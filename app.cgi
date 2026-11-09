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
