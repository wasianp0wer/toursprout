# 0004 — Media comes in by content, and the scripts became tools

Status: accepted, 2026-10-25.

## Problem

Sub-project 3b had to let an author put media into the open tour (uploads,
microphone recordings) and reach the services the content scripts had been
reaching for them (Mapillary panoramas, OSM places, Library of Congress
photographs, synthesized narration). Both halves take input the application
does not control: a file the client names, and a URL the client names.

## Considered

**Store uploads under the client's filename.** The obvious design, and
the one a reader recognises. Its cost is that the name is attacker-chosen
input to a filesystem write: traversal, overwrite of an existing file by
naming it, and an `.html` or `.svg` that is then served from the author's
own origin. Each can be patched separately (reject `..`, reject known-bad
extensions), but a deny-list loses to whoever picks the name, so it was
rejected in favour of making the name irrelevant.

**Transcode recordings to one format.** It would remove the Safari/WebM
split for good. Its cost is a transcoder in the request path (ffmpeg, which
may not be installed) or in the client (a WASM build of a few megabytes), a
new failure mode for every recording, and work out of proportion to a
limitation that preferring MP4 where the browser offers it already removes
for most authors. Rejected for now; it is the answer if the unverified
Safari risk below turns out to be common.

**Rewrite the scripts as new code.** A cleaner API than lifted functions.
Its cost is that the scripts hold query shapes learned the hard way (which
Overpass tags return usable results, the LoC scoring and excluded places)
and a rewrite re-learns them by failing in front of the author. It would
also fork the logic, leaving `make content` and the editor to disagree.
Lifting keeps one source of knowledge and costs some awkward signatures.

**Fetch archive images from the browser.** It would avoid an endpoint that
fetches a client-named URL and so avoid the SSRF surface entirely. Its cost
is dependence on `tile.loc.gov` sending CORS headers (unchecked), losing
retry-on-5xx and the magic-byte check, and a browser then uploading what it
fetched, so the same bytes cross the wire twice. The endpoint plus an
allowlist was judged the smaller risk.

## Decision

### The client never names an uploaded file

A stored media id is a slug of the original stem plus a content hash, and
the extension is chosen by sniffing the bytes (`media_store.sniff`), never
from the upload's name or declared type. The client supplies a stem for
readability and nothing else. That removes three problems with one rule:
path traversal (the slug is `[a-z0-9-]`, no separator or dot), overwrite by
guessing (the id follows the content, so a different file cannot land on an
existing name; a hash collision escalates to a longer hash rather than
replacing), and extension smuggling (a file called `x.jpg` whose bytes are
HTML is refused; an HTML file cannot be stored as `.html` because no
sniffed type maps there).

This matters more than it would for a private scratch directory because
`publish.py` copies the working directory into the published site. Anything
in `media/` is served from the author's own origin, so an `.html` or `.svg`
that got in would run with that origin's authority.

Bundle import is the second door, and it must use the same definition of
"media". It first waved all of `media/` through, so `media/evil.html`
imported and was served as `text/html` from the editor's origin, which also
hosts the unauthenticated session API, and then from the public one via
publish. `bundle._check_media_file` now sniffs every file under `media/`
with the upload path's own `_sniff_type` and requires an extension from the
set uploads are stored under, because a static server types by extension and
JPEG bytes named `.html` are still served as HTML.

### Recording keeps the browser's native format

`MediaRecorder` produces whatever the browser produces: WebM/Opus in
Chromium and Firefox (Firefox may give Ogg/Opus), MP4/AAC in Safari. There
is no transcoder in this application and adding one (ffmpeg in the request
path, or WASM in the client) is a dependency and a failure mode out of
proportion to the problem. The cost is that a tour recorded in Chromium
carries `.webm` narration that Safari cannot play. Mitigation: the recorder
now prefers MP4 when `isTypeSupported` says the browser can produce it
(Chromium recent enough, and Safari), which removes the limitation for most
authors. The warning remains for browsers that cannot, and an author
recording in such a browser should expect Safari viewers to get silence.

