# UI customization — design

Written 2026-11-14, from a brainstorming conversation with the author. This is
the third of the three features ADR 0005 named as planned-but-not-built, and
the one that ADR 0005 audited the schema against. Read that record's section
"UI customization has nowhere to live" before this document; everything here
is built on top of its conclusion.

## 1. Intent, and why now

A tour should be able to look like its own subject. Nothing is wrong with the
current appearance — the author said so plainly — so this is not a repair. It
is expressiveness: a tour about 1860s Fairfax and a tour about a 1970s housing
estate should not arrive in the same dark-and-gold chrome, and today they must,
because the look is thirty-odd hex literals compiled into the application.

What an author gets is a **theme**: a starting preset, a set of colours they may
override with a free picker, a type pairing, a type scale, and one of three
layouts. It is stored in the document, so it survives export, import and
publish, and it shows in the editor's preview and in the published site because
both run the same viewer code against the same file.

## 2. Goals, non-goals, anti-goals

**Goals**

1. A theme is part of the tour document and round-trips through export and
   import without loss.
2. The same theme renders identically in the editor's preview and in the
   published static site, by being the same code path rather than two.
3. An author can reach any colour they want, including a bad one.
4. Existing tours keep working, and (with one named exception in §5.2) keep
   looking as they do today.
5. The resolution rules are pure functions, testable with no browser, because
   no browser runs in this development environment.

**Non-goals**

- Theming the editor, the welcome screen or the entry page. Those are the
  author's workbench and the application's front door, not the tour.
- A per-tour basemap or tile URL. ADR 0005 explains why it cannot live in the
  document today, and `config.json` would not survive a round trip.
- Author-uploaded font files. Considered and declined in §4.
- Resolving which copy of `Tour.attribution` is authoritative. See §7.
- Per-stop themes. A theme is tour-level.

**Anti-goals** — things that would make this a failure even if it worked

- A theme that can inject anything into the page. Everything an author can
  store is either an enumerated name or a six-digit hex colour.
- A theme that can make the *editor* unusable. An author who picks black-on-
  black must still be able to edit their way out of it.
- An extra network request on a published site, or a third-party font host.
- A preview that is not proof. If the preview and the published site could
  disagree, the preview is worse than nothing in an environment where nobody
  can look at the real thing.

## 3. Constraints

These come from the repository, not from preference.

1. **`config.json` is the wrong home.** It is derived state, rebuilt by
   `Session.write_config` on every open, import and example, and deliberately
   excluded from exported bundles. A theme there would vanish on a round trip.
   So the theme goes in `tour.json`, and therefore **schema v4 with a migration
   step** (`CHANGING-THINGS.md` entry 3).
2. **`extra="forbid"` and `schema_version: Literal[3]`** mean even a purely
   additive field is a hard rejection for an older reader. ADR 0005 took that
   as a decision to bump often.
3. **Nothing free-form may be interpolated into `style` or `src`.** An imported
   bundle is untrusted and a published site serves it from the author's own
   origin. ADR 0005's wording: *"enumerated tokens and bounded scalars, not
   strings the viewer interpolates"*. A `#rrggbb` validated by pattern is a
   bounded scalar; a font URL or a CSS blob is not.
4. **The viewer never calls `/api`.** A theme must arrive through
   `tour-data/tour.json`, which it does by being in the document.
5. **Components contain no document logic**, because nothing in a template can
   be verified here. The arithmetic goes in a pure function.
6. **`publish.py` has no document knowledge** — it imports `zipfile` and `Path`
   and zips two trees. Keeping it that way is a goal, not an accident; the
   uploaded-base-imagery design got this wrong once and had to correct it.
7. **No browser runs here.** `make check` runs `ng build`, so a broken asset
   reference fails the build, but nothing renders a page. Anything whose only
   proof is pixels goes to `UNVERIFIED.md`.

## 4. Approaches

**Chosen: CSS custom properties on the viewer's host element, written at
runtime from the document.** A pure `resolveTheme()` turns the stored theme
into a complete set of token values; the viewer writes them as inline custom
properties on its own host element; the viewer's five stylesheets consume
`var(--token)` where they hold literals today. Layout and type pairing are data
attributes on the same host. Nothing is generated, nothing is built, and
`publish.py` is untouched.

It wins on three counts that matter here. The arithmetic is pure, so it is
Vitest-testable with no DOM, which is this project's standing answer to having
no browser. Scoping to the viewer host rather than `:root` makes "the editor is
never themed" structural rather than a convention — and it still reaches the
Leaflet pins, because Leaflet builds marker icons inside the map container,
inside that host, and custom properties inherit down the DOM. And the published
site needs no new machinery at all, so the editor's preview is the same code
reading the same file, which is the only kind of preview worth having here.

**Rejected: generate a `theme.css` server-side at publish time.** It gives
`publish.py` the document knowledge constraint 6 exists to prevent, and worse,
it makes the preview a different mechanism from the published site, so the
preview stops being proof. A static host would also need the file regenerated
on every theme change.

**Rejected: four CSS preset classes and nothing else.** Cheapest by far, and it
cannot express the free colour pickers the author asked for.

**Rejected: per-component `[style.color]` bindings.** Puts document logic in
templates, against constraint 5, and in a repository where no template can be
observed running.

## 5. The design

### 5.1 The theme in the document

Schema v4 adds one optional field to `Tour`:

