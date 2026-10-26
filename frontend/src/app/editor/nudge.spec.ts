import { describe, expect, it } from 'vitest';
import { nudgeAnchor, STEP_DEG, type InWorldPlacementLike } from './nudge';

const BASE: InWorldPlacementLike = {
  lng: -77.30732, lat: 38.84562, altitudeM: 6,
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
    expect(nudgeAnchor(BASE, 'PageUp').altitudeM).toBeGreaterThan(BASE.altitudeM);
    expect(nudgeAnchor(BASE, 'PageDown').altitudeM).toBeLessThan(BASE.altitudeM);
  });

  it('z raises and c lowers, for keyboards without page keys', () => {
    expect(nudgeAnchor(BASE, 'z').altitudeM).toBeGreaterThan(BASE.altitudeM);
    expect(nudgeAnchor(BASE, 'c').altitudeM).toBeLessThan(BASE.altitudeM);
  });

  it('z and c move by the same step as the page keys', () => {
    expect(nudgeAnchor(BASE, 'z').altitudeM).toBeCloseTo(
      nudgeAnchor(BASE, 'PageUp').altitudeM, 6);
    expect(nudgeAnchor(BASE, 'c').altitudeM).toBeCloseTo(
      nudgeAnchor(BASE, 'PageDown').altitudeM, 6);
  });

  it('accepts Z and C with shift or caps lock held', () => {
    expect(nudgeAnchor(BASE, 'Z').altitudeM).toBeGreaterThan(BASE.altitudeM);
    expect(nudgeAnchor(BASE, 'C').altitudeM).toBeLessThan(BASE.altitudeM);
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
