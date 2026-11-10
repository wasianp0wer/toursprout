#!/usr/bin/env bash
#
# deploy/deploy.sh [--target DIR] [--config FILE] -- ship this checkout to the host.
#
# This is the ship half of .github/workflows/deploy.yml, run from a
# workstation. The pipeline still exists and still works, but it cannot reach
# the host: the host's firewall permits the author's address and drops GitHub's
# hosted runners at the TCP level, which is a request to the host rather than a
# change here. So the same rsyncs, the same order, the same modes, the same
# merge and the same only-if-absent .env run from here instead, reading their
# configuration from deploy/deploy.env rather than from repository secrets.
#
# Lint, tests and the frontend build are NOT reimplemented: `make check` runs
# them, so the Makefile's pinned Node (the ambient one is v25, which Angular 22
# rejects) applies here exactly as it does by hand. They run BEFORE the first
# remote command, so a failing test stops the deploy instead of being noticed
# after half a tree has shipped.
#
# NEVER add `--delete` (or --delete-excluded, --remove-source-files) to the
# rsyncs below. Historians' in-progress tours live in Settings.sessions_dir
# (default ~/.clio-wired/sessions), OUTSIDE the deploy tree so rsync cannot
# reach them: that is the first defence. Not deleting anything is the second. A
# deploy that destroys a tour is a failure condition, so the cost of this
# choice -- a file removed from the repository lingers on the host until
# someone removes it by hand -- is accepted on purpose.
#
# The layout on the host mirrors the repository, because Settings derives
# content_dir and frontend_dist from the backend's location.
#
# Tested in backend/tests/test_deploy_script.py, which is the only thing that
# will ever run this script before a live host does.

set -euo pipefail

# $0's directory, not `git rev-parse --show-toplevel`: this script shells out
# to git for the production gates, and where its own files live must not depend
# on a git that is stubbed, shadowed or missing.
REPO_ROOT=$(cd "$(dirname "$0")/.." && pwd)

usage() {
  echo "usage: deploy/deploy.sh [--target DIR] [--config FILE]" >&2
}

CONFIG="$REPO_ROOT/deploy/deploy.env"
TARGET=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --target)
      [ "$#" -ge 2 ] || { echo "deploy.sh: --target needs a directory." >&2; usage; exit 2; }
      TARGET=$2
      shift 2
      ;;
    --config)
      [ "$#" -ge 2 ] || { echo "deploy.sh: --config needs a file." >&2; usage; exit 2; }
      CONFIG=$2
      shift 2
      ;;
    *)
      echo "deploy.sh: unknown argument '$1'." >&2
      usage
      exit 2
      ;;
  esac
done

# Every source path below is relative, as in the workflow, so the trailing
# slashes that decide what rsync copies read the same in both files.
cd "$REPO_ROOT"

# shellcheck source=/dev/null
. "$CONFIG"

DEPLOY_PORT=${DEPLOY_PORT:-22}
SSH_KEY=${SSH_KEY:-$HOME/.ssh/clio_deploy}
DEPLOY_DIR=${TARGET:-$DEPLOY_PATH}
SSH_DEST="$DEPLOY_USER@$DEPLOY_HOST"

# One place the ssh options are written, for both ssh and rsync.
#
# StrictHostKeyChecking=yes with no UserKnownHostsFile, which is the one thing
# this script does differently from the workflow: on a workstation the host key
# is already in ~/.ssh/known_hosts, verified interactively once, and that is a
# better pin than a blob re-pasted into a repository variable. If the entry is
# absent this fails closed -- `Host key verification failed`, fixed by one
# interactive ssh to the host -- which is the wanted behaviour. BatchMode=yes
# because the deploy key has no passphrase and nothing here can answer a
# prompt.
SSH_OPTS=(-p "$DEPLOY_PORT" -i "$SSH_KEY" -o IdentitiesOnly=yes
          -o StrictHostKeyChecking=yes -o BatchMode=yes
          -o ServerAliveInterval=30 -o ServerAliveCountMax=4)

