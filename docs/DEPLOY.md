# Deploying to the Reclaim host

A runbook for the person operating the server. The historians' one-page guide
is [`FOR-HISTORIANS.md`](FOR-HISTORIANS.md); this one is not for them.

The reasoning behind the shape of all this is in
[ADR 0006](decisions/0006-host-it-one-session-per-browser.md), and the hosted
deployment it led to is
`docs/superpowers/specs/2026-11-06-hosted-tester-deployment-design.md`. That
design assumed cPanel's *Setup Python App* — CloudLinux's Passenger — and
**this host does not offer it**. The half of that design which rested on
Passenger is superseded by
`docs/superpowers/specs/2026-11-09-cgi-deployment-design.md`: the application
now runs as **CGI behind an Apache front controller**. What the host was
measured to actually offer is step 3's table, and the raw output those rows
were read from is committed in [`tests/`](tests/) with a README that says
which file is which.

**No step in this file has been run against the real host.** The exception is
step 3's table: those rows were measured in the host's own terminal and
browser on 2026-11-08/09. Everything else — every command below, and every
claim about where this host puts things — was written from the code and the
workflow in a sandbox with no network. Treat every step as an instruction to
verify, not a description of what works. Each step says what you should see,
and what to paste back if you see something else. Where a detail about the
host is a guess, the text says so.

How it fits together. **You ship from your own machine:** `deploy/deploy.sh`
(step 5b) runs `make check` — the lint, both test suites and the frontend
build — and then `rsync`s `app.cgi`, `.htaccess`, `backend/`, the built
frontend and `content/` to the host over SSH. It then creates `backend/.env`
if the host does not have one yet, and `pip install`s the dependencies into
`$DEPLOY_PATH/.venv` — a virtualenv you create by hand, once, in step 4, and
which no deploy ever writes to or copies over. **Nothing is restarted,**
because nothing is resident: Apache executes `app.cgi` fresh for each request
the front controller (`.htaccess`) routes to it, so new files are live the
moment `rsync` finishes. Each historian's tour lives outside all of that, in
`~/.clio-wired/sessions`, so a deploy cannot touch it.

**A push to `main` no longer deploys**, which is the one structural change
since this runbook was first written. `.github/workflows/deploy.yml` still
holds the same sequence and is not stubbed or gutted, but it cannot reach the
host from GitHub's runners — the host's firewall drops their addresses, which
step 5 explains and [ADR 0008](decisions/0008-ship-from-a-workstation.md)
records — so it is kept intact and manual-only for the day that changes.
`.github/workflows/ci.yml` runs the frontend build, both test suites and the
lint on every push and every pull request, so the gates still fire on a merge;
they just do not ship anything. The gates that used to live in the trigger —
production deploys run from `main`, with a clean tree — now live in
`deploy/deploy.sh`, which refuses otherwise unless you give it `--target`.

---

## 1. Run the egress diagnostic, and learn to read it

This comes first because it decides what the application can do on this host,
and because "reachable" does not mean "usable".

`GET /api/diagnostics/egress` makes the running application try each outside
service it might depend on: `graph.mapillary.com`, `www.loc.gov` and all four
Overpass mirrors, in parallel, with an 8 second limit each. It asks from inside
the application, not from your shell, because the shell you type in is not the
CGI process Apache starts, and CloudLinux can treat the two differently. The
earlier measurements (ADR 0006, and `tests/` for this host) were taken from
the shell and are strong evidence, not proof.

**The first time through, nothing answers yet.** `/api/diagnostics/egress` is
a dynamic route, so it needs both the application installed (steps 3 to 6)
and the front controller routing `/api` to it (step 7). Do those against a
staging subdomain, then come back here before doing anything else. On every
deploy after that, this is the first thing to check.

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

`backend/uv.lock` is **stale, and still is after the `a2wsgi` fix.** The
missing dependency was locked in `f708161`; what is stale now is the Python
floor. This branch lowered `requires-python` to `>=3.12`, to match the
3.12.15 the host was measured to have (step 3), and the committed lock still
records `requires-python = ">=3.13"`. A lock resolved for a higher floor is
not a lock for this project any more, so:

- `make backend-test` (and `make lint`, `make serve`; everything that goes
  through a bare `uv run`) sees the mismatch and tries to re-resolve. With no
  network that fails. With a network it succeeds but rewrites `uv.lock`,
  leaving you an uncommitted change you did not ask for. The way to run the
  tests meanwhile is to opt out of the sync, which is what this branch has
  been doing:

  ```sh
  cd backend && uv run --no-sync pytest -q
  ```

- The CI workflow copes: it runs `uv sync`, which re-resolves, on purpose.
  Its comment explains the earlier, `a2wsgi` version of the staleness rather
  than this one; the workaround is the same either way. It is working around
  this, not endorsing it.

Fix it once, on a machine with a network:

```sh
cd backend && uv lock
git add uv.lock && git commit -m "Re-lock for the 3.12 floor"
```

Once the regenerated lock is committed, change `uv sync` to `uv sync --frozen`
and add `--frozen` to the `uv export` in the workflow, as the workflow's own
comment says. Do not do that before the lock is committed or the build breaks.

**You should see:** `uv lock` finishing without error, and `git diff uv.lock`
showing `requires-python` changed to `>=3.12`. A resolution that then refuses
a dependency on 3.12 is a real finding, not a lock problem: stop and report
it, because the host has no newer interpreter to move to. **Paste back:** the
error, if it fails.

## 3. What the host offers: what was measured, and what is still open

Most of this step has already been done. These rows were **measured on the
host** on 2026-11-08/09, in its own terminal and browser, and the raw output
is committed under [`tests/`](tests/). They are why the application is CGI
and not a long-running `uvicorn`:

| Question | Result | Consequence | Raw output |
| --- | --- | --- | --- |
| cPanel Python app support | **absent** | there is no Passenger; `passenger_wsgi.py` had nothing to run it, and is gone | — |
| `python3` | **3.6.8**, pip 9.0.3 | end-of-life since 2021; unusable | `tests/round1/test1.txt` |
| `python3.12` | **3.12.15**, `venv` works, pip 23.2.1 | **this is the interpreter.** Step 4 builds the venv with it | `tests/round1/test1.txt`, `tests/round2/test1.txt` |
| PyPI reachable from the host | **yes** — `pip install fastapi a2wsgi` succeeded | a venv on the host can be populated at all. Egress here is selective, so this was not a given | `tests/round2/test2.txt` |
| a background process surviving logout | **no** — `200`, then `000` | nothing long-lived can be kept up | `tests/round1/test2.txt` |
| `mod_proxy` in `.htaccess` | **no** — the whole site 500s | nothing can be proxied to a local port | `tests/round1/test4.png` |
| CGI | **yes** — a one-line `t.cgi` printed `cgi ok` | this is the execution model | `tests/round1/test3.txt`, `tests/round1/test3.png` |
| cold start, importing `fastapi` + `pydantic` | **0.35–0.46 s** over 5 runs | CGI is affordable, as long as Python stays off the static path (step 7). **Plan around 0.46 s**, the measured ceiling | `tests/round2/test3.txt` |

