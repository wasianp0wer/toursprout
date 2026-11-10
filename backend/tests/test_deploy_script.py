"""`deploy/deploy.sh`: the orderings and the refusals a deploy must not lose.

Shipping moved off GitHub Actions and onto the author's own machine, because
the host's firewall drops GitHub's runner addresses. `deploy/deploy.sh` is the
ship half of `.github/workflows/deploy.yml` transcribed into a script, and the
transcription is where the properties that pipeline carried can quietly go
missing: a `--chmod` dropped, a path left pointing at production, an rsync that
grew a `--delete`, a refusal that fires after the first write.

These tests are the only thing that will ever execute this script before it
runs against a live host, so they pin the failure modes rather than the happy
path. There is exactly one happy-path test, and it is there to prove the stubs
are wired up at all; everything else asserts something the script must NOT do:

- that no rsync can delete, because a historian's in-progress tour is not
  recoverable and "nothing is ever deleted" is cheaper than reasoning about
  which paths are safe;
- that `.htaccess` is installed before `app.cgi`, before `backend/`, before
  `content/` and before the `.env` write, because until the front controller is
  in place the document root is uncontained and writing `backend/.env` first
  publishes `MAPILLARY_TOKEN` by URL;
- that the token never reaches an argv, so it is in no process listing and no
  shell history;
- that `make check` runs before the first remote command, so a failing test
  stops the deploy instead of being noticed after half a tree has shipped;
- that `--target` reaches EVERY remote path, because a rehearsal that writes
  into production is worse than no rehearsal;
- that a refusal has done nothing first -- every refusal test below asserts the
  log holds no `ssh` and no `rsync` line;
- and that a remote command failing mid-sequence stops the script, which on the
  `.htaccess` merge is the difference between a stopped deploy and one that
  carries on shipping into an uncontained document root.

The script is driven for real -- `bash deploy/deploy.sh` -- with `ssh`, `rsync`,
`make`, `uv` and `git` replaced by stubs on `PATH` that log their own argv and
exit on command. So what is tested is the script's own control flow and the
arguments it builds, which is what a transcription gets wrong.

Nothing here claims the deploy works. rsync's behaviour, Apache's reading of
the modes, the host's Python, the merge on a real `.htaccess` -- none of that is
in reach of a stub, and `docs/UNVERIFIED.md` says so. The first real run is the
runbook's rehearsal against a staging directory.
"""

from __future__ import annotations

import os
import re
import stat
import subprocess
from pathlib import Path
from typing import NamedTuple

import pytest

REPO = Path(__file__).resolve().parents[2]
SCRIPT = REPO / "deploy" / "deploy.sh"

# Every rsync flag that can remove something on the host. The list is longer
# than it looks and two of them do not contain the string "delete": the old
# check was `"--delete" not in line`, and `--del` -- rsync's own documented
# short form, and the one a person reaches for -- walked straight past it, as
# did `--force`, which removes a non-empty directory to make way for a
# non-directory. A deploy that destroys a historian's in-progress tour is the
# binding failure condition, so this is a token match against a list rather
# than a substring search for two spellings.
DELETING_FLAGS = frozenset(
    [
        "--delete",
        "--delete-before",
        "--delete-during",
        "--delete-after",
        "--delete-delay",
        "--delete-excluded",
        "--delete-missing-args",
        "--del",
        "--remove-source-files",
        "--remove-sent-files",
        "--force",
    ]
)

# What a complete deploy does on the host: mkdir, stage .htaccess, send the
# merge script, run the merge, send app.cgi, chmod it, backend/, the bundle,
# content/, the .env write, the install step.
REMOTE_OPERATIONS = 11

PROD_PATH = "/home/deployer/tours"
STAGING_PATH = "/home/deployer/tours-staging"
TOKEN = "tok-SENTINEL-123"

# Every program the script shells out to is stubbed. A stub that is missing is
# not a harmless gap: the real `rsync` or `ssh` would be found on PATH instead
# and the test would be talking to the network.
STUBS = {
    "rsync": "",
    "make": "",
    "uv": "",
    # The `.env` step pipes the token into ssh's stdin, so the stub has to read
    # it or the pipeline dies of SIGPIPE and the exit code says the wrong
    # thing. It goes to /dev/null: a stub that logged stdin would put the token
    # in the log the token tests then search.
    # stdin is captured to its own numbered file rather than dropped. The
    # last remote step -- the venv guard, `pip install`, and the two chmods --
    # is a heredoc on stdin, so a stub that did `cat > /dev/null` left the
    # whole of it unasserted: deleting `pip install` or either chmod passed the
    # entire suite. It must NOT go into $STUB_LOG, because the `.env` step
    # pipes the token on stdin and the argv log is what the token tests search.
    "ssh": """
n=0
while [ -e "$STUB_STDIN_DIR/$n" ]; do n=$((n + 1)); done
cat > "$STUB_STDIN_DIR/$n"
if [ -n "${STUB_FAIL_SSH_MATCH:-}" ]; then
  case "$*" in
    *"$STUB_FAIL_SSH_MATCH"*) exit 1 ;;
  esac
fi
""",
    # Only the two queries the production gates make. Anything else is a
    # deploy script consulting git for something this harness has not thought
    # about, and should fail rather than return a plausible answer.
    "git": """
case "$1" in
  rev-parse) printf '%s\\n' "${FAKE_BRANCH:-main}"; exit 0 ;;
  status)    if [ -n "${FAKE_DIRTY:-}" ]; then printf '%s\\n' "$FAKE_DIRTY"; fi; exit 0 ;;
  *)         echo "stub git: unexpected '$*'" >&2; exit 2 ;;
esac
""",
}


