# Hosted deployment for historian testers — design

**Date:** 2026-11-06
**Status:** awaiting approval
**Builds on:** `2026-10-25-media-and-acquisition.md`, `2026-10-26-welcome-screen.md`
**Base:** schema v3 (`docs/decisions/0005-schema-v3-locks-the-document.md`),
merged to `main` as `1c70812` before this work began. Line references below
were taken against that merge; `migration.migrate` replaced
`migrate_v1_to_v2`, and `SCHEMA_VERSION` is 3.

Historians at RRCHNM need to author tours with the editor and report back on
it. Today the application only runs from a development checkout on the
author's Mac. This design puts it behind a URL on Reclaim shared hosting,
isolates each historian's open document from the others', and makes updating
the deployed app a push to `main`.

## 1. Intent, and why hosting rather than packaging

The testers are historians on Windows laptops, not developers. The original
proposal was a Windows `.exe` built by GitHub Actions that self-updates from
GitHub Releases. That is feasible, and it was rejected for three reasons:

- **Nothing about it is easier for the historians.** With no code-signing
  certificate, first install opens with the full-screen blue "Windows
  protected your PC" box and written instructions to click through it.
  A URL has no install step at all.
- **It could only be tested on one machine.** Development is on macOS; the
  Windows artifact would be produced by CI and verified on a single Windows
  desktop. Every packaging bug costs a round trip through CI.
- **The update path is heavier.** A release pipeline, an updater, a restart
  prompt and version skew across testers, versus `git push`.

Two alternatives were also considered and rejected:

- **One hosted instance per historian** (six cPanel Python apps on six
  subdomains, each with its own `work_dir`) needs no session code at all, but
  multiplies the deploy targets, the passwords and the disk by six, and
  strains shared-hosting process limits.
- **Moving the document to the browser** (client-side sessions, backend
  reduced to four stateless proxies) is the eventual shape if the backend
  should ever go away, but it means porting roughly 1,100 lines of Python
  document machinery — `session.py`, `media_store.py`, `bundle.py`,
  `publish.py`, `examples.py`, `loose_import.py` — into TypeScript, and it
  accepts that a browser can evict a historian's in-progress tour under
  storage pressure or lose it to "clear browsing data". Deferred, not
  discarded; see §9.

## 2. Verified premises

Established by reading the code and probing the environment, not assumed.
Each is load-bearing for a decision below.

- **The application is single-session.** `main.py:141` is
  `app.state.session = Session(cfg.work_dir)` — one global session object, one
  working directory, no cookie and no per-request key. `session.py`'s own
  docstring reads "One open document, rooted at a working directory." Hosted
  as-is, every historian would share one document and the last save would win.
- **The stateful surface is most of the API.** Eleven of sixteen routes are
  `/api/session/*`. `main.py` references the session 76 times. The five
  others are `/api/health` and the four `/api/tools/*` endpoints.
- **`work_dir` is inside the deploy target.** `config.py` derives it as
  `content_dir / "work"`, i.e. `content/work` in the repo tree. A deploy that
  syncs `content/` over it destroys whatever a historian had open.
- **`/tour-data` is a wholesale static mount of `work_dir`**
  (`main.py:596-600`). Per-session directories without changing this would
  serve every historian every other historian's media.
- **Narration is macOS-only.** `/api/tools/narrate` (`main.py:510`) shells out
  to `say` and `ffmpeg` (`tools.py:61-63,381,391`). Neither exists on a Linux
  shared host, and neither exists on the testers' Windows laptops either — so
  this breaks on any route out of the author's Mac, not just this one.
- **The Python floor appears arbitrary.** `backend/pyproject.toml` declares
  `requires-python = ">=3.13"`. `app/` and `tests/` were scanned for PEP 695
  generics, `match`/`case`, `StrEnum`, `TaskGroup`, `datetime.UTC`,
  `tomllib`, `@override`, `itertools.batched`, `TypeIs`, `ReadOnly` and
  `ExceptionGroup`/`except*`: no hits. Nothing newer than 3.9 syntax is in
  use. **This is unverified by execution** — the sandbox blocked downloading
  another interpreter, and this project's standing rule is not to add a
  network allowlist. It must be confirmed in CI on the host's version.