The two negative rows are jointly decisive, which is worth knowing if anyone
later proposes "just run `uvicorn`": the process would be reaped *and* Apache
would not route to it. Neither can be worked around from inside the account.

**On the cold-start row, because that number gets quoted.** The committed
evidence is five runs of the `fastapi` + `pydantic` import, and its ceiling is
0.46 s. An earlier version of this table said "0.36–0.40 s over 8 runs" and
cited the same file: that range comes from a *second*, app-equivalent import
series of three runs which was reported in conversation and **never committed**
anywhere under `docs/tests/`, so it cannot be checked from this repository and
should not be treated as measured. `docs/tests/README.md` describes both
series and is the only place that tells them apart. Size anything you plan
against **0.46 s per dynamic request**, not 0.40 s.

**Three questions are still open, and only cPanel can answer them:**

1. **Is SSH enabled on the plan?** cPanel, *Security*, *SSH Access*. The deploy
   cannot run without it. (The fallback, cPanel Git Version Control with a
   `.cpanel.yml`, works but requires committing the built frontend; it is not
   built.)
2. **Which port does SSH use?** Reclaim has not been confirmed to use 22. If it
   is not 22, you set the `DEPLOY_PORT` variable in step 5.
3. **Will cPanel accept `DEPLOY_PATH` as the subdomain's document root?** The
   document root and the deploy directory **must be the same directory** —
   that is a contract both `app.cgi` and `.htaccess` depend on, and step 4
   explains why and what to do if cPanel refuses.

Nothing about the Python version is open any more: the floor is `>=3.12`, CI
pins `3.12`, and `backend/tests/test_versions.py` fails if those two ever
drift apart. What is *not* proven is that the code runs on 3.12 — only that
the numbers agree. CI running green on 3.12 is the first evidence; the host is
the second.

**Paste back:** the SSH port, your disk quota if cPanel shows it, and whether
cPanel let you set the document root where step 4 asks.

## 4. Create the subdomain and the virtualenv

Two things, in this order, and the first one constrains the second.

### 4a. The subdomain, whose document root is the deploy directory

cPanel, *Domains*, *Create A New Domain* (or *Subdomains* on older
interfaces). Create a subdomain — e.g. `tours.example.org` — and set its
**document root** to the directory you will deploy into, e.g.
`/home/USER/tours`. That same absolute path becomes the `DEPLOY_PATH` secret
in step 5. For the rehearsal, make a second subdomain with its own directory,
e.g. `/home/USER/tours-staging`.

Two things here are **deploy contracts, not guesses about the host**, and both
are visible in the files that depend on them:

- **The document root must be the deploy directory itself.** The deploy puts
  `.htaccess` there, and the front controller's bundle rule tests
  `%{DOCUMENT_ROOT}/frontend/dist/frontend/browser/$1` — the one place it
  names an absolute location. If the document root is the parent directory,
  `%{DOCUMENT_ROOT}` is the parent, that test misses every file in the bundle,
  and rule 3 catches everything instead: a 200 on every URL, `index.html` in
  every body, no JavaScript. Apache also only reads an `.htaccess` for the
  directory it sits in and below, so one level too deep and the file is not
  read at all.
- **It must be the root of the subdomain, not a path under an existing
  domain.** The frontend asks for `/api/session` and friends with a leading
  slash. Under a subpath every API call would break while the viewer kept
  working, which is the most confusing possible failure.

**If cPanel refuses a document root outside `public_html`** — some
configurations will only let you point a subdomain at a directory beneath it —
then put the deploy directory inside it, e.g. `/home/USER/public_html/tours`,
and use that as `DEPLOY_PATH`. Nothing in the deploy, in `app.cgi` or in
`.htaccess` cares where the directory is, only that it *is* the subdomain's
document root.

What nesting it does cost you is a **second URL for the same tree**: the
parent domain serves `public_html`, so `https://THE-PARENT-DOMAIN/tours/`
reaches the same files. That second URL is a subpath, so it is the broken case
in the bullet above — `%{DOCUMENT_ROOT}` is `public_html` there, the bundle
rule misses, and the frontend's leading-slash API calls go to the parent
domain's root. The password is not the problem (Directory Privacy protects the
*directory*, so it applies by either route), but confusion is: check which URL
does what, and give the historians only the subdomain. **Unverified**, like
everything else here about this host's Apache configuration.

### 4b. The virtualenv, created once, by hand

The deploy installs into this virtualenv but **never creates it**, and
`rsync` excludes it so a deploy cannot overwrite it. Over SSH, with
`DEPLOY_PATH` set to the directory from 4a:

```sh
DEPLOY_PATH=/home/USER/tours-staging      # the staging one first
mkdir -p "$DEPLOY_PATH"
python3.12 -m venv "$DEPLOY_PATH/.venv"
"$DEPLOY_PATH/.venv/bin/python" --version
```

`.venv`, directly inside the deploy directory, is the other half of the
contract above. `app.cgi` is a shell wrapper, and this is the whole of what it
does:

```sh
DIR=$(dirname "$0")
PYTHONPATH="$DIR/backend" exec "$DIR/.venv/bin/python" -P -m app.cgi
```

so the venv is found relative to the script, with no absolute path to guess
and nothing for cPanel to tell us. (`-P` keeps the document root off
`sys.path`, so a stray file dropped beside `app.cgi` cannot shadow a module.)

**You should see:** `Python 3.12.15` from the last line — the version measured
on this host in step 3. Anything else means `python3.12` on the account is not
what it was, and the floor in `backend/pyproject.toml` and the pin in
`deploy.yml` would both have to move with it (a decision for the author, not a
fix to make in passing).

**Paste back:** the `--version` output if it is not 3.12.x, and the whole
error if `python3.12 -m venv` fails. If the venv is missing or has no
interpreter when the deploy runs, the *Install dependencies* step stops with
"No interpreter at …/.venv/bin/python" and installs nothing, rather than doing
something improvised.

## 5. Configure GitHub

**Do this, and know that it is not the path that ships today.** The pipeline
cannot reach the host. Its *Check the host is reachable* step says so in as
many words — `Cannot open TCP 22 to DEPLOY_HOST from this runner` — because
the host's firewall permits your own address and drops GitHub's hosted-runner
addresses **at the TCP level**: the connection never gets as far as
authentication, so there is nothing here to fix with a key or a secret. The same
key, the same user and the same `DEPLOY_HOST` connect from your Mac. Shipping
therefore happens from your own machine, which is **step 5b** — do that step if
all you want is a deploy.

Configure GitHub anyway. `deploy.yml` is kept intact and manual-only, so the day
Reclaim allowlists a few addresses (asking them is the one thing that would
bring the pipeline back; see
[ADR 0008](decisions/0008-ship-from-a-workstation.md)) a deploy is one button
away rather than an afternoon's archaeology. These secrets are also the
reference for step 5b's table, which carries the same values under the same
names.

Repository *Settings*, *Secrets and variables*, *Actions*. The two tabs matter.

