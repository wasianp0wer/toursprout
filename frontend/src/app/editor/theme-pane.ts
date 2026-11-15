import { Component, computed, inject } from '@angular/core';
import { EditorStore } from './editor-store';
import { ThemePreview } from './theme-preview';
import {
  clearThemeOverride, clearThemeOverrides, setThemeOverride, setThemePreset,
  setTourLayout, setTypePairing, setTypeScale,
} from './document-ops';
import {
  LAYOUT_NAMES, PRESET_NAMES, TYPE_PAIRINGS, TYPE_SCALES, contrastRatio, resolveTheme,
  type LayoutName, type PresetName, type ResolvedTheme, type Theme, type ThemeOverrides,
  type TypePairing, type TypeScale,
} from '../core/theme';

type Token = keyof ThemeOverrides;
type RowState = 'set' | 'preset' | 'derived';

interface Row { token: Token; label: string; }

/** The six an author reaches for first. The names are the author's, not the tokens'. */
const TOP_ROWS: Row[] = [
  { token: 'paper', label: 'Page' },
  { token: 'panel', label: 'Panel' },
  { token: 'ink', label: 'Text' },
  { token: 'accent', label: 'Accent' },
  { token: 'wayfinding', label: 'Another stop' },
  { token: 'destination', label: 'The way onward' },
];
// `error` and `pinRing` are not here and not in ThemeOverrides: an author must
// not be able to make a fatal message or a map pin unreadable.
const MORE_ROWS: Row[] = [
  { token: 'soft', label: 'Soft text' },
  { token: 'muted', label: 'Muted text' },
  { token: 'rule', label: 'Lines' },
  { token: 'chip', label: 'Chip' },
  { token: 'chipSelected', label: 'Selected chip' },
  { token: 'attributionBar', label: 'Attribution bar' },
  { token: 'onAccent', label: 'Button label' },
];
const CORE: ReadonlySet<Token> = new Set(TOP_ROWS.map((r) => r.token));

const PRESET_LABELS: Record<PresetName, string> = {
  nocturne: 'Nocturne', archival: 'Archival', civic: 'Civic', fieldNotes: 'Field notes',
};
const PAIRING_LABELS: Record<TypePairing, string> = {
  georgia: 'Georgia', garamond: 'Garamond', franklin: 'Franklin', plex: 'Plex',
  franklinGaramond: 'Franklin and Garamond',
};
const SCALE_LABELS: Record<TypeScale, string> = {
  compact: 'Compact', comfortable: 'Comfortable', generous: 'Generous',
};
const LAYOUT_LABELS: Record<LayoutName, string> = {
  widePanel: 'Wide panel', panelLeft: 'Panel left', immersive: 'Immersive',
};

/** WCAG AA for body text. Applied to all three pairs, which is stricter than AA asks of a UI colour. */
const AA = 4.5;

/**
 * Two palettes on which every core colour is the same, one dark and one light.
 * A derived token is one whose value moves when the core moves; a pinned one
 * does not. Two probes rather than one because a derivation such as
 * `readableOn` can land on the same answer for the preset's own accent and a
 * single probe colour.
 */
const PROBES: ThemeOverrides[] = ['#000000', '#ffffff'].map((c) => ({
  paper: c, panel: c, ink: c, accent: c, wayfinding: c, destination: c,
}));

function stateOf(token: Token, theme: Theme | null | undefined): RowState {
  if (typeof theme?.overrides?.[token] === 'string') return 'set';
  if (CORE.has(token)) return 'preset';
  const own = resolveTheme({ ...baseOf(theme), overrides: {} });
  const moves = PROBES.some((p) =>
    resolveTheme({ ...baseOf(theme), overrides: p })[token] !== own[token]);
  return moves ? 'derived' : 'preset';
}

function baseOf(theme: Theme | null | undefined): Theme {
  return {
    preset: theme?.preset ?? 'nocturne', typePairing: theme?.typePairing ?? 'georgia',
    typeScale: theme?.typeScale ?? 'comfortable', layout: theme?.layout ?? 'widePanel',
    overrides: {},
  };
}

