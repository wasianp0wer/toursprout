import { describe, expect, it, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import {
  AlignMode,
  alignModeEnabled,
  alignTarget,
} from './align-mode';
import { TourStore } from '../core/tour-store';
import type { Overlay, Tour } from '../core/tour.models';

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
  function photo(id: string): Overlay {
    return {
      id, kind: 'image',
      anchor: { type: 'geo', lng: -77.3, lat: 38.84, altitudeM: 6 },
      display: { mode: 'inWorld', opacity: 0.7, headingDeg: 113, widthM: 18, heightM: 14 },
      title: id, body: null, mediaId: `${id}.jpg`,
      credit: { type: 'sourced', source: 'S', url: 'U', license: 'L', creator: null },
    };
  }

  const photos = [photo('court-1863'), photo('court-1918')];

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
