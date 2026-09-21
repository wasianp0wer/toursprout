import { describe, expect, it, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { PanoramaPane, PANORAMA_VIEWER } from './panorama-pane';
import { FakeViewer } from './fake-viewer';
import { TourStore } from '../core/tour-store';
import type { Overlay, Tour } from '../core/tour.models';

const REPHOTO_OVERLAY: Overlay = {
  id: 'court-1863',
  kind: 'rephoto',
  anchor: {
    type: 'geoQuad',
    lng: -77.3073, lat: 38.8456, altitude: 6,
    headingDeg: 200, widthM: 18, heightM: 14,
  },
  title: 'Fairfax Court House, 1863',
  body: null,
  mediaId: 'court-1863.jpg',
  credit: { source: 'LoC', url: 'U', license: 'PD', creator: null },
};

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
    const overlayMarkers = fake.markers.at(-1)!.filter((m) => m.kind === 'overlay');
    expect(overlayMarkers.map((m) => m.id)).toEqual(['ov-1']);
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

  it('sends rephoto placements to the viewer', async () => {
    const t = tour();
    t.stops[0].overlays = [...t.stops[0].overlays, REPHOTO_OVERLAY];
    store.load(t);
    await render();
    const sent = fake.rephotos.at(-1)!;
    expect(sent).toHaveLength(1);
    expect(sent[0].id).toBe('court-1863');
    expect(sent[0].imageUrl).toBe('/api/media/court-1863.jpg');
    expect(sent[0].headingDeg).toBe(200);
  });

  it('sends no rephotos for a stop that has none', async () => {
    store.load(tour());
    await render();
    expect(fake.rephotos.at(-1)).toEqual([]);
  });

  it('does not send point overlays as rephotos', async () => {
    const t = tour();
    t.stops[0].overlays = [...t.stops[0].overlays, REPHOTO_OVERLAY];
    store.load(t);
    await render();
    expect(fake.rephotos.at(-1)!.map((r) => r.id)).toEqual(['court-1863']);
  });

  it('does not place a marker for a rephoto', async () => {
    const t = tour();
    t.stops[0].overlays = [...t.stops[0].overlays, REPHOTO_OVERLAY];
    store.load(t);
    await render();
    expect(fake.markers.at(-1)!.map((m) => m.id)).not.toContain('court-1863');
  });

  it('feeds viewer movement back into the store', async () => {
    const t = tour();
    t.stops[1].location = { lng: -77.305, lat: 38.8456 };
    store.load(t);
    const fixture = await render();
    fake.emitPositionChange({ lng: -77.305, lat: 38.8456 }, 'img-walked');
    fixture.detectChanges();
    expect(store.currentIndex()).toBe(1);
  });

  it('pushes the bearing to the next stop down to the viewer', async () => {
    const t = tour();
    t.stops[0].location = { lng: -77.31, lat: 38.8456 };
    t.stops[1].location = { lng: -77.31, lat: 38.8466 };
    store.load(t);
    const fixture = await render();
    fake.emitPositionChange({ lng: -77.31, lat: 38.8456 }, 'img-1');
    fixture.detectChanges();
    await fixture.whenStable();
    expect(fake.destinationBearing).toBeCloseTo(0, 0);
  });

  it('includes a destination marker for the next stop', async () => {
    store.load(tour());
    await render();
    expect(fake.markers.at(-1)!.map((m) => m.kind)).toContain('destination');
  });

  it('drops the destination marker on the final stop', async () => {
    store.load(tour());
    const fixture = await render();
    store.goTo(1);
    fixture.detectChanges();
    await fixture.whenStable();
    expect(fake.markers.at(-1)!.every((m) => m.kind === 'overlay')).toBe(true);
  });

  it('pushes opacity to the viewer on first render, not only on change', async () => {
    // If opacity only reached the renderer when the slider moved, every
    // rephoto would start fully transparent and look like a missing image.
    store.load(tour());
    await render();
    expect(fake.opacity).not.toBeNull();
    expect(fake.opacity).toBeGreaterThan(0);
  });

  it('pushes the opacity setting down to the viewer', async () => {
    store.load(tour());
    const fixture = await render();
    store.setRephotoOpacity(0.25);
    fixture.detectChanges();
    await fixture.whenStable();
    expect(fake.opacity).toBeCloseTo(0.25, 3);
  });
});
