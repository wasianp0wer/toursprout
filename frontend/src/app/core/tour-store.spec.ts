import { describe, expect, it, beforeEach } from 'vitest';
import { TourStore } from './tour-store';
import type { Stop, Tour } from './tour.models';

function stop(id: string, order: number): Stop {
  return {
    id, order,
    title: `Stop ${order}`,
    summary: 'summary',
    location: { lng: -77.3, lat: 38.84 },
    osmRef: null,
    panorama: { provider: 'mapillary', imageId: `img-${order}`, bearing: 90, cachedPath: null },
    overlays: [{
      id: `ov-${order}`, kind: 'text',
      anchor: { type: 'geo', lng: -77.3, lat: 38.84, altitude: 2 },
      title: 'Overlay', body: 'Body', mediaId: null,
      credit: { source: 'S', url: 'U', license: 'L', creator: null },
    }],
  };
}

function tour(n = 3): Tour {
  return {
    id: 'fairfax-old-town', schemaVersion: 1,
    title: 'Old Town Fairfax', description: 'desc',
    attribution: [],
    stops: Array.from({ length: n }, (_, i) => stop(`s${i + 1}`, i + 1)),
  };
}

describe('TourStore', () => {
  let store: TourStore;
  beforeEach(() => { store = new TourStore(); });

  it('starts empty', () => {
    expect(store.tour()).toBeNull();
    expect(store.currentStop()).toBeNull();
    expect(store.stops()).toEqual([]);
  });

  it('loads a tour and selects the first stop', () => {
    store.load(tour());
    expect(store.currentIndex()).toBe(0);
    expect(store.currentStop()?.id).toBe('s1');
  });

  it('orders stops by their order field regardless of array order', () => {
    const t = tour();
    t.stops = [t.stops[2], t.stops[0], t.stops[1]];
    store.load(t);
    expect(store.stops().map((s) => s.id)).toEqual(['s1', 's2', 's3']);
  });

  it('advances and retreats', () => {
    store.load(tour());
    store.next();
    expect(store.currentStop()?.id).toBe('s2');
    store.previous();
    expect(store.currentStop()?.id).toBe('s1');
  });

  it('does not advance past the last stop', () => {
    store.load(tour());
    store.goTo(2);
    store.next();
    expect(store.currentIndex()).toBe(2);
    expect(store.hasNext()).toBe(false);
  });

  it('does not retreat before the first stop', () => {
    store.load(tour());
    store.previous();
    expect(store.currentIndex()).toBe(0);
    expect(store.hasPrevious()).toBe(false);
  });

  it('ignores out-of-range goTo', () => {
    store.load(tour());
    store.goTo(99);
    expect(store.currentIndex()).toBe(0);
    store.goTo(-1);
    expect(store.currentIndex()).toBe(0);
  });

  it('exposes overlays for the current stop', () => {
    store.load(tour());
    expect(store.overlaysForCurrentStop().map((o) => o.id)).toEqual(['ov-1']);
    store.next();
    expect(store.overlaysForCurrentStop().map((o) => o.id)).toEqual(['ov-2']);
  });

  it('clears the selected overlay when the stop changes', () => {
    store.load(tour());
    store.selectOverlay('ov-1');
    expect(store.selectedOverlay()?.id).toBe('ov-1');
    store.next();
    expect(store.selectedOverlay()).toBeNull();
  });

  it('ignores selection of an overlay that is not on the current stop', () => {
    store.load(tour());
    store.selectOverlay('ov-3');
    expect(store.selectedOverlay()).toBeNull();
  });

  it('resets position when a new tour is loaded', () => {
    store.load(tour());
    store.goTo(2);
    store.load(tour());
    expect(store.currentIndex()).toBe(0);
  });

  it('reports hasNext correctly in the middle of a tour', () => {
    store.load(tour());
    store.goTo(1);
    expect(store.hasNext()).toBe(true);
    expect(store.hasPrevious()).toBe(true);
  });

  it('starts with no viewer position', () => {
    store.load(tour());
    expect(store.viewerPosition()).toBeNull();
  });

  it('records viewer position as you move', () => {
    store.load(tour());
    store.updateViewerPosition({ lng: -77.31, lat: 38.8456 });
    expect(store.viewerPosition()).toEqual({ lng: -77.31, lat: 38.8456 });
  });

  it('exposes the next stop while walking', () => {
    store.load(tour());
    expect(store.nextStop()?.id).toBe('s2');
    store.goTo(2);
    expect(store.nextStop()).toBeNull();
  });

  it('exposes a bearing toward the next stop once position is known', () => {
    const t = tour();
    t.stops[0].location = { lng: -77.31, lat: 38.8456 };
    t.stops[1].location = { lng: -77.31, lat: 38.8466 };
    store.load(t);
    expect(store.bearingToNextStop()).toBeNull();
    store.updateViewerPosition({ lng: -77.31, lat: 38.8456 });
    expect(store.bearingToNextStop()!).toBeCloseTo(0, 0);
  });

  it('advances when the viewer walks into the next stop', () => {
    const t = tour();
    t.stops[1].location = { lng: -77.305, lat: 38.8456 };
    store.load(t);
    store.updateViewerPosition({ lng: -77.305, lat: 38.8456 });
    expect(store.currentIndex()).toBe(1);
  });

  it('does not advance for a position far from any stop', () => {
    store.load(tour());
    store.updateViewerPosition({ lng: -70, lat: 30 });
    expect(store.currentIndex()).toBe(0);
  });

  it('does not re-advance while lingering at the same stop', () => {
    const t = tour();
    t.stops[1].location = { lng: -77.305, lat: 38.8456 };
    store.load(t);
    store.updateViewerPosition({ lng: -77.305, lat: 38.8456 });
    store.updateViewerPosition({ lng: -77.305, lat: 38.8456 });
    expect(store.currentIndex()).toBe(1);
  });

  it('clears the selected overlay on arrival', () => {
    const t = tour();
    t.stops[1].location = { lng: -77.305, lat: 38.8456 };
    store.load(t);
    store.selectOverlay('ov-1');
    store.updateViewerPosition({ lng: -77.305, lat: 38.8456 });
    expect(store.selectedOverlay()).toBeNull();
  });

  it('walking backwards moves the tour back', () => {
    const t = tour();
    t.stops[0].location = { lng: -77.31, lat: 38.8456 };
    t.stops[1].location = { lng: -77.305, lat: 38.8456 };
    store.load(t);
    store.goTo(1);
    store.updateViewerPosition({ lng: -77.31, lat: 38.8456 });
    expect(store.currentIndex()).toBe(0);
  });

  it('a deliberate skip does not immediately re-arrive at itself', () => {
    const t = tour();
    t.stops[1].location = { lng: -77.305, lat: 38.8456 };
    store.load(t);
    store.goTo(1);
    store.updateViewerPosition({ lng: -77.305, lat: 38.8456 });
    expect(store.currentIndex()).toBe(1);
  });

  it('forgets viewer position and latches when a new tour loads', () => {
    const t = tour();
    t.stops[1].location = { lng: -77.305, lat: 38.8456 };
    store.load(t);
    store.updateViewerPosition({ lng: -77.305, lat: 38.8456 });
    store.load(tour());
    expect(store.viewerPosition()).toBeNull();
    expect(store.currentIndex()).toBe(0);
  });

  it('defaults rephoto opacity to a visible ghost', () => {
    expect(store.rephotoOpacity()).toBeCloseTo(0.7, 3);
  });

  it('clamps rephoto opacity into range', () => {
    store.setRephotoOpacity(5);
    expect(store.rephotoOpacity()).toBe(1);
    store.setRephotoOpacity(-3);
    expect(store.rephotoOpacity()).toBe(0);
  });

  it('knows whether the current stop has a rephoto', () => {
    store.load(tour());
    expect(store.hasRephotos()).toBe(false);
  });

  it('does not arrive elsewhere while standing at the current stop\'s own panorama', () => {
    // A stop's panorama sits on the road, not at the stop, and can be nearer
    // to a neighbour than to its own stop. Loading stop 1 must not teleport
    // the tour to stop 2.
    const t = tour();
    t.stops[0].location = { lng: -77.30732, lat: 38.84562 };
    t.stops[1].location = { lng: -77.30716, lat: 38.84566 };
    store.load(t);
    store.updateViewerPosition({ lng: -77.30716, lat: 38.84566 }, 'img-1');
    expect(store.currentIndex()).toBe(0);
  });

  it('still arrives once you walk to a different image', () => {
    const t = tour();
    t.stops[0].location = { lng: -77.31, lat: 38.8456 };
    t.stops[1].location = { lng: -77.305, lat: 38.8456 };
    store.load(t);
    store.updateViewerPosition({ lng: -77.305, lat: 38.8456 }, 'some-other-image');
    expect(store.currentIndex()).toBe(1);
  });

  it('records position even when arrival is suppressed', () => {
    const t = tour();
    store.load(t);
    store.updateViewerPosition({ lng: -77.3, lat: 38.84 }, 'img-1');
    expect(store.viewerPosition()).toEqual({ lng: -77.3, lat: 38.84 });
  });
});
