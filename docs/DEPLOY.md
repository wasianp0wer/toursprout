# Deploying to the Reclaim host

A runbook for the person operating the server. The historians' one-page guide
is [`FOR-HISTORIANS.md`](FOR-HISTORIANS.md); this one is not for them. The
reasoning behind the shape of all this is in
[ADR 0006](decisions/0006-host-it-one-session-per-browser.md), and the design
is `docs/superpowers/specs/2026-11-06-hosted-tester-deployment-design.md`.

**Nothing in this file has been run against the real host.** It was written
from the code and the workflow in a sandbox with no network. Treat every step
as an instruction to verify, not a description of what works. Each step says
what you should see, and what to paste back if you see something else. Where a
detail about the host is a guess, the text says so.

How it fits together, in four sentences. A push to `main` runs
`.github/workflows/deploy.yml`, which builds the frontend, runs the lint and
the tests, and then `rsync`s `passenger_wsgi.py`, `backend/`, the built
frontend and `content/` to the host over SSH. It then creates `backend/.env` if the host does not have one yet,
installs the dependencies into the app's virtualenv with `pip`, and touches
`tmp/restart.txt` so Passenger restarts. Passenger runs WSGI and the app is
ASGI, so `passenger_wsgi.py` wraps it with `a2wsgi`. Each historian's tour
lives outside all of that, in `~/.clio-wired/sessions`, so a deploy cannot
touch it.

---

## 1. Run the egress diagnostic, and learn to read it

This comes first because it decides what the application can do on this host,
and because "reachable" does not mean "usable".

`GET /api/diagnostics/egress` makes the running application try each outside
service it might depend on: `graph.mapillary.com`, `www.loc.gov` and all four
Overpass mirrors, in parallel, with an 8 second limit each. It asks from inside
the application, not from your shell, because a cPanel shell is not the
Passenger worker and CloudLinux can treat the two differently. The earlier
measurements (ADR 0006) were taken from the shell and are strong evidence, not
proof.

**The first time through, nothing answers yet.** The diagnostic needs the app
running, which needs steps 3 to 6. Do those against a staging path, then come
back here before doing anything else. On every deploy after that, this is the
first thing to check.

```sh
curl -u USER:PASSWORD https://YOUR-HOST/api/diagnostics/egress
```

(Leave out `-u` before Directory Privacy is on, step 8.) The answer is one
object, one entry per host:

```json
{"hosts": {"graph.mapillary.com": {"error": "timed out"},
           "www.loc.gov": {"status": 403},
           "overpass-api.de": {"status": 400}, ...}}
```

An entry is either `{"status": N}`, meaning a connection completed and the
server answered with HTTP status N, or `{"error": "..."}`, meaning no HTTP
answer came back. Any status at all proves the network path is open. Whether
the answer is *useful* depends on the status:

| Host | You see | It means | What to do |
| --- | --- | --- | --- |
| any | `200` | Reachable and answering. | Nothing. |
| `www.loc.gov` | `403` | **Reachable but refused**, at Cloudflare's firewall. The connection completes and the server says no. This is the condition that removed in-editor archive search (ADR 0006). It is not a fault to fix. | Nothing. Historians use loc.gov in their own browser. |
| each Overpass mirror | `400` | Normal. The probe sends no query, so a working Overpass answers "bad request". It is reachable. | Nothing. |
| an Overpass mirror | `502`, `504`, `429` | Reachable, but busy or rate-limiting. `overpass-api.de` was seen answering `502` before. | Run it again in a few minutes. |
| `graph.mapillary.com` | an `error` entry | **Genuinely blocked.** `"timed out"` is the signature of the silently dropped connection measured on 2026-11-06. | Nothing. Panorama search runs in the historian's browser, not here. |
| `graph.mapillary.com` | any `status` | Reachable from the server. (Unverified what status it returns; the probe has no token.) | Nothing; the app does not need it. |
| any other host | an `error` entry | Blocked, or DNS failed. `"timed out"` is a dropped connection; other text names the exception. | See below. |

The line that matters is Overpass. **If at least one of the four mirrors shows a
status, place search can work.** If all four show an `error`, place search is
dead on this host, and its fate is the author's decision (ADR 0006,
"What is not known"): paste the whole object back.

