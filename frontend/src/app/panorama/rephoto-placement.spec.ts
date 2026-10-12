import { describe, expect, it } from 'vitest';
import { Euler, Vector3 } from 'three';
import {
  geodeticAltitude,
  planeTransform,
  rephotoMaterialOptions,
  type InWorldPlacement,
} from './rephoto-placement';

function placement(over: Partial<InWorldPlacement> = {}): InWorldPlacement {
  return {
    id: 'court-1863',
    imageUrl: '/api/media/court-1863.jpg',
    lng: -77.30732, lat: 38.84562, altitudeM: 6,
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

describe('geodeticAltitude', () => {
  // The viewer reference at Fairfax sits ~136.6 m above the ellipsoid.
  const FAIRFAX_GROUND = 136.60236361623;

  it('treats the anchor altitude as height above the ground', () => {
    expect(geodeticAltitude(8, FAIRFAX_GROUND)).toBeCloseTo(144.6, 1);
  });

  it('puts a ground-level anchor at the reference height, not at sea level', () => {
    expect(geodeticAltitude(0, FAIRFAX_GROUND)).toBeCloseTo(FAIRFAX_GROUND, 6);
  });

  it('never buries the photograph below the reference ground', () => {
    // The original bug: passing the raw anchor altitude put the plane
    // 128 m underground, because geodeticToEnu wants absolute altitude.
    expect(geodeticAltitude(8, FAIRFAX_GROUND) - FAIRFAX_GROUND).toBeGreaterThan(0);
  });

  it('scales with the anchor altitude', () => {
    const low = geodeticAltitude(2, FAIRFAX_GROUND);
    const high = geodeticAltitude(20, FAIRFAX_GROUND);
    expect(high - low).toBeCloseTo(18, 6);
  });
});

describe('rephotoMaterialOptions', () => {
  it('renders both sides so a grazing angle does not cull the photograph', () => {
    // DoubleSide is 2 in three.js. FrontSide (0) makes the plane vanish as
    // soon as the viewer is behind its normal.
    expect(rephotoMaterialOptions(0.7).side).toBe(2);
  });

  it('carries the requested opacity', () => {
    expect(rephotoMaterialOptions(0.42).opacity).toBeCloseTo(0.42, 6);
  });

  it('is transparent so the present view shows through', () => {
    expect(rephotoMaterialOptions(0.7).transparent).toBe(true);
  });

  it('does not write depth, so it cannot occlude the panorama', () => {
    expect(rephotoMaterialOptions(0.7).depthWrite).toBe(false);
  });
});
