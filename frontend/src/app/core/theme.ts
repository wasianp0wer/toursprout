// The pure layer between a tour's stored theme and the colours the app paints
// with. No DOM, no Angular: a viewer with no browser to hand and no Python in
// the path must still be able to prove, under Vitest, what a theme resolves to.

// Each of these four arrays MUST stay on one line with single-quoted strings.
// backend/tests/theme_vocabulary.py finds them by regex over this file's text,
// in the manner of IMAGE_EXTS in editor/document-ops.ts, so that the Python
// Literals in backend/app/models.py and these copies cannot drift. A formatter
// that wraps a line or swaps the quotes makes that test fail loudly.
export const PRESET_NAMES = ['nocturne', 'archival', 'civic', 'fieldNotes'] as const;
export const TYPE_PAIRINGS = ['georgia', 'garamond', 'franklin', 'plex', 'franklinGaramond'] as const;
export const TYPE_SCALES = ['compact', 'comfortable', 'generous'] as const;
export const LAYOUT_NAMES = ['widePanel', 'panelLeft', 'immersive'] as const;

export type PresetName = (typeof PRESET_NAMES)[number];
export type TypePairing = (typeof TYPE_PAIRINGS)[number];
export type TypeScale = (typeof TYPE_SCALES)[number];
export type LayoutName = (typeof LAYOUT_NAMES)[number];

/**
 * The thirteen tokens an author may set. Nullable because the backend sends
 * `null` for each one left alone; absent and null both mean "not set". The
 * spelling is the camelCase JSON one (`chipSelected`, not `chip_selected`).
 * The field list is checked against pydantic's ThemeOverrides by a backend
 * test, so a fourteenth cannot be added on one side only.
 */
export interface ThemeOverrides {
  paper?: string | null;
  panel?: string | null;
  ink?: string | null;
  accent?: string | null;
  wayfinding?: string | null;
  destination?: string | null;
  soft?: string | null;
  muted?: string | null;
  rule?: string | null;
  chip?: string | null;
  chipSelected?: string | null;
  attributionBar?: string | null;
  onAccent?: string | null;
}

export interface Theme {
  preset: PresetName;
  typePairing: TypePairing;
  typeScale: TypeScale;
  layout: LayoutName;
  overrides: ThemeOverrides;
}

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

type ColourToken =
  | 'paper' | 'panel' | 'ink' | 'accent' | 'wayfinding' | 'destination'
  | 'soft' | 'muted' | 'rule' | 'chip' | 'chipSelected' | 'attributionBar'
  | 'onAccent' | 'onWayfinding' | 'mutedWeak' | 'panoCanvas' | 'error' | 'pinRing';

/** The six an author picks a preset for, and `error`, which no derivation gives. */
type CoreTokens = Pick<ResolvedTheme,
  'paper' | 'panel' | 'ink' | 'accent' | 'wayfinding' | 'destination' | 'error'>;

/**
 * A preset may pin any token, internal ones included, and a pin beats a
 * derivation — until the author overrides one of the core six, at which point
 * the pins listed in LEGACY_PINS give way to their derivations.
 */
type Preset = CoreTokens & Partial<Record<ColourToken, string>> & { pairing: TypePairing };

const PRESETS: Record<PresetName, Preset> = {
  // Every value is lifted from the stylesheets and map/panorama code as they
  // stood before theming (spec section 5.2), and pinned rather than derived:
  // three of today's colours are not reachable by any sensible mix, and an
  // existing tour must not change its look. onWayfinding is pinned for the
  // same reason, see resolveTheme.
  nocturne: {
    pairing: 'georgia',
    paper: '#14161a', panel: '#1b1e24', ink: '#ecebe6', accent: '#e8b04b',
    wayfinding: '#2f7fd4', destination: '#5fd08a',
    soft: '#c3c7cf', muted: '#9aa0ab', rule: '#333944',
    chip: '#252a32', chipSelected: '#2d323c', attributionBar: '#0f1114',
    mutedWeak: '#6d7480', panoCanvas: '#111111', error: '#e8825b',
    onWayfinding: '#ffffff',
  },
  // The three below supply their core six and an error colour and let the
  // derivations do the rest. The error colours and the wayfinding/destination
  // pairs are the implementer's choice, not the author's (spec section 5.2).
  archival: {
    pairing: 'garamond',
    paper: '#f4ecdd', panel: '#fbf6ea', ink: '#2e2418', accent: '#9c5a24',
    wayfinding: '#4a6274', destination: '#4f6b2a', error: '#9e2f1b',
  },
  civic: {
    pairing: 'franklin',
    paper: '#eef1f4', panel: '#ffffff', ink: '#1b2430', accent: '#1f5c8f',
    wayfinding: '#6b7684', destination: '#1d6b66', error: '#b3261e',
  },
  fieldNotes: {
    pairing: 'plex',
    paper: '#f7f5ef', panel: '#fffefb', ink: '#23241f', accent: '#a3341f',
    wayfinding: '#4b5a63', destination: '#4f6b2a', error: '#8a2a12',
  },
};

