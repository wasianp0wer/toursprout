import { describe, expect, it, beforeEach, vi } from 'vitest';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { CloseDialog } from './close-dialog';

/** What the dialog handed to the browser to save, per anchor click. */
interface Handoff {
  href: string;
  download: string;
}

describe('CloseDialog', () => {
  let http: HttpTestingController;
  let fixture: ComponentFixture<CloseDialog>;
  let el: HTMLElement;
  let handoffs: Handoff[];

  const q = (sel: string) => el.querySelector(sel) as HTMLElement | null;

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [CloseDialog],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    http = TestBed.inject(HttpTestingController);

    // jsdom can make an object URL but cannot follow one: a click on an
    // anchor is a navigation it does not implement. Recording the click is
    // also the only way to assert the blob was actually offered to the
    // author, which is the whole point of fetching it rather than linking.
    handoffs = [];
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:tour');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      handoffs.push({ href: this.getAttribute('href') ?? '', download: this.download });
    });
  });

  /** The dialog's work is promise-based and the app is zoneless, so a
   * macrotask tick first lets the awaited chain (including reading a 409's
   * JSON back out of its Blob body) finish. */
  async function settle(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
    fixture.detectChanges();
    await new Promise((resolve) => setTimeout(resolve, 0));
    fixture.detectChanges();
  }

  function mount(): void {
    fixture = TestBed.createComponent(CloseDialog);
    fixture.componentRef.setInput('tourTitle', 'Old Town Fairfax');
    fixture.componentRef.setInput('stopCount', 6);
    fixture.componentRef.setInput('mediaCount', 15);
    el = fixture.nativeElement;
    fixture.detectChanges();
  }

  const confirm = () => q('[data-confirm-close]') as HTMLButtonElement;

  it('names the tour and what is in it', () => {
    mount();
    const text = q('[data-close-dialog]')!.textContent ?? '';
    expect(text).toContain('Old Town Fairfax');
    expect(text).toContain('6 stops');
    expect(text).toContain('15 media files');
    // The one fact an author cannot recover from being wrong about.
    expect(text).toContain('only');
  });

  it('keeps close disabled until the bundle is downloaded', async () => {
    mount();
    expect(confirm().disabled).toBe(true);

    q('[data-download]')!.click();
    const req = http.expectOne('/api/session/export');
    expect(req.request.responseType).toBe('blob');
    req.flush(new Blob(['x'.repeat(2048)]));
    await settle();

    expect(q('[data-size]')?.textContent).toContain('2.0 kB');
    expect(handoffs).toEqual([{ href: 'blob:tour', download: 'tour.zip' }]);
    expect(confirm().disabled).toBe(false);
    expect(q('[data-export-failed]')).toBeNull();
  });

  it('keeps close disabled until the author acknowledges instead', () => {
    mount();
    expect(confirm().disabled).toBe(true);

    const box = q('[data-acknowledge]') as HTMLInputElement;
    box.checked = true;
    box.dispatchEvent(new Event('change'));
    fixture.detectChanges();

    expect(confirm().disabled).toBe(false);
    // Nothing was downloaded, so no size is claimed.
    expect(q('[data-size]')).toBeNull();
  });

  it('falls back to acknowledging when the export cannot be built', async () => {
    mount();
    q('[data-download]')!.click();
    const detail = 'tour.json references media that is not in the session: media/missing.jpg';
    http.expectOne('/api/session/export').flush(
      new Blob([JSON.stringify({ detail })], { type: 'application/json' }),
      { status: 409, statusText: 'Conflict' },
    );
    await settle();

    // The backend's own words, not a generic failure.
    expect(q('[data-export-failed]')?.textContent).toContain(detail);
    expect(q('[data-size]')).toBeNull();
    // Refusing to close here would trap the author in a tour they cannot
    // leave, so the acknowledgement still releases the gate.
    expect(confirm().disabled).toBe(true);
    const box = q('[data-acknowledge]') as HTMLInputElement;
    box.checked = true;
    box.dispatchEvent(new Event('change'));
    fixture.detectChanges();
    expect(confirm().disabled).toBe(false);
  });

  it('emits closed only from the confirmation', async () => {
    mount();
    const closed = vi.fn();
    fixture.componentInstance.closed.subscribe(closed);

    q('[data-download]')!.click();
    http.expectOne('/api/session/export').flush(new Blob(['x']));
    await settle();
    expect(closed).not.toHaveBeenCalled();

    confirm().click();
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it('emits cancelled from Keep working', () => {
    mount();
    const cancelled = vi.fn();
    fixture.componentInstance.cancelled.subscribe(cancelled);
    q('[data-keep-working]')!.click();
    expect(cancelled).toHaveBeenCalledTimes(1);
  });

  // Escape is the conventional form of "the quiet way out", and this is the
  // one screen where an author may be alarmed: it is telling them their only
  // copy is about to be deleted.
  it('backs out on Escape, exactly as Keep working does', () => {
    mount();
    const cancelled = vi.fn();
    fixture.componentInstance.cancelled.subscribe(cancelled);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(cancelled).toHaveBeenCalledTimes(1);
  });

  it('takes focus when it opens', () => {
    mount();
    // The dialog itself, so a screen reader announces what it is, and so the
    // keys that dismiss it reach it without a click first.
    expect(document.activeElement).toBe(q('[data-close-dialog]'));
  });
});
