import { describe, expect, it, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ViewerPage } from './viewer-page';
import { PANORAMA_VIEWER } from '../panorama/panorama-pane';
import { FakeViewer } from '../panorama/fake-viewer';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Tour } from '../core/tour.models';
import { LAYOUT_NAMES, cssVariablesFor, resolveTheme } from '../core/theme';

const TOUR: Tour = JSON.parse(
  readFileSync(join(process.cwd(), '..', 'content', 'tours', 'fairfax-old-town.json'), 'utf8'),
);

describe('ViewerPage', () => {
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [ViewerPage],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: PANORAMA_VIEWER, useValue: new FakeViewer() },
      ],
    });
    http = TestBed.inject(HttpTestingController);
  });

  it('shows an actionable message when the backend is unreachable', async () => {
    const fixture = TestBed.createComponent(ViewerPage);
    fixture.detectChanges();
    http.expectOne('tour-data/config.json').error(new ProgressEvent('network'));
    http.expectOne('tour-data/tour.json').error(new ProgressEvent('network'));
    // The bootstrap promise rejects on a microtask; whenStable alone can run
    // before the catch block has set the error signal.
    await new Promise((resolve) => setTimeout(resolve, 0));
    await fixture.whenStable();
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('[data-error]')?.textContent).toContain('backend');
  });

  it('distinguishes no-tour-open from an unreachable backend', async () => {
    const fixture = TestBed.createComponent(ViewerPage);
    fixture.detectChanges();
    // The backend is up and serving; the working directory simply has no
    // tour in it, so tour-data/ 404s. Telling the reader to start a server
    // would send them to the wrong fix.
    http.expectOne('tour-data/config.json').flush(null, { status: 404, statusText: 'Not Found' });
    http.expectOne('tour-data/tour.json').flush(null, { status: 404, statusText: 'Not Found' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await fixture.whenStable();
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const text = el.querySelector('[data-error]')?.textContent ?? '';
    expect(text).toContain('No tour is open');
    expect(text).not.toContain('backend');
    // And it must name a fix that still exists. The editor used to be able
    // to create a tour; the welcome screen at '/' took that over and the
    // editor's empty state was removed, so "open or import one in the
    // editor" now sends the reader to a route that would bounce them back
    // here. A message naming the one fix that cannot work is the defect
    // this whole branch grew out of.
    expect(text).not.toContain('in the editor');
    expect(text).toContain('start screen');
  });

  it('shows the loading state before the tour arrives', () => {
    const fixture = TestBed.createComponent(ViewerPage);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.textContent).toContain('Loading the tour');
    http.expectOne('tour-data/config.json');
    http.expectOne('tour-data/tour.json');
  });

  it('renders an attribution with no URL as plain text, not a broken link', async () => {
    // `Attribution.url` is nullable as of v3, for the same reason
    // `OriginalCredit` exists: a line of credit with nothing to link to is
    // ordinary. The template used to emit `<a href>` unconditionally, which
    // for a null URL is a link to the page itself.
    const fixture = TestBed.createComponent(ViewerPage);
    fixture.detectChanges();
    http.expectOne('tour-data/config.json').flush({
      mapillaryToken: '',
      tileUrl: 'https://tile.example/{z}/{x}/{y}.png',
      attribution: [
        { text: 'Photographs by the author', url: null, license: 'CC-BY-4.0' },
        { text: 'Map data (c) OpenStreetMap contributors',
          url: 'https://www.openstreetmap.org/copyright', license: 'ODbL' },
      ],
    });
    http.expectOne('tour-data/tour.json').flush(TOUR);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await fixture.whenStable();
    fixture.detectChanges();

    const footer = (fixture.nativeElement as HTMLElement).querySelector('.attribution')!;
    expect(footer.textContent).toContain('Photographs by the author');
    const links = [...footer.querySelectorAll('a')].map((a) => a.textContent?.trim());
    expect(links).toEqual(['Map data (c) OpenStreetMap contributors']);
  });

  async function mountWith(tour: Tour): Promise<{ fixture: ReturnType<typeof TestBed.createComponent<ViewerPage>>; host: HTMLElement }> {
    const fixture = TestBed.createComponent(ViewerPage);
    fixture.detectChanges();
    http.expectOne('tour-data/config.json').flush({
      mapillaryToken: '',
      tileUrl: 'https://tile.example/{z}/{x}/{y}.png',
      attribution: [],
    });
    http.expectOne('tour-data/tour.json').flush(tour);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await fixture.whenStable();
    fixture.detectChanges();
    return { fixture, host: fixture.nativeElement as HTMLElement };
  }

  const ARCHIVAL: Tour = {
    ...TOUR,
    theme: {
      preset: 'archival', typePairing: 'garamond', typeScale: 'generous',
      layout: 'panelLeft', overrides: {},
    },
  };

  describe('theming', () => {
    it('writes the resolved tokens onto its own host, not the document root', async () => {
      const { host } = await mountWith(ARCHIVAL);
      expect(host.style.getPropertyValue('--paper')).toBe('#f4ecdd');
      expect(document.documentElement.style.getPropertyValue('--paper')).toBe('');
    });

    it('writes the type scale factor onto the host', async () => {
      const { host } = await mountWith(ARCHIVAL);
      expect(host.style.getPropertyValue('--type-scale')).toBe('1.14');
    });

    it('reflects the layout and the type pairing as attributes', async () => {
      const { host } = await mountWith(ARCHIVAL);
      expect(host.getAttribute('data-layout')).toBe('panelLeft');
      expect(host.getAttribute('data-type-pairing')).toBe('garamond');
    });

    it('still renders a tour that carries no theme, in Nocturne', async () => {
      const bare = { ...TOUR } as Tour;
      delete bare.theme;
      const { fixture, host } = await mountWith(bare);
      expect(host.querySelector('[data-ready]')).not.toBeNull();
      expect(host.style.getPropertyValue('--paper')).toBe('#14161a');
      expect(host.getAttribute('data-layout')).toBe('widePanel');
      expect(fixture.componentInstance.resolved().paper).toBe('#14161a');
    });
  });

  // jsdom computes no cascade, so what the browser will paint is asserted on
  // the stylesheet's text, as entry-page.spec.ts does for its own load-bearing
  // rule.
  describe('viewer-page.css', () => {
    const css = readFileSync(join(process.cwd(), 'src/app/viewer/viewer-page.css'), 'utf8');

    it('paints the page colour on the host so body never shows through', () => {
      expect(css).toMatch(/:host\s*\{[^}]*background:\s*var\(--paper\)/);
      expect(css).toMatch(/:host\s*\{[^}]*min-height:\s*100vh/);
    });

    it('defines a grid for every layout name', () => {
      // A grid-template-areas inside the layout's own .layout block, so a
      // block that only nudged a border, or a mention in a comment, fails.
      for (const name of LAYOUT_NAMES) {
        const re = new RegExp(
          `:host\\(\\[data-layout='${name}'\\]\\)\\s+\\.layout\\s*\\{[^}]*grid-template-areas:`);
        expect(css, name).toMatch(re);
      }
    });

    it('stacks every layout the same way below 900px', () => {
      const media = css.slice(css.indexOf('@media (max-width: 900px)'));
      expect(media).toContain('@media (max-width: 900px)');
      // Equal specificity to the layout blocks, so source order decides; and
      // `[data-layout]` without a value so it covers all three.
      expect(media).toMatch(/:host\(\[data-layout\]\)\s+\.layout\s*\{[^}]*grid-template-areas:\s*"pano"\s+"map"\s+"panel"\s+"attr"/);
    });

    it('scales inherited text by sizing the host in rem', () => {
      // Prose, the stop summary and the Prev/Next labels declare no font-size
      // and inherit from the host; without this they would stay at 16px.
      expect(css).toMatch(/:host\s*\{[^}]*font-size:\s*calc\(1rem \* var\(--type-scale\)\)/);
    });

    it('holds no colour literals', () => {
      expect(css).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    });
  });

  describe('viewer stylesheets', () => {
    const files = [
      'src/app/viewer/viewer-page.css',
      'src/app/stop/stop-panel.css',
      'src/app/map/map-pane.css',
      'src/app/panorama/panorama-pane.css',
    ];
    for (const f of files) {
      it(`${f} reads colours from tokens and scales every font-size`, () => {
        const css = readFileSync(join(process.cwd(), f), 'utf8');
        expect(css).not.toMatch(/#[0-9a-f]{3,8}\b/i);
        expect(css).not.toMatch(/rgba?\(/);
        for (const m of css.matchAll(/(?<![-\w])font-size:\s*([^;}]*)/g)) {
          expect(m[1]).toMatch(/^calc\(.+ \* var\(--type-scale\)\)$/);
        }
      });
    }

    it('paints the primary button with accent, not wayfinding', () => {
      // wayfinding means "another stop" and nothing else (spec 5.2); the
      // primary action is accent. Today's blue is the same value for both,
      // so "preserving today's colour" would pass every hex-free check and
      // quietly re-conflate the two tokens.
      const css = readFileSync(join(process.cwd(), 'src/app/stop/stop-panel.css'), 'utf8');
      const rule = css.match(/\.controls button\s*\{[^}]*\}/)![0];
      expect(rule).toMatch(/background:\s*var\(--accent\)/);
      expect(rule).toMatch(/color:\s*var\(--on-accent\)/);
      expect(rule).not.toContain('wayfinding');
    });

    it('gives color-mix a fallback declaration, with no colour literal in it', () => {
      // A browser without color-mix drops that declaration at parse time, and
      // Leaflet's own rgba(255,255,255,0.8) then wins: grey credit text in a
      // white box on a dark tour. The fallback is the solid token, which costs
      // only the translucency and keeps this file free of colour literals.
      const css = readFileSync(join(process.cwd(), 'src/app/map/map-pane.css'), 'utf8');
      expect(css).toMatch(
        /background:\s*var\(--attribution-bar\);\s*background:\s*color-mix\(in srgb,/);
    });

    it('names only tokens that cssVariablesFor emits', () => {
      // A var() nobody emits renders as nothing, silently: jsdom, lint and
      // the production build all let it through.
      const known = new Set([...Object.keys(cssVariablesFor(resolveTheme(null))), '--type-scale']);
      for (const f of files) {
        const css = readFileSync(join(process.cwd(), f), 'utf8');
        for (const m of css.matchAll(/var\((--[\w-]+)/g)) {
          expect(known.has(m[1]), `${f}: ${m[1]}`).toBe(true);
        }
      }
    });

    it('has the rules that make --display and --body do anything', () => {
      const css = readFileSync(join(process.cwd(), 'src/styles.css'), 'utf8');
      expect(css).toMatch(/app-viewer-page\s*\{[^}]*font-family:\s*var\(--body/);
      expect(css).toMatch(/app-viewer-page h2, app-viewer-page h3\s*\{[^}]*font-family:\s*var\(--display/);
      expect(css).toMatch(/app-viewer-page h2, app-viewer-page h3\s*\{[^}]*font-weight:\s*var\(--display-weight/);
    });

    it('themes only the pin ring in styles.css, leaving the editor literals', () => {
      const css = readFileSync(join(process.cwd(), 'src/styles.css'), 'utf8');
      expect(css).toMatch(/\.stop-pin span\s*\{[^}]*border:\s*2px solid var\(--pin-ring\)/);
      // Twelve hex literals before this task; the pin ring was converted, so 11 remain.
      expect(css.match(/#[0-9a-f]{3,8}\b/gi)?.length).toBe(11);
    });
  });
});
