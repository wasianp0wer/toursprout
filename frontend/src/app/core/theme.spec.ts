import { describe, expect, it } from 'vitest';
import {
  contrastRatio, cssVariablesFor, markerColoursFor, mix, readableOn, resolveTheme,
} from './theme';
import type { Theme } from './theme';

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
    expect(r.muted).toBe(mix(r.ink, r.panel, 0.45));
    expect(r.mutedWeak).toBe(mix(r.muted, r.panel, 0.45));
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