**Secrets** (the *Secrets* tab):

| Name | What it is |
| --- | --- |
| `SSH_PRIVATE_KEY` | A private key made for this and nothing else, authorised on the host. **Generate it on your own machine, not on the host** — a private key whose copy lives on the box it unlocks protects nothing, and getting it off again means putting it through a browser and a clipboard. **And it must have no passphrase**: the workflow sets `BatchMode yes`, so ssh cannot prompt and simply fails. cPanel refuses to *generate* a passphraseless key, which is a further reason not to let it: it never needs your private half. So `ssh-keygen -t ed25519 -f ~/.ssh/clio_deploy -N ""`, paste `~/.ssh/clio_deploy.pub` into cPanel under *SSH Access*, *Import Key* (leaving the private-key box empty), then *Manage*, *Authorize* — importing alone does nothing — and paste the whole private file here, `BEGIN` line through `END` line. Nothing about this needs working SSH, which is what makes it the way to bootstrap one. |
| `DEPLOY_HOST` | The SSH endpoint of the **server**, not the subdomain the app serves at. Find it with `hostname -f` in the cPanel terminal, or in cPanel's *Server Information* sidebar, or in your Reclaim welcome email; confirm it with `ssh -p PORT USER@CANDIDATE 'hostname -f; pwd'`, which should land in `/home/USER`. Your own domain usually resolves to the same server and is still the worse choice: it is a DNS alias, so putting a proxy in front of it or moving the DNS later breaks SSH and invalidates the pinned host key, in a deploy that has nothing to do with DNS. Use the same string for `ssh-keyscan` below — the pin is for this literal text. |
| `DEPLOY_USER` | Your cPanel username. |
| `DEPLOY_PATH` | The absolute path of the production deploy directory, which is the production subdomain's document root from step 4, e.g. `/home/USER/tours`. **Set it even if you only mean to rehearse**: the first workflow step refuses to run with any of these empty. A rehearsal does not use it — a manual run's `target` input replaces it for that run, exactly as `deploy/deploy.sh --target` does from your own machine (step 5b). |
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

## 5b. Configure your own machine

This is the path that works. One file, outside git, holding the same values the
secrets above hold:

```sh
cp deploy/deploy.env.example deploy/deploy.env && chmod 600 deploy/deploy.env
```

Then fill it in. **The `600` is not advice.** The file holds
`MAPILLARY_TOKEN`, and `deploy/deploy.sh` refuses to run while anything but its
owner can read it — it reads the mode itself, with `stat -f %Lp` on macOS or
`stat -c %a` on Linux, and refuses if it cannot read it at all rather than
assuming the best. `deploy/deploy.env` is gitignored;
`deploy/deploy.env.example` is the committed copy and carries a shorter version
of this table beside each variable.

| Name | Required | What it is |
| --- | --- | --- |
| `DEPLOY_HOST` | yes | The same string as the secret of that name: the SSH endpoint of the **server**, not the subdomain the app serves at and not your Cloudflare-proxied domain, which forwards HTTP and drops port 22. Confirm it the way the secret's row says, with `ssh USER@CANDIDATE 'hostname -f; pwd'` landing you in `/home/USER`. |
| `DEPLOY_USER` | yes | Your cPanel username. |
| `DEPLOY_PATH` | yes | The absolute path of the **production** deploy directory, which is the production subdomain's document root from step 4, e.g. `/home/USER/tours`. No trailing slash. A rehearsal does not use it — `--target` replaces it for that run — but it is required all the same, because a config file that is only complete enough for a rehearsal is a trap for the day you stop rehearsing. |
| `MAPILLARY_TOKEN` | yes | Written into `backend/.env` on the host, **and only when that file does not already exist** (see *Settings*, below). Rotating it here does not update the host. |
| `SSH_KEY` | no | The private half of the deploy key, as a path on this machine rather than a secret pasted into a settings page. Default `$HOME/.ssh/clio_deploy`, which is where the secrets table's `ssh-keygen` puts it. It must have **no passphrase**: the deploy sets `BatchMode=yes`, so nothing in it can answer a prompt. |
| `DEPLOY_PORT` | no | The SSH port. Defaults to 22, which is still unconfirmed for this hosting plan (step 3). If it is not 22, set it here *and* pass `-p PORT` to the interactive `ssh` below, or the host key goes into `known_hosts` under the wrong name. |

The file is sourced as shell, so quote any value containing a space — and then
expect the deploy to refuse it by name. `rsync`'s `--rsh` option takes one
string and splits it on whitespace *itself*, so a space in `DEPLOY_HOST`,
`DEPLOY_USER`, `DEPLOY_PORT`, `SSH_KEY` or the deploy directory cannot be
quoted through it; it would change which arguments `ssh` receives rather than
failing, and an rsync that connects somewhere unintended and says nothing is
the failure this refusal exists to prevent.

`deploy/deploy.sh --config FILE` reads a different file, if you ever want a
second host or a second account side by side. There are only those two flags,
and an argument that is neither is refused rather than ignored.

### The host key: there is no `DEPLOY_HOST_KEY` here

This is the one substantive difference between the script and the pipeline, and
the one worth reading twice, because it presents as the same unhelpful message
as everything else in this area.

The pipeline pins the host's public key from the `DEPLOY_HOST_KEY` variable,
because a fresh runner has no history with the host and would otherwise trust
whatever answered at that address. **Your machine does have that history.**
`deploy/deploy.sh` sets `StrictHostKeyChecking=yes` and names no
`UserKnownHostsFile`, so the pin is the entry in your own
`~/.ssh/known_hosts` — put there by one interactive `ssh` whose fingerprint you
checked. That is a better pin than a blob re-pasted into a repository setting,
and it is why there is nothing to configure here.

So before the first deploy, connect by hand once:

```sh
ssh -i ~/.ssh/clio_deploy -o IdentitiesOnly=yes \
    USER@YOUR-HOST 'hostname -f; pwd'          # add -p PORT if it is not 22
```

**You should see** the fingerprint prompt (the first time only), then the
host's own `hostname -f` and `/home/USER`. Check the fingerprint against what
cPanel's *SSH Access* page shows, or against the host's own console, before you
type `yes` — that one `yes` is the whole of the trust decision the pipeline
spends a repository variable on. `IdentitiesOnly=yes` matters if you have other
keys loaded: without it ssh offers them all and the host may refuse the
connection before reaching this one.

Two consequences, both wanted:

- **A host key that changes stops the deploy.** `ssh` refuses, the script exits
  non-zero, and nothing is shipped. Reclaim rebuilding or migrating the server
  is the innocent explanation and someone answering in its place is the other
  one; find out which before you touch `known_hosts`.
- **`Host key verification failed` from `deploy/deploy.sh` means there is no
  entry yet** — not that anything is wrong with the host. It is the command
  above that fixes it, and nothing else: do not add
  `StrictHostKeyChecking=accept-new` to the script, which would trade the pin
  for a convenience on the one connection that carries the source and the
  token.

