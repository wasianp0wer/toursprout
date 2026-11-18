# Media Field Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the author see an image or audio overlay's file in the inspector and replace it by upload or (for audio) by recording.

**Architecture:** A pure document op `replaceOverlayMedia` changes only `mediaId`. A standalone `MediaField` component handles preview, upload and recording, and applies the op through `EditorStore.apply`, uploading first and changing the document second. `InspectorPane` renders it at the top of the overlay form.

**Tech Stack:** Angular 22 standalone components with signals, Vitest + TestBed (jsdom). Run tests with `make frontend-test`, or for a single file `cd frontend && npx ng test --watch=false --include <path>` (with the Makefile's `NODE_BIN` on `PATH`).

**Spec:** `docs/superpowers/specs/2026-11-18-media-field-design.md`

## Global Constraints

- Replacing changes **only** `mediaId`. Title, body, credit, anchor and display are untouched.
- An image is replaced only by an image, and audio only by audio. The kind is checked with `mediaKindOf` (the server's verdict, taken from the stored extension).
- Upload first, document second. A refused upload or recording leaves the draft, undo stack and `dirty` exactly as they were.
- A refused op returns the **same** tour reference (see the `EditorStore.apply` comment). Never return an equal copy.
- The old file is never deleted.
- Every visible input sits inside a `<label>` with text before it (`controlsWithoutLabelAbove` must stay `[]`). Hidden file inputs are exempt.
- Match the surrounding code: signals, `data-*` attributes as test hooks, a doc comment on each non-obvious method.

## Review Focus

1. **The author selects another overlay while an upload is running.** The replace must land on the overlay the button was pressed on, and the field shown for the new selection must not show "Uploading…" from the old one. → Task 2, test `replaces the overlay pressed on, even after the selection moves`.
2. **The target overlay is deleted (or undone away) mid-upload.** Expected: the document is untouched and the message is `The file was uploaded but not applied.` → Task 2, test `does not touch the document when the target is gone`.
3. **A preview URL 404s** (a file missing from disk). Expected: a `File not found.` note, with Replace still enabled. → Task 2, test `says File not found when the preview fails, and still offers Replace`.
4. **Uploading the same file again returns the same `mediaId`.** Expected: no undo step and no dirty flag. → Task 1, test `returns the same tour when the id is unchanged`. Task 2's component test asserts `canUndo` stays false.
5. **The field is destroyed while recording** (the selection changes, or the inspector closes). Expected: the microphone tracks are stopped. → Task 3, test `releases the microphone when destroyed mid-recording`.

---

### Task 1: `replaceOverlayMedia` document op

**Files:**
- Modify: `frontend/src/app/editor/document-ops.ts` (add after `addMediaOverlay`, ~line 496)
- Test: `frontend/src/app/editor/document-ops.spec.ts`

**Interfaces:**
- Produces: `export function replaceOverlayMedia(tour: Tour, overlayId: string, mediaId: string): Tour`

**Depends on:** none.

- [ ] **Step 1: Write the failing tests** in a new `describe('replaceOverlayMedia')`. Use `overlay`, `stop` and `tour` from `test-builders`:
  - `sets mediaId and nothing else`: given image overlay `o1` with `mediaId: 'a-1111.jpg'`, a custom title, credit, anchor and inWorld display, the result's overlay deep-equals the input with only `mediaId: 'b-2222.png'` changed.
  - `refuses a kind mismatch`: image overlay plus `'clip-3333.webm'` → `toBe(input)`.
  - `refuses a text overlay`: `kind: 'text', mediaId: null` plus `'b.jpg'` → `toBe(input)`.
  - `refuses a missing overlay`: `'nope'` → `toBe(input)`.
  - `returns the same tour when the id is unchanged` → `toBe(input)`.
  - `replaces audio with audio`: `'a.m4a'` → `'b.webm'` is applied.
- [ ] **Step 2: Run** `cd frontend && npx ng test --watch=false --include src/app/editor/document-ops.spec.ts`. Expected: FAIL, because `replaceOverlayMedia` is not exported.
- [ ] **Step 3: Implement** `replaceOverlayMedia`. Find the overlay. Return `tour` if it is missing, if its kind is `'text'`, if `mediaKindOf(mediaId) !== overlay.kind`, or if `overlay.mediaId === mediaId`. Otherwise return `updateOverlay(tour, overlayId, { mediaId })`. Add a doc comment saying that title and credit are deliberately kept (the author's decision), and that the old file is left as an orphan.
- [ ] **Step 4: Run** the same command. Expected: PASS. Then `make frontend-test`, all green.
- [ ] **Step 5: Commit** `Add replaceOverlayMedia: swap an overlay's file, keep the rest`.

### Task 2: `MediaField`: preview and replace by upload, shown in the inspector

**Files:**
- Create: `frontend/src/app/editor/media-field.ts`, `media-field.html`, `media-field.css`, `media-field.spec.ts`
- Modify: `frontend/src/app/editor/inspector-pane.ts` (add `MediaField` to `imports`), `inspector-pane.html` (first child of the overlay `<form>`)
- Test: `media-field.spec.ts`, plus one test in `inspector-pane.spec.ts`

**Interfaces:**
- Consumes: `replaceOverlayMedia` (Task 1), `mediaKindOf` (document-ops), `SessionApi.uploadMedia(file: File): Promise<string>`, `TourApi.mediaUrl(id)`, `audioType(id)` from `core/tour-api`, `EditorStore.apply / draft / selectedOverlay`.
- Produces: `@Component({ selector: 'app-media-field' }) export class MediaField` with a required input `overlay = input.required<Overlay>()`. It holds `protected readonly busy = signal(false)` and `protected readonly error = signal<string | null>(null)`.
- DOM hooks: `[data-media-preview]` (an `<img>` or an `<audio controls>` wrapping `<source [type]>`), `[data-media-name]` (the mediaId as text), `[data-media-missing]`, `[data-replace-file]` (button), `[data-media-file]` (hidden input), `[data-media-busy]`, `[data-media-error]` (`role="alert"`).

**Depends on:** Task 1.

**Behaviour the tests pin down:**
- When the button is pressed, capture `overlay().id` and kind as the target. When the upload resolves, apply `replaceOverlayMedia` to **that id**, whatever is selected by then.
- The `accept` value is `image/jpeg,image/png,image/webp` for an image and `audio/*,.webm,.m4a,.mp3,.ogg,.wav` for audio, copied from `outline-pane.html`.
- Error messages, verbatim:
  - upload throws → `err.message`, falling back to `the upload failed`
  - stored kind mismatch → `` `That file is ${stored ?? 'not a supported type'}, not ${kind}.` ``
  - target missing after the upload → `The file was uploaded but not applied.`
- A preview `(error)` event sets the missing note to `File not found.`. The note resets when the `mediaId` changes, via a `linkedSignal` keyed on `mediaId`.
- Busy and error state belong to the overlay they started on. Key them on the overlay id (`linkedSignal` from `overlay().id`) so that selecting another overlay shows a clean field. A late upload for the old overlay must not set the error on the new one.
- `[data-replace-file]` is disabled while `busy()`.

- [ ] **Step 1: Write the failing tests** in `media-field.spec.ts`, following `outline-pane.spec.ts`. Provide `SessionApi` as `{ uploadMedia: vi.fn() }`, `store.load(tour([...]))`, create the component with `fixture.componentRef.setInput('overlay', store.selectedOverlay())` after `store.select`, and dispatch `change` on `[data-media-file]` with a `File` set through `Object.defineProperty(input, 'files', …)`. Tests:
  - `shows the image` and `shows a playable audio control with its type`: check `src` ends with `tour-data/media/<id>`, `<source type="audio/webm">` for `.webm`, and that `[data-media-name]` contains the id.
  - `offers the image accept list` and `offers the audio accept list`.
  - `replaces the file and keeps title and credit`: the upload resolves `'new-9999.jpg'`, then the overlay's `mediaId` is the new id, title and credit are unchanged, and `store.canUndo()` is true.
  - `a refused upload leaves the document untouched`: the upload rejects with `new Error('too big')`, then `[data-media-error]` text is `too big`, `store.draft()` is the same reference as before, and `canUndo()` and `dirty()` are false.
  - `refuses a file of the other kind`: an image overlay and an upload resolving `'x.webm'` → the message is `That file is audio, not image.` and the draft is the same reference.
  - `the same file again adds no undo step`: resolves the current id → `canUndo()` is false.
  - `replaces the overlay pressed on, even after the selection moves`: an unresolved promise; select `o2` and `setInput('overlay', o2)`; resolve → `o1` has the new id and `o2` is unchanged; while pending, `[data-media-busy]` is absent for `o2`.
  - `does not touch the document when the target is gone`: delete `o1` with `store.apply(t => deleteOverlay(t,'o1'))` while pending, then resolve → the draft is the same reference as after the delete. (The component is now showing nothing or another overlay, so assert the message through the overlay id's linked state, or simply that the draft did not change. The draft check is the one that must hold.)
  - `says File not found when the preview fails, and still offers Replace`: dispatch `error` on the `<img>` → `[data-media-missing]` text is `File not found.` and `[data-replace-file]` is not disabled.
  - `disables Replace while uploading`.
  - In `inspector-pane.spec.ts`: `shows the media field for image and audio overlays, not text`, and `controlsWithoutLabelAbove(el)` is still `[]` with an image overlay selected.
- [ ] **Step 2: Run** `npx ng test --watch=false --include src/app/editor/media-field.spec.ts`. Expected: FAIL, because the module `./media-field` is not found.
- [ ] **Step 3: Implement** `MediaField` and its template. In `inspector-pane.html`, add `@if (o.kind !== 'text' && o.mediaId) { <app-media-field [overlay]="o" /> }` as the first child of the overlay form. Keep the styles minimal: the preview has `max-width: 240px` for an image and `width: 100%` for audio, and the visual language follows `inspector-pane.css`.
- [ ] **Step 4: Run** both spec files. Expected: PASS. Then `make frontend-test`, all green.
- [ ] **Step 5: Commit** `Show an overlay's file in the inspector and let it be replaced`.

### Task 3: Record a replacement clip for audio overlays

**Files:**
- Modify: `frontend/src/app/editor/media-field.ts`, `media-field.html`
- Test: `frontend/src/app/editor/media-field.spec.ts`

**Interfaces:**
- Consumes: `startRecording(): Promise<ActiveRecording>`, `ActiveRecording.{stop(): Promise<File>, cancel(), mimeType}`, `RecordingError`, `formatWarning(mime)` from `./recorder`. Test fakes come from `installRecording` / `uninstallRecording` in `./recording-fakes`. Uses the upload-then-replace path from Task 2. Factor it into one private method, `replaceWith(file: File, target: { id: string; kind: 'image' | 'audio' })`, that both the file input and recording call.
- Produces: DOM hooks `[data-record-replace]` (audio only), `[data-record-replace-stop]` ("Stop and replace"), `[data-record-replace-cancel]` ("Discard"), `[data-media-recording]` (`role="status"`, text `Recording from your microphone…`), `[data-media-record-format]`.

**Depends on:** Task 2.

Mirror `OutlinePane`'s recording: the `'idle' | 'starting' | 'recording'` state, a `startToken` bumped by discard and destroy so a late start releases itself, and `ngOnDestroy` cancelling. The target is captured when Record is pressed.

- [ ] **Step 1: Write the failing tests** (copy the setup from the outline pane's recording `describe`):
  - `offers Record only for audio`: `[data-record-replace]` is present for audio and absent for an image.
  - `records and replaces the clip`: start, stop, and the upload resolves `'take2-aaaa.webm'` → the overlay's `mediaId` is the new id and the title is unchanged.
  - `discard leaves the document untouched and releases the microphone`: the fake tracks' `stop` was called and the draft is the same reference.
  - `says why when MediaRecorder is missing` and `says why when permission is denied`: the `RecordingError` message appears in `[data-media-error]` and the state returns to idle.
  - `releases the microphone when destroyed mid-recording`: `fixture.destroy()` → the tracks are stopped.
  - `disables Replace and Record while recording`.
- [ ] **Step 2: Run** `media-field.spec.ts`. Expected: the new tests FAIL because their hooks are missing.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the spec, then `make frontend-test`. Expected: all green.
- [ ] **Step 5: Commit** `Record a replacement clip for an audio overlay`.

### Finish

- [ ] `make check` is green.
- [ ] Browser check, left to the author: there is no browser in this sandbox. Replace an image, replace an audio file, and record a replacement, in the real editor.

**Parallelism:** none. Each task depends on the one before it, and Tasks 2 and 3 share files.
