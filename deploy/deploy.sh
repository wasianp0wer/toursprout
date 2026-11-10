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
# NEVER add a deleting flag to the rsyncs below. The list is longer than it
# looks and two of them do not contain the string "delete": `--delete`,
# `--delete-before/during/after/delay/excluded`, `--del` (the documented short
# form, and the one a person types), `--remove-source-files`,
# `--remove-sent-files`, and `--force`, which removes a non-empty directory to
# make way for a non-directory. backend/tests/test_deploy_script.py checks for
# all of them by token rather than by substring, for that reason. Historians' in-progress tours live in Settings.sessions_dir
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

# `pipefail` earns its place on one line of this script -- the .env write,
# where printf is upstream of ssh. ssh's own failure is caught by `set -e`
# without it, because ssh is last in the pipeline; what pipefail adds is the
# case where printf fails because the remote end did not read, which would
# otherwise be a deploy that reported success and wrote no token. The tests
# cannot reach that case (it is a SIGPIPE race on a 30-byte write), so it rests
# on this flag and on the remote command's `cat > /dev/null` rather than on a
# test.
set -euo pipefail

# $0's directory, not `git rev-parse --show-toplevel`: this script shells out
# to git for the production gates, and where its own files live must not depend
# on a git that is stubbed, shadowed or missing.
REPO_ROOT=$(cd "$(dirname "$0")/.." && pwd)
# Where the operator typed the command, kept because `cd "$REPO_ROOT"` below
# happens before the config file is looked for: without this, a relative
# --config is resolved against the repository root and the refusal names a
# path that does exist, just not from here.
INVOCATION_CWD=$PWD

usage() {
  echo "usage: deploy/deploy.sh [--target DIR] [--config FILE]" >&2
}

