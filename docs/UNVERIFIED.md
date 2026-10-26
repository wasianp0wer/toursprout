# Unverified

Everything here is something nobody has seen work. This is the checklist for
the author's first session with a real browser.

**No browser can launch in the development sandbox** (`docs/ENVIRONMENT.md`:
Chromium dies at a Mach-port check, Firefox cannot spawn a content process).
The editor, with its four surfaces, drag-to-place, inspector, media upload,
microphone recording and acquisition tools, has been built, tested against
jsdom, reviewed, and **never once seen running**. The tests prove the logic.
They cannot prove the pixels, and nothing below has a pixel-level proof.

Only unproven things are listed. What was verified (the live Mapillary and
loc.gov response shapes, the Overpass `[timeout:12]` query, the direct
`tile.loc.gov` image path, the bootstrap procedure in `HANDOFF.md`) is
recorded in the ADRs and `HANDOFF.md`, not here.

## How to use this

Start at 1 and work down; stop at the first failure. The order is by how much
work a failure would invalidate: if the editor does not load, nothing below it
can be tried, and if the viewer does not render, the editor's panorama pane
will not either. Entries 1 to 3 take about ten minutes and decide whether the
rest is worth starting.

Setup for the session: `make serve`, then open the editor's tour as described
in `HANDOFF.md` ("Opening the existing six-stop tour"). That procedure was run
end to end against a live backend with `curl`; the browser half of it was not.

---

## 1. The editor loads at all

- **Unproven:** that `/edit` renders. The lazy editor chunk, the four surfaces,
  and every template have only ever run under jsdom.