```python
HexColor = Annotated[
    str,
    Field(pattern=r"^#[0-9a-fA-F]{6}$"),
    AfterValidator(lambda v: v.lower()),
]

class ThemeOverrides(Strict):
    paper: HexColor | None = None
    panel: HexColor | None = None
    ink: HexColor | None = None
    accent: HexColor | None = None
    wayfinding: HexColor | None = None
    destination: HexColor | None = None
    soft: HexColor | None = None
    muted: HexColor | None = None
    rule: HexColor | None = None
    chip: HexColor | None = None
    chip_selected: HexColor | None = Field(default=None, alias="chipSelected")
    attribution_bar: HexColor | None = Field(default=None, alias="attributionBar")
    on_accent: HexColor | None = Field(default=None, alias="onAccent")

class Theme(Strict):
    preset: Literal["nocturne", "archival", "civic", "fieldNotes"] = "nocturne"
    type_pairing: Literal[
        "georgia", "garamond", "franklin", "plex", "franklinGaramond"
    ] = Field(default="georgia", alias="typePairing")
    type_scale: Literal["compact", "comfortable", "generous"] = Field(
        default="comfortable", alias="typeScale"
    )
    layout: Literal["widePanel", "panelLeft", "immersive"] = "widePanel"
    overrides: ThemeOverrides = Field(default_factory=ThemeOverrides)

class Tour(Strict):
    ...
    theme: Theme | None = None
```

Four decisions are packed into that, and each is deliberate:

- **An untouched token is not stored.** Every override is nullable and absent
  by default, so a tour that simply picks Archival stores no colour at all. A
  later improvement to Archival's palette then reaches that tour. A document
  that stored thirteen resolved colours would be frozen against its own preset
  forever.

  **An earlier draft of this document gave the stored document as `{"preset":
  "archival"}` and nothing more**, which is not what `setThemePreset` writes:
  it writes all five keys, so the document holds `{"preset": "archival",
  "typePairing": "garamond", "typeScale": "comfortable", "layout":
  "widePanel", "overrides": {}}`. The claim that matters survives — `overrides`
  is empty, so no colour is frozen — but the **type pairing is** frozen by it,
  which follows from §5.2's decision that the pairing moves with the preset,
  and is the price of that decision rather than an accident.
- **`theme` is nullable and absent means the default**, which is Nocturne with
  no overrides — today's appearance. This is what makes the migration a version
  bump and nothing else (§5.7).
- **Six hex digits.** No three-digit form, no named colours, no `rgb()`.
  Uppercase input is accepted and lowercased by the model, so a hand-authored
  `#FFF000` is not a frustrating refusal. This is the whole of constraint 3's
  compliance: the pattern cannot express `url(…)`, a semicolon, or a closing
  brace.

  **What "lowercased" does and does not mean.** An earlier draft of this
  document claimed `tour.json` holds one spelling. It does not, and should not:
  nothing in `backend/app/` calls `model_dump`, so both the import path and
  `Session.write_tour` persist the document exactly as authored, and
  `test_the_shipped_tour_round_trips_byte_identically` is a deliberate
  guarantee that rewriting it through pydantic would break. So the rule is
  narrower — **the model normalises, and every server-side reader sees one
  spelling; an authored document may keep its own spelling on disk.** That is
  harmless: the pattern has already refused anything that is not six hex
  digits, and CSS hex is case-insensitive, so `#9C5A24` reaching the browser
  renders identically. `resolveTheme` lowercases override values on the
  TypeScript side as well, so comparisons there do not depend on case.
- **Only names of things we serve are enumerated.** A type pairing names font
  files in our own bundle, and a layout names a grid we have had to lay out, so
  both are `Literal`s. Colour is not a file, so colour is free.

### 5.2 Resolution: six authored, thirteen authorable, eighteen in the end

`frontend/src/app/core/theme.ts` holds the preset table and one pure function:

```ts
export function resolveTheme(theme: Theme | null | undefined): ResolvedTheme
```

It returns every token as a concrete `#rrggbb`. Six tokens are the authored
core, each supplied by the preset; seven more are authorable but **derive from
the core until the author sets one**, after which they hold what was set; five
more are internal and never appear in the pane.

**A preset may pin any token, including an internal one, and a pinned value
beats a derivation.** That is what lets Nocturne reproduce today's appearance
exactly rather than approximately — three of today's colours are not
reproducible by any reasonable derivation, and inventing a derivation that
happened to hit them would be worse than writing them down.

| Token | Source when not overridden | Where it shows |
| --- | --- | --- |
| `paper` | preset | the page behind the viewer |
| `panel` | preset | stop panel, minimap backdrop |
| `ink` | preset | body text and headings |
| `accent` | preset | tour title, selected chip, primary button, the pin for the stop you are on, the route line |
| `wayfinding` | preset | the pin for any *other* stop, and an unselected panorama marker |
| `destination` | preset | the panorama marker pointing at the next stop |
| `soft` | `mix(ink, panel, 0.22)` | stop summary, slider labels |
| `muted` | `mix(ink, panel, 0.28)` | small caps, credits, attribution text |
| `rule` | `mix(panel, ink, 0.18)` | borders and dividers |
| `chip` | `mix(panel, ink, 0.07)` | an overlay list item |
| `chipSelected` | `mix(panel, accent, 0.14)` | the selected one |
| `attributionBar` | `mix(paper, ink, 0.08)` | the footer, and Leaflet's control at 75% |
| `onAccent` | `#121212` or `#ffffff`, whichever has more contrast against `accent` | button label, the current pin's number |
| `onWayfinding` (internal) | the same rule, against `wayfinding` | another stop's pin number |
| `mutedWeak` (internal) | `mix(muted, panel, 0.25)` | disabled control text |
| `panoCanvas` (internal) | `mix(paper, ink, 0.12)` | the mapillary container, seen while an image loads |
| `error` (internal) | preset; never derived, never overridable | the viewer's fatal message, a panorama error |
| `pinRing` (internal) | `#ffffff`, fixed | the ring separating a pin from the map tiles |