CONFIG="$REPO_ROOT/deploy/deploy.env"
TARGET=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --target)
      # `-ge 2` is satisfied by an EMPTY second argument, and an empty TARGET
      # then falls through `${TARGET:-$DEPLOY_PATH}` to production while
      # `[ -z "$TARGET" ]` re-arms the production gates -- so `--target ""`
      # ships to the historians while the operator believes they are
      # rehearsing. `--target "$STAGING"` with STAGING unset is how that gets
      # typed. Refused here, with the absoluteness check, because every later
      # test of TARGET reads an empty value as "no target given".
      [ "$#" -ge 2 ] || { echo "deploy.sh: --target needs a directory." >&2; usage; exit 2; }
      case "$2" in
        "") echo "deploy.sh: --target was given an empty directory, which would deploy to DEPLOY_PATH -- that is production. Omit --target to mean production." >&2; exit 2 ;;
        /*) : ;;
        *)  echo "deploy.sh: --target needs an ABSOLUTE path on the host (got '$2'). The host resolves it against the deploy user's home, which is not where the subdomain's document root is." >&2; exit 2 ;;
      esac
      TARGET=$2
      shift 2
      ;;
    --config)
      [ "$#" -ge 2 ] || { echo "deploy.sh: --config needs a file." >&2; usage; exit 2; }
      case "$2" in
        /*) CONFIG=$2 ;;
        *)  CONFIG="$INVOCATION_CWD/$2" ;;
      esac
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

# Every refusal below happens before the first remote command, so a refusal has
# never done anything. They are collected rather than raised one at a time:
# fixing one thing, rerunning the whole `make check`, and only then being told
# about the second is the kind of gate that gets worked around.
#
# The prefix is load-bearing for the tests: `set -e` tripping over a missing
# `source` and `set -u` saying `unbound variable` are also non-zero exits with
# a path on stderr, and neither is a message anyone can act on.
PROBLEMS=()
note() {
  PROBLEMS+=("$1")
}
flush() {
  if [ "${#PROBLEMS[@]}" -gt 0 ]; then
    for problem in "${PROBLEMS[@]}"; do
      echo "deploy.sh refuses: $problem" >&2
    done
    exit 1
  fi
}

# ---- Refusals: the config file itself --------------------------------------
if [ ! -f "$CONFIG" ]; then
  note "there is no config file at $CONFIG. Copy deploy/deploy.env.example to deploy/deploy.env, fill it in, and chmod 600 it."
  flush
fi

# The file holds MAPILLARY_TOKEN, so a mode anything else can read is refused.
#
# `stat` has no portable spelling: BSD/macOS wants -f '%Lp', GNU wants
# -c '%a'. Each is tried in its own command substitution and the ANSWER IS
# VALIDATED, rather than the obvious `stat -f ... || stat -c ...` inside one
# substitution: GNU's -f takes no format argument, so it reads '%Lp' as a
# filename, prints the real file's filesystem block on stdout and THEN fails,
# and a single substitution would hand that block and the second command's
# output back as one string. `8#` on that is an arithmetic error, not a mode,
# so the shape of the bug is the script dying with `unbound variable` on Linux
# -- or, with one `|| echo ""` in the wrong place, deciding the mode is unknown
# and carrying on.
read_config_mode() {
  local candidate
  # -L on both spellings: the BSD form reports the LINK's mode (always 0755)
  # for a symlink, and `chmod 600` on a symlink changes its target, so without
  # this a `deploy/deploy.env -> ~/secrets/clio.env` -- a reasonable way to
  # keep the credential out of the repository directory -- is refused forever
  # by a message insisting the fix is a chmod that cannot work.
  for flags in "-Lf %Lp" "-Lc %a"; do
    # Unquoted on purpose: the two words are two arguments.
    # shellcheck disable=SC2086
    candidate=$(stat $flags "$1" 2>/dev/null) || continue
    case "$candidate" in
      [0-7][0-7][0-7] | [0-7][0-7][0-7][0-7]) printf '%s\n' "$candidate"; return 0 ;;
    esac
  done
  return 1
}

if mode=$(read_config_mode "$CONFIG"); then
  if [ $((8#$mode & 8#77)) -ne 0 ]; then
    note "$CONFIG is mode $mode, so its MAPILLARY_TOKEN is readable beyond its owner. chmod 600 $CONFIG"
  fi
else
  note "cannot read the mode of $CONFIG: neither 'stat -f %Lp' (BSD) nor 'stat -c %a' (GNU) gave one, so whether the token is readable by others is unknown, and unknown is not the same as fine."
fi
flush

# shellcheck source=/dev/null
. "$CONFIG"

# ---- Refusals: the values --------------------------------------------------
# Named one by one. "The configuration is incomplete" against a file with six
# variables in it is a guessing game. `${!name:-}` rather than `${!name}`
# because an ABSENT variable and an EMPTY one are the same mistake, and only
# the second survives `set -u` long enough to be reported.
for name in DEPLOY_HOST DEPLOY_USER DEPLOY_PATH MAPILLARY_TOKEN; do
  if [ -z "${!name:-}" ]; then
    note "$name is empty or absent in $CONFIG, and it has no default."
  fi
done
flush

DEPLOY_PORT=${DEPLOY_PORT:-22}
SSH_KEY=${SSH_KEY:-$HOME/.ssh/clio_deploy}
DEPLOY_DIR=${TARGET:-$DEPLOY_PATH}
SSH_DEST="$DEPLOY_USER@$DEPLOY_HOST"

# Whitespace in any of the five values that end up inside rsync's --rsh string
# or beside it. See the RSH comment below: that string is split on whitespace
# by rsync itself, so a space cannot be quoted through it, only refused. The
# deploy directory is in the list because it is the one of the five that can
# come from --target rather than from the config file.
for name in DEPLOY_HOST DEPLOY_USER DEPLOY_PORT SSH_KEY DEPLOY_DIR; do
  case "${!name}" in
    *[[:space:]]*)
      # DEPLOY_DIR is an internal name: it is in no config file and in neither
      # of the runbook's tables, so a refusal naming it sends the operator
      # looking for a variable that does not exist. Report it as whichever of
      # the two things they actually typed.
      case "$name" in
        DEPLOY_DIR) shown=$([ -n "$TARGET" ] && echo "the --target argument" || echo "DEPLOY_PATH") ;;
        *)          shown=$name ;;
      esac
      note "$shown contains whitespace ('${!name}'), which rsync's --rsh string cannot carry: it is split on spaces by rsync, so a value with a space in it changes which arguments ssh gets rather than failing."
      ;;
  esac
done

# ---- Refusals: the production gates ----------------------------------------
# Only for a production deploy. Rehearsing a branch, or a working tree in the
# middle of something, against a staging directory is what --target is for, so
# it relaxes both -- which is also why these live here rather than in a push
# trigger, where "rehearse this branch" could not be expressed.
if [ -z "$TARGET" ]; then
  # Plain assignments, not `if git ...; then`: under `set -e` an assignment
  # from a command substitution still fails the script, where the same command
  # as an `if` condition would have its failure swallowed and be read as
  # "clean" or "on main".
  branch=$(git rev-parse --abbrev-ref HEAD)
  if [ "$branch" != main ]; then
    note "production deploys run from main, and this checkout is on '$branch'. Use --target DIR to rehearse a branch against a staging directory."
  fi
  # rsync ships the WORKING TREE, not the commit, so an uncommitted change
  # reaches the host with nothing in the history to say what is running there.
  dirty=$(git status --porcelain)
  if [ -n "$dirty" ]; then
    note "the working tree has uncommitted changes, and rsync ships the tree rather than the commit:
$dirty"
  fi
fi
flush

# ---- One deploy at a time ---------------------------------------------------
# .github/workflows/deploy.yml carries `concurrency: {group: deploy,
# cancel-in-progress: false}` with the comment "two rsyncs into the same tree
# must not interleave". Moving the ship half into a script dropped that, and a
# script is easier to run twice than a workflow: two terminals, or a second go
# because the first looked stuck during `make check`. A directory is the lock
# because `mkdir` is atomic everywhere and macOS has no flock(1).
#
# Taken AFTER the refusals, so a refused deploy neither waits for a lock nor
# leaves one, and before `make check`, so the slow part is inside it.
# Overridable so the tests can take a lock in a temp directory instead of in
# the real repository, the same kind of seam as backend/app/main.py's `_now`.
# Nothing but a test sets it.
LOCK=${DEPLOY_LOCK:-$REPO_ROOT/.deploy.lock}
if ! mkdir "$LOCK" 2>/dev/null; then
  echo "deploy.sh refuses: $LOCK exists, so another deploy is running (or one died). Two rsyncs into the same tree must not interleave. If nothing is running, rmdir it." >&2
  exit 1
fi
trap 'rmdir "$LOCK" 2>/dev/null || true' EXIT

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
# NO --chmod ON ANY RSYNC HERE, and that is not a simplification. The workflow
# could use `--chmod=F644`/`F755` because it ran on ubuntu-24.04, whose rsync is
# GNU rsync. This script runs on macOS, where /usr/bin/rsync is Apple's
# openrsync ("rsync version 2.6.9 compatible") and a literal mode is rejected
# outright: `rsync: --chmod=F644: invalid argument`, exit 1, nothing
# transferred. Carried over unchanged, the flag stopped every deploy at this
# very line, before anything reached the host. (openrsync takes only relative
# forms like `u+x`, and documents --chmod as having no effect without --perms,
# which `-rlt` does not pass -- so even parsing it would not have set the mode.)
#
# The modes are therefore set on the host, by chmod, which both rsyncs agree
# about. `.htaccess` needs none of its own: deploy/merge-htaccess.sh chmods 644
# the temp file it writes before the atomic mv, so the file Apache reads is 644
# however it arrived.
"${RSYNC[@]}" .htaccess "$SSH_DEST:$DEPLOY_DIR/.htaccess.new"

# The merge script, which composes the two. No mode is needed on it at all: it
# is invoked as `bash <path>` below, never executed directly, so the bit is
# irrelevant -- and relying on the bit would have been wrong anyway, since a
# copy already on the host with the wrong mode is not something rsync repairs.
"${RSYNC[@]}" deploy/merge-htaccess.sh "$SSH_DEST:$DEPLOY_DIR/deploy/"

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

# `rsync -rlt` carries no permissions, so a NEW app.cgi arrives 644 and Apache
# 500s on executing it. The chmod is its own ssh round-trip immediately after,
# rather than only in the install step at the end: between the two sits the
# whole of backend/, the bundle, content/, the .env write and a pip install,
# and on a first deploy -- the one where app.cgi is new and therefore 644 --
# that is minutes of 500 on every URL. The install step still chmods it again,
# for the case rsync did not create it and the mode on the host is wrong.
"${RSYNC[@]}" app.cgi "$SSH_DEST:$DEPLOY_DIR/"
ssh "${SSH_OPTS[@]}" "$SSH_DEST" "chmod 755 '$DEPLOY_DIR/app.cgi'"

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
#
# The workflow interpolated $DEPLOY_DIR into this heredoc. Here it is passed as
# `bash -s`'s positional argument and the heredoc is QUOTED, for two reasons.
# One: a quoted heredoc expands nothing, so there is no escaping to get right
# and no way for a local variable to leak into the remote script. Two -- the
# one that earns the difference from the workflow -- the directory is then in
# an argv rather than on stdin, which is the only place a test can see it; this
# is the one remote step that writes nothing by rsync, so a `--target` that
# failed to reach it would pip-install into production's venv and chmod
# production's files during a "rehearsal", invisibly.
ssh "${SSH_OPTS[@]}" "$SSH_DEST" "bash -s '$DEPLOY_DIR'" <<'REMOTE'
set -euo pipefail
DIR=$1
VENV="$DIR/.venv"
if [ ! -x "$VENV/bin/python" ]; then
  echo "No interpreter at $VENV/bin/python. Create the virtualenv once, by hand, as described in docs/DEPLOY.md step 4; the deploy installs into it but never creates it." >&2
  exit 1
fi
"$VENV/bin/pip" install -r "$DIR/backend/requirements.txt"
# NOT redundant with the --chmod flags above: --chmod only applies to files
# rsync CREATES, so a file already on the host with the wrong mode (an earlier
# deploy without --chmod, or a hand-edit through the file manager) would never
# be repaired. Either one costs the whole tree: an app.cgi Apache cannot
# execute and an .htaccess it cannot read are both 500 on every URL.
chmod 755 "$DIR/app.cgi"
chmod 644 "$DIR/.htaccess"
REMOTE

echo "deploy.sh: shipped to $SSH_DEST:$DEPLOY_DIR"
