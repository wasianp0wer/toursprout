# UI customization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an author give each tour its own look — colours, typefaces, type
scale and one of three layouts — stored in the document so it survives export,
import and publish, and visible in the editor's preview and the published site.

**Architecture:** The theme is an optional field on `Tour` (schema v4). A pure
`resolveTheme()` in `core/theme.ts` turns it into eighteen concrete `#rrggbb`
tokens; `ViewerPage` writes them as inline CSS custom properties on its own
host element, and the viewer's stylesheets consume `var()`. Three colours live
in TypeScript rather than CSS (map pins, the route polyline, mapillary-js
markers) and take the resolved values as parameters — never through a root
store, because the editor's panorama pane shares the same `PanoramaViewer`.

**Tech Stack:** pydantic v2, FastAPI, Angular 22 (`@angular/build:application`),
Vitest, pytest, Leaflet 1.9, mapillary-js 4.1.2. No new runtime dependency.

**Spec:** [`docs/superpowers/specs/2026-11-14-ui-customization-design.md`](../specs/2026-11-14-ui-customization-design.md)

## Global Constraints

- **Nothing free-form may reach `style` or `src`.** Every author-supplied value
  is an enumerated name or `^#[0-9a-fA-F]{6}$`, stored lowercased.
- **The editor, welcome screen and entry page are never themed.** The 90 colour
  literals in `editor/`, `welcome/` and `entry/` are not touched, and nor are
  the nine editor form-control literals inside `styles.css`.
- **Tokens go on the viewer's host element, never `:root`.** `EntryPage` routes
  to `/edit` within the same page load.
- **Nocturne reproduces today's appearance exactly**, from the value table in
  spec §5.2, with one deliberate exception: the stop-panel primary button moves
  from `#2f7fd4` to `accent` (gold).
- **`publish.py` gains no document knowledge.** It still imports `zipfile` and
  `Path` and is not modified by this plan.
- **`make check` must be green at the end of every task.** Node 24 is pinned by
  the Makefile; Angular's build cache stays disabled.
- **Never use `urllib`** — it truncates through the egress proxy. `httpx` only.
- **Commits:** let git use its own config; never pass `-c user.email=...`.
  End each message with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.

## Review Focus

Five things the spec implies and no task's happy path exercises. Each has a test
assigned to the task that owns the code.

1. **`theme` absent vs `theme: null`.** `tour.models.ts` already records that
   the on-disk file has no `defaults` key while the API serialises `null`; the
   same will be true of `theme`. Both must resolve to Nocturne. → Task 2.
2. **An unknown `preset`, `typePairing` or `layout` reaching the viewer.** The
   frontend has no migration, so a hand-unzipped or hand-edited document can
   carry one. A published site must still render rather than throw. → Task 2.
3. **An uppercase hex inside an imported bundle.** Lowercasing must happen on
   the import path, not only on `PUT /api/session/tour`. → Task 1.
4. **An override set to exactly the preset's own value.** It must persist, not
   be silently treated as unset. → Task 6.
5. **A mid-grey accent at the contrast boundary.** `onAccent` must pick
   deterministically for an input where black and white score near-equally.
   → Task 2.

---

## File Structure

**Backend**
- `backend/app/models.py` — `HexColor`, `ThemeOverrides`, `Theme`, `Tour.theme`, `SCHEMA_VERSION = 4`
- `backend/app/migration.py` — `_v3_to_v4`, one `_MIGRATIONS` entry
- `backend/tests/fixtures/fairfax-old-town-v3.json` — frozen, never refreshed
- `content/tours/fairfax-old-town.json` — `schemaVersion` bumped by hand (see Task 1)

**Frontend — shared**
- `frontend/src/app/core/theme.ts` — presets, derivation, `resolveTheme`; the single source of the token set
- `frontend/src/app/core/tour.models.ts` — the hand-kept mirror

**Frontend — viewer**
- `frontend/src/styles.css` — `@font-face` blocks, `--pin-ring` on `.stop-pin span`
- `frontend/src/app/viewer/viewer-page.{ts,css}` — token application, three grids, type scale
- `frontend/src/app/stop/stop-panel.css`, `map/map-pane.css`, `panorama/panorama-pane.css` — `var()`
- `frontend/src/app/map/map-pane.ts` — pin fills, route colour
- `frontend/src/app/panorama/{panorama-viewer,mapillary-viewer,fake-viewer,panorama-pane}.ts` — marker colours

**Frontend — editor**
- `frontend/src/app/editor/theme-pane.{ts,html,css}` — the pane
- `frontend/src/app/editor/theme-preview.{ts,html,css}` — the live miniature
- `frontend/src/app/editor/document-ops.ts` — seven pure ops

**Assets and build**
- `frontend/src/assets/fonts/*.woff2`, `.../OFL-*.txt`
- `frontend/angular.json` — an `assets` entry so the licence reaches `dist/`

