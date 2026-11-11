import { describe, expect, it } from 'vitest';
import { bearingBetween, distanceBetween } from '../core/geo';
import {
  FLAT_WEDGE_FOV_DEG, SPHERICAL_WEDGE_FOV_DEG,
  footprintCorners, headingFromHandle, rotationHandleAt, viewWedge, wedgeFor,
} from './footprint';
import type { ImageryReport } from '../panorama/panorama-viewer';

const A = { lng: -77.3065, lat: 38.8456 };
const M = 111_320;
const mLat = (a: { lat: number }, b: { lat: number }) => (b.lat - a.lat) * M;
const mLng = (a: { lng: number; lat: number }, b: { lng: number }) =>
  (b.lng - a.lng) * M * Math.cos((a.lat * Math.PI) / 180);

describe('footprintCorners', () => {
  it('for a north-facing plane runs west-east with exact offsets', () => {
    const [a, b] = footprintCorners(A, 0, 10);
    expect(mLat(A, a)).toBeCloseTo(0, 6);
    expect(mLat(A, b)).toBeCloseTo(0, 6);
    // Facing north (0), the extent lies across: ends are west (-5 m) and east (+5 m).
    expect(mLng(A, a)).toBeCloseTo(-5, 6);
    expect(mLng(A, b)).toBeCloseTo(5, 6);
  });

  it.each([
    [0, [-5, 0], [5, 0]],
    [90, [0, 5], [0, -5]],
    [180, [5, 0], [-5, 0]],
    [270, [0, -5], [0, 5]],
  ])('heading %d puts the ends at (E,N) %j and %j', (h, ea, eb) => {
    const [a, b] = footprintCorners(A, h, 10);
    expect(mLng(A, a)).toBeCloseTo(ea[0], 4);
    expect(mLat(A, a)).toBeCloseTo(ea[1], 4);
    expect(mLng(A, b)).toBeCloseTo(eb[0], 4);
    expect(mLat(A, b)).toBeCloseTo(eb[1], 4);
  });

  it.each([0, 17, 45, 90, 138, 178, 225, 301])(
    'is perpendicular to heading %d and centred on the anchor', (h) => {
      const [a, b] = footprintCorners(A, h, 8);
      const along = bearingBetween(a, b);
      const diff = Math.abs((((along - h) % 360) + 540) % 360 - 180);
      expect(Math.abs(diff - 90)).toBeLessThan(0.05);
      const mid = { lng: (a.lng + b.lng) / 2, lat: (a.lat + b.lat) / 2 };
      expect(distanceBetween(mid, A)).toBeLessThan(1e-3);
    });

  it('scales with widthM', () => {
    const len = (w: number) => {
      const [a, b] = footprintCorners(A, 33, w);
      return distanceBetween(a, b);
    };
    expect(len(4)).toBeCloseTo(4, 1);
    expect(len(12)).toBeCloseTo(12, 1);
    expect(len(12) / len(4)).toBeCloseTo(3, 3);
  });

  it('does not mutate the anchor', () => {
    const anchor = { ...A };
    footprintCorners(anchor, 10, 5);
    expect(anchor).toEqual(A);
  });

  it('keeps true metres at 60 degrees north, where a degree of longitude is half as long', () => {
    const hi = { lng: 10, lat: 60 };
    const [a, b] = footprintCorners(hi, 0, 10);
    // 111,320 m/deg (nudge.ts) vs the haversine sphere differ by ~0.1%.
    expect(distanceBetween(a, b)).toBeCloseTo(10, 1);
  });

  it('wraps longitude across the antimeridian rather than leaving [-180, 180]', () => {
    const edge = { lng: 179.99999, lat: 10 };
    const [, b] = footprintCorners(edge, 0, 100);
    expect(b.lng).toBeGreaterThanOrEqual(-180);
    expect(b.lng).toBeLessThan(-179);
    expect(distanceBetween(edge, b)).toBeCloseTo(50, 0);
    const west = { lng: -179.99999, lat: 10 };
    const [a] = footprintCorners(west, 0, 100);
    expect(a.lng).toBeGreaterThan(179);
    expect(a.lng).toBeLessThanOrEqual(180);
  });
});

describe('rotationHandleAt', () => {
  it.each([[0, [0, 6]], [90, [6, 0]], [180, [0, -6]], [270, [-6, 0]]])(
    'heading %d puts the handle 6 m in front of the face at (E,N) %j', (h, e) => {
      const p = rotationHandleAt(A, h, 6);
      expect(mLng(A, p)).toBeCloseTo(e[0], 4);
      expect(mLat(A, p)).toBeCloseTo(e[1], 4);
    });

  it('lies on the face normal, so it is perpendicular to the footprint', () => {
    const h = 71;
    const [a, b] = footprintCorners(A, h, 9);
    const p = rotationHandleAt(A, h, 5);
    expect(Math.abs(bearingBetween(A, p) - h)).toBeLessThan(0.05);
    const across = bearingBetween(a, b);
    const diff = Math.abs((((across - bearingBetween(A, p)) % 360) + 540) % 360 - 180);
    expect(Math.abs(diff - 90)).toBeLessThan(0.1);
  });
});

