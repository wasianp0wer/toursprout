# 0007 — Serve it through CGI, because the host has no Passenger

Status: accepted, 2026-11-09.

Supersedes the **hosting mechanism** of
[0006](0006-host-it-one-session-per-browser.md) — its decision 1 assumed
cPanel's *Setup Python App*, which is CloudLinux's Passenger, and its
`passenger_wsgi.py` bridge. The host does not offer it. **Everything else in
0006 stands**: hosting rather than packaging a Windows `.exe`, the
cookie-keyed session that doubles as a recovery key, the sessions directory
outside the deploy tree and the deploy that never passes `--delete`, the
sweep's two retention windows, the caps as settings, the browser-side
Mapillary search, and the removal of in-editor archive search and synthesised
narration. This record changes where the code runs, not what it does. One
sentence inside 0006 is corrected below (decision 3, the `Secure` cookie's
reason), and one of its "what is not known" items is answered (the Python
version).

The design document is
`docs/superpowers/specs/2026-11-09-cgi-deployment-design.md`. Where this
record and that design disagree, this record is what was built; the two
differences are marked.

## Problem

0006 was written on the assumption that the plan exposes *Setup Python App*.
It does not. There is no Passenger on this host, so `passenger_wsgi.py` had
nothing to run it, and the whole execution half of the previous branch had no
target.

The replacement had to be chosen from what the host actually offers, which
nobody had measured. The author measured it, in the host's own terminal and
browser, on 2026-11-08 and 2026-11-09. **Those measurements will not be
reproducible later** — they were run once, by hand, against a live shared
account whose configuration is not ours to version — so they are recorded
here with the decisions they caused, which is the reason this record exists
at all. Raw output is committed under [`../tests/round1/`](../tests/round1/)
and [`../tests/round2/`](../tests/round2/).

| Question | Result | Consequence | Raw output |
| --- | --- | --- | --- |
| cPanel Python app support | **absent** | there is no Passenger; `passenger_wsgi.py` is gone | — |
| `python3` | **3.6.8**, pip 9.0.3 | end-of-life since 2021; unusable | `round1/test1.txt` |
| `python3.12` | **3.12.15**, `venv` works, pip 23.2.1 | this is the interpreter | `round1/test1.txt`, `round2/test1.txt` |
| PyPI reachable from the host | **yes** — `pip install fastapi a2wsgi` succeeded | a venv on the host can be populated at all | `round2/test2.txt` |
| a background process surviving logout | **no** — `200`, then `000` | nothing long-lived can be kept up | `round1/test2.txt` |
| `mod_proxy` in `.htaccess` | **no** — the whole site 500s | nothing can be proxied to a local port | `round1/test4.png` |
| CGI | **yes** — a one-line `t.cgi` printed `cgi ok` | this is the execution model | `round1/test3.txt`, `round1/test3.png` |
| cold start, importing `fastapi` + `pydantic` | **0.35–0.46 s** over 5 runs | CGI is affordable, if Python stays off the static path. **0.46 s is the ceiling to plan around** | `round2/test3.txt` |

**The cold-start row is narrower than this document first claimed, and the
correction is worth spelling out, because that number is load-bearing: it is
the entire basis for "CGI is affordable."** What is committed is
`docs/tests/round2/test3.txt`, five lines — `0.35s 0.46s 0.38s 0.38s 0.35s` —
and that series is the **`fastapi` + `pydantic`** import, not the
application's full third-party import set. A second series *was* run for the
app-equivalent set and reported at 0.36–0.40 s over **three** runs, but it
was **never committed to a file**: it exists only in the conversation that
produced it, and `docs/tests/README.md` is the only place in the repository
that distinguishes the two series at all. The earlier "0.36–0.40 s over 8
runs" in this row conflated them — it took the tighter range from the
uncommitted series and the run count from neither.

So, plainly: the app-equivalent figure is **unverifiable from this
repository** and must not be quoted as measured evidence. The checkable
evidence is five runs whose ceiling is **0.46 s**, 15% above the range this
document used to quote, and 0.46 s is the number to size a media-heavy stop
against. The conclusion survives — half a second of process start is still
affordable for six testers, which is why decision 1 stands — but it survives
on a looser margin than the old row implied.

