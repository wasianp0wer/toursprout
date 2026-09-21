import { describe, expect, it } from 'vitest';
import {
  alignModeEnabled,
  alignTarget,
  nudgeAnchor,
  STEP_DEG,
  type GeoQuadAnchorLike,
} from './align-mode';
import type { Overlay } from '../core/tour.models';

const BASE: GeoQuadAnchorLike = {
  lng: -77.30732, lat: 38.84562, altitude: 6,
  headingDeg: 200, widthM: 18, heightM: 14,
};

describe('nudgeAnchor', () => {
  it('ArrowUp moves the photograph north', () => {
    expect(nudgeAnchor(BASE, 'ArrowUp').lat).toBeGreaterThan(BASE.lat);
  });

  it('ArrowDown moves it south', () => {
    expect(nudgeAnchor(BASE, 'ArrowDown').lat).toBeLessThan(BASE.lat);
  });

  it('ArrowRight moves it east', () => {
    expect(nudgeAnchor(BASE, 'ArrowRight').lng).toBeGreaterThan(BASE.lng);
  });

  it('ArrowLeft moves it west', () => {
    expect(nudgeAnchor(BASE, 'ArrowLeft').lng).toBeLessThan(BASE.lng);
  });

  it('PageUp raises it and PageDown lowers it', () => {
    expect(nudgeAnchor(BASE, 'PageUp').altitude).toBeGreaterThan(BASE.altitude);
    expect(nudgeAnchor(BASE, 'PageDown').altitude).toBeLessThan(BASE.altitude);
  });

  it('z raises and c lowers, for keyboards without page keys', () => {
    expect(nudgeAnchor(BASE, 'z').altitude).toBeGreaterThan(BASE.altitude);
    expect(nudgeAnchor(BASE, 'c').altitude).toBeLessThan(BASE.altitude);
  });

  it('z and c move by the same step as the page keys', () => {
    expect(nudgeAnchor(BASE, 'z').altitude).toBeCloseTo(
      nudgeAnchor(BASE, 'PageUp').altitude, 6);
    expect(nudgeAnchor(BASE, 'c').altitude).toBeCloseTo(
      nudgeAnchor(BASE, 'PageDown').altitude, 6);
  });

  it('accepts Z and C with shift or caps lock held', () => {
    expect(nudgeAnchor(BASE, 'Z').altitude).toBeGreaterThan(BASE.altitude);
    expect(nudgeAnchor(BASE, 'C').altitude).toBeLessThan(BASE.altitude);
  });

  it('+ grows and - shrinks, preserving aspect ratio', () => {
    const bigger = nudgeAnchor(BASE, '+');
    expect(bigger.widthM).toBeGreaterThan(BASE.widthM);
    expect(bigger.widthM / bigger.heightM).toBeCloseTo(BASE.widthM / BASE.heightM, 6);
    expect(nudgeAnchor(BASE, '-').widthM).toBeLessThan(BASE.widthM);
  });

  it('never shrinks below a visible size', () => {
    let a = { ...BASE, widthM: 1, heightM: 1 };
    for (let i = 0; i < 20; i++) a = nudgeAnchor(a, '-');
    expect(a.widthM).toBeGreaterThan(0);
  });

  it('[ and ] rotate by the heading step', () => {
    expect(nudgeAnchor(BASE, ']').headingDeg).toBeCloseTo(BASE.headingDeg + STEP_DEG, 6);
    expect(nudgeAnchor(BASE, '[').headingDeg).toBeCloseTo(BASE.headingDeg - STEP_DEG, 6);
  });

  it('wraps heading into [0, 360)', () => {
    expect(nudgeAnchor({ ...BASE, headingDeg: 359 }, ']').headingDeg).toBeLessThan(360);
    expect(nudgeAnchor({ ...BASE, headingDeg: 1 }, '[').headingDeg).toBeGreaterThanOrEqual(0);
  });

  it('ignores keys it does not handle', () => {
    expect(nudgeAnchor(BASE, 'q')).toEqual(BASE);
  });

  it('does not mutate the anchor it is given', () => {
    nudgeAnchor(BASE, 'ArrowUp');
    expect(BASE.lat).toBe(38.84562);
  });
});

describe('alignModeEnabled', () => {
  it('is off by default', () => {
    expect(alignModeEnabled('')).toBe(false);
  });

  it('is on for align=1', () => {
    expect(alignModeEnabled('?align=1')).toBe(true);
  });

  it('is off for any other value', () => {
    expect(alignModeEnabled('?align=0')).toBe(false);
    expect(alignModeEnabled('?other=1')).toBe(false);
  });
});

describe('alignTarget', () => {
  function rephoto(id: string): Overlay {
    return {
      id, kind: 'rephoto',
      anchor: { type: 'geoQuad', lng: -77.3, lat: 38.84, altitude: 6,
                headingDeg: 113, widthM: 18, heightM: 14 },
      title: id, body: null, mediaId: `${id}.jpg`,
      credit: { source: 'S', url: 'U', license: 'L', creator: null },
    };
  }

  const photos = [rephoto('court-1863'), rephoto('court-1918')];

  it('aligns the selected photograph', () => {
    // The bug: arrow keys always moved the first photograph, so the second
    // could never be positioned.
    expect(alignTarget(photos, 'court-1918')?.id).toBe('court-1918');
  });

  it('falls back to the first when nothing is selected', () => {
    expect(alignTarget(photos, null)?.id).toBe('court-1863');
  });

  it('falls back to the first when the selection is not a photograph', () => {
    expect(alignTarget(photos, 'some-text-overlay')?.id).toBe('court-1863');
  });

  it('returns null when the stop has no photographs', () => {
    expect(alignTarget([], 'anything')).toBeNull();
  });

  it('does not mutate the list it is given', () => {
    alignTarget(photos, 'court-1918');
    expect(photos.map((p) => p.id)).toEqual(['court-1863', 'court-1918']);
  });
});