- **Why not here:** no browser can launch. (ADR 0003, Costs: "Nothing here has
  been seen in a browser.")
- **Close it:** with the six-stop tour open, go to
  <http://localhost:8000/edit>. Open the browser console first. Pass: the
  outline, map and panorama panes and the inspector all appear and the console
  has no errors. Fail: a blank page or a console error; fix that before
  anything else.

## 2. The viewer still renders after schema v2

- **Unproven:** that `/` shows the tour as it did before schema v2 and the
  editor landed: panorama, ground arrows, the two courthouse photographs as
  planes in the world, opacity sliders, the Leaflet minimap with its gold
  current pin. The viewer predates the editor and was worked on with a browser
  in earlier sessions, but that is an inference from a landmine note
  (`HANDOFF.md`, Current state), not a recorded fact, and schema v2, the
  session API and the editor have all landed since.
- **Why not here:** no WebGL. The jsdom `real-tour.spec.ts` covers everything
  except rendering.
- **Close it:** open <http://localhost:8000/>. Walk to the courthouse stop:
  the 1863 photograph should be ghosted into the street view and its slider
  should fade it. Click a minimap pin; the tour should move. Add `?diag=1` to
  see renderer boundaries in the console.

## 3. The two on-screen changes schema v2 made, which nobody has decided on

- **Unproven:** how they look. At the courthouse the overlay badge now reads
  `IMAGE` instead of `REPHOTO`, and selecting a photograph now also shows an
  `<img>` thumbnail in the panel on top of the ghosted plane
  (`HANDOFF.md`, Outstanding item 7; ADR 0001, Costs). Current behaviour is
  pinned by `stop-panel.spec.ts`; no one has looked at it.
- **Why not here:** no browser.
- **Close it:** on the courthouse stop, select each photograph and look. Keep
  or revert; either way the spec pins the answer, so change the test with it.

## 4. The editor's surfaces work together, and the panorama pane redraws

- **Unproven:** selection syncing across outline, map, panorama and inspector;
  drag on the map moving the footprint and the anchor; the keyboard nudge in
  the panorama pane; undo. Specifically at risk: **mapillary-js renders on
  demand**, so the panorama pane shows nothing new after a mutation unless
  `triggerRerender()` is called (`ENVIRONMENT.md`). That has produced two wrong
  root-cause conclusions already, and an editor mutates the scene constantly.
- **Why not here:** the panes are covered by jsdom and by arithmetic in
  `footprint.ts`, `nudge.ts` and `document-ops.ts`. "Whether a drag feels
  right" and "whether the footprint drawn on the map corresponds to what the
  plane looks like in the panorama" cannot be tested without eyes
  (editing-core spec, Testing).
- **Close it:** select the 1863 courthouse photograph. Drag it on the map and
  watch the plane move in the panorama pane. Press an arrow key in the
  panorama pane. Undo. If the plane lags one edit behind, it is a stale frame:
  look for a missing `triggerRerender()`.

## 5. Rephoto alignment, and that a save survives a reload

- **Unproven:** that the courthouse photographs actually line up, and that an
  aligned result persists. Open since the prototype. The anchors were improved
  by hand in `de48b0d` and are not finished; the stored heading (113 for both)
  disagrees with what a reviewer derived from the hand-tuned anchors (105.0 and
  147.2). `HANDOFF.md`, Outstanding item 1.
- **Why not here:** the render cannot be seen, so whether a roofline aligns
  cannot be judged. The editing-core acceptance was written for exactly this.
- **Close it:** on the 1863 photograph, align it by eye using map, panorama and
  inspector together. Wait for "All changes saved". **Reload.** It must still
  be aligned. Repeat for c.1918. Then decide `HANDOFF.md` item 2 (sync
  `stops.json` or retire the pipeline); until you do, `make content` reverts
  this work.
- **Also see:** the heading gate. Before the panorama has loaded, Derive
  should be refused and switching an overlay to `inWorld` should do nothing.
  Both are covered in jsdom; neither has been seen. Do not loosen the gate if
  it is annoying (ADR 0003).

## 6. Microphone permission flows

- **Unproven:** the whole permission path. Denied, allowed, no microphone, no
  `MediaRecorder`, and **destroy-during-prompt** (leave the editor, or
  discard, while the browser's permission prompt is still open; a late grant
  must release the microphone). Tested with fakes in `recorder.spec.ts` and
  `outline-pane.spec.ts` ("releases a microphone granted after the pane was
  destroyed during the prompt").
- **Why not here:** no browser, no microphone, no permission prompt
  (media spec, Risks).
- **Close it:** in a fresh profile, click Record. (a) Block the prompt: a
  message naming permission appears, not a dead button. (b) Reset the
  permission, click Record, then navigate away from `/edit` with the prompt
  still open and allow it afterwards; the tab's recording indicator must go
  out. (c) Record, stop, and confirm the indicator goes out. The browser's own
  tab indicator is the check; the app shows nothing of its own.

## 7. The recorded-audio round trip, once per browser

- **Unproven:** that what `MediaRecorder` produces passes the upload sniffer
  (`_sniff_type` in `backend/app/media_store.py`). Believed, not known.
  Chromium's EBML header and Firefox's `OggS` pass. **Safari's MP4 brand is the
  risk:** `isom`, `iso5`, `mp42` and `M4A ` pass; `dash` and `cmfc` would be
  refused as "not an allowed type". ADR 0004, Costs.
- **Why not here:** no browser to record in.
- **Close it:** in each of Chromium, Firefox and Safari, record one short clip
  in the editor and let it upload. If it is refused, the brand is the cause.
  Whether or not it is, take the first bytes of the clip you recorded
  (`head -c 64 content/work/media/<clip> | xxd`, or the saved download) and
  commit them as fixtures in `backend/tests/test_media_store.py`, which today
  has only invented headers. If Safari's brand is refused, transcoding before
  `store_media` is the recorded answer (ADR 0004, deferred features).

## 8. What brand does Chromium's own MP4 recording write?

*Not listed in any other document as a question; it follows from entry 7.*

- **Unproven:** the recorder prefers `audio/mp4` whenever
  `MediaRecorder.isTypeSupported('audio/mp4')` is true (`recorder.ts`; ADR
  0004), so a recent Chromium will take that branch rather than WebM. The
  Entry 7 expects Chromium's EBML (WebM); this is the MP4 branch, and no
  record says which brand it writes. If the MP4
  muxer there writes a fragmented-MP4 brand such as `dash` or `cmfc`, the
  recorder's preferred path is the one the sniffer refuses.
- **Why not here:** same as 7; no record of this brand exists anywhere.
- **Close it:** record in Chromium; if the clip's extension is `.m4a`, look at
  bytes 4-12 of the stored file. `ftypisom`, `ftypiso5`, `ftypmp42` or
  `ftypM4A ` pass.

## 9. A published site opens in a browser

- **Unproven:** all of it. `GET /api/session/publish` returns a site that was
  extracted, served once from `python3 -m http.server` during sub-project 2's
  review, and probed with `curl`. **It has never been opened in a browser.**
  Untested with it: `<base href="./">` resolving every asset URL, the viewer
  loading entirely from `tour-data/` with no backend, the Mapillary token in
  `tour-data/config.json` working from a different origin, and Mapillary and
  tile attribution showing.
- **Why not here:** no browser. The jsdom spy "reads everything from tour-data/
  and never touches /api" is the strongest proxy and proves `TourApi` only; the
  bundle-and-publish spec says the author should spot-check a published site
  and that `<base href>` "needs the author's eyes once outside the sandbox."
- **Close it:** `curl localhost:8000/api/session/publish -o site.zip`, unzip it
  into an empty directory, then **stop `make serve`** and run
  `python3 -m http.server` there on another port. Open it. It must work with
  the backend off. Open it from a subdirectory URL too, since `<base href>`
  is what that depends on. Network tab: no request to `/api`.

## 10. Narration plays on a published site

- **Unproven:** that a clip plays from a static host. The `.m4a` MIME fix
  (`mimetypes.add_type` in `main.py`) only reaches the editor's own FastAPI.
  Plain `python3 -m http.server` serves `.m4a` as `audio/mp4a-latm`, and a real
  static host sets its own headers. That is why the viewer carries an explicit
  `<source [type]>` (`audioType` in `tour-api.ts`). Browsers should pick by
  that attribute; this has been confirmed by reading code and serving the
  output, **not by hearing it**. ADR 0002 asks for this check by name.
- **Why not here:** no browser, and nothing to hear with.
- **Close it:** in the site from entry 9, play a narration clip on a stop. Do
  it in Safari as well as Chromium, since Safari is the picky one.

## 11. Narration the editor makes plays too

*Not in any other list.*

- **Unproven:** that a clip made by the `narrate` tool (macOS `say`, then
  ffmpeg to AAC) plays in the editor and in a browser. The backend tool is
  exercised here, since it needs no network; the audio has never been played
  back from a page.
- **Close it:** use the narration tool on a stop, then play the resulting
  overlay in the editor and in the viewer.

## 12. Media upload through the real file picker

*Not in any other list.*

- **Unproven:** the upload flow as an author meets it: the file picker, image
  and audio buttons, the one-time creator-and-licence prompt, the refusal
  message for a bad file. Pinned by jsdom specs
  (`outline-pane.spec.ts`).
- **Why not here:** no browser, so no file picker.
- **Close it:** upload a JPEG and an `.m4a` to a stop. See the overlays appear
  and the credit prompt show once. Then try an `.html` renamed to `.jpg`; it
  must be refused with a message and leave the document alone.

## 13. The acquisition tools, driven from the editor

*The tools' backend shapes were live-checked once; their UI was not seen.*

- **Unproven:** the four tool panels in the editor: panorama picker (it must
  set both the stop's panorama and the position the gate needs), places,
  archive search with thumbnails and download, narration.
- **Why not here:** no browser. The three network tools were run once, from a
  script, against live services on 2026-10-25, never through the editor.
- **Close it:** on a new stop, run the panorama tool near the courthouse
  (needs `MAPILLARY_TOKEN` in `backend/.env`), pick a result, and confirm the
  Derive button then works. Search the archive, download one result.

## 14. Overpass in practice

- **Unproven:** the 45 s timeouts. On 2026-10-25 `overpass-api.de` took 34-42 s
  on every request from one network, including a trivial `node(1)` query, and
  once returned a 502 ("at capacity"). The old 15 s timeout could never
  succeed from there, so it was raised to 45 s **on that single observation**.
  ADR 0004: "adjust it against your own."
- **Why not here:** one network, one afternoon. Overpass latency is the
  upstream's and the network's, not the code's.
- **Close it:** run the places tool from the editor on your own network and
  time it. If it regularly takes more than a few seconds or fails at 45 s, the
  constants near `OVERPASS_MIRRORS` in `backend/app/tools.py` need changing.

## 15. The Overpass mirrors

- **Unproven:** all three fallbacks (`overpass.kumi.systems`,
  `overpass.private.coffee`, `overpass.osm.jp`) have never been called. Only
  `overpass-api.de` was authorised in the live run.
- **Why not here:** the authorisation named one host, and no live call may be
  made from here.
- **Close it:** after entry 14, make the primary fail on purpose (disconnect,
  or temporarily put a bad host first in `OVERPASS_MIRRORS`) and run the places
  tool. A mirror should answer. Check each mirror's response has the same
  `elements` shape.

## 16. `archive-fetch` through a real redirect

- **Unproven:** the per-hop allowlist on a real loc.gov redirect. Unit-tested
  in both directions (allowed hop followed, disallowed hop refused). Real
  `tile.loc.gov` URLs (150 px, 1024 px, IIIF) returned 200 directly, and no
  image URL ever redirected. ADR 0004.
- **Why not here:** no live call may be made, and none redirected in the one
  run that was made.
- **Close it:** download a variety of archive results from the editor, across
  a few searches. If one fails with a redirect refusal, the log shows the hop
  host; decide whether the allowlist (`check_archive_url`, https on `loc.gov`
  or a subdomain) is too strict. loc.gov also reset an HTTP/2 stream twice
  during the live run; a failed fetch you can simply retry is not this bug.

## 17. `make e2e` has never run

*Not in any other list.*

- **Unproven:** the Playwright suite (`frontend/tests/e2e/tour.spec.ts`,
  `fixtures.ts`). It "is correct and complete" by review; it has never launched.
  It covers the viewer only, not the editor.
- **Why not here:** `ENVIRONMENT.md`; it must run outside Claude Code.
- **Close it:** `make e2e` from an ordinary terminal. Its Mapillary and tile stubs
  (`fixtures.ts`) have never met a real page.

## 18. The end-to-end acceptance for the whole authoring application

*Stated in the media spec; not yet attempted.*

- **Unproven:** that the thing this project was rebuilt for works: author a
  second tour, **not Old Town Fairfax**, entirely in the editor, and publish it.
- **Why not here:** no browser. The media-and-acquisition spec says "It is the
  author's to do, and it is the real test."
- **Close it:** last, once 1 to 16 pass. Start from `POST /api/session/new`,
  or the equivalent in the editor, use the tools and a recording, publish, and
  open the result as in entry 9.

---

## Not on this list, deliberately

These are open decisions, not unverified facts: the `stops.json` drift and
whether to retire the pipeline (`HANDOFF.md` item 2), the unreviewed
historical text (item 4), the Marr Monument question (item 5). They need your
judgement, not a browser.