/** The six the author picks a preset for; every derivation reads one of them. */
const CORE_TOKENS = ['paper', 'panel', 'ink', 'accent', 'wayfinding', 'destination'] as const;

/**
 * The pins that exist only to reproduce the appearance this application shipped
 * before theming, and that yield once a core token carries an override.
 *
 * A pin beats a derivation so that Nocturne can be today's look exactly rather
 * than approximately. But a pin exists to reproduce today's appearance, and
 * once the author has moved the palette out from under it, reproducing the old
 * value is no longer a feature but a bug: on Nocturne, setting `paper`, `panel`
 * and `ink` to light values left `soft` pinned to #c3c7cf, which is a stop
 * summary at 1.69:1, and `chip` pinned to #252a32 under an inherited dark
 * `color`, which is an overlay list at 1.09:1 — invisible, and neither of them
 * in the pane's readout. So the derivations take over, which is what spec 5.2
 * promises an author who "wants one strange panel colour": coherent chips and
 * rules for free.
 *
 * Any one of the six releases all nine, deliberately: an author who has
 * repainted a core colour has made this preset their own, and tracking which
 * derivation reads which core would be a rule nobody could predict. An
 * override on a listed token still wins, so nothing the author set is lost.
 *
 * `onWayfinding` is on the list although it is internal and not authorable.
 * Nocturne pins it to #ffffff purely for legacy exactness (spec 5.2 says the
 * other three derive it "because they have no legacy appearance to preserve"),
 * and it is derived from `wayfinding`, so an author who sets a pale wayfinding
 * colour would otherwise get a white numeral on it. `error` and `pinRing` are
 * not on the list and cannot be: neither is derived from the core, so there is
 * nothing for either to fall back to.
 *
 * Every tour already in the wild carries no overrides at all, so no core token
 * is overridden, every pin still applies, and none of them changes.
 */
const LEGACY_PINS = ['soft', 'muted', 'rule', 'chip', 'chipSelected',
  'attributionBar', 'mutedWeak', 'panoCanvas', 'onWayfinding'] as const;

/**
 * The override values that survive validation, keyed by token. Shared by
 * `resolveTheme` and `pinnedTokens` so that "the author overrode a core
 * colour" means exactly one thing in both: a value that actually reaches CSS.
 */
function appliedOverrides(
  overrides: ThemeOverrides | null | undefined,
): Partial<Record<ColourToken, string>> {
  // Lowercase what is set. The pydantic model lowercases on validation, but
  // nothing rewrites the stored file, so a hand-authored tour.json may hold
  // `#9C5A24` and the viewer reads it directly. Anything that is not six hex
  // digits is ignored rather than trusted: the colour reaches CSS.
  const set: Partial<Record<ColourToken, string>> = {};
  const from: ThemeOverrides = overrides ?? {};
  for (const key of OVERRIDABLE) {
    const value = from[key];
    if (typeof value === 'string' && HEX.test(value.toLowerCase())) {
      set[key] = value.toLowerCase();
    }
  }
  return set;
}

/** Whether the author has moved any of the core six, which releases the pins. */
function coreMoved(set: Partial<Record<ColourToken, string>>): boolean {
  return CORE_TOKENS.some((token) => set[token] !== undefined);
}

/**
 * The type pairing a preset starts with. The approved mockup paired each theme
 * with a face and moved the pairing with the theme; without this, Field notes
 * would be oxide-red colours in Georgia. Spec section 5.2.
 */
export function presetPairing(preset: PresetName): TypePairing {
  return PRESETS[oneOf(PRESET_NAMES, preset, DEFAULT_PRESET)].pairing;
}

