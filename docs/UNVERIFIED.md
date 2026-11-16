# Unverified

Everything here is something nobody has seen work. This is the checklist for
the author's first session with a real browser.

**No browser can launch in the development sandbox** (`docs/ENVIRONMENT.md`:
Chromium dies at a Mach-port check, Firefox cannot spawn a content process).
**Corrected 2026-11-06.** This file used to say that the editor, the welcome
screen, the drop zone, the close dialog and the microphone recorder had never
been seen running. That overstated it. The author has since viewed the editor
and the welcome screen, and believes the drop zone was exercised. What is
still unseen is the **close dialog** (entries 11 and 12) and the **microphone
recorder** (entries 7 to 9), and neither has been seen in a browser. Entries
that cover the parts now seen are marked below rather than deleted, because
"seen" was an eyeball check and not the pass/fail run each entry describes:
none of it was recorded against its entry. The tests prove the logic. They
cannot prove the pixels, and nothing below has a pixel-level proof.

**The hosted deployment added entries 32 to 36, and entry 32 is the single
highest-risk unverified assumption on that branch.** Start there if the
panorama search does not work on the host.

**The CGI deployment (ADR
[0007](decisions/0007-serve-it-through-cgi.md)) added entries 37 to 40 and
rewrote 33 and 34.** The host has no Passenger, so the application now runs as
CGI behind an Apache front controller.

**2026-11-09/10 closed a great deal of that, and the closures are marked in
place rather than deleted.** Two runs did it. A **production deploy ran to
completion from GitHub Actions on 2026-11-09**, on the one attempt in nine that
reached the host (ADR [0008](decisions/0008-ship-from-a-workstation.md)), and
the author has confirmed that the live site serves and works. Then
`deploy/deploy.sh --target` was **rehearsed against the real host on
2026-11-10** and succeeded. Entries 33, 34, 37, 38 and 41 are rewritten around
that evidence; each says what the run proved and what it did not.

**What is still open about the host, in the order worth caring about:** a
**production** run of `deploy/deploy.sh`, which is the thing that ships from
now on and has never shipped (entry 41); the one-deploy-at-a-time lock against
a real second deploy (entry 41); whether `backend/.env` is reachable by URL,
which is the one remaining `.htaccess` claim with a credential at stake
(entry 38); whether `merge-htaccess.sh` preserves a **real** Directory Privacy
password (entry 34); `index.html`'s missing `no-cache` header, which nothing
has touched (**entry 40**); and CGI under the load of several historians at
once (entry 39).

**Flat (non-360) Mapillary imagery added entry 42, and nothing in it has been
seen at all.** It is the only entry whose first check can send the design back:
if `Image.cameraType` is undefined for a flat image the viewer renders, the
"unknown is spherical" fallback is wrong for exactly the imagery the feature
exists for. Start there if a tester outside the United States reports that a
stop will not face the right way.

**Per-tour theming added entry 43, and nothing in it has been seen at all.**
Its first check is whether the four presets are legible on a real screen.
Three pairs that were not are now measured and fixed by a test that walks
every preset (`theme.spec.ts`, "contrast, for every pair the viewer paints"),
and what the test still records as below AA is Archival's accent on its
attribution bar and on its panorama canvas — a preset value from a mockup,
which no derivation can move. Start there; the rest are the pixels.

Only unproven things are listed. What was verified (the live Mapillary and
loc.gov response shapes, the Overpass `[timeout:12]` query, the direct
`tile.loc.gov` image path, the bootstrap procedure and the example's session
figures in `HANDOFF.md`) is recorded in the ADRs and `HANDOFF.md`, not here.

## How to use this

Start at 1 and work down; stop at the first failure. The order is by how much
work a failure would invalidate: if nothing can be opened, nothing can be
looked at; if the editor does not load, nothing below it can be tried; and if
the viewer does not render, the editor's panorama pane will not either.
Entries 1 to 4 take about fifteen minutes and decide whether the rest is worth
starting.

Setup for the session: `make serve`, then entry 1, which *is* the setup —
opening the six-stop tour is now one click on the welcome screen rather than a
`curl` and two `cp`s. The headless sequence is still in `HANDOFF.md`
("Opening the existing six-stop tour", under "The headless fallback") if you
want a tour open before you start, and its backend half was run end to end
against a live backend; the browser half of all of it was not.

**The numbering moved on 2026-10-26**, when the welcome screen landed and the
front-door entries went in at the top. An older document citing an entry by
number means the old numbering: what was entry 2 (the viewer) is now entry 3,
and what was entry 9 (a published site) is now entry 19.

---

## 1. The front door, and the example that opens in one click

*Partly seen: the author has viewed the welcome screen (2026-11-06). Whether
the example's button lands in the editor with six stops was not recorded.*

- **Unproven:** that `/` shows the welcome screen when nothing is open, that
  the shelf lists *Old Town Fairfax*, and that clicking it lands in the editor
  with the tour in it. This is what the whole front door was built for, and it
  is also the setup for everything below: it replaces the `curl`-plus-two-`cp`s
  procedure `HANDOFF.md` used to open with.
- **Why not here:** no browser. `EntryPage`'s probe, the deferred welcome
  chunk and the example button have only ever run under jsdom. The backend
  half *was* run live, on a throwaway backend with a temporary `CONTENT_DIR`:
  `POST /api/session/examples/fairfax-old-town` answers `"stopCount": 6`,
  `"mediaCount": 15`, `"orphanCount": 6` and six panorama warnings, and
  `test_opening_the_fairfax_example_matches_the_recorded_figures` pins those
  figures and the surviving `media/pano/` paths. What nobody has seen is the
  screen.
- **Close it:** with nothing open — if a tour is open, close it first (entry
  11) or `curl -c jar.txt -b jar.txt -X DELETE localhost:8000/api/session` — open
  <http://localhost:8000/>. Pass: a drop zone, a *New empty tour* box, *Old
  Town Fairfax* under "Open an example", and the five guide titles down the
  right, which do nothing by design. Click the example. Pass: you arrive at
  `/edit` with six stops in the outline, and the close dialog (entry 11)
  reports 6 stops and 15 media files. Fail: if `/` shows the viewer's *"No
  tour is open. Go to the start screen at / to create one, import a bundle, or
  open the example."*, the probe decided there is no backend and revealed the
  viewer — the Network tab's `/api/session` says why. Note the circularity
  while you are there: that message sends you to `/`, which is where you
  already are. In that state the real fault is `/api/session` not answering,
  which the viewer has no way to know.

## 2. The editor loads at all

*Partly seen: the author has viewed the editor (2026-11-06). Whether the
console was clean was not recorded.*

- **Unproven:** that `/edit` renders. The lazy editor chunk, the four surfaces,
  and every template have only ever run under jsdom.
