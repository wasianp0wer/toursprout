"""The CGI entry point: this host has no Passenger and no "Setup Python App".

The web server executes `app.cgi` at the document root, which runs this module
with `python -m app.cgi`. FastAPI is ASGI, so the app is bridged with a2wsgi
and handed to `wsgiref`'s CGI handler. The bridge does not run the ASGI
lifespan, which is why `create_app` sets `app.state.cfg` in its body.

`sys.path` is deliberately untouched here: `app.cgi` exports `PYTHONPATH` and
runs the interpreter with `-P`, so the document root stays off the import path
and a file dropped beside the script cannot shadow a module. A `sys.path`
insert in this file would quietly give that back.

`BaseCGIHandler` rather than `CGIHandler`, because an environ and three
streams passed in are what make every test in `tests/test_cgi.py` possible,
and under CGI `main` passes the same things `CGIHandler` would read for
itself. It is not quite the same handler, though, and the difference is worth
knowing:

- `CGIHandler` sets `os_environ = {}` ("do not allow os.environ to leak
  between requests"); `BaseCGIHandler` inherits `BaseHandler.os_environ`,
  which is the whole process environment, and merges the passed environ over
  it. In production that is the same dictionary twice -- Apache's CGI
  environment *is* this process's environment -- but it means any ambient
  `HTTP_*` variable in it arrives at the app as a request header, and it
  means the test suite runs with the developer's shell environment merged
  into every request.
- `CGIHandler` also sets `wsgi_run_once = True`; here the app is told
  `False`, which is pessimistic rather than wrong: nothing in this
  application caches on the strength of being run again.
"""

from __future__ import annotations

import os
import sys
import traceback
import wsgiref.handlers
from collections.abc import Mapping
from typing import IO
from urllib.parse import unquote_to_bytes

from a2wsgi import ASGIMiddleware

from app.main import app

# The WSGI callable, built once at import. Under CGI "once" is once per
# request anyway; it is module level so the bridge, and therefore the import
# of the whole application, is exercised by a plain import.
application = ASGIMiddleware(app)

_INTERNAL_ERROR = (
    "The editor could not start. The server's error log has the details.\n"
)


def _path_info(path: str) -> str:
    """One URL path, percent-decoded, in the form a2wsgi can carry.

    Three hazards, in the order they bite:

    `os.environ` surrogate-escapes any byte the filesystem encoding cannot
    decode, so a client that sends a raw non-ASCII byte instead of
    percent-encoding it puts a lone surrogate in `REQUEST_URI`.
    `unquote_to_bytes` re-encodes a `str` as strict UTF-8, which raises on
    that -- so the surrogates are undone first, back to the bytes the client
    actually sent.

    Then the percent-decoding, once and only once, on bytes.

    Then the bytes have to come back as a `str` that a2wsgi can put through
    `.encode("latin1").decode("utf8")` without raising, because it has no
    error handler and a `UnicodeDecodeError` there is a 500 with a traceback
    in the host's error log -- for a request anyone can send, in a log as
    sensitive as `sessions_dir`. A path that is not UTF-8 cannot name
    anything we store, so each bad sequence becomes U+FFFD and the request
    goes on to be the router's ordinary 404.
    """
    raw = unquote_to_bytes(path.encode("utf-8", "surrogateescape"))
    return raw.decode("utf-8", "replace").encode("utf-8").decode("latin-1")


def cgi_environ(environ: Mapping[str, str]) -> dict[str, str]:
    """Rewrite a front-controller CGI environ into one that can be routed.

    Every dynamic URL is rewritten to this one script, so the web server sets
    `SCRIPT_NAME=/app.cgi` and leaves `PATH_INFO` empty: routing on those two
    would 404 every route in the application. `REQUEST_URI` still holds what
    the browser asked for, so the path is taken from there.

    `SCRIPT_NAME` is cleared because a2wsgi reads it as `root_path` and
    prepends it to the path (`a2wsgi/asgi.py:92-93`), so the app would be
    told it is mounted under `/app.cgi`. Routing survives that -- Starlette
    1.6 strips `root_path` off again before matching, which was measured, not
    assumed -- but every URL the app then *generates* (a redirect's
    `Location`, `/docs`'s pointer to `openapi.json`) carries the `/app.cgi`
    prefix, and the app is not mounted there: the front controller rewrites
    clean paths to this script, it does not serve them under its own name.
    Clearing it keeps that whole class of bug out, so do not "restore" it.

    `PATH_INFO` is the percent-decoded *bytes* read back as latin-1, not a
    str. a2wsgi undoes exactly that (`PATH_INFO.encode("latin1")
    .decode("utf8")`), which is the CGI convention, so a stop photo named
    `façade one.jpg` only survives the bridge if it is encoded this way.

    An *empty* `REQUEST_URI` is treated as an absent one. Apache always sets
    it, so this only matters for some other server or a test -- but `""` is
    falsy and not None, and rewriting the path to nothing 404s every route,
    which is a confusing way to fail.
    """
    env = dict(environ)
    request_uri = env.get("REQUEST_URI")
    if not request_uri:
        # No REQUEST_URI: not the front controller, or a test. Pass the
        # environ through so the caller's own PATH_INFO stands.
        return env
    env["PATH_INFO"] = _path_info(request_uri.partition("?")[0])
    env["SCRIPT_NAME"] = ""
    return env


def run(stdin: IO[bytes], stdout: IO[bytes], errors: IO[str],
        environ: Mapping[str, str], wsgi_app: object | None = None) -> None:
    """Serve one request. `multiprocess`, `multithread`: CGI is one per process."""
    handler = wsgiref.handlers.BaseCGIHandler(
        stdin, stdout, errors, cgi_environ(environ),
        multithread=False, multiprocess=True,
    )
    handler.run(wsgi_app or application)


def main() -> None:
    """What `app.cgi` runs.

    The fallback matters more than it looks. Anything that raises before the
    handler has written its headers otherwise reaches the historian as
    Apache's bare "Premature end of script headers" with nothing to read and
    nothing to report. So: one fixed sentence to the browser, and the
    traceback only to stderr.

    It covers this module's *body*, not its import: `app = create_app()` runs
    while `app.main` is imported above, so a bad `backend/.env` or a
    dependency missing from the host's venv still dies before `main` is
    reached. The runbook's first host-side check exists for that case.

    `Exception`, not `BaseException`: a `KeyboardInterrupt` or a `SystemExit`
    is the process being told to stop, not a request that failed, and
    answering it with a 500 page would be a lie.

    stderr is the host's error log, which is operator-only. It is not
    harmless: a traceback can carry a sid, and a sid is both a credential and
    the historian's recovery key, so that log is as sensitive as
    `sessions_dir`. The deploy runbook records that.
    """
    try:
        run(sys.stdin.buffer, sys.stdout.buffer, sys.stderr, os.environ)
    except Exception:  # noqa: BLE001 - the browser gets a 500, never a traceback
        traceback.print_exc(file=sys.stderr)
        sys.stdout.write(
            "Status: 500 Internal Server Error\r\n"
            "Content-Type: text/plain; charset=utf-8\r\n"
            "\r\n"
            + _INTERNAL_ERROR
        )
        sys.stdout.flush()


if __name__ == "__main__":
    main()