The PyPI row deserves its own emphasis, because it could have ended the
project on this host: egress here is **selective**, not open. 0006's
decisions 3 and 4 exist because `graph.mapillary.com` is unreachable and
`www.loc.gov` answers 403. PyPI being reachable is the only reason a venv on
the host is possible, and therefore the only reason any of this works.

## Decision

### 1. CGI. A long-running process is not merely awkward here; it is closed

The obvious alternative to Passenger is a resident `uvicorn` on a local port
with Apache in front of it. **Two of the measurements close that off
jointly**, and the pair is worth keeping together, because either one alone
invites a workaround:

- a background process does not survive logout — the `200` then `000` row —
  so there would be nothing listening;
- `mod_proxy` is not permitted in `.htaccess` — the directive 500s the whole
  site — so even if something were listening, Apache would not route to it.

Fix the reaping with a cron watchdog and the proxy is still refused. Get the
proxy allowed and the process is still reaped. Neither can be worked around
from inside the account, and anyone who later proposes "just run `uvicorn`"
should be shown both rows, not one.

What is left is CGI, which the host does have: a process per request,
0.36–0.40 s of it spent on imports. For roughly six historians that is
affordable. It is not affordable for a JavaScript chunk, which is decision 2.

### 2. Apache serves the bundle; CGI serves `/api` and `/tour-data`

`_mount_frontend` mounts the built Angular bundle on `/` through FastAPI's
`_SpaFiles`. Under CGI that would spend a process start on every chunk of
public application code, so `.htaccess` becomes a front controller: Apache
serves the bundle itself, `/api/*` and `/tour-data/*` are rewritten to the
CGI script, and everything else falls back to the bundle's `index.html` — the
same deep-link job `_SpaFiles` does in development.

`_mount_frontend` and `_SpaFiles` stay in the code, untouched. They are what
makes `make serve` work, and the published-static-site output relies on the
same layout. Under CGI they are never reached **for the bundle**, because
Apache answers first.

That last sentence needs its qualifier, because without it someone will read
it as "this code is dead on the host" and delete it. Two ways it is not:

- The mount *is* registered on the host — `frontend/dist/frontend/browser`
  really exists there — and `_SpaFiles.get_response`'s
  `path.startswith("api/")` guard is what makes an unmatched `/api/foo`
  return a 404 rather than a 200 serving `index.html`. That guard is
  load-bearing on the host even though the static fallback beside it never
  fires there.
- `cfg.frontend_dist` is read by the host, in `GET /api/session/publish`:
  `build_site` needs the bundle to package it, and a wrong path is a **409
  on Publish**, not a static-serving fault. See the settings table in
  `docs/DEPLOY.md` — it is the one place `FRONTEND_DIST` matters on this
  host, and it is not the one an operator would guess.

One behaviour *is* genuinely lost by handing the bundle to Apache, and this
decision did not notice it at the time: `_SpaFiles` sets `Cache-Control:
no-cache, must-revalidate` on `index.html` — for a reason recorded in
`docs/ENVIRONMENT.md`, where a cached `index.html` serving stale bundles was a
real bug — and Apache serving the file directly sends no such header. It is
recorded as `UNVERIFIED.md` entry 40, together with the reasoning for **not**
restoring it with a `mod_headers` directive: `mod_headers` here is as unknown
as everything else in `.htaccess`, and by decision 3's own warning a directive
Apache will not accept is 500 on the whole tree. A stale page is the lesser
failure, and the deploy's own habits (fresh mtimes, no `--delete`) make it
lesser still.

**`/tour-data/*` stays in Python, deliberately, although serving it
statically would be faster.** The only thing separating one historian's media
from another's is the `sid`, and the `sid` is also the recovery key (0006,
decision 2). Apache can only be told which directory to serve by having the
`sid` in the URL of every image the page loads, which would leak a credential
through `Referer` headers, browser history, bookmarks and screenshots. That
is not a performance tweak with a privacy cost; it is a credential leak with
a performance benefit. The application reads the `sid` from the cookie
instead, and the route's `resolve()` / `is_relative_to` containment guard
stays exactly where it was.

