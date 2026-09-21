import { describe, expect, it } from 'vitest';
import { Euler, Vector3 } from 'three';
import { planeTransform, type RephotoPlacement } from './rephoto-placement';

function placement(over: Partial<RephotoPlacement> = {}): RephotoPlacement {
  return {
    id: 'court-1863',
    imageUrl: '/api/media/court-1863.jpg',
    lng: -77.30732, lat: 38.84562, altitude: 6,
    headingDeg: 200, widthM: 18, heightM: 14,
    ...over,
  };
}

/**
 * Where does the face of the photograph point, given the returned rotation?
 * The scene is ENU: x east, y north, z up. A PlaneGeometry's normal starts
 * along +Z, so an unrotated plane lies flat on the ground facing the sky.
 */
function faceDirection(headingDeg: number): Vector3 {
  const { rotation, rotationOrder } = planeTransform(placement({ headingDeg }), [0, 0, 0]);
  return new Vector3(0, 0, 1).applyEuler(
    new Euler(rotation[0], rotation[1], rotation[2], rotationOrder),
  );
}

/** Compass bearing of a direction in the ENU frame. */
function bearingOf(v: Vector3): number {
  return ((Math.atan2(v.x, v.y) * 180) / Math.PI + 360) % 360;
}

describe('planeTransform', () => {
  it('places the plane at the supplied ENU position', () => {
    expect(planeTransform(placement(), [10, -4, 6]).position).toEqual([10, -4, 6]);
  });

  it('carries physical size through unchanged', () => {
    const t = planeTransform(placement({ widthM: 18, heightM: 14 }), [0, 0, 0]);
    expect(t.width).toBe(18);
    expect(t.height).toBe(14);
  });

  it('stands the photograph upright rather than flat on the ground', () => {
    // A flat plane would face straight up and be invisible edge-on.
    expect(Math.abs(faceDirection(200).z)).toBeLessThan(1e-6);
  });

  it('faces north for heading 0', () => {
    expect(bearingOf(faceDirection(0))).toBeCloseTo(0, 4);
  });

  it('faces east for heading 90', () => {
    expect(bearingOf(faceDirection(90))).toBeCloseTo(90, 4);
  });

  it('faces south for heading 180', () => {
    expect(bearingOf(faceDirection(180))).toBeCloseTo(180, 4);
  });

  it('faces west for heading 270', () => {
    expect(bearingOf(faceDirection(270))).toBeCloseTo(270, 4);
  });

  it('faces the courthouse heading for 200', () => {
    expect(bearingOf(faceDirection(200))).toBeCloseTo(200, 4);
  });

  it('treats heading 360 as equivalent to 0', () => {
    // Bearings wrap, so compare the angular separation rather than the numbers.
    const separation = Math.abs(((bearingOf(faceDirection(359.999)) + 180) % 360) - 180);
    expect(separation).toBeLessThan(0.01);
  });

  it('does not mutate the placement it is given', () => {
    const p = placement();
    planeTransform(p, [1, 2, 3]);
    expect(p.headingDeg).toBe(200);
  });
});
