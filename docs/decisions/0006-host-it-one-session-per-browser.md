# 0006 — Host it, one session per browser, and what left the server

Status: accepted, 2026-11-06.

Supersedes the single-global-session assumption of [0002](0002-the-tour-is-a-portable-document.md)
(one working directory, `content/work/`), and removes three of the four
acquisition tools [0004](0004-media-comes-in-by-content-and-tools-wrap-the-scripts.md)
built. Leaves everything else in both alone: the tour is still a portable
document, and the client still never names a stored file.

## Problem

About six historians at RRCHNM need to author tours and report back. The
application ran only from a development checkout on the author's Mac, with one
open tour for the whole process, a working directory inside the repository, and
four tools that reach out to the internet from the server.

Putting it on Reclaim shared cPanel hosting changes what each of those means.
Several of the calls below look like loss of function. Each one was forced by a
measurement, and the measurements will not be reproducible later (the author
ran them once, from the cPanel shell, on 2026-11-06), so they are recorded here
with the decision they caused. The design document is
`docs/superpowers/specs/2026-11-06-hosted-tester-deployment-design.md`.

## Decision

### 1. Host it; do not package a Windows `.exe`

The testers are on Windows laptops. The original proposal was an `.exe` built
by GitHub Actions that updates itself from GitHub Releases. It was feasible and
it lost on three counts:

- **Nothing about it is easier for the historian.** With no code-signing
  certificate, the first install opens Windows' blue "protected your PC"
  SmartScreen box, and the instructions are to click through it. A URL has no
  install step.
- **It could only be tested on one machine.** Development is on macOS. The
  Windows artifact would come from CI and be verified on a single Windows
  desktop, and every packaging bug costs a round trip through CI.
- **The update path is heavier.** A release pipeline, an updater, a restart
  prompt and version skew across testers, against a `git push` to `main`.

One instance per historian (six cPanel Python apps with six passwords) was also
rejected: it multiplies the deploy targets, the credentials and the disk by six
and strains shared-hosting process limits, to avoid writing session code that
turned out to be small.

### 2. One global session became one per browser, keyed by a cookie

`app.state.session` is gone. A `tour_sid` cookie names a directory under
`Settings.sessions_dir`; `current_session` resolves it without creating
anything, and `mint_session` creates it, and only `GET /api/session` and the
four routes that make a tour out of nothing may mint. `/tour-data` stopped
being a static mount of one directory and became a route that resolves the
cookie, because the mount would have served every historian every other
historian's media.

The session id doubles as a **recovery key**: 16 lowercase hex characters
(64 bits), shown in the editor and accepted back on the welcome screen. It is
long enough not to be guessed and short enough to write down, and it exists
because the cookie is the only thing tying a browser to its tour, and browsers
forget cookies. The cost of that dual use is that the key is also a directory
name, so it is validated before it is ever joined to a path, and a backup of
`sessions_dir` contains every key.

The directory lives outside the deploy tree (`~/.clio-wired/sessions` by
default) so that an `rsync` deploy cannot reach it. The deploy also never
passes `--delete`: the first defence is location, the second is not deleting,
and the price of the second (a file removed from the repository lingers on the
host) is accepted on purpose.