## 6. Rehearse: deploy to a staging path first

A first deploy does not work first try, and a deploy that destroys a
historian's tour is a failure condition, so rehearse. From the repository root
on your own machine:

```sh
deploy/deploy.sh --target /home/USER/tours-staging
```

That is the staging directory from step 4 — the one with its own subdomain and
its own `.venv` — and *not* the production `DEPLOY_PATH`. `--target` is also
what relaxes the two production gates: with no `--target` the script refuses to
run from any branch but `main`, and refuses a working tree with uncommitted
changes, because `rsync` ships the tree rather than the commit and a deploy you
cannot name in the history is one you cannot reason about later. Rehearsing a
branch, mid-change, against a directory nobody uses is the whole point of the
flag, so it relaxes both.

**Do step 2 first if you have not.** `deploy/deploy.sh` delegates the lint, the
tests and the build to `make check`, which goes through a bare `uv run`; with
`uv.lock` still stale that either fails (no network) or re-resolves and rewrites
the lockfile (network). The rewrite is the one to watch: the clean-tree gate
runs *before* `make check`, so the deploy you are running now is unaffected,
and the **next** production deploy refuses because `uv.lock` is modified. The
fix is step 2's `uv lock`, committed, not a `--target` to get past it.

**Read step 7 before you press anything.** This deploy copies `.htaccess` to
the staging directory, so it is the deploy that installs the front controller,
and an `.htaccess` the host will not accept returns 500 for every URL in that
directory and below. Step 7 says what that looks like and gives you the one
command that undoes it; have

```sh
ssh HOST 'cd /home/USER/tours-staging && mv .htaccess .htaccess.broken'
```

in a second terminal before you start. Deploying to *staging* first is exactly
so that the file is proven somewhere harmless.

**You should see**, in order, and nothing before the first one:

1. `make check`'s four stages — `ruff` clean, the backend suite's `N passed`,
   the frontend suite under `ng test`, then `ng build`. **Everything that leaves
   this machine happens after this**, so a failing test stops the deploy
   instead of being noticed with half a tree shipped.
2. a line or two from `uv export`, which resolves
   `backend/requirements.txt` for the host's `pip` from `uv.lock`. That file is
   **gitignored**: it is a build artefact, rewritten on every run, and an
   untracked file left in the tree would make the script's own clean-tree gate
   refuse every deploy after the first. Do not "fix" the gitignore.
3. nothing from the `mkdir -p` that makes the directories on the host.
4. `rsync --itemize-changes` lines, in this order: `.htaccess` (staged as
   `.htaccess.new`), `deploy/merge-htaccess.sh`, then — silently, because
   `deploy/merge-htaccess.sh` speaks only when it refuses — the merge of the
   two on the host, then `app.cgi`, then `backend/`, then the built frontend,
   then `content/`. **The front controller is first on purpose** and that order
   is pinned by a test: until `.htaccess` is in place the document root is
   uncontained, and the `.env` write below would publish `MAPILLARY_TOKEN` by
   URL.
5. one line from the `.env` step: `backend/.env did not exist: created it.` on
   a first deploy, or `backend/.env already exists on the host: left alone
   (token and other settings NOT updated).` on every one after. The token goes
   over `ssh`'s stdin, so it is in no argument list, no process listing and no
   shell history.
6. `pip install`'s output, into `/home/USER/tours-staging/.venv`.
7. `deploy.sh: shipped to USER@HOST:/home/USER/tours-staging` — and that is the
   last line. There is no restart step and there is nothing missing: Apache
   starts a process per request, so the files being in place *is* the
   deployment.

**Stop and paste back** whatever it printed. The likely failures, in the order
the script reaches them:

- **`deploy.sh refuses: …`**, one line per problem, with nothing shipped — the
  refusals all run before the first remote command, so a refusal has never done
  anything. They are: no config file at that path; a required variable empty or
  absent, named; the config file readable by group or world (`chmod 600` it),
  or a `stat` that would not say which; a value containing whitespace, named;
  not on `main`; and a dirty working tree, with `git status --porcelain`'s
  output quoted so you can see what it means. The last two are the ones
  `--target` relaxes. More than one is reported at once, deliberately: fixing
  one, re-running the whole `make check` and only then being told about the
  second is the kind of gate that gets worked around.
- **`make check` red.** Not a deploy problem. The one deploy-flavoured case is
  a `uv` resolution failure now that the floor is 3.12 (step 2), which is where
  a dependency needing 3.13 would first show.
- **`Host key verification failed`** — `~/.ssh/known_hosts` has no entry for
  `DEPLOY_HOST`. One interactive `ssh` to it fixes it; step 5b has the command
  and says what to check before accepting.
- **`Permission denied (publickey)`** — the key is not authorised on the host,
  or `SSH_KEY` points at the wrong file. Note that *importing* a key in cPanel
  does nothing: *Manage*, *Authorize* is the second half (step 5).
