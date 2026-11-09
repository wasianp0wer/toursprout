#!/usr/bin/env bash
#
# merge-htaccess.sh <dest> <new> -- install the repository's front controller
# WITHOUT removing the shared password.
#
# cPanel's Directory Privacy (docs/DEPLOY.md step 8) protects a directory by
# writing AuthType / AuthName / AuthUserFile / Require valid-user into THAT
# DIRECTORY's .htaccess. The directory protected here is the subdomain's
# document root, which is the deploy directory itself, so the file cPanel edits
# is the same .htaccess the deploy ships. An unconditional `rsync` of the
# repository's copy over it therefore removes the one thing keeping strangers
# off the editor -- where they would spend the Mapillary quota and fill the
# disk -- and removes it SILENTLY, because the front controller is perfectly
# valid without those four lines. Nothing appears in the deploy log, the error
# log, or the site's behaviour.
#
# So the deploy composes the file on the host instead of overwriting it. The
# workflow rsyncs the repository's .htaccess to .htaccess.new and runs this
# script, which writes <dest> as the contents of <new> followed by whatever
# auth directives <dest> already carried, then removes <new>.
#
# Two properties are the whole point of the script, and both are pinned by
# backend/tests/test_merge_htaccess.py:
#
#   It FAILS LOUDLY. If <new> is missing, empty or unreadable, or <dest> exists
#   but cannot be read, this exits non-zero and changes nothing -- the remote
#   shell runs under `set -e`, so the deploy stops. A script that helpfully
#   fell back to installing <new> on a read error would be performing exactly
#   the overwrite it exists to prevent, and would report success while doing it.
#
#   It is ATOMIC. The merged file is written to a temp file in the same
#   directory and `mv`d over <dest>, because an .htaccess that is half-written,
#   or briefly absent, is 500 on EVERY URL of the subdomain for as long as it
#   lasts -- the editor, the viewer, the API, the bundle, the lot.
#
# This is a shipped file rather than inline shell in the workflow for one
# reason: so a test can run it. A silent loss of access control must not rest
# on reasoning about heredoc quoting.
#
# WHAT IS KEPT, AND WHAT IS NOT. Only the auth directives below are carried
# over. cPanel writes other things into .htaccess -- hotlink protection and
# redirects (RewriteRule/RewriteCond), IP denies, PHP handler lines -- and none
# of them is preserved, on purpose. The rewrites cannot be: the repository's
# rule 3 is unconditional, so anything appended after it is dead code, and
# anything that would have to go BEFORE it cannot be placed by appending at
# all. The rest is either inert here (there is no PHP in this tree) or
# dangerous to re-emit out of context -- `Require all denied`, which the
# repository's own file has inside `<Files ".env">`, denies the entire document
# root if it is lifted to the top level, which is why the pattern below matches
# `Require valid-user` specifically and never bare `Require`. An operator who
# needs one of those directives on the host should put it in the repository's
# .htaccess, where it is reviewed and version-controlled, not in cPanel.
#
# Written for a host that is Linux (CloudLinux) but tested on macOS, so it
# sticks to constructs that behave the same under BSD and GNU tools: `grep -iE`
# with POSIX character classes, no GNU-only flags. These tests are the only
# thing that will ever execute it before the host does.

set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "usage: merge-htaccess.sh <dest> <new>" >&2
  echo "  <dest>  the .htaccess on the host, whose auth directives are kept" >&2
  echo "  <new>   the staged copy from the repository; removed on success" >&2
  exit 2
fi

dest=$1
new=$2

