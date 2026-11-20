# Omeka import: bring an item's media into a stop

Status: draft, 2026-11-20. Builds on sub-project 3b
(`2026-10-25-media-and-acquisition-design.md`) and decisions 0001 and 0004.

## Why

Historians keep their collections in Omeka. Today the only way to get one of
those images or recordings into a tour is to download it by hand, upload it,
and retype its title, creator and rights. The import does that in one step
and carries the citation with it, so provenance is not lost between two
browser tabs. It is wanted for the demo this weekend (2026-11-21/22).

The editor had an in-editor archive search before (Library of Congress). It
was removed in `67bf589` because loc.gov refuses connections from the
production host. That code is the template for this one, and that failure is
the main risk this one carries.

## Goals

- An author types the address of any **Omeka Classic** site, searches it by
  keyword, picks an item, picks one of its files, and adds it to the current
  stop as an image or audio overlay.
- The overlay's title and body come from the item's Dublin Core Title and
  Description. Its credit is a `sourced` credit built from whatever rights
  data the item has.
- When something on the Omeka side stops the import (API turned off, not an
  Omeka Classic site, unreachable), the author is told what is wrong **and
  what to do about it**, in words they can act on or forward to their Omeka
  administrator.

## Non-goals

- **Omeka S.** Its API is a different shape (JSON-LD, `o:` keys). It is
  detected and named in the error, not supported.
- Private items and API keys. Only what the site's API returns to anyone.
- Browsing by collection, tag or item type. Keyword search only.
- Importing files other than images and audio (PDF, video, TIFF with no
  derivative). They are listed as "can't be imported" with the reason.
- Bulk import, or importing several files of an item in one press.
- Keeping an imported overlay in sync with later edits on the Omeka side.
- Dublin Core Date or Subject on the overlay. They are shown in the results
  so the author can type them in, but not written into the document.

## Anti-goals

- **An invented rights statement.** If the item states no rights, the
  overlay is not added until the author types a licence. Nothing defaults.
- **The server fetching an address on a private network** because an author
  (or anyone with the tester password) typed one. See "The address guard".
- **A failed import that changes the document.** Download and store first,
  change the document second, as every other media path does.
- **An error that only says "failed".** Every failure the author can fix, or
  can ask someone to fix, says how.

## Constraints

- Decision 0004: any new way bytes reach `media/` goes through
  `media_store.store_media`, so the stored type is decided by sniffing the
  bytes. A fetch of a client-named URL needs the streamed, capped,
  deadlined download that `fetch_archive_image` had.
- Decision 0004: acquisition tools live in `backend/app/tools.py`, take an
  `httpx.Client` so tests swap the transport, and raise `ToolError` with the
  HTTP status the route returns. No test touches the network.
- `SourcedCredit` (`backend/app/models.py`) requires non-blank `source`,
  `url` and `license`; `creator` is optional. No schema change.
- The hosted editor sits behind Basic auth (`docs/DEPLOY.md`), so only
  testers reach these routes. The guard is still required: the password is
  shared, and the published site is not where this runs anyway.
- Per-browser sessions: routes take `CurrentSession`, as
  `/api/session/media` does; the old archive routes' `app.state.session` no
  longer exists.
- Deploys are manual from the workstation (`deploy/deploy.sh`).

## Approaches

- **A. The server does everything (chosen by the author).** The editor sends
  the site address and search words to the backend, which calls the Omeka
  API, returns results, then downloads the chosen file and stores it. Needs
  nothing from the Omeka site beyond an enabled API. The address guard lives
  in one place.
- B. The browser searches Omeka directly, the server downloads. Less server
  code, but a browser can only read another site's API if that site sends
  CORS headers, and Omeka Classic does not by default. Search would fail on
  most sites. Dropped.
- C. The browser does everything and uploads the bytes through
  `/api/session/media`. No server-side fetch at all, so no forgery risk, but
  it depends on CORS for the API and the files. Workable on a site we
  control, not on "any URL". Dropped.

## Design

### The address guard

The author may type any URL. The server must still never connect to a
private address. `check_public_url(url)` in `tools.py` refuses, with
`ToolError(400)`:

- any scheme but `http` and `https`;
- userinfo (`https://a@b/`);
- a port other than the scheme default (80, 443) *(builder's call, below:
  Omeka on an odd port is rare, and refusing it stops the editor being used
  to probe ports)*;