**Two ratios were corrected after measurement, and a pin now yields.** The
whole-branch review found that the ratios above had only ever been *exercised*
on the three light presets — Nocturne pins these tokens — and had never been
measured there: `muted` sat at 2.75:1 against the attribution bar and
`mutedWeak` at 1.31:1 against `rule`, against AA's 4.5 for the 10-11.5 px text
they paint. `muted` is therefore `0.28` and `mutedWeak` `0.25`, which clears AA
on all three and puts the disabled control at ~2.4, matching Nocturne's own
pinned 2.46. No existing tour moved, because Nocturne pins both.

The same review found the paragraph below false where it matters most. A pin
beats a derivation, and Nocturne pins twelve authorable tokens — so on the
default preset, overriding `panel` did **not** bring the chips and rules with
it, and an author who lightened the palette shipped a stop summary at 1.69:1
and an overlay list at 1.09:1 while the pane reported a pass. **So a preset's
legacy-exactness pins — `soft`, `muted`, `rule`, `chip`, `chipSelected`,
`attributionBar`, `mutedWeak`, `panoCanvas`, `onWayfinding` — yield to their
derivations once any of the core six carries a valid override, unless that
token is itself overridden.** A pin exists to reproduce today's appearance;
once the author has moved the palette out from under it, reproducing the old
value is a bug rather than a feature. `error` and `pinRing` never yield:
neither is derived from the core. Existing tours are untouched because they
carry no overrides at all.

`wayfinding` and `destination` are in the author's hands rather than fixed per
preset, which was the author's decision. They carry **state, not brand**:
`accent` means "the stop you are on", `wayfinding` means "another stop", and
`destination` means "the way to the next stop". Folding any of them into
`accent` would destroy a distinction a visitor navigates by, which is why they
are three tokens and not one.

The derivation is why the pane is usable: an author who wants one strange panel
colour gets coherent chips and rules for free, and the pane labels each row
`preset`, `derived` or `set` so it is never a mystery which is which.

`mix` is a linear sRGB interpolation of two hex colours. It is deliberately
naive — no perceptual space, no gamma correction — because the author's own
override is always available and a cleverer mix would be a worse thing to have
to explain. Contrast is measured with the WCAG relative-luminance formula.

**The four presets.** Nocturne pins everything, because it is today's
appearance and exactness matters more there than tidiness. Every value below is
lifted from the current source, not chosen:

| Token | Nocturne | From |
| --- | --- | --- |
| `paper` | `#14161a` | `styles.css` `body` |
| `panel` | `#1b1e24` | `stop-panel.css`, `map-pane.css` |
| `ink` | `#ecebe6` | `styles.css` `body` |
| `accent` | `#e8b04b` | `.tour-title`, `.active`, `map-pane.ts` current pin |
| `wayfinding` | `#2f7fd4` | `map-pane.ts` other pin, `mapillary-viewer.ts` `UNSELECTED` |
| `destination` | `#5fd08a` | `mapillary-viewer.ts` `DESTINATION` |
| `soft` | `#c3c7cf` | `.summary` |
| `muted` | `#9aa0ab` | `.position`, `.credit`, Leaflet attribution |
| `rule` | `#333944` | every border |
| `chip` | `#252a32` | `.overlay-list button` |
| `chipSelected` | `#2d323c` | `.overlay-list button.active` |
| `attributionBar` | `#0f1114` | `.attribution` |
| `onWayfinding` | `#ffffff` | `map-pane.ts` other pin's number — pinned, see below |
| `mutedWeak` | `#6d7480` | `.controls button:disabled` |
| `panoCanvas` | `#111111` | `panorama-pane.css` `.panorama` |
| `error` | `#e8825b` | `.fatal` |

`onAccent` resolves by the contrast rule to `#121212` (9.58 against
`#e8b04b`, against 1.95 for white), which is what `map-pane.ts` writes today
for the current pin's number — it writes `#14161a`, near enough to be
indistinguishable, and the token is the honest value, so the one-off literal
goes.

**`onWayfinding` is pinned, and an earlier draft of this document had it
wrong.** That draft claimed the contrast rule resolves it to `#ffffff`. It does
not: `#2f7fd4` scores **4.56** against `#121212` and only **4.11** against
white, so the rule picks dark — while `map-pane.ts` writes `#ffffff` for
another stop's number today. Deriving it would therefore change an existing
tour's appearance, which goal 4 forbids. Nocturne pins
`onWayfinding: #ffffff`, making it a sixteenth pinned value; the rule that a
preset may pin any token is what makes this expressible. The other three
presets derive it, because they have no legacy appearance to preserve.

