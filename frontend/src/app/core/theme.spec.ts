import { describe, expect, it } from 'vitest';
import {
  PRESET_NAMES, contrastRatio, cssVariablesFor, markerColoursFor, mix, pinnedTokens,
  presetPairing, readableOn, resolveTheme,
} from './theme';
import type { PresetName, ResolvedTheme, Theme } from './theme';

function themed(over: Partial<Theme> = {}): Theme {
  return {
    preset: 'nocturne', typePairing: 'georgia', typeScale: 'comfortable',
    layout: 'widePanel', overrides: {}, ...over,
  };
}

describe('resolveTheme', () => {
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
    expect(r.onAccent).toBe('#121212');    expect(r.onWayfinding).toBe('#ffffff');
  });
  // The one deliberate departure: the stop-panel primary button was #2f7fd4 and
  // is now the accent. #2f7fd4 survives as `wayfinding`. Spec section 5.2.

  it('treats an absent theme and a null theme alike', () => {
    expect(resolveTheme(undefined)).toEqual(resolveTheme(null));
  });

  it('falls back to Nocturne rather than throwing on an unknown preset', () => {
    const r = resolveTheme({ preset: 'brutalist', typePairing: 'nope',
                             typeScale: 'huge', layout: 'spiral', overrides: {} } as never);
    expect(r.paper).toBe('#14161a');
    expect(r.typePairing).toBe('georgia');
    expect(r.typeScale).toBe('comfortable');
    expect(r.layout).toBe('widePanel');
    expect(r.scaleFactor).toBe(1);
  });

  it('does not throw on a theme with no overrides object at all', () => {
    expect(() => resolveTheme({ preset: 'civic' } as never)).not.toThrow();
  });

  it('applies the type scale factor', () => {
    expect(resolveTheme(themed({ typeScale: 'compact' })).scaleFactor).toBe(0.88);
    expect(resolveTheme(themed({ typeScale: 'generous' })).scaleFactor).toBe(1.14);
  });

  it('lets an override beat a derivation and a preset pin beat a derivation', () => {
    // Nocturne pins rule; an override still beats the pin.
    expect(resolveTheme(themed({ overrides: { rule: '#123456' } })).rule).toBe('#123456');
    // Archival derives rule; an override beats the derivation.
    const base = resolveTheme(themed({ preset: 'archival' }));
    const set = resolveTheme(themed({ preset: 'archival', overrides: { rule: '#123456' } }));
    expect(base.rule).not.toBe('#123456');
    expect(set.rule).toBe('#123456');
    // A pin beats a derivation: Nocturne's rule is not mix(panel, ink, 0.18).
    expect(resolveTheme(null).rule).not.toBe(mix('#1b1e24', '#ecebe6', 0.18));
  });

  it('moves chip, rule and chipSelected when panel is overridden', () => {
    const before = resolveTheme(themed({ preset: 'civic' }));
    const after = resolveTheme(themed({ preset: 'civic', overrides: { panel: '#ffeecc' } }));
    expect(after.panel).toBe('#ffeecc');
    expect(after.chip).not.toBe(before.chip);
    expect(after.rule).not.toBe(before.rule);
    expect(after.chipSelected).not.toBe(before.chipSelected);
  });

  it('derives the other presets from their core six', () => {
    const r = resolveTheme(themed({ preset: 'archival' }));
    expect(r.paper).toBe('#f4ecdd');
    expect(r.error).toBe('#9e2f1b');
    expect(r.rule).toBe(mix(r.panel, r.ink, 0.18));
    expect(r.soft).toBe(mix(r.ink, r.panel, 0.22));
    expect(r.muted).toBe(mix(r.ink, r.panel, 0.28));
    expect(r.mutedWeak).toBe(mix(r.muted, r.panel, 0.25));
    expect(r.onAccent).toBe(readableOn(r.accent));
    expect(r.chip).toBe(mix(r.panel, r.ink, 0.07));
    expect(r.chipSelected).toBe(mix(r.panel, r.accent, 0.14));
    expect(r.attributionBar).toBe(mix(r.paper, r.ink, 0.08));
    expect(r.panoCanvas).toBe(mix(r.paper, r.ink, 0.12));
    expect(r.onWayfinding).toBe(readableOn(r.wayfinding));
  });

  it('derives the same way for every preset that does not pin', () => {
    for (const preset of ['civic', 'fieldNotes'] as const) {
      const r = resolveTheme(themed({ preset }));
      expect(r.chip).toBe(mix(r.panel, r.ink, 0.07));
      expect(r.rule).toBe(mix(r.panel, r.ink, 0.18));
      expect(r.onWayfinding).toBe(readableOn(r.wayfinding));
    }
  });

  it('never lets an override change error or pinRing', () => {
    const r = resolveTheme(themed({
      overrides: { error: '#000000', pinRing: '#000000' } as never }));
    expect(r.error).toBe('#e8825b');
    expect(r.pinRing).toBe('#ffffff');
  });

  it('lowercases override values so nothing downstream depends on case', () => {
    const r = resolveTheme(themed({ overrides: { accent: '#9C5A24' } }));
    expect(r.accent).toBe('#9c5a24');
  });

  it('ignores an override that is not six hex digits, keeping the preset value', () => {
    // The injection boundary for a published site: these reach CSS custom
    // properties, so none may survive resolution.
    for (const bad of ['red', '#fff', '#12345g', '#ffffff; x: y', 'url(x)', '#ffffff}', '', '#ffffffff']) {
      const r = resolveTheme(themed({ preset: 'archival', overrides: { accent: bad, panel: bad } }));
      expect(r.accent, bad).toBe('#9c5a24');
      expect(r.panel, bad).toBe('#fbf6ea');
    }
  });

  it('survives overrides that are not an object, or hold non-strings', () => {
    for (const overrides of ['x', 7, [], true]) {
      const r = resolveTheme(themed({ preset: 'civic', overrides: overrides as never }));
      expect(r.accent).toBe('#1f5c8f');
    }
    const r = resolveTheme(themed({ preset: 'civic', overrides: { accent: 5 } as never }));
    expect(r.accent).toBe('#1f5c8f');
  });

  it('honours every one of the thirteen overridable tokens', () => {
    // Guards against a token being added to ThemeOverrides and forgotten in
    // the resolver, which would drop the author's choice silently.
    const keys = ['paper', 'panel', 'ink', 'accent', 'wayfinding', 'destination', 'soft',
      'muted', 'rule', 'chip', 'chipSelected', 'attributionBar', 'onAccent'] as const;
    const overrides = Object.fromEntries(keys.map((k, i) => [k, '#0' + (i + 1).toString(16) + '0a0b']));
    const r = resolveTheme(themed({ overrides }));
    for (const k of keys) expect(r[k], k).toBe(overrides[k]);
  });

  it('ignores a null override, as the backend sends them', () => {
    const r = resolveTheme(themed({ overrides: { accent: null } as never }));
    expect(r.accent).toBe('#e8b04b');
  });
});

