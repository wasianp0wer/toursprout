import { describe, expect, it } from 'vitest';
import { centerForBearing, isFlatCamera } from './view-turn';

describe('isFlatCamera', () => {
  it('is true only for the projections that are positively not spherical', () => {
    expect(isFlatCamera('perspective')).toBe(true);
    expect(isFlatCamera('fisheye')).toBe(true);
    expect(isFlatCamera('spherical')).toBe(false);
  });

  it('treats an unknown camera type as spherical, which is today\'s behaviour', () => {
    // mapillary-js documents cameraType as undefined when SfM has not run.
    // Only a positive statement from Mapillary may change what we do, so
    // every image that works today goes on working.
    expect(isFlatCamera(undefined)).toBe(false);
    expect(isFlatCamera(null)).toBe(false);
    expect(isFlatCamera('equirectangular')).toBe(false);
  });
});

describe('centerForBearing', () => {
  it('shifts a spherical image by the signed difference over 360', () => {
    expect(centerForBearing('spherical', 100, [0.5, 0.4], 190)).toEqual([0.75, 0.4]);
  });

  it('takes the short way round at the wrap, and keeps x inside [0,1)', () => {
    // 350 to 10 degrees is +20, not -340.
    expect(centerForBearing('spherical', 350, [0.5, 0.4], 10)![0]).toBeCloseTo(0.5 + 20 / 360, 12);
    // Past the right edge, and back round past the left one.
    expect(centerForBearing('spherical', 10, [0.98, 0.4], 100)![0]).toBeCloseTo(0.98 + 0.25 - 1, 12);
    expect(centerForBearing('spherical', 100, [0.02, 0.4], 10)![0]).toBeCloseTo(0.02 - 0.25 + 1, 12);
  });

  it('leaves the y coordinate alone', () => {
    expect(centerForBearing('spherical', 0, [0.5, 0.37], 90)![1]).toBe(0.37);
  });

  it('refuses to turn a perspective or fisheye image', () => {
    // On a perspective image x spans the camera's 70-90 degree field of view,
    // not the full circle, so the same shift over-rotates by a factor of four
    // or five and most bearings are not reachable at all.
    expect(centerForBearing('perspective', 100, [0.5, 0.4], 190)).toBeNull();
    expect(centerForBearing('fisheye', 100, [0.5, 0.4], 190)).toBeNull();
  });

  it('turns when the camera type is unknown', () => {
    expect(centerForBearing(undefined, 100, [0.5, 0.4], 190)).toEqual([0.75, 0.4]);
  });
});