**A preset also carries a default type pairing, which an earlier draft of this
document dropped.** The interactive mockup the author used and approved paired
each theme with a face — `nocturne: georgia`, `archival: garamond`,
`civic: franklin`, `fieldNotes: plex` — and changing the theme moved the
pairing with it. The §5.2 table recorded only colours and §5.1 gave a single
global default of `georgia`, so as specified, picking *Field notes* produced
oxide-red colours set in Georgia serif rather than the typewriter headings on
screen when the author said yes. That reduces the four presets to colour
variants, which is precisely the outcome the author rejected when they chose
self-hosted faces over system stacks.

So `THEME_PRESETS` carries a `pairing` per preset, and `setThemePreset` writes
it alongside clearing the overrides — the same "starting point" semantics the
mockup had, where choosing a theme resets what it governs. An author who then
picks a different pairing keeps it until they change preset again.

The other three presets supply their core six and an `error`, and let the
derivations do the rest. These values came from the approved mockups except the
three `error` colours and the `wayfinding`/`destination` pairs, **which are my
choice and not the author's** — the mockups never showed an error state or a
themed pin:

| Preset | `paper` | `panel` | `ink` | `accent` | `wayfinding` | `destination` | `error` |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Archival | `#f4ecdd` | `#fbf6ea` | `#2e2418` | `#9c5a24` | `#4a6274` | `#4f6b2a` | `#9e2f1b` |
| Civic | `#eef1f4` | `#ffffff` | `#1b2430` | `#1f5c8f` | `#6b7684` | `#1d6b66` | `#b3261e` |
| Field notes | `#f7f5ef` | `#fffefb` | `#23241f` | `#a3341f` | `#4b5a63` | `#4f6b2a` | `#8a2a12` |

Field notes is the awkward one: its accent is already a red, so its `error` is
distinguished only by being darker. If the builder finds that unreadable in
place, change it — `error` is internal, so no document depends on its value.

**The one visible change to the existing tour, and it is my call, not the
author's.** Today the stop panel's primary button is blue (`#2f7fd4` on
`#fff`), while the accent everywhere else is gold. Under this design the button
takes `accent` / `onAccent`, so the Fairfax tour's *Next stop* button becomes
gold. One accent applied consistently is the better design and it is what the
approved mockups showed, but it does change the shipped tour's appearance.

**No existing test will catch that**, which is worth saying plainly: nothing in
`frontend/src/app` asserts any of these hex values today, so this change would
land silently. That is the argument for §6's test 2, not against it — the
Nocturne pinning test is the only thing that will ever notice a colour
regression here, and it should be written to expect gold for the button and to
carry a comment saying the blue was retired deliberately.

The blue is not lost, incidentally. `#2f7fd4` becomes `wayfinding`, where it
means "another stop" and nothing else — a clearer job than it has today, when
the same value means "another stop" on the map and "primary button" in the
panel.

### 5.3 Type pairings and the font files

Five pairings over four families plus Georgia:

| Pairing | Headings | Body |
| --- | --- | --- |
| `georgia` | Georgia | Georgia — no font files, today's |
| `garamond` | EB Garamond | EB Garamond |
| `franklin` | Libre Franklin | Libre Franklin |
| `plex` | IBM Plex Mono | IBM Plex Sans |
| `franklinGaramond` | Libre Franklin | EB Garamond |

All three families are under the SIL Open Font License, so bundling and
redistributing them with a published site is permitted provided the licence
travels with them — see the paragraph on `dist/` below, which is where that
nearly went wrong.

**The heading weight travels with the pairing, and an earlier draft left it to
the user agent.** No viewer stylesheet sets `font-weight`, so `<h2>`/`<h3>`
take the UA default `bold` (700). For the three variable families that is
accidentally correct — 700 is outside the declared `400 600`, so it clamps to
600 and the wght axis genuinely moves. But `'IBM Plex Mono'` ships as a single
static 500 face, and 700 against a 500 candidate is exactly the condition
browsers answer with **synthetic emboldening** — so `plex`, the one pairing
whose whole identity is its mono headings, would render them algorithmically
smeared rather than as the Medium that was fetched for them. The heading rule
therefore reads `font-weight: var(--display-weight, 600)`, and the `plex` rule
sets `--display-weight: 500`.

**The `font-weight: 400 600` range on the three variable faces is
load-bearing.** It is what makes a UA `bold` heading land on a real 600 instead
of synthesising one. A later tidy-up that sees one file and "corrects" the
descriptor to `400` would clamp every heading to regular and silently remove
the weight contrast from every pairing, with no test failing. The descriptor
needs a comment saying so. The claim is verifiable without `fontTools`: a
WOFF2's table directory is readable without brotli, `fvar` is present only in
a variable font, and Node's `zlib.brotliDecompressSync` will yield the axis
records — EB Garamond is `wght 400..800`, Libre Franklin `100..900`, IBM Plex
Sans `100..700`.

**The latin subset is not enough for this application, which is a decision
rather than an oversight.** The fetched files cover ASCII, `é`, `ü`, dashes and
curly quotes, but **not** Latin Extended-A: `ł`, `č`, `ő`, `ş`, `Š`, `ą` are
all absent. A walking tour is a tool for naming real places, and this
project's own tester search covered six European sites; a stop called *Łódź* or
*Český Krumlov* would render glyph-by-glyph half in the chosen face and half in
the fallback — visible, silent, and content-dependent, so no test in this
repository could catch it. So the `latin-ext` files ship too, each declared
with its `unicode-range`, which means a tour whose text is plain ASCII
downloads none of them.

