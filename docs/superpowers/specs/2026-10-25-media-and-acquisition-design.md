# Media and acquisition: getting content into a tour

Sub-project 3b of 4 (sub-project 3 was split; see
`docs/superpowers/specs/2026-10-13-editing-core-design.md` for 3a). The
umbrella is `docs/superpowers/specs/2026-10-12-authoring-application-overview.md`.

## Why

Sub-project 3a built a tool for placing content precisely. It cannot create
any. An `image` or `audio` overlay needs a `mediaId`, and nothing in the
application can produce one, so the editor can arrange and align what the
hand-built pipeline already made and nothing else.

Two consequences, both recorded during 3a's reviews:

- **A stop you add cannot be placed.** `addStop` clones the previous stop's
  `location` and `panorama`, and nothing can change either afterwards, so
  "Add stop" produces a permanent duplicate of its predecessor.
- **The umbrella's success criterion is unreachable**: "the author creates a
  second tour, one that is not Old Town Fairfax, entirely through the editor."

This sub-project closes both. When it lands, `content/source/stops.json` and
`make content` retire, which also resolves the `de48b0d` drift that has been
HANDOFF's outstanding item 2 since sub-project 2.

## What gets built

### 1. Media upload

`POST /api/session/media`, multipart, writing into the open working
directory's `media/`, returning the `mediaId` the document will reference.

This is the application's **second untrusted input**, after bundle import, and
it is a file write driven by a client-supplied name. It gets the same
treatment:

- **The client does not choose the stored name.** The `mediaId` is derived
  server-side from a slug of the original stem plus a short content hash, with
  the extension taken from the sniffed type rather than the supplied name. A
  caller cannot write `../../etc/passwd`, cannot overwrite an existing file by
  guessing its name, and cannot smuggle `.html` past an extension check.
- **An allowlist of types**, by content sniffing and not by extension:
  JPEG, PNG, WebP for images; MP4/M4A, MPEG, WAV, WebM, Ogg for audio.
  Anything else is refused with the detected type in the message.
- **A per-file size cap** and a running total cap for the working directory,
  so an editor session cannot fill the disk one upload at a time. The bundle
  caps bound an archive; nothing currently bounds accumulation.
- **Identical content uploaded twice yields the same `mediaId`** and does not
  duplicate the file. Authors re-upload the same photograph constantly.

Deleting an overlay deliberately does **not** delete its media. Orphans are
already a warning rather than an error on bundle import, for the same reason:
an author mid-edit frequently has media not yet placed, and silently
discarding their uploads is the worse failure. `GET /api/session` gains an
orphan count so the editor can offer a deliberate cleanup.

### 2. Audio recording

A record control in the editor, using the browser's `MediaRecorder`, which
uploads through the same endpoint when stopped.

**The format is whatever the browser produces** — WebM/Opus in Chromium and
Firefox, MP4/AAC in Safari. There is no transcoder available and adding one
would be a large dependency for a local tool. So `audioType()` — the helper
sub-project 2 added so the viewer does not depend on a static host's MIME
table — gains the WebM and Ogg cases, and the upload allowlist accepts them.

The cost is that a tour recorded in Chromium carries WebM audio, which Safari
cannot play. That is a real limitation of recording without transcoding, it
belongs in the decision record, and the honest mitigation is that an author
who needs broad compatibility uploads an `.m4a` they made elsewhere.

Recording needs microphone permission, which is a browser prompt this
environment cannot exercise. Permission denial and the absence of
`MediaRecorder` must both degrade to a clear message rather than a dead
button.

### 3. Overlays that carry media

With upload in place, `legalKindsFor` relaxes: adding an image or audio
overlay becomes "choose a file, or record" and then the overlay is created
with that `mediaId`, anchored at its stop, with an `original` credit
pre-filled from the tour's `defaults`.

The spec for 3a stated an invariant that was not implemented: *if the tour has
no defaults, the editor asks for a creator and licence once and writes them
there.* It is implemented here, because this is the sub-project that creates
the author's own work.

### 4. The acquisition tools