**Docs** — `docs/decisions/0009-the-look-is-in-the-document.md`, `HANDOFF.md`,
`UNVERIFIED.md`, `CHANGING-THINGS.md`, `ARCHITECTURE.md`

**Dependencies:** 1 → 2 → 3 → 4 → 5 → 6 → 7. **All sequential.**

**Nothing here is parallel-safe.** An earlier draft marked 5 ∥ 6, on the
grounds that Task 5 writes `styles.css`, `angular.json` and `src/assets/`
while Task 6 writes `editor/` and `document-ops.ts` — no write overlap. That
test was the wrong one. Task 5 **produces** `--display` and `--body`, and Task
6's token-subset test **consumes** them from `styles.css`; in separate
worktrees Task 6 cannot see them and its test fails against a correct preview.
Compare which interfaces a task consumes, not only which files it writes.
(Two worktrees would also mean two `node_modules` and two virtualenvs — see
`docs/HANDOFF.md` on a pass in one checkout not being a pass in the other.)

---

### Task 1: Schema v4 — the theme in the document

**Files:**
- Create: `backend/tests/fixtures/fairfax-old-town-v3.json`
- Modify: `backend/app/models.py`, `backend/app/migration.py`
- Modify: `content/tours/fairfax-old-town.json` (the `schemaVersion` value only)
- Test: `backend/tests/test_models.py`, `backend/tests/test_migration.py`, `backend/tests/test_bundle.py`

**Interfaces:**
- Consumes: nothing.
- Produces: `SCHEMA_VERSION = 4`; `Theme` with fields `preset`, `type_pairing`
  (alias `typePairing`), `type_scale` (alias `typeScale`), `layout`,
  `overrides`; `ThemeOverrides` with thirteen `HexColor | None` fields;
  `Tour.theme: Theme | None = None`.

- [ ] **Step 1: Freeze the v3 fixture before anything else**

```bash
cp content/tours/fairfax-old-town.json backend/tests/fixtures/fairfax-old-town-v3.json
python3 -c "import json;assert json.load(open('backend/tests/fixtures/fairfax-old-town-v3.json'))['schemaVersion']==3"
```

This must happen first: once `SCHEMA_VERSION` is 4 there is no v3 document in
the tree to snapshot. Add the same "never refreshed" comment the v1 and v2
fixtures carry, in `test_migration.py`.

- [ ] **Step 2: Write the failing tests**

In `backend/tests/test_models.py`:

```python
def test_a_hex_colour_must_be_six_digits_with_a_hash():
    for bad in ("#fff", "red", "#12345g", "url(x)", "#ffffff;", "", "#ffffffff"):
        with pytest.raises(ValidationError):
            ThemeOverrides(accent=bad)

def test_a_hex_colour_is_stored_lowercased():
    assert ThemeOverrides(accent="#AABBCC").accent == "#aabbcc"

def test_a_theme_defaults_to_nocturne_with_no_overrides():
    t = Theme()
    assert (t.preset, t.type_pairing, t.type_scale, t.layout) == (
        "nocturne", "georgia", "comfortable", "widePanel")
    assert t.overrides.model_dump(exclude_none=True) == {}

def test_a_tour_has_no_theme_by_default():
    assert _tour().theme is None

def test_an_unknown_preset_is_refused():
    with pytest.raises(ValidationError):
        Theme(preset="brutalist")
```

In `backend/tests/test_migration.py`:

```python
def test_v3_to_v4_is_a_version_bump_and_changes_nothing_else():
    doc = json.loads(FIXTURES.joinpath("fairfax-old-town-v3.json").read_text())
    out = migrate(doc)
    assert out["schemaVersion"] == SCHEMA_VERSION == 4
    assert {k: v for k, v in out.items() if k != "schemaVersion"} == \
           {k: v for k, v in doc.items() if k != "schemaVersion"}

def test_the_v3_fixture_migrates_and_validates():
    Tour.model_validate(migrate(json.loads(
        FIXTURES.joinpath("fairfax-old-town-v3.json").read_text())))

def test_the_v1_fixture_migrates_through_three_steps_to_the_current_version():
    # rename and extend the existing two-step test
```

In `backend/tests/test_bundle.py` — spec §6 test 6, and Review Focus 3:

```python
def test_a_theme_survives_export_and_import(tmp_path):
    """The whole reason the theme is in the document and not config.json."""
    doc = _minimal_doc() | {"theme": {"preset": "archival",
        "typePairing": "garamond", "typeScale": "generous",
        "layout": "immersive", "overrides": {"accent": "#4f6b2a"}}}
    # write_bundle -> read_bundle
    assert back["theme"] == doc["theme"]

def test_an_imported_bundle_lowercases_an_uppercase_override(tmp_path):
    # a v4 doc whose theme.overrides.accent is "#9C5A24"
    # read_bundle -> Tour -> accent == "#9c5a24"
```

