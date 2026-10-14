import { describe, expect, it, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { routes } from './app.routes';
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

  it("routes '' to the viewer", async () => {
    const harness = await RouterTestingHarness.create('/');
    expect(harness.routeDebugElement?.componentInstance).toBeInstanceOf(ViewerPage);
    http.expectOne('tour-data/config.json').error(new ProgressEvent('network'));
    http.expectOne('tour-data/tour.json').error(new ProgressEvent('network'));
  });

  it("routes 'edit' to the editor", async () => {
    const harness = await RouterTestingHarness.create('/edit');
    expect(harness.routeDebugElement?.componentInstance).toBeInstanceOf(EditorPage);
    http.expectOne('/api/session').flush({ open: false });
  });
});