- **Why not here:** no browser can launch. (ADR 0003, Costs: "Nothing here has
  been seen in a browser.")
- **Close it:** with the six-stop tour open, go to
  <http://localhost:8000/edit>. Open the browser console first. Pass: the
  outline, map and panorama panes and the inspector all appear and the console
  has no errors. Fail: a blank page or a console error; fix that before
  anything else.

## 3. The viewer still renders after schema v2

- **Unproven:** that the viewer shows the tour as it did before schema v2 and
  the editor landed: panorama, ground arrows, the two courthouse photographs as
  planes in the world, opacity sliders, the Leaflet minimap with its gold
  current pin. The viewer predates the editor and was worked on with a browser
  in earlier sessions, but that is an inference from a landmine note
  (`HANDOFF.md`, Current state), not a recorded fact, and schema v2, the
  session API, the editor and the front door have all landed since.
- **Why not here:** no WebGL. The jsdom `real-tour.spec.ts` covers everything
  except rendering.
- **Close it:** open <http://localhost:8000/view>. **Not `/`** — with a tour
  open, `/` now goes to the editor; `/view` is the URL that means "show me the
  tour as a reader sees it". Walk to the courthouse stop: the 1863 photograph
  should be ghosted into the street view and its slider should fade it. Click a
  minimap pin; the tour should move. Add `?diag=1` to see renderer boundaries
  in the console.
- **Also close the pin hit test here**, which is the one thing on this list a
  browser is strictly required for: jsdom has no layout, so no test in the
  repo can see two pins overlap. On the courthouse stop, the Marr Monument's
  pin centre sits 15 px from the gold pin's at zoom 17 (14.6 m, 0.93 m/px) —
  the two circles visibly touch. Click the monument's pin **once, anywhere on
  it, including the edge nearest the gold pin**. Pass: the tour moves to stop
  2 on that first click. Fail (the bug fixed in this branch): the first click
  does nothing and a second, further from the gold pin, works. Then do it in
  reverse from stop 2 back to stop 1, and check the numbers sit centred in
  their circles rather than 2 px down and right.

## 4. The two on-screen changes schema v2 made, which nobody has decided on

- **Unproven:** how they look. At the courthouse the overlay badge now reads
  `IMAGE` instead of `REPHOTO`, and selecting a photograph now also shows an
  `<img>` thumbnail in the panel on top of the ghosted plane
  (`HANDOFF.md`, Outstanding item 7; ADR 0001, Costs). Current behaviour is
  pinned by `stop-panel.spec.ts`; no one has looked at it.
- **Why not here:** no browser.
- **Close it:** on the courthouse stop, select each photograph and look. Keep
  or revert; either way the spec pins the answer, so change the test with it.

## 5. The editor's surfaces work together, and the panorama pane redraws

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

## 6. Rephoto alignment, and that a save survives a reload

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

## 7. Microphone permission flows

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

## 8. The recorded-audio round trip, once per browser

- **Unproven:** that what `MediaRecorder` produces passes the upload sniffer
  (`_sniff_type` in `backend/app/media_store.py`). Believed, not known.
  Firefox's `OggS` passes. Chromium's EBML (WebM) header also passes, but
  the recorder prefers MP4 wherever the browser supports it, so a recent
  Chromium most likely records MP4 and never produces the EBML path; see
  entry 9. **Safari's MP4 brand is the risk, and Chromium's may be too:** `isom`, `iso5`, `mp42` and `M4A ` pass; `dash` and `cmfc` would be
  refused as "not an allowed type". ADR 0004, Costs.
- **Why not here:** no browser to record in.
- **Close it:** in each of Chromium, Firefox and Safari, record one short clip
  in the editor and let it upload. If it is refused, the brand is the cause.
  Whether or not it is, take the first bytes of the clip you recorded
  (`head -c 64 $SESSIONS_DIR/<sid>/media/<clip> | xxd`, where `<sid>` is the Recovery key shown in the editor, or the saved download) and
  commit them as fixtures in `backend/tests/test_media_store.py`, which today
  has only invented headers. If Safari's brand is refused, transcoding before
  `store_media` is the recorded answer (ADR 0004, deferred features).

## 9. What brand does Chromium's own MP4 recording write?

*Not listed in any other document as a question; it follows from entry 8, and the two are best checked in the same recording.*

- **Unproven:** the recorder prefers `audio/mp4` whenever
  `MediaRecorder.isTypeSupported('audio/mp4')` is true (`recorder.ts`; ADR
  0004), so a recent Chromium will take that branch rather than WebM. The
  ADR 0004 only vouches for Chromium's WebM (EBML) header, which this
  preference makes the less likely path, and no record says which brand
  Chromium's MP4 writes. If its MP4 muxer writes a fragmented-MP4 brand such as `dash` or `cmfc`, the
  recorder's preferred path is the one the sniffer refuses.
- **Why not here:** same as 8; no record of this brand exists anywhere.
- **Close it:** record in Chromium; if the clip's extension is `.m4a`, look at
  bytes 4-12 of the stored file. `ftypisom`, `ftypiso5`, `ftypmp42` or
  `ftypM4A ` pass.

## 10. *Preview* reaches the viewer as a full page load

- **Unproven:** that the editor's top-bar *Preview* link works. It is a plain
  `<a href="/view" data-preview>` and not a `routerLink` on purpose — the full
  document load is what guarantees the viewer bootstraps `tour-data/` afresh,
  which is what a preview is for — so it tears the editor down, and a browser
  is the only place that can be watched. Two things to look at while there:
  the `href` is root-absolute, so it assumes the app is served at the origin
  root (which `make serve` is), and autosave is debounced 500 ms, so a preview
  opened in the same instant as a keystroke can legitimately show the document
  as of the previous save.
- **Why not here:** no browser, and jsdom does not navigate. The spec can only
  assert the element's `href`.
- **Close it:** from the editor, click *Preview*. Pass: the viewer at `/view`,
  showing the tour you were editing, with your last saved edit in it. Then go
  back: the editor reloads from the session, which is entry 2 again.

## 11. The close dialog

- **Unproven:** all of it, and this is the one place on the front door where a
  failure loses data. The dialog is what stands between *Close tour* and
  deleting the working directory, which is the only copy of the tour that
  exists anywhere. Unseen: that it appears over the editor and takes focus
  (the panel itself, not a button, so a stray Return cannot press anything);
  that it names the tour, its stop count and its media count; that *Close and
  delete* is disabled until the author has either downloaded the bundle
  (entry 12) or ticked "I know this tour will be deleted"; that *Keep working*
  and Escape both back out with nothing done; and that confirming lands back
  on the welcome screen with no "Save failed" flashing up on the way.
- **Why not here:** no browser. The gating, the ordering (autosave stopped
  before the `DELETE`, draft cleared after it) and the no-late-"Save failed"
  rule are all pinned in `close-dialog.spec.ts` and `editor-page.spec.ts`;
  what nobody has seen is the dialog.
- **Close it:** with the Fairfax example open (entry 1), click *Close tour*.
  Pass: the figures match what entry 1 reported (6 stops, 15 media files),
  *Close and delete* is dead, and Escape backs out with the editor exactly as
  it was. Then reopen it and do **entry 12 first** — the download is the other
  thing that arms the gate, and you want the bundle before you destroy the
  working copy. Come back here and confirm: *Close and delete* is now live,
  pressing it lands you on the welcome screen, no "Save failed" appears a
  second later, and the session directory (`$SESSIONS_DIR/<sid>/`) is gone. Tick the acknowledgement instead
  of downloading, on a tour you do not mind losing, to check that half too.

## 12. The blob download out of the close dialog

*The editor's top-bar *Export bundle* link is unaffected and stays a plain
`<a download>`; this is only the dialog's copy of it.*

- **Unproven:** that *Download tour.zip* actually puts a file on disk. It is
  not a link: the dialog fetches `GET /api/session/export` as a blob so that
  the transfer resolving is the signal that releases the gate and `blob.size`
  is the size it shows. That means an object URL, an anchor created in script,
  appended to the document, clicked, removed, and the URL revoked a second
  later — a sequence with several browser-dependent steps and no test that can
  see a download happen.
- **Why not here:** jsdom has no download. The spec stubs `createObjectURL`
  and pins three things: the anchor was in the document when it was clicked,
  it is gone again afterwards, and the URL was **not** revoked in the same
  tick (`expect(revoke).not.toHaveBeenCalled()`) — a big archive takes longer
  than a tick, and revoking early cancels the save. Note what that leaves
  open: **no test anywhere asserts the URL is ever revoked**, so the
  `setTimeout` in `offerToSave` is unproven in both directions. Whether the
  browser saves a 4.5 MB archive from any of it is the rest of the gap.
- **Close it:** in the close dialog for the Fairfax tour, click *Download
  tour.zip*. Pass: a `tour.zip` of about 4.5 MB in your downloads (4,536,271
  bytes for that tour, exported live), the dialog reporting that size, and
  *Close and delete* now live. Keep the file — entry 13 needs it. Then finish
  entry 11, and afterwards re-import the bundle
  (`curl -X POST localhost:8000/api/session/import -F file=@tour.zip`) to
  check it comes back with 6 stops and 15 media files. No `force` needed:
  finishing entry 11 closed the tour, and `import` now refuses while one is
  open. Fail: a saved file of 0
  bytes or a truncated archive means the object URL was revoked too early —
  `REVOKE_DELAY_MS` in `close-dialog.ts`.

## 13. A real `.zip` dragged onto the drop zone

*Entries 13 to 18 are the drop zone. The author believes it was exercised
(2026-11-06) but did not record which of these gestures were tried, so they
stay listed until each has a result written against it.*

- **Unproven:** that dragging a bundle onto the dashed area imports it. The
  drop handler reads a single `.zip` straight out of `DataTransfer` and posts
  it to `/api/session/import` — without `force`, deliberately, so a drop onto
  a stale welcome screen is refused rather than replacing another tab's tour.
- **Why not here:** no browser, so no drag. jsdom specs build a `DataTransfer`
  by hand, which proves the sorting and the posting, not the gesture.
- **Close it:** entries 11 and 12 together leave you with a `tour.zip` and
  nothing open, which is exactly the state this needs. Drag that `tour.zip`
  onto the drop zone. Pass: the dashed area highlights while the file is over
  it, "Opening…" appears, and you land in the editor with the tour. Then close
  again and drag a `.zip` that is **not** a tour bundle: pass is the backend's
  own refusal shown on the welcome screen, with the screen still usable and
  nothing open.

## 14. A real folder dragged onto the drop zone

- **Unproven:** that dragging a folder yields the files *and their paths*. A
  dropped directory cannot be read from `DataTransfer.files` at all — that
  list holds only files, with the directories thrown away — so the handler
  uses `webkitGetAsEntry` and walks it, batching `readEntries` (Chrome caps a
  batch at 100). The paths are the whole point: the repository's own tour
  references six panoramas as `media/pano/pano-*.jpg`, and a flattened drop
  imports a document pointing at files that are not where it says.
- **Why not here:** no browser. `dropped-files.spec.ts` builds the entry
  objects by hand, so every shape it walks is one this project invented and
  assumes a browser produces.
- **Close it:** with nothing open (entry 13 left a tour open; close it with
  entry 11 or `curl -c jar.txt -b jar.txt -X DELETE localhost:8000/api/session`), build the folder a
  loose drop expects and drag it onto the zone:

  ```sh
  mkdir -p /tmp/fairfax
  cp content/tours/fairfax-old-town.json /tmp/fairfax/tour.json
  cp -R content/media /tmp/fairfax/
  ```

  Pass: 6 stops and 15 media files in the editor, and
  `$SESSIONS_DIR/<sid>/media/pano/` (the sid is the Recovery key) holding the six panoramas under their original
  names.

  **Drag that folder, not `content/` itself — and the reason is a trap, not a
  refusal.** Dragging `content/` is *accepted*: the frozen example's
  `content/examples/fairfax-old-town/tour.json` is the only `tour.json` in
  there once nothing is open (the session directory does not exist or holds no
  `tour.json` — closing removes the whole directory, and "open" *is* the
  session's `tour.json` existing), and
  `content/media/` supplies the media, so the screen reports 6 stops and 15
  media files. That is character for character the pass criteria above, from a
  drop that tells you nothing about the folder you meant to test. The
  duplicate-path refusal only arises with a session `tour.json` present, which
  cannot happen while the welcome screen is reachable at all. So check *which*
  folder you dropped, not only what the editor says afterwards.

## 15. macOS AppleDouble `._*` sidecars in a real folder drag

*Not in any other list; it is why the frontend filters dot-prefixed path
components at all.*

- **Unproven:** that a real folder drag yields the `._*` files, and that
  skipping them is therefore load-bearing rather than theoretical. macOS
  writes an AppleDouble `._court-1863.jpg` beside the real file whenever the
  media has been on exFAT, FAT or SMB, or round-tripped through a non-HFS
  volume — which is exactly how photographs travel between a scanner, a laptop
  and an archive. **Finder does not show them**, so the author cannot see them
  in what they drag. They carry the real file's `.jpg`, so an extension test
  waves them through, and the backend then refuses the *whole* drop:
  `a hidden file cannot be part of a tour: media/._court-1863.jpg` (verified
  live against the import-files route). `belongsInATour` in
  `dropped-files.ts` skips any dot-prefixed component for this reason.
- **Why not here:** no browser, and no drag. Whether the browser's directory
  walk even reports them is the unproven half.
- **Close it:** entry 14 left a tour open, so close it first (entry 11, or
  `curl -c jar.txt -b jar.txt -X DELETE localhost:8000/api/session`) — every drop needs the welcome
  screen, which is only reachable with nothing open. Then `ls -a` the folder
  from entry 14 to see whether any sidecars exist; if none do, make one with
  real bytes so the backend's refusal is actually
  reachable (`cp /tmp/fairfax/media/court-1863.jpg
  /tmp/fairfax/media/._court-1863.jpg`), or copy the folder to a FAT-formatted
  stick and back. Drag it. Pass: the import succeeds with 15 media files, and
  if the browser reported the sidecar at all it is named in the skipped notice.
  Fail: a 400 naming a `._*` file means the filter missed it.

## 16. The skipped-file notice names what it left out

- **Unproven:** that the author can tell what did not go. This is the landmine
  the whole feature exists to remove: `content/media/` holds a `manifest.json`
  beside the photographs, the old `cp content/media/*` step swept it in, and
  the import refuses a bundle that contains it (verified live: `not an allowed
  image or audio type: media/manifest.json`). The welcome screen filters it
  out before posting and shows "Left out, because these cannot be part of a
  tour: …". The notice is not an error — the rest of the drop went.
- **The wording wrinkle this entry used to describe has been fixed.** The
  notice said "because a tour's media folder may hold only images and audio",
  which is one reason for two different filters: `belongsInATour` skips a file
  either because its extension is not media *or* because some component of its
  path begins with a dot, and an AppleDouble `._court-1863.jpg` (entry 15) was
  then explained away as something that is not an image — which it is. It now
  gives the general reason instead, which covers both filters and the
  unaccompanied `.zip` that also lands in this list. What remains unverified
  is only whether the notice is legible and noticed.
- **Why not here:** no browser; `welcome-page.spec.ts` asserts the notice's
  text, not that it is legible or noticed.
- **Close it:** in the folder drag of entry 14, the notice must appear and must
  name the manifest (by the path you dropped it under —
  `fairfax/media/manifest.json`, not a bare name). Pass: the tour opens *and*
  the notice is there. Fail,
  and worse than a refusal: the tour opens with no notice, so an author whose
  media was silently dropped has no way to know.

## 17. The browse-a-folder path

- **Unproven:** that Chrome's `webkitdirectory` input yields the
  `webkitRelativePath` values the code models — each one beginning with the
  chosen folder's own name, with `content/media/`'s `pano/` subdirectory as
  the case to look at. `webkitdirectory` is non-standard, and this is the only
  browse path that can preserve the nesting: the plain *choose files* input
  gives a flat list with an empty `webkitRelativePath`, which is why there are
  two buttons.
- **Why not here:** no browser, so no file picker. The spec feeds `File`
  objects with `webkitRelativePath` set by hand.
- **Close it:** close whatever entry 15 left open (entry 11, or
  `curl -c jar.txt -b jar.txt -X DELETE localhost:8000/api/session`), then click *choose a folder*,
  pick the folder from entry 14, and confirm the same result: 6 stops, 15
  media files, `media/pano/` intact. The flat *choose files* half below needs
  nothing open again, so close once more between the two.
- **The landmine here is closed, and this is what it was.** A flat selection
  used **not** to get refused. Panoramas were referenced by each stop's
  `cachedPath`, and `bundle.missing_media` only checked overlay `mediaId`s,
  so `tour.json` plus the nine top-level files imported cleanly — verified
  live at the time: `200`, `"mediaCount": 9`, `"orphanCount": 0`, no
  warnings — and the six panoramas were simply absent, 404ing in the viewer
  later. Schema v3 renamed the field to `cachedMediaId` and gave both kinds
  of reference one collector, so a flat selection is now refused by name:
  `the bundle is missing media its tour references: pano/pano-<stop>.jpg`
  (ADR 0005). **Still worth checking the number — 15, not 9 — because that
  refusal has only been seen from the test suite, never from a browser's file
  picker**, which is the half of this entry that remains unverified.

## 18. The stray-drop guard

- **Unproven:** that releasing a file just outside the dashed border does
  nothing. A drag the page does not `preventDefault` is a navigation: Chrome
  leaves the app and opens the dropped file, so a `.zip` released a few pixels
  low would replace the welcome screen with a download and the application
  would simply be gone — on the one screen whose job is a first impression.
  `WelcomePage` binds `window:dragover` and `window:drop` and calls only
  `preventDefault`, deliberately: a near miss does nothing and the author
  tries again, rather than the whole page quietly becoming a drop target.
  Narrowed since: it skips a drag over an `input` or `textarea`, so text can
  still be dropped into the *New empty tour* title box, and it answers
  `dragover` only for a drag carrying files, so a drag of selected text does
  not give the whole page a "you may drop here" cursor.
- **Why not here:** jsdom has no default drop behaviour to prevent, so the
  spec can only assert that `preventDefault` was or was not called.
- **Close it:** back to the welcome screen once more (entry 17's flat
  selection will have opened a tour), then drop a `.zip` on the guides column,
  and again on the page margin. Pass: nothing happens and the welcome screen
  is still there. Fail: the browser navigates to the file. Then select some
  text on the page and drag it: the cursor must not say the margin accepts it,
  and dropping it into the title box must type it there.

## 19. A published site opens in a browser

- **Unproven:** all of it. `GET /api/session/publish` returns a site that was
  extracted, served once from `python3 -m http.server` during sub-project 2's
  review, and probed with `curl`. **It has never been opened in a browser.**
  Untested with it: `<base href="./">` resolving every asset URL, the viewer
  loading entirely from `tour-data/` with no backend, the Mapillary token in
  `tour-data/config.json` working from a different origin, and Mapillary and
  tile attribution showing. New since the front door: `/` on a published site
  is no longer the viewer directly but `EntryPage`, which probes
  `/api/session`, gets nothing, and reveals the viewer it already mounted —
  see entries 20 to 22, which are the parts of that worth checking separately.
- **Why not here:** no browser. The jsdom spy "reads everything from tour-data/
  and never touches /api" is the strongest proxy and proves `TourApi` only; the
  bundle-and-publish spec says the author should spot-check a published site
  and that `<base href>` "needs the author's eyes once outside the sandbox."
- **Close it:** `curl localhost:8000/api/session/publish -o site.zip`, unzip it
  into an empty directory, then **stop `make serve`** and run
  `python3 -m http.server` there on another port. Open it. (Its root, not
  `/view`: a plain static server has no SPA rewriting, so only `/` and
  `index.html` resolve.) It must work with the backend off. Open it from a
  subdirectory URL too, since `<base href>` is what that depends on. Network
  tab: one failed `/api/session` from the probe, and nothing else to `/api`.

## 20. The probing wrapper's layout on a real published build

*The most likely way the front door breaks a published site, and the hazard
runs in the direction that is easy to get backwards.*

- **Unproven:** that the viewer is correctly **sized** after the reveal. The
  danger is not that hiding fails; it is that hiding works too well. The
  viewer is mounted and hidden while the probe runs, and its `tour-data/`
  fetches usually resolve first, so `ViewerPage.ready()` flips while the
  wrapper is still hidden and `MapPane` builds its Leaflet map against
  whatever box the wrapper has. With `display: none` that box is 0×0, and
  **nothing in `frontend/src` ever calls `invalidateSize` or watches for a
  resize** — pinned by `entry-page.spec.ts`'s *"still has nothing that
  recovers a map measured at the wrong size"*, not merely searched for once —
  so the map would stay grey for good after the reveal. Hence `.viewer-slot[hidden] { display: block; visibility: hidden;
  pointer-events: none }` — the `display: block` is load-bearing, overriding
  the UA stylesheet's `[hidden] { display: none }` by hand, and the
  `visibility: hidden` is what keeps the box and its size.
- **Why not here:** jsdom computes no layout. `entry-page.spec.ts` reads the
  CSS file as text and fails if `display: none` appears in that rule or if
  `display: block` and `visibility: hidden` do not, which pins the intent and
  proves nothing about a rendered page. (`pointer-events` is not checked.)
- **Close it:** on a published build whose `/api/session` *hangs* rather than
  refusing (entry 21 sets one up), wait out the deadline and then look at the
  map and the panorama. Pass: both are correctly sized and interactive. Fail:
  a grey or clipped minimap, or a panorama at the wrong aspect, means the
  viewer measured a box it did not end up with — the fix is to add an
  `invalidateSize` on reveal rather than to weaken the CSS. Adding one fails
  the guard test named above **on purpose**: delete it and correct the three
  documents that currently say there is no recovery (`ARCHITECTURE.md`,
  `CHANGING-THINGS.md` and this entry).

## 21. The 2 s probe deadline against a host that black-holes `/api/session`

- **Unproven:** the deadline against a real one. A refused connection resolves
  in single-digit milliseconds, which is the normal published case and the one
  that is easy to try. A static host is equally free to accept the connection
  and never answer — and `SESSION_PROBE_TIMEOUT_MS` (2000, in
  `entry-page.ts`) exists so that visitor is not left staring at a hidden
  viewer until the browser's own connection timeout, which is minutes on some
  networks.
- **Why not here:** jsdom plus a fake clock. `entry-page.spec.ts` covers a
  probe that never settles, which proves the timeout operator is wired up, not
  that two seconds is the right number against a real host.
- **Close it:** serve a published build behind something that swallows
  `/api/session` — a reverse proxy pointed at a dead upstream, or an `iptables
  DROP` — and open it. Pass: the tour appears after about two seconds and
  nothing in the console suggests a backend. If real hosts turn out to be
  slower than that, the constant is the thing to change, not the design.

## 22. What a black-holed probe costs the published visitor

*Written down because it is a deliberate trade, not a bug, and the next person
to see it should not have to rediscover that.*

- **Unproven:** how bad it looks. In the case above the visitor sees a **blank
  page for the full two seconds**. The viewer is mounted and loading behind
  the scenes, but it is `visibility: hidden`, so its own "Loading the tour…"
  does not show — where before the front door existed, `''` was the viewer and
  painted that line immediately.
- **Why this is the right trade anyway:** revealing the viewer on `ready()`
  instead of on the probe would flash the tour, or an authoring checkout's "no
  tour is open" message, in front of an author on their way to `/edit`. That
  was judged the worse failure. But it is the published visitor's real cost,
  and the honest place for it is here rather than in a bug report.
- **Close it:** look at the blank two seconds from entry 21 and decide. If it
  reads as broken, the fix is a quiet neutral placeholder in the `probing`
  branch of `entry-page.html` — not revealing the viewer early.

## 23. Narration plays on a published site

- **Unproven:** that a clip plays from a static host. The `.m4a` MIME fix
  (`mimetypes.add_type` in `main.py`) only reaches the editor's own FastAPI.
  Plain `python3 -m http.server` serves `.m4a` as `audio/mp4a-latm`, and a real
  static host sets its own headers. That is why the viewer carries an explicit
  `<source [type]>` (`audioType` in `tour-api.ts`). Browsers should pick by
  that attribute; this has been confirmed by reading code and serving the
  output, **not by hearing it**. ADR 0002 asks for this check by name.
- **Why not here:** no browser, and nothing to hear with.
- **Close it:** in the site from entry 19, play a narration clip on a stop. Do
  it in Safari as well as Chromium, since Safari is the picky one.

## 24. Narration the editor makes plays too

*Not in any other list.*

- **Superseded.** The `narrate` tool (macOS `say`, then ffmpeg) was removed
  from the editor, because neither exists on the host or on a Windows laptop
  (ADR 0006). What is still unproven is the same question for a clip the
  historian records with the microphone: entries 7 to 9.

## 25. Media upload through the real file picker

*Not in any other list.*

- **Unproven:** the upload flow as an author meets it: the file picker, image
  and audio buttons, the one-time creator-and-licence prompt, the refusal
  message for a bad file. Pinned by jsdom specs
  (`outline-pane.spec.ts`).
- **Why not here:** no browser, so no file picker.
- **Close it:** upload a JPEG and an `.m4a` to a stop. See the overlays appear
  and the credit prompt show once. Then try an `.html` renamed to `.jpg`; it
  must be refused with a message and leave the document alone.

## 26. The acquisition tools, driven from the editor

*The tools' backend shapes were live-checked once; their UI was not seen.
Two of the four were removed on 2026-11-06 (ADR 0006): archive search and
narration. Panorama search now runs in the browser: see entry 32.*

- **Unproven:** the two panels that remain: the panorama picker (it must set
  both the stop's panorama and the position the gate needs) and places.
- **Why not here:** no browser. The network tools were run once, from a
  script, against live services on 2026-10-25, never through the editor.
- **Close it:** on a new stop, run the panorama search near the courthouse
  (needs `MAPILLARY_TOKEN`), pick a result, and confirm the Derive button then
  works. Run place search.

## 27. Overpass in practice

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

## 28. The Overpass mirrors

- **Unproven:** all three fallbacks (`overpass.kumi.systems`,
  `overpass.private.coffee`, `overpass.osm.jp`) have never been called. Only
  `overpass-api.de` was authorised in the live run.
- **Why not here:** the authorisation named one host, and no live call may be
  made from here.
- **Close it:** after entry 27, make the primary fail on purpose (disconnect,
  or temporarily put a bad host first in `OVERPASS_MIRRORS`) and run the places
  tool. A mirror should answer. Check each mirror's response has the same
  `elements` shape.

## 29. `archive-fetch` through a real redirect

- **Superseded.** `archive-fetch` and archive search were removed because
  `www.loc.gov` answers the host with 403 (ADR 0006). The entry below is kept
  as the record of what was unproven when it went.

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

## 30. `make e2e` has never run

*Not in any other list.*

- **Unproven:** the Playwright suite (`frontend/tests/e2e/tour.spec.ts`,
  `fixtures.ts`). It "is correct and complete" by review; it has never launched.
  It covers the viewer only, not the editor. Note that it predates the front
  door, so whatever it opens at `/` now goes through `EntryPage`'s probe
  first — if it fails, that is the first thing to look at.
- **Why not here:** `ENVIRONMENT.md`; it must run outside Claude Code.
- **Close it:** `make e2e` from an ordinary terminal. Its Mapillary and tile stubs
  (`fixtures.ts`) have never met a real page.

## 31. The end-to-end acceptance for the whole authoring application

*Stated in the media spec; not yet attempted.*

- **Unproven:** that the thing this project was rebuilt for works: author a
  second tour, **not Old Town Fairfax**, entirely in the editor, and publish it.
- **Why not here:** no browser. The media-and-acquisition spec says "It is the
  author's to do, and it is the real test."
- **Close it:** last, once 1 to 30 pass. Start from the welcome screen's *New
  empty tour*, use the tools and a recording, publish, and open the result as
  in entry 19.

---

## 32. Whether a browser may call `graph.mapillary.com` directly

*The highest-risk unverified assumption on the hosted-deployment branch.*

- **Unproven:** that `MapillarySearch` (`frontend/src/app/core/mapillary-search.ts`)
  works. It is a plain Angular `HttpClient` GET to
  `https://graph.mapillary.com/images`, with the token as an `access_token`
  query parameter and no custom header, because the host cannot reach Mapillary
  and the search had to move to the browser. The design leaned on the fact that
  `mapillary-js` already calls Mapillary from the browser to render
  panoramas. That is evidence about `mapillary-js`'s own requests, not about
  this one: whether Mapillary's CORS headers let a page read the response to a
  `fetch`/XHR of ours is a separate fact about their server.
- **Why not here:** nothing in a unit test can show it. There is **no CSP
  anywhere in the repository**, so nothing blocks the call from our side
  (`grep` for `Content-Security-Policy` in `backend/app` and `frontend/src`
  finds nothing), but a CORS refusal is the browser's decision, made at
  runtime against Mapillary's response headers. The specs use a mocked
  `HttpClient`.
- **Close it:** open the editor on a real page with the Network tab and
  console open and run the panorama search on a stop with a token configured.
  Pass: a `200` from `graph.mapillary.com/images` and candidates listed. Fail:
  the console says the request was blocked by CORS policy (the Network entry
  shows no readable response), and the editor's message reads "could not reach
  Mapillary". If it fails, panorama search needs a different route, and a
  server proxy is not one: the host cannot reach Mapillary. That is a design
  decision for the author, not a fix to make in passing.

## 33. The CGI path on the host

*Rewritten 2026-11-09. This entry used to say that `passenger_wsgi.py` had
never started under Passenger and that `a2wsgi` could not be installed in the
development environment. Both are out of date: there is no Passenger on this
host (ADR [0007](decisions/0007-serve-it-through-cgi.md)), `passenger_wsgi.py`
is gone, and `a2wsgi` **is** installed here now (`f708161`).*

- **Proven here, which is new:** the bridge itself.
  `backend/tests/test_cgi.py` runs on every `make backend-test` and exercises
  the whole ASGI→WSGI→CGI path — `cgi_environ`'s reading of `REQUEST_URI`, a
  request body, a historian's own media through `/tour-data`, a
  percent-encoded and a malformed path, and a crash before the headers are
  written. `a2wsgi` does not run the ASGI lifespan, which is why
  `app.state.cfg` is set in `create_app`'s body.
- **Proven on the host, 2026-11-09, and this is the entry's main business
  now.** A production deploy ran to completion and the author has confirmed
  that the live site serves and works. That one fact settles the whole chain
  this entry listed as guesswork: **Apache executes `app.cgi`**, so the mode
  survived the deploy and `AddHandler cgi-script .cgi` with `Options +ExecCGI`
  are permitted rather than 500ing the tree or serving the wrapper as text;
  `"$DIR/.venv/bin/python"` resolves from `app.cgi`'s own `$0` under Apache's
  CGI invocation; and the venv at `$DEPLOY_PATH/.venv` holds every dependency
  the application imports, installed there by the host's own pip 23.2.1 from
  the exported `requirements.txt`. A missing dependency or an unresolvable
  interpreter is a 500 on every URL, and the site is not 500ing.
- **Still unproven:** that the error log the wrapper writes its tracebacks to
  can be found at all. Where this host puts it is still unverified
  (`docs/DEPLOY.md`, *Reading the error log*), and nothing about a working site
  says anything about where it reports a broken one. That is the half of this
  entry that only a deliberate failure can close.
- **Why it could not be done here:** there is no Apache and no 3.12
  interpreter in the development sandbox. A test can run the Python; nothing
  here can run the web server. That is still true, and is why the host was the
  only way to settle it.
- **Close the rest of it:** `docs/DEPLOY.md` step 7, checks 1 and 2, on any
  **new** subdomain, since what Apache permits is per-directory configuration.
  `curl -s https://STAGING/api/health` must answer `{"status":"ok"}` and
  `curl -s https://STAGING/api/session/examples` must answer the example
  list — the second one is what proves the whole application imported, the
  settings loaded and `content/` arrived. "Premature end of script headers",
  a blank page, or `app.cgi`'s own source text in the response body are each a
  different failure, and step 7 says which is which. For the error log, make
  the application fail on purpose once and go looking.

## 34. The deploy pipeline

*Rewritten 2026-11-09 for the CGI pipeline. The CloudLinux virtualenv guess
is gone: there is no "Setup Python App" on this host, so there is no
`~/virtualenv/<app>/<version>/` to find. The venv is created by hand at
`$DEPLOY_PATH/.venv` (`docs/DEPLOY.md` step 4) and the deploy only installs
into it.*

*Rewritten again 2026-11-10: **the pipeline has run, once, all the way
through.** On 2026-11-09 at 22:15 UTC — the third attempt, after two timeouts
with an identical signature — a run of `.github/workflows/deploy.yml` found
TCP 22 open and performed a full production deploy, every step succeeding. It
is one of nine runs that reached the network, and the only one that got in; ADR
[0008](decisions/0008-ship-from-a-workstation.md) has the table and is careful
about what nine samples can and cannot support. What this entry used to list as
"never run" is therefore mostly measured, and what remains is named below.*

- **Proven by that run**, with the live site as the second half of the
  evidence:
  - **the SSH port is 22**, and the pinned host key was of a type the host
    offers — the run authenticated and shipped;
  - **`DEPLOY_PATH` is under `$HOME`**, and the `mkdir -p` and every `rsync`
    into it worked;
  - **`app.cgi` arrived executable**, by `--chmod=F755` on the runner's GNU
    rsync plus the explicit `chmod 755` in the install step. (Neither spelling
    is available to `deploy/deploy.sh`, which is a separate matter — entry 41.)
  - **the hand-created venv is where the workflow and `app.cgi` both expect
    it**, at `$DEPLOY_DIR/.venv`, and
    `"$VENV/bin/pip" install -r backend/requirements.txt` **succeeded on the
    host**, with its pip 23.2.1, from the `--no-dev` export. PyPI being
    reachable from the shell turned out to mean it was reachable from this step
    too.
  - **the document-root contract holds.** cPanel accepted `$DEPLOY_PATH`
    *itself* as the subdomain's document root, **outside `public_html`**, so
    `app.cgi` finds the interpreter relative to its own path and `.htaccess`
    finds the bundle relative to `%{DOCUMENT_ROOT}`.
- **Still unproven here:** step 4a's **nesting fallback**, which was not
  needed. If some later subdomain has to live inside `public_html`, the tree
  gets a **second URL under the parent domain**, where `%{DOCUMENT_ROOT}` is
  the parent's and rule 2's `-f` test does not resolve. What that second URL
  serves has still not been reasoned through, let alone tested — it is simply
  moot on this host.
- **And unproven in a different sense: that the pipeline is a path you can
  rely on.** One run in nine reached the host, the cause of the other eight is
  unknown, and nine runs give no power to say whether the rate is moving. That
  is why shipping moved to `deploy/deploy.sh` (entry 41) and why this workflow
  is manual-only: a `workflow_dispatch` run is worth a try, not a plan.
- **Also unproven: that a deploy does not remove the shared password.** This
  branch introduced the risk — the old pipeline shipped no `.htaccess`, and
  this one ships the file cPanel's Directory Privacy writes into — and
  `deploy/merge-htaccess.sh` is the answer to it. **The script itself has now
  run on the host twice**, in the 2026-11-09 production deploy and the
  2026-11-10 rehearsal, and composed an `.htaccess` that Apache then read —
  which the live site is the proof of, and which is more than the synthetic
  tests could say. What it has never met is a real password. Three separate
  things are open:
  - **Whether Directory Privacy writes into *this* `.htaccess` on this
    host at all.** If it keeps the password somewhere else, the merge is a
    harmless no-op and nothing below matters. `docs/DEPLOY.md` step 8's
    `grep` is what answers it, and a result of "no `Auth*` lines" is a
    finding to report, not a pass.
  - **Whether the merge preserves a real password across a real deploy.**
    The script's behaviour is pinned by
    `backend/tests/test_merge_htaccess.py` against synthetic files; the
    composition cPanel actually writes, and where in the file it writes it,
    have not been observed here.
  - **Its atomicity is only half-tested.** The test asserts that no temp
    file is left beside the destination, which a plain non-atomic write to
    `.htaccess` would satisfy just as well. The `mv` is what makes the swap
    atomic — and an `.htaccess` that is half-written or briefly absent is
    500 on every URL of the subdomain for as long as it lasts — but nothing
    in the suite proves the `mv` is what happened.
- **No longer unproven: the lockfile.** `backend/uv.lock` has been
  regenerated and committed, and now records `requires-python = ">=3.12"`, the
  same floor `pyproject.toml` asks for, with `a2wsgi` in it. So CI's `uv sync`
  installs from the lock rather than re-resolving, `make backend-test` works
  offline again, and the deploy's bare `uv export` cannot rewrite the tracked
  lock on its way past. What is still outstanding is the `--frozen` half of
  `docs/DEPLOY.md` step 2: no workflow and no Makefile target passes it, so a
  future drift would be as quiet as the last one.
- **Close what is left:** `docs/DEPLOY.md` step 8's one-off check for the
  password, which is now the only part of this entry a deploy can settle. The
  rest of the runbook's deploy steps are entry 41's business, since
  `deploy/deploy.sh` is what ships.

## 35. Sessions across real browsers

- **Unproven:** the cookie flow in a browser: that `tour_sid` is set once and
  survives a reload, that two browsers on the host get separate tours, that
  *Copy* on the recovery key works (it uses `navigator.clipboard`, which
  needs a secure context), and that typing the key into the welcome screen's
  *Recover a tour* reattaches. The backend half is covered by tests and, for
  the `curl` flow, run live (`HANDOFF.md`). Known: the cookie is always
  `Secure`, so local development in Safari, which has historically refused a
  `Secure` cookie on `http://localhost`, would mint a new session on every
  request. That is untested here.
- **Close it:** on the host over HTTPS, open the editor in two different
  browsers; make a tour in one and confirm the other does not see it; clear
  cookies in the first, then recover by key.

## 36. Whether the host reaches Overpass, and whether the mirrors answer

- **Unproven:** that place search works from the host. The egress diagnostic
  (`GET /api/diagnostics/egress`) answers whether the application can reach
  all four Overpass mirrors; entries 27 and 28 are still open, so the mirrors
  beyond `overpass-api.de` have never been called, and the shell measurements
  that led here were taken from the cPanel shell, which is not the process
  that serves a request (a CGI process started by Apache, since entry 33). If place search proves unusable on the host it goes the way
  panorama search did, into the browser, or goes.
- **Close it:** `docs/DEPLOY.md` step 1.

## 37. That the code runs on Python 3.12

- **Unproven:** that this application works on 3.12. The floor was `>=3.13`,
  chosen as a floor and not as a measured requirement (ADR 0006's last open
  item). The host has 3.12.15, so `requires-python` is now `>=3.12`, CI pins
  `3.12`, and `backend/tests/test_versions.py` fails if those two ever drift
  apart. **That test proves consistency, not compatibility** — it reads two
  files and compares them, and it says so in its own docstring.
- **What was done instead of running it:** `app/` and `tests/` were read for
  syntax and stdlib newer than 3.9 — PEP 695 generics, `match`, `StrEnum`,
  `TaskGroup`, `datetime.UTC`, `@override`, `itertools.batched`, `TypeIs`,
  `ReadOnly`, `except*` — with no hits. Reading is not running, and this says
  nothing about the installed dependencies' own floors.
- **One item was wrong and is corrected here**, because a false line in this
  file is worse than a missing one: this list used to include `tomllib` among
  the features scanned for and not found. **`tomllib` is used** —
  `backend/tests/test_versions.py:11` imports it, and `:23` reads
  `pyproject.toml` with it. The scan predated that file, which the same
  floor-lowering task created, and was never re-run. No harm done: `tomllib`
  is **3.11+**, so it is safe under a `>=3.12` floor, and an independent
  re-scan over `app/`, `tests/` and `content/scripts` turned up nothing newer
  than 3.9 (the only `.walk(` hit is `os.walk`). The entry stands as
  unproven for the reason below, not because of this.
- **Why it could not be done here:** the development sandbox has no network
  and so cannot build or fetch a 3.12 interpreter. The suite here runs on 3.14.
- **Closed on the host, 2026-11-09.** The production deploy installed the
  dependencies into the host's venv with its own pip 23.2.1 and the author has
  confirmed that the live site serves and works — an application that did not
  import under 3.12.15 is a 500 on every URL, so this is the compatibility
  evidence the reading could not give. The entry stays on the list, marked
  closed rather than deleted, for two reasons: what has been exercised is the
  paths a served page and a routed `/api` call touch, not every code path in
  `app/`, and a syntax or stdlib feature the scan missed would fail at import
  of the module that holds it, which may be a module no request has reached
  yet. CI on the pinned `3.12` is the cheap second opinion and runs on every
  push. If either ever fails on a 3.12 feature, the fix is in the code, not in
  the floor — the host offers one interpreter.

## 38. The `.htaccess` front controller — every rule in it

*This was the highest-risk unverified assumption on the CGI branch, in the way
entry 32 still is on the hosted-deployment branch: nothing else on this host
could be looked at until it held. The note below is where that changed, and
what is left of this entry is one `curl` and a caution about new subdomains.*

*Updated 2026-11-10. **Apache has now read this file and followed it.** The
2026-11-09 production deploy put it on the host and the author has confirmed
that the live site serves and works: the bundle is served, `/api` is routed to
`app.cgi`, and a deep link falls through to `index.html`. That is rules 1, 2
and 3 doing their jobs with the guard rule in front of them — and the guard
rule in particular, because without it rule 3 would have turned `app.cgi` and
every bundle path into `index.html`, which is the HTTP-200-on-everything
failure described below and is not what the site is doing. `Options +ExecCGI`
is permitted, and the inherited symlink option is in effect, since otherwise
per-directory `mod_rewrite` would not have run at all. **One claim in this
entry is untouched by all of that, and it is the one with a credential at
stake: nobody has asked the host for `/backend/.env`.** The entry stays for
that, and because every rule here is per-directory configuration and so a fresh
question on any new subdomain.*

- **Proven on the host for the production subdomain, 2026-11-09:** the guard
  rule, rule 1, rule 2, rule 3's fallback, `Options +ExecCGI` and the
  inherited `FollowSymLinks`. See the note above for what each one's evidence
  is.
- **Still unproven:** that **`/backend/.env` is not reachable by URL**. Rule 3
  is unconditional precisely so that it swallows the path, and the
  `<Files ".env">` deny is the belt behind that brace, but neither has been
  asked the question on a real server — and a deep link falling through to
  `index.html` is suggestive rather than conclusive, because it says nothing
  about a path that **does** exist on disk under the document root. The thing
  at stake is a credential, so this is a `curl` worth running today:
  `docs/DEPLOY.md` step 7, check 6.
- **Also still unproven:** every one of these rules on any **other** document
  root. An `.htaccess` is read for its own directory and below, and what a host
  permits is per-directory, so a staging subdomain or a second production one
  is a new measurement rather than a formality.
- **The reasoning each rule rested on before the host answered**, kept because
  it is what to re-read if one of them fails somewhere new. There is **no
  Apache in the development environment**;
  `backend/tests/test_htaccess.py` reads the file as text and pins the rule
  order and the two routed prefixes; it cannot make a web server follow them.
  Each rule was a separate claim:
  - **The guard rule** (`^(app\.cgi$|frontend/dist/frontend/browser/)`) is
    there because per-directory `mod_rewrite` re-runs the whole ruleset on a
    rewritten path — `[L]` ends the round, not the processing. If that
    understanding is wrong in either direction the result is bad: without
    the behaviour the rule is harmless, but *with* it and without the rule,
    rule 3 turns `app.cgi` and every bundle path into `index.html` — no API,
    no JavaScript, and **HTTP 200 on everything**, which is the quietest
    possible failure.
  - **Rule 1**, that `/api` and `/tour-data` reach `app.cgi` with
    `REQUEST_URI` intact through the rewrite.
  - **Rule 2**, that `%{DOCUMENT_ROOT}` is the deploy directory and the `-f`
    test therefore finds the bundle, so a hashed asset answers at its public
    path.
  - **Rule 3**, that an unknown path returns the single-page app rather than
    a 404 — and, the same fact from the other side, **that
    `/backend/.env` is not reachable by URL.** The fallback is unconditional
    precisely because `backend/`, `content/`, `.venv/` and `backend/.env`
    all exist on disk under the document root, so the usual
    `RewriteCond %{REQUEST_FILENAME} !-f` idiom would publish the source and
    the Mapillary token. The `<Files ".env">` deny is the belt behind that
    brace. **The fallback has now been seen working on a path that does not
    exist** (a deep link returns the application); neither it nor the deny has
    been asked for a path that *does* exist on disk, which is the case the
    credential depends on.
  - **`Options +ExecCGI`**, which needs `AllowOverride Options`. cPanel's
    usual setting is `All`, unconfirmed here. If it is narrower, the
    directive itself 500s the tree — not the route, the tree.
  - **Inherited `FollowSymLinks`.** Per-directory `mod_rewrite` does not
    work at all unless `FollowSymLinks` or `SymLinksIfOwnerMatch` is in
    effect for the directory. Nothing in this repository can set it: the
    `Options` line is written in the **`+`/`-` form** (`+ExecCGI -Indexes`)
    specifically so that it *merges* with what the host inherits instead of
    replacing it, which the bare form would do — and that is the whole of
    the defence. A host that does not grant the symlink option 500s the
    tree, or silently fails every rewrite, and the only fix is to ask the
    host for it.
- **Close what is left:** `docs/DEPLOY.md` step 7's six `curl` checks, in the
  order given, each one narrowing what a failure can be. **Check 6**
  (`curl -s https://HOST/backend/.env`) is the one still open and the one to
  read with your own eyes: it must not contain `MAPILLARY_TOKEN`. On a new
  subdomain run all six, before Directory Privacy (step 8), so no credentials
  are involved. Step 7 also keeps the undo —
  `ssh HOST 'rm -f .../.htaccess'` — on screen, because a file Apache
  rejects takes the whole subdomain with it.

## 39. CGI under concurrency, with several historians at once

- **Unproven:** that a process per request holds up with roughly six people
  using the editor. Two separate costs, neither measured under load:
  - **CloudLinux caps concurrent entry processes**, and CGI spends one per
    request. Keeping Python off the static path (ADR 0007, decision 2) keeps
    the count low — a JavaScript chunk costs Apache nothing — but every
    autosave, every session poll and every `/tour-data` media fetch is a
    process. Several historians loading media-heavy stops at the same moment
    could brush the limit. The symptom would be **sporadic 500s or 508s
    under load**, not a steady failure, which is the hardest kind to
    recognise from a bug report.
  - **0.35–0.46 s of process start on every dynamic request**, measured once
    on this host (ADR 0007's table, `tests/round2/test3.txt`) — five runs of
    the `fastapi` + `pydantic` import, single-process and idle, which is the
    optimistic case on both counts. Plan around the **0.46 s** ceiling; the
    tighter 0.36–0.40 s figure that used to stand here belongs to an
    app-equivalent series that was never committed to a file, so this record
    cannot vouch for it (ADR 0007 says so at length). Browsers parallelise,
    so a stop with a dozen media files should be closer to a second than to
    five. Should.
- **Why not here:** the number depends on the host's own limits, which are
  not published to the account and cannot be read from a development
  machine. Nothing in the suite can simulate it.
- **Close it:** watch it in use rather than testing for it. The first real
  session with two or three historians in the editor at once is the
  measurement. If 500s or 508s appear under load, that is this entry and not
  a bug in the application, and the error log (`docs/DEPLOY.md`, *Reading the
  error log*) is where the difference shows. **Engineering around this
  before anyone has used the app would be guessing**, which is why nothing
  was built for it.

## 40. `index.html` on the host has no `no-cache` header any more

*This one is not a question the branch failed to answer; it is a behaviour the
branch changed without noticing, found in review. It is recorded rather than
fixed, and the reasoning for not fixing it is below.*

- **What changed:** in development, `_SpaFiles._with_cache_headers`
  (`backend/app/main.py`) sets `Cache-Control: no-cache, must-revalidate` on
  `index.html`, and its comment says why: `index.html` names content-hashed
  bundles, so a cached copy pins the whole application to an old build. That
  is not hypothetical here — `docs/ENVIRONMENT.md`, *The browser cached
  index.html and served stale bundles*, records it happening during
  development and twice leading to wrong conclusions about where a bug was.
  Under the front controller, rule 3 has **Apache** serve
  `frontend/dist/frontend/browser/index.html` directly, and Python is never
  started for it. `.htaccess` sets no `Header` or `Expires` directives, so the
  file goes out with `ETag` and `Last-Modified` only and the browser applies
  *heuristic* freshness — its own guess. The header the code deliberately adds
  is simply absent on the host.
- **Unproven:** what any real browser then does with it. Nobody has loaded
  this site from this host, let alone loaded it, redeployed, and loaded it
  again, which is the only way to see this.
- **Why it is a watch item and not a fix.** Two accidents of the deploy defuse
  most of it: `rsync -lt` carries CI's fresh build mtime, so
  `Date - Last-Modified` is near zero and the heuristic freshness window with
  it; and no rsync in the workflow passes `--delete`, so the hashed chunks an
  old `index.html` names are **still on the host** — a stale client keeps
  running a working older build instead of breaking on a missing chunk. The
  obvious fix, a `<Files "index.html"> Header set Cache-Control ... </Files>`
  block, needs `mod_headers`, and **whether this host permits `mod_headers` in
  `.htaccess` is exactly as unknown as everything in entry 38** — while the
  penalty for guessing wrong is the one ADR 0007 decision 3 warns about: a
  directive Apache will not accept is **500 on every URL in the tree**, editor
  and viewer and API together. A stale page is a worse-than-nothing outcome; a
  500 tree is a worse-than-stale one. So: no directive.
- **The symptom to recognise:** after a deploy, a historian sees the *old*
  application — a fix or a new feature missing, the page otherwise working
  normally — while someone on a fresh browser sees the new one. That pattern,
  one person stale and another not, is this entry and not a failed deploy.
  Check `frontend/dist/frontend/browser/index.html`'s mtime on the host first;
  if it is new, the deploy worked and the browser is the problem.
- **The remedy, in order:** a **hard reload** (Shift-reload, or Empty Cache
  and Hard Reload in devtools) on the affected browser clears it immediately,
  and that is the whole fix for a six-person tool. Only if it proves to be a
  recurring, real nuisance is it worth adding the `mod_headers` block — and
  then it is a step-7-style change: add it, `curl` the site at once, and keep
  `mv .htaccess .htaccess.broken` on screen first.

## 41. `deploy/deploy.sh` — the thing that now ships, rehearsed once and never shipped to production

*Added 2026-11-10 with ADR
[0008](decisions/0008-ship-from-a-workstation.md). Shipping moved off GitHub
Actions and onto the author's own machine because the pipeline reaches the host
about one time in nine, and a deterministic deploy you type is worth more than
a lottery on a one-person project. Entry 34 above describes the pipeline, which
is intact, manual-only, and has run successfully exactly once.*

*Amended 2026-11-10, after an adversarial review of the branch and before the
rehearsal described below. One of the properties this entry listed as proven — that the
two files Apache reads arrive with the modes it needs, because the rsyncs carry
`--chmod=F644`/`F755` — was **shown to be false on the author's own machine**,
not merely left unproven.
`/usr/bin/rsync` on macOS is Apple's openrsync and rejects a literal mode
outright (`rsync: --chmod=F644: invalid argument`, exit 1, nothing
transferred), so every deploy would have died at the first rsync, after
`make check` had already run. A claim that has been tested and found false is
worth more than one nothing has looked at — it names a thing to fix, where an
unexamined claim only looks like a finding — and the test that let this one sit
here as "proven" is why: it asserted the string `--chmod=F644` was **present**,
which was exactly as true of the broken script as of a working one. It now
asserts that no rsync carries one. The modes are set by `chmod` on the host
instead, which moves them out of this list's first bullet and into its
second.*

*Corrected 2026-11-10, later the same day. **This entry used to say the script
had never run against the host. That is no longer true, and it was the most
misleading line in this file.** `deploy/deploy.sh --target` was rehearsed
against the real host and succeeded: all eleven remote operations worked, the
`.htaccess` merge ran on the host, the only-when-absent `backend/.env` logic
ran, the host-side `chmod`s set the modes, and `rsync` with no `--chmod`
transferred correctly from macOS. What has **not** happened is a **production**
run — no `--target`, into `DEPLOY_PATH` — and the rehearsal's target was a
staging directory with **no subdomain**, so nothing the script wrote was ever
served by Apache. The lock has still never met a second deploy.*

- **Proven here, and it is worth being precise about how little that is:**
  `backend/tests/test_deploy_script.py` drives the real script with `ssh`,
  `rsync`, `make`, `uv` and `git` replaced by stubs on `PATH` that log their own
  argv. So what is proven is the script's control flow and the arguments it
  builds: that `.htaccess` is staged and merged before `app.cgi`, before
  `backend/`, before `content/` and before the `.env` write; that **no** rsync
  carries a deleting flag, matched by token against all eleven of them rather
  than by the substring `--delete`, which `--del` and `--force` walked past;
  that **no** rsync carries a `--chmod` at all, and that `app.cgi` is chmodded
  755 on the host in the command straight after the rsync that lands it, and
  again in the install step; that `backend/.env` is written only when absent;
  that the backend rsync excludes `.env` and `.venv`; that the token never
  reaches an argv; that `make check` — that target, not any `make` — runs
  before the first remote command; that `--target` reaches **every** remote
  path, and that an empty or relative one is refused instead; that each refusal
  logged no `ssh` and no `rsync`; and that the first failing remote command is
  the last thing in the log.
- **Proven against the real host by the 2026-11-10 rehearsal**, which is what
  none of the stubs could reach: `rsync`'s real behaviour and its exit codes,
  including that **`rsync` with no `--chmod` transfers correctly from macOS**;
  all **eleven remote operations**, in order, each one succeeding; the
  **`.htaccess` merge running on the host** rather than on a synthetic file
  tree; the **only-when-absent `backend/.env` logic** running, which on a first
  deploy means the branch that creates the file; the **host-side `chmod`s**
  landing the modes Apache needs, which is where the modes now come from; the
  host's `pip` resolving `requirements.txt` into a hand-made venv; the
  `~/.ssh/known_hosts` entry working as the pin, with no `DEPLOY_HOST_KEY`
  anywhere; and `make check` passing on a machine with a network, which cannot
  be run here at all.
- **Still unproven, and this is the list that matters now:**
  - **A production run.** The rehearsal used `--target`, which relaxes the
    `main`-and-clean-tree gates, and pointed at a staging directory with **no
    subdomain** — so nothing it wrote was ever served by Apache, and no `curl`
    check could have been run against it. A run with no `--target`, into
    `DEPLOY_PATH`, against the tree the historians use, has never happened.
    `docs/DEPLOY.md` step 10 is that run.
  - **The `.deploy.lock` directory keeping two deploys apart.** No test can
    reach it: the lock is taken and released against a temp directory in the
    suite, and a *real* second deploy arriving mid-`rsync` has never happened.
  - **`merge-htaccess.sh` meeting a real Directory Privacy password.** The
    merge ran on the host and Apache read what it wrote, but the live
    `.htaccess` it read had no password in it to carry across (entry 34).
- **Why the rest could not be done here:** the stubs are the point. A test that
  let the real `rsync` or the real `ssh` through would be talking to the network
  from a sandbox that has none, and against a live shared host if it had one.
  There is no Apache and no 3.12 interpreter here either (entries 33 and 38),
  so even a successful ship from the suite would prove nothing about what the
  host then does with the files.
- **Close what is left:** `docs/DEPLOY.md` step 10 — `deploy/deploy.sh` with
  **no** `--target`, from `main` with a clean tree. Its *You should see* list is
  step 6's and is in the order the script prints, so a deploy that stops
  part-way says exactly how far it got; the clean-tree gate is the likeliest
  thing to stop it before it starts. Then step 7's `curl` checks against
  production, of which **check 6 is the one still open** (entry 38). **The lock
  is closed by none of that**: nothing in the runbook runs two deploys at once,
  and the only honest way to see it work is to start a second
  `deploy/deploy.sh` while the first is inside `make check` and read the
  refusal.

## 42. Flat (non-360) Mapillary imagery, which nobody has seen render

*Check 3 can change the design. Do it first.*

- **Unproven:** that **any** of this works in a browser. Nobody has seen a
  flat Mapillary image render in this application. The design rests on
  mapillary-js drawing `"perspective"` and `"fisheye"` itself
  (`mapillary.d.ts:1249`) and on `camera-sync.ts` handing three.js
  mapillary's own view and projection matrices, which should make the
  in-world renderer projection-agnostic by construction — "should" being the
  word that this entry exists for. Specifically at risk: the view turning on
  imagery it cannot turn. `setCenter` works in basic image coordinates, and
  the shift of `delta / 360` assumes x spans the full circle; on a
  perspective image x spans the camera's 70-90 degree field of view, so the
  same shift over-rotates by a factor of four or five.
  `panorama/view-turn.ts` declines to turn anything Mapillary positively
  calls `perspective` or `fisheye`, and `view-turn.spec.ts` pins that, but a
  spec cannot show the resulting view is the right way up.
- **Why not here:** no browser engine launches in the sandbox, and the
  frontend suite runs under vitest with jsdom and no WebGL, so nothing that
  touches mapillary-js is reachable from a test. That is why the four
  decisions live in pure functions with their own specs —
  `thinBySpacing` and `knownCompassAngle` (`core/mapillary-search.ts`),
  `centerForBearing` (`panorama/view-turn.ts`), `wedgeFor`
  (`editor/footprint.ts`) — and why `fake-viewer.ts` grew
  `emitImageryReport`. `graph.mapillary.com` is also unreachable from CI and
  from the host, so even the field names below were confirmed by hand from a
  workstation rather than by anything automated.
- **Close it**, in this order:
  1. **`Image.cameraType` is actually populated for a flat image the viewer
     renders.** Everything else rests on this. mapillary-js documents it as
     "undefined if SfM has not been run" (`mapillary.d.ts:1950`), and
     `isFlatCamera` therefore treats unknown as spherical, which preserves
     today's behaviour for every image that works today. If it comes back
     undefined for flat imagery, **that fallback is wrong for exactly the
     images this feature is for**, and the rule inverts to "turn only when
     positively spherical". Read it in the console on a loaded flat image, or
     watch the report the editor publishes.
  2. A stop built on a flat candidate loads and shows the street.
  3. The view does **not** whip round on load. This is the over-rotation
     above, confirmed absent.
  4. A draped archival photograph inside the camera's wedge appears and fades.
  5. The ground arrows still walk between flat images in a sequence.
  6. The map's wedge is **absent** on a flat stop whose compass angle is `-1`,
     and **present** on one whose angle is known.
- **Subjects**, probed 2026-11-11. Mapillary imagery can be withdrawn
  upstream, so an id that no longer resolves means re-probing, not a defect.
  - **Český Krumlov, `48.8109, 14.3153`** — the main subject. 46 flat images,
    0 panoramas, 17 sequences within 50 m. Today the search returns nothing
    here and the stop cannot be made at all.

    | image id | distance | sequence | compass |
    | --- | --- | --- | --- |
    | `304177654440052` | 21.8 m | `KkmbK5LiUsI_cQBJ6LuHpw` | **-1** |
    | `953230175442807` | 23.0 m | `9NrMXWUXTiSDWGqNL2irrA` | 293.97 |
    | `313605866995776` | 23.0 m | `9NrMXWUXTiSDWGqNL2irrA` | 298.12 |
    | `514486621381530` | 27.0 m | `dOwlXaqhImEkvyRAMYgPUW` | 190 |

    The first row is check 6's "no wedge" case: an unknown compass angle, so
    it stores bearing `0` and must draw nothing. The fourth has a known angle
    and must draw one. Rows two and three are 0.9 m apart in one sequence, so
    only one of them should reach the list.
  - **Visby, Sweden, `57.6409, 18.2960`** — 8 panoramas against 280 flat
    images. The panoramas must still occupy the top of the list: this is the
    check that an author with 360 coverage sees no change in what they are
    offered first.
  - **Rye, England, `50.9509, 0.7311`** — 28 flat images, all in sequence
    `Q9GMfRjnXOskmoyDrIFabv`, nearest 40 m. Thinning must leave **several**
    candidates here, not one. One-frame-per-sequence would have left one, and
    that is the edge case the spatial rule exists for.
- **Also unseen, and not in the list above:** whether 10 m
  (`MIN_CANDIDATE_SPACING_M`) is the right spacing on real coverage, and
  whether `FLAT_WEDGE_FOV_DEG` (60, a deliberate under-claim against the
  70-90 degrees real flat capture runs) reads as useful or as misleadingly
  narrow. Both are module constants, and both are judgement calls that want
  an author's eye rather than a test. Note also that the thinner applies to
  **360** imagery as well: a dense panorama campaign spaced under 10 m will
  be thinned too, which nobody has looked at on Fairfax.
- **`make e2e` cannot run here either** (entry 30).
  `frontend/tests/e2e/flat-imagery.spec.ts` drives the Krumlov list against
  the real Graph API and **skips with a reason** unless `MAPILLARY_TOKEN` is
  in the environment, because a stub returns an empty list and would prove
  the opposite of the point.

---

## 43. Per-tour theming, none of which has been seen in a browser

*Check 1 is the pixel risk a visitor is most likely to see: the three light
presets' derived tokens were remeasured and raised on 2026-11-15, and what is
left in them cannot be fixed by arithmetic. The published-site font check,
which used to lead this list, is check 5 and has been downgraded — the
reasoning is there.*

- **Unproven:** how any of it looks. A theme — preset, colour overrides, type
  pairing, type scale, layout — is stored in the document, resolved by the pure
  `resolveTheme` (`core/theme.ts`), written onto the viewer's host element as
  custom properties and two data attributes, and edited in the theme pane
  (ADR [0009](decisions/0009-the-look-is-in-the-document.md)). The resolution,
  the schema, the ops and the colours handed to the pins and markers are all
  specified by tests. What is not is every pixel, and everything below depends
  on one.
- **Why not here:** no browser engine launches in the sandbox and the frontend
  suite runs under jsdom, which computes no layout, loads no font and paints
  nothing. `make check` runs `ng build`, which fails on a `url()` it cannot
  resolve, so a wrong font path is caught; a font file that resolves at build
  time and 404s under a published site's base URL is not.
- **Close it**, in this order:
  1. **Any of the four presets is legible on a real screen.** Nocturne is
     today's appearance; Archival, Civic and Field notes came from approved
     mockups, and their `error` colours and `wayfinding`/`destination` pairs
     were the design's own choice and were never rendered. Field notes' `error`
     is distinguished from its accent only by being darker; if it cannot be
     told apart in place, change it (`error` is internal, so no document
     depends on it). **Three pairs were measured and fixed on 2026-11-15**: the
     `muted` derivation was 3.48–3.62:1 against `panel` and 2.75–2.87 against
     `attributionBar` on these three presets, and `mutedWeak` was 1.30 against
     `rule`, because the ratios came from a mockup and only Nocturne — which
     pins both tokens — had ever been looked at. `theme.spec.ts` now holds
     a contrast floor for every foreground/background pair the viewer paints,
     on all four presets, so arithmetic of this kind cannot go unmeasured
     again. **What a floor cannot fix is still here to look at:** Archival's
     accent reads **3.95:1** on its own attribution bar (`.tour-title`) and
     **3.66:1** on its panorama canvas (`.pano-error`), both below AA for the
     ~11 px and ~13 px text they paint. `accent` is a preset value from the
     mockup, not a derivation, so no ratio in `theme.ts` can move it: the
     answers are a darker Archival accent, a lighter bar, or accepting it.
     Judge it by eye first. Nocturne's own `onWayfinding` is 4.11:1 against
     `wayfinding` and is deliberate — see spec §5.2, it is today's appearance.
  2. **The three layouts hold together at real sizes, and the narrow stacking
     works on a phone.** `widePanel`, `panelLeft` and `immersive`, each at a
     wide window and below the 900 px breakpoint, where all three stack as
     panorama, map, panel, attribution. The stacked rows (`45vh`, `25vh`, then
     the panel) are a guess at a phone screen.
  3. **`color-mix` renders as intended in the testers' browsers.** It is used
     in `map-pane.css` for Leaflet's attribution control, as
     `color-mix(in srgb, var(--attribution-bar) 75%, transparent)`. A browser
     that does not support it drops the declaration, which is why the rule now
     carries a plain `background: var(--attribution-bar)` before it: the
     fallback costs the translucency and nothing else. What is unproven is
     only which of the two a tester's browser takes, and whether the solid
     band looks acceptable if it is the fallback.
  4. **The pins and the panorama markers read well over real map tiles and real
     street imagery.** A `wayfinding` colour that separates cleanly from grey
     squares in a mockup may disappear into a dense basemap, and a
     `destination` marker has to be findable in a photograph. Try each preset
     over a dense part of the basemap and over both a bright and a dim street.
  5. **The fonts load on a published site, under `<base href="./">`, served
     from a subdirectory.** `make serve`, publish a tour with each of
     `garamond`, `franklin`, `plex` and `franklinGaramond`, unzip it into a
     subdirectory of any static host (not the root), open it, and read the
     network panel: the `media/*.woff2` requests must be 200, not 404, and the
     headings must be visibly in the chosen face rather than Georgia. Also
     confirm the four `OFL-*.txt` files are in the zip under `fonts/` — they
     are the licence condition on redistributing the faces.
     **This was check 1 and led the list, as the one that fails only after an
     author has published. It is downgraded, because the subdirectory half of
     it cannot fail:** the built stylesheet emits
     `url("./media/ebgaramond-YZ47ODPX.woff2")`, and a CSS `url()` resolves
     against **the stylesheet's own URL**, not against `<base href>`, which
     governs only HTML-relative URLs. The stylesheet and `media/` are siblings
     in the published zip, so they stay siblings wherever the zip is unpacked.
     That is readable here, from `frontend/dist/frontend/browser/*.css`, which
     is why it is no longer first. What is left is worth doing anyway: that
     the licence files are actually in the zip, and that the faces render as
     the chosen family rather than silently falling back for some other
     reason. On the licences: `test_fonts.py` proves the `angular.json` assets
     entry names the fonts directory and that the `OFL-*.txt` files are in the
     source tree, and — when a build is present — that they reach
     `dist/frontend/browser/fonts/`. It does not prove a *served* site carries
     them. An earlier wording of this check, and the test's own earlier name,
     said it proved they reach `dist/`, which it did not.
  6. **The live miniature resembles the viewer closely enough to be useful.**
     It is a deliberate lookalike (`editor/theme-preview.ts`), tied to the
     viewer by one test that its stylesheet names only tokens the viewer also
     defines. That catches a renamed token and nothing else; its resemblance
     can drift, and the comparison is the *Preview* link to `/view`.
  7. **The immersive layout's proportions.** The `3fr`/`2fr` split between
     panel and map, the `minmax(320px, 1fr)` floor on the panel under
     `panelLeft`, and the `45vh`/`25vh` stacked rows are all numbers chosen
     without a screen. The one most worth measuring is not in any
     `:host([data-layout='immersive'])` block at all: that rule sets only
     `grid-template-columns` and `grid-template-areas`, so `immersive`
     inherits `grid-template-rows: minmax(0, 3fr) minmax(0, 2fr) auto` from
     the base `.layout`. The full-width panorama therefore takes **3/5 of the
     viewport height**, with the panel and the map sharing the remaining 2/5 —
     a stop's words in two fifths of the screen, which is arguably the more
     consequential unverified number in that layout.
  8. **In `immersive` alone there is no rule between the full-width panorama
     and the panel beneath it.** `.panel-slot` loses its `border-left` and
     `.map-slot` keeps only its `border-top`, so the join between panorama and
     panel may read as one surface. Judge by eye whether it needs a divider.
  9. **The theme pane's fit in the editor sidebar, at both widths.** Whether
     the inspector above it gets squeezed, and how the pane's own scroller
     behaves nested inside the sidebar's below 60rem.
  10. **No browser has rendered the type pairings in the miniature.** The
      attribute-scoped `[data-type-pairing='…']` rules are what give the
      preview its fonts, because it sits inside the editor and not inside the
      viewer; a miniature in Georgia under every pairing would mean they do
      not reach it.
  11. **Hit sizes at real DPI.** The colour swatches (1.1 rem) and the
      reset-arrow controls (0.1 rem padding) are small, and are the pane's
      only way to undo a colour.
  12. **The latin-ext faces actually resolve for an accented place name.**
      Give a stop a title such as *Łódź* or *Český Krumlov* under each
      pairing and check the network panel fetches the `-latin-ext` file and
      that no glyph falls back. The `unicode-range` split is correct by
      inspection and has never been exercised by a browser, and a tour whose
      text is plain ASCII is meant to download none of those files, which is
      the other half of the same check.
- **Also unseen:** whether the readout's wording and the amber warning below
  AA are noticeable (it must warn and never block publishing) — it now shows
  five readings rather than three, having gained the stop summary and the
  overlay list, so whether five rows is still a readout rather than a wall is
  part of the same look; and the
  primary button's new colour on the shipped Fairfax tour, which is gold where
  it was blue (ADR 0009, and `HANDOFF.md`), and is the one change a visitor to
  an existing tour will see.
- **`make e2e` cannot run here either** (entry 30); there is no Playwright spec
  for any of this.

---

## Not on this list, deliberately

These are open decisions, not unverified facts: the `stops.json` drift and
whether to retire the pipeline (`HANDOFF.md` item 2), the unreviewed
historical text (item 4), the Marr Monument question (item 5). They need your
judgement, not a browser.
