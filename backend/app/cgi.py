"""The CGI entry point: this host has no Passenger and no "Setup Python App".

The web server executes `app.cgi` at the document root, which runs this module
with `python -m app.cgi`. FastAPI is ASGI, so the app is bridged with a2wsgi
and handed to `wsgiref`'s CGI handler. The bridge does not run the ASGI
lifespan, which is why `create_app` sets `app.state.cfg` in its body.

`sys.path` is deliberately untouched here: `app.cgi` exports `PYTHONPATH` and
runs the interpreter with `-P`, so the document root stays off the import path
and a file dropped beside the script cannot shadow a module. A `sys.path`
insert in this file would quietly give that back.

`BaseCGIHandler` rather than `CGIHandler`: the two are the same handler --
`CGIHandler` is a subclass whose only job is to read `os.environ` and the real
stdio for you. Passing the environ and the streams in is what makes every
test in `tests/test_cgi.py` possible, and `main` supplies exactly what
`CGIHandler` would have.
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

    Without a `REQUEST_URI` -- a server that is not the front controller, or a
    test -- the environ is passed through, so the caller's `PATH_INFO` stands.
    """
    env = dict(environ)
    request_uri = env.get("REQUEST_URI")
    if request_uri is None:
        return env
    path = request_uri.partition("?")[0]
    env["PATH_INFO"] = unquote_to_bytes(path).decode("latin-1")
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