describe('colour helpers', () => {
  it('picks a readable label on an accent, deterministically at the boundary', () => {
    expect(readableOn('#ffffff')).toBe('#121212');
    expect(readableOn('#000000')).toBe('#ffffff');
    // Mid-greys score near-equally against both candidates, so pin readableOn
    // to contrastRatio rather than to hand-computed hexes. The rule is strict:
    // white must beat #121212 to win, so a tie goes to #121212. No 8-bit grey
    // ties exactly (#797979 is the closest), so the direction is mirrored here
    // with `>`, not `>=`, to match the documented rule rather than its opposite.
    for (const c of ['#767676', '#777777', '#787878', '#797979', '#7a7a7a', '#7b7b7b']) {
      const expected = contrastRatio('#ffffff', c) > contrastRatio('#121212', c)
        ? '#ffffff' : '#121212';
      expect(readableOn(c), c).toBe(expected);
    }
  });

  it('mixes two colours in sRGB', () => {
    expect(mix('#000000', '#ffffff', 0.5)).toBe('#808080');
    expect(mix('#102030', '#ffffff', 0)).toBe('#102030');
  });

  it('computes WCAG contrast', () => {
    expect(contrastRatio('#ffffff', '#000000')).toBeCloseTo(21, 1);
    expect(contrastRatio('#777777', '#777777')).toBeCloseTo(1, 5);
  });
});

describe('outputs', () => {
  it('names a CSS variable per colour token', () => {
    const vars = cssVariablesFor(resolveTheme(null));
    expect(vars['--paper']).toBe('#14161a');
    expect(vars['--chip-selected']).toBe('#2d323c');
    expect(vars['--on-accent']).toBe('#121212');
    expect(Object.keys(vars).length).toBe(18);
  });

  it('hands the map its three marker colours', () => {
    expect(markerColoursFor(resolveTheme(null))).toEqual(
      { accent: '#e8b04b', wayfinding: '#2f7fd4', destination: '#5fd08a' });
  });
});

