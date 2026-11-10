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
import subprocess
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
SCRIPT = REPO / "deploy" / "deploy.sh"

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
    "ssh": """
cat > /dev/null
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
    key = tmp_path / "clio_deploy"
    key.write_text("not a key; the ssh that would read it is a stub\n")
    key.chmod(0o600)

    default_config = (
        f"DEPLOY_HOST=host.example\n"
        f"DEPLOY_USER=deployer\n"
        f"DEPLOY_PATH={PROD_PATH}\n"
        f"MAPILLARY_TOKEN={TOKEN}\n"
        f"SSH_KEY={key}\n"
    )

    def _run(args=(), config=None, config_mode=0o600, config_path=None, **env):
        # `config_path` names a file the test does NOT want created -- the
        # absent-config refusal needs a path with nothing at it.
        path = tmp_path / "deploy.env" if config_path is None else Path(config_path)
        if config_path is None:
            path.write_text(default_config if config is None else config)
            path.chmod(config_mode)

        environ = dict(os.environ)
        environ["PATH"] = f"{bin_dir}:{environ['PATH']}"
        environ["STUB_LOG"] = str(log)
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
        return result, [ln for ln in lines if ln]

    return _run


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

    assert index_of(log, ".htaccess.new") < index_of(log, "app.cgi")
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


def test_no_rsync_can_delete(run_deploy):
    """A deploy that destroys a historian's in-progress tour is a failure
    condition, and nothing in this script needs to remove anything. Sessions
    living outside the deploy tree is the first defence; this is the second."""
    _, log = run_deploy()

    rsyncs = [ln for ln in log if ln.startswith("rsync ")]
    assert rsyncs
    for line in rsyncs:
        assert "--delete" not in line, line
        assert "--remove-source-files" not in line, line


def test_the_token_never_appears_in_an_argument(run_deploy):
    """MAPILLARY_TOKEN travels over stdin, so it is in no process listing and
    no shell history. The `backend/.env` assertion is the guard on the guard:
    without it this test passes against a script that never writes the .env at
    all, and "the token appears nowhere" would be true for the wrong reason."""
    _, log = run_deploy()

    assert any("backend/.env" in ln for ln in log), log
    for line in log:
        assert TOKEN not in line, line


def test_the_modes_apache_reads_are_given_explicitly(run_deploy):
    """`rsync -rlt` carries no permissions. Without --chmod, app.cgi arrives
    644 and Apache 500s on executing it, and an .htaccess Apache cannot read is
    500 on every URL in the tree -- the same outage from the other side."""
    _, log = run_deploy()

    assert "--chmod=F644" in log[index_of(log, ".htaccess.new")]
    assert "--chmod=F755" in log[index_of(log, "app.cgi")]
    assert "--chmod=F755" in log[index_of(log, "merge-htaccess.sh")]


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