- [ ] **Step 3: Run them to verify they fail**

Run: `cd backend && uv run pytest tests/test_models.py tests/test_migration.py tests/test_bundle.py -v`
Expected: FAIL — `ImportError`/`NameError` on `Theme` and `ThemeOverrides`, and
version assertions failing on `3 != 4`.

- [ ] **Step 4: Implement the models in `backend/app/models.py`**

Add `HexColor` (`Annotated[str, Field(pattern=...), AfterValidator(lower)]`),
`ThemeOverrides`, `Theme` and `Tour.theme` exactly as spec §5.1 gives them;
both classes extend `Strict`. Bump `SCHEMA_VERSION` to `4` **and**
`Tour.schema_version` to `Literal[4]` — two separate places.

- [ ] **Step 5: Implement `_v3_to_v4(doc: dict) -> dict` in `backend/app/migration.py`**

`deepcopy`, set `schemaVersion` to `4`, return. Add `3: _v3_to_v4` to
`_MIGRATIONS`. Nothing else in that module changes — `migrate` chains it.

- [ ] **Step 6: Bump the committed seed tour by hand**

Edit `content/tours/fairfax-old-town.json` so `schemaVersion` reads `4`, and
change nothing else. `test_the_shipped_tour_is_valid_at_the_current_version`
reads that file raw and asserts the version. **Do not run `make content`** —
it regenerates from `content/source/stops.json`, which has drifted, and would
revert the hand-tuned rephoto alignment (HANDOFF Outstanding item 2).
`content/examples/fairfax-old-town/tour.json` stays at v3: it is a frozen
snapshot and is migrated on import.

- [ ] **Step 7: Run the whole backend suite and fix the fallout**

Run: `cd backend && uv run ruff check app tests ../content/scripts && uv run pytest -q`
Expected: PASS, and ruff clean. **Lint is part of `make check` (`check: lint
backend-test frontend-test build`), so a ruff error leaves the branch red even
with every test green.** Known breakages to fix, not work around:
`test_migration.py` line ~228 asserts `SCHEMA_VERSION == 3` literally;
`test_session.py` checks the skeleton's version via `SCHEMA_VERSION`, which
needs nothing; `_minimal_doc` in `test_bundle.py` and any helper that writes
`"schemaVersion": 3`.

- [ ] **Step 8: Commit**

```bash
git add backend/app/models.py backend/app/migration.py backend/tests content/tours/fairfax-old-town.json
git commit -m "Give a tour a theme, at schema v4"
```

---

### Task 2: `core/theme.ts` — presets, derivation, resolution

**Files:**
- Create: `frontend/src/app/core/theme.ts`, `frontend/src/app/core/theme.spec.ts`
- Modify: `frontend/src/app/core/tour.models.ts`
- Test: also `backend/tests/test_models.py` (the drift test)

**Interfaces:**
- Consumes: Task 1's field names and literals.
- Produces:

```ts
export type PresetName = 'nocturne' | 'archival' | 'civic' | 'fieldNotes';
export type TypePairing = 'georgia' | 'garamond' | 'franklin' | 'plex' | 'franklinGaramond';
export type TypeScale = 'compact' | 'comfortable' | 'generous';
export type LayoutName = 'widePanel' | 'panelLeft' | 'immersive';

export interface ThemeOverrides { /* 13 optional string fields, spec §5.2 names */ }
export interface Theme { preset: PresetName; typePairing: TypePairing;
                         typeScale: TypeScale; layout: LayoutName;
                         overrides: ThemeOverrides; }

/** Eighteen colour tokens plus the three enumerated choices and the factor. */
export interface ResolvedTheme {
  paper: string; panel: string; ink: string; accent: string;
  wayfinding: string; destination: string; soft: string; muted: string;
  rule: string; chip: string; chipSelected: string; attributionBar: string;
  onAccent: string; onWayfinding: string; mutedWeak: string;
  panoCanvas: string; error: string; pinRing: string;
  typePairing: TypePairing; typeScale: TypeScale; layout: LayoutName;
  scaleFactor: number;
}
export interface MarkerColours { accent: string; wayfinding: string; destination: string; }

export function mix(a: string, b: string, t: number): string;
export function contrastRatio(a: string, b: string): number;
export function readableOn(background: string): string;
export function resolveTheme(theme: Theme | null | undefined): ResolvedTheme;
export function cssVariablesFor(r: ResolvedTheme): Record<string, string>;
export function markerColoursFor(r: ResolvedTheme): MarkerColours;
```

Plus four **one-line, single-quoted** arrays the backend drift test finds by
regex, in the manner of `IMAGE_EXTS`:

