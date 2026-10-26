import { describe, expect, it, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { routes } from './app.routes';
import { EntryPage } from './entry/entry-page';
import { ViewerPage } from './viewer/viewer-page';
import { EditorPage } from './editor/editor-page';
import { PANORAMA_VIEWER } from './panorama/panorama-pane';
import { FakeViewer } from './panorama/fake-viewer';

describe('app routing', () => {
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter(routes),
        { provide: PANORAMA_VIEWER, useValue: new FakeViewer() },
      ],
    });
    http = TestBed.inject(HttpTestingController);
  });

  it("routes '' to the entry page", async () => {
    const harness = await RouterTestingHarness.create('/');
    expect(harness.routeDebugElement?.componentInstance).toBeInstanceOf(EntryPage);
    // The entry page mounts the viewer at once and probes for a backend
    // alongside it, so all three requests are in flight from one navigation.
    http.expectOne('tour-data/config.json').error(new ProgressEvent('network'));
    http.expectOne('tour-data/tour.json').error(new ProgressEvent('network'));
    http.expectOne('/api/session').flush({ open: false });
  });

  // '/view' is the viewer on its own, with no probe and no redirect: the
  // editor's Preview link needs somewhere to send an author whose tour is
  // open, which '' would bounce straight back to '/edit'.
  it("routes 'view' to the viewer", async () => {
    const harness = await RouterTestingHarness.create('/view');
    expect(harness.routeDebugElement?.componentInstance).toBeInstanceOf(ViewerPage);
    http.expectOne('tour-data/config.json').error(new ProgressEvent('network'));
    http.expectOne('tour-data/tour.json').error(new ProgressEvent('network'));
  });

  it("routes 'edit' to the editor", async () => {
    const harness = await RouterTestingHarness.create('/edit');
    expect(harness.routeDebugElement?.componentInstance).toBeInstanceOf(EditorPage);
    http.expectOne('/api/session').flush({ open: false });
  });

  // A published site opened as https://host/tour/index.html leaves the router
  // the remainder `index.html`; without a wildcard that renders nothing.
  it.each(['/index.html', '/anything/at/all'])("routes unmatched %s to the viewer", async (url) => {
    const harness = await RouterTestingHarness.create(url);
    expect(harness.routeDebugElement?.componentInstance).toBeInstanceOf(ViewerPage);
    http.expectOne('tour-data/config.json').error(new ProgressEvent('network'));
    http.expectOne('tour-data/tour.json').error(new ProgressEvent('network'));
  });
});
