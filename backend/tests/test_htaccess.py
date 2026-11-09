"""The Apache front controller, pinned to the code it has to agree with.

`.htaccess` is configuration for a server that is not in this environment, so
NOTHING here claims the rewrites work -- that is a `curl` check in the host
runbook and an entry in `UNVERIFIED.md`. What is testable, and what these
tests cover, is the ways the file silently goes out of step with the Python: a
route added at a third URL prefix, and a moved `frontend_dist`. Both drift
without an error anywhere, because the front controller's answer to an unknown
path is the single-page app, which renders happily.

The last two tests are about the file's own structure rather than the Python:
the order of the rules, which three of them depend on, and the containment
property -- of everything under the document root (the source, the venv,
`backend/.env` with the Mapillary token in it) only the built bundle may be
reachable by URL. Both are still text, not behaviour: they say what the file
says, never what Apache does with it.

Everything is read from the DIRECTIVES, with comment lines stripped, because
the prose in `.htaccess` has to be free to name the things it is warning
about -- `REQUEST_FILENAME`, a moved bundle path -- without satisfying or
tripping an assertion here.
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


def _directives() -> list[str]:
    """The file's directive lines, in order, comments and blanks dropped."""
    return [line.strip() for line in HTACCESS.splitlines()
            if line.strip() and not line.lstrip().startswith("#")]


def _rewrite_rules() -> list[tuple[str, str]]:
    """Every RewriteRule as `(pattern, substitution)`, in file order.

    Parsed rather than grepped: a rule is identified by what it rewrites TO,
    so no assertion below has to spot it by a substring that the rule above
    it also happens to contain.
    """
    rules = []
    for directive in _directives():
        if not directive.startswith("RewriteRule"):
            continue
        parsed = re.fullmatch(r"RewriteRule\s+(\S+)\s+(\S+)(?:\s+\[[^\]]*\])?", directive)
        assert parsed is not None, f"cannot parse this RewriteRule: {directive}"
        rules.append((parsed.group(1), parsed.group(2)))
    return rules


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
    # rewrite and never added to the app. EVERY rule that rewrites to app.cgi
    # is read, not just the first one found, because a second such rule is
    # exactly how a third prefix would arrive.
    routed = set()
    for pattern, substitution in _rewrite_rules():
        if substitution != "app.cgi":
            continue
        prefixes = re.fullmatch(r"\^\(([^)]+)\)\(/\|\$\)", pattern)
        assert prefixes is not None, f"cannot read the prefixes out of {pattern}"
        routed |= {"/" + p for p in prefixes.group(1).split("|")}
    assert routed == dynamic


def test_the_front_controller_serves_the_bundle_config_points_at():
    """If frontend_dist moves, .htaccess serves a directory that is not there
    and every page load falls through to a missing index.html."""
    rel = Settings().frontend_dist.relative_to(REPO_DIR).as_posix()
    assert rel == "frontend/dist/frontend/browser"

    # Each of the three places the path appears is checked for on its own.
    # Counting occurrences is not enough: repointing the -f test and the
    # substitution of the bundle rule -- the pair that has to agree, since the
    # rule serves whatever the test found -- leaves the count unchanged and
    # the bundle serving nothing.
    conds = [d for d in _directives() if d.startswith("RewriteCond")]
    assert any(re.fullmatch(r"RewriteCond\s+%\{DOCUMENT_ROOT\}/" + re.escape(rel)
                            + r"/\$1\s+-f", c) for c in conds), \
        f"no RewriteCond tests for a file under {rel}"
    substitutions = [s for _, s in _rewrite_rules()]
    assert f"{rel}/$1" in substitutions          # the bundle rule
    assert f"{rel}/index.html" in substitutions  # the deep-link fallback


def test_the_front_controller_keeps_its_rules_in_their_order():
    """Three of the rules are only correct where they are.

    The first is the no-op guard. In .htaccess context mod_rewrite runs the
    ruleset AGAIN on the path a rule produced, and the guard is what makes
    that second pass harmless; without it the unconditional fallback turns
    app.cgi and every rewritten bundle path into index.html, which is no API
    and no JavaScript with a 200 on every request. Deleting it is a silent
    site-wide outage, so its presence AND its position are pinned here.

    The fallback must also come last: ahead of the bundle rule it would answer
    every asset with index.html, the same outage by a different route.

    This is a claim about the file's text, not about Apache: it says the rules
    are in the order the comments in the file explain, nothing more.
    """
    rules = _rewrite_rules()
    patterns = [p for p, _ in rules]
    substitutions = [s for _, s in rules]

    def position(substitution: str) -> int:
        """Where the rule rewriting to `substitution` is, by name not index,
        so a missing rule says which one rather than raising a ValueError."""
        assert substitution in substitutions, f"no rule rewrites to {substitution}"
        return substitutions.index(substitution)

    assert substitutions[0] == "-", \
        f"the first RewriteRule is not the no-op guard: {rules[0]}"
    bundle = "frontend/dist/frontend/browser"
    assert position("app.cgi") > 0
    assert position(f"{bundle}/$1") < position(f"{bundle}/index.html")

    # The guard exempts two paths from the fallback, so its pattern is the one
    # place in this file where a loose match means a file is served instead of
    # the app. `AddHandler cgi-script .cgi` keys on ANY dot-separated .cgi
    # component, so an unanchored `app\.cgi` would exempt -- and Apache would
    # then EXECUTE -- an `app.cgi.bak` left behind by an editor or a
    # hand-edit. Asserted on the pattern's own anchoring (Python's `re` is
    # close enough to PCRE for a literal and a `$`), not on what Apache does.
    assert re.match(patterns[0], "app.cgi")
    assert re.match(patterns[0], f"{bundle}/main.js")
    assert not re.match(patterns[0], "app.cgi.bak")


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
    # root. A tripwire, so that idiom cannot arrive later by habit.
    assert "REQUEST_FILENAME" not in "\n".join(_directives())
