import { describe, expect, it } from 'vitest';
import { ARRIVAL_RADIUS_M, detectArrival } from './arrival';
import type { Stop } from './tour.models';

function stop(id: string, order: number, lng: number, lat: number): Stop {
  return {
    id, order, title: id, summary: '',
    location: { lng, lat }, osmRef: null,
    panorama: { provider: 'mapillary', imageId: `img-${order}`, bearing: 0, cachedMediaId: null },
    overlays: [],
  };
}

// Three stops spaced roughly 200 m apart along a line of latitude.
const STOPS = [
  stop('a', 1, -77.31, 38.8456),
  stop('b', 2, -77.3077, 38.8456),
  stop('c', 3, -77.3054, 38.8456),
];

const away = { lng: -77.3089, lat: 38.8456 }; // between a and b, far from both

describe('detectArrival', () => {
  it('reports no arrival when far from every stop', () => {
    const r = detectArrival({ position: away, stops: STOPS, currentIndex: 0, latched: new Set() });
    expect(r.arrivedIndex).toBeNull();
  });

  it('arrives when inside the radius of the next stop', () => {
    const r = detectArrival({
      position: STOPS[1].location, stops: STOPS, currentIndex: 0, latched: new Set(),
    });
    expect(r.arrivedIndex).toBe(1);
    expect(r.latched.has('b')).toBe(true);
  });

  it('does not re-arrive at a stop that is already latched', () => {
    const r = detectArrival({
      position: STOPS[1].location, stops: STOPS, currentIndex: 1, latched: new Set(['b']),
    });
    expect(r.arrivedIndex).toBeNull();
  });

  it('arrives walking backwards', () => {
    const r = detectArrival({
      position: STOPS[0].location, stops: STOPS, currentIndex: 2, latched: new Set(),
    });
    expect(r.arrivedIndex).toBe(0);
  });

  it('releases the latch once you walk well clear', () => {
    const r = detectArrival({
      position: away, stops: STOPS, currentIndex: 1, latched: new Set(['b']),
    });
    expect(r.arrivedIndex).toBeNull();
    expect(r.latched.has('b')).toBe(false);
  });

  it('keeps the latch while still close but outside the radius', () => {
    // ~35 m east of stop b: past the arrival radius, inside the release radius.
    const near = { lng: STOPS[1].location.lng + 0.0004, lat: STOPS[1].location.lat };
    const r = detectArrival({
      position: near, stops: STOPS, currentIndex: 1, latched: new Set(['b']),
    });
    expect(r.latched.has('b')).toBe(true);
  });

  it('picks the nearest stop when two are in range', () => {
    const nearB = { lng: STOPS[1].location.lng + 0.00005, lat: STOPS[1].location.lat };
    const r = detectArrival({
      position: nearB, stops: STOPS, currentIndex: 0, latched: new Set(),
    });
    expect(r.arrivedIndex).toBe(1);
  });

  it('does not report arrival at the stop you are already on', () => {
    const r = detectArrival({
      position: STOPS[0].location, stops: STOPS, currentIndex: 0, latched: new Set(['a']),
    });
    expect(r.arrivedIndex).toBeNull();
  });

  it('handles an empty stop list', () => {
    const r = detectArrival({ position: away, stops: [], currentIndex: 0, latched: new Set() });
    expect(r.arrivedIndex).toBeNull();
  });

  it('does not mutate the latch set it is given', () => {
    const latched = new Set(['b']);
    detectArrival({ position: away, stops: STOPS, currentIndex: 1, latched });
    expect(latched.has('b')).toBe(true);
  });

  it('uses a 30 metre radius', () => {
    expect(ARRIVAL_RADIUS_M).toBe(30);
  });

  // Real geometry from the tour: the Marr Monument stands on the courthouse
  // lawn, 14.6 m away — well inside the 30 m arrival radius.
  const COURTHOUSE = stop('courthouse', 1, -77.30732, 38.84562);
  const MARR = stop('marr', 2, -77.30716, 38.84566);
  const CLOSE_PAIR = [COURTHOUSE, MARR];

  it('does not arrive at a neighbour that merely shares the radius', () => {
    const r = detectArrival({
      position: COURTHOUSE.location, stops: CLOSE_PAIR, currentIndex: 0, latched: new Set(),
    });
    expect(r.arrivedIndex).toBeNull();
  });

  it('arrives once the neighbour becomes the nearest stop', () => {
    const r = detectArrival({
      position: MARR.location, stops: CLOSE_PAIR, currentIndex: 0, latched: new Set(),
    });
    expect(r.arrivedIndex).toBe(1);
  });

  it('does not arrive from the midpoint back toward the stop behind you', () => {
    const midpoint = {
      lng: (COURTHOUSE.location.lng + MARR.location.lng) / 2,
      lat: (COURTHOUSE.location.lat + MARR.location.lat) / 2,
    };
    const r = detectArrival({
      position: midpoint, stops: CLOSE_PAIR, currentIndex: 1, latched: new Set(),
    });
    // Standing between them, neither is decisively nearer than the current stop.
    expect(r.arrivedIndex).toBeNull();
  });

  // A stop's panorama stands on the road and can be nearer to a neighbour
  // than to its own stop: the courthouse vantage point is 39 m from the
  // courthouse but only 26 m from the Marr Monument. Distance alone can
  // therefore never settle the tour back on the courthouse.
  const COURT = stop('courthouse', 1, -77.30732, 38.84562);
  const MARR_M = stop('marr', 2, -77.30716, 38.84566);
  const PAIR = [COURT, MARR_M];
  const COURT_PANO = { lng: -77.306888, lat: 38.845534 };

  it('arrives at the stop whose panorama you stepped onto', () => {
    const r = detectArrival({
      position: COURT_PANO, imageId: 'img-1', stops: PAIR, currentIndex: 1, latched: new Set(),
    });
    expect(r.arrivedIndex).toBe(0);
  });

  it('returns to the courthouse even though the monument is nearer', () => {
    const r = detectArrival({
      position: COURT_PANO, imageId: 'img-1', stops: PAIR, currentIndex: 1, latched: new Set(['marr']),
    });
    expect(r.arrivedIndex).toBe(0);
  });

  it('does not re-arrive when already on that stop', () => {
    const r = detectArrival({
      position: COURT_PANO, imageId: 'img-1', stops: PAIR, currentIndex: 0, latched: new Set(),
    });
    expect(r.arrivedIndex).toBeNull();
  });

  it('a panorama belonging to no stop still falls back to proximity', () => {
    const r = detectArrival({
      position: MARR_M.location, imageId: 'some-street-image',
      stops: PAIR, currentIndex: 0, latched: new Set(),
    });
    expect(r.arrivedIndex).toBe(1);
  });

  it('identity beats proximity even mid-street', () => {
    // Standing nearer the monument, but on the courthouse's own panorama.
    const r = detectArrival({
      position: MARR_M.location, imageId: 'img-1', stops: PAIR, currentIndex: 1, latched: new Set(),
    });
    expect(r.arrivedIndex).toBe(0);
  });
});