def _write_stubs(bin_dir: Path) -> None:
    for name, extra in STUBS.items():
        var = f"STUB_EXIT_{name.upper()}"
        path = bin_dir / name
        path.write_text(
            f'#!/bin/sh\nprintf \'%s %s\\n\' "{name}" "$*" >> "$STUB_LOG"\n'
            f'{extra}exit "${{{var}:-0}}"\n'
        )
        path.chmod(0o755)


@pytest.fixture
def run_deploy(tmp_path):
    """Drive the real script with stubbed `ssh`/`rsync`/`make`/`uv`/`git`.

    Returns `(CompletedProcess, log_lines)`, the log being one line per
    subprocess the script ran, in order, as `"<name> <joined argv>"`. Flattening
    the argv loses quoting, which is fine: every assertion below is about which
    arguments are present and in what order, and the one property that would
    need quoting back -- the token's absence -- is a search for a string that
    must appear nowhere at all.
    """
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    _write_stubs(bin_dir)

    log = tmp_path / "stub.log"
    stdin_dir = tmp_path / "stdin"
    stdin_dir.mkdir()
    key = tmp_path / "clio_deploy"
    key.write_text("not a key; the ssh that would read it is a stub\n")
    key.chmod(0o600)

    # SSH_KEY is pointed at a temp file so no real key is read, and DEPLOY_PORT
    # is left out so the default is exercised on every ordinary run.
    default_config = {
        "DEPLOY_HOST": "host.example",
        "DEPLOY_USER": "deployer",
        "DEPLOY_PATH": PROD_PATH,
        "MAPILLARY_TOKEN": TOKEN,
        "SSH_KEY": str(key),
    }

    def _run(args=(), config_set=None, config_mode=0o600, config_path=None, stat_impl=None,
             symlink=False, **env):
        if stat_impl is not None:
            stub = bin_dir / "stat"
            stub.write_text(stat_impl)
            stub.chmod(0o755)

        # `config_path` names a file the test does NOT want created -- the
        # absent-config refusal needs a path with nothing at it.
        path = tmp_path / "deploy.env" if config_path is None else Path(config_path)
        if config_path is None:
            values = dict(default_config)
            # A `None` drops the line entirely, which is a different thing from
            # an empty value: one leaves the variable unset, where `set -u`
            # would otherwise produce `unbound variable` instead of a refusal
            # that says which variable.
            values.update(config_set or {})
            # Quoted, because the config file is SOURCED: `DEPLOY_HOST=a b` is
            # not a value with a space in it, it is a command named `b` run
            # with DEPLOY_HOST in its environment. Quoting is how a person
            # writes a value with a space, and it is the only way the
            # whitespace refusals below get a value to refuse.
            path.write_text(
                "".join(f'{k}="{v}"\n' for k, v in values.items() if v is not None)
            )
            path.chmod(config_mode)
            if symlink:
                # The config becomes a symlink to the real file. A symlink's
                # own mode is always 0755 and `chmod` on it changes its
                # target, so a mode check that does not follow the link
                # refuses this forever with a remedy that cannot work.
                real = path.with_name(path.name + ".real")
                path.rename(real)
                path.symlink_to(real)

        environ = dict(os.environ)
        environ["PATH"] = f"{bin_dir}:{environ['PATH']}"
        environ["STUB_LOG"] = str(log)
        environ["STUB_STDIN_DIR"] = str(stdin_dir)
        # The lock lives in a temp directory, so a test neither trips nor
        # leaves behind the real repository's .deploy.lock.
        environ.setdefault("DEPLOY_LOCK", str(tmp_path / "deploy.lock"))
        environ.update({k: str(v) for k, v in env.items()})

        result = subprocess.run(
            ["bash", str(SCRIPT), "--config", str(path), *args],
            cwd=REPO,
            env=environ,
            capture_output=True,
            text=True,
            stdin=subprocess.DEVNULL,
            check=False,
        )
        lines = log.read_text().strip("\n").split("\n") if log.exists() else []
        stdins = [f.read_text() for f in sorted(stdin_dir.iterdir(), key=lambda f: int(f.name))]
        return Run(result, [ln for ln in lines if ln], stdins)

    return _run


class Run(NamedTuple):
    """What a driven deploy left behind.

    `stdins` is what each `ssh` was fed, in call order, which is the only place
    the remote install script can be inspected: it is a quoted heredoc, so it
    reaches the host on stdin and appears in no argv.
    """

    result: subprocess.CompletedProcess
    log: list[str]
    stdins: list[str]

    def __iter__(self):
        # The tests below unpack `result, log = run_deploy()`; `stdins` is
        # reached by attribute where it is wanted.
        return iter((self.result, self.log))


