"""`deploy/merge-htaccess.sh`: a deploy must not remove the shared password.

cPanel's *Directory Privacy* (docs/DEPLOY.md step 8) protects a directory by
writing `AuthType`, `AuthName`, `AuthUserFile` and `Require valid-user` into
THAT DIRECTORY's `.htaccess`. The directory to protect here is the subdomain's
document root, which is the deploy directory itself, so the file cPanel edits
is the same `.htaccess` the deploy ships -- and overwriting it removes the only
thing keeping strangers off the editor. It removes it SILENTLY, too: the front
controller is perfectly valid without those four lines, so nothing in the
deploy log, the error log or the site's behaviour says the password is gone.

So the deploy composes the file on the host instead of overwriting it. The
workflow rsyncs the repository's copy to `.htaccess.new` and runs this script,
which rewrites `.htaccess` as the new file plus whatever auth directives the
old one carried. The script is a shipped file rather than inline shell in the
workflow for exactly one reason: so these tests can run it. A silent loss of
access control must not rest on reasoning about heredoc quoting.

These tests are the only thing that will ever execute the script before the
host does, so they pin the failure modes rather than the happy path:

- that it exits non-zero and changes NOTHING when it cannot read what it needs,
  because a script that helpfully proceeds on a read error is worse than one
  that stops the deploy;
- that running it twice does not stack the block up, which it can only satisfy
  by re-reading the destination rather than appending to it;
- and that `Require all denied` -- which the repository's own `.htaccess` has
  inside a `<Files ".env">` block -- is not mistaken for an auth directive and
  copied out to the top level, where it would deny the whole document root.
  That one would be a fresh outage rather than a lost password.

Nothing here claims Apache accepts the result; that is a `curl` check in the
runbook. What is testable is the text, and the text is where the password is.
"""

from __future__ import annotations

import os
import stat
import subprocess
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
SCRIPT = REPO / "deploy" / "merge-htaccess.sh"

# What cPanel's Directory Privacy writes, verbatim in shape: four flat
# directives, no container, an absolute `AuthUserFile` under `.htpasswds`.
CPANEL_AUTH = """AuthType Basic
AuthName "Protected"
AuthUserFile "/home/u/.htpasswds/public_html/tours/passwd"
Require valid-user
"""

AUTH_LINES = CPANEL_AUTH.strip("\n").split("\n")

# A stand-in for the repository's front controller: short, but it carries the
# two lines that matter to these tests -- a `Require all denied` inside a
# `<Files>` block, and a marker that must not survive from the OLD file.
REPO_HTACCESS = """# The front controller.
Options +ExecCGI -Indexes
<Files ".env">
  Require all denied
</Files>
RewriteEngine On
RewriteRule ^ frontend/dist/frontend/browser/index.html [L]
"""


def _run(dest: Path, new: Path) -> subprocess.CompletedProcess[str]:
    """Drive the script the way the install step does: `bash SCRIPT dest new`."""
    return subprocess.run(
        ["bash", str(SCRIPT), str(dest), str(new)],
        capture_output=True,
        text=True,
        check=False,
    )


def _lines(path: Path) -> list[str]:
    return path.read_text().strip("\n").split("\n")


def _assert_refused(result: subprocess.CompletedProcess[str], mentions: str) -> None:
    """A loud refusal FROM THE SCRIPT, not from whatever ran it.

    Without the 127 clause every test below would pass against a repository
    with no script in it at all: `bash` exits 127 with a message on stderr, and
    "non-zero with something on stderr" is satisfied by its own complaint. The
    `mentions` clause is the same guard one step further in -- `set -u` saying
    `unbound variable` is also non-zero and also useless in a deploy log."""
    assert result.returncode != 127, f"the script did not run at all: {result.stderr}"
    assert result.returncode != 0, "the script accepted input it cannot safely act on"
    assert result.stderr.strip(), "a refusal with nothing on stderr is a silent failure"
    assert mentions in result.stderr, (
        f"the refusal does not say what went wrong ({mentions!r} absent): {result.stderr!r}"
    )


def test_the_script_is_shipped_executable(tmp_path):
    """Mode 755 in the repository. The workflow's `--chmod=F755` only applies to
    files rsync CREATES, so the bit in git is what a re-deploy over an existing
    copy relies on -- and the install step invokes it through `bash` as well,
    because neither of those two is worth betting the password on alone."""
    assert SCRIPT.is_file()
    assert SCRIPT.stat().st_mode & stat.S_IXUSR, "deploy/merge-htaccess.sh is not executable"