- **A connection timeout** — the wrong `DEPLOY_PORT`, or `DEPLOY_HOST` is your
  proxied domain rather than the server (step 5's `DEPLOY_HOST` row). From your
  own machine this should not be the firewall: the firewall is what stops
  GitHub's runners, and your address is the one it permits.
- **`merge-htaccess.sh: …` and the deploy stops.** It refuses, and changes
  nothing, if the staged copy did not arrive or is empty, or if it cannot read
  the host's live `.htaccess` — because overwriting a file it could not read
  might silently remove step 8's shared password. The deploy failing here is
  the intended outcome; `.htaccess.new` is left on the host and is not served.
- **`No interpreter at …/.venv/bin/python`** — step 4b was not done for *this*
  target, or was done in a different directory. The deploy installs into the
  virtualenv and never creates it.
- **A `pip` build error.** Paste the whole thing, because nothing about what
  `pip install -r requirements.txt` needs on this host is verified beyond
  `fastapi` and `a2wsgi` installing (step 3). The surface is as small as it can
  be made: `requirements.txt` is exported `--no-dev`, and
  `uvicorn[standard]` — which nothing under `backend/app/` imports, and which
  only `make serve` ever runs — **was moved out of the runtime dependencies
  into the `dev` group** for exactly this reason. It used to ship, so every
  deploy asked the host's pip 23.2.1 to resolve and build uvicorn, uvloop,
  httptools, watchfiles, websockets and PyYAML for code the CGI path never
  loads; any one of those missing a cp312 wheel on CloudLinux is a source
  build, and a source build failing there stopped the whole deploy. What the
  host installs now is what `app/` actually imports.

A remote command that fails stops everything after it. The script runs under
`set -e` and its tests pin that: the first failing `ssh` or `rsync` is the last
thing in the log. So a deploy that stopped half-way shipped a prefix of that
ordered list and no more, which is why the front controller is at the front of
it.

Then check on the host, over SSH, that the two files Apache reads arrived with
the modes it needs:

```sh
ls -l /home/USER/tours-staging/app.cgi /home/USER/tours-staging/.htaccess
head -n 3 /home/USER/tours-staging/app.cgi
```

**You should see** `-rwxr-xr-x` on `app.cgi` and `-rw-r--r--` on `.htaccess`,
and these three lines:

```sh
#!/bin/sh
# Apache's CGI entry point: the only file the web server executes.
#
```

The modes are the thing to look at twice. `rsync -rlt` carries no permissions
at all, so the deploy sets them with `--chmod=F755` and `--chmod=F644` and
re-asserts both with an explicit `chmod` on the host at the end of every
deploy — belt and braces, because `--chmod` only applies to files rsync
*creates*, so a file already on the host with the wrong mode would otherwise
never be repaired. Either one costs you the whole tree: an `app.cgi` Apache
cannot execute, and an `.htaccess` it cannot read, are both 500 on every URL.
**Paste back** the `ls -l` lines if the modes differ.

If `head` shows something other than those three lines — cPanel's own
placeholder, or nothing — `rsync` did not land the file: paste back what it
shows.

At this point the application is installed and `.htaccess` has been copied, so
the site may already be serving. What you have not established is whether
Apache *accepted* that file, and curling now would not tell you: step 7 is the
proof, and reads the same whether the front controller is already working or
not.

## 7. Install the front controller, carefully

> **A bad `.htaccess` is not a broken route. It is 500 on every URL in that
> directory and everything below it** — the editor, the viewer, the API, the
> bundle, the lot — because Apache rejects the file as a whole rather than the
> line it objects to. **This has already happened on this host**
> ([`tests/round1/test4.png`](tests/round1/test4.png): a `ProxyPass` line,
> which is how we know `mod_proxy` is not permitted). Keep the undo on screen
> before you look at anything else:
>
> ```sh
> ssh HOST 'rm -f /home/USER/tours-staging/.htaccess'
> ```
>
> That command takes the tree straight back to however the host served the
> directory before, with no deploy and no cPanel. Renaming the file does the
> same thing and keeps it to read.
>
> **Know what that undo costs, because it is not free.** "However the host
> served the directory before" means: with no `.htaccess` there is no deny and
> no rewrite, so the whole deploy tree is **statically browsable** — including
> `backend/.env` with `MAPILLARY_TOKEN` in it, `backend/app/*.py`, `content/`,
> `.venv/`, and `app.cgi` as text. That is precisely the condition check 6
> below tells you to treat as a disclosure, and it is why the deploy workflow
> copies the front controller *before* it writes the token. So: **if the tree
> was reachable from outside for any length of time, treat the token as
> disclosed — rotate it in Mapillary and re-write the host's `backend/.env` by
> hand**, exactly as check 6 says. (The application itself is *not* reachable
> while the file is gone — no rewrite, so no `/api` — so what is exposed is the
> source tree and the token, not anyone's tour.) This is the reason to prefer
> `mv .htaccess .htaccess.broken` and move it straight back: a rename you undo
> within the minute keeps both the containment and step 8's Directory Privacy
> password, where `rm -f` needs a redeploy (step 6) to restore either.

**The blast radius, precisely, because the difference matters.** This
`.htaccess` sits at the subdomain's document root, so what it can break is
**that document root and the tree below it**: the staging subdomain, or the
production one. It cannot reach the parent domain, other subdomains, or
anything else on the account. The incident in `tests/round1/test4.png` *did*
take the live site down, and that was an `.htaccess` at the **site** root — a
different file, in a different directory, with the whole account below it.
That stays true even if 4a made you nest the deploy directory inside
`public_html`: this file is still only read for its own directory and below,
so it reaches the deploy tree and not the site. Do not
conflate the two, and do not relax about this one either: for the historians,
"every URL of the editor returns 500" and "the site is down" are the same
event.

**What has and has not been proved.** The bridge itself is covered by
`backend/tests/test_cgi.py`, which runs *here*, in development, on every
`make backend-test`: `a2wsgi` is installed in the development environment now
(`f708161`), so the ASGI→WSGI→CGI path, `cgi_environ`'s handling of
`REQUEST_URI`, a request body, a historian's own media, and a crash before the
headers are all exercised locally. The rule *order* in `.htaccess` is covered
by `backend/tests/test_htaccess.py`, which reads the file as text. **What
neither can prove is that Apache does any of it**, because there is no Apache
in the development environment. The `curl` checks below are the only evidence
that the rewrites work; the whole front controller rests on them.

Run them from your own machine, before Directory Privacy (step 8), so no
credentials are needed. **In this order**, because each one narrows what a
failure can be:

```sh
# 1. CGI runs at all: Apache executed app.cgi and the app answered.
curl -s https://STAGING/api/health                       # {"status":"ok"}

# 2. A real route, not just the one that cannot fail. Proves the whole
#    application imported, settings loaded, and content/ arrived.
curl -s https://STAGING/api/session/examples             # {"examples":[{"id":"fairfax-old-town",...

# 3. Apache serves the bundle: rule 3's index.html fallback.
curl -s https://STAGING/ | head -c 200                   # <!doctype html> ... <title>Old Town Fairfax

# 4. A hashed asset by its PUBLIC path, which is rule 2 doing its job: the
#    file is at frontend/dist/frontend/browser/main-XXXX.js on disk and must
#    answer at /main-XXXX.js. Take the real name from the page you just got.
ASSET=$(curl -s https://STAGING/ | grep -o 'main-[A-Za-z0-9_-]*\.js' | head -n 1)
echo "$ASSET"                                            # e.g. main-FLFWCRQ3.js
curl -s -o /dev/null -w "%{http_code} %{content_type}\n" "https://STAGING/$ASSET"
                                                         # 200 text/javascript

# 5. A deep link: any other path is the single-page app, not a 404.
curl -s -o /dev/null -w "%{http_code}\n" https://STAGING/some/deep/link   # 200

# 6. The token is not on the web. This one you read with your eyes.
curl -s https://STAGING/backend/.env                     # must NOT contain MAPILLARY_TOKEN
```

What each failure means:

- **Check 1 answers `404`** (a FastAPI `{"detail":"Not Found"}`): the
  application ran and did not recognise the path. This is the
  `SCRIPT_NAME`/`PATH_INFO` mistake. (The 2026-11-09 design named it in §6.1
  but reasoned about it wrongly, which ADR 0007 decision 4 corrects: clearing
  `SCRIPT_NAME` is not what prevents the 404s, since Starlette strips
  `root_path` before matching routes. It is cleared so that URLs the
  application *generates* do not acquire an `/app.cgi` prefix.) The front
  controller rewrites every dynamic URL to one script, so Apache sets
  `SCRIPT_NAME=/app.cgi` and leaves `PATH_INFO` empty; `app/cgi.py` takes the
  path from `REQUEST_URI` instead and clears `SCRIPT_NAME`. If this 404s,
  something put the path back: a `PATH_INFO` appended to the rewrite target in
  `.htaccess` (the rule deliberately has none), or a well-meant "restore" of
  `SCRIPT_NAME` in `cgi_environ`.
- **Check 1 answers `500` with the body `The editor could not start.`**: the
  script ran, the application raised, and `main`'s fallback caught it. The
  traceback is in the host's error log and nowhere else — see *Reading the
  error log* below. The usual causes are a dependency missing from the venv
  and a bad value in `backend/.env`.
- **Check 1 answers a `500` page you did not write**, or the log says
  "Premature end of script headers": Apache could not execute the script, so
  no Python ran. Check `ls -l app.cgi` for the `x` (step 6), and whether the
  host permits `Options +ExecCGI` in `.htaccess` at all.
- **Every check 500s, including 3 and 5**: Apache is rejecting `.htaccess`
  itself. Undo it with the command above and the tree returns; then put the
  directives back a few lines at a time. The first suspects are `Options
  +ExecCGI` and `AddHandler`, which need `AllowOverride Options`. If that is
  it, **ask the host to permit it rather than dropping the line**: without
  ExecCGI and the handler, `app.cgi` is served to the browser as *text*, which
  publishes the one file that names the venv.
- **Check 3 or 5 returns `403`, a `404`, or a directory listing**: the
  document root is not the deploy directory (step 4a), so Apache is not
  reading this `.htaccess` for these URLs at all. If instead they return a
  `200` whose body is `index.html` but check 4 is a 404, the `.htaccess` *is*
  being read and it is `%{DOCUMENT_ROOT}` that points elsewhere — same cause,
  one level out.
- **Check 4 is `404`**: the frontend build did not arrive, or arrived
  elsewhere. `ls` the host's `frontend/dist/frontend/browser/`.
- **Check 6 shows the token**: stop, and treat the token as disclosed —
  rotate it in Mapillary and re-write the host's `backend/.env` by hand. Two
  independent things in `.htaccess` are supposed to prevent this (a
  `<Files ".env">` deny, and rule 3 being unconditional), so if the token is
  readable, neither is in force and the rest of the tree — `backend/`,
  `content/`, `.venv/` — is readable too.

`403` is the expected answer to check 6. A page of HTML is also acceptable
(rule 3 swallowed the path into `index.html`); the only unacceptable answer is
the file.

**If you want to separate "the venv is wrong" from "Apache is wrong"**, the
test suite runs on the host. The deploy ships the tests with `backend/` but
not `pytest`, which is a dev dependency:

```sh
/home/USER/tours-staging/.venv/bin/pip install pytest
cd /home/USER/tours-staging/backend
../.venv/bin/python -m pytest tests/test_cgi.py -q
```

**You should see** the same `22 passed` it gives here. A failure or an import
error there is the venv or the interpreter, and Apache is not involved; a pass
there with check 1 still failing puts it squarely in `.htaccess` or in the
host's CGI configuration. Two caveats: `pytest` is now installed in the venv
that serves the site, which is harmless but is a reason to do this on staging;
and `Settings` reads the host's `backend/.env`, so a difference from the local
run can be a value in that file rather than anything about the host.

**Paste back:** the output of every check that differs, and — for a 500 —
whatever the error log holds.

Now go back to step 1 and run the egress diagnostic against staging.

## 8. Directory Privacy, for the shared password

cPanel, *Files*, *Directory Privacy*. Choose the subdomain's **document root**,
which is the deploy directory itself (step 4a), turn on password protection,
and create one username and one password. Give those to the historians.

The risk this step exists to close is strangers reaching the editor, spending
the Mapillary quota and filling the disk. Whether Directory Privacy covers a
request Apache hands to **CGI**, rather than a file it serves itself, **has
not been verified** on this host. The mechanism has changed since this check
was written — it is `app.cgi` now, not a Passenger worker — and that does not
make the question any less open: Directory Privacy is `AuthType Basic` in an
`.htaccess`, and authorization runs before the rewrite, so it *should* apply
to both. "Should" is not a measurement. So check, from a machine with no
credentials:

```sh
curl -s -o /dev/null -w "%{http_code}\n" https://STAGING-HOST/
curl -s -o /dev/null -w "%{http_code}\n" https://STAGING-HOST/api/session
curl -s -o /dev/null -w "%{http_code}\n" -u USER:PASSWORD https://STAGING-HOST/api/session
```

**You should see:** `401`, `401`, `200`. If the second line is `200`, the
password protects the page but not the API, and the shared password is
decoration: stop and report. (Note that `GET /api/session` creates a directory
for the visitor; that is another reason this check matters.)

**Then read the file, because this step may have edited the front
controller.** cPanel's Directory Privacy normally works by writing
`AuthType Basic`, `AuthName`, `AuthUserFile` and `Require valid-user` into the
`.htaccess` of the directory you selected — and that is *this* `.htaccess`.
Whether it does that on *this* host is still unverified, and cheap to check:

```sh
ssh HOST 'grep -n -i "auth\|require" /home/USER/tours-staging/.htaccess'
```

**You should see** the four directives. *Where* in the file cPanel puts them
has not been observed on this host, so do not expect a particular position —
it does not matter, and the deploy moves them to the end anyway. (Two other
lines match and are not the password: the `Require all denied` inside the
repository's `<Files ".env">` block, and a comment above it that names the
directive. The four `Auth*`/`Require valid-user` lines are the ones to look
for.) If the `grep` finds them, the rest of this step applies. If it finds no
`Auth*` lines at all, cPanel keeps the password somewhere outside this file on
this host — **report that**, because the deploy is built around the other case
and nothing below applies.

1. **The deploy preserves it, and here is how to confirm.** The workflow no
   longer `rsync`s the repository's `.htaccess` over the host's. It stages the
   repository's copy as `.htaccess.new` and runs `deploy/merge-htaccess.sh` on
   the host, which rewrites `.htaccess` as the staged copy followed by
   whatever auth directives the live file carried, atomically, and removes the
   staged copy. It re-reads the live file on *every* deploy, so a password set
   between two deploys is picked up and running it twice does not stack the
   block up. If it cannot read either file it exits non-zero and changes
   nothing, which fails the deploy on purpose: a deploy that reported success
   while removing the password is the defect this replaced. The behaviour is
   pinned by `backend/tests/test_merge_htaccess.py`.

   So this is a check to run **once**, after the first deploy that follows
   this step — not after every deploy, which is what this runbook used to ask
   for:

   ```sh
   ssh HOST 'grep -n -i "auth\|require" /home/USER/tours-staging/.htaccess'
   curl -s -o /dev/null -w "%{http_code}\n" https://STAGING-HOST/
   curl -s -o /dev/null -w "%{http_code}\n" https://STAGING-HOST/api/session
   ```

   **You should see** the four directives still there — now under a comment
   block beginning `NOT FROM THE REPOSITORY`, which the deploy writes above
   them — and `401`, `401`. A `200` on either `curl` is an incident: the
   shared password is gone and the editor is open to the internet. **Paste
   back** the `grep` output either way.

   **Only the auth directives are preserved.** If you later add anything else
   through cPanel that writes to this `.htaccess` — hotlink protection, an IP
   deny, a redirect, a PHP handler line — the next deploy removes it, as
   silently as the password used to go. Put such a rule in the repository's
   `.htaccess` instead, where it is reviewed; the header of
   `deploy/merge-htaccess.sh` says why appending the rest cannot be made to
   work here.
2. **It is one more edit to the file step 7 warns about.** If the whole
   subdomain starts returning 500 right after you turn Directory Privacy on,
   that is the cause, and step 7's undo command applies — with the cost that
   removing the file removes the password too.

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

Production is a second pass through steps 4, 7, 8 and 9 against the production
subdomain, not just a merge. In particular: the production directory needs its
own `.venv` (step 4b) before the first deploy, or *Install dependencies* stops;
and the front controller's `curl` checks (step 7) are worth repeating there,
because the two subdomains could differ in what Apache permits.

Merge to `main`, check out `main` with a clean tree, and run
`deploy/deploy.sh` with **no** `--target`: that is what deploys to
`DEPLOY_PATH`, and the two gates it stops relaxing are exactly the ones that
make a production deploy nameable afterwards. Nothing happens on the push
itself (step 5). Once it has printed `shipped to`:

1. `https://HOST/api/health` answers `{"status":"ok"}`, and the six checks in
   step 7 pass against production.
2. Run step 1 again against production.
3. The three Directory Privacy checks in step 8 still give `401`, `401`,
   `200`. This is not a formality: the deploy you just ran rewrote
   `.htaccess`, which may be where the password lives — it is meant to carry
   the password across, and production is the first place that has ever been
   true of.
4. In a browser, sign in with the shared password and open `https://HOST/`. **You
   should see** the welcome screen, with *Old Town Fairfax* under "Open an
   example". Open it. You should land in the editor with six stops, and a
   *Recovery key* with a *Copy* button in the top bar.
5. In a second, different browser (or a private window), open the same URL. It
   must show the welcome screen, not the first browser's tour. That is the
   whole point of the session code, and it is the check that matters most.
6. In the first browser, select a stop and click *Record audio*. The browser should ask for the microphone. (This has never run in a
   real browser: `UNVERIFIED.md` entries 7 to 9.)
7. Search for panoramas on a stop. (Whether the browser may read Mapillary's
   answer is the largest open risk: `UNVERIFIED.md` entry 32.)
8. Open the editor with the Network tab recording and watch what a save and a
   media fetch cost. Every request under `/api` and `/tour-data` starts a
   Python process, measured at **0.35–0.46 s** on this host (step 3); the
   JavaScript and CSS should show no such delay, because Apache answers those
   itself. If the static files *are* slow too, the front controller is not in
   force and step 7's checks were passing for some other reason.

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
| `CONTENT_DIR` | derived from where `backend/` sits | Where the examples are read from. The deploy mirrors the repository's layout, so the default is right; do not set it without a reason. |
| `FRONTEND_DIST` | derived from where `backend/` sits | Where the built frontend is. **Do not set this on the host** — and if you set it anyway, make sure it still names the real bundle, because **this setting is read on the host**. `GET /api/session/publish` passes it to `build_site` (`backend/app/main.py:798`), which refuses with `no built application at <dist>: run make build first` (`backend/app/publish.py:28-31`) and becomes a **409**. So the symptom of a wrong value is **Publish failing for every historian** — the end product the whole tool exists to produce — while `/` and every deep link keep working perfectly, because `.htaccess` finds the bundle at the literal `%{DOCUMENT_ROOT}/frontend/dist/frontend/browser/` and does **not** read this setting. Debug a 409 on Publish here, not in `.htaccess`. The two paths can therefore disagree and nothing tests them agreeing, so if the bundle must move, move it in **both** places: the rewrite target in `.htaccess` (carefully, and see step 7) *and* `FRONTEND_DIST`. (`_mount_frontend` is registered on the host too — the directory really is there — but Apache answers for static files first, so it is never reached *for the bundle*. It is still load-bearing: `_SpaFiles`'s `api/` guard is what makes an unmatched `/api/foo` a 404 instead of a 200 serving `index.html`. Do not delete the mount as dead code.) |

The caps are positive-only, so a typo is an error at startup, not a server that
refuses every upload. `Settings` ignores keys it does not know, so **a
misspelled key is silently ignored**: after changing one, check it took by
trying the behaviour. There is nothing to restart first — the next request
reads the new `.env`, because the next request is a new process.

**`backend/.env` is host-owned state.** The deploy creates it once, from the
`MAPILLARY_TOKEN` secret, and never overwrites it: the *Write backend/.env (only
if absent)* step logs either "created it" or "left alone". So to set
`SESSIONS_DIR`, lower a cap, or change the retention windows, **edit
`backend/.env` on the host**. It takes effect on the next request, because the
next request is a new process; there is nothing to restart. Your edit survives
every later deploy. The trade: **a rotated Mapillary token does not
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

One file in the sessions directory is not a session at all. **`.last-sweep`**
is the sweep's throttle: an empty file whose modification time is when the
sweep last ran (see below). Leave it alone. Deleting it makes the next mint
sweep, which is harmless; a `tar -x` without `-m` that restores an old one is
also harmless, for the same reason.

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

It runs at most **once an hour**, and only when a request needs to *mint* a
new session (the first visit by a new browser, or a creating route with no
cookie). It is not a timer: with no new visitors it does not run.

**The hour is kept in a file, not in memory.** `.last-sweep`, in
`SESSIONS_DIR`, and the timestamp is the file's mtime — there is nothing in it
to parse and nothing to corrupt. This is forced by CGI: every request is a
fresh process, so a timestamp in `app.state` would be unset every time and
would throttle nothing, meaning a full walk of every session directory on
every cookieless mint. Two consequences for you:

- **The hour holds across processes and across deploys.** Nothing resets it: a
  deploy copies files and starts no process, and there is no restart to press.
  If you want a sweep now, delete `.last-sweep` and visit the site in a
  browser with no cookie.
- **A stamp that cannot be written means the sweep is skipped, not
  repeated.** The stamp is written *before* the walk, so a sweep that fails is
  not retried on the very next request, and a `SESSIONS_DIR` that has gone
  read-only costs one refused write per mint rather than a full walk per mint.
  Both halves fail towards sweeping *less*, which is the only safe direction
  near a historian's in-progress tour. The cost is that a sessions directory
  the application cannot write to is never swept at all, silently, so if the
  disk is filling, check that `.last-sweep`'s mtime is moving.

It never raises into a request; failures are logged as the exception's type
only, never with a recovery key.

## Reading the error log

When the page is a 500, a blank page, or "Premature end of script headers",
the answer is in the web server's error log. Under CGI there is no application
log of its own and no `stderr.log` beside the app: whatever the process writes
to stderr, Apache puts in *its* error log, and that is the only copy.
**Where this host puts that log is unverified.** Look, in this order:

1. **cPanel, *Metrics*, *Errors*.** The recent error log, in the browser, with
   no SSH needed. Start here.
2. `~/logs/`, which is where cPanel accounts usually keep the per-domain logs:

   ```sh
   ls -la ~/logs/
   tail -n 100 ~/logs/tours.example.org.error.log       # the real name is in the ls
   ```

3. The subdomain's own error log, if the host keeps it elsewhere —
   `~/access-logs/`, or a path cPanel's *Raw Access* page names.

If none of them has anything, ask Reclaim support where a subdomain's CGI
stderr goes, and paste back `ls -la ~/logs/`.

What you are looking for: a Python traceback ending in the real error. An
`ImportError` is a dependency missing from `$DEPLOY_PATH/.venv` (the deploy's
*Install dependencies* step, or a `pip install` that half-failed); a
`ValidationError` from `Settings` is a bad value in `backend/.env`; a
`PermissionError` under `SESSIONS_DIR` is the sweep stamp or a session
directory. Nothing needs restarting after you fix it — the next request is a
new process and reads the new files. If the traceback is *absent* and Apache
only says "Premature end of script headers", no Python ran at all: that is
`app.cgi`'s mode, or `Options +ExecCGI` (step 7).

**That log is as sensitive as `SESSIONS_DIR`, and should be treated the same
way.** This is not only about startup crashes. `wsgiref` writes a full
traceback to stderr for **every in-request 500** — any unhandled exception in
any route, on a request anyone can send — and a traceback carries local
variables and paths. A path under `SESSIONS_DIR` contains a `sid`, and the
`sid` **is** the historian's recovery key: a credential that opens their tour.
So the log can hold recovery keys. Concretely:

- do not paste a traceback into an email, a ticket or a chat without reading
  it first and removing any sixteen-hex-character directory name;
- the application's own logging never writes a sid (failures are logged as the
  exception's *type*), so anything that does is a traceback, which is exactly
  what to redact;
- a log file copied off the host for analysis is a secret in transit, like the
  sessions backup above.

A request that dies **part-way through its response**, with no traceback —
especially an export or publish of a large tour — is likely the host's memory
limit rather than a bug: those two responses read the whole zip into memory
(the 2026-11-06 design, §6.7), and a process killed from outside writes
nothing. The symptom
is a truncated download or a connection that closes, not the plain 500 page.
Lowering `MAX_SESSION_MEDIA_BYTES` is the first remedy.

## Known limitations, stated rather than hidden

- **No `--delete` in the deploy.** A file deleted from the repository **lingers
  on the host** until you remove it by hand. This is deliberate: a deploy that
  destroys a tour is a failure condition, and not deleting is the second defence
  behind keeping the sessions outside the tree. If a removed file matters
  (a deleted example, say), delete it over SSH.
- **The subdomain's document root must be the deploy directory**, and the
  virtualenv must be at `$DEPLOY_PATH/.venv` (step 4). Neither is a guess
  about the host — both are contracts `app.cgi` and `.htaccess` depend on —
  but whether cPanel will let you *set* that document root is unconfirmed, and
  if it will not, the deploy directory moves inside `public_html` (step 4a).
- **`Options +ExecCGI` must be permitted in `.htaccess`.** It needs
  `AllowOverride Options`, which is cPanel's usual setting but is not
  confirmed here. If the host refuses it, the right answer is to ask for it:
  without ExecCGI and the `.cgi` handler, Apache serves `app.cgi` as text and
  publishes the one file that names the venv.
- **Every dynamic request pays a process start: 0.35–0.46 s**, measured on
  this host (step 3, which says what was and was not measured). Autosave,
  session polling and each media fetch pay it.
  Browsers parallelise, so a stop with a dozen media files is closer to a
  second than to five. This is accepted for roughly six testers, and it is the
  whole reason Apache serves the bundle itself.
- **CloudLinux caps concurrent entry processes, and CGI spends one per
  request.** Keeping Python off the static path keeps the count low, but
  several historians loading media-heavy stops at the same time could brush
  the limit, and the symptom would be sporadic 500s or 508s under load rather
  than a steady failure. Worth watching; engineering around it before anyone
  has used the app would be guessing.
- **FastAPI's `/docs`, `/redoc` and `/openapi.json` are unreachable on the
  host.** The front controller routes only `/api` and `/tour-data` to the
  application, and those three are not under either, so they fall through to
  rule 3 and return the editor's `index.html`. This is the right outcome, not
  a regression: an interactive form that posts to every write route, on a
  deployment whose only access control is one shared password, is not
  something to publish for the sake of a tidy route table. They still work in
  development, at `http://localhost:8000/docs`, which is where they are
  useful.
- **The SSH port must be confirmed** (step 3). The workflow defaults to 22.
- **The Python floor is 3.12** — `requires-python = ">=3.12"`, CI pins
  `3.12`, the host measures 3.12.15 — but **that the code runs on 3.12 is
  unproven.** It was checked by reading (no syntax or stdlib newer than 3.9 is
  used) and cannot be built here. CI on 3.12 is the first proof; the host is
  the second.
- **`uv.lock` is stale** until you run `uv lock` (step 2): it still records
  `requires-python = ">=3.13"` while `pyproject.toml` says `>=3.12`. Until
  then `make backend-test` fails on a machine with no network — the tests run
  with `cd backend && uv run --no-sync pytest -q` instead — and CI re-resolves
  the whole dependency set on every run.
- **The CGI path has never run on the host, and nor has the pipeline.** The
  bridge itself is now tested in development (`backend/tests/test_cgi.py`, and
  `test_htaccess.py` for the rule order), so what is untested is specifically
  the part that needs Apache: that the rewrites fire, that CGI is permitted,
  and that the deploy's SSH half works at all. Steps 6 and 7 are where that
  changes.
- **Directory Privacy survives a deploy by being re-read, not by being
  version-controlled** (step 8). The deploy greps the host's live `.htaccess`
  for `Auth*` and for `Require valid-user`, `Require user` and `Require group`,
  and re-appends what it finds (`deploy/merge-htaccess.sh`), so the password is
  never in the repository and the host stays the source of truth. The limits of
  that:
  - **Only those directives are kept.** Anything else cPanel writes into this
    file — hotlink protection, an IP deny, a redirect, a PHP handler line — is
    still removed by a deploy, silently. Put such a rule in the repository's
    `.htaccess` instead.
  - **Containers are not preserved, only their contents.** The match is
    line-oriented, so auth directives cPanel put inside a `<Limit GET POST>`
    or a `<Files>` block are carried over *without* the block, which makes the
    protection apply more widely than it did — to every method, or to the whole
    directory. Stricter, not looser, so it is not a hole; but it is a change
    the deploy makes silently, and worth knowing if the `grep` in step 8 shows
    a container.
  - **Directives in an `Include`d file are not seen at all.** The script reads
    only the one file it is given. If that is where the password lives, the
    deploy neither keeps it nor needs to.
  - **None of it has run on the host yet,** so step 8's one-off check after the
    first deploy is the first evidence that any of it works.
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
bug to fix. The host's Apache terminates TLS and then starts the CGI process,
so the scheme the application sees can be `http` for a request the browser
made over HTTPS; deriving the flag from the request scheme would silently drop
it in production, which is where it matters. Develop in Chrome or Firefox. (`curl` on `http://localhost` stores and
sends the cookie without trouble; see `HANDOFF.md`.)