# rsync's --rsh takes ONE string and splits it on whitespace itself, so the
# options can only be joined with spaces here. There is no quoting that
# survives that split, which is why a config value containing whitespace is
# refused outright above rather than escaped: the alternative is an rsync that
# connects somewhere unintended and says nothing.
RSH="ssh ${SSH_OPTS[*]}"
RSYNC=(rsync -rlt --itemize-changes --rsh="$RSH")

# ---- 1. Lint, test and build, before anything leaves this machine ----------
make check

# requirements.txt is resolved HERE and installed THERE, by pip rather than uv:
# the host has no uv. --no-dev keeps uvicorn[standard] -- and uvloop,
# httptools, watchfiles, websockets, PyYAML -- off the host, where the CGI path
# loads none of them and where any one of them lacking a cp312 wheel would
# build from source and fail the install.
(cd backend && uv export --no-dev --no-hashes --no-emit-project -o requirements.txt)

# ---- 2. Ship, front controller first --------------------------------------
ssh "${SSH_OPTS[@]}" "$SSH_DEST" \
  "mkdir -p '$DEPLOY_DIR/backend' '$DEPLOY_DIR/content' '$DEPLOY_DIR/deploy' '$DEPLOY_DIR/frontend/dist/frontend/browser'"

# THE FRONT CONTROLLER GOES FIRST, before app.cgi and before anything under
# backend/ or content/, and -- load-bearing, and invisible unless it is said
# here -- BEFORE THE .env STEP BELOW. Until .htaccess is in place the document
# root is UNCONTAINED: rule 3 is the only thing keeping backend/, content/ and
# .venv/ off the web, and the <Files ".env"> block is the only thing standing
# over the Mapillary token. On a steady-state deploy the file is already there
# and the order makes no difference; the order is for the two deploys where it
# is not -- the first one, and every redeploy after step 7's documented
# `rm -f .htaccess` escape hatch. Writing backend/.env while there is no
# .htaccess would publish MAPILLARY_TOKEN by URL for the length of a pip
# install.
#
# 644, not 755: Apache reads this one, nothing executes it. The mode is given
# explicitly for the same reason app.cgi's is below -- `rsync -rlt` carries
# none -- and an .htaccess Apache cannot READ is 500 on every URL in the tree,
# the same outage as a syntax error.
#
# STAGED as .htaccess.new, NOT written straight to .htaccess. The live file is
# the one cPanel's Directory Privacy writes the shared password into
# (docs/DEPLOY.md step 8): it protects a directory by putting
# AuthType/AuthName/AuthUserFile/Require valid-user in THAT directory's
# .htaccess, and the directory it protects here is the document root, which is
# this one. Overwriting it removes the only access control the deployment has,
# with nothing anywhere to say so, because the file is perfectly valid without
# those lines.
"${RSYNC[@]}" --chmod=F644 .htaccess "$SSH_DEST:$DEPLOY_DIR/.htaccess.new"

# The merge script, which composes the two. F755 for consistency with app.cgi,
# but it is invoked through `bash` below rather than relying on the bit:
# --chmod only applies to files rsync CREATES, so a copy already on the host
# with the wrong mode would never be repaired, and this is not a file to lose
# the password over.
"${RSYNC[@]}" --chmod=F755 deploy/merge-htaccess.sh "$SSH_DEST:$DEPLOY_DIR/deploy/"

# .htaccess becomes the staged copy plus whatever auth directives the host's
# file already carried, written atomically and with the staged copy removed.
# The script exits non-zero and changes nothing if it cannot read either file,
# which stops this deploy -- deliberately, because the alternative is a deploy
# that reports success while having opened the editor to the internet. Tested
# in backend/tests/test_merge_htaccess.py; the reasoning, and what it does NOT
# preserve, is in the script's own header.
#
# .htaccess.new is left on the host only if that merge fails. It is not served:
# rule 3 sends every unknown path to the bundle's index.html.
ssh "${SSH_OPTS[@]}" "$SSH_DEST" \
  "bash '$DEPLOY_DIR/deploy/merge-htaccess.sh' '$DEPLOY_DIR/.htaccess' '$DEPLOY_DIR/.htaccess.new'"