def test_with_no_existing_file_the_repository_version_is_installed(tmp_path):
    """The first deploy, and the one after someone deletes the file to undo a
    500 (step 7's escape hatch). No destination to read, so nothing to keep."""
    dest = tmp_path / ".htaccess"
    new = tmp_path / ".htaccess.new"
    new.write_text(REPO_HTACCESS)

    result = _run(dest, new)

    assert result.returncode == 0, result.stderr
    assert dest.read_text() == REPO_HTACCESS


def test_an_existing_file_without_auth_is_replaced_exactly(tmp_path):
    """The ordinary deploy, on a host where Directory Privacy was never turned
    on. Byte-for-byte the repository's file: no comment, no trailing block, so
    the host's copy is diffable against the repository's."""
    dest = tmp_path / ".htaccess"
    new = tmp_path / ".htaccess.new"
    dest.write_text("# an older deploy's front controller\nOptions +ExecCGI\n")
    new.write_text(REPO_HTACCESS)

    result = _run(dest, new)

    assert result.returncode == 0, result.stderr
    assert dest.read_text() == REPO_HTACCESS


def test_cpanel_auth_directives_survive_a_deploy(tmp_path):
    """The defect this script exists to fix. Every one of the four lines comes
    through, and the rest of the old file does not."""
    dest = tmp_path / ".htaccess"
    new = tmp_path / ".htaccess.new"
    dest.write_text(
        "# a stale front controller\nRewriteRule ^ old-bundle/index.html [L]\n" + CPANEL_AUTH
    )
    new.write_text(REPO_HTACCESS)

    result = _run(dest, new)

    assert result.returncode == 0, result.stderr
    merged = _lines(dest)
    for line in AUTH_LINES:
        assert line in merged, f"Directory Privacy's {line!r} did not survive the deploy"
    # The old file is gone apart from the auth block: the deploy still deploys.
    assert "RewriteRule ^ old-bundle/index.html [L]" not in merged
    assert "# a stale front controller" not in merged
    # The new file's own content is all there, and the auth block is AFTER it.
    for line in REPO_HTACCESS.strip("\n").split("\n"):
        assert line in merged
    assert merged.index("AuthType Basic") > merged.index(
        "RewriteRule ^ frontend/dist/frontend/browser/index.html [L]"
    )


def test_authgroupfile_survives_too(tmp_path):
    """`AuthGroupFile` is the fifth directive cPanel can write, when the
    protection is by group rather than by user. Cheap to keep, and losing it
    is the same outage as losing the other four."""
    dest = tmp_path / ".htaccess"
    new = tmp_path / ".htaccess.new"
    dest.write_text(CPANEL_AUTH + 'AuthGroupFile "/home/u/.htgroups"\n')
    new.write_text(REPO_HTACCESS)

    assert _run(dest, new).returncode == 0
    assert 'AuthGroupFile "/home/u/.htgroups"' in _lines(dest)


def test_require_user_and_require_group_survive(tmp_path):
    """`Require valid-user` is not the only form. A host protected for one
    named account writes `Require user NAME`, and by group `Require group
    NAME`. Keeping the three `Auth*` lines and dropping the `Require` would be
    the worst outcome available: under Apache 2.4 a directory with no
    `Require` has NO authorization, so the editor would be open -- silently,
    which is this script's entire failure mode -- while the file still looked
    protected to anyone grepping it for `Auth`."""
    dest = tmp_path / ".htaccess"
    new = tmp_path / ".htaccess.new"
    dest.write_text(
        "AuthType Basic\n"
        'AuthName "Protected"\n'
        'AuthUserFile "/home/u/.htpasswds/public_html/tours/passwd"\n'
        "Require user historians\n"
        "Require group staff\n"
    )
    new.write_text(REPO_HTACCESS)

    result = _run(dest, new)

    assert result.returncode == 0, result.stderr
    merged = _lines(dest)
    assert "Require user historians" in merged
    assert "Require group staff" in merged
    # And the widening still cannot reach the line it must never match.
    assert dest.read_text().count("Require all denied") == 1