```ts
export const PRESET_NAMES = ['nocturne', 'archival', 'civic', 'fieldNotes'] as const;
export const TYPE_PAIRINGS = ['georgia', 'garamond', 'franklin', 'plex', 'franklinGaramond'] as const;
export const TYPE_SCALES = ['compact', 'comfortable', 'generous'] as const;
export const LAYOUT_NAMES = ['widePanel', 'panelLeft', 'immersive'] as const;
```

- [ ] **Step 1: Write the failing tests** in `frontend/src/app/core/theme.spec.ts`

```ts
it('resolves Nocturne to exactly the colours the application ships today', () => {
  const r = resolveTheme(null);
  expect(r.paper).toBe('#14161a');       expect(r.panel).toBe('#1b1e24');
  expect(r.ink).toBe('#ecebe6');         expect(r.accent).toBe('#e8b04b');
  expect(r.wayfinding).toBe('#2f7fd4');  expect(r.destination).toBe('#5fd08a');
  expect(r.soft).toBe('#c3c7cf');        expect(r.muted).toBe('#9aa0ab');
  expect(r.rule).toBe('#333944');        expect(r.chip).toBe('#252a32');
  expect(r.chipSelected).toBe('#2d323c');
  expect(r.attributionBar).toBe('#0f1114');
  expect(r.mutedWeak).toBe('#6d7480');   expect(r.panoCanvas).toBe('#111111');
  expect(r.error).toBe('#e8825b');       expect(r.pinRing).toBe('#ffffff');
});
// The one deliberate departure: the stop-panel primary button was #2f7fd4 and
// is now the accent. #2f7fd4 survives as `wayfinding`. Spec §5.2.

it('treats an absent theme and a null theme alike', () => { /* Review Focus 1 */
  expect(resolveTheme(undefined)).toEqual(resolveTheme(null));
});

it('falls back to Nocturne rather than throwing on an unknown preset', () => {
  // Review Focus 2: a hand-unzipped document must still render
  const r = resolveTheme({ preset: 'brutalist', typePairing: 'nope',
                           typeScale: 'huge', layout: 'spiral', overrides: {} } as never);
  expect(r.paper).toBe('#14161a');
  expect(r.typePairing).toBe('georgia');
  expect(r.layout).toBe('widePanel');
  expect(r.scaleFactor).toBe(1);
});

it('lets an override beat a derivation and a preset pin beat a derivation', () => { … });
it('moves chip, rule and chipSelected when panel is overridden', () => { … });
it('picks a readable label on an accent, deterministically at the boundary', () => {
  expect(readableOn('#ffffff')).toBe('#121212');
  expect(readableOn('#000000')).toBe('#ffffff');
  // Review Focus 5. A mid-grey scores near-equally against both candidates,
  // so pin readableOn to contrastRatio rather than to a hand-computed hex:
  // the relationship is the behaviour, and it cannot encode a wrong value.
  // Mirror the rule's direction exactly — dark wins a tie — or the test
  // asserts the inverse of what the implementation documents. Note the tie
  // itself is unreachable: no 8-bit grey ties (nearest is #797979, gap
  // 0.0498), so this mirrors the rule and cannot prove it.
  const c = '#767676';
  const expected = contrastRatio('#ffffff', c) > contrastRatio('#121212', c)
    ? '#ffffff' : '#121212';
  expect(readableOn(c)).toBe(expected);
});
it('mixes two colours in sRGB', () => { expect(mix('#000000', '#ffffff', 0.5)).toBe('#808080'); });
it('computes WCAG contrast', () => { expect(contrastRatio('#ffffff', '#000000')).toBeCloseTo(21, 1); });
it('names a CSS variable per colour token', () => {
  expect(cssVariablesFor(resolveTheme(null))['--paper']).toBe('#14161a');
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd frontend && npx ng test --watch=false`
Expected: FAIL — cannot resolve `./theme`.

- [ ] **Step 3: Implement `frontend/src/app/core/theme.ts`**

The preset tables are spec §5.2 verbatim — Nocturne pins all fifteen colour
values, the other three supply their core six plus `error`. `TYPE_SCALE_FACTORS`
is `compact: 0.88, comfortable: 1, generous: 1.14`. `mix` is linear sRGB;
`contrastRatio` is WCAG relative luminance; `readableOn` returns whichever of
`#121212` and `#ffffff` scores higher, preferring `#121212` on a tie so the
result is stable. `resolveTheme` validates each enumerated field against the
arrays above and substitutes the default for anything unrecognised.

- [ ] **Step 4: Mirror the schema in `frontend/src/app/core/tour.models.ts`**

Add `theme?: Theme | null` to `Tour`, re-exporting `Theme` from `./theme`, and
change `schemaVersion: 3` to `schemaVersion: 4`. Fix the compile errors this
causes in `editor/document-ops.ts` and `editor/test-builders.ts`.

- [ ] **Step 5: Add the backend drift test** in `backend/tests/test_models.py`