# --chmod is required: `rsync -rlt` carries no permissions, so without it
# app.cgi arrives mode 644 and Apache 500s on it.
"${RSYNC[@]}" --chmod=F755 app.cgi "$SSH_DEST:$DEPLOY_DIR/"

"${RSYNC[@]}" \
  --exclude '.venv' --exclude '.env' --exclude '__pycache__' \
  --exclude '.pytest_cache' --exclude '.ruff_cache' --exclude 'uv.lock' \
  backend/ "$SSH_DEST:$DEPLOY_DIR/backend/"

"${RSYNC[@]}" frontend/dist/frontend/browser/ \
  "$SSH_DEST:$DEPLOY_DIR/frontend/dist/frontend/browser/"

# content/work is the vestigial pre-sessions directory; it is gitignored so
# absent from a checkout, and excluded as insurance. Anchored (/work) so it
# only matches content/work, nothing deeper.
"${RSYNC[@]}" --exclude '/work' content/ "$SSH_DEST:$DEPLOY_DIR/content/"

# ---- 3. The host's .env, from the config file -----------------------------
# Piped over stdin so the token never appears in a process listing, a log or a
# shell history. Written ONLY WHEN ABSENT: backend/.env is host-owned state.
# The first deploy bootstraps it; later deploys leave it alone, so a
# SESSIONS_DIR or a lowered cap the operator added survives (the rsync above
# excludes .env for the same reason). The cost: a rotated MAPILLARY_TOKEN in
# deploy/deploy.env is NOT picked up; edit backend/.env on the host. stdin is
# drained when skipping so the pipe never breaks.
printf 'MAPILLARY_TOKEN=%s\n' "$MAPILLARY_TOKEN" \
  | ssh "${SSH_OPTS[@]}" "$SSH_DEST" \
    "umask 077 && if [ -e '$DEPLOY_DIR/backend/.env' ]; then cat > /dev/null; echo 'backend/.env already exists on the host: left alone (token and other settings NOT updated).'; else cat > '$DEPLOY_DIR/backend/.env' && echo 'backend/.env did not exist: created it.'; fi"

# ---- 4. Install dependencies on the host ----------------------------------
# The venv is at $DEPLOY_DIR/.venv. That is a DEPLOY CONTRACT, not a guess
# about the host's layout: app.cgi runs "$(dirname $0)/.venv/bin/python", the
# runbook (docs/DEPLOY.md step 4) creates the venv there by hand once, and the
# rsyncs above exclude .venv so a deploy never touches it.
#
# Nothing is restarted. There is no resident process to restart: Apache
# executes app.cgi fresh on every request, so new files are live the moment
# rsync finishes.
ssh "${SSH_OPTS[@]}" "$SSH_DEST" "bash -s" <<REMOTE
set -euo pipefail
DIR='$DEPLOY_DIR'
VENV="\$DIR/.venv"
if [ ! -x "\$VENV/bin/python" ]; then
  echo "No interpreter at \$VENV/bin/python. Create the virtualenv once, by hand, as described in docs/DEPLOY.md step 4; the deploy installs into it but never creates it." >&2
  exit 1
fi
"\$VENV/bin/pip" install -r "\$DIR/backend/requirements.txt"
# NOT redundant with the --chmod flags above: --chmod only applies to files
# rsync CREATES, so a file already on the host with the wrong mode (an earlier
# deploy without --chmod, or a hand-edit through the file manager) would never
# be repaired. Either one costs the whole tree: an app.cgi Apache cannot
# execute and an .htaccess it cannot read are both 500 on every URL.
chmod 755 "\$DIR/app.cgi"
chmod 644 "\$DIR/.htaccess"
REMOTE

echo "deploy.sh: shipped to $SSH_DEST:$DEPLOY_DIR"
