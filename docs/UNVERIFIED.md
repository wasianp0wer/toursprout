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
[0007](decisions/0007-serve-it-through-cgi.md)) added entries 37 to 39 and
rewrote 33 and 34.** The host has no Passenger, so the application now runs as
CGI behind an Apache front controller, and **entry 38 is the one to read
first**: there is no Apache in the development environment, so the whole of
`.htaccess` — every rewrite, and the claim that the Mapillary token is not
reachable by URL — rests on reasoning rather than on anything anyone has
seen. Nothing below 38 can be reached in a browser until it holds.

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
- **Unproven:** that Apache executes any of it. Specifically: that `app.cgi`
  arrives and stays mode 755; that `AddHandler cgi-script .cgi` and
  `Options +ExecCGI` are permitted, rather than 500ing the tree or serving
  `app.cgi` to the browser as text (which would publish the one file that
  names the venv); that the venv at `$DEPLOY_PATH/.venv` holds every
  dependency the app imports; that `"$DIR/.venv/bin/python"` resolves from
  `app.cgi`'s own `$0` under Apache's CGI invocation; and that the error log
  the wrapper writes its tracebacks to can be found at all (where this host
  puts it is unverified — `docs/DEPLOY.md`, *Reading the error log*).
- **Why not here:** there is no Apache and no 3.12 interpreter in the
  development sandbox. A test can run the Python; nothing here can run the
  web server.
- **Close it:** `docs/DEPLOY.md` step 7, checks 1 and 2.
  `curl -s https://STAGING/api/health` must answer `{"status":"ok"}` and
  `curl -s https://STAGING/api/session/examples` must answer the example
  list — the second one is what proves the whole application imported, the
  settings loaded and `content/` arrived. "Premature end of script headers",
  a blank page, or `app.cgi`'s own source text in the response body are each a
  different failure, and step 7 says which is which.

## 34. The deploy pipeline

*Rewritten 2026-11-09 for the CGI pipeline. The CloudLinux virtualenv guess
is gone: there is no "Setup Python App" on this host, so there is no
`~/virtualenv/<app>/<version>/` to find. The venv is created by hand at
`$DEPLOY_PATH/.venv` (`docs/DEPLOY.md` step 4) and the deploy only installs
into it.*

- **Unproven:** every step of `.github/workflows/deploy.yml`. It has never
  run. Specific guesses:
  - that the SSH port is 22 (or whatever `DEPLOY_PORT` says), and that the
    pinned host key is of a type the host offers;
  - that `DEPLOY_PATH` is under `$HOME`;
  - that `app.cgi` arrives **executable** — `rsync -rlt` carries no
    permissions, so this rests on `--chmod=F755` and on the explicit
    `chmod 755` in the install step, neither of which has run;
  - that the hand-created venv is where both the workflow and `app.cgi`
    expect it, at `$DEPLOY_DIR/.venv`, and that
    `"$VENV/bin/pip" install -r backend/requirements.txt` succeeds on the
    host (PyPI is reachable from the shell — ADR 0007's table — which is not
    the same as reachable from this step).
  - **The document-root contract.** The subdomain's document root must be
    `$DEPLOY_PATH` *itself*: `app.cgi` finds the interpreter relative to its
    own path and `.htaccess` finds the bundle relative to
    `%{DOCUMENT_ROOT}`. Whether cPanel will let the author *set* a document
    root outside `public_html` is unconfirmed. If it refuses, step 4a's
    fallback nests the deploy tree inside `public_html` — which gives the
    tree a **second URL under the parent domain**, where `%{DOCUMENT_ROOT}`
    is the parent's and rule 2's `-f` test therefore does not resolve. What
    that second URL serves has not been reasoned through, let alone tested.
  The first run should be a rehearsal against a staging path
  (`workflow_dispatch` with a `target`).
- **Also unproven: that a deploy does not remove the shared password.** This
  branch introduced the risk — the old pipeline shipped no `.htaccess`, and
  this one ships the file cPanel's Directory Privacy writes into — and
  `deploy/merge-htaccess.sh` is the answer to it. Three separate things are
  open:
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
- **Also unproven:** that `uv sync` re-resolving in CI produces a working
  environment. `backend/uv.lock` is stale in two ways now: it does not
  mention `a2wsgi`, and it still records `requires-python = ">=3.13"` while
  `pyproject.toml` says `>=3.12`. It must be regenerated with network access
  (`docs/DEPLOY.md` step 2). Until then `make backend-test` fails offline
  and CI re-resolves the whole dependency set on every run.
- **Close it:** `docs/DEPLOY.md` steps 2 to 6 (and step 10 for production);
  step 8's one-off check for the password.

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
  `TaskGroup`, `datetime.UTC`, `tomllib`, `@override`, `itertools.batched`,
  `TypeIs`, `ReadOnly`, `except*` — with no hits. Reading is not running, and
  this says nothing about the installed dependencies' own floors.
- **Why not here:** the development sandbox has no network and so cannot
  build or fetch a 3.12 interpreter. The suite here runs on 3.14.
- **Close it, in two steps:** first, **CI** — the deploy workflow's test job
  on the pinned `3.12` must go green, which is the cheapest evidence
  available and arrives on the next push. Then **the host**: `docs/DEPLOY.md`
  step 7, check 2 (`/api/session/examples`) answering proves the whole
  application imported under the host's own 3.12.15. If CI fails on a syntax
  or stdlib feature the scan missed, the fix is in the code, not in the
  floor — the host offers one interpreter.

## 38. The `.htaccess` front controller — every rule in it

*The highest-risk unverified assumption on the CGI branch, in the same way
entry 32 is on the hosted-deployment branch. Nothing else on this host can be
looked at until it holds.*

- **Unproven:** that Apache does any of what `.htaccess` says. There is **no
  Apache in the development environment**.
  `backend/tests/test_htaccess.py` reads the file as text and pins the rule
  order and the two routed prefixes; it cannot make a web server follow them.
  Each rule is a separate claim:
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
    brace. **Neither has been tested against a server**, and the thing at
    stake is a credential.
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
- **Close it:** `docs/DEPLOY.md` step 7's six `curl` checks, in the order
  given, each one narrowing what a failure can be. Run them against the
  **staging** subdomain and before Directory Privacy (step 8), so no
  credentials are involved. Check 6 (`curl -s https://STAGING/backend/.env`)
  is the one to read with your own eyes: it must not contain
  `MAPILLARY_TOKEN`. Step 7 also keeps the undo —
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
  - **0.36–0.40 s of process start on every dynamic request**, measured once
    on this host with the app's own imports (ADR 0007's table,
    `tests/round2/test3.txt`) — single-process and idle, which is the
    optimistic case. Browsers parallelise, so a stop with a dozen media
    files should be closer to a second than to five. Should.
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

---

## Not on this list, deliberately

These are open decisions, not unverified facts: the `stops.json` drift and
whether to retire the pipeline (`HANDOFF.md` item 2), the unreviewed
historical text (item 4), the Marr Monument question (item 5). They need your
judgement, not a browser.
