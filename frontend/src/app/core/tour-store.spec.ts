import { describe, expect, it, beforeEach } from 'vitest';
import { TourStore } from './tour-store';
import type { Overlay, Stop, Tour } from './tour.models';

function stop(id: string, order: number): Stop {
  return {
    id, order,
    title: `Stop ${order}`,
    summary: 'summary',
    location: { lng: -77.3, lat: 38.84 },
    osmRef: null,
    panorama: { provider: 'mapillary', imageId: `img-${order}`, bearing: 90, cachedMediaId: null },
    overlays: [{
      id: `ov-${order}`, kind: 'text',
      anchor: { type: 'geo', lng: -77.3, lat: 38.84, altitudeM: 2 },
      display: { mode: 'marker', icon: 'note' },
      title: 'Overlay', body: 'Body', mediaId: null,
      credit: { type: 'sourced', source: 'S', url: 'U', license: 'L', creator: null },
    }],
  };
}

function tour(n = 3): Tour {
  return {
    id: 'fairfax-old-town', schemaVersion: 3,
    title: 'Old Town Fairfax', description: 'desc',
    defaults: null,
    attribution: [],
    stops: Array.from({ length: n }, (_, i) => stop(`s${i + 1}`, i + 1)),
  };
}

function inWorldOverlay(id: string, opacity: number): Overlay {
  return {
    id, kind: 'image',
    anchor: { type: 'geo', lng: -77.3, lat: 38.84, altitudeM: 4 },
    display: { mode: 'inWorld', opacity, headingDeg: 284.4, widthM: 18, heightM: 12 },
    title: 'Photo', body: null, mediaId: `${id}.jpg`,
    credit: { type: 'sourced', source: 'S', url: 'U', license: 'L', creator: null },
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

  it('treats any inWorld overlay as draped, whatever its kind', () => {
    const t = tour(1);
    t.stops[0].overlays.push(inWorldOverlay('p1', 0.7));
    store.load(t);
    expect(store.inWorldOverlays().map((o) => o.id)).toEqual(['p1']);
    expect(store.hasInWorldOverlays()).toBe(true);
  });

  it('seeds opacity from the document, not from a hardcoded rule', () => {
    const t = tour(1);
    t.stops[0].overlays.push(inWorldOverlay('p1', 0.4), inWorldOverlay('p2', 0.9));
    store.load(t);
    expect(store.opacityFor('p1')).toBe(0.4);
    expect(store.opacityFor('p2')).toBe(0.9);
  });

  it('survives a stop with no overlays', () => {
    const t = tour(1);
    t.stops[0].overlays = [];
    store.load(t);
    expect(store.inWorldOverlays()).toEqual([]);
    expect(store.hasInWorldOverlays()).toBe(false);
    expect(store.opacityFor('nope')).toBe(0);
  });

  it('does not treat a marker image as draped', () => {
    const t = tour(1);
    t.stops[0].overlays.push({
      ...inWorldOverlay('p1', 0.7),
      display: { mode: 'marker', icon: 'photo' },
    });
    store.load(t);
    expect(store.inWorldOverlays()).toEqual([]);
  });

  function tourWithInWorld(...entries: [string, number][]) {
    const t = tour();
    t.stops[0].overlays = [
      ...t.stops[0].overlays,
      ...entries.map(([id, opacity]) => inWorldOverlay(id, opacity)),
    ];
    return t;
  }

  it('gives each photograph an independent opacity', () => {
    store.load(tourWithInWorld(['a', 0.7], ['b', 0]));
    store.setOverlayOpacity('b', 0.4);
    expect(store.opacityFor('a')).toBeCloseTo(0.7, 3);
    expect(store.opacityFor('b')).toBeCloseTo(0.4, 3);
  });

  it('lets one photograph be hidden without affecting the other', () => {
    store.load(tourWithInWorld(['a', 0.7], ['b', 0]));
    store.setOverlayOpacity('b', 0.9);
    store.setOverlayOpacity('a', 0);
    expect(store.opacityFor('a')).toBe(0);
    expect(store.opacityFor('b')).toBeCloseTo(0.9, 3);
  });

  it('clamps each opacity into range', () => {
    store.load(tourWithInWorld(['a', 0.5]));
    store.setOverlayOpacity('a', 5);
    expect(store.opacityFor('a')).toBe(1);
    store.setOverlayOpacity('a', -3);
    expect(store.opacityFor('a')).toBe(0);
  });

  it('reports zero for a photograph that is not on this stop', () => {
    store.load(tourWithInWorld(['a', 0.5]));
    expect(store.opacityFor('nope')).toBe(0);
  });

  it('exposes the whole opacity map for the renderer', () => {
    store.load(tourWithInWorld(['a', 0.7], ['b', 0]));
    expect(store.overlayOpacities()).toEqual({ a: 0.7, b: 0 });
  });

  it('resets opacities when the stop changes', () => {
    const t = tourWithInWorld(['a', 0.7], ['b', 0]);
    store.load(t);
    store.setOverlayOpacity('b', 1);
    store.goTo(1);
    store.goTo(0);
    expect(store.opacityFor('a')).toBeCloseTo(0.7, 3);
    expect(store.opacityFor('b')).toBe(0);
  });

  it('knows whether the current stop has an inWorld overlay', () => {
    store.load(tour());
    expect(store.hasInWorldOverlays()).toBe(false);
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