def remote_script(run: Run) -> str:
    """The install step's heredoc: the last ssh fed anything but the token."""
    scripts = [text for text in run.stdins if "pip install" in text or "VENV=" in text]
    assert len(scripts) == 1, f"expected one remote install script, got {run.stdins!r}"
    return scripts[0]


def index_of(log: list[str], needle: str) -> int:
    """The first log line containing `needle`, or a failure naming the log.

    An ordering assertion built on a needle that is in the log zero times is
    vacuous in the worst way -- it passes -- so this raises instead of
    returning a sentinel.
    """
    for i, line in enumerate(log):
        if needle in line:
            return i
    raise AssertionError(f"nothing in the log mentions {needle!r}:\n" + "\n".join(log))


def remote_lines(log: list[str]) -> list[str]:
    return [ln for ln in log if ln.startswith(("ssh ", "rsync "))]


def test_a_clean_run_on_main_succeeds(run_deploy):
    """The one happy-path test: it exists so a failure anywhere below is a
    statement about the script and not about the harness."""
    result, log = run_deploy()

    assert result.returncode == 0, f"{result.stdout}\n{result.stderr}"
    assert any(ln.startswith("make ") for ln in log), log
    assert any(ln.startswith("rsync ") for ln in log), log


def test_the_front_controller_is_installed_before_anything_else(run_deploy):
    """Review Focus: the ordering the workflow's comment calls load-bearing and
    invisible. Until `.htaccess` is in place the document root is uncontained,
    so `app.cgi`, `backend/`, `content/` and above all the `.env` write must all
    come after the merge -- the last of them because writing `backend/.env`
    into an uncontained root publishes MAPILLARY_TOKEN by URL for the length of
    a pip install."""
    _, log = run_deploy()

    assert index_of(log, "merge-htaccess.sh") < index_of(log, "app.cgi")
    assert index_of(log, "merge-htaccess.sh") < index_of(log, "backend/")
    assert index_of(log, "merge-htaccess.sh") < index_of(log, "content/")
    # Matched as `backend/.env`, not as the token: the token's whole point is
    # that it is in no argv, so there is nothing of it in the log to find.
    assert index_of(log, "merge-htaccess.sh") < index_of(log, "backend/.env")

    # The two assertions above would also hold if the merge were never RUN --
    # the first `merge-htaccess.sh` line is the rsync that ships it. So pin the
    # invocation itself, which is the only line that both runs ssh and names
    # the script.
    merged = index_of(log, f"bash '{PROD_PATH}/deploy/merge-htaccess.sh'")
    assert log[merged].startswith("ssh ")
    assert merged < index_of(log, "app.cgi")
    assert merged < index_of(log, "backend/.env")

    # And the staging copy must arrive BEFORE that merge reads it. This needs
    # its own assertion, found by mutation: `.htaccess.new` names two log lines
    # -- the rsync that stages it and the ssh that merges it -- so
    # `index_of(log, ".htaccess.new")` is satisfied by the merge line alone and
    # says nothing about the rsync. Move the rsync after `app.cgi` and every
    # other assertion in this test still holds, while on a real host the merge
    # runs against a file that is not there, exits non-zero, and the front
    # controller is never installed at all. That is the same exposure window
    # the workflow's comment calls load-bearing, reached from the other side.
    staged = [i for i, ln in enumerate(log)
              if ln.startswith("rsync ") and ".htaccess.new" in ln]
    assert len(staged) == 1, f"expected one rsync staging .htaccess.new: {log}"
    assert staged[0] < merged


def test_no_rsync_can_delete(run_deploy):
    """A deploy that destroys a historian's in-progress tour is a failure
    condition, and nothing in this script needs to remove anything. Sessions
    living outside the deploy tree is the first defence; this is the second."""
    _, log = run_deploy()

    rsyncs = [ln for ln in log if ln.startswith("rsync ")]
    assert rsyncs
    for line in rsyncs:
        for token in line.split():
            assert token.split("=")[0] not in DELETING_FLAGS, f"{token} in: {line}"


def test_the_token_never_appears_in_an_argument(run_deploy):
    """MAPILLARY_TOKEN travels over stdin, so it is in no process listing and
    no shell history. The `backend/.env` assertion is the guard on the guard:
    without it this test passes against a script that never writes the .env at
    all, and "the token appears nowhere" would be true for the wrong reason."""
    _, log = run_deploy()

    assert any("backend/.env" in ln for ln in log), log
    for line in log:
        assert TOKEN not in line, line


def test_no_rsync_carries_a_literal_chmod(run_deploy):
    """Because the rsync that will run this script rejects one.

    The workflow this script was transcribed from used `--chmod=F644` and
    `--chmod=F755`, which is fine on ubuntu-24.04's GNU rsync. On macOS
    /usr/bin/rsync is Apple's openrsync ("rsync version 2.6.9 compatible") and
    a literal mode is refused outright -- `rsync: --chmod=F644: invalid
    argument`, exit 1, nothing transferred. Carried over unchanged, it stopped
    every deploy at the first rsync, after `make check` had already run.

    openrsync accepts only relative forms (`u+x`), and documents --chmod as
    having no effect without `--perms`, which `-rlt` does not pass. So there is
    no spelling that would have worked, and the modes are set on the host
    instead -- which is also the only thing that can repair a file rsync did
    not create.
    """
    _, log = run_deploy()

    for line in [ln for ln in log if ln.startswith("rsync ")]:
        assert "--chmod" not in line, (
            f"openrsync rejects a literal --chmod and exits 1 without transferring: {line}"
        )


