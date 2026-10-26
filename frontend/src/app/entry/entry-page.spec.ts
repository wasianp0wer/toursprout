import { describe, expect, it, beforeEach, afterEach, vi, type MockInstance } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Router, provideRouter } from '@angular/router';
import { EntryPage, SESSION_PROBE_TIMEOUT_MS } from './entry-page';
import { PANORAMA_VIEWER } from '../panorama/panorama-pane';
import { FakeViewer } from '../panorama/fake-viewer';

/**
 * `decision()` is protected because nothing in the application reads it —
 * only the template does. The tests read it anyway: until Task 6 lands the
 * welcome screen, the 'welcome' branch renders a placeholder, so the DOM
 * cannot yet distinguish "we decided to show the front door" from "we
 * rendered nothing". Asserting the decision keeps that pinned regardless.
 */
function decisionOf(fixture: ComponentFixture<EntryPage>): string {
  return (fixture.componentInstance as unknown as { decision: () => string }).decision();
}

function viewerWrapper(fixture: ComponentFixture<EntryPage>): HTMLElement | null {
  return (fixture.nativeElement as HTMLElement).querySelector('[data-viewer]');
}

describe('EntryPage', () => {
  let http: HttpTestingController;
  let navigate: MockInstance<Router['navigate']>;

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [EntryPage],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        { provide: PANORAMA_VIEWER, useValue: new FakeViewer() },
      ],
    });
    http = TestBed.inject(HttpTestingController);
    navigate = vi.spyOn(TestBed.inject(Router), 'navigate');
    navigate.mockResolvedValue(true);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function mount(): ComponentFixture<EntryPage> {
    const fixture = TestBed.createComponent(EntryPage);
    fixture.detectChanges();
    return fixture;
  }

  /** The probe settles on a microtask, and a rejected navigation one more
   * microtask after that, so whenStable alone can run too early. */
  async function settle(fixture: ComponentFixture<EntryPage>): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await fixture.whenStable();
    fixture.detectChanges();
  }

  it('starts the viewer bootstrap without waiting for the probe', () => {
    const fixture = mount();

    // Everything below is asserted while /api/session is still open: the
    // probe is matched so its pendency can be checked, and deliberately
    // never answered. Both tour-data/ fetches are therefore already in
    // flight *before* the probe could possibly have resolved, which is what
    // makes a published site cost no extra round trip.
    const probe = http.expectOne('/api/session');
    expect(probe.cancelled).toBe(false);
    http.expectOne('tour-data/config.json');
    http.expectOne('tour-data/tour.json');

    // ...and the viewer is mounted but hidden, so the 404 those fetches get
    // in an authoring checkout with nothing open never flashes on screen.
    expect(viewerWrapper(fixture)).toBeTruthy();
    expect(viewerWrapper(fixture)?.hidden).toBe(true);
    expect(decisionOf(fixture)).toBe('probing');
  });

  it('reveals the viewer when there is no backend', async () => {
    const fixture = mount();
    http.expectOne('/api/session').error(new ProgressEvent('error'));
    await settle(fixture);

    expect(decisionOf(fixture)).toBe('published');
    expect(viewerWrapper(fixture)?.hidden).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('treats a 200 of HTML as no backend', async () => {
    // A static host with SPA rewriting answers /api/session with index.html.
    const fixture = mount();
    http.expectOne('/api/session').flush('<!doctype html><html></html>', {
      headers: { 'Content-Type': 'text/html' },
    });
    await settle(fixture);

    expect(decisionOf(fixture)).toBe('published');
    expect(viewerWrapper(fixture)?.hidden).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('treats a probe timeout as no backend', async () => {
    vi.useFakeTimers();
    const fixture = mount();
    const probe = http.expectOne('/api/session');

    await vi.advanceTimersByTimeAsync(SESSION_PROBE_TIMEOUT_MS);
    fixture.detectChanges();

    expect(decisionOf(fixture)).toBe('published');
    expect(viewerWrapper(fixture)?.hidden).toBe(false);
    // The deadline abandons the request rather than leaving it dangling, so
    // a host that black-holes /api/session cannot answer late and yank the
    // page out from under a reader.
    expect(probe.cancelled).toBe(true);
  });

  it('navigates to /edit when a tour is open', async () => {
    const fixture = mount();
    http.expectOne('/api/session').flush({ open: true, title: 'Old Town Fairfax' });
    await settle(fixture);

    expect(navigate).toHaveBeenCalledWith(['/edit']);
    // Still hidden on the way out: the author is being sent to the editor,
    // and the viewer's own loading or error state must not show first.
    expect(viewerWrapper(fixture)?.hidden).toBe(true);
  });

  it('falls back to the viewer when the editor chunk will not load', async () => {
    navigate.mockRejectedValue(new Error('Failed to fetch dynamically imported module'));
    const fixture = mount();
    http.expectOne('/api/session').flush({ open: true, title: 'Old Town Fairfax' });
    await settle(fixture);

    // A failed navigation must not leave the page hidden and empty for
    // good: a backend answered, so tour-data/ is being served.
    expect(decisionOf(fixture)).toBe('published');
    expect(viewerWrapper(fixture)?.hidden).toBe(false);
  });

  it('does not decide for a visitor who has already left', async () => {
    const fixture = mount();
    const probe = http.expectOne('/api/session');
    fixture.destroy();

    probe.flush({ open: true, title: 'Old Town Fairfax' });
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Navigating now would yank the visitor out of wherever they went
    // instead of out of this page, which is no longer on screen.
    expect(navigate).not.toHaveBeenCalled();
    expect(decisionOf(fixture)).toBe('probing');
  });

  it('mounts the welcome screen through its deferred block', async () => {
    const fixture = mount();
    http.expectOne('/api/session').flush({ open: false });
    await settle(fixture);
    // The deferred dependency is fetched, so it lands a tick later than
    // the decision that asked for it.
    await settle(fixture);

    expect((fixture.nativeElement as HTMLElement).querySelector('app-welcome-page'))
      .toBeTruthy();
    // Proof it is the real screen and not an empty element: the welcome
    // screen asks the backend what examples it has as soon as it mounts.
    http.expectOne('/api/session/examples').flush({ examples: [] });
  });

  it('shows the welcome screen when nothing is open', async () => {
    const fixture = mount();
    http.expectOne('/api/session').flush({ open: false });
    await settle(fixture);

    expect(decisionOf(fixture)).toBe('welcome');
    // The viewer is dropped, not merely hidden: nothing is open, so there is
    // no tour for it to show and no reason to keep it in the DOM.
    expect(viewerWrapper(fixture)).toBeNull();
    expect(navigate).not.toHaveBeenCalled();
  });
});

/**
 * Asserted on the stylesheet's text, not on behaviour, because no
 * behavioural test can see this one: jsdom computes no layout, so a Leaflet
 * map built against a zero-size container looks exactly like a working one.
 *
 * The bug it guards is real and shipped once. Hiding the probing viewer with
 * `display: none` takes its box out of layout; the viewer's tour-data/
 * fetches usually win the race against the probe, so MapPane builds its map
 * while the wrapper is still hidden, and nothing in frontend/src ever calls
 * `invalidateSize` or watches for a resize — so a published visitor got a
 * permanently grey map. `display: block` is load-bearing in the fix: without
 * it the UA stylesheet's `[hidden] { display: none }` wins.
 */
describe('entry-page.css', () => {
  it('hides the probing viewer without taking away its layout box', () => {
    const css = readFileSync(join(process.cwd(), 'src/app/entry/entry-page.css'), 'utf8');
    const rule = css.slice(css.indexOf('.viewer-slot[hidden]'));
    const declarations = rule.slice(0, rule.indexOf('}'));

    expect(declarations).not.toMatch(/display:\s*none/);
    expect(declarations).toMatch(/display:\s*block/);
    expect(declarations).toMatch(/visibility:\s*hidden/);
  });
});