describe('what a preset pins and pairs', () => {
  it('pairs each preset with the face the approved mockup gave it', () => {
    expect(presetPairing('nocturne')).toBe('georgia');
    expect(presetPairing('archival')).toBe('garamond');
    expect(presetPairing('civic')).toBe('franklin');
    expect(presetPairing('fieldNotes')).toBe('plex');
  });

  it('lists the authorable tokens a preset pins, and none it derives', () => {
    // Nocturne pins what it held as literals before theming; the other three
    // pin only their core six.
    expect(pinnedTokens('nocturne').sort()).toEqual(
      ['accent', 'attributionBar', 'chip', 'chipSelected', 'destination', 'ink', 'muted',
        'panel', 'paper', 'rule', 'soft', 'wayfinding'].sort());
    for (const p of ['archival', 'civic', 'fieldNotes'] as const) {
      expect(pinnedTokens(p).sort()).toEqual(
        ['accent', 'destination', 'ink', 'panel', 'paper', 'wayfinding']);
    }
  });

  it('never lists the internal tokens', () => {
    for (const p of ['nocturne', 'archival', 'civic', 'fieldNotes'] as const) {
      expect(pinnedTokens(p)).not.toContain('error');
      expect(pinnedTokens(p)).not.toContain('pinRing');
      expect(pinnedTokens(p)).not.toContain('mutedWeak');
      expect(pinnedTokens(p)).not.toContain('panoCanvas');
      expect(pinnedTokens(p)).not.toContain('onWayfinding');
    }
  });
});

type ColourKey = Exclude<keyof ResolvedTheme,
  'typePairing' | 'typeScale' | 'layout' | 'scaleFactor'>;

interface Painted { fg: ColourKey; bg: ColourKey; where: string }

/**
 * Every foreground/background pair the viewer actually paints, hand-listed
 * rather than derived from the stylesheets, because which foreground lands on
 * which background is a fact about the cascade and not about the text of a
 * rule: `.overlay-list button` is `color: inherit`, so the pair is ink on chip
 * although neither token is named there, and `.kind` inside that button is
 * muted on chip for the same reason. A regex over the files cannot see either.
 *
 * `where` is the rule that paints the pair, so a pair can be retired here when
 * the rule that justified it goes. The list covers the four presets as they
 * resolve with no overrides; the pane's readout is what covers an author's own
 * palette, and no test can cover every palette an author may choose.
 */
const PAINTED_PAIRS: Painted[] = [
  // viewer-page.css: the host paints --ink on --paper, and `.loading` sits
  // directly on it, outside any panel.
  { fg: 'ink', bg: 'paper', where: 'viewer-page.css :host, .loading' },
  // viewer-page.css `.fatal` — the only place --error is painted, and it is on
  // the host's --paper, not on a panel.
  { fg: 'error', bg: 'paper', where: 'viewer-page.css .fatal' },
  // viewer-page.css `.attribution a` over `.attribution`'s --attribution-bar,
  // and map-pane.css's Leaflet control, which is the same pair.
  { fg: 'muted', bg: 'attributionBar', where: 'viewer-page.css .attribution a, map-pane.css' },
  // viewer-page.css `.tour-title`, the only --accent text in the footer.
  { fg: 'accent', bg: 'attributionBar', where: 'viewer-page.css .tour-title' },
  // stop-panel.css :host is --panel and everything in it inherits --ink.
  { fg: 'ink', bg: 'panel', where: 'stop-panel.css :host, h2, overlay prose' },
  // stop-panel.css `.summary` and `.in-world-slider label`.
  { fg: 'soft', bg: 'panel', where: 'stop-panel.css .summary, .in-world-slider label' },
  // stop-panel.css `.position`, `.credit`, `.in-world-heading`, `.slider-row`.
  { fg: 'muted', bg: 'panel', where: 'stop-panel.css .position, .credit, .slider-row' },
  // stop-panel.css `.overlay-list button` is `color: inherit` over --chip.
  { fg: 'ink', bg: 'chip', where: 'stop-panel.css .overlay-list button' },
  { fg: 'ink', bg: 'chipSelected', where: 'stop-panel.css .overlay-list button.active' },
  // stop-panel.css `.kind`, which sits inside each of those two buttons.
  { fg: 'muted', bg: 'chip', where: 'stop-panel.css .kind' },
  { fg: 'muted', bg: 'chipSelected', where: 'stop-panel.css .kind in .active' },
  // stop-panel.css `.controls button`, and map-pane.ts's current pin number.
  { fg: 'onAccent', bg: 'accent', where: 'stop-panel.css .controls button, map-pane.ts' },
  // map-pane.ts's other pins: their number over the pin's own fill.
  { fg: 'onWayfinding', bg: 'wayfinding', where: 'map-pane.ts, another stop pin' },
  // The primary button's fill and the selected chip's border, against the
  // panel they sit on. Not text, so AA would ask 3.0; it is held to 4.5 here
  // because the pane's readout warns at 4.5 for the same pair and the two
  // should not disagree.
  { fg: 'accent', bg: 'panel', where: 'stop-panel.css .controls button, .active border' },
  // panorama-pane.css `.pano-error` over `.panorama`'s --pano-canvas, which is
  // what is behind it when there is no image to show.
  { fg: 'accent', bg: 'panoCanvas', where: 'panorama-pane.css .pano-error' },
  // stop-panel.css `.controls button:disabled` — --muted-weak on --rule.
  { fg: 'mutedWeak', bg: 'rule', where: 'stop-panel.css .controls button:disabled' },
];

