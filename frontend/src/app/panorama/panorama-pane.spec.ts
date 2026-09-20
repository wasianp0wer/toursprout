import { describe, expect, it, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { PanoramaPane, PANORAMA_VIEWER } from './panorama-pane';
import { FakeViewer } from './fake-viewer';
import { TourStore } from '../core/tour-store';
import type { Tour } from '../core/tour.models';

function tour(): Tour {
  return {
    id: 't', schemaVersion: 1, title: 'T', description: '', attribution: [],
    stops: [1, 2].map((n) => ({
      id: `s${n}`, order: n, title: `Stop ${n}`, summary: '',
      location: { lng: -77.3, lat: 38.84 }, osmRef: null,
      panorama: {
        provider: 'mapillary' as const, imageId: `img-${n}`,
        bearing: 90 * n, cachedPath: null,
      },
      overlays: [{
        id: `ov-${n}`, kind: 'text' as const,
        anchor: { type: 'geo' as const, lng: -77.3 + n * 0.0001, lat: 38.84, altitude: 2 },
        title: 'O', body: 'B', mediaId: null,
        credit: { source: 'S', url: 'U', license: 'L', creator: null },
      }],
    })),
  };
}

describe('PanoramaPane', () => {
  let fake: FakeViewer;
  let store: TourStore;

  beforeEach(() => {
    fake = new FakeViewer();
    TestBed.configureTestingModule({
      imports: [PanoramaPane],
      providers: [{ provide: PANORAMA_VIEWER, useValue: fake }],
    });
    store = TestBed.inject(TourStore);
  });

  async function render() {
    const fixture = TestBed.createComponent(PanoramaPane);
    fixture.detectChanges();
    await fixture.whenStable();
    return fixture;
  }

  it('loads the current stop panorama with its bearing', async () => {
    store.load(tour());
    await render();
    expect(fake.loaded).toEqual([{ imageId: 'img-1', bearing: 90 }]);
  });

  it('attaches to a container element', async () => {
    store.load(tour());
    await render();
    expect(fake.attachedTo).toBeTruthy();
  });

  it('reloads when the stop changes', async () => {
    store.load(tour());
    const fixture = await render();
    store.next();
    fixture.detectChanges();
    await fixture.whenStable();
    expect(fake.loaded.at(-1)).toEqual({ imageId: 'img-2', bearing: 180 });
  });

  it('places a marker for each overlay on the current stop', async () => {
    store.load(tour());
    await render();
    expect(fake.markers.at(-1)?.map((m) => m.id)).toEqual(['ov-1']);
  });

  it('marks the selected overlay as selected', async () => {
    store.load(tour());
    const fixture = await render();
    store.selectOverlay('ov-1');
    fixture.detectChanges();
    await fixture.whenStable();
    expect(fake.markers.at(-1)?.find((m) => m.id === 'ov-1')?.selected).toBe(true);
  });

  it('selects the overlay when its marker is clicked', async () => {
    store.load(tour());
    const fixture = await render();
    fake.emitMarkerClick('ov-1');
    fixture.detectChanges();
    expect(store.selectedOverlay()?.id).toBe('ov-1');
  });

  it('surfaces a message when the panorama cannot be loaded', async () => {
    fake.failNextLoad = true;
    store.load(tour());
    const fixture = await render();
    await new Promise((resolve) => setTimeout(resolve, 0));
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('[data-pano-error]')?.textContent).toContain('imagery');
  });

  it('destroys the viewer when the component is torn down', async () => {
    store.load(tour());
    const fixture = await render();
    fixture.destroy();
    expect(fake.destroyed).toBe(true);
  });
});
