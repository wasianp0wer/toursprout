import { describe, expect, it, beforeEach, afterEach, vi, type MockInstance } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Router, provideRouter } from '@angular/router';
import { EntryPage, WAITING_NOTICE_MS } from './entry-page';
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
    // jsdom's document outlives each test; a leftover mark would make every
    // later test a published page.
    document.documentElement.removeAttribute('data-published');
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
    // And makes no further `/api` call: the published site is the anti-goal
    // this whole page exists to protect, and one failed probe is the entire
    // price a public visitor pays for it. A retry — the obvious, well-meant
    // "the connection might have blipped" change — would charge every
    // visitor to a backend-free host a second round trip to learn the same
    // thing. Matched by predicate rather than by `http.verify()`, because
    // the two `tour-data/` requests are deliberately left unflushed.
    http.expectNone((r) => r.url.startsWith('/api'));
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

  it('reveals the viewer at once on a published page and never calls /api', () => {
    document.documentElement.setAttribute('data-published', '');
    const fixture = mount();

    // Synchronously: no probe, so nothing to wait for.
    expect(decisionOf(fixture)).toBe('published');
    expect(viewerWrapper(fixture)?.hidden).toBe(false);
    // None, not a fast one: a published host may black-hole /api.
    http.expectNone((r) => r.url.includes('/api'));
  });

  function waitingLine(fixture: ComponentFixture<EntryPage>): HTMLElement | null {
    return (fixture.nativeElement as HTMLElement).querySelector('[data-waiting]');
  }

  it('awaits a slow backend on the authoring host with no deadline', async () => {
    vi.useFakeTimers();
    const fixture = mount();
    const probe = http.expectOne('/api/session');

    // Far past the measured worst case (73.2 s) and past any deadline this
    // page ever had: the authoring host really answers this slowly, and an
    // unmarked page is the authoring host by contract.
    await vi.advanceTimersByTimeAsync(60_000);
    fixture.detectChanges();
    expect(decisionOf(fixture)).toBe('probing');
    expect(viewerWrapper(fixture)?.hidden).toBe(true);
    expect(probe.cancelled).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
    expect(waitingLine(fixture)).toBeTruthy();

    probe.flush({ open: true, title: 'Old Town Fairfax' });
    await vi.advanceTimersByTimeAsync(0);

    // (`probe.cancelled` is true after any answer — the subscription is torn
    // down on completion — so it is only meaningful above, before one.)
    expect(navigate).toHaveBeenCalledWith(['/edit']);
  });

  it('shows the waiting line only after WAITING_NOTICE_MS, and drops it on an answer', async () => {
    vi.useFakeTimers();
    const fixture = mount();
    const probe = http.expectOne('/api/session');

    await vi.advanceTimersByTimeAsync(WAITING_NOTICE_MS - 1);
    fixture.detectChanges();
    expect(waitingLine(fixture)).toBeNull();

    await vi.advanceTimersByTimeAsync(1);
    fixture.detectChanges();
    expect(waitingLine(fixture)?.textContent).toContain('Waiting for the tour service');
    // Information, not a decision.
    expect(decisionOf(fixture)).toBe('probing');
    expect(viewerWrapper(fixture)?.hidden).toBe(true);

    probe.flush({ open: false });
    await vi.advanceTimersByTimeAsync(0);
    fixture.detectChanges();
    expect(waitingLine(fixture)).toBeNull();
  });

  it('never shows the waiting line when the answer beats the notice', async () => {
    vi.useFakeTimers();
    const fixture = mount();
    http.expectOne('/api/session').error(new ProgressEvent('error'), { status: 0 });
    await vi.advanceTimersByTimeAsync(WAITING_NOTICE_MS * 2);
    fixture.detectChanges();
    expect(waitingLine(fixture)).toBeNull();
  });

  it('says so, and decides nothing, when the service answers with a 5xx', async () => {
    const fixture = mount();
    http.expectOne('/api/session').flush(null, { status: 524, statusText: 'A Timeout Occurred' });
    await settle(fixture);

    // Not "no backend": a Cloudflare 524 means the origin exists and was too
    // slow, and the viewer would sit in front of a dead backend.
    expect(decisionOf(fixture)).toBe('broken');
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('524');
    expect(viewerWrapper(fixture)).toBeNull();
    expect(navigate).not.toHaveBeenCalled();
    http.expectNone((r) => r.url.startsWith('/api'));
  });

  it('says so on a 403 too: only what sits in front of the app sends one', async () => {
    const fixture = mount();
    http.expectOne('/api/session').flush(null, { status: 403, statusText: 'Forbidden' });
    await settle(fixture);

    expect(decisionOf(fixture)).toBe('broken');
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('403');
    expect(viewerWrapper(fixture)).toBeNull();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('clears the waiting-line timer when destroyed before it fires', async () => {
    vi.useFakeTimers();
    const fixture = mount();
    http.expectOne('/api/session');
    fixture.destroy();

    await vi.advanceTimersByTimeAsync(WAITING_NOTICE_MS * 2);

    expect((fixture.componentInstance as unknown as { waiting: () => boolean }).waiting())
      .toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reveals the viewer at once on a 404 (a static host with no SPA rewrite)', async () => {
    const fixture = mount();
    http.expectOne('/api/session').flush(null, { status: 404, statusText: 'Not Found' });
    await settle(fixture);

    expect(decisionOf(fixture)).toBe('published');
    expect(viewerWrapper(fixture)?.hidden).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
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

  /**
   * The premise the rule above rests on, pinned rather than asserted in
   * prose. "Nothing recovers a map measured at the wrong size" is what makes
   * the CSS load-bearing instead of merely tidy, and it is currently claimed
   * by three documents (`ARCHITECTURE.md`, `CHANGING-THINGS.md` and
   * `UNVERIFIED.md` entry 20) and two source comments (`entry-page.css` and
   * the one above).
   *
   * **This test is inverted on purpose, and a failure is not a bug.** Adding
   * `invalidateSize` or a `ResizeObserver` would be an improvement — it would
   * make the hidden-wrapper hazard survivable. What must not happen is that
   * improvement landing while all five of those still tell the next reader
   * there is no recovery, and `UNVERIFIED.md` entry 20 still sends them to
   * check for a grey map. So: if this fails, update them and delete this
   * test. Do not weaken it to keep it green.
   *
   * Only non-spec `.ts` is scanned: a call can live nowhere else, test code
   * does not ship, and `entry-page.css` names `invalidateSize` in the comment
   * that explains all of this.
   */
  it('still has nothing that recovers a map measured at the wrong size', () => {
    const src = join(process.cwd(), 'src');
    const files = readdirSync(src, { recursive: true, encoding: 'utf8' })
      .filter((rel) => rel.endsWith('.ts') && !rel.endsWith('.spec.ts'));
    expect(files.length).toBeGreaterThan(20);

    const offenders = files.filter(
      (rel) => /invalidateSize|ResizeObserver/.test(readFileSync(join(src, rel), 'utf8')),
    );
    expect(offenders).toEqual([]);
  });
});