Put the regex reader in `backend/tests/theme_vocabulary.py` as
`names_in(array_name: str) -> list[str]`, not inline: Task 5 needs the same
reader for the type pairings, and two regexes over one file is the drift these
tests exist to prevent.

```python
def test_the_frontend_theme_vocabulary_matches_this_one():
    """Next to test_the_frontend_mode_table_matches_this_one, same idiom:
    read the TypeScript as text so the two copies cannot drift."""
    text = (REPO / "frontend/src/app/core/theme.ts").read_text()
    for name, values in (
        ("PRESET_NAMES", get_args(Theme.model_fields["preset"].annotation)),
        ("TYPE_PAIRINGS", get_args(Theme.model_fields["type_pairing"].annotation)),
        ("TYPE_SCALES", get_args(Theme.model_fields["type_scale"].annotation)),
        ("LAYOUT_NAMES", get_args(Theme.model_fields["layout"].annotation)),
    ):
        line = re.search(rf"const {name} = \[(.*?)\]", text).group(1)
        assert re.findall(r"'([^']+)'", line) == list(values)
```

Also assert `ThemeOverrides.model_fields.keys()` matches the `ThemeOverrides`
field names found in `theme.ts`, so a thirteenth token cannot be added on one
side only.

- [ ] **Step 6: Run the whole check, not just the suites**

