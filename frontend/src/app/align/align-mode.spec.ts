import { describe, expect, it } from 'vitest';
import { alignModeEnabled, nudgeAnchor, STEP_DEG, type GeoQuadAnchorLike } from './align-mode';

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
