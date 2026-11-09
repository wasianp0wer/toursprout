# Serving the hosted editor through CGI — design

**Date:** 2026-11-09
**Status:** awaiting implementation
**Supersedes:** the Passenger half of
`2026-11-06-hosted-tester-deployment-design.md` (§6.4, §6.5 steps 3 and 6,
and §6.6's runbook shape). Everything else in that design stands.
**Base:** `main` at `29721ad`, which merged the twelve-task hosted-deployment
branch.

The hosted deployment landed on the assumption that the host offers cPanel's
"Setup Python App" — CloudLinux's Passenger-managed Python, which is WSGI-only
and which `passenger_wsgi.py` bridges onto with `a2wsgi`. **The host does not
offer it.** This design records what the host does offer, measured, and the
architecture that follows.

## 1. What the host actually is

Measured in the host's own terminal and browser on 2026-11-08/09. Raw output
is committed under `docs/tests/`.

| Question | Result | Consequence |
| --- | --- | --- |
| cPanel Python app support | **absent** | `passenger_wsgi.py` has nothing to run it |
| `python3` | **3.6.8**, pip 9.0.3 | end-of-life 2021; unusable |
| `python3.12` | **3.12.15**, `venv` works, pip 23.2.1 | this is the interpreter |
| PyPI reachable from the host | **yes** — `pip install fastapi a2wsgi` succeeded | dependencies can be installed |
| Background process survives logout | **no** — `200` then `000` | nothing long-lived can be kept up |
| `mod_proxy` in `.htaccess` | **no** — the whole site 500s | nothing can be proxied to a local port |
| CGI | **yes** — `t.cgi` printed `cgi ok` | this is the execution model |
| Cold start, app-equivalent imports | **0.36–0.40 s** over 8 runs | CGI is affordable |

The two negative results are jointly decisive: a long-running `uvicorn` is
impossible *both* because the process would be reaped and because Apache
would not route to it. That closes the option without ambiguity.

The PyPI result deserves emphasis because it could have ended the project on
this host: egress here is **selective**, not open. `graph.mapillary.com` is
unreachable and `www.loc.gov` answers 403, which is why the previous branch
moved panorama search into the browser and removed in-editor archive search.
PyPI being reachable is what makes a venv on the host possible at all.

## 2. Intent

Serve the editor from this host, to roughly six historians, without a
long-running process, keeping every behaviour the previous branch built.

## 3. Goals

- The app serves at the root of a subdomain, over HTTPS.
- Static frontend assets are served by Apache, never by Python.
- `/api/*` and `/tour-data/*` are handled by the application.
- A deploy remains a push to `main`.
- Nothing in `backend/app/` changes except where the execution model forces it.
- The frontend does not change at all.

## 4. Non-goals

- Supporting Passenger as well. The host has no Passenger; carrying a second
  entry point would mean two untested paths instead of one.
- Performance work beyond keeping Python off the static path.
- Changing the session, sweep, cap or recovery-key designs. They were reviewed
  and merged; this design only changes where the code runs.

## 5. Anti-goals

Unchanged from the previous design, and still binding:

- A deploy, or any other operation, that destroys or truncates a historian's
  in-progress tour.
- One historian able to read or overwrite another's document or media.

And one new to this design:

- A static-serving shortcut that weakens session isolation. See §6.2.

## 6. The design

### 6.1 CGI, with `python3.12` from a venv

A CGI script at the subdomain's document root replaces `passenger_wsgi.py`.
It invokes the host venv's interpreter, puts `backend/` on `sys.path`, and
runs the app through two bridges: `a2wsgi`'s `ASGIMiddleware` for ASGI→WSGI,
then `wsgiref.handlers.CGIHandler` for WSGI→CGI.

`a2wsgi` therefore survives the change of host, and so does the reason
`create_app` sets `app.state.cfg` in its body rather than in a lifespan: no
more under CGI than under Passenger does the ASGI lifespan run.

The script must get `SCRIPT_NAME` and `PATH_INFO` right so that routes
resolve at the subdomain root. A front-controller rewrite (§6.2) sends every
dynamic URL to one script, so the script sees itself at `/` and the real path
in `PATH_INFO`; if that is mishandled every route 404s, which is the first
thing the runbook checks.

### 6.2 Apache serves the bundle; CGI serves the API

Today `_mount_frontend` mounts the built Angular bundle on `/` through
FastAPI's `_SpaFiles`. Under CGI that would spend a 0.4 s process start on
every JavaScript chunk, which is absurd for files that are public application
code.

So `.htaccess` becomes a front controller:

- static assets under the frontend dist are served **directly by Apache**
- `/api/*` and `/tour-data/*` are rewritten to the CGI script
- any other path falls back to `index.html`, preserving the single-page app's
  deep links — the same job `_SpaFiles` does today

**`/tour-data/*` stays in Python, deliberately.** Serving session media
statically would be faster still, and it is rejected: the only thing that
separates one historian's media from another's is the `sid`, and the `sid` is
also the recovery key. Putting it in asset URLs would leak it through
`Referer` headers, browser history, bookmarks and screenshots — turning a
performance tweak into a credential leak. The route's `resolve()` /
`is_relative_to` containment guard stays on the path that needs it.

`_mount_frontend` and `_SpaFiles` stay in the code: they are what makes
`make serve` work in development, and the published-static-site output still
relies on the same layout. Under CGI they are simply never reached, because
Apache answers first.

### 6.3 The Python floor drops to 3.12

`requires-python` is `>=3.13`; the host has 3.12.15. `app/` and `tests/` were
scanned for syntax and stdlib newer than 3.9 — PEP 695 generics, `match`,
`StrEnum`, `TaskGroup`, `datetime.UTC`, `tomllib`, `@override`,
`itertools.batched`, `TypeIs`, `ReadOnly`, `except*` — with no hits, so the
floor is expected to move cleanly.

**This cannot be proved in the development environment**, which has no network
and so cannot build a 3.12 interpreter. The proof has to come from CI, which
can, and from the host. The same shape as `a2wsgi` on the previous branch:
ship it, verify where it can be verified, and say plainly that it is unproven
until then.

### 6.4 The sweep's throttle moves to a file

`_sweep_once` throttles on `app.state.last_sweep`, hourly. Under CGI every
request is a fresh process, so `app.state` cannot carry anything between
requests and the throttle would never fire — meaning a sweep on **every**
cookieless mint, which is precisely the stat storm the throttle exists to
prevent.

The timestamp moves to a file in `sessions_dir`. The same properties must
hold: written before the sweep runs so a failing sweep is not retried every
request, never raising into a request, and no behaviour change to the two
retention windows.

### 6.5 The deploy pipeline

The existing workflow is right in shape — CI builds, tests, and rsyncs; the
host receives files — and that stays, because the host cannot build the
frontend. It has no Node, and Angular 22 needs Node 24. It also keeps a
private-repo credential off shared hosting, which a `git pull` on the host
would require.

What changes:

- the virtualenv-activate step stops guessing at `~/virtualenv/<app>/<ver>/`
  and uses the venv the runbook creates explicitly
- `touch tmp/restart.txt` goes: there is no resident process to restart, and
  CGI picks up new files on the next request
- the CGI script and `.htaccess` join the rsynced set
- the host-side `pip install` targets the explicit venv

Everything else — the host-key pin, the empty-config guard, `.env` written
only when absent, no `--delete`, the frontend test gate — is unchanged and
was reviewed on the previous branch.

### 6.6 Documentation

`DEPLOY.md` steps 4 and 7 are about Setup Python App and the Passenger bridge
test; both are replaced. A new step creates the venv and installs
dependencies, and another installs `.htaccess` and the CGI script and checks
that a dynamic route answers. `UNVERIFIED.md` gains the 3.12 floor and the
CGI path. ADR 0006 is **not** edited — the convention is that a record
explains the forces at the time — so a new ADR supersedes its hosting
decision.

## 7. Known risks, stated rather than hidden

**Entry processes.** CloudLinux caps concurrent entry processes, and CGI
spends one per request. Serving the bundle statically keeps the count low,
but several historians loading media-heavy stops at once could brush the
limit. It belongs in the runbook as something to watch; pre-engineering
around it before anyone has used the app would be guessing.

**0.4 s on every dynamic request.** Autosave, session polling and each media
fetch pay it. Browsers parallelise, so a tour with a dozen media files is
closer to a second than to five. Acceptable for six testers; it is the reason
§6.2 exists.

**The 3.12 floor is unproven here** (§6.3).

**The host's real layout is unproven.** The document root's path, whether
`.htaccess` permits `Options +ExecCGI`, and where the CGI script must sit
relative to the subdomain are all guesses until the runbook is walked.

## 8. What is explicitly unchanged

The cookie-keyed sessions, the recovery key, the two-window sweep's
behaviour, the resource caps, the browser-side Mapillary search, the removal
of narration and in-editor archive search, and every document written for
them. This design moves where the code runs; it does not revisit what it does.