A consequence worth stating because it looks like a regression: FastAPI's
`/docs`, `/redoc` and `/openapi.json` are **unreachable on the host**. They
are under neither routed prefix, so they fall through to `index.html`. That
is the right outcome — an interactive form that posts to every write route,
on a deployment whose only access control is one shared password, is not
something to publish — and they still work in development.

### 3. The front controller's shape, which is not the obvious one

`.htaccess` is, in order: `Options +ExecCGI -Indexes` and the `.cgi` handler;
a `<Files ".env">` deny; a **no-op guard rule**; `/api` and `/tour-data` to
CGI; the bundle by an `-f` test; and an **unconditional** `index.html`
fallback. Three of those are not what a reader would write from scratch, and
each is load-bearing.

**The guard rule exists because per-directory `mod_rewrite` re-runs the whole
ruleset on the path a rule produced.** `[L]` ends the current round, not the
processing. Without a first rule that matches `app.cgi` and the bundle
directory and does nothing, the rewritten paths come back around and the
unconditional fallback turns both into `index.html`: no API, no JavaScript,
and HTTP 200 on every request. That failure is quiet in exactly the worst way
— nothing errors, the site simply does not work — which is why the rule is
first and why its `app\.cgi$` anchor is commented in the file. Unanchored, it
would also exempt an `app.cgi.bak`, and `AddHandler cgi-script .cgi` keys on
any dot-separated `.cgi` component, so a stray backup would not merely be
served but executed.

**`[END]`, which would end the processing outright and make the guard
unnecessary, was rejected.** An Apache that does not recognise the flag
rejects the file as a whole, which is 500 on every URL in the tree. Trading a
rule that works everywhere for a flag that is cleaner where it is supported
and catastrophic where it is not is the wrong direction on a host whose
Apache configuration we cannot read.

**The fallback is unconditional, and the usual
`RewriteCond %{REQUEST_FILENAME} !-f` idiom was rejected**, because on this
layout that idiom is a disclosure. The document root *is* the deploy
directory, so `backend/`, `content/`, `.venv/` and `backend/.env` all exist
on disk beneath it. "Serve the file if it exists" would therefore publish the
source tree and the Mapillary token. Routing every unmatched path to
`index.html` regardless of what is on disk is what keeps them off the web;
the `<Files ".env">` block is the belt behind that brace, for the day the
rewrites are disabled or shadowed.

A property of this file that is not a design choice but must be respected
when editing it: **a directive Apache cannot accept here is not a broken
route, it is 500 on every URL in the directory and below**, because Apache
rejects the file whole. That is how we know `mod_proxy` is unavailable
(`round1/test4.png` — on the *site* root's `.htaccess`, which took the parent
domain down too; this file can only reach the subdomain). The undo is to
rename the file.

Two further Apache facts the file depends on and cannot assert: `Options` is
written in the `+`/`-` form on purpose, because the bare form *replaces* the
inherited set and per-directory `mod_rewrite` needs an inherited
`FollowSymLinks` or `SymLinksIfOwnerMatch` to work at all; and `+ExecCGI`
needs `AllowOverride Options`, which is cPanel's usual setting and is
unconfirmed here. If the host refuses `ExecCGI`, the answer is to ask for it,
not to drop the line: without it and the handler, Apache serves `app.cgi` as
text and publishes the one file that names the venv.

### 4. The entry point is a shell wrapper, and the path comes from `REQUEST_URI`

`app.cgi` at the document root is `sh`, not Python, because a Python shebang
would have to name an absolute interpreter path that differs per host. It
derives the venv from its own `$0` and runs
`PYTHONPATH="$DIR/backend" exec "$DIR/.venv/bin/python" -P -m app.cgi`. The
`-P` keeps the document root off `sys.path`, so a file dropped beside the
script cannot shadow a module — and `backend/app/cgi.py` therefore touches
`sys.path` nowhere, which is noted in its docstring so that a future
`sys.path.insert` is recognised as giving that back.

`a2wsgi` survives the change of host: the app is bridged ASGI→WSGI by
`ASGIMiddleware` and WSGI→CGI by `wsgiref`. So does the reason `create_app`
sets `app.state.cfg` in its body rather than in a lifespan — no more under
CGI than under Passenger does the ASGI lifespan run.

Two details differ from what the design predicted, and both are corrections
rather than refinements.

