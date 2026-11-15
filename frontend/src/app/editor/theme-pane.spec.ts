import { describe, expect, it, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ThemePane } from './theme-pane';
import { ThemePreview } from './theme-preview';
import { EditorStore } from './editor-store';
import { setThemeOverride, setThemePreset, setTypePairing } from './document-ops';
import { controlsWithoutLabelAbove, tour } from './test-builders';
import type { Tour } from '../core/tour.models';

const read = (f: string) => readFileSync(join(process.cwd(), f), 'utf8');
/** Every `var(--name` a stylesheet reads. */
const varNames = (css: string) =>
  new Set([...css.matchAll(/var\(\s*(--[a-z-]+)/g)].map((m) => m[1]));

describe('ThemePane', () => {
  let store: EditorStore;
  let fixture: ReturnType<typeof TestBed.createComponent<ThemePane>>;
  let el: HTMLElement;

  const q = (sel: string) => el.querySelector(sel) as HTMLElement | null;
  const qa = (sel: string) => Array.from(el.querySelectorAll(sel)) as HTMLElement[];
  const settle = async () => { fixture.detectChanges(); await fixture.whenStable(); fixture.detectChanges(); };
  const start = async (t: Tour = tour()) => {
    store.load(t);
    fixture = TestBed.createComponent(ThemePane);
    el = fixture.nativeElement;
    await settle();
  };
  const overrides = () => store.draft()!.theme?.overrides ?? {};
  const choose = async (sel: string, value: string) => {
    const s = q(sel) as HTMLSelectElement;
    s.value = value; s.dispatchEvent(new Event('change')); await settle();
  };

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [ThemePane] });
    store = TestBed.inject(EditorStore);
  });

  describe('contrast readout', () => {
    it('shows a contrast warning without disabling anything', async () => {
      // ink #111111 on panel #0f0f0f
      await start(setThemeOverride(setThemeOverride(tour(), 'ink', '#111111'), 'panel', '#0f0f0f'));
      const warning = q('[data-contrast-warning]')!;
      expect(warning.textContent).toContain('Body text 1.0:1');
      expect(warning.textContent).toContain('below the AA standard');
      expect(warning.textContent).toContain('You can publish it anyway');
      expect(el.querySelectorAll('button[disabled],input[disabled],select[disabled]').length).toBe(0);
    });

    it('is quiet when every pair passes, and still shows the three ratios', async () => {
      await start();
      expect(q('[data-contrast-warning]')).toBeNull();
      expect(qa('[data-contrast]').map((r) => r.getAttribute('data-contrast')))
        .toEqual(['body', 'accent', 'button']);
    });

    it('warns about the button label separately from the body text', async () => {
      await start(setThemeOverride(tour(), 'onAccent', '#e8b04b'));
      const warnings = qa('[data-contrast-warning]');
      expect(warnings.length).toBe(1);
      expect(warnings[0].textContent).toContain('Button label');
    });

    it('does not round a failing ratio up to the pass mark', async () => {
      // #767676 on white is 4.54, #777777 is 4.48: the second must not read 4.5.
      await start(setThemeOverride(setThemeOverride(tour(), 'ink', '#777777'), 'panel', '#ffffff'));
      expect(q('[data-contrast-warning]')!.textContent).toContain('Body text 4.4:1');
    });
  });

  describe('colour rows', () => {
    it('puts six rows on top and the other seven behind the disclosure', async () => {
      await start();
      const top = qa('.theme > .colours > [data-row]').map((r) => r.getAttribute('data-row'));
      expect(top).toEqual(['paper', 'panel', 'ink', 'accent', 'wayfinding', 'destination']);
      const more = qa('details [data-row]').map((r) => r.getAttribute('data-row'));
      expect(more.sort()).toEqual(
        ['attributionBar', 'chip', 'chipSelected', 'muted', 'onAccent', 'rule', 'soft']);
      expect(q('details')!.hasAttribute('open')).toBe(false);
    });

    it('never offers the two internal tokens', async () => {
      await start();
      expect(q('[data-row="error"]')).toBeNull();
      expect(q('[data-row="pinRing"]')).toBeNull();
      const html = read('src/app/editor/theme-pane.html');
      expect(html).not.toMatch(/pinRing|pin-ring/);
      expect(html).not.toMatch(/['"]error['"]/);
    });

    it('gives each row suggested swatches, a colour input and a reset', async () => {
      await start();
      for (const row of qa('[data-row]')) {
        expect(row.querySelectorAll('[data-swatch]').length).toBeGreaterThan(0);
        expect(row.querySelector('input[type="color"]')).toBeTruthy();
        expect(row.querySelector('[data-reset]')).toBeTruthy();
      }
    });

    it('labels each row preset, derived or set', async () => {
      await start();
      const state = (t: string) => q(`[data-row="${t}"] [data-state]`)!.getAttribute('data-state');
      expect(state('accent')).toBe('preset');
      expect(state('chip')).toBe('preset');       // nocturne pins its own chip
      expect(state('onAccent')).toBe('derived');  // nocturne leaves this to the contrast rule
      store.apply((t) => setThemePreset(t, 'archival'));
      await settle();
      expect(state('chip')).toBe('derived');      // archival derives it
      store.apply((t) => setThemeOverride(t, 'chip', '#223344'));
      await settle();
      expect(state('chip')).toBe('set');
    });

    it('shows the resolved colour in the colour input', async () => {
      await start();
      expect((q('[data-row="accent"] input[type="color"]') as HTMLInputElement).value).toBe('#e8b04b');
    });

    it('sets an override from the colour input, once it is committed', async () => {
      await start();
      const input = q('[data-row="accent"] input[type="color"]') as HTMLInputElement;
      input.value = '#aa0000'; input.dispatchEvent(new Event('change')); await settle();
      expect(overrides().accent).toBe('#aa0000');
    });

    it('sets an override from a swatch', async () => {
      await start();
      const swatch = q('[data-row="accent"] [data-swatch="#9c5a24"]')!;
      swatch.click(); await settle();
      expect(overrides().accent).toBe('#9c5a24');
    });

    it('resets one row', async () => {
      await start(setThemeOverride(setThemeOverride(tour(), 'accent', '#aa0000'), 'ink', '#000000'));
      (q('[data-row="accent"] [data-reset]') as HTMLElement).click(); await settle();
      expect(overrides()).toEqual({ ink: '#000000' });
    });

    it('resets every colour to the preset', async () => {
      await start(setThemeOverride(setThemeOverride(tour(), 'accent', '#aa0000'), 'ink', '#000000'));
      (q('[data-reset-all]') as HTMLElement).click(); await settle();
      expect(overrides()).toEqual({});
    });
  });

  describe('choices', () => {
    it('changing the preset clears the overrides', async () => {
      await start(setThemeOverride(tour(), 'accent', '#aa0000'));
      await choose('[data-field="preset"]', 'civic');
      expect(store.draft()!.theme!.preset).toBe('civic');
      expect(overrides()).toEqual({});
    });

    it('sets the type pairing, scale and layout', async () => {
      await start();
      await choose('[data-field="pairing"]', 'plex');
      await choose('[data-field="scale"]', 'generous');
      (q('[data-layout-option="immersive"]') as HTMLElement).click(); await settle();
      expect(store.draft()!.theme).toMatchObject(
        { typePairing: 'plex', typeScale: 'generous', layout: 'immersive' });
    });

    it('offers every name the core vocabulary has', async () => {
      await start();
      expect(qa('[data-field="preset"] option').length).toBe(4);
      expect(qa('[data-field="pairing"] option').length).toBe(5);
      expect(qa('[data-field="scale"] option').length).toBe(3);
      expect(qa('[data-layout-option]').length).toBe(3);
    });

    it('marks the current layout', async () => {
      await start();
      expect(q('[data-layout-option="widePanel"]')!.getAttribute('aria-pressed')).toBe('true');
      expect(q('[data-layout-option="panelLeft"]')!.getAttribute('aria-pressed')).toBe('false');
    });

    it('puts every control under a label', async () => {
      await start();
      // Colour inputs sit in rows with their own label text; the rest in labels.
      expect(controlsWithoutLabelAbove(el).filter((c) => !c.includes('type="color"'))).toEqual([]);
    });
  });

  describe('words', () => {
    it('uses the plain labels', async () => {
      await start();
      const text = el.textContent!;
      for (const label of ['Theme', 'Colours', 'More colours', 'Type pairing', 'Type scale', 'Layout'])
        expect(text).toContain(label);
    });

    it('ships no explanatory mockup copy', () => {
      const html = read('src/app/editor/theme-pane.html');
      for (const phrase of ['font files we serve', 'starting point', 'derived until set'])
        expect(html).not.toContain(phrase);
    });

    it('does not mark option chips with data-type-pairing', () => {
      // The attribute is the signal "this is a preview surface"; only the preview carries it.
      expect(read('src/app/editor/theme-pane.html')).not.toContain('data-type-pairing');
    });
  });

  describe('the miniature', () => {
    it('is in the pane and follows the draft', async () => {
      await start(setTypePairing(setThemePreset(tour(), 'archival'), 'plex'));
      const preview = q('app-theme-preview')!;
      expect(preview.getAttribute('data-type-pairing')).toBe('plex');
      expect(preview.style.getPropertyValue('--paper')).toBe('#f4ecdd');
      store.apply((t) => setThemeOverride(t, 'paper', '#112233'));
      await settle();
      expect(preview.style.getPropertyValue('--paper')).toBe('#112233');
    });
  });
});