def test_app_cgi_is_made_executable_as_soon_as_it_arrives(run_deploy):
    """`rsync -rlt` carries no permissions, so a NEW app.cgi lands 644 and
    Apache 500s on executing it.

    The chmod is asserted to come before the next rsync rather than merely to
    happen: the install step at the end chmods it too, and between the two sit
    the whole of backend/, the bundle, content/, the .env write and a pip
    install. On a first deploy -- the one where app.cgi is new, and therefore
    the one where its mode is wrong -- that gap is minutes of 500 on every URL
    of the subdomain.
    """
    run = run_deploy()
    log = run.log

    sent = index_of(log, "app.cgi")
    made_executable = next(
        i for i, ln in enumerate(log)
        if ln.startswith("ssh ") and "chmod 755" in ln and "app.cgi" in ln
    )
    assert sent < made_executable
    later_rsyncs = [i for i, ln in enumerate(log) if ln.startswith("rsync ") and i > sent]
    assert later_rsyncs, log
    assert made_executable < min(later_rsyncs), (
        f"app.cgi stays mode 644 while the rest of the deploy runs: {log}"
    )


def test_the_remote_install_step_does_all_of_its_work(run_deploy):
    """The install step is a quoted heredoc, so it travels on ssh's stdin and
    appears in no argv. The stub used to drop stdin, which left every line of
    it unasserted: deleting `pip install`, or either chmod, passed the whole
    suite. Those chmods are now the ONLY thing setting the modes Apache needs,
    since no rsync may carry --chmod.
    """
    script = remote_script(run_deploy())

    assert "pip" in script and "install" in script and "requirements.txt" in script
    assert "chmod 755" in script and "app.cgi" in script
    assert "chmod 644" in script and ".htaccess" in script
    # And it refuses rather than creating a venv: the deploy installs into the
    # one the runbook makes by hand, and app.cgi finds its interpreter there.
    assert "/.venv" in script
    assert "exit 1" in script


def test_the_host_env_is_written_only_when_it_is_absent(run_deploy):
    """`backend/.env` is host-owned state. The first deploy bootstraps it;
    later ones leave it alone, so a SESSIONS_DIR or a lowered cap the operator
    set on the host survives.

    Losing this is the nearest thing in the script to destroying a tour: if
    SESSIONS_DIR had been moved off its default, overwriting the file makes
    every in-progress tour invisible to the application in one deploy. The
    property was stated in four places and asserted nowhere -- the only test
    that touched this step matched on `umask 077`, which survives the guard's
    removal.
    """
    _, log = run_deploy()

    line = log[index_of(log, "backend/.env")]
    assert line.startswith("ssh ")
    assert "[ -e " in line, f"the .env write is unconditional: {line}"
    # The skip branch must drain stdin, or the printf upstream of it dies of
    # SIGPIPE and the deploy fails on a host that is behaving correctly.
    assert "cat > /dev/null" in line, f"the skip branch does not drain stdin: {line}"


def test_the_backend_rsync_withholds_the_env_and_the_venv(run_deploy):
    """`backend/.env` exists in this working tree, holding a local token, and
    the host's copy is its own state (above). Dropping the exclude ships the
    author's development `.env` over the host's. `.venv` is excluded too, which
    matters less -- the host's venv is at `$DEPLOY_DIR/.venv`, which no rsync
    destination here reaches -- but shipping a local 3.14 venv to a 3.12 host
    is pointless at best.
    """
    _, log = run_deploy()

    line = log[index_of(log, "backend/ deployer@")]
    assert "--exclude .env" in line, f"the host's own backend/.env is not safe: {line}"
    assert "--exclude .venv" in line, line
    assert "--exclude uv.lock" in line, line


def test_the_whole_check_suite_runs_not_a_part_of_it(run_deploy):
    """`make check` is lint, backend tests, frontend tests and the bundle
    build. The ordering test only asked that *some* `make` ran before the first
    remote command, which `make backend-test` satisfies -- and the runbook
    claims all four ran.
    """
    _, log = run_deploy()

    assert log[index_of(log, "make ")].split() == ["make", "check"], log


def test_requirements_are_exported_without_the_dev_group(run_deploy):
    """uvicorn[standard] must stay off the host: nothing under app/ imports it,
    the CGI path never loads it, and any one of uvloop/httptools/watchfiles
    lacking a cp312 wheel would build from source and fail the install.
    --no-emit-project because the project itself is rsynced, not installed."""
    _, log = run_deploy()

    line = log[index_of(log, "uv ")]
    assert "export" in line
    assert "--no-dev" in line
    assert "--no-emit-project" in line


def test_checks_run_before_the_first_remote_command(run_deploy):
    """Review Focus: checks after the first remote write would ship untested
    code and only then notice."""
    _, log = run_deploy()

    first_remote = min(i for i, ln in enumerate(log) if ln.startswith(("ssh ", "rsync ")))
    assert index_of(log, "make ") < first_remote