Run: `make check`
Expected: `All checks passed!`. **Run `make check` rather than the two suites: it
is `lint backend-test frontend-test build`, and a ruff error in a new test
module leaves the branch red with every test passing.** That happened on this
branch — `I001` and two `FURB167`s went unnoticed for a whole task.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/app/core backend/tests/test_models.py frontend/src/app/editor
git commit -m "Resolve a theme into eighteen tokens, purely"
```

---

### Task 3: The viewer wears the theme

**Files:**
- Modify: `frontend/src/app/viewer/viewer-page.ts`, `viewer-page.css`
- Modify: `frontend/src/app/stop/stop-panel.css`, `map/map-pane.css`, `panorama/panorama-pane.css`
- Modify: `frontend/src/styles.css` (the `.stop-pin span` ring only)
- Test: `frontend/src/app/viewer/viewer-page.spec.ts`

**Interfaces:**
- Consumes: `resolveTheme`, `cssVariablesFor`, `ResolvedTheme` from Task 2.
- Produces: `ViewerPage.resolved` — a `Signal<ResolvedTheme>` later tasks read;
  `data-layout` and `data-type-pairing` attributes on the viewer host.

- [ ] **Step 1: Write the failing tests** in `viewer-page.spec.ts`

```ts
it('writes the resolved tokens onto its own host, not the document root', () => {
  // load a tour with theme.preset 'archival'
  expect(host.style.getPropertyValue('--paper')).toBe('#f4ecdd');
  expect(document.documentElement.style.getPropertyValue('--paper')).toBe('');
});
it('reflects the layout and the type pairing as attributes', () => {
  expect(host.getAttribute('data-layout')).toBe('panelLeft');
  expect(host.getAttribute('data-type-pairing')).toBe('garamond');
});
it('still renders a tour that carries no theme', () => { /* no theme key at all */ });
```

Plus a text assertion in the manner of `entry-page.spec.ts`, which jsdom cannot
compute:

```ts
it('paints the page colour on the host so body never shows through', () => {
  const css = readFileSync('src/app/viewer/viewer-page.css', 'utf8');
  expect(css).toMatch(/:host\s*\{[^}]*background:\s*var\(--paper\)/);
  expect(css).toMatch(/:host\s*\{[^}]*min-height:\s*100vh/);
});
it('defines a grid for every layout name', () => {
  for (const name of LAYOUT_NAMES) expect(css).toContain(`[data-layout='${name}']`);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd frontend && npx ng test --watch=false`
Expected: FAIL — no `--paper` on the host.

- [ ] **Step 3: Apply the tokens in `viewer-page.ts`**

A computed `resolved = computed(() => resolveTheme(this.tour()?.theme))` and an
effect that loops `cssVariablesFor(resolved())` onto the host element via
`ElementRef`, then sets the two attributes. A flat loop and two
`setAttribute`s — no conditionals.

- [ ] **Step 4: Convert the stylesheets**

Replace the ~34 literals with `var()` per the spec §5.2 "where it shows"
column. In `viewer-page.css` add `:host { background: var(--paper);
min-height: 100vh }` and the three `[data-layout='…']` grid blocks (spec §5.4),
all sharing today's stacking below the existing 900 px breakpoint. Wrap each
`font-size` in `calc(<value> * var(--type-scale))` (spec §5.5). For Leaflet's
attribution control use
`color-mix(in srgb, var(--attribution-bar) 75%, transparent)`.
In `styles.css`, `.stop-pin span`'s `border` colour becomes `var(--pin-ring)`
and **nothing else in that file changes** — the nine editor form-control
literals stay.

- [ ] **Step 5: Run the frontend suite and the production build**

Run: `cd frontend && npx ng test --watch=false && cd .. && make check`
Expected: PASS, `All checks passed!`. A `var()` typo shows up as a lint or
build failure, not a test failure, which is why `make check` runs here.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/app/viewer frontend/src/app/stop frontend/src/app/map frontend/src/app/panorama frontend/src/styles.css
git commit -m "Dress the viewer from tokens rather than literals"
```

---

### Task 4: The three colours CSS cannot reach

**Files:**
- Modify: `frontend/src/app/panorama/panorama-viewer.ts`, `mapillary-viewer.ts`, `fake-viewer.ts`, `panorama-pane.ts`
- Modify: `frontend/src/app/map/map-pane.ts`
- Modify: `frontend/src/app/viewer/viewer-page.html` (pass the theme to `app-map-pane`)
- Test: `frontend/src/app/panorama/panorama-pane.spec.ts`, `frontend/src/app/map/map-pane.spec.ts`, `frontend/src/app/editor/edit-panorama-pane.spec.ts`

**Interfaces:**
- Consumes: `MarkerColours`, `markerColoursFor`, `ResolvedTheme` (Task 2);
  `ViewerPage.resolved` (Task 3).
- Produces: `PanoramaViewer.setMarkerColours(colours: MarkerColours): void`;
  `MapPane`'s `theme` input of type `ResolvedTheme | null`.

- [ ] **Step 1: Write the failing tests**

```ts
// panorama-pane.spec.ts — via fake-viewer, which records what it was given
it('hands the tour colours to the viewer', () => {
  expect(fake.markerColours).toEqual({ accent: '#9c5a24',
                                       wayfinding: '#4a6274',
                                       destination: '#4f6b2a' });
});
// edit-panorama-pane.spec.ts — the structural promise
it('never sets marker colours, so the editor keeps the defaults', () => {
  expect(fake.markerColours).toBeNull();
});
// map-pane.spec.ts
it('builds the current pin from the accent and the others from wayfinding', () => {
  expect(iconHtmlFor(1, true)).toContain('background:#9c5a24');
  expect(iconHtmlFor(1, true)).toContain('color:#ffffff');
  expect(iconHtmlFor(2, false)).toContain('background:#4a6274');
});
it('draws the route in the accent', () => { expect(polylineOptions.color).toBe('#9c5a24'); });
it('falls back to the Nocturne values when no theme is set', () => { … });
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd frontend && npx ng test --watch=false`
Expected: FAIL — `setMarkerColours` is not a function; pins contain `#e8b04b`.

(The frontend suite runs whole — `npx ng test --watch=false`, as the Makefile's
`frontend-test` target does. Bare `npx vitest run` fails across the suite with
"window is not defined", and path filters are not available here, so every
frontend step below runs all 740 tests. It is fast enough.)

- [ ] **Step 3: Add `setMarkerColours` to the `PanoramaViewer` interface and both implementations**

`mapillary-viewer.ts` keeps today's `SELECTED`/`UNSELECTED`/`DESTINATION` as
the **initial** values of a private field, so a caller that never sets them —
the editor — is unchanged. `fake-viewer.ts` records the last value, `null`
until called. `panorama-pane.ts` calls it from an effect on the resolved theme;
`edit-panorama-pane.ts` is not modified.

- [ ] **Step 4: Take the colours in `map-pane.ts`**

Add the `theme` input; `pin(order, current)` reads `accent`/`onAccent` or
`wayfinding`/`onWayfinding` from it, and the `Polyline` option reads `accent`.
With no theme, fall back to `resolveTheme(null)`. Pass `[theme]="resolved()"`
from `viewer-page.html`.

- [ ] **Step 5: Run the suite and the build**

Run: `cd frontend && npx ng test --watch=false && cd .. && make check`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/app/panorama frontend/src/app/map frontend/src/app/viewer
git commit -m "Colour the pins and markers from the theme, by parameter"
```

---

### Task 5: The typefaces *(parallel-safe with Task 6)*

**Files:**
- Create: `frontend/src/assets/fonts/*.woff2`, `frontend/src/assets/fonts/OFL-<family>.txt`
- Modify: `frontend/src/styles.css` (`@font-face` blocks and the pairing rules)
- Modify: `frontend/angular.json` (an `assets` entry for the licences)
- Test: `frontend/src/app/core/theme.spec.ts` is untouched; a new
  `backend/tests/test_fonts.py`

**Interfaces:**
- Consumes: `TYPE_PAIRINGS` (Task 2); the `data-type-pairing` attribute (Task 3).
- Produces: `--display` and `--body` font stacks selected by that attribute.

- [ ] **Step 1: Fetch the files**

EB Garamond (400, 400 italic, 600), Libre Franklin (400, 400 italic, 600),
IBM Plex Mono (500), IBM Plex Sans (400, 400 italic, 600) — latin subset
`woff2`. Resolve the URLs from the Google Fonts `css2` API and fetch with
**`httpx`, never `urllib`** (it truncates through the egress proxy about one
request in ten). Take each `OFL.txt` from `google/fonts` on raw.githubusercontent.com.
Report the file count and the measured total; the spec's ~10 files / ~250 kB is
an estimate and must not be carried forward as fact.

- [ ] **Step 2: Write the failing test** in `backend/tests/test_fonts.py`

```python
def test_every_type_pairing_has_its_faces_declared():
    """A pairing an author can choose must resolve to a family we ship."""
    css = (REPO / "frontend/src/styles.css").read_text()
    for pairing in names_in("TYPE_PAIRINGS"):   # theme_vocabulary, from Task 2
        assert f"[data-type-pairing='{pairing}']" in css

def test_the_font_licences_reach_the_build_output():
    """src/assets only ships what a url() pulls in, and nothing resolves a
    url() to a text file — so the licence needs its own assets entry."""
    assets = json.loads((REPO / "frontend/angular.json").read_text()) \
        ["projects"]["frontend"]["architect"]["build"]["options"]["assets"]
    assert any("fonts" in json.dumps(a) for a in assets)
    assert list((REPO / "frontend/src/assets/fonts").glob("OFL-*.txt"))
```

- [ ] **Step 3: Run to verify it fails**

Run: `cd backend && uv run pytest tests/test_fonts.py -v`
Expected: FAIL — no `data-type-pairing` rules, no assets entry.

- [ ] **Step 4: Declare the faces and the pairings in `styles.css`**

One `@font-face` per file with a **relative** `url('assets/fonts/…')` so the
builder resolves, fingerprints and **fails the build on a wrong path**; then
one rule per pairing setting `--display` and `--body`, scoped to
`app-viewer-page[data-type-pairing='…']` so none of it can reach the editor.
`georgia` needs no files.

- [ ] **Step 5: Add the licence assets entry to `angular.json`**

An `{ "glob": "OFL-*.txt", "input": "src/assets/fonts", "output": "fonts" }`
entry beside the existing `public` one.

- [ ] **Step 6: Verify the build output actually contains them**

Run: `cd frontend && npx ng build && ls dist/frontend/browser/fonts/ && ls dist/frontend/browser/media/ | head`
Expected: the `OFL-*.txt` files present, and the fingerprinted `woff2` files
emitted. Then `cd .. && make check`.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/assets/fonts frontend/src/styles.css frontend/angular.json backend/tests/test_fonts.py
git commit -m "Ship four typefaces, with their licences"
```

---

### Task 6: The editor's theme pane *(parallel-safe with Task 5)*

**Files:**
- Create: `frontend/src/app/editor/theme-pane.{ts,html,css}`, `theme-preview.{ts,html,css}`, `theme-pane.spec.ts`
- Modify: `frontend/src/app/editor/document-ops.ts`, `editor-page.html`
- Test: `frontend/src/app/editor/document-ops.spec.ts`, `theme-pane.spec.ts`

**Interfaces:**
- Consumes: `resolveTheme`, `cssVariablesFor`, `contrastRatio`, the four name
  arrays (Task 2).
- Produces: seven ops —

```ts
setThemePreset(tour: Tour, preset: PresetName): Tour
setThemeOverride(tour: Tour, token: keyof ThemeOverrides, hex: string): Tour
clearThemeOverride(tour: Tour, token: keyof ThemeOverrides): Tour
clearThemeOverrides(tour: Tour): Tour
setTypePairing(tour: Tour, pairing: TypePairing): Tour
setTypeScale(tour: Tour, scale: TypeScale): Tour
setTourLayout(tour: Tour, layout: LayoutName): Tour
```

- [ ] **Step 1: Write the failing op tests** in `document-ops.spec.ts`

```ts
it('stores only what the author set', () => {
  const t = setThemePreset(tour, 'archival');
  expect(t.theme).toEqual({ preset: 'archival', typePairing: 'garamond',
    typeScale: 'comfortable', layout: 'widePanel', overrides: {} });
});
it('keeps an override that equals the preset value', () => { // Review Focus 4
  const t = setThemeOverride(setThemePreset(tour, 'archival'), 'accent', '#9c5a24');
  expect(t.theme!.overrides.accent).toBe('#9c5a24');
});
it('lowercases a hex on the way in', () => {
  expect(setThemeOverride(tour, 'accent', '#9C5A24').theme!.overrides.accent).toBe('#9c5a24');
});
it('clears the overrides when the preset changes', () => { … });
it('returns the same reference when nothing changes', () => {
  const t = setThemePreset(tour, 'nocturne');
  expect(setThemePreset(t, 'nocturne')).toBe(t);
});
it('refuses a malformed hex by returning the same reference', () => {
  expect(setThemeOverride(tour, 'accent', 'red')).toBe(tour);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd frontend && npx ng test --watch=false`
Expected: FAIL — `setThemePreset` is not exported.

- [ ] **Step 3: Implement the seven ops in `document-ops.ts`**

In the existing style: never mutate, return the same reference to signal
no-op. `setThemeOverride` validates against the same `^#[0-9a-fA-F]{6}$` and
lowercases; an invalid hex is a refusal, not a throw. Changing the preset
replaces `theme` wholesale with that preset's defaults.

- [ ] **Step 4: Write the failing pane and preview tests** in `theme-pane.spec.ts`

```ts
it('shows a contrast warning without disabling anything', () => {
  // ink #111 on panel #0f0f0f
  expect(warning().textContent).toContain('below the AA standard');
  expect(warning().textContent).toContain('You can publish it anyway');
  expect(pane.querySelectorAll('button[disabled],input[disabled]').length).toBe(0);
});
it('labels each colour row preset, derived or set', () => { … });
it('uses only token names the viewer also defines', () => {
  const mine = varNames(readFileSync('src/app/editor/theme-preview.css', 'utf8'));
  // styles.css is in the set on purpose: --display and --body are declared
  // there (Task 5), not in a component stylesheet, so a subset test that read
  // only the four component files would fail on a correct preview.
  const theirs = new Set([...varNames(viewerCss), ...varNames(stopPanelCss),
                          ...varNames(mapPaneCss), ...varNames(panoramaPaneCss),
                          ...varNames(globalCss)]);
  for (const name of mine) expect(theirs).toContain(name);
});
it('ships no explanatory mockup copy', () => {
  const html = readFileSync('src/app/editor/theme-pane.html', 'utf8');
  for (const phrase of ['font files we serve', 'starting point', 'derived until set'])
    expect(html).not.toContain(phrase);
});
```

- [ ] **Step 5: Run to verify they fail, then implement the pane**

Run: `cd frontend && npx ng test --watch=false`
Expected: FAIL — no such component.

Build `ThemePane` per spec §5.8: preset dropdown; six colour rows (page, panel,
text, accent, *another stop*, *the way onward*) each with swatches, an
`<input type="color">` and a reset arrow; a `<details>` holding the other seven;
*Reset every colour to the preset*; type pairing; type scale; three layout
thumbnails; the contrast readout. `ThemePreview` is a static miniature styled
from `cssVariablesFor`. Labels are exactly *Theme*, *Colours*, *More colours*,
*Type pairing*, *Type scale*, *Layout* — the mockup's explanatory text must not
ship. Add `<app-theme-pane />` to the sidebar in `editor-page.html` beneath
`<app-inspector-pane />`.

- [ ] **Step 6: Run everything**

Run: `cd frontend && npx ng test --watch=false && cd .. && make check`
Expected: PASS. Confirm the editor chunk is still lazy and the eager bundle has
not grown — report both figures from the build output.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/app/editor
git commit -m "Give the author a theme pane, with a live miniature"
```

---

### Task 7: Write it down

**Files:**
- Create: `docs/decisions/0009-the-look-is-in-the-document.md`
- Modify: `docs/decisions/README.md`, `docs/HANDOFF.md`, `docs/UNVERIFIED.md`, `docs/CHANGING-THINGS.md`, `docs/ARCHITECTURE.md`
- Test: `backend/tests/test_models.py` (no new test; the drift tests already pin the rules)

- [ ] **Step 1: Write ADR 0009**

Why the theme is in the document and not `config.json` (round-trip), why
everything is enumerated or a validated hex (an imported bundle is served from
the author's own origin), why marker colours travel as a parameter and not a
store (the editor shares the `PanoramaViewer`), and the cost: the primary
button changed colour, and `extra="forbid"` means this cost a version bump.
Note that ADR 0005's `Tour.attribution` question is **still open** and why this
work did not close it.

- [ ] **Step 2: Add the `UNVERIFIED.md` entries**

One per item in spec §6's "what no test here can prove", in the order given,
with the **published-site font check first** — it is the only one that fails
after an author has already published.

- [ ] **Step 3: Update the three reference documents**

`CHANGING-THINGS.md`: a new entry, "Change what an author can theme", naming
`core/theme.ts` as the one place the token set is defined and the two drift
tests that fail if a copy is left behind; and amend entry 3's step list with
the v3 fixture. `ARCHITECTURE.md`: the token flow in "Four flows", the
viewer-host rule under "What each layer may not do", and `theme.ts` in the
`core/` row. `HANDOFF.md`: current state, the measured figures from `make
check`, and the primary-button change called out as a deliberate visible
change.

- [ ] **Step 4: Verify every figure you wrote down**

Run: `make check`
Copy the printed test counts and bundle sizes into `HANDOFF.md`. Do not write a
number you did not read from that run.

- [ ] **Step 5: Commit**

```bash
git add docs
git commit -m "Record why the look lives in the document"
```
