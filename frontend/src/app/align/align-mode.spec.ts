import { describe, expect, it, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import {
  AlignMode,
  alignModeEnabled,
  alignTarget,
  nudgeAnchor,
  STEP_DEG,
  type InWorldPlacementLike,
} from './align-mode';
import { TourStore } from '../core/tour-store';
import type { Overlay, Tour } from '../core/tour.models';

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
      id, kind: 'image',
      anchor: { type: 'geo', lng: -77.3, lat: 38.84, altitudeM: 6 },
      display: { mode: 'inWorld', opacity: 0.7, headingDeg: 113, widthM: 18, heightM: 14 },
      title: id, body: null, mediaId: `${id}.jpg`,
      credit: { type: 'sourced', source: 'S', url: 'U', license: 'L', creator: null },
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

describe('AlignMode component', () => {
  let store: TourStore;

  function tourWithInWorld(id: string): Tour {
    return {
      id: 't', schemaVersion: 2, title: 'T', description: '', defaults: null, attribution: [],
      stops: [{
        id: 's1', order: 1, title: 'S', summary: '',
        location: { lng: -77.3, lat: 38.84 }, osmRef: null,
        panorama: { provider: 'mapillary', imageId: 'i', bearing: 0, cachedPath: null },
        overlays: [{
          id, kind: 'image',
          anchor: { type: 'geo', lng: -77.30732, lat: 38.84562, altitudeM: 6 },
          display: { mode: 'inWorld', opacity: 0.7, headingDeg: 200, widthM: 18, heightM: 14 },
          title: 'Photo', body: null, mediaId: `${id}.jpg`,
          credit: { type: 'sourced', source: 'S', url: 'U', license: 'L', creator: null },
        }],
      }],
    };
  }

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [AlignMode] });
    store = TestBed.inject(TourStore);
  });

  it('emits v2-shaped JSON: an anchor block and a display block', () => {
    store.load(tourWithInWorld('p1'));
    const fixture = TestBed.createComponent(AlignMode);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const text = el.querySelector('[data-align-json]')?.textContent ?? '';
    expect(JSON.parse(text)).toEqual({
      anchor: { type: 'geo', lng: -77.30732, lat: 38.84562, altitudeM: 6 },
      display: { mode: 'inWorld', headingDeg: 200, widthM: 18, heightM: 14 },
    });
  });
});
