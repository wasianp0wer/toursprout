import { describe, expect, it, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { EditorPage } from './editor-page';
import { EditorStore } from './editor-store';
import { tour } from './test-builders';

describe('EditorPage', () => {
  let http: HttpTestingController;
  let store: EditorStore;

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [EditorPage],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    http = TestBed.inject(HttpTestingController);
    store = TestBed.inject(EditorStore);
  });

  it('shows the loading state before the session responds', () => {
    const fixture = TestBed.createComponent(EditorPage);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.textContent).toContain('Loading the editor');
    http.expectOne('/api/session').flush({ open: false });
  });

  it('explains an empty session rather than treating it as an error', async () => {
    const fixture = TestBed.createComponent(EditorPage);
    fixture.detectChanges();
    http.expectOne('/api/session').flush({ open: false });
    await fixture.whenStable();
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('[data-error]')).toBeNull();
    expect(el.querySelector('[data-empty]')).toBeTruthy();
    expect(el.querySelector('[data-new-tour]')).toBeTruthy();
  });

  it('loads the open document into the store', async () => {
    const fixture = TestBed.createComponent(EditorPage);
    fixture.detectChanges();
    http.expectOne('/api/session').flush({ open: true, title: 'Old Town Fairfax' });
    await fixture.whenStable();
    fixture.detectChanges();
    http.expectOne('tour-data/tour.json').flush(tour());
    await fixture.whenStable();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(store.draft()?.title).toBe('T');
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('[data-shell]')).toBeTruthy();
    expect(el.querySelector('[data-empty]')).toBeNull();
  });

  it('starting a new tour opens it for editing', async () => {
    const fixture = TestBed.createComponent(EditorPage);
    fixture.detectChanges();
    http.expectOne('/api/session').flush({ open: false });
    await fixture.whenStable();
    fixture.detectChanges();

    const button = fixture.nativeElement.querySelector('[data-new-tour]') as HTMLButtonElement;
    button.click();
    http.expectOne('/api/session/new').flush({ open: true, title: 'Untitled tour' });
    await fixture.whenStable();
    http.expectOne('tour-data/tour.json').flush(tour());
    await fixture.whenStable();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(store.draft()?.title).toBe('T');
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('[data-shell]')).toBeTruthy();
  });

  it('names the new tour with what the author typed', async () => {
    const fixture = TestBed.createComponent(EditorPage);
    fixture.detectChanges();
    http.expectOne('/api/session').flush({ open: false });
    await fixture.whenStable();
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const input = el.querySelector('[data-new-title]') as HTMLInputElement;
    input.value = '  Courthouse Square  ';
    input.dispatchEvent(new Event('input'));
    (el.querySelector('[data-new-tour]') as HTMLButtonElement).click();
    const req = http.expectOne('/api/session/new');
    expect(req.request.body).toEqual({ title: 'Courthouse Square' });
    req.flush({ open: true, title: 'Courthouse Square' });
    await fixture.whenStable();
    http.expectOne('tour-data/tour.json').flush(tour());
    await fixture.whenStable();
  });

  it('edits the title and description in the header, and links export and publish', async () => {
    const fixture = TestBed.createComponent(EditorPage);
    fixture.detectChanges();
    http.expectOne('/api/session').flush({ open: true, title: 'T' });
    await fixture.whenStable();
    http.expectOne('tour-data/tour.json').flush(tour());
    await fixture.whenStable();
    await fixture.whenStable();
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const title = el.querySelector('[data-tour-title]') as HTMLInputElement;
    title.value = 'Second Tour';
    title.dispatchEvent(new Event('input'));
    const desc = el.querySelector('[data-tour-description]') as HTMLInputElement;
    desc.value = 'A walk';
    desc.dispatchEvent(new Event('input'));
    expect(store.draft()?.title).toBe('Second Tour');
    expect(store.draft()?.description).toBe('A walk');
    expect(el.querySelector('[data-export]')?.getAttribute('href')).toBe('/api/session/export');
    expect(el.querySelector('[data-publish]')?.getAttribute('href')).toBe('/api/session/publish');
  });

  it('shows an actionable message when the backend is unreachable', async () => {
    const fixture = TestBed.createComponent(EditorPage);
    fixture.detectChanges();
    http.expectOne('/api/session').error(new ProgressEvent('network'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await fixture.whenStable();
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('[data-error]')?.textContent).toContain('backend');
  });
});
