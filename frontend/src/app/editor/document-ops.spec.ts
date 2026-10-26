import { describe, expect, it } from 'vitest';
import {
  LastStopError, addStop, addTextOverlay, defaultCreditFor, deleteOverlay,
  deleteStop, deriveHeading, legalModesFor, moveStop, renumberStops,
  setOverlayKind, slugify, uniqueId, updateOverlay,
  creditText, deriveOverlayHeading, setCreditText, setInWorldField, setOverlayAnchor, setOverlayMode,
} from './document-ops';
import { overlay, stop, tour } from './test-builders';

describe('slugify and uniqueId', () => {
  it('makes a readable slug', () => {
    expect(slugify('Fairfax County Historic Courthouse'))
      .toBe('fairfax-county-historic-courthouse');
  });

  it('survives punctuation and collapses runs', () => {
    expect(slugify("Earp's  Ordinary --- 1800!")).toBe('earps-ordinary-1800');
  });

  it('never returns an empty id', () => {
    expect(slugify('!!!')).toBe('untitled');
  });

  it('de-duplicates against ids already taken', () => {
    expect(uniqueId('courthouse', ['courthouse'])).toBe('courthouse-2');
    expect(uniqueId('courthouse', ['courthouse', 'courthouse-2'])).toBe('courthouse-3');
  });
});

describe('stop ordering', () => {
  it('renumbers contiguously from 1', () => {
    const out = renumberStops([stop('a', 7), stop('b', 3), stop('c', 90)]);
    expect(out.map((s) => s.order)).toEqual([1, 2, 3]);
  });

  it('adds a stop at the end, contiguous', () => {
    const out = addStop(tour([stop('s1', 1), stop('s2', 2)]), 'A New Place');
    expect(out.stops.map((s) => s.order)).toEqual([1, 2, 3]);
    expect(out.stops[2].id).toBe('a-new-place');
  });

  it('moves a stop and renumbers', () => {
    const out = moveStop(tour([stop('a', 1), stop('b', 2), stop('c', 3)]), 'c', -1);
    expect(out.stops.map((s) => s.id)).toEqual(['a', 'c', 'b']);
    expect(out.stops.map((s) => s.order)).toEqual([1, 2, 3]);
  });

  it('clamps a move at the ends rather than throwing', () => {
    const t = tour([stop('a', 1), stop('b', 2)]);
    expect(moveStop(t, 'a', -1).stops.map((s) => s.id)).toEqual(['a', 'b']);
    expect(moveStop(t, 'b', 1).stops.map((s) => s.id)).toEqual(['a', 'b']);
  });

  it('deletes a stop and renumbers', () => {
    const out = deleteStop(tour([stop('a', 1), stop('b', 2), stop('c', 3)]), 'b');
    expect(out.stops.map((s) => s.id)).toEqual(['a', 'c']);
    expect(out.stops.map((s) => s.order)).toEqual([1, 2]);
  });

  it('refuses to delete the last stop', () => {
    // Tour.stops has min_length=1, so this would make the draft unsaveable.
    expect(() => deleteStop(tour([stop('a', 1)]), 'a')).toThrow(LastStopError);
  });
});

describe('overlays', () => {
  it('adds a text overlay that is valid the instant it exists', () => {
    const out = addTextOverlay(tour(), 's1', 'A note');
    const added = out.stops[0].overlays[0];
    expect(added.kind).toBe('text');
    expect(added.display.mode).toBe('marker');
    expect(added.body!.trim().length).toBeGreaterThan(0);
    expect(added.credit.type).toBe('original');
  });

  it('anchors a new overlay at its stop, not at null island', () => {
    const t = tour([stop('s1', 1)]);
    const added = addTextOverlay(t, 's1', 'A note').stops[0].overlays[0];
    expect(added.anchor.lng).toBeCloseTo(t.stops[0].location.lng, 6);
    expect(added.anchor.lat).toBeCloseTo(t.stops[0].location.lat, 6);
  });

  it('de-duplicates overlay ids across the whole tour, not just one stop', () => {
    let t = tour([stop('s1', 1), stop('s2', 2)]);
    t = addTextOverlay(t, 's1', 'A note');
    t = addTextOverlay(t, 's2', 'A note');
    const ids = t.stops.flatMap((s) => s.overlays.map((o) => o.id));
    expect(new Set(ids).size).toBe(2);
  });

  it('keeps an id stable when the title changes', () => {
    let t = addTextOverlay(tour(), 's1', 'Original');
    const id = t.stops[0].overlays[0].id;
    t = updateOverlay(t, id, { title: 'Renamed entirely' });
    expect(t.stops[0].overlays[0].id).toBe(id);
    expect(t.stops[0].overlays[0].title).toBe('Renamed entirely');
  });

  it('deletes an overlay', () => {
    const t = tour([stop('s1', 1, [overlay('o1'), overlay('o2')])]);
    expect(deleteOverlay(t, 'o1').stops[0].overlays.map((o) => o.id)).toEqual(['o2']);
  });

  it('does not mutate its input', () => {
    const t = tour([stop('s1', 1, [overlay('o1')])]);
    const before = JSON.stringify(t);
    updateOverlay(t, 'o1', { title: 'Changed' });
    deleteOverlay(t, 'o1');
    expect(JSON.stringify(t)).toBe(before);
  });
});

