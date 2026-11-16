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

/** A preset may pin any token, internal ones included; a pin beats a derivation. */
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

/**
 * The type pairing a preset starts with. The approved mockup paired each theme
 * with a face and moved the pairing with the theme; without this, Field notes
 * would be oxide-red colours in Georgia. Spec section 5.2.
 */
export function presetPairing(preset: PresetName): TypePairing {
  return PRESETS[preset].pairing;
}

/**
 * The authorable tokens this preset pins to a value, as opposed to deriving
 * them. The pane uses it to say which rows are "preset" and which "derived".
 * Internal tokens (error, pinRing, mutedWeak, panoCanvas, onWayfinding) are
 * never listed, whether pinned or not.
 */
export function pinnedTokens(preset: PresetName): (keyof ThemeOverrides)[] {
  return OVERRIDABLE.filter((token) => PRESETS[preset][token] !== undefined);
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

  // Lowercase what is set. The pydantic model lowercases on validation, but
  // nothing rewrites the stored file, so a hand-authored tour.json may hold
  // `#9C5A24` and the viewer reads it directly. Anything that is not six hex
  // digits is ignored rather than trusted: the colour reaches CSS.
  const set: Partial<Record<ColourToken, string>> = {};
  const overrides: ThemeOverrides = theme?.overrides ?? {};
  for (const key of OVERRIDABLE) {
    const value = overrides[key];
    if (typeof value === 'string' && HEX.test(value.toLowerCase())) {
      set[key] = value.toLowerCase();
    }
  }

  // Precedence for every token: author's override, then the preset's pin, then
  // the derivation. Derivations read the resolved core, so overriding `panel`
  // moves chip, rule and chipSelected with it.
  const pick = (token: ColourToken, derive: () => string): string =>
    set[token] ?? preset[token] ?? derive();

  const paper = pick('paper', () => '');
  const panel = pick('panel', () => '');
  const ink = pick('ink', () => '');
  const accent = pick('accent', () => '');
  const wayfinding = pick('wayfinding', () => '');
  const destination = pick('destination', () => '');
  const muted = pick('muted', () => mix(ink, panel, 0.45));

  return {
    paper, panel, ink, accent, wayfinding, destination, muted,
    soft: pick('soft', () => mix(ink, panel, 0.22)),
    rule: pick('rule', () => mix(panel, ink, 0.18)),
    chip: pick('chip', () => mix(panel, ink, 0.07)),
    chipSelected: pick('chipSelected', () => mix(panel, accent, 0.14)),
    attributionBar: pick('attributionBar', () => mix(paper, ink, 0.08)),
    onAccent: pick('onAccent', () => readableOn(accent)),
    // Nocturne pins this to #ffffff, which is what map-pane.ts writes today;
    // the contrast rule alone would give #121212 (4.56 against 4.11).
    onWayfinding: pick('onWayfinding', () => readableOn(wayfinding)),
    mutedWeak: pick('mutedWeak', () => mix(muted, panel, 0.45)),
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