Two details that look incidental are not. The cookie is **always `Secure`**,
not derived from the request scheme: Passenger terminates TLS upstream, so the
scheme this process sees can be `http` on a request the browser made over
HTTPS, and a derived flag would be silently dropped in production, which is
where it matters. The price is that Safari, which has historically rejected a
`Secure` cookie on `http://localhost`, mints a new session per request in local
development. And `a2wsgi` does not run the ASGI lifespan, so initialisation that
lived there (`app.state.cfg`, the viewer's `config.json`) moved into
`create_app`'s body and into the mint.

Abandoned directories are swept, on a mint and at most hourly, in two windows:
a day for a directory with no `tour.json` (no authored work, and no key anyone
was shown), ninety days for one with real work, measured from the newest file
inside it.

### 3. Panorama search moved into the browser

`graph.mapillary.com` is unreachable from the host. Measured from the cPanel
shell: DNS resolves it to `31.13.80.8`, a Meta edge address, and the IPv4 SYN
is silently dropped: no `RST`, no `Connected to`, a hang until killed. The host
has no IPv6 route, so the `2a03:2880:...` addresses fail at once with "Network
is unreachable". Whether the cause is Reclaim's egress rules or Meta refusing
the host's address range is unknown and does not matter.

Moving the search to the client was the easy direction rather than a
compromise. The frontend already holds the token (`_viewer_config` hands it
over; Mapillary tokens are designed for client use), `mapillary-js` already
calls Mapillary from the browser to render every panorama, and the search
returns metadata only (ids, camera coordinates, compass angles, thumbnail
URLs), so no media bytes cross our server. `selectPanorama` already sets
`cachedMediaId: null`, so nothing needed fetching server-side.

**What this does not establish:** that a browser may read the response to a
plain `HttpClient` GET. `mapillary-js`'s own requests prove that library can
reach Mapillary, not that Mapillary's CORS headers admit ours. There is no CSP
anywhere in the repository, so nothing blocks it from our side, but CORS is
decided at runtime by the browser against their headers. Unit tests mock
`HttpClient`. This is `UNVERIFIED.md` entry 32 and the largest open risk here.

### 4. In-editor archive search was removed

`www.loc.gov` returns **403** from the host, via `104.17.6.58`, a Cloudflare
address, both with `curl`'s default User-Agent and with the application's own
(`clio-wired-prototype/0.1 (graduates@rrchnm.org)`). The connection completes,
so this is a WAF refusal and most likely based on the address range. It could
not be fixed from our side. An egress proxy would restore it (design §9 records
the shape), and was not built: it is a new thing to operate, and the loss is
small.

It is small because **rephotography is untouched**. Overlays and alignment work
on an uploaded image, wherever it came from. A historian now finds the
photograph at loc.gov in their own browser, uploads it, and cites it by hand;
the editor used to fill in title, date, photographer and rights from the
archive record, and no longer does.

### 5. Synthesised narration was removed; the microphone is the only path

`/api/tools/narrate` shells out to macOS `say` and `ffmpeg`. Neither exists on
the Linux host, and neither exists on the testers' Windows laptops, so this
broke on every route out of the author's Mac, not only this one. Recording from
the microphone (which needs HTTPS, hence AutoSSL) is the replacement. The
recorder has never run in a real browser, and ships that way by the author's
decision: historians are told where to report a failure
(`docs/FOR-HISTORIANS.md`).

### 6. The resource caps became settings

64 MB per file, 1 GB of media per session and 512 MB per bundle were sized for
one author on a local disk. Six sessions plus abandoned ones multiply them
against a shared quota. They are now `Settings` fields (defaults unchanged,
positive-only), so the host's `.env` can lower them. Streaming the export and
publish responses, rather than reading the zip into memory, is deferred, not
dismissed: under CloudLinux memory limits a worker dying mid-export is the
symptom to recognise.

## What is not known

- **The cPanel shell is not the Passenger worker.** CloudLinux can treat an
  interactive shell and an application's user context differently. The
  measurements above are strong evidence, not proof. This is why
  `GET /api/diagnostics/egress` exists and is the first step of
  `docs/DEPLOY.md`: it asks the question from inside the running application.
- **The Overpass mirrors beyond the first are untested.** `overpass-api.de`
  returned 406 to a bare User-Agent and 502 to the application's. A 502 from
  that mirror is a known transient state, which is the reason four are
  listed, but `overpass.kumi.systems`, `overpass.private.coffee` and
  `overpass.osm.jp` have never been called. If all four refuse, place lookup
  goes the way of archive search and historians place stops by eye on the map,
  which the editor already supports. Its fate is open.
- **The host's Python version, the CloudLinux virtualenv path, the SSH port and
  whether the deploy pipeline works at all** have never been checked
  against the host. See `docs/DEPLOY.md` and `UNVERIFIED.md` entries 33 and 34.
- **Python 3.13 is the floor, not a measured requirement.** The code was
  scanned for syntax newer than 3.9 and none was found, but that was not
  confirmed by running another interpreter.