**The cost, measured, because this document's first estimate was wrong by a
factor of about sixty.** It guessed "roughly 4 kB per family". The seven
`latin-ext` files are **247,312 bytes**, against 185,872 for the seven latin
ones — so the extended set is *larger* than the base. `ebgaramond-latin-ext`
alone is 113,756 bytes, 2.6× its own latin file. That is not an error in the
fetch: the latin subset is a small glyph set, `latin-ext` is a much larger one,
and in a variable face every glyph carries per-axis deltas.

What it actually costs is the thing worth stating, and it is not the disk
figure. Fonts on disk total 433,184 bytes and all eighteen files ride in every
published zip — negligible beside the 4.5 MB the Fairfax tour's media already
weighs. The eager bundle grew 0.39 kB, because only the `@font-face` CSS is
eager. And a **visitor** fetches only the faces their tour's own text needs: a
plain-ASCII Archival tour pulls `ebgaramond.woff2` (44 kB) and nothing else,
while a tour with Czech place names also pulls the 114 kB extended face —
which is the tour that needs it. `unicode-range` is what makes the large number
harmless, and without it this trade would not be worth making.

**The author has authorised fetching and committing them.** The files are
downloaded once from Google Fonts or the families' upstream repositories and
committed to the tree. This is deliberate rather than incidental: ADR 0004 and
`ENVIRONMENT.md` treat outbound network use here as an authorised act, and the
alternative — `@fontsource/*` as three npm dependencies — was declined to keep
the dependency list short, in a repository that keeps `three` transitive on
purpose. Nothing is fetched at build time or at run time.

The faces needed are regular, italic and semibold for each body
face (`.summary` is italic, so a synthesised oblique would be visible) and
medium for Plex Mono, which is headings only — about ten `woff2` files, latin
subset. **The count and the total size must be measured, not taken from this
document**; the working estimate used in conversation was ~25 kB a file and
~250 kB in total, and it is an estimate.

**Who applies the stacks, which an earlier draft left to nobody.** This
document said the pairings set `--display` and `--body`, and §5.6 said the
stylesheets consume the tokens — but no task was ever told to write a
`font-family` rule, and none did, so the two tokens were defined and read by
nothing. The gap closed in Task 5: `app-viewer-page` takes
`font-family: var(--body)` and its `h1, h2, h3` take `var(--display)`, both as
descendant-scoped rules in `styles.css` so neither can reach the editor, the
welcome screen or the entry page.

**The token definitions are scoped by attribute, not by tag.** The five
`[data-type-pairing='…']` rules match any element carrying the attribute
rather than `app-viewer-page` alone, because the editor's live preview (§5.8)
sits inside the editor and not inside the viewer, so a tag-scoped rule would
leave the preview with no fonts at all. The alternative — restating five
pairings against the preview's own tag — is the duplication these tokens exist
to avoid. Scoping by attribute is still not global: an element gets the tokens
only by asking for them, and only the viewer and the preview ever set the
attribute. The `font-family` *application* stays per-component, so nothing
inherits a family by accident.

The files go in `frontend/src/assets/fonts/` and are referenced relatively from
`styles.css`, **not** in `frontend/public/`. The reason is constraint 7: the
`@angular/build:application` builder processes and fingerprints a `url()` it
can resolve and **fails the build on one it cannot**, so a wrong path is caught
by `make check`. A file in `public/` is copied verbatim and a wrong path is a
runtime 404, which nothing in this environment can see.

**The licence file is the exception, and it needs an explicit step.**
`angular.json` copies only `public/**` as assets, and a file under
`src/assets/` reaches `dist/` *only* if something resolves a `url()` to it.
Nothing resolves a `url()` to a text file, and `build_site` zips `dist`, so
`OFL.txt` sitting beside the fonts would never reach a published site at all —
which is precisely the condition the OFL attaches to redistributing them. Add
an `assets` entry to `angular.json` for the licence (or put that one file in
`public/fonts/`), and confirm it is present in `dist/` before calling this
done.

`@font-face` declarations are global (they must be) and cost a few hundred
bytes in the eager bundle. The font *files* are separate requests the browser
makes only when a matching rule applies, and the family is selected by a
`data-type-pairing` attribute on the viewer host, so **a visitor downloads only
the pairing their tour uses**. Every file does ship inside every published zip,
because `build_site` copies all of `dist`; that is a zip-size cost, not a
visitor cost, and it should be stated in `DEPLOY.md` once measured.

### 5.4 Layouts

Three, as data attribute `data-layout` on the viewer host, each a
`grid-template-areas` block in `viewer-page.css`:

- `widePanel` — today: panorama over map on the left, stop panel full height on
  the right, attribution across the bottom.
- `panelLeft` — the mirror.
- `immersive` — panorama full width across the top, then stop panel and a
  narrower map side by side, attribution across the bottom.

**All three share today's narrow-width stacking** (panorama, map, panel,
attribution, in that order) below the existing 900 px breakpoint. That is my
call: three bespoke phone layouts would be three more things nobody can look
at, and the stacking order is the same regardless of how the wide layout was
arranged.

### 5.5 Type scale

`compact` 0.88, `comfortable` 1.0, `generous` 1.14, as `--type-scale`.

