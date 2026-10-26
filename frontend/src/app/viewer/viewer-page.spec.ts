import { describe, expect, it, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ViewerPage } from './viewer-page';
import { PANORAMA_VIEWER } from '../panorama/panorama-pane';
import { FakeViewer } from '../panorama/fake-viewer';

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
});