**Paste back:** the whole JSON object, and the time you ran it, if anything
other than the table's "normal" rows appears. In particular: any `error` on an
Overpass mirror, and any status on `graph.mapillary.com` other than an error.

## 2. On your own machine: run `uv lock` once, with network access

`backend/pyproject.toml` now depends on `a2wsgi`, but `backend/uv.lock` was
**deliberately not regenerated**: the environment this branch was written in
has no network, and `uv lock` needs one. So the lock is stale. This will bite
the author first:

- `make backend-test` (and `make lint`, `make serve`; everything that goes
  through `uv run`) tries to re-resolve the lock. With no network that fails.
  With a network it succeeds but rewrites `uv.lock`, which leaves you with an
  uncommitted change you did not ask for.
- The CI workflow copes: it runs `uv sync`, which re-resolves, on purpose
  (`.github/workflows/deploy.yml` says why).

Fix it once:

```sh
cd backend && uv lock
git add uv.lock && git commit -m "Lock a2wsgi"
```

Once the regenerated lock is committed, change `uv sync` to `uv sync --frozen`
and add `--frozen` to the `uv export` in the workflow, as the workflow's own
comment says. Do not do that before the lock is committed or the build breaks.

**You should see:** `uv lock` finishing without error and `git diff` showing
`a2wsgi` added to `uv.lock`. **Paste back:** the error, if it fails.

## 3. Find out what the host offers

Three answers, none of which could be checked from here:

1. **Is SSH enabled on the plan?** cPanel, *Security*, *SSH Access*. The deploy
   cannot run without it. (The fallback, cPanel Git Version Control with a
   `.cpanel.yml`, works but requires committing the built frontend; it is not
   built.)
2. **Which port does SSH use?** Reclaim has not been confirmed to use 22. If it
   is not 22, you set the `DEPLOY_PORT` variable in step 5.
3. **Which Python versions does *Setup Python App* offer?** The workflow pins
   **3.13** (`python-version: "3.13"` in `deploy.yml`, and
   `requires-python = ">=3.13"` in `backend/pyproject.toml`). **The host's
   offered versions are still unconfirmed**, and they must match: the tests run
   on the interpreter CI picks, and the app runs on the one cPanel picks. If
   the dropdown's highest version is lower than 3.13, stop and report: the
   floor in `pyproject.toml` was set without a measured reason, and the
   workflow's version, the lock and the floor must all move together (a
   decision for the author, not a fix to make in passing).

**Paste back:** the SSH port, the list of Python versions in the dropdown, and
your disk quota, if cPanel shows it.

## 4. Create the Python app in cPanel

cPanel, *Software*, *Setup Python App*, *Create Application*:

| Field | Value |
| --- | --- |
| Python version | 3.13 (see step 3) |
| Application root | the path you will use as `DEPLOY_PATH`, relative to your home directory, e.g. `tours`. **It must be under your home**: the workflow finds the virtualenv by stripping `$HOME/` from the path. |
| Application URL | the **root** of a subdomain, e.g. `tours.example.org`, with nothing after it. The frontend requests `/api/session` and friends with a leading slash, so under a subpath every call would break while the viewer kept working. |
| Application startup file | `passenger_wsgi.py` |
| Application entry point | `application` |

(These are the names in `passenger_wsgi.py`: it defines
`application = ASGIMiddleware(app)`.) Leave the environment-variable box empty;
settings come from `backend/.env`, which the first deploy creates (see the settings
table below).

cPanel puts a placeholder `passenger_wsgi.py` in the application root when it
creates the app. The first deploy overwrites it; step 6 checks that it did.

**You should see:** the app listed as *Started*, and cPanel showing a
virtualenv path. **Paste back:** that path. The workflow assumes CloudLinux
keeps it at `~/virtualenv/<application root>/<python version>/`; that is a
**guess, unproven** (the workflow says so too). If the path cPanel shows has a
different shape, the *Install dependencies and restart* step will fail
loudly with "No virtualenv under ~/virtualenv/..." rather than doing the wrong
thing.

## 5. Configure GitHub

Repository *Settings*, *Secrets and variables*, *Actions*. The two tabs matter.

**Secrets** (the *Secrets* tab):