Each `font-size` in the viewer's stylesheets becomes
`calc(<existing value> * var(--type-scale))` — **twelve** declarations, counted
(an earlier draft estimated "about twenty"). Deliberately not done by scaling
the root font size, which would mean theming `:root` (§5.6), and deliberately
not done by converting `rem` to `em`, because the viewer nests font-sized
elements (`.kind` inside `.overlay-list button`) and `em` would compound.

**Wrapping those twelve is not sufficient, and an earlier draft of this
document missed why.** The viewer's longest prose carries no `font-size` of its
own: the overlay body paragraph in `stop-panel.html` has no rule sizing it,
`.summary` has none, and `.controls button` is `font: inherit`. All three
inherit from `body`, which keeps its literal — so an author choosing `generous`
would get larger headings, chips and labels while the actual reading text, the
stop summary and the Prev/Next labels stayed put. That reads as a bug, not a
design.

So the viewer host also takes `font-size: calc(1rem * var(--type-scale))`.
This is safe against the compounding the paragraph above rules out, for a
reason worth stating: every sized descendant is declared in `rem`, which is
relative to the **root** element and therefore indifferent to the host's own
size, so `.kind` stays at `calc(0.62rem * scale)` rather than multiplying by
it. Only elements with no size of their own inherit the host's, which is
exactly the set that was being left behind. And it is on the host, not `:root`,
so §5.6's rule is untouched.

### 5.6 How it reaches the pixels

`ViewerPage` gains a small effect: when the tour loads, call `resolveTheme` and
write the result onto its own host element as inline custom properties, plus
`data-layout` and `data-type-pairing` attributes. That is the only place the
DOM is touched, and it is a flat loop over a resolved record — no conditionals,
nothing to get subtly wrong in a template.

**Not `:root`, and not `document.documentElement`.** `EntryPage` mounts
`ViewerPage` at `''` and then routes to `/edit` **within the same page load**
when a tour is open, so tokens written to `:root` would outlive the viewer and
sit on the document while the editor is on screen. Harmless today, because no
editor rule would read them, and exactly the kind of latent coupling that
becomes a bug the first time someone reuses a token name. Host-scoped, it
cannot happen.

The viewer host therefore also takes `background: var(--paper)` and
`min-height: 100vh`, so `body`'s literal `#14161a` in `styles.css` stays where
it is and is simply never visible behind the viewer — including under the
mobile breakpoint, where `.layout` is `height: auto`.

About **31** colour literals in the viewer's five stylesheets become `var()`
references: `stop-panel.css` 18, `viewer-page.css` 6, `map-pane.css` 4,
`panorama-pane.css` 2, and — of `styles.css`'s **12** — **exactly one**, the
`.stop-pin span` border, which becomes `var(--pin-ring)`. (An earlier draft of
this document said 13. The file held 12 hex literals at the merge base, plus
one `rgba()`, which is the shadow mentioned below; the code and the test
comment have the right figure and only this sentence was stale.)

An earlier draft of this document said "4 of `styles.css`'s 13", counting that
file's viewer-*side* literals rather than the ones that convert. Three of those
four stay, each for a reason: `body`'s `background` and `color` keep their
literals so the editor and welcome screen keep them, the viewer host painting
`var(--paper)` and `var(--ink)` over them instead; and the pin's `box-shadow`
rgba is a shadow, not a theme colour. The remaining nine in that file are the
editor's form controls and are not the viewer's at all.

The 90 literals in `editor/`, `welcome/` and `entry/` are not touched.

`--type-scale` is not one of the eighteen colour tokens, so `cssVariablesFor`
does not emit it; the viewer writes it from `ResolvedTheme.scaleFactor`
alongside them.

#### Three colours are not in CSS, and custom properties cannot reach them

This is the part a first draft of this design missed, and it is where the
feature's promise is most visible. Each of these needs the resolved theme
handed to it as a value:

- **`map/map-pane.ts:140`** builds each pin's fill as an **inline style
  attribute** in TypeScript — `const background = current ? '#e8b04b' :
  '#2f7fd4'` and a matching label colour — and an inline style beats any
  stylesheet rule, `var()` or not. It takes `accent`/`onAccent` for the current
  pin and `wayfinding`/`onWayfinding` for the others. **Only the `#fff` ring in
  `styles.css`'s `.stop-pin span` is reachable by CSS**, as `var(--pin-ring)`;
  an earlier draft of this document claimed the fill was too, and it was wrong.
- **`map/map-pane.ts:90`** draws the route with
  `new Polyline(path, { color: '#e8b04b', … })`, a Leaflet option. It takes
  `accent`.
- **`panorama/mapillary-viewer.ts:15-17`** holds `SELECTED`, `UNSELECTED` and
  `DESTINATION`, passed to `SimpleMarker` at line 132 and rendered by
  mapillary-js in WebGL. There is no CSS anywhere near it. They become
  `accent`, `wayfinding` and `destination`.

**How the colours get there, and why not through a store.** `PanoramaViewer`
gains `setMarkerColours(colours: MarkerColours)`, and `MapPane` gains the
resolved theme as an input. Both are called **only from the viewer's own
components** — `panorama/panorama-pane.ts` and `map/map-pane.ts`.

