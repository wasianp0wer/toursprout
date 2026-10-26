import { describe, expect, it, beforeEach, afterEach, vi, type MockInstance } from 'vitest';
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
    await fixture.whenStable();
    fixture.detectChanges();

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
    await fixture.whenStable();
    fixture.detectChanges();

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
    await fixture.whenStable();
    fixture.detectChanges();

    expect(navigate).toHaveBeenCalledWith(['/edit']);
    // Still hidden on the way out: the author is being sent to the editor,
    // and the viewer's own loading or error state must not show first.
    expect(viewerWrapper(fixture)?.hidden).toBe(true);
  });

  it('shows the welcome screen when nothing is open', async () => {
    const fixture = mount();
    http.expectOne('/api/session').flush({ open: false });
    await fixture.whenStable();
    fixture.detectChanges();

    expect(decisionOf(fixture)).toBe('welcome');
    // The viewer is dropped, not merely hidden: nothing is open, so there is
    // no tour for it to show and no reason to keep it in the DOM.
    expect(viewerWrapper(fixture)).toBeNull();
    expect(navigate).not.toHaveBeenCalled();
  });
});