The Python content scripts hold real, hard-won knowledge — which Mapillary
query returns usable panoramas, how to read a Library of Congress result, how
to derive a bearing from where a camera actually stood. They are re-homed as
endpoints the editor calls, not rewritten:

| Endpoint | From | Reaches |
| --- | --- | --- |
| `POST /api/tools/panoramas` | `probe_coverage.py`, `fetch_media.py` | `graph.mapillary.com` |
| `POST /api/tools/places` | `probe_coverage.py` | `overpass-api.de` and mirrors |
| `POST /api/tools/archive-search` | `fetch_rephotos.py` | `www.loc.gov` |
| `POST /api/tools/narrate` | `make_narration.py` | **nothing** — macOS `say`, local |

Narration is local. `make_narration.py` shells out to `say -v Samantha`; the
`support.apple.com` URL in it is a credit link, not an API. It can therefore
be built *and exercised* in the development sandbox, unlike the other three.

**The panorama tool is the important one.** It is what lets a new stop get a
real panorama, and it must return each candidate's **actual position**, because
the editor's heading gate is keyed to exactly that: 3a found that deriving from
`stop.location` instead gives a 178-degree error on the real tour. Selecting a
panorama sets the stop's `panorama.imageId` **and** supplies the position the
gate needs.

Every tool writes its results through the existing document ops and the media
upload path. None of them writes files directly.

### Testing the three that need the network

Tests use `httpx.MockTransport` with captured response shapes. Live calls in a
suite would be flaky, slow, and would spend the author's Mapillary quota on
every `make check`.

Live access to those three hosts has been authorised for **one-off
verification only**, passed per command rather than added to settings — the
project's standing rule is that `.claude/settings.json` gets no persistent
egress allowlist. The verification run is a task of its own and its results
are recorded, because it is the only evidence that the captured shapes match
reality.

### 5. Retiring the pipeline

`content/source/stops.json` and the `make content` target go, along with
`build_tour.py`'s document generation. The scripts' acquisition logic survives
in the tools; what retires is the parallel source of truth.

This closes HANDOFF outstanding item 2 — the hand alignment in `de48b0d` that
`stops.json` had drifted from — because once the document is the only source,
there is nothing left to drift from it. **The author must confirm before this
lands**, since it is the point of no return for the old workflow; until then
`make content` keeps its warning.

`fetch_media.py`'s existing media and `content/media/` stay exactly where they
are; they are reachable through a bundle, and deleting an author's media to
tidy a pipeline would be indefensible.

## Out of scope

Omeka import, AR, themes. Video. Image editing, cropping or rotation.
Transcoding. Multi-tour. Any acquisition source beyond the four above.

## Testing

TDD throughout. The 197 backend and 426 frontend tests stay green.

**Backend.** Upload rejects a traversal name, an executable disguised with an
image extension, an over-large file, and an upload that would exceed the
directory total; identical content twice yields one file and one id; the
stored name is never the client's. Each tool parses a captured response into
the documented shape, surfaces an upstream error as a useful message rather
than a 500, and times out rather than hanging the editor. The panorama tool
returns positions, and a round-trip test asserts that a stop given a panorama
from it produces a heading the gate accepts.

**Frontend.** Upload creates an overlay with the returned `mediaId`; a refused
upload leaves the document untouched and says why; `MediaRecorder` absent or
permission denied degrades to a message; the panorama picker sets both the
stop's `imageId` and the position the gate needs.

**Acceptance.** `make check` green, and then the thing the whole project has
been for: **author a second tour — not Old Town Fairfax — entirely in the
editor, and publish it.** That cannot be done in this sandbox, because no
browser runs here. It is the author's to do, and it is the real test.

## Risks

- **A second untrusted input**, written from client-supplied data. The upload
  rules above are not optional coverage.
- **Recording cannot be exercised here at all** — no browser, no microphone,
  no permission prompt. jsdom can check the degradation paths and the upload
  call; it cannot check that a recording is audible.
- **Three tools whose real behaviour is only verifiable in one authorised
  run**, against services that can change shape without notice.
- **Retiring `make content` is irreversible in practice.** It is gated on the
  author's confirmation for that reason.