- a host that is an IP literal or resolves to any address that is not
  globally routable: loopback, private (10/8, 172.16/12, 192.168/16),
  link-local (169.254/16, including the cloud metadata address), CGNAT,
  multicast, reserved, unspecified, and their IPv6 equivalents
  (`ipaddress.ip_address(...).is_global` is the test, plus a refusal of
  IPv4-mapped IPv6 that maps to a refused address).

**The check must hold at connect time, not only before it.** A name checked
and then resolved again by httpx can answer differently the second time
(DNS rebinding). So the Omeka client is built on a transport whose network
backend resolves the host, refuses non-global addresses, and connects to the
address it checked, keeping the hostname for TLS SNI and certificate checks.
In httpx this is an `httpcore` network backend wrapper passed to the
connection pool; how it is wired is the builder's. Every connection the
client makes, including redirect hops, goes through it.

**Order and fallback (the author's decision).** The connect-time check is
the least predictable piece: nothing in the codebase hooks httpcore's
network layer yet. It is built **first**, before anything else in this
work. If it is not passing by **Saturday 2026-11-21 midday**, the demo ships
with the simpler check instead: `check_public_url` resolves the host and
refuses non-global addresses before each request and on every redirect
hop. The connect-time check is then recorded as open in
`docs/UNVERIFIED.md` and finished after the demo. In the meantime only
testers with the Basic auth password can reach these routes.

Redirects are followed by hand (`follow_redirects=False`, as
`_get_capped` did), at most 5 hops, re-running `check_public_url` on each,
so a scheme or port change is caught even though the connect-time check
already covers addresses.

The Omeka client does not read proxy settings from the environment
(`trust_env=False`): through a proxy the connected peer is the proxy, and
the guard would check the wrong address. If the production host turns out to
need a proxy for egress, that is a change to this design, not a flag.

Tests: the address classification is a pure function, tested directly
(including `169.254.169.254`, `::1`, `::ffff:127.0.0.1`, `0.0.0.0`,
`100.64.0.1`). The resolver is a seam so the connect-time check is tested
with a fake that answers a public address first and a private one second.
Route tests use `MockTransport` as every other tool does, so the guard's
resolver is not on that path; one test asserts the production client is
built with the guarded backend.

### Finding the site

The author types an address, perhaps sloppily: `omeka.example.org`,
`https://example.org/omeka/items/browse?tags=x`. `omeka_base(raw)`
normalises it: adds `https://` if no scheme was given; drops query and
fragment; strips a trailing public-theme or admin path (`/items/...`,
`/collections/...`, `/exhibits/...`, `/admin/...`, `/files/...`) so a page
copied from the browser works; keeps any install subpath (`/omeka`); drops
a trailing slash. The API root is `{base}/api`.

`GET {base}/api/site` identifies the site. Its JSON has a `title` (the
credit's source) and `omeka_version`. The response classifies the failure
modes, and these messages are the user-facing text, word for word unless
the builder improves them:

| What came back | Status | Message to the author |
|---|---|---|
| `403` with `{"message": "API is disabled"}` | 409 | "The Omeka site at {host} has its API turned off. Someone with an administrator login can turn it on: in the Omeka admin, go to **Settings → API**, tick **Enable API access**, and save. Then search again." |
| `403` or `503` that is a Cloudflare bot challenge (a `cf-mitigated` header, or `server: cloudflare` with an HTML body) | 409 | "The Omeka site at {host} is behind Cloudflare, which challenged the editor's server as a bot. Whoever manages the site's Cloudflare account can allow it: add a rule letting this server's address reach /api/* and /files/* without a challenge. Then try again." Checked on the API calls and the file download alike; not retried. |
| any other `403`/`401` | 409 | "The Omeka site at {host} refused the request ({Omeka's message, if any}). It may only allow signed-in access, which this import does not support." |
| `404`, or a `200` that is not JSON with a `title` | 404 | "There is no Omeka Classic site at {base}. Check the address is the site's home page, for example `https://example.org` or `https://example.org/omeka`. (Omeka S sites are not supported yet.)" |
| a `200` from `{base}/api/sites` instead (Omeka S) | 404 | "{base} is an Omeka S site. Only Omeka Classic is supported." — *only checked after `/api/site` fails, and only if it is cheap; the builder may drop this row and let the previous message stand.* |
| connection refused, DNS failure, timeout | 502 | "The editor's server could not reach {host} ({reason}). The site may be down, or this server may not be allowed to connect to it. Check the address opens in your browser; if it does, the server's network is blocking it." |
| refused by the address guard | 400 | "{host} points to a private or local network address, which the editor will not connect to." |
| 5xx | 502 | "The Omeka site at {host} had an error ({status}). Try again in a minute." |

The API-disabled case is checked by status **and** message, since the
message is the only thing distinguishing it from an access-control 403.
Messages go to the author through `ToolError` → `HTTPException(detail)` →
`ToolsApi`'s existing `detail` handling, so the outline pane shows them as it
shows any tool error.

### The Omeka API calls

**Time budget (builder's call).** Under CGI (decision 0007) each request is
one process, and the host's limit on how long a CGI request may run is not
recorded anywhere; shared hosts commonly cut requests off at 30–60 s. A
killed request reaches the author as a bare 500/504 instead of the messages
above. So **every route finishes within 30 s in total**, end to end: a
shared deadline is passed through each call. Search and files: 10 s per
Omeka request. Import: the file-record read gets 10 s, and the download
shares a 25 s deadline across one retry and every redirect hop (not
`fetch_archive_image`'s 5 attempts and 90 s).

The 30 s is a budget, not a hard ceiling. httpcore fixes a response's read
timeout once, when the body starts, so the body's read timeout is set to
whatever budget remains at that moment. A server that sends part of a body
and then stalls can therefore hold the route past 30 s, but by no more than
the budget that was left when the body began. A timeout at or after the
deadline is reported as the 504 below, not as "unreachable". A watchdog at
the socket level would close this gap entirely, and was judged out of
proportion for now; step 5 of the live check measures the real timings.

Running out of deadline is a
`ToolError(504)` with "The Omeka site at {host} took too long to answer.
Try again, or try a smaller file."

All three are `GET`s through the guarded client with the existing `UA`,
`Accept: application/json`, a 10 s timeout per request, and `_get_json`-style
handling (bad JSON is a `ToolError(502)`). **Response shapes were confirmed
live** on 2026-11-20 against `https://omeka.madelynharrington.net` (Omeka
3.2.1). The captured responses are the test fixtures in
`backend/tests/fixtures/omeka/`. What they showed:
- non-image files have `fullsize: null`;
- PNG originals have JPEG `fullsize` derivatives;
- item 3 has no Rights;
- titles can carry trailing spaces;
- `/api/sites` on Classic is a 404;
- an empty search is `200 []` with `Omeka-Total-Results: 0`.

- `GET {base}/api/items?search={q}&page={n}` → a list of items. Total in the
  `Omeka-Total-Results` header; page size is set by the site administrator
  (default 50), not by us. Each item has `id`, `public`, `files.count`, and
  `element_texts: [{text, html, element: {name}, element_set: {name}}]`.
- `GET {base}/api/files?item={id}` → that item's files: `id`, `mime_type`,
  `original_filename`, `file_urls: {original, fullsize, thumbnail,
  square_thumbnail}` (derivatives are `null` for non-images), and their own
  `element_texts`.
- `GET {base}/api/site` as above.

Dublin Core values are read from `element_texts` where
`element_set.name == "Dublin Core"`; several texts for one element are
joined with `"; "`. A text with `html: true` has its tags stripped and
entities decoded to plain text (the overlay body is plain text).

### Routes

In `main.py` beside the other tools, each `dependencies=[Depends(_reject_cross_site)]`,
plain `def` (threadpool), request models in `tools.py`.

**`POST /api/tools/omeka-search`** `{siteUrl, query, page=1}` →
```json
{ "site": { "base": "...", "title": "..." },
  "total": 132, "page": 1, "rawCount": 50,
  "results": [ { "itemId": 17, "itemUrl": "{base}/items/show/17",
                 "title": "...", "description": "...", "creator": "...",
                 "date": "...", "rights": "...", "fileCount": 2 } ] }
```
Calls `/api/site` then `/api/items`. Items with `files.count == 0` are left
out of `results` (an item with nothing to import is noise) but counted in
`total` as Omeka reports it. `rawCount` is how many items Omeka returned on
this page before that filtering, so the panel stops offering More results
once a page comes back empty or the raw items seen reach `total` (counting
`results` against `total` would never get there). `query` is required and non-blank, max 300
characters; `page` 1–1000.

**`POST /api/tools/omeka-files`** `{siteUrl, itemId}` →
```json
{ "files": [ { "fileId": 41, "kind": "image", "filename": "...",
               "thumbUrl": "...", "importable": true, "reason": null,
               "title": "...", "creator": "...", "rights": "..." } ] }
```
One call per item, made when the author opens it, rather than one per
search result (an N+1 of up to 50 requests). `kind` is `image` when
`mime_type` starts with `image/` and `fullsize` is non-null; `audio` when
`mime_type` is one of the audio types `media_store.ALLOWED_TYPES` accepts;
otherwise `importable: false` with a short `reason` ("PDF files can't be
added to a tour"). The file-level Dublin Core fields are returned so the
credit can prefer them (below).

**`POST /api/tools/omeka-import`** `{siteUrl, itemId, fileId, title}` →
`{...session.summary(), "mediaId": "..."}`. 409 if no tour is open. The
server **re-reads the file record** from `/api/files?item={itemId}` and
picks `fileId` from it; the client never names the download URL. Images
download `file_urls.fullsize` (Omeka's JPEG derivative: originals are often
TIFF, which `store_media` refuses); audio downloads `file_urls.original`.
The download is `fetch_archive_image` reborn as `fetch_omeka_file`: streamed,
capped at `cfg.max_media_file_bytes` (declared `Content-Length` over it
refused before reading), one retry on transport errors and 5xx, inside the
time budget above, redirects by hand through the guard. The
body must sniff as the expected kind. Then `store_media(session.path, body,
title or "omeka", max_file_bytes=..., max_session_bytes=...)`.

`GET /api/diagnostics/egress` is not changed: it probes fixed hosts, and the
Omeka host is whatever the author types. The search's own unreachable
message does that job.

### The credit, title and body

A pure function `omekaCredit(site, item, file, authorLicense?)` in
`document-ops.ts`, the shape of the deleted `archiveCredit`:

| Credit field | From |
|---|---|
| `source` | the site's `title` from `/api/site`; the host if blank |
| `url` | the item's public page, `{base}/items/show/{itemId}` |
| `creator` | file's DC Creator, else item's DC Creator, else `null` |
| `license` | file's DC Rights, else item's DC Rights, else what the author typed; with none, the function returns `null` and nothing is added |

Overlay `title`: file's DC Title, else item's DC Title, else the file's
`original_filename`. Overlay `body`: item's DC Description, else `null`.
Display is a marker at the stop's location, as every new media overlay is.

*Builder's call (departing from decision 0001):* 0001 sketched `source`
coming from `dcterms:publisher`. For an archival photograph, Publisher is
usually the original publisher (a newspaper, a studio), not where the author
got it; the credit's `source` is the citable place the file came from, which
is the Omeka site. Publisher is not imported.

**No `identifier` field (the author's decision).** Decision 0005 left
to this work whether `SourcedCredit` gets an `identifier`, and warned that
adding one after the first import leaves that batch unreconcilable. The
answer is no schema change: `url` is `{base}/items/show/{itemId}`, which
records both the site and the item id. A later re-import or sync can match
on it by parsing the URL. This is weaker than a dedicated field, because an
author can edit the URL, and that is accepted.

`addMediaOverlay` gains an optional `body` so the overlay, its title, body
and credit land in **one** document change (one undo step). Existing callers
are unchanged.

### The editor panel

A new standalone component, `OmekaPanel` (`editor/omeka-panel.{ts,html,css}`),
opened by an **Import from Omeka** button in the outline pane's toolbar,
disabled without a current stop (where "Search the archive" was). The
outline pane is 280 lines already; the panel owns its own search, paging,
busy and error state, and emits `{kind, mediaId, title, body, credit}` when a
file is stored. The outline pane passes that to `createFromMedia`, extended
to take `body`, so the document half stays in one place.

```
┌ Import from Omeka ─────────────────────────────────────────┐
│ Site  [ https://omeka.madelynharrington.net         ]      │
│ Find  [ courthouse                                  ] [Search]
│                                                            │
│ Historic Courthouse — Fairfax Historical Society  (132)    │
│ ▸ Fairfax Courthouse, 1863        2 files                  │
│ ▾ Courthouse cupola               1 file                   │
│     Creator: Brady, Mathew   Date: ca. 1863                │
│     Rights: No known restrictions                          │
│     [thumb] cupola.jpg  image   [Add to this stop]         │
│ ▸ Court day handbill              1 file                   │
│     [pdf]  handbill.pdf  PDF files can't be added to a tour│
│                                         [More results]     │
└────────────────────────────────────────────────────────────┘
```

When an item and file state no rights, the file row reads "No rights
statement. Enter the licence you are adding it under:" with a text field,
and **Add to this stop** stays disabled until it is non-blank, as the old
archive panel did.

The site address is remembered per browser in `localStorage` (wrapped in
try/catch, as theme code does) so the author does not retype it.
Thumbnails are `<img src>` straight from the Omeka site: images need no
CORS, and nothing is stored until the author adds one. An `http://`-only
site's thumbnails may be blocked as mixed content on the https editor; the
import itself still works, since the server fetches.

Status lines reuse the outline pane's idiom: "Searching…", "Adding…",
errors in the existing `.note.warning` style, showing the server's message
verbatim.

## Testing

Test-first throughout (the author's standing rule).

- `tools.py`: `omeka_base` normalisation table; `check_public_url` and the
  address classifier; the connect-time check via the resolver seam;
  `/api/site` classification, one test per row of the error table (the
  API-disabled message must name Settings → API); Dublin Core extraction
  (multiple values, `html: true` stripping, missing element set); file
  classification (image with/without `fullsize`, each accepted audio type,
  PDF); `fetch_omeka_file` cap, deadline, retry, per-hop redirect re-check,
  wrong-kind body. Fixtures are JSON shaped like the documented API.
- Routes: search, files, import (409 with no tour; import ignores any
  client attempt to name a URL; stored media id's kind matches).
- Frontend: `omekaCredit` table; `addMediaOverlay` with `body`; `ToolsApi`
  methods; `OmekaPanel` spec (search, open item, licence gate, error text
  shown, emits only after the server returns a media id); outline pane wires
  the emit into one undo step.

## Live check (before the demo)

Recorded in `docs/UNVERIFIED.md` as a new entry until done.

1. Turn on the demo site's API (Settings → API). Confirm from the
   workstation: `curl -s https://omeka.madelynharrington.net/api/site`
   returns JSON with a `title`.
2. Compare one real `/api/items?search=` and `/api/files?item=` response
   against the fixtures; fix the fixtures (and parser) where they differ,
   as the 3b live run did for loc.gov.
3. **From the production host**, after deploying: search the demo site in
   the hosted editor. This is the check loc.gov failed. If the host cannot
   reach it, the message says so; that needs fixing on the host or the
   Omeka side before the demo, not in this code. The demo site is behind
   Cloudflare (it resolves to `172.67.222.62` and `104.21.46.14`), so it is
   not on the editor's own server. But Cloudflare's bot protection may
   challenge requests from a hosting provider's address. A challenge is a
   `403` (with a `cf-mitigated: challenge` header and an HTML page) or a
   `503`, and the editor reports it as such: "The Omeka site at {host} is
   behind Cloudflare, which challenged the editor's server as a bot. ..."
   The fix is a Cloudflare rule allowing the editor host's address to reach
   `/api/*` and `/files/*`, which the author controls.
5. Time one search and one import from the hosted editor. If either comes
   close to 30 s, the host's CGI limit becomes the next thing to learn.
4. Import one image and, if the site has one, one audio file; publish;
   open the published page.

## Left to the builder

- How the guarded network backend is wired into httpx/httpcore.
- Exact HTML-stripping approach for `html: true` texts (stdlib
  `html.parser` is enough; no new dependency).
- Panel styling, within the existing editor CSS tokens.
- Whether to keep the Omeka S detection row.
- Splitting into tasks; backend tool, routes, and frontend panel are the
  natural seams, with the credit function and `addMediaOverlay` change
  touching `document-ops.ts` (a shared file: not parallel with each other).
