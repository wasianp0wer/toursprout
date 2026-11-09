# Serving the hosted editor through CGI — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve the already-built hosted editor from a host that has no
Passenger and no cPanel Python app, by running the application as CGI behind
an Apache front controller.

**Architecture:** Apache answers for the built Angular bundle; two URL
prefixes (`/api`, `/tour-data`) are rewritten to one CGI script, which execs
the host venv's `python3.12` and bridges the ASGI app through `a2wsgi` and
`wsgiref`. Nothing about the session, sweep, cap or recovery-key design
changes; the sweep's in-memory throttle moves to a file because every CGI
request is a fresh process.

**Tech Stack:** Python 3.12, FastAPI, `a2wsgi`, `wsgiref.handlers`, Apache
`mod_rewrite` via `.htaccess`, GitHub Actions + rsync over SSH.

**Spec:** `docs/superpowers/specs/2026-11-09-cgi-deployment-design.md`

## Global Constraints

- **The backend test command in this environment is
  `cd backend && UV_CACHE_DIR=$PWD/../.uv-cache uv run --no-sync pytest -q`.**
  Plain `make backend-test` re-resolves dependencies, which needs network this
  sandbox does not have, and Task 4 lowers `requires-python` which makes `uv`
  want to re-resolve on every call. `--no-sync` uses the venv as it stands.
  The baseline is **543 passed**. Lint: `uv run --no-sync ruff check app tests ../content/scripts`.
- **`a2wsgi` 1.10.10 IS installed in this environment** (it arrived with
  commit `f708161`). Earlier documents say it cannot be; they are out of date.
  Nothing in this plan may be written as skipped-here-runs-on-the-host.
- **The raw `sid` is a credential** (it is also the recovery key). It must
  never be written to a log, and must never appear in a static asset URL.
- **No operation may destroy a historian's in-progress tour**, and no
  historian may read or overwrite another's. These outrank every other goal
  in this plan.
- **Never add `--delete` to the deploy's rsyncs.**
- **Python floor: `>=3.12`** (the host has 3.12.15). CI pins exactly `3.12`.
- The frontend does not change. `backend/app/` changes only where the
  execution model forces it.
- Ruff line length is 100.

## Review Focus

Five things the spec implies that would bite a historian, each pinned to a
test in the task that owns the code:

1. **A media filename with a space or a non-ASCII character** (`façade one.jpg`)
   fetched through CGI: `PATH_INFO` must be percent-decoded bytes read back as
   latin-1, because that is what `a2wsgi` re-decodes as UTF-8. Get this wrong
   and the historian's own uploads 404. → Task 1.
2. **A query string on a dynamic URL** must not end up in the routed path. → Task 1.
3. **A new top-level route added later** (a future `/export`, say) would be
   silently swallowed by the SPA fallback instead of reaching the app. → Task 2.
4. **The sweep's stamp file must not be mistaken for a session**: not swept,
   not reported as removed, and not able to age a real session out. → Task 3.
5. **A stamp that cannot be written, or one dated in the future**, must not
   raise into a request, must not cause a sweep on every single request, and
   must not suppress the sweep forever. → Task 3.

---

## Task 1: The CGI entry point

Replaces `passenger_wsgi.py`. Two files: a four-line shell script Apache
executes, and a Python module that normalises the CGI environment and runs
the bridged app. The module is importable, so all of it is testable here.

**Files:**
- Create: `backend/app/cgi.py`
- Create: `app.cgi` (repository root, mode 755)
- Delete: `passenger_wsgi.py`
- Rename: `backend/tests/test_wsgi.py` → `backend/tests/test_cgi.py` (`git mv`;
  it also holds the egress-diagnostic tests, which stay in it unchanged)
- Modify: `docs/ARCHITECTURE.md:56` (the file-inventory row for `passenger_wsgi.py`)
- Modify: `.github/workflows/deploy.yml:184` (the rsync line for the entry point)

**Interfaces:**
- Consumes: `app.main.app` (the module-level FastAPI instance), `a2wsgi.ASGIMiddleware`.
- Produces, in `backend/app/cgi.py`:
  - `cgi_environ(environ: Mapping[str, str]) -> dict[str, str]`
  - `application` — the WSGI callable, `ASGIMiddleware(app)`, built at import
  - `run(environ, stdin, stdout, errors, wsgi_app=None) -> None`
  - `main() -> None`
  - Task 2's `.htaccess` rewrites to the filename `app.cgi` at the document root.

**Why `REQUEST_URI` and not `PATH_INFO`:** the front controller sends every
dynamic URL to one script, so Apache sets `SCRIPT_NAME=/app.cgi` and leaves
`PATH_INFO` empty — routing on those two would 404 every route. `REQUEST_URI`
still holds what the browser asked for. `SCRIPT_NAME` is cleared because
`a2wsgi` turns it into `root_path` and prepends it to the path
(`a2wsgi/asgi.py:92-93`).

- [ ] **Step 1: Write the failing tests** in `backend/tests/test_cgi.py`,
      above the egress tests that are already there.