describe('headingFromHandle', () => {
  it.each([0, 1, 90, 138, 178, 270, 359])('inverts rotationHandleAt at %d', (h) => {
    const back = headingFromHandle(A, rotationHandleAt(A, h, 7));
    const diff = Math.abs((((back - h) % 360) + 540) % 360 - 180);
    expect(diff).toBeLessThan(0.01);
  });

  it('is always in [0, 360)', () => {
    const v = headingFromHandle(A, { lng: A.lng - 0.0001, lat: A.lat - 1e-9 });
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThan(360);
  });
});

describe('viewWedge', () => {
  it('starts at the camera and spans the field of view', () => {
    const w = viewWedge(A, 90, 90, 20);
    expect(w[0]).toEqual(A);
    const first = bearingBetween(A, w[1]);
    const last = bearingBetween(A, w[w.length - 1]);
    expect(first).toBeCloseTo(45, 1);
    expect(last).toBeCloseTo(135, 1);
    expect(distanceBetween(A, w[1])).toBeCloseTo(20, 1);
  });
});

/**
 * Which wedge, if any, the edit map should draw. The wedge says where the
 * camera looked; it is not a claim about what is visible, and it is on the
 * authoring map only — the visitor never sees it.
 */
describe('wedgeFor', () => {
  const PANORAMA = { imageId: 'img-1', bearing: 113 };
  const report = (over: Partial<ImageryReport> = {}): ImageryReport =>
    ({ imageId: 'img-1', cameraType: 'spherical', compassAngle: 90, ...over });

  it('spherical: the full wedge from the STORED bearing, as today', () => {
    expect(wedgeFor(PANORAMA, report())).toEqual({ bearingDeg: 113, fovDeg: SPHERICAL_WEDGE_FOV_DEG });
    expect(SPHERICAL_WEDGE_FOV_DEG).toBe(90);
  });

  it('flat with a known angle: the REPORTED angle, and narrower', () => {
    // Krumlov 514486621381530 reports 190; 953230175442807 reports 293.97.
    expect(wedgeFor(PANORAMA, report({ cameraType: 'perspective', compassAngle: 190 })))
      .toEqual({ bearingDeg: 190, fovDeg: FLAT_WEDGE_FOV_DEG });
    expect(wedgeFor(PANORAMA, report({ cameraType: 'fisheye', compassAngle: 293.97 })))
      .toEqual({ bearingDeg: 293.97, fovDeg: FLAT_WEDGE_FOV_DEG });
    expect(FLAT_WEDGE_FOV_DEG).toBeLessThan(SPHERICAL_WEDGE_FOV_DEG);
  });

  it('flat with a known angle ignores the stored bearing entirely', () => {
    // The stored number is a fact about the camera, not a direction the
    // author chose, and for these stops the viewer never reads it.
    const w = wedgeFor({ imageId: 'img-1', bearing: 0 },
      report({ cameraType: 'perspective', compassAngle: 190 }));
    expect(w!.bearingDeg).toBe(190);
  });

  it('flat with an unknown angle: no wedge at all', () => {
    // Krumlov 304177654440052 reports -1. Drawing 359 degrees here would be a
    // confident 90-degree wedge pointing within a degree of north, on nothing.
    expect(wedgeFor(PANORAMA, report({ cameraType: 'perspective', compassAngle: -1 }))).toBeNull();
    expect(wedgeFor(PANORAMA, report({ cameraType: 'perspective', compassAngle: null }))).toBeNull();
    expect(wedgeFor(PANORAMA, report({ cameraType: 'fisheye', compassAngle: -1 }))).toBeNull();
  });

  it('nothing reported yet: no wedge', () => {
    // A document opened fresh draws none until its panorama loads. That is
    // correct: the alternative is a wedge from a number that may mean nothing.
    expect(wedgeFor(PANORAMA, null)).toBeNull();
  });

  it("a report for ANOTHER image is not this stop's camera", () => {
    expect(wedgeFor(PANORAMA, report({ imageId: 'img-other' }))).toBeNull();
    expect(wedgeFor(PANORAMA, report({ imageId: 'img-other', cameraType: 'perspective', compassAngle: 190 })))
      .toBeNull();
  });

  it('an unknown or absent camera type behaves as spherical', () => {
    // cameraType is undefined if SfM has not been run, and Mapillary may add
    // a projection. Either way, today's behaviour is preserved.
    expect(wedgeFor(PANORAMA, report({ cameraType: undefined })))
      .toEqual({ bearingDeg: 113, fovDeg: SPHERICAL_WEDGE_FOV_DEG });
    expect(wedgeFor(PANORAMA, report({ cameraType: 'equirectangular' })))
      .toEqual({ bearingDeg: 113, fovDeg: SPHERICAL_WEDGE_FOV_DEG });
  });
});
