import {
  Component, ElementRef, computed, inject, output, viewChild,
  type AfterViewInit,
} from '@angular/core';
import { EditorStore } from './editor-store';
import { ThemePreview } from './theme-preview';
import {
  clearThemeOverride, clearThemeOverrides, setThemeOverride, setThemePreset,
  setTourLayout, setTypePairing, setTypeScale,
} from './document-ops';
import {
  LAYOUT_NAMES, PRESET_NAMES, TYPE_PAIRINGS, TYPE_SCALES, contrastRatio, pinnedTokens, resolveTheme,
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

/**
 * WCAG AA for body text, applied to all five pairs. That is deliberately
 * stricter than AA asks of large text or a UI colour: Archival's accent on its
 * panel is 4.9, so a small darkening turns it amber. The warning is only a
 * warning; nothing is refused.
 */
const AA = 4.5;

function stateOf(token: Token, theme: Theme | null | undefined): RowState {
  if (typeof theme?.overrides?.[token] === 'string') return 'set';
  // The overrides go in because a pin is conditional: once the author has
  // overridden a core colour, the preset's legacy pins yield to their
  // derivations, and a row this pane still called "preset" would be naming a
  // value the viewer is no longer painting.
  return pinnedTokens(theme?.preset ?? 'nocturne', theme?.overrides).includes(token)
    ? 'preset' : 'derived';
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

interface Reading {
  key: 'body' | 'summary' | 'overlay' | 'accent' | 'button';
  text: string;
  fails: boolean;
}

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
  selector: 'app-theme-dialog',
  imports: [ThemePreview],
  templateUrl: './theme-dialog.html',
  styleUrl: './theme-dialog.css',
  // Escape is what everyone reaches for to back out of a dialog, and this one
  // is reachable only from a header button, so there is no other obvious way
  // out for the keyboard. Bound on the document because focus can be on the
  // panel itself or on any control inside it, and both must answer the key.
  // Same contract as CloseDialog: this only ASKS to be closed. The parent
  // owns whether the dialog is on screen, so nothing here can take an
  // author's surface away mid-edit. (No focus trap, for the same reason
  // CloseDialog has none: backing out and being heard are what this covers.)
  host: {
    '(document:keydown.escape)': 'cancelled.emit()',
  },
})
export class ThemeDialog implements AfterViewInit {
  private readonly store = inject(EditorStore);

  /** Asks the parent to take the dialog down. Nothing closes itself. */
  readonly cancelled = output<void>();

  private readonly surface = viewChild.required<ElementRef<HTMLElement>>('surface');

  ngAfterViewInit(): void {
    // The author opened this from a header button, so the keyboard is out in
    // the header; without this, Tab walks the editor behind the dialog
    // instead of the controls in it, and Escape would not reach the host
    // binding either until something inside took focus.
    this.surface().nativeElement.focus();
  }

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

  /**
   * The five pairs the author is shown. `summary` and `overlay` are here
   * because the review's worked case — a light theme made by setting `paper`,
   * `panel` and `ink` — left the stop summary at 1.69:1 and the overlay list
   * at 1.09:1 while the readout reported a pass on body text and warned only
   * about the accent. Those are the two surfaces most of a stop's words are
   * on, so they are the two the readout was most wrong to leave out.
   *
   * `overlay` is ink on chip and not chip on anything: `.overlay-list button`
   * is `color: inherit`, so what is painted there is the body colour.
   *
   * It is still only a warning. Nothing here disables a control or blocks a
   * save, which was the author's decision.
   */
  protected readonly readings = computed<Reading[]>(() => {
    const r = this.resolved();
    return [
      reading('body', 'Body text', r.ink, r.panel),
      reading('summary', 'Stop summary', r.soft, r.panel),
      reading('overlay', 'Overlay list', r.ink, r.chip),
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
