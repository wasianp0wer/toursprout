import { describe, expect, it } from 'vitest';
import { FakeViewer } from './fake-viewer';
import type { InWorldPlacement } from './rephoto-placement';

const REPHOTO: InWorldPlacement = {
  id: 'court-1863', imageUrl: '/api/media/court-1863.jpg',
  lng: -77.30732, lat: 38.84562, altitudeM: 6,
  headingDeg: 200, widthM: 18, heightM: 14,
};

describe('FakeViewer', () => {
  it('records rephotos', () => {
    const v = new FakeViewer();
    v.setRephotos([REPHOTO]);
    expect(v.rephotos.at(-1)).toEqual([REPHOTO]);
  });

  it('records opacity per photograph', () => {
    const v = new FakeViewer();
    v.setRephotoOpacity({ 'court-1863': 0.4, 'court-1918': 0 });
    expect(v.opacity).toEqual({ 'court-1863': 0.4, 'court-1918': 0 });
  });

  it('records destination bearing including null', () => {
    const v = new FakeViewer();
    v.setDestinationBearing(123);
    expect(v.destinationBearing).toBe(123);
    v.setDestinationBearing(null);
    expect(v.destinationBearing).toBeNull();
  });

  it('emits position changes to the registered handler', () => {
    const v = new FakeViewer();
    const seen: string[] = [];
    v.onPositionChange((_pos, imageId) => seen.push(imageId));
    v.emitPositionChange({ lng: -77.3, lat: 38.8 }, 'img-9');
    expect(seen).toEqual(['img-9']);
  });

  it('does not throw when position changes with no handler registered', () => {
    const v = new FakeViewer();
    expect(() => v.emitPositionChange({ lng: 0, lat: 0 }, 'x')).not.toThrow();
  });
});
