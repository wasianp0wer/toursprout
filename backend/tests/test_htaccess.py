"""The Apache front controller, pinned to the code it has to agree with.

`.htaccess` is configuration for a server that is not in this environment, so
NOTHING here claims the rewrites work -- that is a `curl` check in the host
runbook and an entry in `UNVERIFIED.md`. What is testable, and what these
tests cover, is the two ways the file silently goes out of step with the
Python: a route added at a third URL prefix, and a moved `frontend_dist`.
Both drift without an error anywhere, because the front controller's answer
to an unknown path is the single-page app, which renders happily.

The third test is a tripwire on the containment property: of everything under
the document root -- the source, the venv, `backend/.env` with the Mapillary
token in it -- only the built bundle may be reachable by URL.
"""

from __future__ import annotations

import re

from app.config import REPO_DIR, Settings
from app.main import create_app

HTACCESS = (REPO_DIR / ".htaccess").read_text()

# FastAPI's own interactive docs. Reduced to first URL segments the way
# `_served_prefixes` below reduces everything else, so `/docs/oauth2-redirect`
# is already covered by `/docs` and does not appear separately.
DOC_ROUTES = {"/docs", "/redoc", "/openapi.json"}


def _served_prefixes(app) -> set[str]:
    """The set of first URL segments the application answers on.

    The bundle mount registers with the path `""` (not `"/"`), so it reduces
    to `"/"` here and is subtracted by name at the call site rather than
    quietly filtered out.
    """
    return {"/" + getattr(r, "path", "").lstrip("/").split("/")[0] for r in app.routes}


def test_every_dynamic_prefix_the_app_serves_is_routed_to_the_cgi_script(tmp_path):
    """The front controller sends two prefixes to the application and falls
    back to index.html for everything else. A route added at a third prefix
    would be answered by the single-page app instead of the backend, with no
    error anywhere -- so the two lists are pinned to each other here.

    FastAPI's own /docs, /redoc and /openapi.json are deliberately NOT routed:
    they are unreachable on the host, which is where they belong.
    """
    dist = tmp_path / "dist"
    dist.mkdir()  # so the catch-all bundle mount is registered, as on the host
    app = create_app(Settings(content_dir=tmp_path, sessions_dir=tmp_path / "s",
                              frontend_dist=dist))
    dynamic = _served_prefixes(app) - DOC_ROUTES - {"/"}
    assert dynamic == {"/api", "/tour-data"}

    # Read the prefixes back OUT of the file and compare the sets, rather than
    # grepping for the two names: `re.search("api|tour-data")` also matches
    # `^(api|tour-data|anything)`, so it would miss a prefix added to the
    # rewrite and never added to the app.
    rule = re.search(r"^RewriteRule\s+\^\(([^)]+)\)\(/\|\$\)\s+app\.cgi\b",
                     HTACCESS, re.MULTILINE)
    assert rule is not None, "no RewriteRule sends a prefix to app.cgi"
    assert {"/" + p for p in rule.group(1).split("|")} == dynamic


def test_the_front_controller_serves_the_bundle_config_points_at():
    """If frontend_dist moves, .htaccess serves a directory that is not there
    and every page load falls through to a missing index.html."""
    rel = Settings().frontend_dist.relative_to(REPO_DIR).as_posix()
    assert rel == "frontend/dist/frontend/browser"
    assert HTACCESS.count(rel) >= 2  # the -f test and the index.html fallback


def test_the_front_controller_keeps_python_off_the_static_path():
    """An anti-goal of the spec: nothing under the document root is served
    except the bundle, so backend/.env and the venv are not reachable by URL.
    """
    # Adjacent to the deny block, and asserted as one block: two substring
    # checks pass just as well with the `Require` somewhere else in the file,
    # where it would deny something else entirely.
    assert re.search(r'<Files "\.env">\s*\n\s*Require all denied\s*\n\s*</Files>',
                     HTACCESS)

    # The index.html fallback is unconditional ON PURPOSE. The usual idiom
    # guards it with `RewriteCond %{REQUEST_FILENAME} !-f` so that real files
    # are served directly -- which here would hand out backend/.env,
    # backend/app/*.py, content/ and the venv to anyone who names the path,
    # since every one of those files really does exist under the document
    # root. A tripwire, so that idiom cannot arrive later by habit. Comments
    # are stripped first, because .htaccess explains this in prose and the
    # prose has to be allowed to name the thing it is warning about.
    directives = "\n".join(line for line in HTACCESS.splitlines()
                           if not line.lstrip().startswith("#"))
    assert "REQUEST_FILENAME" not in directives
