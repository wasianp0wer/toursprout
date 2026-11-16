# 0009 — The look is in the document

Status: accepted, 2026-11-15.

Supersedes nothing. Answers the second bullet of "What was found and left
alone" in [0005](0005-schema-v3-locks-the-document.md), "UI customization has
nowhere to live", and rests on [0002](0002-the-tour-is-a-portable-document.md)
(the tour is a portable document) and [0003](0003-the-editor-is-three-surfaces-on-one-state.md)
(the editor's selection and panes are never saved). The design is
`docs/superpowers/specs/2026-11-14-ui-customization-design.md`; this record is
the part of it that has to outlive the design.

## Problem

A tour should be able to look like its own subject, and until now it could not:
the look was about thirty hex literals compiled into the viewer's stylesheets
and three more in TypeScript. ADR 0005 audited the schema for exactly this and
found that the obvious home was the wrong side of the document/config line,
and that anything free-form arriving in `tour.json` from an imported bundle
would be served from the author's own origin on a published site.

So the question was not "what should a theme contain" but "where may it live,
and what may it be made of, such that an untrusted bundle cannot use it".

## Decision

A tour carries an optional `theme`: a preset (`nocturne`, `archival`,
`civic`, `fieldNotes`), thirteen optional colour overrides, a type pairing, a
type scale and one of three layouts. It is schema **v4**. Absent means
Nocturne with no overrides, which is the appearance the application shipped
before this branch.

### 1. The theme is in the document, not in `config.json`

`config.json` is derived state. `Session.write_config` rebuilds it on every
open, import and example, and `write_bundle` excludes it from an exported
`.zip` by name. A theme written there would be gone after one export and
re-import, and a published site would carry whatever the host last wrote
rather than what the author chose. ADR 0005 said so about the basemap; it is
equally true of a palette.

In `tour.json` the theme travels with everything else: export, import and
publish need no new code, `publish.py` stays free of document knowledge (it
zips two trees and imports `zipfile` and `Path`), and the editor's preview and
the published site read the same file through the same viewer code.

### 2. Everything an author can store is an enumerated name or a validated `#rrggbb`

An imported bundle is untrusted, and a published site serves it from the
author's own origin. Anything the viewer interpolates into `style` or `src` is
therefore a way for someone else's document to run on the author's origin.

So there is nothing to interpolate. `HexColor` is the pattern
`^#[0-9a-fA-F]{6}$`, and that pattern cannot express `url(…)`, a semicolon or
a closing brace; no three-digit form, no named colours, no `rgb()`. Preset,
type pairing, type scale and layout are `Literal`s.

The line between free and enumerated is what the value *names*. **Colour is
free because colour is not a file.** A type pairing names font files in our own
bundle and a layout names a grid someone had to lay out, so each is enumerated:
an author cannot ask the viewer for a font or an arrangement we do not serve.
Author-uploaded fonts were considered and declined, for this reason and for the
licensing problem that publishing a font makes real.

Uppercase hex is accepted and lowercased by the model, but the guarantee is
narrower than that sounds. Nothing in `backend/app/` calls `model_dump`, so
import and `Session.write_tour` both persist the document as authored, and
`test_the_shipped_tour_round_trips_byte_identically` is a deliberate guarantee
that rewriting it through pydantic would break. The model normalises and every
server-side reader sees one spelling; the file on disk may keep its own. That
is harmless, because the pattern has already refused anything that is not six
hex digits and CSS hex is case-insensitive.

An untouched **colour** is not stored, and an earlier wording of this record
overstated that. It said a tour that picks Archival stores
`{"preset": "archival"}` and nothing more. It does not: `setThemePreset`
writes all five keys, so what that tour holds is `{"preset": "archival",
"typePairing": "garamond", "typeScale": "comfortable", "layout": "widePanel",
"overrides": {}}`.

The substance is right and is the part that matters: **no colour is frozen.**
`overrides` is empty, so all thirteen resolve from the preset and a later
improvement to Archival's palette reaches that tour, where a document holding
thirteen resolved colours would be frozen against its own preset for good.
What *is* frozen is the **type pairing**, because choosing a preset writes the
preset's own face into the document — the mockup moved the pairing with the
theme and the design keeps that (§5.2) — so a later change to which face
Archival starts with does not reach a tour that already chose it. That is the
price of the mockup's behaviour, and it is a type pairing rather than a
palette, which is why it was worth paying.

### 3. The marker colours travel as a parameter, not a store, and teardown is half of that

Three colours are not CSS and no custom property reaches them: the pins' fill
and the route line in `map/map-pane.ts` (an inline style and a Leaflet option),
and the three marker colours in `panorama/mapillary-viewer.ts`, painted by
mapillary-js in WebGL. They have to be handed over as values.

The tempting route was a root-provided `ThemeStore` read by the viewer. It was
rejected because `editor/edit-panorama-pane.ts` calls `setMarkers` on the same
`PanoramaViewer`, so a store would theme the editor's panorama markers with the
tour's colours. Instead `PanoramaViewer` gains `setMarkerColours`, called only
from the viewer's own `panorama/panorama-pane.ts`; `MapPane` takes the
resolved theme as an input; and `mapillary-viewer.ts` keeps today's three
constants as its defaults. The editor's pane never asks for a themed marker.

**The first draft of the design claimed this made the editor unthemed "by
construction", and that was an overclaim.** `PANORAMA_VIEWER` is
`providedIn: 'root'` with `factory: () => new MapillaryViewer()`, and the
editor's panorama pane injects that same token: there is one viewer instance
for the whole app session. `markerColours` is mutable instance state, so
refusing to read a store is only half the job. `app.routes.ts` documents `/view`
as an author round-trip, and `/edit` → `/view` → `/edit` would leave the
editor's markers in the tour's accent — the outcome the store was rejected to
avoid.

So the guarantee has two parts: **the editor never asks for a themed marker,
and `destroy()` restores `DEFAULT_MARKER_COLOURS` so the viewer hands the
instance back in its default state.** The second is a line of teardown, not an
architectural property, and it must be `destroy()` and not `attach()`: the
colours effect in `panorama-pane.ts` is declared before the effect that
attaches, so resetting on attach would wipe the viewer's own colours on the way
in. The halves are pinned in different files: `panorama/mapillary-viewer.spec.ts`
("goes back to the defaults when destroyed", against a mapillary-js stub) pins
the reset, because the test double's `destroy()` never touches colours;
`editor/edit-panorama-pane.spec.ts` pins that the editor never calls the setter;
and `panorama/panorama-pane.spec.ts` pins the effect order, both using
`fake-viewer.ts`. If a
second consumer of the shared viewer ever sets colours, it inherits the same
duty.

The same reasoning puts the CSS tokens on the viewer's host element and never
on `:root`: `EntryPage` routes to `/edit` within the same page load, so tokens
on the document would sit there while the editor is on screen.

### 4. A pin reproduces today's appearance, and yields when that stops being the point

A preset may pin any token, and a pin beats a derivation: that is what lets
Nocturne be today's look exactly rather than approximately, because three of
the shipped colours are not reachable by any sensible mix of the core six.

But a pin exists to reproduce today's appearance, so once the author has moved
the palette out from under it, reproducing the old value is no longer a feature
but a bug. The whole-branch review's worked case was an author on the default
turning it into a light theme by setting `paper`, `panel` and `ink`: Nocturne's
pins outlived the palette they belonged to, and the result was a stop summary
at **1.69:1** and an overlay list at **1.09:1** — invisible, and neither of
them among the three pairs the pane's contrast readout showed. The author
would have fixed the accent they were warned about and published a tour whose
words could not be read.

So an override on any of the core six — `paper`, `panel`, `ink`, `accent`,
`wayfinding`, `destination` — releases the pins that exist only for legacy
exactness: `soft`, `muted`, `rule`, `chip`, `chipSelected`, `attributionBar`,
`mutedWeak`, `panoCanvas` and `onWayfinding`. Each then derives from the
palette the author actually chose, which is what §5.2's promise — "an author
who wants one strange panel colour gets coherent chips and rules for free" —
says the derivation layer is for. An override on a released token still wins,
so nothing the author set is lost. `error` and `pinRing` cannot join the list:
neither is derived from the core, so there is nothing for either to fall back
to, and `error` is deliberately outside the author's reach.

**Every tour already in the wild is untouched by this, and the reason is worth
stating precisely: none of them carries any override at all.** No core token
is overridden, so no pin is released and every value resolves as before. The
rule is reachable only by a document an author has themed.

The readout was widened in the same breath, to five pairs rather than three:
body text, **stop summary**, **overlay list**, accent and button label. It
still only warns — it disables nothing and blocks no save, which was the
author's decision.

And the derivation ratios were measured, which they had not been. `muted` and
`mutedWeak` came from a design mockup and are only ever *exercised* on the
three light presets, because Nocturne pins both; nobody had looked at them
there. `muted` was 3.48–3.62:1 against `panel` and 2.75–2.87:1 against
`attributionBar` — credits, "STOP 1 OF 6" and the footer's links, at 10 to
11.5 px — and `mutedWeak` was 1.30:1 against `rule`, a disabled label that is
not dimmed but gone. They are now `mix(ink, panel, 0.28)` and
`mix(muted, panel, 0.25)`, which give 5.83–6.24 and 4.62–4.89 and leave the
disabled control at 2.38–2.47, beside Nocturne's own pinned 2.46. `theme.ts`
carries the measurements in comments, and `theme.spec.ts` carries a contrast
floor for every foreground/background pair the viewer paints, on all four
presets, so the next change to a ratio is answered by a test rather than by a
mockup. Nocturne pins both of those tokens, so none of its values moved.

## Costs

**The primary button changed colour, and it is the only appearance change to a
tour that already exists.** The stop panel's Prev/Next button was blue
(`#2f7fd4` on `#fff`) and is now the accent — gold under the default Nocturne
preset. It was deliberate. `wayfinding` now means "another stop" and nothing
else; before, the same value meant "another stop" on the map and "primary
button" in the panel, so a primary action and a stop you are not at shared a
token. Giving the button `accent`/`onAccent` makes the blue purely
wayfinding. Everything else resolves to the values the application shipped
before this branch, and `theme.spec.ts` pins Nocturne's values in a table,
because nothing in the repository asserted any of those colours before. The
button itself is pinned by a spec in `viewer/viewer-page.spec.ts` that reads
`stop-panel.css` as text and requires `background: var(--accent)` and
`color: var(--on-accent)`, with a comment on why `wayfinding` is wrong there.

It took three attempts to get right, which is worth recording. The conversion
first mapped the button to `wayfinding`, preserving its colour; a review praised
that as correct; and it was caught only four tasks later, when the theme dialog's
subset test noticed `--on-accent` was read by nothing. A token that is defined
and read by nothing is the symptom to look for.

**`extra="forbid"` made this a version bump and a migration.** Adding one
optional field to `Tour` is a hard rejection for an older reader, which is the
"decision to bump often" ADR 0005 took. `_v3_to_v4` bumps the version and does
nothing else, because no tour acquires a `theme`; `fairfax-old-town-v3.json`
was frozen first, so v1 now migrates through three steps against real content.
The committed example stays a frozen v3 and is migrated on import like any
bundle. Ordering against the uploaded-base-imagery work is by landing: this took
v4, and that work takes the next number.

**The preview is a lookalike, and it can drift.** The theme dialog's live
miniature (`editor/theme-preview.ts`) is a static imitation of the viewer, not
the viewer. It consumes only token names, and `theme-dialog.spec.ts` asserts that
the `var(--…)` names its stylesheet uses are a subset of the names the viewer's
stylesheets define — a union of the `var(--…)` names those five stylesheets
read and the names `cssVariablesFor` emits, which is what lets `--wayfinding`
and `--destination` be checked rather than excused. Those two reach the
viewer's pins and markers as parameters from `markerColoursFor` and never
through CSS, so an earlier form of the test allow-listed them by hand and
could not have caught a rename of either. It catches a renamed token. It does
not catch a layout
that stops resembling the real one, or a type pairing that renders differently
at real sizes — nothing here can, and `UNVERIFIED.md` entry 43 says so. The
full-size check is the existing *Preview* link to `/view`.

**The fonts are bundled, and they are large.** Fourteen `woff2` files total
433,184 bytes, plus four OFL licence files that have to travel with them; the
latin-ext set (247,312 bytes) is bigger than the latin one (185,872) because
this is a tool for naming real places. `unicode-range` means a visitor downloads
only what their tour's text needs, but every file rides in every published zip.
The first estimate of the extended set was wrong by a factor of about sixty,
which is why the figures in this record are the measured ones.

## What this deliberately does not settle

**`Tour.attribution` is still open.** ADR 0005 said the question — which copy is
authoritative, the document's unread array or `ConfigStore.attribution()` from
`config.json` — had to be settled before theming landed on top of it. This work
did not settle it, and the author's decision was to leave it open. It did not
block: theming styles the attribution bar whichever copy feeds it. But the
reason it is worth keeping open on purpose is that the document now carries
presentation, which strengthens rather than weakens the case that it should
carry its own credits one day.

Also left alone: author-uploaded fonts, a per-tour basemap, per-stop themes,
and a theme for the editor, the welcome screen or the entry page — those are the
author's workbench and the application's front door, not the tour.

## What nobody has seen

Everything about how it looks. The preset values for three of the four themes,
their `error` colours and their `wayfinding`/`destination` pairs came from
mockups or from the design's author and have never been rendered; the three
layouts, the fonts under a published site's `<base href="./">`, `color-mix` and
the pins over real tiles are all pixels. They are `UNVERIFIED.md` entry 43,
and its first check is now whether the presets are legible at all: the derived
tokens that failed there are fixed and under test, and what is left —
Archival's accent at 3.95:1 on its own attribution bar and 3.66:1 on its
panorama canvas — is a mockup value no derivation can move, so it needs an eye
and a decision. The published-site font check led that list and has been
downgraded, because a CSS `url()` resolves against the stylesheet's own URL
rather than against `<base href>`, so the subdirectory half of it cannot fail.