```python
CGI_ENV = {
    "REQUEST_METHOD": "GET", "SERVER_NAME": "h", "SERVER_PORT": "443",
    "SERVER_PROTOCOL": "HTTP/1.1", "SCRIPT_NAME": "/app.cgi", "PATH_INFO": "",
    "QUERY_STRING": "", "HTTP_HOST": "h", "wsgi.url_scheme": "https",
}


def _drive(wsgi_app, **overrides):
    """Run one request through the CGI handler; return (headers, body, stderr)."""
    out, err = io.BytesIO(), io.StringIO()
    cgi.run(io.BytesIO(b""), out, err, {**CGI_ENV, **overrides}, wsgi_app=wsgi_app)
    head, _, body = out.getvalue().partition(b"\r\n\r\n")
    return head.decode("latin-1"), body, err.getvalue()


def test_the_path_comes_from_request_uri_not_path_info():
    env = cgi.cgi_environ({**CGI_ENV, "REQUEST_URI": "/api/health"})
    assert env["PATH_INFO"] == "/api/health"
    assert env["SCRIPT_NAME"] == ""


def test_a_query_string_is_not_part_of_the_path():
    env = cgi.cgi_environ({**CGI_ENV, "REQUEST_URI": "/api/session/examples?x=1"})
    assert env["PATH_INFO"] == "/api/session/examples"


def test_a_percent_encoded_utf8_filename_survives_the_bridge():
    # a2wsgi does PATH_INFO.encode("latin1").decode("utf8"), so PATH_INFO must
    # be the decoded BYTES read back as latin-1 -- not str.
    env = cgi.cgi_environ(
        {**CGI_ENV, "REQUEST_URI": "/tour-data/media/fa%C3%A7ade%20one.jpg"})
    assert env["PATH_INFO"].encode("latin-1").decode("utf-8") == \
        "/tour-data/media/façade one.jpg"


def test_without_a_request_uri_path_info_is_left_alone():
    env = cgi.cgi_environ({**CGI_ENV, "PATH_INFO": "/api/health"})
    assert env["PATH_INFO"] == "/api/health"


def test_the_cgi_script_answers_a_dynamic_route(tmp_path):
    head, body, errors = _drive(_wsgi(tmp_path), REQUEST_URI="/api/health")
    assert head.startswith("Status: 200 OK")
    assert json.loads(body) == {"status": "ok"}
    assert errors == ""


def test_the_cgi_script_serves_a_historians_own_media_by_its_real_name(tmp_path):
    """The whole point of Review Focus 1, end to end: a session, a file with a
    space and a ç in its name, fetched the way a browser would ask for it."""
    cfg = Settings(content_dir=tmp_path, sessions_dir=tmp_path / "sessions",
                   frontend_dist=tmp_path / "nodist")
    app = create_app(cfg)
    with TestClient(app, base_url="https://testserver") as c:
        c.post("/api/session/new", json={"title": "T"})
        sid = c.cookies[SID_COOKIE]
    (cfg.sessions_dir / sid / "media" / "façade one.jpg").write_bytes(JPEG)
    head, body, _ = _drive(
        ASGIMiddleware(app),
        REQUEST_URI="/tour-data/media/" + quote("façade one.jpg"),
        HTTP_COOKIE=f"{SID_COOKIE}={sid}")
    assert head.startswith("Status: 200 OK")
    assert "content-type: image/jpeg" in head.lower()
    assert body == JPEG


def test_another_historian_cannot_read_it_through_cgi_either(tmp_path):
    """Containment is not weakened by the new entry point: the same URL with
    a different cookie must not serve the file. Same setup as above, then:"""
    head, body, _ = _drive(
        ASGIMiddleware(app),
        REQUEST_URI="/tour-data/media/" + quote("façade one.jpg"),
        HTTP_COOKIE=f"{SID_COOKIE}={'a' * 16}")
    assert head.startswith("Status: 404")
    assert body != JPEG


def test_the_apache_entry_script_is_executable_and_names_the_venv():
    """`app.cgi` is a deploy contract: Apache executes it, so the mode and the
    interpreter path are part of the shipped artefact, not cosmetics."""
    script = ROOT / "app.cgi"
    assert script.stat().st_mode & 0o111
    text = script.read_text()
    assert text.startswith("#!/bin/sh\n")
    assert ".venv/bin/python" in text
    assert "-m app.cgi" in text
```

`JPEG` is the four-byte-prefix fixture `test_session_cookie.py:36` uses;
`_wsgi(tmp_path)` builds `ASGIMiddleware(create_app(Settings(...)))` the way
the existing `_cfg` helper in this file does. Keep `test_app_state_exists_without_a_lifespan`
(reworded for CGI) and both egress tests.

- [ ] **Step 2: Run them to verify they fail**

Run: `cd backend && UV_CACHE_DIR=$PWD/../.uv-cache uv run --no-sync pytest tests/test_cgi.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.cgi'`.

- [ ] **Step 3: Write `backend/app/cgi.py`**

Signatures, in this order, with `sys.path` untouched (`app.cgi` sets
`PYTHONPATH` instead):

```python
def cgi_environ(environ: Mapping[str, str]) -> dict[str, str]: ...
application = ASGIMiddleware(app)
def run(stdin: IO[bytes], stdout: IO[bytes], errors: IO[str],
        environ: Mapping[str, str], wsgi_app: object | None = None) -> None: ...
def main() -> None: ...
```