# The directives Directory Privacy writes. Apache's directive names are
# case-insensitive and it ignores leading whitespace, so a hand-edit through
# the cPanel file manager -- or a cPanel version that indents its own block --
# is still the password; matching the exact casing cPanel happens to use today
# would lose it. AuthGroupFile is here because protection by group writes it
# instead of AuthUserFile.
#
# `Require` is matched ONLY as `Require valid-user`. See the note above: bare
# `Require` would also match the `Require all denied` inside the repository's
# own `<Files ".env">` block on every deploy after the first, and re-emit it at
# the top level, where it is 403 on the whole subdomain.
AUTH_RE='^[[:space:]]*(AuthType|AuthName|AuthUserFile|AuthGroupFile)[[:space:]]'
AUTH_RE="$AUTH_RE"'|^[[:space:]]*Require[[:space:]]+valid-user[[:space:]]*$'

# ---- Refuse before touching anything ---------------------------------------

if [ ! -f "$new" ]; then
  echo "merge-htaccess.sh: no staged front controller at $new: refusing to touch $dest." >&2
  echo "  The deploy's rsync of .htaccess did not arrive. Nothing was changed." >&2
  exit 1
fi

if [ ! -r "$new" ] || [ ! -s "$new" ]; then
  echo "merge-htaccess.sh: $new is unreadable or empty: refusing to touch $dest." >&2
  echo "  Installing it would leave a front controller with no rules at all." >&2
  exit 1
fi

existing_auth=""
if [ -e "$dest" ]; then
  # Read the auth block back out of the file ON THE HOST -- not out of some
  # record of what was there last time. That is what makes a second deploy a
  # no-op instead of a second copy of the block, and it is what picks up a
  # password set between two deploys.
  #
  # `grep` exits 1 for "no match", which is a normal outcome here and must not
  # trip `set -e`, and >=2 for an actual error, which must. `|| true` cannot
  # tell those apart, so the status is captured instead.
  set +e
  existing_auth=$(grep -iE -e "$AUTH_RE" -- "$dest")
  grep_status=$?
  set -e
  if [ "$grep_status" -gt 1 ]; then
    echo "merge-htaccess.sh: cannot read $dest (grep exited $grep_status)." >&2
    echo "  Refusing to replace it. Nothing was changed." >&2
    echo "  If Directory Privacy's password lives in that file, overwriting it now would" >&2
    echo "  remove it with nothing to say so. Fix the file's permissions and re-run." >&2
    exit 1
  fi
fi

# ---- Compose, then swap -----------------------------------------------------

tmp=$(mktemp "$(dirname -- "$dest")/.htaccess.merge.XXXXXX")
trap 'rm -f -- "$tmp"' EXIT

cat -- "$new" > "$tmp"

if [ -n "$existing_auth" ]; then
  # A <new> that does not end in a newline would otherwise run straight into
  # the comment below, commenting out its own last directive.
  if [ -n "$(tail -c 1 -- "$tmp")" ]; then
    printf '\n' >> "$tmp"
  fi
  cat >> "$tmp" <<'HEADER'

# ---------------------------------------------------------------------------
# NOT FROM THE REPOSITORY. The lines below were read off this host's own
# .htaccess by deploy/merge-htaccess.sh during the deploy, and re-appended so
# they survive it. They are cPanel's Directory Privacy block -- the shared
# password for the editor (docs/DEPLOY.md step 8).
#
# Editing them here is pointless: the next deploy reads whatever this file says
# at the time it runs and writes it back. Change the password in cPanel,
# Files, Directory Privacy. Removing the protection there removes it here too,
# on the next deploy.
# ---------------------------------------------------------------------------
HEADER
  printf '%s\n' "$existing_auth" >> "$tmp"
fi

# 644, not mktemp's 600: an .htaccess Apache cannot READ is 500 on every URL in
# the tree, the same outage as a syntax error in it. The install step chmods it
# too, which is not redundant -- that one also repairs a file this script did
# not write -- but this script is also run by hand during an incident, when
# there is no install step after it.
chmod 644 "$tmp"

# The atomic half: a reader sees the old file or the new one, never a partial
# one and never none.
mv -f -- "$tmp" "$dest"
trap - EXIT

rm -f -- "$new"
