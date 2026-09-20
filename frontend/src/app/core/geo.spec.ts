import { describe, expect, it } from 'vitest';
import { bearingBetween, distanceBetween } from './geo';

const FAIRFAX = { lng: -77.30732, lat: 38.84562 };

describe('bearingBetween', () => {
  it('returns 0 due north', () => {
    expect(bearingBetween(FAIRFAX, { lng: FAIRFAX.lng, lat: FAIRFAX.lat + 0.01 })).toBeCloseTo(0, 1);
  });

  it('returns 90 due east', () => {
    expect(bearingBetween(FAIRFAX, { lng: FAIRFAX.lng + 0.01, lat: FAIRFAX.lat })).toBeCloseTo(90, 1);
  });

  it('returns 180 due south', () => {
    expect(bearingBetween(FAIRFAX, { lng: FAIRFAX.lng, lat: FAIRFAX.lat - 0.01 })).toBeCloseTo(180, 1);
  });

  it('returns 270 due west', () => {
    expect(bearingBetween(FAIRFAX, { lng: FAIRFAX.lng - 0.01, lat: FAIRFAX.lat })).toBeCloseTo(270, 1);
  });

  it('always returns a value in [0, 360)', () => {
    const b = bearingBetween(FAIRFAX, { lng: FAIRFAX.lng - 0.01, lat: FAIRFAX.lat - 0.01 });
    expect(b).toBeGreaterThanOrEqual(0);
    expect(b).toBeLessThan(360);
  });

  it('is reversible: the reverse bearing is 180 degrees opposed', () => {
    const to = { lng: -77.30468, lat: 38.84601 };
    const there = bearingBetween(FAIRFAX, to);
    const back = bearingBetween(to, FAIRFAX);
    // Great-circle bearings converge, so over this distance the opposition is
    // 180 to within a fraction of a degree rather than exactly.
    const separation = ((back - there) + 360) % 360;
    expect(separation).toBeCloseTo(180, 1);
  });
});

describe('distanceBetween', () => {
  it('is zero for the same point', () => {
    expect(distanceBetween(FAIRFAX, FAIRFAX)).toBeCloseTo(0, 6);
  });

  it('measures a known short hop', () => {
    // Historic courthouse to the Marr monument: about 14 m apart.
    const marr = { lng: -77.30716, lat: 38.84566 };
    const d = distanceBetween(FAIRFAX, marr);
    expect(d).toBeGreaterThan(8);
    expect(d).toBeLessThan(25);
  });

  it('measures a longer walk down Main Street', () => {
    // Courthouse to the museum: roughly 600 m.
    const museum = { lng: -77.3005, lat: 38.84455 };
    const d = distanceBetween(FAIRFAX, museum);
    expect(d).toBeGreaterThan(500);
    expect(d).toBeLessThan(750);
  });

  it('is symmetric', () => {
    const other = { lng: -77.30468, lat: 38.84601 };
    expect(distanceBetween(FAIRFAX, other)).toBeCloseTo(distanceBetween(other, FAIRFAX), 6);
  });
});