**The request path is taken from `REQUEST_URI`, not `PATH_INFO`.** The design
assumed the front controller would leave the real path in `PATH_INFO`. It
does not: every dynamic URL is rewritten to one script, so Apache sets
`SCRIPT_NAME=/app.cgi` and leaves `PATH_INFO` empty. `REQUEST_URI` still
holds what the browser asked for, and that is what `cgi_environ` reads.

**`SCRIPT_NAME` is cleared, but the design's reason for it was wrong.** The
design said that mishandling these two variables would 404 every route. It
would not: a2wsgi reads `SCRIPT_NAME` as `root_path`, and Starlette strips
`root_path` before matching, which was measured rather than assumed. The real
cost is in the other direction — every URL the application *generates* (a
redirect's `Location`, `/docs`'s pointer to `openapi.json`) would carry an
`/app.cgi` prefix, and the app is not mounted there, because the front
controller rewrites clean paths *to* the script rather than serving them
*under* it. So `SCRIPT_NAME` is cleared to keep that class of bug out, and
the comment in `cgi_environ` says "do not restore it" for the benefit of
whoever reads the design's version first.

**`PATH_INFO` is percent-decoded bytes read back as latin-1**, which is the
CGI convention and exactly what a2wsgi undoes
(`PATH_INFO.encode("latin1").decode("utf8")`). A stop photo named
`façade one.jpg` only survives the bridge if it is encoded that way. a2wsgi
has no error handler on that decode, so a path that is not valid UTF-8 would
raise a `UnicodeDecodeError` *inside the bridge* — a 500, with a traceback,
for a request anyone can send, in a log as sensitive as `sessions_dir`
because a traceback can carry a `sid`. Each bad sequence therefore becomes
U+FFFD and the request goes on to be the router's ordinary 404, which is what
a path that cannot name anything we store deserves.

For the same reason — the error log is the only place a CGI failure can be
read, and it is operator-only — `main` wraps the handler and answers an
unhandled exception with one fixed sentence and a 500, writing the traceback
to stderr alone. Without it the historian gets Apache's bare "Premature end
of script headers", with nothing to read and nothing to report.

### 5. The sweep's throttle moved from memory to a file

0006's sweep runs on a mint and at most hourly. The hour lived in
`app.state.last_sweep`. Under CGI every request is a fresh interpreter, so
that value is always unset and would throttle nothing — meaning a full walk
of every session directory on **every cookieless mint**, which is precisely
the stat storm the throttle exists to prevent.

The hour is now the **mtime of `.last-sweep` in `sessions_dir`**. The mtime
rather than the contents: there is nothing to parse and nothing to corrupt.
The **wall clock** rather than `time.monotonic()`, because the stamp outlives
the process and monotonic time is measured from boot, so a stored monotonic
value means nothing after a restart; the price is a host whose clock steps, so
a negative age reads as due rather than suppressing every sweep for the
length of the skew.

The stamp is written **before** the walk, and the walk is skipped if the
stamp cannot be written. That keeps a read-only `sessions_dir` to one refused
write per mint instead of a full walk per mint, and keeps a failing sweep from
being retried on the very next request. Both halves fail towards sweeping
*less*, which is the only safe direction near a historian's in-progress tour;
the cost, stated in the runbook, is that a sessions directory the application
cannot write to is never swept at all, silently.

Two concurrent CGI processes can both decide a sweep is due and both run one.
That is redundant rather than harmful: they evaluate the same two windows
against the same filesystem state, and the sweep already leaves alone any
directory it cannot read completely. A lock would be a second failure mode
(a stale one would suppress sweeping indefinitely) bought for no benefit.

Neither retention window changes, and the sweep still never raises into a
request.

### 6. The Python floor drops to 3.12, and that is unproven here

`requires-python` was `>=3.13`, chosen in 0006 as a floor rather than a
measured requirement. The host has 3.12.15, so the floor is now `>=3.12`, CI
pins `3.12`, and `backend/tests/test_versions.py` fails if those two ever
drift apart — it asserts a single uncommented `python-version` pin in the
deploy workflow, that it equals the floor, and that it is the version
measured on the host.