/** AA for body text. The derivations are tuned to clear it, not to graze it. */
const AA_TEXT = 4.5;

/**
 * The pairs that are knowingly below AA, each with the floor it must still
 * hold and the reason it is allowed to be lower. A key is `preset:fg/bg`, or
 * `*:fg/bg` for every preset. These are deliberately tight: a pair that slips
 * further fails, and a pair that rises above AA fails the staleness test
 * below, so the list cannot quietly outlive its reasons.
 */
const BELOW_AA: Record<string, { floor: number; why: string }> = {
  // A disabled control is outside AA's scope. 2.0 is the floor because
  // Nocturne's own pinned pair measures 2.46 and the derivation is set to
  // land beside it: the disabled button keeps the relationship this
  // application already ships rather than acquiring a new one.
  '*:mutedWeak/rule': { floor: 2.0, why: 'a disabled control; AA does not govern it' },
  // Nocturne pins onWayfinding to #ffffff because map-pane.ts writes white for
  // another stop's number today and goal 4 forbids changing an existing tour's
  // appearance. The contrast rule would pick #121212, at 4.56. Measured 4.11.
  // The other three presets derive it and are held to AA.
  'nocturne:onWayfinding/wayfinding': { floor: 4.0, why: "Nocturne's legacy pin, spec 5.2" },
  // Archival's accent came from an approved mockup and is not derived, so
  // neither Important 1's ratios nor any other change here can move these two.
  // Measured 3.95 and 3.66. Recorded in UNVERIFIED.md entry 43.
  'archival:accent/attributionBar': { floor: 3.9, why: "Archival's mockup accent on a light bar" },
  'archival:accent/panoCanvas': { floor: 3.6, why: "Archival's mockup accent on a light canvas" },
};

const floorFor = (preset: PresetName, p: Painted) =>
  BELOW_AA[`${preset}:${p.fg}/${p.bg}`] ?? BELOW_AA[`*:${p.fg}/${p.bg}`]
    ?? { floor: AA_TEXT, why: '' };

describe('contrast, for every pair the viewer paints', () => {
  // The whole point of this suite: the derivation ratios were taken from a
  // mockup and are only ever exercised on the three light presets, because
  // Nocturne pins the tokens they produce. Nothing measured them there.
  for (const preset of PRESET_NAMES) {
    it(`${preset} clears its floor on every painted pair`, () => {
      const r = resolveTheme(themed({ preset }));
      const failures = PAINTED_PAIRS
        .map((p) => ({ p, ...floorFor(preset, p), ratio: contrastRatio(r[p.fg], r[p.bg]) }))
        .filter((f) => f.ratio < f.floor)
        .map((f) => `${f.p.fg}/${f.p.bg} ${f.ratio.toFixed(2)}:1 < ${f.floor}`
          + `${f.why ? ` (${f.why})` : ''} — ${f.p.where}`);
      expect(failures).toEqual([]);
    });
  }

  it('keeps no below-AA exception that the ratios no longer need', () => {
    for (const [key, { floor }] of Object.entries(BELOW_AA)) {
      const [scope, pair] = key.split(':');
      const [fg, bg] = pair.split('/') as [ColourKey, ColourKey];
      expect(PAINTED_PAIRS.some((p) => p.fg === fg && p.bg === bg), key).toBe(true);
      const presets = scope === '*' ? PRESET_NAMES : [scope as PresetName];
      const worst = Math.min(...presets.map((preset) => {
        const r = resolveTheme(themed({ preset }));
        return contrastRatio(r[fg], r[bg]);
      }));
      expect(worst, `${key} now reaches ${worst.toFixed(2)}:1; delete the exception`)
        .toBeLessThan(AA_TEXT);
      expect(floor, key).toBeLessThanOrEqual(worst);
    }
  });
});