def test_the_same_file_as_both_arguments_fails_loudly(tmp_path):
    """Only reachable by a hand-run during an incident, which is exactly when
    it would hurt: the merge `mv`s the composed file over <dest> and then
    removes <new>, so if they are one file the result is NO `.htaccess` at all
    -- 500 on every URL of the subdomain -- from a command that exited 0."""
    dest = tmp_path / ".htaccess"
    original = REPO_HTACCESS + CPANEL_AUTH
    dest.write_text(original)

    result = _run(dest, dest)

    _assert_refused(result, str(dest))
    assert dest.exists(), "the front controller was deleted outright"
    assert dest.read_text() == original


def test_running_twice_does_not_duplicate_the_auth_block(tmp_path):
    """Idempotence, and the reason it is not free: the second run reads back
    the block the FIRST run appended. A script that appended the old file's
    auth lines to the file it had just written -- or that appended anything at
    all without re-reading -- doubles the block here, and goes on doubling it
    on every deploy until the file is unreadable prose."""
    dest = tmp_path / ".htaccess"
    dest.write_text(REPO_HTACCESS + CPANEL_AUTH)

    first = tmp_path / ".htaccess.new"
    first.write_text(REPO_HTACCESS)
    assert _run(dest, first).returncode == 0
    after_one = dest.read_text()

    second = tmp_path / ".htaccess.new"
    second.write_text(REPO_HTACCESS)
    assert _run(dest, second).returncode == 0
    after_two = dest.read_text()

    # The strongest statement available: the second deploy changed nothing.
    assert after_two == after_one
    # And the statement that is legible when it fails.
    for line in AUTH_LINES:
        assert after_two.count(line) == 1, f"{line!r} appears {after_two.count(line)} times"
    assert after_two.count("Options +ExecCGI -Indexes") == 1
    # Guard the guard: the first run must really have kept the block, or every
    # count above is 1 because it is 0 everywhere and the test says nothing.
    assert "Require valid-user" in after_one


def test_indented_and_oddly_cased_directives_are_still_recognised(tmp_path):
    """Apache's directive names are case-insensitive and leading whitespace is
    ignored, so a hand-edit through the cPanel file manager -- or a cPanel
    version that indents its own block -- is still the password. Matching the
    exact casing cPanel happens to use today would lose it."""
    dest = tmp_path / ".htaccess"
    new = tmp_path / ".htaccess.new"
    dest.write_text(
        "  authtype Basic\n"
        '\tAuthNAME "Historians only"\n'
        '   AUTHUSERFILE "/home/u/.htpasswds/tours/passwd"\n'
        "  require   valid-user\n"
    )
    new.write_text(REPO_HTACCESS)

    result = _run(dest, new)

    assert result.returncode == 0, result.stderr
    merged = dest.read_text()
    # Preserved verbatim, indentation and casing included: the script is not in
    # the business of rewriting directives it does not understand.
    for line in ("  authtype Basic", '\tAuthNAME "Historians only"',
                 '   AUTHUSERFILE "/home/u/.htpasswds/tours/passwd"', "  require   valid-user"):
        assert line in merged.split("\n"), f"{line!r} did not survive the deploy"


def test_require_all_denied_is_not_promoted_out_of_its_files_block(tmp_path):
    """The repository's own `.htaccess` has `Require all denied` inside
    `<Files ".env">`. On the second deploy that line is in the DESTINATION, so
    a script matching bare `Require` would copy it to the end of the file --
    outside any container, where it denies the entire document root. That is a
    403 on every URL of the subdomain: a worse outage than the one this script
    prevents, introduced by the fix. The `<Files>` and `</Files>` lines are not
    auth either, and must not be dragged along on their own."""
    dest = tmp_path / ".htaccess"
    new = tmp_path / ".htaccess.new"
    dest.write_text(REPO_HTACCESS)
    new.write_text(REPO_HTACCESS)

    result = _run(dest, new)

    assert result.returncode == 0, result.stderr
    # Nothing was carried over, so the file round-trips unchanged.
    assert dest.read_text() == REPO_HTACCESS
    assert dest.read_text().count("Require all denied") == 1


