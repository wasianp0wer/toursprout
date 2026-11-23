import { describe, expect, it, afterEach, beforeEach, vi, type MockInstance } from 'vitest';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Router, provideRouter } from '@angular/router';
import { Autosave, AUTOSAVE_DEBOUNCE_MS } from './autosave';
import { EditorPage } from './editor-page';
import { EditorStore } from './editor-store';
import { addStop } from './document-ops';
import { tour } from './test-builders';
import { ConfigStore } from '../core/config-store';
import type { SessionSummary } from '../core/session-api';

describe('EditorPage', () => {
  let http: HttpTestingController;
  let store: EditorStore;
  let autosave: Autosave;
  let navigate: MockInstance<Router['navigate']>;
  let fixture: ComponentFixture<EditorPage>;
  let el: HTMLElement;

  const q = (sel: string) => el.querySelector(sel) as HTMLElement | null;

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [EditorPage],
      providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])],
    });
    http = TestBed.inject(HttpTestingController);
    store = TestBed.inject(EditorStore);
    autosave = TestBed.inject(Autosave);
    navigate = vi.spyOn(TestBed.inject(Router), 'navigate');
    navigate.mockResolvedValue(true);
  });

  afterEach(() => {
    // Autosave is providedIn root and debounces on a real timer, so a
    // pending save would otherwise fire against a TestBed that has already
    // been torn down. A test that closed the tour has stopped it already.
    autosave.stop();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    document.title = '';
  });

  /** The page's work is promise-based and the app is zoneless, so a
   * macrotask tick first lets the awaited chain finish; `whenStable` alone
   * can run before it. */
  async function settle(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
    fixture.detectChanges();
    await new Promise((resolve) => setTimeout(resolve, 0));
    fixture.detectChanges();
  }

  function create(): void {
    fixture = TestBed.createComponent(EditorPage);
    el = fixture.nativeElement;
    fixture.detectChanges();
  }

  const OPEN: SessionSummary = {
    open: true, tourId: 'fairfax-old-town', title: 'Old Town Fairfax',
    stopCount: 6, mediaCount: 15, orphanCount: 6,
  };

  const CONFIG = { mapillaryToken: 'MLY|t', tileUrl: 'https://tiles/{z}/{x}/{y}.png', attribution: [] };

  /** Mounts the page with a tour open and its document loaded. */
  async function mountOpen(
    summary: SessionSummary = OPEN,
    config: () => void = () => http.expectOne('tour-data/config.json').flush(CONFIG),
  ): Promise<void> {
    create();
    http.expectOne('/api/session').flush(summary);
    await settle();
    config();
    http.expectOne('tour-data/tour.json').flush(tour());
    await settle();
  }

  /** Opens the close dialog and ticks the acknowledgement, which is the
   * route to a cold close that needs no export. */
  function askToClose(): void {
    q('[data-close-tour]')!.click();
    fixture.detectChanges();
    const box = q('[data-acknowledge]') as HTMLInputElement;
    box.checked = true;
    box.dispatchEvent(new Event('change'));
    fixture.detectChanges();
  }

  it('shows the recovery key where it can be read and copied', async () => {
    await mountOpen({ ...OPEN, recoveryKey: '0123456789abcdef' });

    const field = q('[data-recovery-key]') as HTMLInputElement;
    expect(field.value).toBe('0123456789abcdef');
    // Readonly rather than text: selectable and copyable, not editable.
    expect(field.readOnly).toBe(true);

    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    vi.useFakeTimers();
    const button = q('[data-copy-recovery-key]')!;
    expect(button.getAttribute('data-copy-state')).toBe('idle');
    button.click();
    await vi.advanceTimersByTimeAsync(0);
    fixture.detectChanges();
    expect(writeText).toHaveBeenCalledWith('0123456789abcdef');
    expect(button.getAttribute('data-copy-state')).toBe('copied');
    expect(button.textContent).toContain('Copied');

    await vi.advanceTimersByTimeAsync(2000);
    fixture.detectChanges();
    expect(button.getAttribute('data-copy-state')).toBe('idle');
  });

  it('says so when the clipboard refuses, and leaves the field to copy by hand', async () => {
    await mountOpen({ ...OPEN, recoveryKey: '0123456789abcdef' });
    const writeText = vi.fn().mockRejectedValue(new Error('denied'));
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    vi.useFakeTimers();
    const button = q('[data-copy-recovery-key]')!;
    button.click();
    await vi.advanceTimersByTimeAsync(0);
    fixture.detectChanges();
    expect(button.getAttribute('data-copy-state')).toBe('failed');
    expect((q('[data-recovery-key]') as HTMLInputElement).value).toBe('0123456789abcdef');
  });

  it('shows no recovery key when the backend sent none', async () => {
    await mountOpen();
    expect(q('[data-recovery-key]')).toBeNull();
  });

  it('shows the loading state before the session responds', () => {
    create();
    expect(el.textContent).toContain('Loading the editor');
    http.expectOne('/api/session').flush({ open: false });
  });

  it('navigates to the front door when nothing is open', async () => {
    create();
    http.expectOne('/api/session').flush({ open: false });
    await settle();

    // Creating a tour belongs to the welcome screen now; there is exactly
    // one front door, and this is not it.
    expect(navigate).toHaveBeenCalledWith(['/']);
    expect(q('[data-empty]')).toBeNull();
    expect(q('[data-error]')).toBeNull();
  });

  it('says so when it cannot even get to the front door', async () => {
    // A refused or failed navigation would otherwise leave a blank page.
    navigate.mockResolvedValue(false);
    create();
    http.expectOne('/api/session').flush({ open: false });
    await settle();

    expect(q('[data-error]')?.textContent).toContain('No tour is open');
  });

  it('loads the open document into the store', async () => {
    await mountOpen();
    expect(store.draft()?.title).toBe('T');
    expect(q('[data-shell]')).toBeTruthy();
    expect(q('[data-empty]')).toBeNull();
  });

  it('loads the viewer config so the map and panorama panes have a token', async () => {
    await mountOpen();
    const config = TestBed.inject(ConfigStore);
    expect(config.mapillaryToken()).toBe('MLY|t');
    expect(config.tileUrl()).toBe('https://tiles/{z}/{x}/{y}.png');
  });

  it('still opens the document when the config request fails', async () => {
    await mountOpen(OPEN, () =>
      http.expectOne('tour-data/config.json').error(new ProgressEvent('network')),
    );
    expect(TestBed.inject(ConfigStore).mapillaryToken()).toBe('');
    expect(store.draft()?.title).toBe('T');
    expect(q('[data-shell]')).toBeTruthy();
    expect(q('[data-error]')).toBeNull();
  });

  it('edits the title and description in the header, and links export and publish', async () => {
    await mountOpen();
    const title = q('[data-tour-title]') as HTMLInputElement;
    title.value = 'Second Tour';
    title.dispatchEvent(new Event('input'));
    const desc = q('[data-tour-description]') as HTMLInputElement;
    desc.value = 'A walk';
    desc.dispatchEvent(new Event('input'));
    expect(store.draft()?.title).toBe('Second Tour');
    expect(store.draft()?.description).toBe('A walk');
    // Left exactly as it was: a plain download link, not the dialog's blob
    // fetch. The `download` attribute is half of what makes it that.
    expect(q('[data-export]')?.getAttribute('href')).toBe('/api/session/export');
    expect(q('[data-export]')?.hasAttribute('download')).toBe(true);
    expect(q('[data-publish]')?.getAttribute('href')).toBe('/api/session/publish');
  });

  it('names the tab after the tour, marked as editing, and follows title edits', async () => {
    document.title = 'Toursprout — Virtual Walking Tours';
    await mountOpen();
    expect(document.title).toBe(`${store.draft()!.title} - Toursprout (editing)`);
    const title = q('[data-tour-title]') as HTMLInputElement;
    title.value = 'Second Tour';
    title.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect(document.title).toBe('Second Tour - Toursprout (editing)');
    fixture.destroy();
    expect(document.title).toBe('Toursprout — Virtual Walking Tours');
  });

  it('puts the TourSprout logo just before the title in the header', async () => {
    await mountOpen();
    const logo = q('header [data-app-logo]') as HTMLImageElement;
    expect(logo.getAttribute('src')).toBe('favicon.png');
    // Decoration beside a labelled field, so screen readers skip it.
    expect(logo.getAttribute('alt')).toBe('');
    expect(logo.nextElementSibling).toBe(q('[data-tour-title]'));
  });

  it('offers Close tour and Preview in the header', async () => {
    await mountOpen();
    expect(q('[data-close-tour]')).toBeTruthy();
    // A plain link, not a routerLink: a full page load is what guarantees
    // the viewer bootstraps `tour-data/` afresh.
    expect(q('[data-preview]')?.getAttribute('href')).toBe('/view');
    // Nothing is being closed until the author says so.
    expect(q('[data-close-dialog]')).toBeNull();
  });

  it('keeps the theme out of the sidebar and behind a header button', async () => {
    // Theming is an occasional act, so it belongs with the other occasional
    // acts in the header — Preview, Export, Publish, Close — and not holding
    // sidebar space away from the inspector, which is used constantly.
    await mountOpen();
    expect(q('.sidebar app-theme-dialog')).toBeNull();
    expect(q('[data-open-theme]')).toBeTruthy();
    // Nothing is open until the author asks.
    expect(q('[data-theme-dialog]')).toBeNull();
  });

  it('opens and closes the theme dialog from the header', async () => {
    await mountOpen();
    q('[data-open-theme]')!.click();
    await settle();
    expect(q('[data-theme-dialog]')).toBeTruthy();

    q('[data-theme-done]')!.click();
    await settle();
    expect(q('[data-theme-dialog]')).toBeNull();
  });

  it('tells the close dialog what is about to be deleted', async () => {
    await mountOpen();
    // Renamed since the session reported it, and with a stop added: the
    // dialog must describe the tour as it is now, not as it was opened.
    const title = q('[data-tour-title]') as HTMLInputElement;
    title.value = 'Courthouse Square';
    title.dispatchEvent(new Event('input'));
    store.apply((t) => addStop(t, 'Second'));
    fixture.detectChanges();

    q('[data-close-tour]')!.click();
    fixture.detectChanges();

    const text = q('[data-close-dialog]')!.textContent ?? '';
    expect(text).toContain('Courthouse Square');
    expect(text).toContain('2 stops');
    expect(text).toContain('15 media files');
  });

  // The media count is the one figure the dialog cannot read off the draft,
  // and it is the number the author is deciding against: telling them 15
  // files when it is 17, at the moment they destroy data, is the worst place
  // in the app to be out of date.
  it('re-reads the media count when the dialog opens', async () => {
    await mountOpen();
    q('[data-close-tour]')!.click();
    fixture.detectChanges();
    // Open and readable immediately: the probe gates nothing.
    expect(q('[data-close-dialog]')!.textContent).toContain('15 media files');

    http.expectOne('/api/session').flush({ ...OPEN, mediaCount: 17 });
    await settle();
    expect(q('[data-close-dialog]')!.textContent).toContain('17 media files');
  });

  it('keeps the count it already had when the re-read fails, and says nothing about it', async () => {
    await mountOpen();
    q('[data-close-tour]')!.click();
    fixture.detectChanges();
    http.expectOne('/api/session').error(new ProgressEvent('network'));
    await settle();

    expect(q('[data-close-dialog]')!.textContent).toContain('15 media files');
    // A failed probe is not news: it must not look like a failure to close,
    // and it must not stop the author closing.
    expect(q('[data-close-failed]')).toBeNull();
    expect(q('[data-error]')).toBeNull();
    const box = q('[data-acknowledge]') as HTMLInputElement;
    box.checked = true;
    box.dispatchEvent(new Event('change'));
    fixture.detectChanges();
    expect((q('[data-confirm-close]') as HTMLButtonElement).disabled).toBe(false);
  });

  it('dismisses the close dialog on Escape', async () => {
    await mountOpen();
    q('[data-close-tour]')!.click();
    fixture.detectChanges();
    expect(q('[data-close-dialog]')).toBeTruthy();

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    fixture.detectChanges();

    expect(q('[data-close-dialog]')).toBeNull();
    expect(store.draft()).not.toBeNull();
    http.expectNone({ method: 'DELETE', url: '/api/session' });
  });

  // jsdom does no layout, so elementFromPoint cannot say what is on top, and
  // Playwright cannot launch a browser under this sandbox (docs/ENVIRONMENT.md).
  // What can be checked is the rule that decides it: Leaflet's panes and
  // controls carry z-indexes of 400 to 1000, and only an isolated pane keeps
  // them from competing with the dialog in the page's stacking context.
  it('keeps the close dialog above the map and the panorama', async () => {
    await mountOpen();
    store.select(store.draft()!.stops[0].id);
    q('[data-close-tour]')!.click();
    fixture.detectChanges();

    for (const pane of ['app-edit-map-pane', 'app-edit-panorama-pane']) {
      const host = q(pane)!;
      expect(getComputedStyle(host).isolation, pane).toBe('isolate');
    }
    // And above anything a pane might still raise itself to outside the
    // workspace, including Leaflet's own ceiling.
    const scrim = q('[data-close-dialog]')!.closest('.scrim')!;
    expect(Number(getComputedStyle(scrim).zIndex)).toBeGreaterThan(1000);
  });

  it('keeps working when the author changes their mind', async () => {
    await mountOpen();
    q('[data-close-tour]')!.click();
    fixture.detectChanges();
    q('[data-keep-working]')!.click();
    fixture.detectChanges();

    expect(q('[data-close-dialog]')).toBeNull();
    expect(store.draft()).not.toBeNull();
    http.expectNone({ method: 'DELETE', url: '/api/session' });
    expect(navigate).not.toHaveBeenCalled();
  });

  // Review Focus 3, and the reason `Autosave.stop()` exists. A save was
  // already on the wire when the author confirmed the close; it lands on the
  // session the close is deleting and the backend 409s it. If the close
  // sequence deleted first and stopped autosave afterwards, that 409 would
  // paint "Save failed" over a close that worked.
  it('leaves no save failure behind after a confirmed close', async () => {
    await mountOpen();
    store.apply((t) => addStop(t, 'Second'));
    TestBed.flushEffects();
    await new Promise((resolve) => setTimeout(resolve, AUTOSAVE_DEBOUNCE_MS + 20));
    const put = http.expectOne({ method: 'PUT', url: '/api/session/tour' });
    expect(autosave.status()).toBe('saving');

    askToClose();
    q('[data-confirm-close]')!.click();
    const del = http.expectOne({ method: 'DELETE', url: '/api/session' });

    put.flush({ detail: 'no tour is open' }, { status: 409, statusText: 'Conflict' });
    await settle();
    // The close has not even finished yet, and already nothing may claim a
    // save failed: autosave was switched off before the DELETE was sent.
    expect(autosave.status()).not.toBe('error');
    expect(q('[data-autosave-error]')).toBeNull();
    expect(q('[data-autosave-status]')?.textContent).not.toContain('Save failed');
    // And the draft is still here: the store is cleared AFTER the session is
    // deleted, not before, so a close that fails leaves the tour intact.
    expect(store.draft()).not.toBeNull();

    del.flush({ open: false });
    await settle();

    expect(store.draft()).toBeNull();
    expect(autosave.status()).toBe('idle');
    expect(autosave.message()).toBeNull();
    expect(navigate).toHaveBeenCalledWith(['/']);
    expect(q('[data-autosave-error]')).toBeNull();
    // Nothing is saving a tour that no longer exists.
    await new Promise((resolve) => setTimeout(resolve, AUTOSAVE_DEBOUNCE_MS + 20));
    http.expectNone({ method: 'PUT', url: '/api/session/tour' });
  });

  it('keeps the tour and autosave when the close itself is refused', async () => {
    await mountOpen();
    askToClose();
    q('[data-confirm-close]')!.click();
    http.expectOne({ method: 'DELETE', url: '/api/session' }).flush(
      { detail: 'no tour is open' }, { status: 409, statusText: 'Conflict' },
    );
    await settle();

    expect(q('[data-close-failed]')?.textContent).toContain('no tour is open');
    expect(store.draft()).not.toBeNull();
    expect(navigate).not.toHaveBeenCalled();
    // The close did not happen, so the editor is working as before — which
    // includes saving what the author types next.
    store.apply((t) => addStop(t, 'Second'));
    TestBed.flushEffects();
    await new Promise((resolve) => setTimeout(resolve, AUTOSAVE_DEBOUNCE_MS + 20));
    http.expectOne({ method: 'PUT', url: '/api/session/tour' }).flush({ open: true });
  });

  it('distinguishes an unreadable document from an unreachable backend', async () => {
    create();
    // The session answers, so the backend is up. Its tour.json does not,
    // which is what a stale `ng serve` proxy looks like from in here.
    http.expectOne('/api/session').flush({ open: true, title: 'Old Town Fairfax' });
    await settle();
    http.expectOne('tour-data/tour.json').flush(null, { status: 404, statusText: 'Not Found' });
    await settle();
    const text = q('[data-error]')?.textContent ?? '';
    expect(text).toContain('could not be read');
    expect(text).not.toContain('Is the backend running');
  });

  it('shows an actionable message when the backend is unreachable', async () => {
    create();
    http.expectOne('/api/session').error(new ProgressEvent('network'));
    await settle();
    expect(q('[data-error]')?.textContent).toContain('backend');
  });
});
