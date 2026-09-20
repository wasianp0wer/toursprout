import { describe, expect, it } from 'vitest';
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

/** Wrap a rotation into [-PI, PI] so equivalent orientations compare equal. */
const wrap = (r: number) => Math.atan2(Math.sin(r), Math.cos(r));

describe('planeTransform', () => {
  it('places the plane at the supplied ENU position', () => {
    expect(planeTransform(placement(), [10, -4, 6]).position).toEqual([10, -4, 6]);
  });

  it('carries physical size through unchanged', () => {
    const t = planeTransform(placement({ widthM: 18, heightM: 14 }), [0, 0, 0]);
    expect(t.width).toBe(18);
    expect(t.height).toBe(14);
  });

  it('faces north for heading 0', () => {
    expect(planeTransform(placement({ headingDeg: 0 }), [0, 0, 0]).rotationY).toBeCloseTo(0, 6);
  });

  it('turns a quarter circle for heading 90', () => {
    expect(planeTransform(placement({ headingDeg: 90 }), [0, 0, 0]).rotationY)
      .toBeCloseTo(-Math.PI / 2, 6);
  });

  it('turns a half circle for heading 180', () => {
    expect(Math.abs(planeTransform(placement({ headingDeg: 180 }), [0, 0, 0]).rotationY))
      .toBeCloseTo(Math.PI, 6);
  });

  it('rotates clockwise as heading increases, matching a compass', () => {
    const a = planeTransform(placement({ headingDeg: 10 }), [0, 0, 0]).rotationY;
    const b = planeTransform(placement({ headingDeg: 20 }), [0, 0, 0]).rotationY;
    expect(b).toBeLessThan(a);
  });

  it('treats heading 360 as equivalent to 0', () => {
    const a = wrap(planeTransform(placement({ headingDeg: 0 }), [0, 0, 0]).rotationY);
    const b = wrap(planeTransform(placement({ headingDeg: 359.999 }), [0, 0, 0]).rotationY);
    expect(Math.abs(a - b)).toBeLessThan(0.001);
  });

  it('does not mutate the placement it is given', () => {
    const p = placement();
    planeTransform(p, [1, 2, 3]);
    expect(p.headingDeg).toBe(200);
  });
});