def test_a_failing_check_stops_the_deploy_before_it_starts(run_deploy):
    """And the half of that property a pure ordering assertion cannot state:
    that a red suite is a refusal, not a warning. Nothing has left the machine
    when it fires."""
    result, log = run_deploy(STUB_EXIT_MAKE=1)

    assert result.returncode != 0
    assert not remote_lines(log), log


# The production path is a PREFIX of the staging path the rehearsal test uses,
# so `"/home/deployer/tours" not in line` would pass for every line of a
# correct rehearsal AND for every line of one that wrote straight into
# production. This matches the production path only where it is not continued
# by `-staging` or anything else word-like, which is the distinction that
# matters: a path component that ends there.
PRODUCTION_PATH_RE = re.compile(re.escape(PROD_PATH) + r"(?![-\w])")


def test_the_script_is_shipped_executable(run_deploy):
    """Mode 755 in the repository: the runbook's rehearsal is
    `deploy/deploy.sh --target ...`, not `bash deploy/deploy.sh`, and these
    tests go through `bash` so they would not notice the bit was gone."""
    assert SCRIPT.is_file()
    assert SCRIPT.stat().st_mode & stat.S_IXUSR, "deploy/deploy.sh is not executable"


def test_target_replaces_the_production_path_everywhere(run_deploy):
    """Review Focus: a `--target` that reaches some remote paths and not others
    is a rehearsal that writes into production, which is worse than no
    rehearsal -- it is a deploy nobody meant to make, reported as a test."""
    _, log = run_deploy(args=["--target", STAGING_PATH])

    remote = remote_lines(log)
    # Every one of them names a deploy directory, so "mentions the staging
    # path" is a statement about all of them rather than about whichever ones
    # happen to.
    assert len(remote) == REMOTE_OPERATIONS, remote
    for line in remote:
        assert STAGING_PATH in line, line
        assert not PRODUCTION_PATH_RE.search(line), line


def assert_refused(result, log, mentions: str) -> None:
    """A refusal FROM THE SCRIPT, before it did anything, saying what is wrong.

    Three guards, each covering a way this could pass for the wrong reason.
    The 127 clause: `bash` exits 127 with a message on stderr for a script that
    is not there, and "non-zero with something on stderr" is satisfied by its
    own complaint. The `refuses:` prefix: `set -e` tripping over a missing
    `source`, or `set -u` saying `unbound variable`, are also non-zero, also
    name a path, and are also useless in a deploy log -- bash cannot produce
    that prefix. And the empty-log clause, which is the point of a refusal:
    it must come before the first thing that cannot be taken back.
    """
    assert result.returncode != 127, f"the script did not run at all: {result.stderr}"
    assert result.returncode != 0, "the script accepted a configuration it must refuse"
    assert "deploy.sh refuses:" in result.stderr, (
        f"not a deliberate refusal, just a failure: {result.stderr!r}"
    )
    assert mentions in result.stderr, (
        f"the refusal does not say what is wrong ({mentions!r} absent): {result.stderr!r}"
    )
    assert not remote_lines(log), f"the refusal came after touching the host: {log}"


def test_a_deploy_from_another_branch_is_refused(run_deploy):
    """Production runs from `main`. A deploy from a feature branch ships code
    that was never on main to six historians who have no way to tell."""
    result, log = run_deploy(FAKE_BRANCH="rephoto-alignment")

    assert_refused(result, log, "main")
    assert "rephoto-alignment" in result.stderr


def test_a_deploy_from_a_dirty_tree_is_refused(run_deploy):
    """The same property from the other side: what rsync ships is the WORKING
    TREE, not the commit, so an uncommitted edit goes to the host with nothing
    in the history to say what is running there."""
    result, log = run_deploy(FAKE_DIRTY=" M frontend/src/app/editor/edit-map-pane.css")

    assert_refused(result, log, "uncommitted")
    # The refusal is actionable or it is just an obstacle.
    assert "edit-map-pane.css" in result.stderr


def test_both_production_gates_are_reported_together(run_deploy):
    """Fixing one and rerunning only to be told about the other is the kind of
    refusal that gets worked around rather than read."""
    result, log = run_deploy(FAKE_BRANCH="rephoto-alignment", FAKE_DIRTY=" M backend/app/x.py")

    assert_refused(result, log, "main")
    assert "uncommitted" in result.stderr


def test_a_rehearsal_is_exempt_from_both_gates(run_deploy):
    """And the reason the gates are in the script rather than in the branch:
    rehearsing a branch against a staging directory is the whole point of
    `--target`, so it relaxes both. Nothing it writes is production."""
    result, log = run_deploy(
        args=["--target", STAGING_PATH],
        FAKE_BRANCH="rephoto-alignment",
        FAKE_DIRTY=" M backend/app/x.py",
    )

    assert result.returncode == 0, f"{result.stdout}\n{result.stderr}"
    assert len(remote_lines(log)) == REMOTE_OPERATIONS, log


def test_the_whitespace_refusal_names_a_variable_the_operator_has(run_deploy):
    """DEPLOY_PATH reaches the whitespace check as the internal name
    DEPLOY_DIR, which is in no config file and in neither of the runbook's
    tables. The script's own stated principle is that a refusal naming nothing
    is a guessing game, so it reports whichever of the two the operator
    actually typed.
    """
    result, log = run_deploy(config_set={"DEPLOY_PATH": "/home/deployer/tours staging"})
    assert_refused(result, log, "DEPLOY_PATH")
    assert "DEPLOY_DIR" not in result.stderr, result.stderr

    result, log = run_deploy(args=["--target", "/home/deployer/tours staging"])
    assert_refused(result, log, "--target")
    assert "DEPLOY_DIR" not in result.stderr, result.stderr