describe('kind and display mode', () => {
  it('offers only legal modes', () => {
    expect(legalModesFor('text')).toEqual(['marker']);
    expect([...legalModesFor('image')].sort()).toEqual(['inWorld', 'marker']);
    expect([...legalModesFor('audio')].sort()).toEqual(['ambient', 'marker']);
  });

  it('coerces an illegal mode when the kind changes', () => {
    // An inWorld image switched to text cannot stay inWorld: the backend
    // rejects the pair, so the draft would be unsaveable.
    const t = tour([stop('s1', 1, [overlay('o1', {
      kind: 'image', body: null, mediaId: 'p.jpg',
      display: { mode: 'inWorld', opacity: 0.7, headingDeg: 284.4, widthM: 18, heightM: 12 },
    })])]);
    const out = setOverlayKind(t, 'o1', 'text');
    expect(out.stops[0].overlays[0].display.mode).toBe('marker');
  });

  it('leaves a mode alone when it is already legal for the new kind', () => {
    const t = tour([stop('s1', 1, [overlay('o1', {
      kind: 'audio', body: null, mediaId: 'a.m4a',
      display: { mode: 'marker', icon: 'audio' },
    })])]);
    expect(setOverlayKind(t, 'o1', 'image').stops[0].overlays[0].display.mode).toBe('marker');
  });
});

describe('deriveHeading', () => {
  it('points an overlay back at the panorama that views it', () => {
    // Panorama due south of the anchor: the face must look south, 180 degrees.
    expect(deriveHeading({ lng: -77.3, lat: 38.846 }, { lng: -77.3, lat: 38.845 }))
      .toBeCloseTo(180, 1);
  });

  it('returns a value in [0, 360)', () => {
    const h = deriveHeading({ lng: -77.3, lat: 38.845 }, { lng: -77.3, lat: 38.846 });
    expect(h).toBeGreaterThanOrEqual(0);
    expect(h).toBeLessThan(360);
  });
});

describe('defaultCreditFor', () => {
  it('uses the tour defaults', () => {
    expect(defaultCreditFor(tour())).toEqual({
      type: 'original', creator: 'M. Harrington', license: 'CC-BY-4.0',
    });
  });

  it('falls back to something valid when the tour has no defaults', () => {
    const credit = defaultCreditFor({ ...tour(), defaults: null });
    expect(credit.type).toBe('original');
    expect((credit as { creator: string }).creator.trim().length).toBeGreaterThan(0);
  });
});

describe('inspector helpers', () => {
  const t = () => tour([stop('s1', 1, [
    overlay('o1', { kind: 'image', display: { mode: 'marker', icon: 'photo' } })])]);
  const get = (x: ReturnType<typeof tour>) => x.stops[0].overlays[0];

  it('patches the anchor without mutating the input', () => {
    const before = t();
    const after = setOverlayAnchor(before, 'o1', { lng: -77.1 });
    expect(get(after).anchor.lng).toBe(-77.1);
    expect(get(before).anchor.lng).toBe(-77.3);
  });

  it('entering inWorld derives the heading from the stop location', () => {
    const base = t();
    base.stops[0].overlays[0].anchor = { type: 'geo', lng: -77.3, lat: 38.841, altitudeM: 2 };
    const d = get(setOverlayMode(base, 'o1', 'inWorld')).display;
    expect(d.mode).toBe('inWorld');
    // stop is due south of the anchor
    expect((d as { headingDeg: number }).headingDeg).toBeCloseTo(180, 3);
  });

  it('refuses a mode that is illegal for the kind', () => {
    const base = tour([stop('s1', 1, [overlay('o1')])]);
    expect(setOverlayMode(base, 'o1', 'inWorld')).toEqual(base);
  });

  it('setInWorldField ignores non-inWorld overlays', () => {
    const base = t();
    expect(get(setInWorldField(base, 'o1', { widthM: 9 })).display).toEqual(get(base).display);
  });

  it('re-derives heading after the anchor moves', () => {
    let x = setOverlayMode(t(), 'o1', 'inWorld');
    x = setInWorldField(x, 'o1', { headingDeg: 1 });
    x = setOverlayAnchor(x, 'o1', { lat: 38.841 });
    x = deriveOverlayHeading(x, 'o1');
    expect((get(x).display as { headingDeg: number }).headingDeg).toBeCloseTo(180, 3);
  });

  it('edits credit text for original and sourced credits', () => {
    const x = setCreditText(t(), 'o1', 'New Name');
    expect(creditText(get(x).credit)).toBe('New Name');
    const s = tour([stop('s1', 1, [overlay('o1', {
      credit: { type: 'sourced', source: 'LoC', url: 'http://x', license: 'PD', creator: null } })])]);
    expect(creditText(get(setCreditText(s, 'o1', 'NARA')).credit)).toBe('NARA');
  });
});