def test_an_unreadable_destination_fails_loudly_and_changes_nothing(tmp_path):
    """The failure this script exists to prevent is a SILENT one, so a read
    error must stop the deploy rather than fall back to the repository's file:
    the fallback is exactly the overwrite that loses the password."""
    if os.geteuid() == 0:
        pytest.skip("root reads mode 000, so there is no unreadable file to test with")
    dest = tmp_path / ".htaccess"
    new = tmp_path / ".htaccess.new"
    original = REPO_HTACCESS + CPANEL_AUTH
    dest.write_text(original)
    new.write_text(REPO_HTACCESS)
    dest.chmod(0o000)

    try:
        result = _run(dest, new)
    finally:
        dest.chmod(0o644)

    _assert_refused(result, str(dest))
    assert dest.read_text() == original, "the destination was modified despite the failure"
    assert new.exists(), "the staging file was removed, so a retry would have nothing to install"


def test_a_missing_new_file_fails_loudly(tmp_path):
    """If the rsync of `.htaccess.new` did not happen, there is nothing to
    install and the right answer is to stop. Truncating the live front
    controller to the empty file would be 404 on the API and no password."""
    dest = tmp_path / ".htaccess"
    original = REPO_HTACCESS + CPANEL_AUTH
    dest.write_text(original)

    new = tmp_path / ".htaccess.new"
    result = _run(dest, new)

    _assert_refused(result, str(new))
    assert dest.read_text() == original


def test_the_wrong_number_of_arguments_fails_loudly(tmp_path):
    """`set -u` alone would say `unbound variable`, which is not a message
    anyone reading a deploy log can act on."""
    result = subprocess.run(
        ["bash", str(SCRIPT), str(tmp_path / ".htaccess")],
        capture_output=True,
        text=True,
        check=False,
    )
    _assert_refused(result, "usage:")


def test_the_staging_file_is_removed_on_success(tmp_path):
    """`.htaccess.new` is a deploy artefact, not a file the host should keep.
    Leaving it would also leave the next operator grepping the wrong file for
    the auth block."""
    dest = tmp_path / ".htaccess"
    new = tmp_path / ".htaccess.new"
    dest.write_text(CPANEL_AUTH)
    new.write_text(REPO_HTACCESS)

    assert _run(dest, new).returncode == 0
    assert not new.exists()
    assert dest.exists()


def test_the_merged_file_is_readable_by_apache(tmp_path):
    """An `.htaccess` Apache cannot read is 500 on every URL in the tree, the
    same outage as a syntax error in it. The file is written through `mktemp`,
    which creates mode 600, so the mode has to be set deliberately -- the
    install step's `chmod 644` is the second line of defence, not the first,
    because this script also runs by hand during an incident."""
    dest = tmp_path / ".htaccess"
    new = tmp_path / ".htaccess.new"
    dest.write_text(CPANEL_AUTH)
    new.write_text(REPO_HTACCESS)

    assert _run(dest, new).returncode == 0
    assert stat.S_IMODE(dest.stat().st_mode) == 0o644


def test_no_temporary_file_is_left_beside_the_destination(tmp_path):
    """The write is atomic -- temp file plus `mv` -- because an `.htaccess`
    that is half-written, or briefly absent, is a 500 on every URL of the
    subdomain for as long as it lasts. The leftovers that would prove it was
    not atomic are also directly testable."""
    dest = tmp_path / ".htaccess"
    new = tmp_path / ".htaccess.new"
    dest.write_text(CPANEL_AUTH)
    new.write_text(REPO_HTACCESS)

    assert _run(dest, new).returncode == 0
    assert sorted(p.name for p in tmp_path.iterdir()) == [".htaccess"]


def test_the_appended_block_says_where_it_came_from(tmp_path):
    """Whoever opens this file on the host next needs to know that the lines at
    the bottom are not in the repository and that editing them here is
    pointless -- the next deploy re-reads whatever the file says at the time."""
    dest = tmp_path / ".htaccess"
    new = tmp_path / ".htaccess.new"
    dest.write_text(CPANEL_AUTH)
    new.write_text(REPO_HTACCESS)

    assert _run(dest, new).returncode == 0
    merged = dest.read_text()
    comments = [ln for ln in merged.split("\n") if ln.startswith("#")]
    prose = "\n".join(comments).lower()
    assert "directory privacy" in prose
    assert "merge-htaccess.sh" in prose
    # Named so the next person can find the explanation rather than guess.
    assert "deploy.md" in prose