def test_an_empty_target_is_refused_rather_than_meaning_production(run_deploy):
    """`--target ""` passed the argument check, then fell through
    `${TARGET:-$DEPLOY_PATH}` to production while `[ -z "$TARGET" ]`
    simultaneously re-armed the production gates -- so on main with a clean
    tree it shipped to the historians while the operator believed they were
    rehearsing. `--target "$STAGING"` with STAGING unset is how that gets
    typed, and nothing in the output would have said otherwise.
    """
    result, log = run_deploy(args=["--target", ""])

    assert result.returncode != 0
    assert not remote_lines(log), f"an empty --target deployed somewhere: {log}"
    assert PROD_PATH not in " ".join(log)


def test_a_relative_target_is_refused(run_deploy):
    """The host resolves it against the deploy user's home, which is not where
    any subdomain's document root is. `--target tours-staging` would make a
    directory and deploy into it, succeed, and serve nothing."""
    result, log = run_deploy(args=["--target", "tours-staging"])

    assert result.returncode != 0
    assert not remote_lines(log), log


def test_a_second_deploy_will_not_interleave_with_the_first(run_deploy, tmp_path):
    """The workflow had `concurrency: {group: deploy, cancel-in-progress:
    false}` -- "two rsyncs into the same tree must not interleave". A script is
    easier to run twice than a workflow: two terminals, or a second go because
    the first looked stuck during `make check`.
    """
    held = tmp_path / "held.lock"
    held.mkdir()
    result, log = run_deploy(DEPLOY_LOCK=str(held))

    assert result.returncode != 0
    assert "refuses" in result.stderr
    assert not remote_lines(log), log


def test_the_lock_is_released_so_the_next_deploy_can_run(run_deploy, tmp_path):
    """A lock a successful deploy does not release is a deploy that works once."""
    lock = tmp_path / "released.lock"
    first, _ = run_deploy(DEPLOY_LOCK=str(lock))
    assert first.returncode == 0, first.stderr
    assert not lock.exists(), "the lock outlived the deploy that took it"

    second, log = run_deploy(DEPLOY_LOCK=str(lock))
    assert second.returncode == 0, second.stderr
    # The stub log is cumulative across calls within one test, so a second
    # complete deploy is twice the operations rather than the same count.
    assert len(remote_lines(log)) == 2 * REMOTE_OPERATIONS, log
    assert not lock.exists()


def test_an_absent_config_file_is_refused_by_name(run_deploy, tmp_path):
    """`source` on a missing file under `set -e` also stops the script, but it
    stops it with bash's line number, which does not say that the thing to do
    is copy deploy.env.example."""
    result, log = run_deploy(config_path=tmp_path / "not-there.env")

    assert_refused(result, log, str(tmp_path / "not-there.env"))
    assert "deploy.env.example" in result.stderr


@pytest.mark.parametrize("name", ["DEPLOY_HOST", "DEPLOY_USER", "DEPLOY_PATH", "MAPILLARY_TOKEN"])
@pytest.mark.parametrize("value", ["", None], ids=["empty", "absent"])
def test_a_missing_required_value_is_refused_by_name(run_deploy, name, value):
    """Named, because four variables in one file and a refusal saying only
    "configuration is incomplete" is a guessing game. Absent and empty are
    tested separately: `set -u` turns the first into `unbound variable`, which
    is non-zero and says nothing."""
    result, log = run_deploy(config_set={name: value})

    assert_refused(result, log, name)


@pytest.mark.parametrize(
    "config_mode",
    [0o644, 0o640, 0o604, 0o660, 0o606, 0o666],
    ids=["644", "640", "604", "660", "606", "666"],
)
def test_a_config_file_others_can_read_is_refused(run_deploy, config_mode):
    """The file holds MAPILLARY_TOKEN. On a shared or synced machine any of
    these is the token readable or writable by something that is not the
    owner, and the cost of noticing is one `stat`.

    Parametrised because the check is a mask, and a mask is the kind of thing
    that is right for the case it was written against and wrong by one bit for
    the rest: narrowing `& 8#77` to `& 8#7` still refuses 644 and lets 640
    through.
    """
    result, log = run_deploy(config_mode=config_mode)

    assert_refused(result, log, "600")


def test_an_owner_only_config_file_is_accepted(run_deploy):
    """The other side of the mask: it must not refuse what it exists to allow."""
    result, log = run_deploy(config_mode=0o600)

    assert result.returncode == 0, f"{result.stdout}\n{result.stderr}"
    assert len(remote_lines(log)) == REMOTE_OPERATIONS, log


