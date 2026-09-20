import { describe, expect, it } from 'vitest';
import { ARRIVAL_RADIUS_M, detectArrival } from './arrival';
import type { Stop } from './tour.models';

function stop(id: string, order: number, lng: number, lat: number): Stop {
  return {
    id, order, title: id, summary: '',
    location: { lng, lat }, osmRef: null,
    panorama: { provider: 'mapillary', imageId: `img-${order}`, bearing: 0, cachedPath: null },
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
});