`run` uses `wsgiref.handlers.BaseCGIHandler(stdin, stdout, errors,
cgi_environ(environ), multithread=False, multiprocess=True).run(wsgi_app or application)`.
`main()` is `run(sys.stdin.buffer, sys.stdout.buffer, sys.stderr, os.environ)`
wrapped so that an exception reaching it prints `Status: 500 Internal Server
Error`, a `Content-Type`, a blank line and one fixed sentence to stdout, and
the traceback to stderr — otherwise a bad import on the host reaches the
browser as Apache's bare "Premature end of script headers" with nothing to
read. Module ends with `if __name__ == "__main__": main()`.

Two notes for the docstrings, because both are decisions a reader will
otherwise undo:
- The spec says `CGIHandler`; `BaseCGIHandler` is `CGIHandler`'s own base
  class with the environ passed in rather than read from `os.environ`. Same
  handler, same output, and it is what makes the tests above possible.
- The traceback on stderr goes to the host's error log, which is operator-only
  — but a traceback can carry a `sid`, so that log is as sensitive as
  `sessions_dir`. Task 5 says so in the runbook.

- [ ] **Step 4: Write `app.cgi`** (and `chmod 755` it)

```sh
#!/bin/sh
# Apache's CGI entry point: the only file the web server executes.
#
# A shell wrapper rather than a Python script with a shebang, because the
# shebang would have to name an absolute interpreter path that differs per
# host. $0 is this script's own path, so the venv is found relative to it.
# The venv is created once by hand (docs/DEPLOY.md step 4) and the deploy
# installs into it; it is never rsynced. -P keeps the document root off
# sys.path, so a file dropped beside this one cannot shadow a module.
DIR=$(dirname "$0")
PYTHONPATH="$DIR/backend" exec "$DIR/.venv/bin/python" -P -m app.cgi
```

- [ ] **Step 5: Delete `passenger_wsgi.py`** and point the workflow at the new
      file: `$RSYNC --chmod=F755 app.cgi "deploy-host:$DEPLOY_DIR/"`.
      `--chmod` is required: `rsync -rlt` carries no permissions, so without it
      the script arrives mode 644 and Apache 500s.

- [ ] **Step 6: Update `docs/ARCHITECTURE.md:56`** — the row describes
      `../../passenger_wsgi.py`. Replace it with two rows, `../../app.cgi` and
      `app/cgi.py`, saying what each is for. Keep the sentence about the bridge
      not running the ASGI lifespan: it is still why `create_app` sets
      `app.state.cfg` in its body.

- [ ] **Step 7: Run the full suite and the linter**

Expected: PASS, and a total of 543 + the new tests.

- [ ] **Step 8: Commit**

```bash
git add -A && git commit -m "Run the app as CGI instead of under Passenger"
```

---

## Task 2: The front controller, and the host-side install

Apache answers for the bundle; the application answers two prefixes. This
task also fixes the deploy's host-side step, which currently guesses at a
CloudLinux virtualenv path and touches a restart file for a process that does
not exist.