describe('ThemePreview', () => {
  const css = read('src/app/editor/theme-preview.css');

  it('uses only token names the viewer also defines', () => {
    const mine = varNames(css);
    expect(mine.size).toBeGreaterThan(5);
    // styles.css is in the set on purpose: --display and --body are declared
    // there, not in a component stylesheet, so a subset test that read only the
    // four component files would fail on a correct preview.
    const theirs = new Set([
      ...varNames(read('src/app/viewer/viewer-page.css')),
      ...varNames(read('src/app/stop/stop-panel.css')),
      ...varNames(read('src/app/map/map-pane.css')),
      ...varNames(read('src/app/panorama/panorama-pane.css')),
      ...varNames(read('src/styles.css')),
      // The viewer's pins take this colour as a parameter from
      // markerColoursFor, not from CSS, so no viewer stylesheet reads it.
      // The miniature has no JavaScript to pass them through.
      '--destination',
    ]);
    for (const name of mine) expect(theirs, name).toContain(name);
  });

  it('applies the fonts itself, with fallbacks, because the attribute rules only set tokens', () => {
    expect(css).toMatch(/font-family:\s*var\(--body,\s*Georgia/);
    expect(css).toMatch(/font-family:\s*var\(--display,\s*Georgia/);
    expect(css).toMatch(/font-weight:\s*var\(--display-weight,\s*600\)/);
  });

  it('carries the pairing and layout as attributes, with the type scale as a token', () => {
    TestBed.configureTestingModule({ imports: [ThemePreview] });
    const f = TestBed.createComponent(ThemePreview);
    f.componentRef.setInput('theme', {
      preset: 'civic', typePairing: 'franklin', typeScale: 'generous', layout: 'panelLeft', overrides: {},
    });
    f.detectChanges();
    const host = f.nativeElement as HTMLElement;
    expect(host.getAttribute('data-type-pairing')).toBe('franklin');
    expect(host.getAttribute('data-layout')).toBe('panelLeft');
    expect(host.style.getPropertyValue('--type-scale')).toBe('1.14');
  });

  it('falls back to a valid pairing when the stored one is not recognised', () => {
    TestBed.configureTestingModule({ imports: [ThemePreview] });
    const f = TestBed.createComponent(ThemePreview);
    f.componentRef.setInput('theme', { preset: 'civic', typePairing: 'comic', typeScale: 'comfortable', layout: 'widePanel', overrides: {} });
    f.detectChanges();
    expect((f.nativeElement as HTMLElement).getAttribute('data-type-pairing')).toBe('georgia');
  });
});