def test_a_symlinked_config_file_is_accepted(run_deploy):
    """`deploy/deploy.env -> ~/secrets/clio.env` is a reasonable way to keep
    the credential out of the repository directory.

    A symlink's own mode is always 0755, and BSD `stat -f` reports the link
    rather than its target -- so without `-L` this is refused as
    world-readable, and the refusal's own remedy cannot clear it: `chmod 600`
    on a symlink changes the target, leaving the link at 0755 forever. The
    target here is 600, which is the mode that matters.
    """
    result, log = run_deploy(symlink=True)

    assert result.returncode == 0, f"{result.stdout}\n{result.stderr}"
    assert len(remote_lines(log)) == REMOTE_OPERATIONS, log


@pytest.mark.parametrize(
    "config_set",
    [
        {"DEPLOY_HOST": "host.example extra"},
        {"DEPLOY_USER": "deployer deployer"},
        {"DEPLOY_PORT": "22 "},
        {"SSH_KEY": "/tmp/a key"},
        {"DEPLOY_PATH": "/home/deployer/tours staging"},
    ],
    ids=["host", "user", "port", "key", "path"],
)
def test_a_config_value_containing_whitespace_is_refused(run_deploy, config_set):
    """Review Focus: rsync's --rsh takes ONE string and splits it on whitespace
    itself, so these five values are joined with spaces and there is no quoting
    that survives. A space in DEPLOY_HOST does not fail cleanly -- it makes
    rsync's ssh take a different argument list, which can mean connecting
    somewhere unintended -- so it is refused before anything is built."""
    result, log = run_deploy(config_set=config_set)

    assert_refused(result, log, "whitespace")


def test_a_target_containing_whitespace_is_refused(run_deploy):
    """The deploy directory goes through the same --rsh-joined string, and it
    is the one of the five that does not come from the config file."""
    result, log = run_deploy(args=["--target", "/home/deployer/tours staging"])

    assert_refused(result, log, "whitespace")


def test_the_first_failing_ssh_stops_everything(run_deploy):
    """Review Focus: `set -e` is easy to lose -- a remote command inside an
    `if`, or a `$(...)` in a condition, has its failure swallowed -- and the
    shape of that bug is a deploy that carries on past a failure and reports
    success. Nothing may run after the failed command."""
    result, log = run_deploy(STUB_EXIT_SSH=1)

    assert result.returncode != 0
    first_ssh = min(i for i, ln in enumerate(log) if ln.startswith("ssh "))
    assert first_ssh == len(log) - 1, f"the deploy continued past a failed ssh: {log}"
    assert not [ln for ln in log if ln.startswith("rsync ")], log


def test_a_failed_htaccess_merge_stops_the_deploy(run_deploy):
    """The specific case the ordering exists for. If the merge fails, the
    document root is uncontained -- either there is no `.htaccess` or it is the
    host's old one -- and continuing would ship `app.cgi`, `backend/`,
    `content/` and the token-bearing `.env` into it. Nothing after the merge
    may run, and `app.cgi` is the very next thing."""
    result, log = run_deploy(STUB_FAIL_SSH_MATCH="merge-htaccess.sh")

    assert result.returncode != 0
    assert not any("app.cgi" in ln for ln in log), log
    assert not any("backend/.env" in ln for ln in log), log
    # And it got as far as attempting the merge, or this test proves nothing.
    assert any(ln.startswith("ssh ") and "merge-htaccess.sh" in ln for ln in log), log


def test_a_failed_rsync_stops_the_deploy(run_deploy):
    """The same property for the other half of the sequence. The first rsync is
    the staged `.htaccess`, so "it failed and we carried on" means deploying
    into a root the front controller never reached."""
    result, log = run_deploy(STUB_EXIT_RSYNC=1)

    assert result.returncode != 0
    first_rsync = min(i for i, ln in enumerate(log) if ln.startswith("rsync "))
    assert first_rsync == len(log) - 1, f"the deploy continued past a failed rsync: {log}"


def test_a_failed_env_write_stops_the_deploy(run_deploy):
    """The `.env` step is the one remote command on the right-hand side of a
    PIPE, which is the shape most likely to have its status dropped. It is not
    dropped here, and not because of `pipefail`: ssh is the LAST command of the
    pipeline, so its status is the pipeline's and plain `set -e` catches it.
    (`pipefail` covers the other side -- `printf` failing on a remote end that
    does not drain stdin -- and that one is not reachable from a test: whether
    a 30-byte write into a 64KB pipe buffer meets SIGPIPE before the reader
    exits is a race, so a test for it would pass or fail by timing. The script
    keeps `pipefail` and the remote command keeps its `cat > /dev/null`; what
    is pinned here is the half that can be pinned.)

    Losing even this one means a host with no `backend/.env`, hence no
    Mapillary token, reported as a successful deploy."""
    result, log = run_deploy(STUB_FAIL_SSH_MATCH="umask 077")

    assert result.returncode != 0
    assert any("backend/.env" in ln for ln in log), log
    assert not any(ln.endswith("bash -s") or "bash -s '" in ln for ln in log), log


# `stat` is the one tool in the script with no portable spelling, and the mode
# check is the thing standing between MAPILLARY_TOKEN and anything that can
# read a home directory -- so a fallback that silently stops checking is the
# failure to look for. These stand in for the three shapes it can meet. The
# real mode comes from a real `stat` underneath, so a stub cannot make the
# check pass by inventing a mode.
BSD_ONLY_STAT = """#!/bin/sh
case "$1" in
  -Lf) exec /usr/bin/stat -Lf "$2" "$3" ;;
  *)  echo "stat: illegal option -- ${1#-}" >&2; exit 1 ;;
esac
"""