describe('a preset pin yields once the author has moved the core', () => {
  // The worked case from the whole-branch review: an author on the default
  // preset turning it into a light theme by setting paper, panel and ink.
  const lightened = themed({
    overrides: { paper: '#f7f5ef', panel: '#ffffff', ink: '#1b2430' } });

  it('derives every legacy-exactness pin from the core the author moved', () => {
    const r = resolveTheme(lightened);
    expect(r.soft).toBe(mix(r.ink, r.panel, 0.22));
    expect(r.muted).toBe(mix(r.ink, r.panel, 0.28));
    expect(r.rule).toBe(mix(r.panel, r.ink, 0.18));
    expect(r.chip).toBe(mix(r.panel, r.ink, 0.07));
    expect(r.chipSelected).toBe(mix(r.panel, r.accent, 0.14));
    expect(r.attributionBar).toBe(mix(r.paper, r.ink, 0.08));
    expect(r.mutedWeak).toBe(mix(r.muted, r.panel, 0.25));
    expect(r.panoCanvas).toBe(mix(r.paper, r.ink, 0.12));
    expect(r.onWayfinding).toBe(readableOn(r.wayfinding));
  });

  it('makes the two pairs that worked case broke readable again', () => {
    // Pinned, these were the stop summary at 1.69:1 and the overlay list at
    // 1.09:1 — invisible, and neither of them in the pane's readout.
    const r = resolveTheme(lightened);
    expect(contrastRatio(r.soft, r.panel)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(r.ink, r.chip)).toBeGreaterThanOrEqual(4.5);
  });

  it('keeps every pin while no core token is overridden', () => {
    // This is the whole safety argument for the tours already in the wild:
    // they carry no overrides at all, so no core token is overridden, every
    // pin still applies, and nothing about their appearance moves.
    expect(resolveTheme(themed({ overrides: {} }))).toEqual(resolveTheme(null));
    // A non-core override is not a reason to release the pins either.
    expect(resolveTheme(themed({ overrides: { soft: '#010203' } })).rule).toBe('#333944');
  });

  it('keeps a yielding token the author set by hand', () => {
    const r = resolveTheme(themed({ overrides: { panel: '#ffffff', chip: '#010203' } }));
    expect(r.chip).toBe('#010203');
  });

  it('leaves error and pinRing alone, which are not derived from the core', () => {
    const r = resolveTheme(themed({ overrides: { panel: '#ffffff' } }));
    expect(r.error).toBe('#e8825b');
    expect(r.pinRing).toBe('#ffffff');
  });

  it('is a no-op on a preset that pins nothing but its core six', () => {
    const r = resolveTheme(themed({ preset: 'archival', overrides: { panel: '#ffffff' } }));
    expect(r.chip).toBe(mix('#ffffff', '#2e2418', 0.07));
  });

  it('is not released by an override the resolver refuses', () => {
    // A bad hex is ignored, so it is not a core override and releases nothing.
    const r = resolveTheme(themed({ overrides: { panel: '#fff' } }));
    expect(r.panel).toBe('#1b1e24');
    expect(r.chip).toBe('#252a32');
  });

  it('tells the pane which rows have stopped being the preset\'s', () => {
    expect(pinnedTokens('nocturne').length).toBe(12);
    expect(pinnedTokens('nocturne', {}).length).toBe(12);
    expect(pinnedTokens('nocturne', { paper: '#f7f5ef' }).sort()).toEqual(
      ['accent', 'destination', 'ink', 'panel', 'paper', 'wayfinding']);
    // A non-core override changes nothing about what is pinned.
    expect(pinnedTokens('nocturne', { soft: '#010203' }).length).toBe(12);
  });
});

describe('the preset table is as total as resolveTheme is', () => {
  it('falls back to Nocturne rather than throwing on an unknown preset', () => {
    // ThemeDialog calls pinnedTokens(theme?.preset ?? 'nocturne') straight from
    // the document, so a hand-edited tour.json must not throw here when the
    // viewer degrades gracefully on the same value.
    expect(presetPairing('brutalist' as never)).toBe('georgia');
    expect(pinnedTokens('brutalist' as never)).toEqual(pinnedTokens('nocturne'));
    expect(() => presetPairing(undefined as never)).not.toThrow();
    expect(() => pinnedTokens(null as never)).not.toThrow();
  });
});
