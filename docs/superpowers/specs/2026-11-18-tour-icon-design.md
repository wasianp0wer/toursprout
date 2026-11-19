# Tour icon and footer credit — design

**Date:** 2026-11-18
**Status:** approved by the author, 2026-11-18
**Base:** `main` at `aec65c1`, branch `tour-icon`.

## Intent

A published tour should show its own icon in the browser tab instead of
Angular's default `favicon.ico`. The author uploads an ordinary image; the
tour carries it; the published site and the editor's Preview both show it.
Alongside it, the viewer's footer credits the software: "Powered by
TourSprout", linking to https://github.com/wasianp0wer/toursprout.

## Goals

- An author can set, see and remove a tour icon from the theme dialog.
- Any image the browser can decode is accepted, and stored as a PNG.
- The published zip carries the icon **statically**: its `index.html` names it,
  so no script has to run for a browser to find it.
- Preview (`/view` on the authoring host) shows the icon too.
- The icon travels with the document: export, import and publish keep it.
- The footer shows "Powered by TourSprout" after the OSM and Mapillary credits.

## Non-goals

- `.ico` output. Every current browser accepts a PNG favicon; the author chose
  PNG once that was known.
- Home-screen / `apple-touch-icon` / manifest icons.
- Icons on the editor's own tab, the welcome screen or the entry page. Those
  are the author's workbench (ADR 0009, "What this deliberately does not
  settle").

## Anti-goals

- An icon left on the editor tab after `/edit` → `/view` → `/edit`. The viewer
  must hand the page back as it found it, for the same reason ADR 0009 §3
  keeps theme tokens off `:root`.
- A published `index.html` an imported bundle can inject into. The icon id is
  written into an HTML attribute, so it is escaped.

## Approaches

1. **Viewer sets the favicon at runtime, everywhere.** One code path, but the
   published page flashes the default icon and non-JS readers never see the
   tour's. Rejected on its own.
2. **Baked into the zip only.** Preview is not the zip — it is the authoring
   host's shared `dist/index.html` — so Preview would never show it. Rejected
   on its own.
3. **Chosen: both.** `publish.py` rewrites the zip's `<link rel="icon">`; the
   viewer sets the same link at runtime so Preview shows it. On a published
   site the runtime set is a no-op (the same URL).

The author asked why it could not simply be exported statically; the answer
was Preview, and the author approved approach 3.

## Design (decided)

1. **Schema v5.** `Tour.icon: MediaRef | None = None`, top-level, not in
   `theme` (ADR 0009 keeps `theme` to enumerated names and hex colours). A
   validator requires it to end in `.png`. `referenced_media` includes it, so
   it is neither an orphan nor allowed to be missing. `_v4_to_v5` bumps the
   version and nothing else. `tour.models.ts` mirrors it as `icon?: string |
   null`.
2. **Editor.** The theme dialog gains an "Icon" field: choose an image, see a
   thumbnail, remove it. In the browser the chosen image is drawn centred,
   aspect preserved, on a transparent 256×256 canvas and exported as PNG, then
   uploaded through `SessionApi.uploadMedia`. No backend image library.
   Upload first, document second, as `media-field.ts` does, so a refused upload
   leaves the document untouched. Undoable like any document op.
3. **Publish.** When the tour has an icon, the zip's `index.html` has its
   `<link rel="icon" …>` rewritten to
   `href="tour-data/media/<id>" type="image/png"`, the id HTML-escaped. Done in
   the same zip-only step as `mark_published`; the on-disk `dist/index.html` is
   never touched. No icon → byte-identical to today's output. `publish.py` now
   reads one field of the document; ADR 0009 §1's "free of document knowledge"
   is amended to say so.
4. **Preview.** `ViewerPage` sets the document's `link[rel=icon]` href (and
   type) to `TourApi.mediaUrl(icon)` when the tour has an icon, and restores
   the original href and type when destroyed.
5. **Footer.** A fixed `<a href="https://github.com/wasianp0wer/toursprout"
   target="_blank" rel="noopener">Powered by TourSprout</a>` after the
   attribution loop in `viewer-page.html`. Not part of `config.json`'s
   `attribution`: it credits the software, not the data.

## Left to the builder

- Exact wording and placement of the Icon field within the dialog.
- Whether the canvas helper lives in `core/` or `editor/` (editor-only use).
- Docs: `ARCHITECTURE.md`, `CHANGING-THINGS.md`, an `UNVERIFIED.md` entry for
  favicon rendering nobody has seen, and the ADR 0009 amendment.