`app/` and `tests/` were scanned for syntax and stdlib newer than 3.9 — PEP
695 generics, `match`, `StrEnum`, `TaskGroup`, `datetime.UTC`, `@override`,
`itertools.batched`, `TypeIs`, `ReadOnly`, `except*` — with no hits. One
correction to an earlier version of this list, which named `tomllib` among
the not-found: **`tomllib` is used.** `backend/tests/test_versions.py` imports
it to read `pyproject.toml`, and that file was added by this same floor-lowering
work, after the scan was run and without the scan being re-run. It is fine on
the merits — `tomllib` landed in **3.11**, below the 3.12 floor — and a later
re-scan over `app/`, `tests/` and `content/scripts` found nothing newer than
3.9. But a list of eleven items with one false entry is worth less than the
ten true ones, so the item is removed rather than left to be discovered.
**And in any case: that is reading, not running.** The development
environment has no network and cannot build a 3.12 interpreter, so nobody has
executed this code on 3.12. CI on the pinned version is the first evidence
and the host is the second, and until one of them is green this is a claim
and not a fact (`UNVERIFIED.md` entry 37).

`backend/uv.lock` still records `requires-python = ">=3.13"` and has to be
regenerated with network access. Until that happens, `make backend-test`
fails offline — the suite is run with `cd backend && uv run --no-sync pytest
-q` instead — and CI re-resolves the dependency set on every run. That is a
known, recorded cost of landing the floor change before the lock could be
rebuilt, not an oversight.

### 7. The deploy composes `.htaccess` on the host, because this branch broke the password

This is the one decision here that is not about the host's constraints but
about a regression **this branch introduced**, and it is recorded because the
failure mode is silent.

cPanel's *Directory Privacy* protects a directory by writing `AuthType`,
`AuthName`, `AuthUserFile` and `Require valid-user` into **that directory's**
`.htaccess`. The directory protected here is the subdomain's document root,
which is the deploy directory, which is the file this branch now ships. The
previous pipeline shipped no `.htaccess` at all, so the question did not
exist; an unconditional `rsync` of the repository's copy would have removed
the shared password — the only thing keeping strangers off the editor, the
Mapillary quota and the disk — and removed it with nothing to say so, because
the front controller is perfectly valid without those lines. Nothing in the
deploy log, the error log or the site's behaviour would change.

So the deploy stages the repository's copy as `.htaccess.new` and runs
`deploy/merge-htaccess.sh` on the host, which rewrites `.htaccess` as the
staged copy followed by whatever auth directives the live file carried. It
re-reads the live file on every deploy, so a password set between two deploys
is picked up and a second deploy is a no-op rather than a second copy of the
block. It fails loudly and changes nothing if either file cannot be read: a
helpful fallback to installing the staged copy would be performing exactly
the overwrite it exists to prevent, and reporting success while doing it. It
writes through a temp file and `mv`, because an `.htaccess` that is
half-written or briefly absent is 500 on every URL of the subdomain for as
long as it lasts. It is a shipped script rather than inline shell in the
workflow for one reason: so that a test can run it, because a silent loss of
access control must not rest on reasoning about heredoc quoting.

Two details inside it are the kind that look like fussiness and are not:

- **`Require` is matched only as `Require valid-user`, `Require user NAME` or
  `Require group NAME`, never bare.** Bare would also match the
  `Require all denied` inside the repository's own `<Files ".env">` block and
  re-emit it at the top level, where it is 403 on the entire document root —
  on the *second* deploy, not the first, which is the worst possible time to
  find out. Narrow enough to never reach that line; wide enough to catch
  protection by named user or group, because keeping the `Auth*` lines and
  dropping the `Require` is the worst outcome available: under Apache 2.4 a
  directory with no `Require` has no authorization, so the editor would be
  open while the file still looked protected to anyone grepping it for
  `Auth`.
- **Only those directives are carried.** Rewrites cannot be: the
  repository's fallback is unconditional, so anything appended after it is
  dead code and anything that would have to precede it cannot be placed by
  appending. The rest is either inert here or dangerous to re-emit out of
  context. An operator who needs such a rule puts it in the repository's
  `.htaccess`, where it is reviewed.