| Name | What it is |
| --- | --- |
| `SSH_PRIVATE_KEY` | A private key made for this and nothing else, authorised on the host. Make one with `ssh-keygen -t ed25519 -f deploy_key`, add `deploy_key.pub` in cPanel under *SSH Access*, *Import Key*, then *Manage*, *Authorize*, and paste the *private* file here. |
| `DEPLOY_HOST` | The SSH hostname. |
| `DEPLOY_USER` | Your cPanel username. |
| `DEPLOY_PATH` | The absolute path of the application root, e.g. `/home/USER/tours`. **Set it even if you only mean to rehearse**: the first workflow step refuses to run with any of these empty. |
| `MAPILLARY_TOKEN` | Written into `backend/.env` on the first deploy only. |

**Variables** (the *Variables* tab; the host's public key is not secret):

| Name | Required | What it is |
| --- | --- | --- |
| `DEPLOY_HOST_KEY` | yes | The host's public key, pinned. See below. |
| `DEPLOY_PORT` | no | The SSH port. Defaults to 22. |

### The host key, precisely

The workflow does not scan the host at deploy time. A fresh runner trusting
whatever answers at that address would send the source and `.env` to anything
that did. It pins the key you give it instead, and a mismatch fails the deploy.

```sh
ssh-keyscan -t ed25519 YOUR-HOST          # add -p PORT if it is not 22
```

You get a line like `YOUR-HOST ssh-ed25519 AAAAC3...`. **Paste only the key
portion**: the type and the base64 blob, `ssh-ed25519 AAAAC3...`, without the
hostname in front. The workflow writes `HOST KEY` into `known_hosts` itself.

Three ways this goes wrong, and all three present as the same unhelpful
message, "Host key verification failed":

1. **The key type does not match what the host offers.** Pinning an ed25519
   key when the host presents RSA fails closed. Before you pin anything, run
   `ssh-keyscan YOUR-HOST` with no `-t` and look at which types come back. Pin
   one of those, and if the type is not `ssh-ed25519`, paste the matching
   `ssh-rsa AAAA...` line instead.
2. **A multi-line paste.** If `ssh-keyscan` printed several lines (several
   types, or comment lines starting `#`) and you pasted them all, `known_hosts`
   is malformed. One line, one key.
3. **The hostname does not match.** The pinned entry is for the exact string in
   `DEPLOY_HOST`; scanning an IP address and then deploying to the hostname (or
   the reverse) will not match.

Take the key from output you have **looked at**, ideally from the host's own
console or a network you trust, and compare the fingerprint
(`ssh-keygen -lf` on the line) with what cPanel's *SSH Access* page shows if it
shows one. Do not take it from the pipeline.

## 6. Rehearse: deploy to a staging path first

A first-run deploy workflow does not work first try, and a deploy that destroys
a historian's tour is a failure condition, so rehearse. In GitHub, *Actions*,
*Deploy*, *Run workflow*, and give **`target`** an absolute path under your home
that is *not* the production app root (e.g. `/home/USER/tours-staging`), after
creating a second Python app for it in step 4 with its own subdomain.
Leave `target` empty only for production, which runs from `main` only; a manual
run of any other branch with an empty target is refused on purpose.

**You should see**, in the log, in order: *Check configuration*, *Choose the
deploy target* ("Rehearsal deploy to the path given as input."), the build,
`ruff` and `pytest` passing, *Copy files to the host* listing files
(`rsync --itemize-changes`), *Write backend/.env (only if absent)*, then *Install dependencies
and restart*.

**Stop and paste back** the failing step's log if any step goes red. The likely
ones:

- *Check configuration*: a missing secret or variable, named in the error.
- *Set up SSH* or any `ssh`/`rsync` line: "Host key verification failed" (see
  step 5), "Permission denied (publickey)" (the key is not authorised), or a
  connection timeout (wrong `DEPLOY_PORT`).
- *Install dependencies and restart*: "No virtualenv under ~/virtualenv/..."
  (step 4's guess is wrong), or a `pip` build error. Paste the whole error;
  nothing about what `pip install -r requirements.txt` needs on this host is
  verified.

Then check on the host, over SSH, that the placeholder was replaced:

```sh
head -n 12 /home/USER/tours-staging/passenger_wsgi.py
```

**You should see** a docstring starting `Passenger entry point` and a line
`from a2wsgi import ASGIMiddleware`. If you see cPanel's placeholder instead,
`rsync` did not overwrite it: paste back the file.

Then, from your own machine:

```sh
curl https://STAGING-HOST/api/health          # {"status":"ok"}
```

An error page here instead is the Passenger log's job (see "Reading the
Passenger log" below). Now go back to step 1 and run the diagnostic.

## 7. Run the WSGI bridge test on the host

`backend/tests/test_wsgi.py` drives `passenger_wsgi.py` through a real WSGI
transport and checks `/api/health`. It is **skipped in development**, because
`a2wsgi` cannot be installed there, so this is the first and only time it
runs. The deploy ships the tests along with `backend/`, but not `pytest`, which
is a dev dependency. On the host:

```sh
source ~/virtualenv/tours-staging/3.13/bin/activate   # the path from step 4
pip install pytest
cd /home/USER/tours-staging/backend
python -m pytest tests/test_wsgi.py -q -rs
```

**You should see:** `5 passed`, and **no line saying `SKIPPED`**. On the host
it must show as *passed*, not *skipped*. A skip means `a2wsgi` is not
installed in this virtualenv, and Passenger will not start the app. (In
development the same command prints `4 passed, 1 skipped`, with the skip
reason naming `a2wsgi`; that is how you know the skip is the one you are
looking for.)

**Paste back:** the whole output if there is a `SKIPPED`, a failure, or an
import error. If it skips, check that the virtualenv you activated is the
app's: `pip list | grep -i a2wsgi`.

## 8. Directory Privacy, for the shared password

cPanel, *Files*, *Directory Privacy*. Choose the subdomain's **document root**
(where cPanel serves the domain from, which is not necessarily the
application root), turn on password protection, and create one username and
one password. Give those to the historians.

The risk this step exists to close is strangers reaching the editor, spending
the Mapillary quota and filling the disk. Whether Directory Privacy covers
requests that Passenger handles, rather than files Apache serves, **has not
been verified** on this host. So check, from a machine with no credentials:

```sh
curl -s -o /dev/null -w "%{http_code}\n" https://STAGING-HOST/
curl -s -o /dev/null -w "%{http_code}\n" https://STAGING-HOST/api/session
curl -s -o /dev/null -w "%{http_code}\n" -u USER:PASSWORD https://STAGING-HOST/api/session
```

**You should see:** `401`, `401`, `200`. If the second line is `200`, the
password protects the page but not the API, and the shared password is
decoration: stop and report. (Note that `GET /api/session` creates a directory
for the visitor; that is another reason this check matters.)

## 9. AutoSSL, because the microphone needs HTTPS

cPanel, *Security*, *SSL/TLS Status*, run AutoSSL for the subdomain. **HTTPS is
required, not nice to have.** Browsers only give a page the microphone in a
secure context. `localhost` counted as one during development, which is why
this never came up. The session cookie is also always `Secure`, and the recovery
key's *Copy* button uses the clipboard API, which wants a secure context too.

```sh
curl -sI https://STAGING-HOST/api/health | head -n 1      # HTTP/2 200
```

**You should see** a normal response over `https://` with no certificate error.
Then open the site in a browser and check for the padlock. **Paste back:** the
`curl` error, if any (`curl: (60)` is a certificate problem).

## 10. Go to production, and smoke-test it

Merge to `main`. The workflow runs on the push, and with `target` empty it
deploys to `DEPLOY_PATH`. Once it is green:

1. `https://HOST/api/health` answers `{"status":"ok"}`.
2. Run step 1 again against production.
3. In a browser, sign in with the shared password and open `https://HOST/`. **You
   should see** the welcome screen, with *Old Town Fairfax* under "Open an
   example". Open it. You should land in the editor with six stops, and a
   *Recovery key* with a *Copy* button in the top bar.
4. In a second, different browser (or a private window), open the same URL. It
   must show the welcome screen, not the first browser's tour. That is the
   whole point of the session code, and it is the check that matters most.
5. In the first browser, select a stop and click *Record audio*. The browser should ask for the microphone. (This has never run in a
   real browser: `UNVERIFIED.md` entries 7 to 9.)
6. Search for panoramas on a stop. (Whether the browser may read Mapillary's
   answer is the largest open risk: `UNVERIFIED.md` entry 32.)

**Paste back:** what you see for any item that differs, with the browser's
console and the Network tab's failing request.

---

## Settings

Everything the application reads from the environment lives in
`backend/app/config.py` (`Settings`), read from the process environment or from
`backend/.env`. Names are case-insensitive. **There is no example `.env` in the
repository**, so this table is the reference. Nothing is strictly required: a
missing `MAPILLARY_TOKEN` does not stop the app starting, but panorama search
then says "no Mapillary token is configured".

| Key | Default | What it does |
| --- | --- | --- |
| `MAPILLARY_TOKEN` | empty | The Mapillary client token. Handed to every browser in the viewer config (Mapillary tokens are designed to be public in a client), and written into each session's `config.json`. **Needed in practice.** The deploy writes it from the `MAPILLARY_TOKEN` secret. |
| `SESSIONS_DIR` | `~/.clio-wired/sessions` | Where session directories live. Outside the deploy tree on purpose. Created lazily, when the first session is minted. |
| `SESSION_RETENTION_DAYS_WITHOUT_TOUR` | `1` | The sweep window for a directory with no `tour.json`. Must be greater than 0. |
| `SESSION_RETENTION_DAYS_WITH_TOUR` | `90` | The sweep window for a directory with real work. Must be greater than 0. |
| `MAX_MEDIA_FILE_BYTES` | `67108864` (64 MB) | The largest single upload. |
| `MAX_SESSION_MEDIA_BYTES` | `1073741824` (1 GB) | Total media per **session**, everything under one tour's `media/`. |
| `MAX_BUNDLE_BYTES` | `536870912` (512 MB) | The largest **archive** accepted on import, counted uncompressed. Do not confuse it with the line above: one is per session, one is per archive. |
| `MAX_BUNDLE_ENTRIES` | `5000` | The most files an imported archive may hold. |
| `CONTENT_DIR`, `FRONTEND_DIST` | derived from where `backend/` sits | The examples and the built frontend. The deploy mirrors the repository's layout so the defaults are right; do not set these without a reason. |

The caps are positive-only, so a typo is an error at startup, not a server that
refuses every upload. `Settings` ignores keys it does not know, so **a
misspelled key is silently ignored**: after changing one, check it took
(restart, then try the behaviour).

**`backend/.env` is host-owned state.** The deploy creates it once, from the
`MAPILLARY_TOKEN` secret, and never overwrites it: the *Write backend/.env (only
if absent)* step logs either "created it" or "left alone". So to set
`SESSIONS_DIR`, lower a cap, or change the retention windows, **edit
`backend/.env` on the host** and restart (`touch tmp/restart.txt`). Your edit
survives every later deploy. The trade: **a rotated Mapillary token does not
propagate.** Updating the `MAPILLARY_TOKEN` secret changes nothing on an
existing host; edit the token in the host's `.env` by hand. (The file is
created with mode 600.) To re-bootstrap, delete the host's `.env` and deploy.

## Where sessions live, and how to back them up

`SESSIONS_DIR` defaults to `~/.clio-wired/sessions`, deliberately outside the
deploy tree so `rsync` cannot touch it. Each subdirectory is **one historian's
tour**, and its name is **their recovery key**: sixteen lowercase hex
characters. Inside:

```
<sid>/bundle.json   <sid>/tour.json   <sid>/config.json   <sid>/media/…
```

To back up all of them:

```sh
tar czf ~/sessions-$(date +%F).tar.gz -C ~/.clio-wired sessions
```

Two things to know about a backup:

- **It contains every recovery key**, as directory names, and the Mapillary
  token, in each `config.json`. Treat it as a secret and do not email it.
  (A historian's own `.zip` export leaves out `config.json`.)
- **Restore with `tar -x -m`** (`--touch`), not plain `tar -x`. The sweep
  (below) measures age from the files' modification times, and a plain
  extraction preserves them. A backup older than 90 days restored without `-m`
  is deleted by the next sweep.

Two other names can appear in the sessions directory, both left by an import
(*Import bundle*, *Import files*, or opening an example) that was interrupted by
a process death part-way through swapping the new tour in:

- `<sid>.incoming` holds the **half-finished new tour** of an import that did
  not complete. It is garbage. The sweep reclaims it once it is a day stale (the
  same window as a directory with no `tour.json`), and you may delete it by hand.
- `<sid>.outgoing` holds the **tour that was being replaced**. The sweep never
  touches it. Look inside before you delete it: it may be the only copy of a
  historian's earlier work, and `mv` it back to `<sid>` if the import left that
  name missing.

Both end up in a `tar` backup of the sessions directory, like everything else
in it.

Historians can also keep their own copy at any time: *Export bundle* in the
editor downloads a `.zip`.

## What the sweep does, so a disappearing directory is not a surprise

On a mint, the application deletes abandoned session directories:

- a directory with **no `tour.json`** after **1 day**: it holds no authored work,
  and no one was shown a recovery key for it (a visit that never started a
  tour, or a request that failed halfway);
- a directory **with a `tour.json`** after **90 days**, because its recovery key
  may be on paper.

Age is measured from the **newest file inside** the directory, not from the
directory itself (a directory's own timestamp does not move when a file inside
is rewritten, and autosave rewrites `tour.json`). So a tour in use never
ages out. A directory the sweep cannot read completely is left alone.

It runs at most **once an hour** per application process, and only when a
request needs to *mint* a new session (the first visit by a new browser, or a
creating route with no cookie). It is not a timer: with no new visitors it does
not run. A Passenger restart resets the hour, so the first mint after a deploy
sweeps. It never raises into a request; failures are logged as the exception's
type only, never with a recovery key.

## Reading the Passenger log

When the page is an error page, a blank 500, or "Incomplete response received
from application", the answer is in the Passenger log. **Where this host
writes it is unverified.** Look, in this order:

1. `<application root>/stderr.log`, which CloudLinux's *Setup Python App*
   normally creates beside the app.
2. cPanel, *Metrics*, *Errors*: the web server's recent error log, which
   includes Passenger's startup failures.
3. `~/logs/`.

If none of them exists, ask Reclaim support where an application's Passenger log
is, and paste back `ls -la` of the application root.

```sh
tail -n 100 /home/USER/tours/stderr.log
```

What you are looking for: a Python traceback ending in the real error (an
`ImportError: a2wsgi` is a missing dependency; a `ValidationError` from
`Settings` is a bad `.env` value). After fixing anything, restart Passenger
without redeploying:

```sh
touch /home/USER/tours/tmp/restart.txt
```

(or press *Restart* on the app in *Setup Python App*). A request that makes the
worker die with no traceback, especially an export or publish of a large tour,
is likely the host's memory limit: those two responses read the whole zip into
memory (design §6.7). Lowering `MAX_SESSION_MEDIA_BYTES` is the first remedy.

## Known limitations, stated rather than hidden

- **No `--delete` in the deploy.** A file deleted from the repository **lingers
  on the host** until you remove it by hand. This is deliberate: a deploy that
  destroys a tour is a failure condition, and not deleting is the second defence
  behind keeping the sessions outside the tree. If a removed file matters
  (a deleted example, say), delete it over SSH.
- **The CloudLinux virtualenv path in the workflow is an unproven guess**
  (step 4). If it is wrong, the install step fails loudly.
- **The SSH port must be confirmed** (step 3). The workflow defaults to 22.
- **The Python version is 3.13 in the workflow, and the host's "Setup Python
  App" version is still unconfirmed.** They must match (step 3).
- **`uv.lock` is stale** until you run `uv lock` (step 2).
- **The WSGI bridge and the whole pipeline have never run.** Steps 6 and 7 are
  where that changes.
- **The recorder has never run in a real browser,** and ships that way by the
  author's decision; historians are told where to report a failure.
- **Whether a browser may call `graph.mapillary.com` directly** is unproven
  (`UNVERIFIED.md` entry 32).
- **Two tabs in one browser are one session.** They share the cookie, and
  therefore the tour: the last save wins. This is the "two historians editing
  the same tour" case, and it is out of scope by design.

## A wart in local development

The session cookie is always `Secure`. Chrome and Firefox accept a `Secure`
cookie on `http://localhost`, but **Safari historically rejects it**, so local
development in Safari mints a new session on every request: the welcome screen
keeps returning and a tour you just opened is gone. This is deliberate, not a
bug to fix. Passenger terminates TLS upstream, so the scheme the application sees
can be `http` for a request the browser made over HTTPS; deriving the flag from
the request scheme would silently drop it in production, which is where it
matters. Develop in Chrome or Firefox. (`curl` on `http://localhost` stores and
sends the cookie without trouble; see `HANDOFF.md`.)
