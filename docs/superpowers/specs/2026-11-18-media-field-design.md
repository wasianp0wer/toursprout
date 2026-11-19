# Media field: see and replace an overlay's file

A small change to the editor's inspector. Builds on sub-project 3b
(`2026-10-25-media-and-acquisition-design.md`).

## Why

Once an image or audio overlay is added, its file cannot be seen or changed
in the editor. The inspector shows title, body, credit, kind and placement;
the `mediaId` never surfaces. The only way to change the file is to delete
the overlay and add it again, which throws away its anchor, display mode,
heading and size.

## Goals

- Show the overlay's file in the inspector: the picture for an image, a
  playable audio control for audio.
- Replace the file: upload a new one (image or audio), or record a new clip
  (audio).
- Replacing changes **only** `mediaId`. Title, body, credit, anchor and
  display are kept as they are (the author's decision).

## Non-goals

- Attaching media to a text overlay, or changing an overlay's kind by
  replacing its file. An image is replaced by an image, audio by audio.
- Deleting the old file. It becomes an orphan, as a deleted overlay's media
  already does (3b: silently discarding uploads is the worse failure). Undo
  brings it back into use.
- Cropping, trimming, or any editing of the media itself.
- Stop panoramas' `cachedMediaId`.

## Anti-goals

- A refused upload or recording that changes the document. Upload first,
  change the document second, exactly as `outline-pane.ts` does.
- A replace that lands on a different overlay than the one the author
  pressed the button on, because the selection moved during the upload.

## Approaches

- **A. A standalone `MediaField` component inside the inspector (chosen).**
  It owns preview, replace, record and its own busy/error state. It reuses
  `SessionApi.uploadMedia` and `recorder.ts`. Cost: about 15 lines of
  upload-then-apply sequencing duplicated from the outline pane.
- B. The same field plus a shared upload/record service extracted from the
  outline pane. No duplication, but it refactors the outline pane and its
  441-line spec for no current gain. Easy to do later from A.
- C. A Replace button in the outline toolbar with a preview in the
  inspector. Splits one task across two panes on an already crowded
  toolbar. Dropped.

## Design

**Document op.** `replaceOverlayMedia(tour, overlayId, mediaId): Tour` in
`document-ops.ts`. It returns the same reference (no change, no undo step)
when the overlay is missing, when it is a text overlay, when
`mediaKindOf(mediaId) !== overlay.kind`, or when `mediaId` is already the
overlay's. Otherwise it sets `mediaId` and nothing else.

**Component.** `editor/media-field.ts` (+ html/css/spec), placed at the top
of the overlay form in `inspector-pane.html`, rendered only for `image` or
`audio` overlays that have a `mediaId`.

```
[ image preview, max ~240px wide ]    or   <audio controls>
courthouse-1910-a3f2.jpg
[Replace file…]  [Record new]         ← Record only for audio
Uploading… / Recording… / error line
```

- The preview uses `TourApi.mediaUrl(mediaId)`. Audio uses `<audio controls>`
  with `<source [type]="audioType(mediaId)">`, as `stop-panel.ts` does.
- **Replace file**: a hidden file input with the same `accept` lists the
  outline pane uses. It uploads, then applies `replaceOverlayMedia`.
- **Record new** (audio only): start, then "Stop and replace" or "Discard",
  with the same states, format warning and microphone release on
  discard/destroy as the outline pane.
- **The target overlay id is captured when the button is pressed.** If that
  overlay no longer exists when the upload resolves, the document is not
  touched and the upload stays as an orphan. The field is normally gone by
  then (a delete or an undo clears the selection), so the message `The file
  was uploaded but not applied.` shows only if the field is still on that
  overlay.
- A stored kind mismatch says `That file is <kind>, not <kind>.` and leaves
  the document untouched.
- Both buttons are disabled while an upload or recording is in progress.

**Effects that come for free.** The panorama pane's in-world image reads
`mediaId`, so it updates on replace. Undo and redo restore the previous
file. Uploading identical content yields the same `mediaId`, so the op is a
no-op.

## Builder's calls

- If the preview fails to load (for example a 404 on a file missing from
  disk), show a short "File not found" note in place of the preview, with
  Replace still available.
- Show the filename beneath the preview as plain text.
- Styling follows `inspector-pane.css`.

## Testing

TDD. `document-ops.spec.ts` covers `replaceOverlayMedia`'s refusals and
that it changes only `mediaId`. `media-field.spec.ts` covers: preview per
kind; replace applies the returned id; a refused upload leaves the draft,
undo stack and dirty flag as they were; a kind mismatch is refused with the
message; selection moving during the upload still replaces the original
overlay; a deleted target is not touched; recording degrades when
`MediaRecorder` is absent or permission is denied. Existing suites stay
green.