And the ordering inside the deploy, which is invisible unless stated: **the
front controller is installed first**, before `app.cgi`, before the source,
and before `backend/.env`. Until `.htaccess` exists the document root is
uncontained — the unconditional fallback is the only thing keeping `backend/`
and `.venv/` off the web — so writing the token while there is no front
controller would publish `MAPILLARY_TOKEN` by URL for the length of a `pip
install`. On a steady-state deploy the order makes no difference; it is for
the first deploy and for every redeploy after the runbook's documented
`rm -f .htaccess` escape hatch.

## A correction to 0006

0006's decision 2 says the session cookie is always `Secure` "not derived from
the request scheme: **Passenger terminates TLS upstream**, so the scheme this
process sees can be `http`". The decision is still right and the reason is now
wrong — there is no Passenger. What is true of this host is that **Apache
terminates TLS and then starts the CGI process**, so the scheme the
application sees can still be `http` for a request the browser made over
HTTPS, and a derived flag would still be silently dropped in production, which
is where it matters. The price is unchanged: Safari, which has historically
refused a `Secure` cookie on `http://localhost`, mints a new session per
request in local development. The comment at `backend/app/main.py` is updated
to say this; 0006 is left as it was written, per the convention in
[README.md](README.md).

## What is not known

- **Nothing in `.htaccess` has been seen to work.** There is no Apache in the
  development environment. `backend/tests/test_htaccess.py` reads the file as
  text and pins the rule order; it cannot make Apache follow it. Every
  rewrite, `Options +ExecCGI`, the inherited `FollowSymLinks` that
  per-directory rewriting needs, and the claim that `/backend/.env` is not
  reachable by URL all rest on reasoning. `docs/DEPLOY.md` step 7's `curl`
  checks are the only thing that can close them (`UNVERIFIED.md` entry 38).
- **The CGI path has not run on the host.** The bridge itself *is* now tested
  here — `a2wsgi` is installed in the development environment (`f708161`), so
  `backend/tests/test_cgi.py` exercises ASGI→WSGI→CGI, `cgi_environ`, a
  request body, a historian's own media and a crash before the headers, on
  every run. 0006 and `UNVERIFIED.md` entry 33 said that could not be done;
  that is out of date. What is untested is the part that needs Apache
  (`UNVERIFIED.md` entry 33, rewritten).
- **CGI under concurrency.** CloudLinux caps concurrent entry processes and
  CGI spends one per request. Keeping Python off the static path keeps the
  count low, but several historians loading media-heavy stops at once could
  brush the limit, and the symptom would be sporadic 500s or 508s under load
  rather than a steady failure. Pre-engineering around it before anyone has
  used the app would be guessing (`UNVERIFIED.md` entry 39).
- **That the code runs on 3.12** (decision 6, `UNVERIFIED.md` entry 37).
- **Whether Directory Privacy writes into *this* `.htaccess` on this host at
  all.** If it keeps the password elsewhere, the merge is a no-op and the
  whole of decision 7 is machinery for a case that does not arise — which is
  worth knowing but costs nothing. Whether the merge preserves a real password
  across a real deploy is also unproven (`UNVERIFIED.md` entry 34).
- **The document-root contract.** The subdomain's document root must be
  `DEPLOY_PATH` itself; `app.cgi` finds the interpreter relative to its own
  path and `.htaccess` finds the bundle relative to `%{DOCUMENT_ROOT}`. If
  cPanel refuses a document root outside `public_html`, the runbook's fallback
  nests the tree inside it — which gives the tree a second URL under the
  parent domain, where `%{DOCUMENT_ROOT}` is the parent's and the rewrites do
  not resolve (`UNVERIFIED.md` entry 34).
- **The atomicity of the `.htaccess` merge is only half-tested.** The test
  asserts that no temp file is left beside the destination, which a
  non-atomic direct write would also satisfy. The `mv` is what makes it
  atomic, and nothing proves the `mv` is what happened
  (`UNVERIFIED.md` entry 34).
- 0006's open questions that this branch does not touch stay open: the
  browser's ability to call `graph.mapillary.com` (entry 32, still the largest
  risk), the Overpass mirrors beyond the first, and whether the measurements
  taken from the cPanel shell describe the process that serves requests.
  `GET /api/diagnostics/egress` still exists to ask that last one from inside
  the running application, and is still the runbook's first step.