/** What each of the four presets gives this token: the swatches an author can pick from. */
function swatchesFor(token: Token): string[] {
  const seen = new Set<string>();
  for (const preset of PRESET_NAMES) {
    seen.add(resolveTheme({ ...baseOf(null), preset })[token as keyof ResolvedTheme] as string);
  }
  return [...seen];
}

const SWATCHES = new Map<Token, string[]>(
  [...TOP_ROWS, ...MORE_ROWS].map((r) => [r.token, swatchesFor(r.token)]));

interface Reading { key: 'body' | 'accent' | 'button'; text: string; fails: boolean; }

function reading(key: Reading['key'], label: string, a: string, b: string): Reading {
  const ratio = contrastRatio(a, b);
  // Truncated, not rounded: 4.48 must not read "4.5:1 — below the AA standard".
  const shown = (Math.floor(ratio * 10) / 10).toFixed(1);
  const fails = ratio < AA;
  return {
    key, fails,
    text: fails
      ? `${label} ${shown}:1 — below the AA standard. You can publish it anyway.`
      : `${label} ${shown}:1`,
  };
}

/**
 * The author's only way to theme a tour. Every change is a pure op from
 * document-ops, applied through the store, so autosave and undo carry it like
 * any other edit. Nothing here transforms the document itself.
 *
 * The contrast readout warns and never refuses: no control is ever disabled on
 * its account. That was the author's decision.
 */
@Component({
  selector: 'app-theme-pane',
  imports: [ThemePreview],
  templateUrl: './theme-pane.html',
  styleUrl: './theme-pane.css',
})
export class ThemePane {
  private readonly store = inject(EditorStore);

  protected readonly theme = computed(() => this.store.draft()?.theme ?? null);
  protected readonly resolved = computed(() => resolveTheme(this.theme()));
  protected readonly preset = computed(() => this.theme()?.preset ?? 'nocturne');
  protected readonly topRows = TOP_ROWS;
  protected readonly moreRows = MORE_ROWS;

  protected readonly presets = PRESET_NAMES.map((v) => ({ value: v, label: PRESET_LABELS[v] }));
  protected readonly pairings = TYPE_PAIRINGS.map((v) => ({ value: v, label: PAIRING_LABELS[v] }));
  protected readonly scales = TYPE_SCALES.map((v) => ({ value: v, label: SCALE_LABELS[v] }));
  protected readonly layouts = LAYOUT_NAMES.map((v) => ({ value: v, label: LAYOUT_LABELS[v] }));

  protected readonly states = computed(() => {
    const theme = this.theme();
    return new Map<Token, RowState>(
      [...TOP_ROWS, ...MORE_ROWS].map((r) => [r.token, stateOf(r.token, theme)]));
  });

  protected readonly readings = computed<Reading[]>(() => {
    const r = this.resolved();
    return [
      reading('body', 'Body text', r.ink, r.panel),
      reading('accent', 'Accent colour', r.accent, r.panel),
      reading('button', 'Button label', r.onAccent, r.accent),
    ];
  });

  protected colour(token: Token): string {
    return this.resolved()[token as keyof ResolvedTheme] as string;
  }
  protected swatches(token: Token): string[] { return SWATCHES.get(token) ?? []; }

  protected setPreset(value: string): void {
    this.store.apply((t) => setThemePreset(t, value as PresetName));
  }
  protected setPairing(value: string): void {
    this.store.apply((t) => setTypePairing(t, value as TypePairing));
  }
  protected setScale(value: string): void {
    this.store.apply((t) => setTypeScale(t, value as TypeScale));
  }
  protected setLayout(value: LayoutName): void {
    this.store.apply((t) => setTourLayout(t, value));
  }
  protected setColour(token: Token, hex: string): void {
    this.store.apply((t) => setThemeOverride(t, token, hex));
  }
  protected resetColour(token: Token): void {
    this.store.apply((t) => clearThemeOverride(t, token));
  }
  protected resetAll(): void {
    this.store.apply((t) => clearThemeOverrides(t));
  }
}