**Depends on:** Task 1 (the script's name and location).

**Files:**
- Create: `.htaccess` (repository root)
- Create: `backend/tests/test_htaccess.py`
- Modify: `.github/workflows/deploy.yml` (add `.htaccess` to the rsynced set;
  replace the *Install dependencies and restart* step; drop `tmp` from the
  `mkdir -p`)

**Interfaces:**
- Consumes: `app.cgi` at the document root (Task 1); `Settings.frontend_dist`
  from `backend/app/config.py:20`.
- Produces: the deploy contract that the venv lives at `$DEPLOY_DIR/.venv`
  and that the subdomain's document root is `$DEPLOY_DIR` (Task 5 documents both).

**What cannot be tested here:** Apache. There is no server in this
environment, so no test in this task may claim the rewrites work — that is
Task 6's `UNVERIFIED.md` entry and Task 5's `curl` checks. What *is* tested is
the two ways the file silently goes out of step with the code.

- [ ] **Step 1: Write the failing tests** in `backend/tests/test_htaccess.py`

```python
HTACCESS = (Path(__file__).resolve().parents[2] / ".htaccess").read_text()

DOC_ROUTES = {"/docs", "/docs/oauth2-redirect", "/redoc", "/openapi.json"}


def test_every_dynamic_prefix_the_app_serves_is_routed_to_the_cgi_script():
    """The front controller sends two prefixes to the application and falls
    back to index.html for everything else. A route added at a third prefix
    would be answered by the single-page app instead of the backend, with no
    error anywhere -- so the two lists are pinned together here.

    FastAPI's own /docs, /redoc and /openapi.json are deliberately NOT routed:
    they are unreachable on the host, which is where they belong.
    """
    app = create_app(Settings(...))
    served = {"/" + r.path.lstrip("/").split("/")[0]
              for r in app.routes if getattr(r, "path", "").startswith("/")}
    assert served - DOC_ROUTES - {"/"} == {"/api", "/tour-data"}
    assert re.search(r"RewriteRule\s+\^\(api\|tour-data\)", HTACCESS)


def test_the_front_controller_serves_the_bundle_config_points_at():
    """If frontend_dist moves, .htaccess serves a directory that is not there
    and every page load falls through to a missing index.html."""
    rel = Settings().frontend_dist.relative_to(REPO_DIR).as_posix()
    assert rel == "frontend/dist/frontend/browser"
    assert HTACCESS.count(rel) >= 2  # the -f test and the index.html fallback


def test_the_front_controller_keeps_python_off_the_static_path():
    """Review-Focus-adjacent, and an anti-goal of the spec: nothing under the
    document root is served except the bundle, so backend/.env and the venv
    are not reachable by URL."""
    assert "Require all denied" in HTACCESS
    assert '<Files ".env">' in HTACCESS
```

- [ ] **Step 2: Run them to verify they fail**

Expected: FAIL with `FileNotFoundError: .htaccess`.

- [ ] **Step 3: Write `.htaccess`**

```apache
Options +ExecCGI -Indexes
AddHandler cgi-script .cgi

<Files ".env">
  Require all denied
</Files>

RewriteEngine On

# 1. The application. No PATH_INFO is appended on purpose: app.cgi reads the
#    path from REQUEST_URI, which survives any rewrite. /tour-data stays here
#    rather than becoming a static alias because the sid in the URL is also
#    the historian's recovery key.
RewriteRule ^(api|tour-data)(/|$) app.cgi [QSA,L]

# 2. The built bundle, served by Apache -- the reason a JavaScript chunk does
#    not pay a 0.4 s process start.
RewriteCond %{DOCUMENT_ROOT}/frontend/dist/frontend/browser/$1 -f
RewriteRule ^(.+)$ frontend/dist/frontend/browser/$1 [L]

# 3. Every other path is a deep link into the single-page app -- the job
#    _SpaFiles does in development. This is also what keeps backend/,
#    content/ and .venv/ off the web: nothing under the document root is
#    served except the bundle and the two prefixes above.
RewriteRule ^ frontend/dist/frontend/browser/index.html [L]
```

- [ ] **Step 4: Run the tests to verify they pass**

- [ ] **Step 5: Rewrite the deploy's host-side step** in `.github/workflows/deploy.yml`

- `mkdir -p` loses `'$DEPLOY_DIR/tmp'`.
- Add `$RSYNC .htaccess "deploy-host:$DEPLOY_DIR/"` beside the `app.cgi` line.
- Replace *Install dependencies and restart* with *Install dependencies*:
  the venv is `$DEPLOY_DIR/.venv`, checked for with `[ -x "$VENV/bin/python" ]`
  and a message naming `docs/DEPLOY.md` step 4 if it is missing; then
  `"$VENV/bin/pip" install -r "$DIR/backend/requirements.txt"`; then
  `chmod 755 "$DIR/app.cgi"` as a second guarantee behind `--chmod=F755`.
  No `touch tmp/restart.txt`: there is no resident process, and CGI picks up
  new files on the next request.
- Replace the step's comment block. The old one explains the CloudLinux
  virtualenv guess; the new one should say the venv path is a deploy contract
  the runbook creates, not a guess about the host.

- [ ] **Step 6: Run the full suite and the linter**, then **commit**

```bash
git add -A && git commit -m "Let Apache serve the bundle and route two prefixes to CGI"
```

---

## Task 3: The sweep's throttle moves to a file

`_sweep_once` throttles on `app.state.last_sweep`. Under CGI every request is
a fresh process, so that attribute is always unset and the throttle never
fires — a full walk of every session directory on every cookieless mint.

**Parallel-safe with Task 2** (no shared files), though the worktree setup in
this repository is expensive (no network for `uv`, `node_modules` must be
symlinked), so sequential execution is the default.

**Files:**
- Modify: `backend/app/sessions.py` (add the stamp; `sweep` already ignores it)
- Modify: `backend/app/main.py:273-293` (`SWEEP_INTERVAL_SECONDS`, `_monotonic`,
  `_sweep_once`) and its one call site at `main.py:322`
- Modify: `backend/tests/test_sessions.py` (unit tests, beside the sweep tests)
- Modify: `backend/tests/test_session_cookie.py:604-636` (the throttle tests)

**Interfaces:**
- Produces, in `backend/app/sessions.py`:
  - `SWEEP_STAMP = ".last-sweep"`
  - `sweep_due(sessions_dir: Path, *, interval_seconds: float, now: float) -> bool`
  - `mark_swept(sessions_dir: Path, *, now: float) -> bool`
- Changes, in `backend/app/main.py`: `_sweep_once(cfg: Settings) -> None` loses
  its `app` parameter; the clock seam `_monotonic` becomes `_now = time.time`.

**Why wall clock, not monotonic:** the stamp outlives the process, and
`time.monotonic()` is measured from boot, so a stored value means nothing
after a restart. The cost is that a stepped clock can skew the interval, which
is what the future-stamp test below covers.

**Why mtime, not file contents:** nothing to parse and nothing to corrupt. The
name begins with a dot, so it fails `valid_sid` and `sweep` skips it
(`sessions.py:105`) — Step 1 pins that rather than assuming it.

- [ ] **Step 1: Write the failing tests**

In `backend/tests/test_sessions.py`:

```python
def test_sweep_is_due_when_nothing_has_swept_yet(tmp_path):
    assert sweep_due(tmp_path, interval_seconds=3600, now=NOW) is True


def test_sweep_is_not_due_again_within_the_interval(tmp_path):
    assert mark_swept(tmp_path, now=NOW) is True
    assert sweep_due(tmp_path, interval_seconds=3600, now=NOW + 60) is False
    assert sweep_due(tmp_path, interval_seconds=3600, now=NOW + 3600) is True


def test_a_stamp_dated_in_the_future_does_not_suppress_the_sweep(tmp_path):
    """A host whose clock steps back would otherwise never sweep again."""
    mark_swept(tmp_path, now=NOW + 86400)
    assert sweep_due(tmp_path, interval_seconds=3600, now=NOW) is True


def test_marking_creates_the_sessions_dir_it_stamps(tmp_path):
    assert mark_swept(tmp_path / "sessions", now=NOW) is True
    assert (tmp_path / "sessions" / SWEEP_STAMP).stat().st_mtime == NOW


def test_marking_reports_failure_instead_of_raising(tmp_path):
    (tmp_path / "blocked").write_text("I am a file, not a directory")
    assert mark_swept(tmp_path / "blocked", now=NOW) is False


def test_the_stamp_is_not_a_session_and_is_never_swept(tmp_path):
    """It lives in sessions_dir and is older than every window."""
    mark_swept(tmp_path, now=NOW - 400 * 86400)
    _dir(tmp_path, "b" * 16, days_ago=400)
    assert _sweep(tmp_path) == ["b" * 16]
    assert (tmp_path / SWEEP_STAMP).exists()
```

In `backend/tests/test_session_cookie.py`, replace
`test_a_second_mint_within_the_interval_does_not_sweep_but_one_after_does`
(it patches the `_monotonic` seam that is going away) and add the test that
states the actual CGI property:

```python
def test_a_second_mint_within_the_interval_does_not_sweep_but_one_after_does(
        cfg, monkeypatch):
    clock = [1_700_000_000.0]          # after _stale_dir's 1_000_000_000
    monkeypatch.setattr("app.main._now", lambda: clock[0])
    # ... as before: mint, make a stale dir, +60s mints without sweeping,
    # +3600s sweeps.


def test_the_throttle_holds_across_processes_not_just_within_one(cfg, monkeypatch):
    """Under CGI every request is a fresh interpreter, so a throttle in
    app.state would sweep on every cookieless mint. A fresh create_app per
    request is the closest this suite gets to that."""
    clock = [1_700_000_000.0]
    monkeypatch.setattr("app.main._now", lambda: clock[0])
    with TestClient(create_app(cfg), base_url=HTTPS) as c:
        c.get("/api/session")
    stale = _stale_dir(cfg)
    clock[0] += 60
    with TestClient(create_app(cfg), base_url=HTTPS) as c:   # new app, new state
        c.get("/api/session")
    assert stale.exists()


def test_a_stamp_that_cannot_be_written_does_not_sweep_on_every_request(
        cfg, monkeypatch):
    """Fail closed: if the stamp cannot be recorded, the walk is skipped
    rather than repeated on every mint."""
    monkeypatch.setattr("app.main.mark_swept", lambda *a, **kw: False)
    called = []
    monkeypatch.setattr("app.main.sweep", lambda *a, **kw: called.append(1))
    with TestClient(create_app(cfg), base_url=HTTPS) as c:
        assert c.get("/api/session").status_code == 200
    assert called == []
```

Keep `test_the_first_mint_sweeps_an_abandoned_directory`,
`test_a_session_that_resolves_does_not_sweep`, and both failing-sweep tests
exactly as they are: they must still pass unchanged.

- [ ] **Step 2: Run them to verify they fail**

Expected: `ImportError: cannot import name 'sweep_due'`, and the two rewritten
tests failing on the absent `app.main._now`.

- [ ] **Step 3: Implement the stamp** in `backend/app/sessions.py`

`sweep_due` returns True when the stamp is absent or unreadable (`OSError`) and
when `now - mtime` is negative. `mark_swept` creates `sessions_dir` with
`parents=True, exist_ok=True`, touches the stamp, sets its mtime to `now` with
`os.utime`, and returns False on any `OSError`.

- [ ] **Step 4: Rewrite `_sweep_once`** in `backend/app/main.py`

`_sweep_once(cfg)` reads `now = _now()` once, returns early if not
`sweep_due(...)`, returns early if not `mark_swept(...)`, then calls `sweep`
inside the existing `try`/`except` with the existing type-only log. Update the
docstring: "Throttled, not once per process" was about a long-lived worker and
is now about a fresh process per request. Fix the call site at `main.py:322`.

- [ ] **Step 5: Run the full suite and the linter**, then **commit**

```bash
git add -A && git commit -m "Throttle the sweep on a file, because CGI has no process to remember in"
```

---

## Task 4: The Python floor drops to 3.12

The host has 3.12.15 and `requires-python` says `>=3.13`. This cannot be
proved here — there is no 3.12 interpreter in this environment and no network
to fetch one (`python3 --version` is 3.15.2, the venv is 3.14). What *can* be
pinned is that the floor and the version CI tests on never drift apart again,
which is exactly how this branch came to exist.

**Files:**
- Modify: `backend/pyproject.toml:4`
- Modify: `.github/workflows/deploy.yml:100-107` (the comment and `python-version`)
- Modify: `README.md:29`
- Create: `backend/tests/test_versions.py`

**Interfaces:** none. Nothing imports from this task.

**This task breaks `make backend-test`** until `uv lock` is run with network:
lowering the floor makes the committed lock inconsistent, and `uv run` then
wants to re-resolve. Use the `--no-sync` command from Global Constraints. Say
so in the commit message.

- [ ] **Step 1: Write the failing test** in `backend/tests/test_versions.py`

```python
def test_the_deploy_tests_on_the_interpreter_the_floor_names():
    """The host runs one interpreter and CI tests on another unless these two
    move together. They did not, which is why this branch exists: the floor
    said 3.13 and the host offers 3.12.15.
    """
    floor = tomllib.loads((BACKEND / "pyproject.toml").read_text())["project"]["requires-python"]
    workflow = (REPO / ".github/workflows/deploy.yml").read_text()
    pinned = re.search(r'python-version:\s*"([\d.]+)"', workflow).group(1)
    assert floor == f">={pinned}"
    assert pinned == "3.12"      # the version measured on the host, docs/tests/round2
```

- [ ] **Step 2: Run it to verify it fails**

Expected: FAIL, `assert '>=3.13' == '>=3.12'`.

- [ ] **Step 3: Lower the floor and the pin.** `requires-python = ">=3.12"`;
      `python-version: "3.12"`; rewrite the workflow comment above it (it
      currently says 3.13 must stay and must match cPanel's "Setup Python App",
      which does not exist on this host) to say the host's measured 3.12.15 is
      what this pin matches. `README.md:29` becomes "Python 3.12 or newer".

- [ ] **Step 4: Verify** — the new test passes, and so does the whole suite
      with `--no-sync`. Then check by hand that nothing in `app/` or `tests/`
      needs 3.13: `grep -rn "itertools.batched\|TypeIs\|ReadOnly\|@override\|warnings.deprecated"
      backend/app backend/tests` must come back empty. Record in the commit
      message that the floor is unproven here and is Task 6's `UNVERIFIED.md` entry.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "Lower the Python floor to 3.12, which is what the host has"
```

---

## Task 5: The runbook

`docs/DEPLOY.md` is 521 lines written against Passenger. Four of its ten steps
and three of its reference sections are now wrong. A historian never reads
this file; the person operating the server reads it with the host in front of
them, so every instruction must be runnable as written.

**Depends on:** Tasks 1-4 (it documents what they built).

**Files:**
- Modify: `docs/DEPLOY.md`

**Interfaces:** none.

- [ ] **Step 1: The header and the four-sentence summary** (lines 1-24).
      The summary names `passenger_wsgi.py`, `tmp/restart.txt` and Passenger.
      Replace with: rsync of `app.cgi`, `.htaccess`, `backend/`, the bundle and
      `content/`; `pip install` into `$DEPLOY_DIR/.venv`; no restart. Add a
      pointer to `docs/tests/` and to the 2026-11-09 design beside the existing
      ADR pointer. Keep the "nothing here has been run against the real host"
      warning — it is still true of every step below.

- [ ] **Step 2: Step 2 (the lock).** `a2wsgi` is locked now (`f708161`). Rewrite
      as: run `uv lock` again, because Task 4 lowered `requires-python` and the
      committed lock still says `>=3.13`; until then CI re-resolves and
      `make backend-test` fails locally without `--no-sync`.

- [ ] **Step 3: Step 3 (what the host offers).** Replace the Setup-Python-App
      question with the measured table from the design §1, and leave only the
      questions still open: the SSH port, the disk quota, and whether cPanel
      will accept `$DEPLOY_PATH` as the subdomain's document root.

- [ ] **Step 4: Step 4** becomes *Create the subdomain and the venv*: point the
      subdomain's document root at `DEPLOY_PATH`; `python3.12 -m venv
      "$DEPLOY_PATH/.venv"`; `"$DEPLOY_PATH/.venv/bin/python" --version` must
      print 3.12.15. Note the fallback if cPanel refuses a document root
      outside `public_html`: put `DEPLOY_PATH` inside it.

- [ ] **Step 5: Step 6 (the rehearsal).** The expected step names changed
      (*Install dependencies*, no restart). Replace the
      `head -n 12 passenger_wsgi.py` check with `ls -l app.cgi` (mode must
      include `x`) and `head -n 3 app.cgi`.

- [ ] **Step 6: Step 7** becomes *Install the front controller, carefully* —
      and it opens with the warning, because this has already happened once:
      **a bad `.htaccess` returns 500 for the whole site, not just this app**
      (`docs/tests/test4.png`). So rehearse on the staging subdomain, and keep
      the undo command on screen before running anything:
      `ssh HOST 'rm -f /home/USER/tours-staging/.htaccess'`. Then the checks,
      in this order, each with what it proves:

```sh
curl -s https://STAGING/api/health                       # {"status":"ok"} -- CGI runs
curl -s https://STAGING/ | head -c 200                   # index.html -- Apache serves the bundle
curl -s -o /dev/null -w "%{http_code}\n" https://STAGING/some/deep/link   # 200, the SPA fallback
curl -s https://STAGING/backend/.env                     # must NOT contain MAPILLARY_TOKEN
curl -s https://STAGING/api/session/examples             # the examples list -- a real route, not just health
```

      A 404 from the first line is the `SCRIPT_NAME`/`PATH_INFO` mistake the
      design §6.1 names; a 500 is the CGI script itself, and the next section
      says where to read why.

- [ ] **Step 7: Step 8 (Directory Privacy)** keeps its three `curl` checks; the
      reason the middle one matters is unchanged (the API must be behind the
      password too), but the mechanism is now CGI, not Passenger.

- [ ] **Step 8: *Reading the Passenger log*** becomes *Reading the error log*:
      cPanel *Metrics* → *Errors* first, then `~/logs/`, then the subdomain's
      own error log. Add, plainly: **a traceback in that log can contain a
      recovery key, so the log is as sensitive as `sessions_dir`.** Delete the
      `touch tmp/restart.txt` paragraph — there is nothing to restart; the next
      request picks up new files. Keep the memory-limit paragraph.

- [ ] **Step 9: *What the sweep does*.** "at most once an hour per application
      process" and "a Passenger restart resets the hour" are both now false.
      The timestamp is the mtime of `.last-sweep` in `sessions_dir`, so the
      hour holds across processes and across deploys, and a stamp that cannot
      be written means the sweep is skipped, not repeated.

- [ ] **Step 10: *Known limitations*.** Drop the CloudLinux virtualenv guess.
      Add: the document root must be `DEPLOY_PATH`; `Options +ExecCGI` must be
      permitted; every dynamic request pays ~0.4 s; CloudLinux caps concurrent
      entry processes and CGI spends one per request; FastAPI's `/docs` is
      unreachable on the host by design. Update the Python line to 3.12.

- [ ] **Step 11: *A wart in local development*.** "Passenger terminates TLS
      upstream" becomes the host's Apache; the conclusion (the cookie is
      always `Secure`, so develop in Chrome or Firefox) does not change.

- [ ] **Step 12: Read the whole file once** as the operator would, checking
      that no step references a file or a step number that no longer exists,
      then **commit**

```bash
git add -A && git commit -m "Rewrite the runbook for a host with no Passenger"
```

---

## Task 6: The record

The decision, the open questions, and the comments in the code that still
explain a host this app no longer runs on.

**Depends on:** Tasks 1-5.

**Files:**
- Create: `docs/decisions/0007-serve-it-through-cgi.md`
- Modify: `docs/decisions/README.md` (the index)
- Modify: `docs/UNVERIFIED.md` (entries 33 and 34; new entries 37-39; the head note)
- Modify: `backend/app/main.py:265`, `:355`, `:715` (three Passenger comments)

**Interfaces:** none.

- [ ] **Step 1: Write ADR 0007**, *Serve it through CGI, because the host has
      no Passenger*. ADR 0006 is **not** edited — a record explains the forces
      at the time — so this one supersedes its hosting decision and leaves the
      rest of it standing. It must carry the measured table (design §1), the
      two negative results that jointly closed the long-running-process option,
      why `/tour-data` stays in Python when serving it statically would be
      faster, why the sweep's throttle moved to a file, and the floor drop with
      its honest "unproven here". The measurements are not reproducible later,
      which is the reason this record exists at all.

- [ ] **Step 2: Add the index line** to `docs/decisions/README.md`.

- [ ] **Step 3: Update `docs/UNVERIFIED.md`.**
      - Entry 33 (*The WSGI bridge on the host*) is wrong twice over: there is
        no Passenger, and `a2wsgi` **is** installed here now, so the bridge
        test runs rather than skips. Rewrite it as the CGI path on the host.
      - Entry 34 (*The deploy pipeline*) loses the CloudLinux virtualenv guess
        and gains the new ones: the document root is `DEPLOY_PATH`, the venv is
        at `$DEPLOY_DIR/.venv`, `app.cgi` arrives executable, `Options +ExecCGI`
        is permitted.
      - New entry 37: the 3.12 floor, closable by CI and by the host.
      - New entry 38: the `.htaccess` front controller — every rewrite in it,
        including that `/backend/.env` is not reachable by URL. Closable by
        `DEPLOY.md` step 7's checks.
      - New entry 39: CGI under concurrency — the entry-process cap and the
        0.4 s per dynamic request, with several historians at once.
      - The head note says "entries 32 to 36"; extend it.

- [ ] **Step 4: Fix the three comments in `main.py`.** Each one explains a real
      decision and must keep explaining it, with Passenger replaced by what is
      actually true: `:265` (TLS is terminated upstream of this process, so the
      `Secure` flag is not derived from the request scheme), `:355` (no ASGI
      lifespan runs under the bridge, so `app.state.cfg` is set in the body),
      `:715` (a cPanel shell is not the process that serves requests).

- [ ] **Step 5: Run the full suite and the linter**, then **commit**

```bash
git add -A && git commit -m "Record the CGI decision and what is still unproven"
```

---

## Self-review notes

**Spec coverage.** §6.1 → Task 1. §6.2 → Task 2. §6.3 → Task 4. §6.4 → Task 3.
§6.5 → Tasks 1 and 2 (the workflow is edited in both: Task 1 owns the entry
point's rsync line because it owns the file, Task 2 owns `.htaccess` and the
host-side step). §6.6 → Tasks 5 and 6. §7's risks → Task 6's entries 37-39
and Task 5's *Known limitations*. §8's "explicitly unchanged" list is what the
kept-unchanged tests in Task 3 protect.

**Deliberately not done.** No test claims Apache's behaviour; no second entry
point for Passenger (spec §4); no performance work beyond keeping Python off
the static path; `_mount_frontend` and `_SpaFiles` stay exactly as they are,
because `make serve` and the published-site output still use them.

---

## Task 7: A deploy must not remove the shared password

Added after Task 5, which found it. cPanel's *Directory Privacy* protects a
directory by writing `AuthType`, `AuthName`, `AuthUserFile` and
`Require valid-user` into **that directory's `.htaccess`**. The directory to
protect is the subdomain's document root, which is `$DEPLOY_DIR` — so it is
*our* `.htaccess`, and Task 2's pipeline rsyncs over it unconditionally.

**This branch introduces the regression.** The previous pipeline shipped no
`.htaccess` at all, so Directory Privacy's file was never touched. As it
stands, the first deploy after the password is set silently removes it, and
nothing in the deploy log says so. The shared password is the only thing
keeping strangers off the editor, where they would spend the Mapillary quota
and fill the disk.

So the deploy composes the file on the host instead of overwriting it: the
repository's `.htaccess` plus whatever auth directives the host's copy
already carries.

**Files:**
- Create: `deploy/merge-htaccess.sh` (mode 755)
- Create: `backend/tests/test_merge_htaccess.py`
- Modify: `.github/workflows/deploy.yml` (rsync `.htaccess` to `.htaccess.new`
  and the script alongside it; call the script in the install step)
- Modify: `docs/DEPLOY.md` (step 8 — the `grep` that determines which
  behaviour this host has can stay, but the "re-check the 401s after every
  deploy" instruction becomes "the deploy preserves it; here is how to
  confirm")

**Interfaces:**
- `deploy/merge-htaccess.sh <dest> <new>`: writes `<dest>` as the contents of
  `<new>` followed by any auth directives `<dest>` already had, atomically
  (temp file plus `mv`), and removes `<new>`. Exit non-zero, changing nothing,
  if `<new>` is missing or `<dest>` exists but cannot be read — losing the
  password quietly is the failure this task exists to prevent, so it fails
  loudly instead.

**Why a shipped script rather than inline shell in the workflow:** it can be
run by a test. A silent loss of access control is exactly the defect that
should not rest on reasoning about a heredoc.

- [ ] **Step 1: Write the failing tests** in `backend/tests/test_merge_htaccess.py`,
      driving the script with `subprocess.run(["bash", SCRIPT, dest, new])`.

```python
CPANEL_AUTH = '''AuthType Basic
AuthName "Protected"
AuthUserFile "/home/u/.htpasswds/public_html/tours/passwd"
Require valid-user
'''


def test_with_no_existing_file_the_repository_version_is_installed(tmp_path): ...
def test_an_existing_file_without_auth_is_replaced_exactly(tmp_path): ...
def test_cpanel_auth_directives_survive_a_deploy(tmp_path):
    # Every one of the four lines, and the rest of the old file gone.
def test_running_twice_does_not_duplicate_the_auth_block(tmp_path):
    # The second run reads back the block the first appended.
def test_indented_and_oddly_cased_directives_are_still_recognised(tmp_path): ...
def test_an_unreadable_destination_fails_loudly_and_changes_nothing(tmp_path):
    # chmod 000: non-zero exit, dest untouched, new still present.
def test_a_missing_new_file_fails_loudly(tmp_path): ...
def test_the_staging_file_is_removed_on_success(tmp_path): ...
```

- [ ] **Step 2: Run them to verify they fail** (the script does not exist).

- [ ] **Step 3: Write `deploy/merge-htaccess.sh`.** `set -euo pipefail`;
      recognise `AuthType`, `AuthName`, `AuthUserFile`, `AuthGroupFile` and
      `Require valid-user`, case-insensitively, with leading whitespace, via
      `grep -iE` guarded against a no-match exit; append under a comment
      saying where the block came from and that the deploy re-reads it.

- [ ] **Step 4: Run the tests to verify they pass**, and `chmod 755` the script.

- [ ] **Step 5: Wire it into the workflow.** `.htaccess` rsyncs to
      `.htaccess.new`; `deploy/merge-htaccess.sh` rsyncs with `--chmod=F755`;
      the install step calls it before the `chmod 644`. Keep the `chmod 644`:
      an `.htaccess` Apache cannot read is a 500 on every URL.

- [ ] **Step 6: Update `docs/DEPLOY.md` step 8** and the Known limitations
      entry Task 5 left about re-checking the 401s.

- [ ] **Step 7: Full suite, lint, commit.**