/**
 * The authorable tokens this preset pins to a value, as opposed to deriving
 * them. The pane uses it to say which rows are "preset" and which "derived".
 * Internal tokens (error, pinRing, mutedWeak, panoCanvas, onWayfinding) are
 * never listed, whether pinned or not.
 *
 * `overrides` is the stored overrides object, because a pin is conditional: it
 * yields once the author has moved the core out from under it (see
 * LEGACY_PINS). Called with one argument it answers for a tour with no
 * overrides. Both this and `presetPairing` guard the preset name the way
 * `resolveTheme` does: ThemePane passes `theme?.preset` straight from the
 * document, so a hand-edited tour.json must not throw here either.
 */
export function pinnedTokens(
  preset: PresetName, overrides?: ThemeOverrides | null,
): (keyof ThemeOverrides)[] {
  const table = PRESETS[oneOf(PRESET_NAMES, preset, DEFAULT_PRESET)];
  const yielded: readonly string[] =
    coreMoved(appliedOverrides(overrides)) ? LEGACY_PINS : [];
  return OVERRIDABLE.filter(
    (token) => table[token] !== undefined && !yielded.includes(token));
}

const TYPE_SCALE_FACTORS: Record<TypeScale, number> = {
  compact: 0.88, comfortable: 1, generous: 1.14,
};

const DEFAULT_PRESET: PresetName = 'nocturne';
const DEFAULT_PAIRING: TypePairing = 'georgia';
const DEFAULT_SCALE: TypeScale = 'comfortable';
const DEFAULT_LAYOUT: LayoutName = 'widePanel';

/**
 * The tokens an author may override (`error` and `pinRing` deliberately are
 * not). Written as a Record over every key of ThemeOverrides so that adding a
 * fourteenth field to the interface and forgetting it here is a compile error,
 * not an author's override silently dropped.
 */
const OVERRIDABLE_TOKENS: Record<keyof ThemeOverrides, true> = {
  paper: true, panel: true, ink: true, accent: true, wayfinding: true,
  destination: true, soft: true, muted: true, rule: true, chip: true,
  chipSelected: true, attributionBar: true, onAccent: true,
};
export const OVERRIDABLE = Object.keys(OVERRIDABLE_TOKENS) as (keyof ThemeOverrides)[];

const HEX = /^#[0-9a-f]{6}$/;