A root-provided `ThemeStore` injected into `mapillary-viewer.ts` would have
been less plumbing and is the wrong answer, because `editor/edit-panorama-pane.ts:134`
calls `setMarkers` on *the same* `PanoramaViewer`. A store would quietly theme
the editor's panorama markers with the tour's colours, breaking the one
structural promise this design makes. As a parameter, the editor pane simply
never calls `setMarkerColours`, and `mapillary-viewer.ts` keeps today's three
constants as its defaults. The editor's map is already a separate component
(`editor/edit-map-pane.ts`, with its own 17 literals), so it needs nothing.

**But "by construction" was too strong, and the Task 4 review caught why.**
`PANORAMA_VIEWER` is `providedIn: 'root'` with `factory: () => new
MapillaryViewer()`, and `editor/edit-panorama-pane.ts:68` injects that same
token — **one viewer instance for the whole app session**. `markerColours` is
mutable instance state, so refusing to read a store is only half the job: once
the viewer has run, the field still holds the tour's colours, and
`app.routes.ts` documents `/view` precisely as an author round-trip ("for an
author who wants to see their open tour as a reader will"). So `/edit` →
`/view` → `/edit` leaves the editor's markers painted in the tour's accent —
the same visible outcome the store was rejected for.

The parameter design is still right; it just needs the residue cleared.
**`destroy()` must restore `DEFAULT_MARKER_COLOURS`.** It must be `destroy()`
and **not** `attach()`: the colours effect in `panorama-pane.ts` is declared
*before* the effect that attaches, so resetting on attach would wipe the
viewer's own colours on the way in.

The honest statement of the guarantee is therefore: the editor never *asks*
for a themed marker, and the viewer hands the instance back in its default
state. Both halves are needed, and the second is a line of teardown rather
than an architectural property.

**And this is verifiable here**, which is the part that makes it acceptable
under constraint 5. Handing a resolved hex to a library API is not document
logic in a template — the arithmetic stays in `resolveTheme` — and
`panorama/fake-viewer.ts` is the existing test double, so a Vitest spec can
assert that `PanoramaPane` passed the tour's three colours and that
`EditPanoramaPane` passed none, with no browser involved. Only the final pixels
are unverifiable, and those go to `UNVERIFIED.md`.

One CSS detail that is easy to get wrong: `map-pane.css` has
`rgba(15, 17, 20, 0.75)` for the Leaflet attribution control — the
attribution-bar colour at 75%. Use
`color-mix(in srgb, var(--attribution-bar) 75%, transparent)`. If the builder
judges `color-mix` too new for the testers' browsers, the fallback is a solid
`var(--attribution-bar)` and a note that the translucency was dropped; do not
add a token for it.

### 5.7 Migration

`_v3_to_v4` is a version bump and nothing else:

```python
def _v3_to_v4(doc):
    out = deepcopy(doc)
    out["schemaVersion"] = 4
    return out
```

No tour acquires a `theme` key. Absent resolves to Nocturne with no overrides,
which is today's appearance, so **no document already in the wild changes how it
looks** — subject to the primary-button note in §5.2, which changes Nocturne
itself and therefore changes every existing tour's button. That is the one place
goal 4 is knowingly broken.

Before the bump: freeze `backend/tests/fixtures/fairfax-old-town-v3.json`, a
snapshot of the repository's real tour at v3, never refreshed, so the chain is
exercised end to end against real content. `fairfax-old-town-v1.json` then
migrates through three steps.

The committed example `content/examples/fairfax-old-town/tour.json` stays a
frozen v3 snapshot and is migrated on import like any other bundle, which keeps
`test_opening_the_fairfax_example_matches_the_recorded_figures` passing
unchanged — the theme touches no media and no count.

### 5.8 The editor's theme pane

A new `app-theme-pane` in `editor/`, in the sidebar beneath `app-inspector-pane`,
with the layout agreed from a working mockup: preset dropdown; six colour rows
(page, panel, text, accent, *another stop*, *the way onward*), each with
suggested swatches, a free `<input type="color">` and a reset arrow;
a disclosure holding the other seven rows; *Reset every colour to the preset*;
type pairing; type scale; three layout thumbnails; and a contrast readout.

**The contrast readout warns and never refuses.** This was the author's explicit
decision. It shows body-on-panel, accent-on-panel and button-label-on-accent
ratios, goes amber when any falls below AA, and says so in plain words — the
agreed wording is *"Body text 2.1:1 — below the AA standard. You can publish it
anyway."* It must not disable any control and must not block autosave.

Every change goes through a pure op in `document-ops.ts`, in the existing style
(return the same reference to signal no-op): `setThemePreset`,
`setThemeOverride`, `clearThemeOverride`, `clearThemeOverrides`,
`setTypePairing`, `setTypeScale`, `setTourLayout`. Changing the preset clears
the overrides, which is what the mockup did and what an author expects from
"starting point". Autosave then carries it like any other edit.

**The live miniature** (`theme-preview.ts`) is a static lookalike of the viewer
— panorama placeholder, map placeholder with pins, stop panel, attribution bar
— rendered with the same resolved tokens. It is **not** the real viewer, and the
cost is that it can drift from it. Two mitigations, both cheap: it consumes only
token names, and a test asserts that the set of `var(--…)` names its stylesheet
uses is a subset of the names the viewer's stylesheets use, so a token renamed
in one place fails. The full-size check remains the existing *Preview* link to
`/view`, which stays a plain `<a href>` and a full page load.

The pane is inside the lazy `edit` chunk, so none of it reaches a published
visitor.

## 6. Verification

`make check` must stay green: lint, 696-plus backend, 740-plus frontend,
production build.

New tests, following this repository's habits:

1. **`resolveTheme` is pure and total** — Vitest, no DOM. Every preset resolves
   all eighteen tokens; an absent theme equals Nocturne; an override wins over a
   derivation; a preset's pinned value wins over a derivation; setting `panel`
   moves `chip`, `rule` and `chipSelected`; `onAccent` and `onWayfinding` flip
   on a light input; `mix` and the contrast ratio have fixed-value cases.
2. **Nocturne reproduces today's values** — a table test asserting the resolved
   tokens equal the hex values the current source holds, taken from the table in
   §5.2 and including the three in TypeScript, not only the stylesheets. This is
   the test that makes goal 4 enforceable instead of asserted, and since
   **nothing in the repository pins any of these colours today** it is also the
   only thing that would ever notice a regression. It expects gold for the
   primary button, with a comment recording that the blue was retired on
   purpose.
3. **Schema and migration** — `HexColor` refuses `#fff`, `red`, `#12345g`,
   `url(x)` and `#ffffff;`; accepts and lowercases `#AABBCC`; the v3→v4 step is
   exercised through `migrate`; `test_the_v1_fixture_migrates_through_both_steps…`
   becomes three steps; the v3 fixture migrates and validates.
4. **A drift test in this repo's idiom** — a backend test reads
   `frontend/src/app/core/theme.ts` as text and asserts its preset names, type
   pairings, scales and layouts match the Python `Literal`s, in the manner of
   `test_the_frontend_mode_table_matches_this_one`. That means those lists must
   be written in a form a regex can find; copy the one-line, single-quoted
   convention `IMAGE_EXTS` uses and say so in a comment.
5. **The token-name subset test** for the miniature, from §5.8.
6. **The theme round-trips** — a backend test that a bundle exported with a
   theme and overrides re-imports with them identical.
7. **Ops** — `document-ops.spec.ts` cases for each new op, including that a
   no-op returns the same reference and that changing preset clears overrides.
8. **The colours reach the markers, and only in the viewer** — using
   `fake-viewer.ts`: `PanoramaPane` passes `accent`, `wayfinding` and
   `destination` from the loaded tour, and `EditPanoramaPane` passes no
   colours at all, so `mapillary-viewer.ts` keeps its defaults in the editor.
   A sibling case asserts `MapPane` builds a current pin with `accent`/
   `onAccent` and any other pin with `wayfinding`/`onWayfinding`.

**What no test here can prove**, and therefore goes to `UNVERIFIED.md` as a new
block of entries for the first browser session:

- that any of the four presets is legible on a real screen;
- that the three layouts hold together at real sizes, and that the narrow
  stacking works on a phone;
- that the font files actually load on a published site under
  `<base href="./">` in a subdirectory;
- that `color-mix` renders as intended in the testers' browsers;
- that the pins and the panorama markers read well over real map tiles and real
  street imagery — a `wayfinding` colour that separates cleanly from grey
  squares in a mockup may disappear into a dense basemap, and a `destination`
  marker has to be findable in a photograph;
- that the live miniature resembles the viewer closely enough to be useful.

The published-site font check is the highest-risk of these, because it is the
one that fails only after an author has published.

## 7. What this deliberately does not settle

ADR 0005 said the `Tour.attribution` question had to be settled before theming
landed on top of it: the field is in the document and completely unread, because
the viewer renders `ConfigStore.attribution()` from `config.json`, and no
editor op writes the document's copy. The author's decision is to **leave it and
record it as still open**. Theming styles the attribution bar whichever copy
feeds it, so it does not block this work; the reason for noting it is that the
document now carries presentation, which strengthens rather than weakens the
case that it should carry its own credits one day.

Also left: author-uploaded fonts (§4 and the media allowlist in
`CHANGING-THINGS.md` entry 8, plus a font-licensing problem publishing makes
real); a per-tour basemap; per-stop themes.

**Ordering against Outstanding item 11.** The uploaded-base-imagery work also
wants a schema bump. Whichever lands first takes v4 and the other takes v5;
`migrate`'s registry makes that a function and a dictionary entry either way, so
there is no need to decide now. This design assumes it is v4 and the builder
should renumber if that has stopped being true.

## 8. What is left to the builder

- The exact `mix` ratios in §5.2 are starting values from a mockup, not
  measurements. Adjust them if a preset's derived chips or rules look wrong,
  and keep the authored six as they are.
- The three `error` colours and the three `wayfinding`/`destination` pairs for
  the new presets (§5.2). They are my choice, not the author's; `error` is
  internal and `wayfinding`/`destination` are preset defaults an author can
  override, so changing any of them breaks no document.
- The precise font files, weights and subsets, and whether ten is the right
  number. Measure the result and report it; do not carry this document's
  estimate forward as fact. Confirm the licence file reaches `dist/` (§5.3).
- Whether `color-mix` or a solid fallback is right for the Leaflet attribution
  control (§5.6).
- The wording of the pane's labels. The mockup carried explanatory text that was
  for the author's benefit in conversation and must not ship; the plain labels
  are *Theme*, *Colours*, *More colours*, *Type pairing*, *Type scale*,
  *Layout*.
- Task order, and which tasks are parallel-safe. Note that §5.6's refactor and
  §5.8's pane both touch `document-ops.ts` and `tour.models.ts`, and that the
  schema bump in §5.1 and §5.7 is a dependency of nearly everything else.