- **Passenger runs WSGI; FastAPI is ASGI.** Reclaim shared cPanel plans
  expose CloudLinux's "Setup Python App", which is Passenger-managed and
  WSGI-only. A FastAPI app reaches it through an ASGI-to-WSGI bridge.
- **The microphone needs HTTPS.** `getUserMedia` requires a secure context.
  cPanel AutoSSL (Let's Encrypt) satisfies this; `localhost` satisfied it
  during development, which is why this never surfaced.
- **The editor deploys to its own subdomain root.** Confirmed by the author.
  This matters because `session-api.ts` and `entry-page.ts` request
  `/api/session`, `/api/session/new`, `/api/session/media` and so on with a
  leading slash, absolutely, while `index.html`'s `<base href="./">` and
  `tour-api.ts`'s relative `tour-data/...` are path-agnostic. At a subdomain
  root the frontend needs no change. Under a subdirectory every API call
  would break while the viewer kept working — a welcome screen that silently
  does nothing — and an API-base token would have to be threaded through the
  frontend and its build. Root avoids that entirely; a later move to a
  subpath is not free.
- **`docs/UNVERIFIED.md` overstates what is unseen.** It lists the editor,
  welcome screen, drop zone, close dialog and microphone recorder as never
  having run in a browser. The author has since viewed the editor and the
  welcome screen, and believes the drop zone was exercised. That file needs
  correcting as part of this work so it stops misdirecting whoever reads it
  next.
- **A Mapillary token may ship to the client.** Confirmed by the author:
  Mapillary tokens are designed for frontend use. This removes token secrecy
  as a constraint on the frontend, though §7 still keeps it off the open web.
- **`a2wsgi` does not run the ASGI lifespan.** `app.state.cfg` and
  `app.state.session` are set inside the lifespan context manager
  (`main.py:138-143`), and `main.py` reads `app.state` 26 times. Bridged onto
  WSGI, the lifespan never fires and every route raises on a missing
  attribute. §6.4 moves that initialisation.
- **`backend/uv.lock` exists; no `requirements.txt` does.** The host's
  Passenger virtualenv installs with `pip`, not `uv`, so the deploy needs an
  exported requirements file. §6.5 adds the step.
- **The acquisition tools call out to the internet server-side.**
  `tools.py:31-36` reaches `graph.mapillary.com`, `www.loc.gov`,
  `tile.loc.gov` and four Overpass mirrors through `httpx` — all four
  `/api/tools/*` routes.
- **Egress from the host is selective, not blocked.** Measured from the
  cPanel shell on 2026-11-06:
  - `graph.mapillary.com` **is unreachable.** DNS resolves to `31.13.80.8`
    (a Meta edge address) and the IPv4 SYN is silently dropped — no `RST`,
    no `Connected to`, a hang until killed. The host has no IPv6 route, so
    the `2a03:2880:...` addresses fail immediately with "Network is
    unreachable". Cause unknown and immaterial: either Reclaim's egress
    rules or Meta refusing the host's IP range. §6.9 moves panorama search
    off the host.
  - `www.loc.gov` returns **403** via `104.17.6.58`, a Cloudflare address,
    both with `curl`'s default User-Agent and with the application's own UA
    from `tools.py:29`. The connection completes, so this is a WAF refusal
    and most likely IP-range based. **Unresolved — see §7.**
  - `overpass-api.de` returns **406** with a bare UA and **502** with the
    application's. 502 is a known transient state for that mirror: the live
    content run from the author's Mac already recorded "34-42 s per query
    (and one 502)" in `tools.py:43-46`, which is why `tools.py:33-38` lists
    four. **Unresolved pending the other three mirrors — see §7.**

## 3. Goals

- A historian opens a URL in Edge on a Windows laptop, enters one shared
  password, and authors a tour with nothing installed.
- Two historians working at the same time never see or overwrite each other's
  document or media.
- A historian's in-progress tour survives every deploy, and survives losing
  the browser cookie that identified it.
- Deploying an update is pushing to `main`.
- The whole thing runs on Reclaim shared cPanel hosting.

## 4. Non-goals

- Public or anonymous access. One shared credential is enough for six testers.
- User accounts, per-person identity, or permissions.
- Offline authoring.
- Serving *published* tours. The app already publishes a backend-free static
  site, and shared hosting serves that well, but the author has deferred it.
- **Archival photograph search inside the editor.** Removed in §6.10 because
  the host is refused by loc.gov. Historians download from loc.gov themselves
  and upload. Rephotography and alignment are unaffected.
- Server-side speech synthesis, which §6 removes outright.
- Two historians editing the *same* tour at once.
- A Windows `.exe`, now or later.

## 5. Anti-goals

Any of these makes the work a failure even if it technically runs:

- A deploy that destroys or truncates a historian's in-progress tour.
- One historian able to read another's media or document, by URL or otherwise.
- Two historians silently editing the same document, as happens today.
- The editor writable by strangers, spending the Mapillary quota or filling
  the disk.
- A deployment only the author can perform or debug. Satisfying this means
  `DEPLOY.md` is complete enough that a second person *could* deploy and read
  the logs; it does not mean provisioning a second person's access now.

## 6. The design

### 6.1 Cookie-keyed sessions

`Settings` gains a `sessions_dir`, defaulting **outside** the deploy tree and
overridable by environment variable, so rsync can never touch it. Session
directories live at `sessions_dir/<sid>`.

Session resolution becomes a FastAPI dependency rather than
`app.state.session`: read an opaque random `sid` from a cookie, resolve it to
`sessions_dir/<sid>`, and construct `Session` on that path. The cookie is
`HttpOnly`, `Secure`, `SameSite=Lax`.

**Only `/api/session` and the four creating routes mint.** `entry-page.ts`
mounts the viewer eagerly, so a
first load fires `tour-data/config.json`, `tour-data/tour.json` and
`/api/session` concurrently. If every cookieless request minted, one load
would create three directories, race three `Set-Cookie` headers, and leave
the frontend's first `GET /api/session` possibly describing a session the
browser did not keep. So minting is confined to `/api/session` and to the four
routes that create a tour from nothing — `POST /api/session/new`,
`POST /api/session/examples/{id}`, `POST /api/session/import` and
`POST /api/session/import-files`. Everything else resolves or fails: a
cookieless `PUT /api/session/tour` gets the existing 409 "no tour is open",
and `/tour-data` returns 404 rather than conjuring a session. This is a
deliberate narrowing of "no cookie mints a fresh `sid`", recorded here
because it is a behaviour decision and not an implementation detail.

**Why the creating routes are included**, since an earlier draft of this
section excluded them: a route that creates a tour but cannot mint has
nowhere safe to write it. A fixed placeholder path is the collision anti-goal
restated, and an un-cookied `sid` path is worse — the tour lands in a
directory the author's browser can never reach again, which is
indistinguishable from losing their work. Refusing cookieless creation
instead would invent a status and message this design never specified, and
would break `docs/HANDOFF.md:172`, which documents
`curl -X POST localhost:8000/api/session/new` as the first call of the
supported no-browser flow. The concurrency rationale above survives intact,
because two of the three requests in that first-load burst are `/tour-data`,
which never mints, and the creating routes are user-initiated after
`/api/session` has already answered and set the cookie.

Minting on a POST is safe because `_reject_cross_site` guards all four
creating routes, so a cross-site POST is refused and this opens no path an
attacker did not already have through `GET /api/session`.

Minting therefore has to do what startup used to: `main.py:142` writes the
viewer config into the open session during the lifespan, which is where the
frontend gets its Mapillary token and tile URL. With sessions created on
demand, `write_config(_viewer_config(cfg))` moves into the mint path.

The existing `_reject_cross_site` CSRF guard stays and becomes more important,
because there is now a cookie worth forging requests against.

The `sid` must be treated as untrusted input on every use: it names a
directory, so it is validated against a strict character class and rejected if
it is not exactly one path component. `examples.py:149` already does this kind
of check for `example_id` and is the pattern to follow.

**`/tour-data` can no longer be a static mount.** It becomes a route that
resolves the session from the cookie and serves from that session's media
directory. It must keep what the current mount provides: the `nosniff` header
from `_NoSniffStaticFiles`, and Range support, which `main.py:583` records the
narration audio as needing — and which the historians' own recorded audio will
need just as much.

Abandoned session directories accumulate, so a sweep deletes any whose
contents have not been touched for a configurable number of days.

**Losing the cookie must not lose the tour.** Two mitigations, both wanted:

- The cookie carries a long `Max-Age` — a year — so it survives closing Edge,
  restarting Windows and ordinary use. A session cookie would not.
- The editor **displays the session id as a recovery key**, and typing it back
  reattaches to that session. This covers cleared browsing data, a new
  laptop, and a second browser. Anyone holding a recovery key and the shared
  password can open that tour, which is acceptable among six colleagues and
  is to be stated plainly in the historians' sheet rather than left implicit.

The recovery key interacts with the sweep: a tour whose key is written on
paper must not be deleted out from under it. The retention window is
therefore generous, and the sheet tells historians that a tour untouched for
that long is reclaimed.

### 6.2 Remove narration

Delete `/api/tools/narrate`, `NarrateRequest`, the synthesis helpers, and the
`SAY`, `VOICE`, `FFMPEG`, `SAY_TIMEOUT` and `NARRATION_CREDIT` constants from
`tools.py`. Remove the narrate action from the editor UI; in-browser
microphone recording becomes the only narration path, which is better
scholarship than a synthetic voice in any case.

`content/scripts/make_narration.py` **stays**. It runs on the author's Mac to
regenerate the committed Fairfax tour and is not part of the deployed app.
The existing synthetic-narration credit on committed content stays accurate
and keeps its labelling.

Tests that exercise the narrate endpoint are removed with it.

This ships microphone recording **unverified in a real browser**, by the
author's decision: `editor/recorder.ts` has only ever run under jsdom, and
narration is the one feature left without a fallback once `say` is gone. If
it fails on Edge the historians file a bug. The historians' sheet should
therefore name recording as the newest part of the application and say where
to report it, so a broken recorder returns as a bug report rather than as a
historian quietly giving up on narration.

### 6.3 Relax the Python floor

Lower `requires-python` to the highest version the host's "Setup Python App"
dropdown offers, and run the test suite on exactly that version in CI so the
claim in §2 is proved rather than assumed. If the suite fails on it, that
failure is a finding to bring back, not something to work around silently.

### 6.4 WSGI entry point

A `passenger_wsgi.py` at the application root wraps the ASGI app with
`a2wsgi`'s `ASGIMiddleware`, and `a2wsgi` joins the dependencies. The routes
that already use plain `def` so blocking `httpx` and subprocess calls land in
the threadpool (`main.py:455`) are unaffected by the bridge.

**Application state moves out of the lifespan.** Because the bridge never
runs the ASGI lifespan (§2), `app.state.cfg` is assigned in `create_app`'s
body instead of inside the `lifespan` context manager. The session assignment
there disappears anyway, replaced by §6.1's dependency. Whatever genuinely
needs startup and shutdown hooks — nothing in the current code does — would
have to find another home, so the lifespan can go entirely rather than linger
as something that silently does not run.

Keep `make serve` working on uvicorn for development. The bridge is how the
host runs the app, not a replacement for the local workflow.

### 6.5 Deploy pipeline

The repository is `wasianp0wer/virtual-tour-demo`, which has no `.github/`
directory — there is no CI today. It **stays private**: making it public was
only ever to let an `.exe` pull updates from GitHub Releases, and that route
is gone. A private repository also removes the forked-pull-request path to
the deploy secrets.

One GitHub Actions workflow, on push to `main` **and** on
`workflow_dispatch` with a target input:

1. Node 24 (Angular 22 rejects 25, as the Makefile records), `ng build`.
2. The host's Python version; `ruff check` and `pytest`.
3. Export `backend/uv.lock` to a requirements file and install it into the
   host's Passenger virtualenv. The host has `pip`, not `uv`, so the lock
   has to be exported rather than shipped.
4. `rsync` over SSH: `backend/`, the built `frontend/dist/frontend/browser`,
   and `content/` **excluding** `content/work`.
5. Write the host's `.env` from repository secrets, including the Mapillary
   token and the `sessions_dir` and frontend-dist paths.
6. `touch tmp/restart.txt` to restart Passenger.

The deploy target is a workflow input with the production path as its
default, so the pipeline can be rehearsed against a staging directory or
subdomain before any historian has the password. First-run deploy workflows
do not work first try, and §5 makes a tour-destroying deploy a failure
condition; rehearsing is not optional. The author needs to create that
staging target — see §7.

The rsync must never use `--delete` against the sessions directory. Keeping
`sessions_dir` outside the synced tree is the primary defence; not deleting is
the second.

Secrets required: SSH private key, host, username, deploy path, Mapillary
token.

A failing test or lint stops the deploy. Historians should never receive a
build that did not pass the suite.

### 6.6 Host-side steps are a runbook, not automation

Everything that touches the host — creating the Python app, setting the
Python version, Directory Privacy, AutoSSL, the first `rsync`, reading the
Passenger log — cannot be reached or verified from the development sandbox,
whose egress is proxied and which this project does not grant a network
allowlist. The same limit is why §2's Python-floor premise is unproven.

So the host-side work is delivered as code plus a numbered runbook in
`DEPLOY.md` with explicit stop-and-report points: each step says what the
author should see, and what to paste back if they see something else. The
implementation plan sequences these as checkpoints rather than assuming they
succeed.

### 6.7 Resource caps

`media_store.py:49-50` allows 64 MB per file and 1 GB of media per session;
`bundle.py:38` caps a bundle at 512 MB. Those were sized for one local author
with a local disk. Six concurrent sessions plus abandoned ones multiply them
against a shared-hosting quota, so the per-session media cap and the bundle
cap become settings and are lowered for the host.

`/api/session/export` and `/api/session/publish` (`main.py:527-571`) build the
zip on disk and then `out.read_bytes()` it entirely into memory. Under
CloudLinux LVE memory limits that is what kills a Passenger worker mid-export,
and the historian sees a failed download with no explanation. Streaming those
two responses is **deferred**, not dismissed: lowering the caps first is
cheaper and may make it moot. It is recorded in §10 so that a worker dying
during export is recognised rather than re-diagnosed.

### 6.8 Access control

cPanel Directory Privacy on the application's document root, with one shared
username and password given to the historians. No application code. This
keeps strangers off the disk and off the Mapillary quota.

HTTP Basic is per-browser and the session cookie is per-browser, so each
historian's laptop naturally gets its own session.

### 6.9 Panorama search moves into the browser

Mapillary is unreachable from the host (§2), so `/api/tools/panoramas`
cannot work there. It moves into the frontend as a direct `fetch` to
`graph.mapillary.com`.

This is the easy direction rather than a compromise, for three reasons:

- The frontend **already holds the token**. `_viewer_config` hands it over as
  `mapillaryToken`, and the author has confirmed Mapillary tokens are
  designed to ship to clients.
- `mapillary-js` **already calls Mapillary from the browser** to render every
  panorama, so reachability from a historian's laptop is proven by the
  application working at all. No CORS gamble.
- **No media bytes are involved.** `find_panoramas` (`tools.py:161-199`)
  returns metadata only — image ids, camera coordinates, compass angles,
  thumbnail URLs — and `selectPanorama` in `document-ops.ts` sets
  `cachedMediaId: null` when the editor selects a panorama (schema v3's
  rename of v2's `cachedPath`; see ADR 0005). The only populated
  `cachedMediaId` comes from the
  offline `fetch_media.py` pipeline. So nothing touches the media store and
  the session machinery is untouched.

What ports to TypeScript is `bbox_around`, `haversine_m`, the
panoramas-first-then-nearest sort and the `limit` trim — on the order of
forty lines. The camera-position subtlety documented in `find_panoramas`'
docstring must survive the port: a candidate's `lng`/`lat` are where the
camera stood, from `computed_geometry` falling back to `geometry`, never the
query point. Deriving a stop's bearing from the stop instead faces the
photograph 178 degrees backwards.

**The Python goes with the route.** `content/scripts/` does not import
`app.tools` at all — the only `app` import anywhere in it is
`build_tour.py`'s `from app.models import SCHEMA_VERSION, Tour`, and
`probe_coverage.py` carries its own `bbox_around` (line 150) and
`haversine_m` (line 156). So `find_panoramas`, `bbox_around`, `haversine_m`,
`PanoramaRequest`, `MAPILLARY_IMAGES` and `MAPILLARY_TIMEOUT` have exactly
one caller between them, which is the route. `find_places` computes its own
bbox inline and shares none of them. Leaving them behind would be dead code
that reads as shared; they are deleted, and their behaviour is pinned by the
ported TypeScript tests instead.

### 6.10 Archive search leaves the hosted editor

`www.loc.gov` refuses the host (§2) and the author has accepted losing it
rather than building a proxy for it. `/api/tools/archive-search` and
`/api/tools/archive-fetch` are removed from the deployed API, along with the
editor's archive-search panel.

**What this does not lose.** Rephotography itself is untouched. Overlays, the
per-photograph sliders, and the map-and-panorama alignment tools all operate
on an uploaded image, and media upload needs no egress. A historian finds a
photograph at loc.gov in their own browser, downloads it, drops it into the
editor, and aligns it exactly as before.

**What it does lose** is metadata arriving correct. Today `search_archive`
returns title, date, photographer and rights statement, and takes deliberate
care with them: it rejects any item whose title does not name every required
term or that names an excluded place, because "attaching an Alexandria
photograph to a Fairfax stop under a confident LoC credit is a provenance
error", and `_rights` reports a rights statement only when the item carries
one so the editor never shows an invented one. Hand-entered credits lose
those guardrails. The historians' sheet must therefore tell them how to cite
an LoC photograph — item URL, title, date, photographer, rights statement —
and that the burden is now theirs.

**The Python goes with the routes here too**, for the same reason as §6.9:
`content/scripts/fetch_rephotos.py` defines its own `UA`, `LOC_SEARCH`,
`_first` and `pick_by_date`, and `content/scripts/relevance.py` its own
`score_title` — which is the copy `backend/tests/test_relevance.py` actually
imports, via a `sys.path.insert` to `content/scripts`. So deleting
`search_archive`, `score_title`, `_creator`, `_rights`, `_image_url`,
`check_archive_url`, `fetch_archive_image` and their helpers from
`app/tools.py` cannot break `make content`, and `test_relevance.py` keeps
passing untouched.

Reversibility therefore rests on git, not on dead code: this is one commit to
revert if the §9 proxy is ever built. Note the knock-on — with both
`find_panoramas` and `search_archive` gone, `_get_json` and `RETRY_PAUSE`
lose their last callers (`find_places` posts to Overpass directly), so
`tools.py` reduces to roughly the Overpass path alone.

### 6.11 Documentation

- `docs/DEPLOY.md`: the §6.6 runbook, how to deploy, how to roll back, where
  session directories live on the host, how to back them up, and how to read
  the Passenger log when something breaks.
- A one-page sheet for the historians: the URL, the shared password, their
  recovery key and what it is for, how to record narration with the
  microphone and where to report it if that fails, and how to export a
  finished tour as a `.zip` to email back.
- `docs/UNVERIFIED.md` corrected per §2, and `docs/ARCHITECTURE.md` updated
  where it describes the single global session.

## 7. What the author still has to confirm on the host

The pipeline cannot be pinned without these, and the first is a go/no-go:

1. **Do the other three Overpass mirrors answer?** `overpass-api.de` returned
   502, which the author has already seen from their own Mac, so this is
   likely transient rather than a host restriction. `tools.py:33-38` lists
   `overpass.kumi.systems`, `overpass.private.coffee` and `overpass.osm.jp`.
   This is the last acquisition tool whose fate is unknown, and it is the
   only item here that changes §6's scope: if all four refuse, place lookup
   goes the way of §6.10 and historians place stops by eye on the map, which
   the editor already supports.
2. **The highest Python version** in cPanel's *Setup Python App* dropdown.
   §6.3 depends on it.
3. **Whether SSH is enabled** on the plan. §6.5 depends on it; the fallback
   is cPanel Git Version Control with a `.cpanel.yml`, which works but
   requires committing the built Angular bundle.
4. **A staging target** — a second subdomain or a second application path —
   for §6.5's rehearsal.
5. **The account's limits**: disk quota, and CloudLinux LVE memory and
   entry-process limits, which §6.7 is sized against.

Item 1 is one `curl` from the cPanel shell. Everything after it is sequencing
detail that does not block planning.

Note also that the cPanel shell is not the Passenger worker — CloudLinux can
treat an interactive shell and an application's user context differently. The
measurements in §2 are therefore strong evidence, not proof. A diagnostic
endpoint that attempts all three services from inside the running application
is the first thing to deploy, ahead of the session work, so a surprise
surfaces on day one rather than when a historian clicks *find panoramas*.

## 8. Left to the builder

- Cookie name and `sid` generation. The `sid` doubles as the recovery key a
  historian may copy by hand, so it needs to be long enough to be
  unguessable and short enough to retype.
- The `sid` validation character class, and whether to reuse
  `examples.py`'s guard directly.
- Where the recovery key appears in the editor, and how reattaching is
  entered.
- The sweep's retention window, given that recovery keys may be on paper.
- Whether `/tour-data` becomes a route or a per-session mount, provided
  `nosniff` and Range survive either way.
- The session sweep's implementation and its default retention window.
- How cookie isolation is tested — at minimum, two clients must not see each
  other's document or media.
- rsync flags and exclude syntax.
- Where `sessions_dir` defaults to on the host.

## 9. Contingency: an egress proxy

The acquisition tools now degrade rather than fail: panorama search moves to
the browser (§6.9), archive search leaves the hosted editor (§6.10), and
place lookup is pending §7's one open item. **No proxy is in scope.**

It is recorded here because it is the answer if the degradation turns out to
cost historians more than expected, or if archive search is wanted back. A
small proxy on a free tier — a Cloudflare Worker or equivalent, roughly
fifty lines — forwarding to LoC and Overpass and called from the browser,
would restore both. It is worth preferring over further client-side moves
because a proxy you own sets its own CORS headers, solving reachability and
cross-origin reads together, where a direct browser call solves only the
first. Its costs are a second deployment target and one more thing a second
person has to understand, which is why it is not in the plan.

If it is ever built for LoC, routing Mapillary through it too is cleaner than
keeping §6.9 alongside it — one mechanism rather than two.

**Try the cheaper thing first.** A historian's browser is on a residential
address and is not what loc.gov refused; only the host was. So before
building any proxy, test whether `www.loc.gov` sends
`Access-Control-Allow-Origin` to a browser request. If it does, archive
search returns client-side exactly as §6.9 does, for the cost of porting
`score_title` and the result mapping to TypeScript and nothing else. That
test was never run, because the question only became interesting after the
host was refused.

Reclaim Cloud remains the other shape of answer: a real container, `uvicorn`
directly, Python 3.14 as the Makefile already pins, and no egress question at
all. It costs money monthly and would delete §6.4's bridge, §6.3's version
question and this entire section. Worth revisiting if the proxy starts
growing.

## 10. Deferred

- **Client-side sessions.** If the backend should ever reduce to stateless
  proxies, the server-side session machinery described in §2 is what gets
  ported. Preserve the current implementation on a branch before §6.1 lands,
  so it can be read later without archaeology through the history.
- **Serving published tours** from the personal site as static files.
- **Per-person identity**, if tours ever need attributing to their author
  inside the application rather than by who emailed the `.zip`.
- **Streaming `/api/session/export` and `/api/session/publish`** instead of
  reading the whole archive into memory (§6.7). If a Passenger worker dies
  mid-export, this is the cause; recognise it rather than re-diagnosing it.
- **The close dialog**, still listed in `docs/UNVERIFIED.md` as unseen in a
  browser and not touched by this work.