GNU_ONLY_STAT = """#!/bin/sh
case "$1" in
  -Lc) exec /usr/bin/stat -Lf '%Lp' "$3" ;;
  *)  echo "stat: invalid option -- '${1#-}'" >&2; exit 1 ;;
esac
"""

# GNU `stat` does not take a FORMAT after -f: it reads `%Lp` as a FILENAME, so
# it complains about that, prints the real file's filesystem block on STDOUT,
# and exits non-zero. A fallback written as `stat -f ... || stat -c ...` inside
# one command substitution therefore captures the first command's output
# CONCATENATED with the second's, and "600" is not what comes out.
GNU_STAT_THAT_PRINTS_FIRST = """#!/bin/sh
case "$1" in
  -Lf) echo "  File: \\"$3\\""; echo "    ID: 0 Namelen: 255     Type: apfs"
       echo "stat: cannot read file system information for '$2'" >&2; exit 1 ;;
  -Lc) exec /usr/bin/stat -Lf '%Lp' "$3" ;;
esac
"""

NO_USABLE_STAT = """#!/bin/sh
echo "stat: unrecognised option '$1'" >&2
exit 1
"""


@pytest.mark.parametrize(
    "stat_impl",
    [BSD_ONLY_STAT, GNU_ONLY_STAT, GNU_STAT_THAT_PRINTS_FIRST],
    ids=["bsd", "gnu", "gnu-prints-on-stdout-and-fails"],
)
def test_the_mode_check_works_with_either_stat(run_deploy, stat_impl):
    """Both spellings, and the awkward middle case. A 600 file deploys."""
    result, log = run_deploy(stat_impl=stat_impl)

    assert result.returncode == 0, f"{result.stdout}\n{result.stderr}"
    assert len(remote_lines(log)) == REMOTE_OPERATIONS, log


@pytest.mark.parametrize(
    "stat_impl",
    [BSD_ONLY_STAT, GNU_ONLY_STAT, GNU_STAT_THAT_PRINTS_FIRST],
    ids=["bsd", "gnu", "gnu-prints-on-stdout-and-fails"],
)
def test_the_mode_check_still_refuses_with_either_stat(run_deploy, stat_impl):
    """And the half that matters: a fallback that reaches the wrong platform's
    `stat` and quietly treats "no answer" as "fine" is a check that has been
    turned off, which is indistinguishable from a passing deploy."""
    result, log = run_deploy(stat_impl=stat_impl, config_mode=0o644)

    assert_refused(result, log, "600")


def test_a_stat_that_answers_neither_way_is_refused(run_deploy):
    """Unknown is not the same as fine. If the mode cannot be read at all, the
    script does not know whether the token is exposed, and the deploy is not
    urgent enough to guess."""
    result, log = run_deploy(stat_impl=NO_USABLE_STAT)

    assert_refused(result, log, "stat")


REQUIRED = ("DEPLOY_HOST", "DEPLOY_USER", "DEPLOY_PATH", "MAPILLARY_TOKEN")
OPTIONAL = ("SSH_KEY", "DEPLOY_PORT")


def test_the_shipped_example_config_assigns_exactly_what_the_script_reads(run_deploy, tmp_path):
    """A `cp deploy.env.example deploy.env` with nothing filled in is the state
    every new machine starts in, so the example has to spell the variables the
    way the script reads them.

    This is a STRUCTURAL comparison, not a behavioural one, and that is the
    whole point: a typo in the example leaves the variable unset, and an unset
    variable produces exactly the same `DEPLOY_USER is empty or absent`
    refusal as the correctly-spelled empty one. Running the example and reading
    the refusal therefore cannot tell a working example from a broken one. The
    names are compared against both files instead, so renaming a variable in
    one without the other fails here."""
    example = (REPO / "deploy" / "deploy.env.example").read_text()
    script = SCRIPT.read_text()

    assigned = {
        m.group(2): m.group(1) == "#"
        for m in re.finditer(r"(?m)^(#?)([A-Z_][A-Z0-9_]*)=", example)
    }
    assert set(assigned) == set(REQUIRED) | set(OPTIONAL), assigned

    for name in REQUIRED:
        assert not assigned[name], f"{name} is commented out, so the example cannot be filled in"
        # And it is the script's own list, not a second opinion about it.
        assert f"for name in {' '.join(REQUIRED)}" in script
    for name in OPTIONAL:
        assert assigned[name], f"{name} is not commented out, so the example overrides its default"
        assert f"{name}=${{{name}:-" in script, f"{name} has no default in the script"

    # The header has to carry the chmod: the script refuses a loose file, and a
    # refusal whose fix is not written down beside the file is a puzzle.
    header = example.split("DEPLOY_HOST=")[0]
    assert "chmod 600" in header
    assert "deploy/deploy.env" in header

    # Finally, that it is a file the script can actually read and refuse on its
    # contents rather than on its syntax.
    config = tmp_path / "from-example.env"
    config.write_text(example)
    config.chmod(0o600)
    result, log = run_deploy(config_path=config)
    assert_refused(result, log, "DEPLOY_HOST")
