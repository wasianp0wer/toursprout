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
});