function channels(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/**
 * Linear interpolation in sRGB, `t` of the way from `a` to `b`. Deliberately
 * naive: no perceptual space and no gamma correction, because the author's own
 * override is always available and a cleverer mix is a worse thing to have to
 * explain. Spec section 5.2.
 */
export function mix(a: string, b: string, t: number): string {
  const ca = channels(a);
  const cb = channels(b);
  return '#' + ca
    .map((c, i) => Math.round(c + (cb[i] - c) * t).toString(16).padStart(2, '0'))
    .join('');
}

function luminance(hex: string): number {
  const [r, g, b] = channels(hex).map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2 contrast ratio, 1 (identical) to 21 (black on white). */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Whichever of near-black and white reads better on `background`. A tie goes to
 * near-black so the answer is stable rather than dependent on float noise.
 */
export function readableOn(background: string): string {
  return contrastRatio('#ffffff', background) > contrastRatio('#121212', background)
    ? '#ffffff' : '#121212';
}

function oneOf<T extends string>(names: readonly T[], value: unknown, fallback: T): T {
  return names.includes(value as T) ? (value as T) : fallback;
}

/**
 * Turn a stored theme into every concrete token. Never throws: a published
 * site has no migration and no Python in the path, so a hand-edited or
 * hand-unzipped document can carry an unknown preset, pairing, scale or layout
 * (or no overrides object at all), and a thrown exception here would be a
 * blank page for a member of the public. Each enumerated field is checked
 * against the name arrays and replaced by its default when unrecognised.
 */
export function resolveTheme(theme: Theme | null | undefined): ResolvedTheme {
  const preset = PRESETS[oneOf(PRESET_NAMES, theme?.preset, DEFAULT_PRESET)];
  const typeScale = oneOf(TYPE_SCALES, theme?.typeScale, DEFAULT_SCALE);

  const set = appliedOverrides(theme?.overrides);

  // Precedence for every token: author's override, then the preset's pin, then
  // the derivation. Derivations read the resolved core, so overriding `panel`
  // moves chip, rule and chipSelected with it.
  //
  // With one condition on the middle step: once any core token carries an
  // override, the legacy-exactness pins give way to their derivations, so the
  // palette the author started is the one the rest of the theme is built from.
  // See LEGACY_PINS for why, and for why `error` and `pinRing` cannot join.
  const released = coreMoved(set);
  const pinned = (token: ColourToken): string | undefined =>
    released && (LEGACY_PINS as readonly string[]).includes(token)
      ? undefined : preset[token];
  const pick = (token: ColourToken, derive: () => string): string =>
    set[token] ?? pinned(token) ?? derive();

  const paper = pick('paper', () => '');
  const panel = pick('panel', () => '');
  const ink = pick('ink', () => '');
  const accent = pick('accent', () => '');
  const wayfinding = pick('wayfinding', () => '');
  const destination = pick('destination', () => '');
  // 0.28, not the mockup's 0.45. The ratio is only ever exercised on the three
  // light presets, because Nocturne pins `muted`, and at 0.45 it resolved to
  // the wrong side of AA on all three: the credits and "STOP 1 OF 6" read
  // 3.48/3.62/3.62 against `panel` and the footer's credit links 2.76/2.75/2.87
  // against `attributionBar`, for text the stylesheets size at 10 to 11.5 px.
  // 0.28 gives 5.83/6.24/6.17 and 4.62/4.75/4.89, while leaving `muted` far
  // from `ink` (14.09/15.65/15.50 against `panel`), so it still reads as a
  // muted tone rather than as body text. theme.spec.ts holds the floors.
  const muted = pick('muted', () => mix(ink, panel, 0.28));

  return {
    paper, panel, ink, accent, wayfinding, destination, muted,
    soft: pick('soft', () => mix(ink, panel, 0.22)),
    rule: pick('rule', () => mix(panel, ink, 0.18)),
    chip: pick('chip', () => mix(panel, ink, 0.07)),
    chipSelected: pick('chipSelected', () => mix(panel, accent, 0.14)),
    attributionBar: pick('attributionBar', () => mix(paper, ink, 0.08)),
    onAccent: pick('onAccent', () => readableOn(accent)),
    // Nocturne pins this to #ffffff, which is what map-pane.ts writes today;
    // the contrast rule alone would give #121212 (4.56 against 4.11). That pin
    // is on LEGACY_PINS, so an author who repaints the core gets the rule's
    // answer against their own wayfinding colour rather than a white numeral.
    onWayfinding: pick('onWayfinding', () => readableOn(wayfinding)),
    // 0.25, not 0.45, for the same reason: at 0.45 the disabled Prev/Next
    // label was 1.30:1 against `rule` on the light presets, which is not a
    // dimmed label but an invisible one. 0.25 gives 2.38/2.47/2.46, which is
    // Nocturne's own pinned pair at 2.46 almost exactly, so the disabled
    // control keeps the relationship this application already ships. AA does
    // not govern a disabled control, which is why the floor is lower here.
    mutedWeak: pick('mutedWeak', () => mix(muted, panel, 0.25)),
    panoCanvas: pick('panoCanvas', () => mix(paper, ink, 0.12)),
    // Never derived and never overridable: the colour of a fatal message must
    // not be something an author can make unreadable.
    error: preset.error,
    // A fixed ring that separates a pin from any map tile.
    pinRing: '#ffffff',
    typePairing: oneOf(TYPE_PAIRINGS, theme?.typePairing, DEFAULT_PAIRING),
    typeScale,
    layout: oneOf(LAYOUT_NAMES, theme?.layout, DEFAULT_LAYOUT),
    scaleFactor: TYPE_SCALE_FACTORS[typeScale],
  };
}

// A Record over ColourToken for the same reason as OVERRIDABLE_TOKENS: a new
// token missing here is a compile error rather than a missing CSS variable.
const CSS_TOKEN_SET: Record<ColourToken, true> = {
  paper: true, panel: true, ink: true, accent: true, wayfinding: true,
  destination: true, soft: true, muted: true, rule: true, chip: true,
  chipSelected: true, attributionBar: true, onAccent: true, onWayfinding: true,
  mutedWeak: true, panoCanvas: true, error: true, pinRing: true,
};
const CSS_TOKENS = Object.keys(CSS_TOKEN_SET) as ColourToken[];

/** One custom property per colour token: `chipSelected` becomes `--chip-selected`. */
export function cssVariablesFor(r: ResolvedTheme): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const token of CSS_TOKENS) {
    vars['--' + token.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())] = r[token];
  }
  return vars;
}

/** The three colours the map and panorama code paint markers with. */
export function markerColoursFor(r: ResolvedTheme): MarkerColours {
  return { accent: r.accent, wayfinding: r.wayfinding, destination: r.destination };
}