### The scripts became tools, not rewrites

`content/scripts/` encode which queries actually work against these
services (the Overpass tag filter, the LoC required-term and
excluded-place scoring, Mapillary's bbox query, `say` then ffmpeg AAC).
Re-deriving that would lose it, so `backend/app/tools.py` lifts each
function, naming its origin, and changes only the shape: return data
instead of writing `content/media/`, take an `httpx.Client` so tests swap
the transport, raise `ToolError` with an HTTP status instead of
`sys.exit`. The scripts and `make content` are untouched.

One behaviour is load-bearing. The panorama tool returns each camera's
own position (`computed_geometry`, else `geometry`), never the query
point, because the editor's heading gate derives a stop's view bearing from
where the camera stood. Deriving it from the stop's location instead faces
the photograph 178 degrees backwards on the real tour: the stop is the
building and the camera is in the street.

### `archive-fetch` is a backend endpoint with a host allowlist

Downloading the chosen LoC image could have been a browser `fetch`. It is
not, for two reasons. A cross-origin browser fetch depends on CORS, which
the Python tooling never needed and which was not checked for `tile.loc.gov`;
and a browser fetch would throw away the retry-on-5xx and
magic-byte check that `relevance.get_bytes_with_retry` already had: a LoC
error page served as `200` would be stored as an "image".

An endpoint that fetches a URL the client supplies is a server-side request
forgery hole unless constrained. So `check_archive_url` allows only
`https` on `loc.gov` or a subdomain, refuses userinfo and non-443 ports
(`https://a.loc.gov@evil/` and `https://loc.gov:8443/` are how such lists
get walked around), and is re-applied on every redirect hop, which is
followed by hand. The body must sniff as an image; the Content-Type header
is not trusted. The body is streamed and abandoned past `MAX_FILE_BYTES`
(a declared `Content-Length` over it is refused before a byte is read), and
a 90 s deadline bounds all attempts and hops together, since the per-request
timeout bounds only each read.

## What the live verification showed

Every network tool had only ever met mocked responses. On 2026-10-25 each
was run once against the real services at the courthouse panorama
(-77.306888, 38.845534). Three shapes rested on recalled documentation;
two of those were wrong.

- **Mapillary `thumb_256_url`: present, and the call succeeds.** It is a
  256x128 `scontent.xx.fbcdn.net` URL. Mapillary also silently ignores an
  unknown `fields` entry (200, field absent), so the field list is not a
  failure risk. Panoramas stand at distance 0.0 and 3.0 m from the
  courthouse point; ids are strings.
- **Mapillary error envelope: confirmed.** A bad token is HTTP 400 with
  `{"error":{"message":"Invalid OAuth access token - Cannot parse access
  token","type":"OAuthException","code":190,"fbtrace_id":"..."}}`.
- **loc.gov `rights`: does not exist, and neither does `creator`.** Search
  results have no top-level `rights`, `rights_advisory`,
  `rights_information` or `creator`. The rights statement is
  `item.rights_advisory` (identical to `item.rights_information`); the
  photographer is `item.creators[].title`, with `item.contributors[]`
  strings as the fallback and a top-level `contributor` list (lowercased,
  e.g. `"o'sullivan, timothy h."`) as the last resort. The parser read
  top-level `creator` and `rights`, so it returned `null` for both on every
  real item. **Fixed**, and the mock rewritten to the observed shape. Also
  fixed: `itemUrl` preferred `id`, which is `http://`; it now prefers `url`
  (`https://`).
- **loc.gov `image_url`.** A list of renditions, smallest first:
  `[0]` is a 150px JPEG, `[1]` a GIF thumbnail, `[2]` about 640px,
  `[-1]` about 1024px (`...v.jpg`), each with a `#h=..&w=..` fragment. So
  `image_url[0]` is a usable thumbnail. Some items have a single entry (a
  IIIF `.../default.jpg`), in which case thumbnail and full image coincide.
  Titles and dates are strings.
- **Overpass `[timeout:12]` at 3 km: survives.** It returned 200 with 19
  elements and no `remark`, the shape the mock already had (plus the
  `version`/`generator`/`osm3s` envelope). **But latency is the real
  problem:** from this network `overpass-api.de` took 34-42 seconds for
  every request, including a trivial `node(1)` query, and once answered 502
  "at capacity". The tool's per-mirror timeout was 15 s with a 40 s total
  budget, so against this mirror from here it could never succeed. Only
  `overpass-api.de` was authorised, so the fallback mirrors are unexercised.
  The timeouts are now 45 s each, on the reasoning that a generous timeout
  costs a slower failure while a tight one costs the feature. That figure
  is from one observation on one network; adjust it against your own. (The
  query's own server-side `[timeout:12]` is unchanged and was not the
  limiting factor in the observed run.)
- **`archive-fetch`: the direct path is verified; redirects are not.**
  Real `tile.loc.gov` image URLs (150px, 1024px and an IIIF one) returned
  200 `image/jpeg` with a JPEG magic prefix and went through
  `fetch_archive_image` unmodified. No real redirect was encountered on any
  image URL, so the per-hop allowlist has still never met a live one.
- **loc.gov flakiness.** Over HTTP/2 `curl` twice received a stream reset
  and a silently truncated body, and one `httpx` read timed out mid-body.
  Complete responses are about 700 KB for 25 results. `_get_json` does not
  retry a timeout, deliberately; the author may simply press search again.

Disclosure: the image downloads went to `tile.loc.gov`, a host the run's
authorisation did not name (it named `www.loc.gov`). The image URLs the
search returns point there, so the check could not be made otherwise, but
it was not separately authorised.

## Costs and what is still open

- **The extension lists are mirrored, and now tied.** `IMAGE_EXTS` and
  `AUDIO_EXTS` in `frontend/src/app/editor/document-ops.ts` copy the
  backend's `ALLOWED_TYPES`; a backend test reads the TypeScript and fails
  on drift, the same idiom as the display-mode table.
- **The recording round trip is unverified in a real browser.** Chromium's
  EBML header and Firefox's `OggS` pass the sniffer. Safari's MP4 brand is
  a risk: `isom`, `iso5`, `mp42` and `M4A ` pass; `dash` and `cmfc` would be
  refused as "not an allowed type". The closing test is to record one clip
  per browser and commit the first 32-64 bytes of each as fixtures for the
  sniffer. Until then this is believed, not known.
- **The old pipeline is not retired.** `content/source/stops.json`, `make
  content` and `build_tour.py`'s document generation remain, with their
  warnings. Retiring them is the point of no return for the old workflow
  and waits for the author's explicit confirmation.

## How the deferred features land on this

- **Any new way bytes reach `media/`** (a drag-and-drop route, a URL import,
  another tool) goes through `media_store.store_media`, or, if it arrives as
  an archive, through `bundle._check_media_file`. Both rest on
  `_sniff_type`; a new format is one entry in `ALLOWED_TYPES` plus the
  matching line in `document-ops.ts`, and the tie-test says which you forgot.
- **A new acquisition source** is a function in `tools.py` taking an
  `httpx.Client` and raising `ToolError`, with a route beside the others and
  a method in `tools-api.ts`. If it fetches a client-named URL it needs its
  own host allowlist and the streamed, capped, deadlined download that
  `fetch_archive_image` uses, not a copy of its `resp.content` ancestor.
- **Transcoding recordings** would slot in before `store_media`, in the
  upload route, so the stored type is still decided by the bytes. It is the
  answer to the unverified Safari brand risk if that proves common.
- **Retiring `content/source/stops.json`** (HANDOFF, outstanding item 2) is
  now technically possible: an author can name a tour, write stop text,
  place media and publish, all in the editor. This record does not decide
  it; it is gated on the author's explicit confirmation.
