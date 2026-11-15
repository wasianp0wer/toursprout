import { describe, expect, it } from 'vitest';
import {
  LastStopError, addMediaOverlay, defaultsAnswerValid, hasDefaults, mediaKindOf, setTourDefaults, addStop, addTextOverlay, defaultCreditFor, deleteOverlay,
  deleteStop, deriveHeading, legalModesFor, moveStop, renumberStops,
  setOverlayKind, slugify, uniqueId, updateOverlay,
  creditText, deriveOverlayHeading, setOverlayHeadingManual, setCreditText, setInWorldField, setOverlayAnchor, setOverlayAnchorKeepingHeading, setOverlayMode, setStopTitle, legalKindsFor,
  setStopLocation, selectPanorama,
  PLACEHOLDER_SUMMARY, setStopSummary, setTourDescription, setTourTitle,
  setThemePreset, setThemeOverride, clearThemeOverride, clearThemeOverrides,
  setTypePairing, setTypeScale, setTourLayout,
} from './document-ops';
import { overlay, stop, tour } from './test-builders';
import type { Tour } from '../core/tour.models';

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

  it('adds a stop where it is told to, when told', () => {
    const t = tour([stop('s1', 1, [], { location: { lng: 1, lat: 2 } })]);
    expect(addStop(t, 'New stop', { lng: -77.3, lat: 38.8 }).stops[1].location).toEqual({ lng: -77.3, lat: 38.8 });
    // Without a place to start, the old rule: where the previous stop is.
    expect(addStop(t, 'New stop').stops[1].location).toEqual({ lng: 1, lat: 2 });
    expect(addStop(t, 'New stop', null).stops[1].location).toEqual({ lng: 1, lat: 2 });
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
  // DECOY: the stop's location is deliberately far from the panorama fix. The
  // panorama stands where the camera car drove, the stop is the building, and
  // deriving from the stop once pointed a photograph 178 degrees backwards.
  // With the two apart, any code path that reads stop.location gives a
  // different heading and fails loudly instead of passing by coincidence.
  const STOP_LOC = { lng: -77.5, lat: 38.7 };
  const PANO = { imageId: 'img-1', lng: -77.31, lat: 38.85 };
  const ANCHOR = { type: 'geo' as const, lng: -77.3, lat: 38.84, altitudeM: 2 };
  const IMG = () => overlay('o1', {
    kind: 'image', mediaId: 'p.jpg', anchor: { ...ANCHOR },
    display: { mode: 'marker', icon: 'photo' },
  });
  const t = (loc = STOP_LOC) => tour([stop('s1', 1, [IMG()], { location: loc })]);
  const get = (x: ReturnType<typeof tour>) => x.stops[0].overlays[0];
  const heading = (x: ReturnType<typeof tour>) => (get(x).display as { headingDeg: number }).headingDeg;
  const inWorldTour = () => setOverlayMode(t(), 'o1', 'inWorld', PANO);
  const frozen = <T,>(x: T): string => JSON.stringify(x);

  it('the decoy really is far from the panorama fix', () => {
    expect(deriveHeading(ANCHOR, STOP_LOC)).not.toBeCloseTo(deriveHeading(ANCHOR, PANO), 0);
  });

  it('patches the anchor without mutating the input', () => {
    const before = t();
    const snap = frozen(before);
    const after = setOverlayAnchor(before, 'o1', { lng: -77.1 });
    expect(get(after).anchor.lng).toBe(-77.1);
    expect(frozen(before)).toBe(snap);
  });

  it('rejects non-finite and out-of-range anchor values by identity', () => {
    const x = t();
    expect(setOverlayAnchor(x, 'o1', { lng: NaN })).toBe(x);
    expect(setOverlayAnchor(x, 'o1', { lat: 91 })).toBe(x);
    expect(setOverlayAnchor(x, 'o1', { lng: -181 })).toBe(x);
    expect(setOverlayAnchor(x, 'o1', { altitudeM: Infinity })).toBe(x);
  });

  it('entering inWorld derives the heading from the fix, not the stop', () => {
    const x = inWorldTour();
    expect(get(x).display.mode).toBe('inWorld');
    expect(heading(x)).toBeCloseTo(deriveHeading(ANCHOR, PANO), 9);
  });

  it('the derived heading is unchanged when stop.location changes', () => {
    const a = deriveOverlayHeading(inWorldTour(), 'o1', PANO);
    const moved = tour([stop('s1', 1, [get(inWorldTour())], { location: { lng: -77.1, lat: 38.95 } })]);
    const b = deriveOverlayHeading(moved, 'o1', PANO);
    expect(heading(a)).toBeCloseTo(deriveHeading(ANCHOR, PANO), 9);
    expect(heading(b)).toBe(heading(a));
  });

  it('refuses to enter inWorld with no fix or a fix for another panorama, by identity', () => {
    const x = t();
    expect(setOverlayMode(x, 'o1', 'inWorld', null)).toBe(x);
    expect(setOverlayMode(x, 'o1', 'inWorld', { ...PANO, imageId: 'other' })).toBe(x);
  });

  it('refuses a mode that is illegal for the kind, by identity', () => {
    const base = tour([stop('s1', 1, [overlay('o1')])]);
    expect(setOverlayMode(base, 'o1', 'inWorld', { ...PANO })).toBe(base);
  });

  it('an overlay already inWorld keeps its heading when the position is unknown', () => {
    const x = setInWorldField(inWorldTour(), 'o1', { headingDeg: 77 });
    expect(deriveOverlayHeading(x, 'o1', null)).toBe(x);
    expect(heading(x)).toBe(77);
  });

  it('derive refuses a fix belonging to a different panorama, by identity', () => {
    const x = inWorldTour();
    expect(deriveOverlayHeading(x, 'o1', { ...PANO, imageId: 'previous-pano' })).toBe(x);
  });

  it('re-derives from the fix after the anchor moves', () => {
    let x = setInWorldField(inWorldTour(), 'o1', { headingDeg: 1 });
    x = setOverlayAnchor(x, 'o1', { lat: 38.841 });
    x = deriveOverlayHeading(x, 'o1', PANO);
    expect(heading(x)).toBeCloseTo(deriveHeading({ ...ANCHOR, lat: 38.841 }, PANO), 9);
  });

  it('setInWorldField ignores non-inWorld overlays, by identity', () => {
    const x = t();
    expect(setInWorldField(x, 'o1', { widthM: 9 })).toBe(x);
  });

  it('setInWorldField validates, clamps and normalises, without mutating', () => {
    const x = inWorldTour();
    const snap = frozen(x);
    expect(setInWorldField(x, 'o1', { widthM: 0 })).toBe(x);
    expect(setInWorldField(x, 'o1', { heightM: -2 })).toBe(x);
    expect(setInWorldField(x, 'o1', { opacity: NaN })).toBe(x);
    const d = get(setInWorldField(x, 'o1', { opacity: 3, headingDeg: 370 })).display as
      { opacity: number; headingDeg: number };
    expect(d.opacity).toBe(1);
    expect(d.headingDeg).toBe(10);
    expect(frozen(x)).toBe(snap);
  });

  it('mode and derive transforms do not mutate their input', () => {
    const x = t(); const snap = frozen(x);
    const y = setOverlayMode(x, 'o1', 'inWorld', PANO);
    const snapY = frozen(y);
    deriveOverlayHeading(y, 'o1', PANO);
    expect(frozen(x)).toBe(snap);
    expect(frozen(y)).toBe(snapY);
  });

  it('edits credit text for original and sourced credits, without mutating', () => {
    const x = t(); const snap = frozen(x);
    const y = setCreditText(x, 'o1', 'New Name');
    expect(creditText(get(y).credit)).toBe('New Name');
    expect(frozen(x)).toBe(snap);
    const s = tour([stop('s1', 1, [overlay('o1', {
      credit: { type: 'sourced', source: 'LoC', url: 'http://x', license: 'PD', creator: null } })])]);
    expect(creditText(get(setCreditText(s, 'o1', 'NARA')).credit)).toBe('NARA');
  });

  it('setStopTitle does not mutate', () => {
    const x = t(); const snap = frozen(x);
    expect(setStopTitle(x, 's1', 'Renamed').stops[0].title).toBe('Renamed');
    expect(frozen(x)).toBe(snap);
  });

  it('legalKindsFor offers image and audio only when media is attached', () => {
    expect(legalKindsFor(overlay('a'))).toEqual(['text']);
    expect(legalKindsFor(overlay('a', { mediaId: 'm.jpg' }))).toEqual(['text', 'image']);
    expect(legalKindsFor(overlay('a', { mediaId: 'm.mp3' }))).toEqual(['text', 'audio']);
    expect(legalKindsFor(overlay('a', { mediaId: 'm.xyz' }))).toEqual(['text', 'image', 'audio']);
    // the current kind stays listed even if the data is odd
    expect(legalKindsFor(overlay('a', { kind: 'image', mediaId: null }))).toEqual(['text', 'image']);
  });

  describe('setOverlayAnchorKeepingHeading', () => {
    const NONE: ReadonlySet<string> = new Set();
    const MOVE = { lng: -77.2995 }; // a few hundred metres east: the bearing must change

    it('re-derives a derived heading from the new anchor', () => {
      const before = inWorldTour();
      const after = setOverlayAnchorKeepingHeading(before, 'o1', MOVE, PANO, NONE);
      expect(get(after).anchor.lng).toBe(-77.2995);
      expect(heading(after)).toBeCloseTo(deriveHeading(get(after).anchor, PANO), 6);
      expect(heading(after)).not.toBeCloseTo(heading(before), 0);
    });

    it('leaves a manual heading alone', () => {
      const before = inWorldTour();
      const after = setOverlayAnchorKeepingHeading(before, 'o1', MOVE, PANO, new Set(['o1']));
      expect(get(after).anchor.lng).toBe(-77.2995);
      expect(heading(after)).toBe(heading(before));
    });

    it('leaves the heading alone, but still moves, when no fix is available', () => {
      const before = inWorldTour();
      const after = setOverlayAnchorKeepingHeading(before, 'o1', MOVE, null, NONE);
      expect(get(after).anchor.lng).toBe(-77.2995);
      expect(heading(after)).toBe(heading(before));
    });

    it('ignores a fix for another stop\'s panorama', () => {
      const before = inWorldTour();
      const after = setOverlayAnchorKeepingHeading(before, 'o1', MOVE, { ...PANO, imageId: 'other' }, NONE);
      expect(heading(after)).toBe(heading(before));
    });

    it('moves a marker overlay without trying to derive anything', () => {
      const before = t();
      const after = setOverlayAnchorKeepingHeading(before, 'o1', MOVE, PANO, NONE);
      expect(get(after).anchor.lng).toBe(-77.2995);
      expect(get(after).display.mode).toBe('marker');
    });

    it('returns the same reference when the move itself is refused', () => {
      const before = inWorldTour();
      expect(setOverlayAnchorKeepingHeading(before, 'o1', { lat: 99 }, PANO, NONE)).toBe(before);
    });
  });

  it('regression: courthouse 1863 derives from the real panorama (about 105, not about 285)', () => {
    // DECOY: stop.location sits on the far side of the anchor from the
    // camera, so a derivation that wrongly reads the stop gets about 285,
    // facing exactly backwards; from the real panorama position it is about 105.
    const COURT_ANCHOR = { lng: -77.30732, lat: 38.84562 };
    const CAMERA = { imageId: 'img-1', lng: -77.306888, lat: 38.845534 };
    const decoy = {
      lng: COURT_ANCHOR.lng * 2 - CAMERA.lng,
      lat: COURT_ANCHOR.lat * 2 - CAMERA.lat,
    };
    expect(Math.abs(deriveHeading(COURT_ANCHOR, decoy) - 285)).toBeLessThan(10);
    const x = tour([stop('s1', 1, [overlay('o1', {
      kind: 'image', mediaId: 'c.jpg',
      anchor: { type: 'geo', lng: -77.30732, lat: 38.84562, altitudeM: 2 },
      display: { mode: 'inWorld', opacity: 0.8, headingDeg: 0, widthM: 4, heightM: 3 },
    })], { location: decoy })]);
    const out = deriveOverlayHeading(x, 'o1', CAMERA);
    expect(heading(out)).toBeGreaterThan(100);
    expect(heading(out)).toBeLessThan(110);
  });
});

describe('setOverlayHeadingManual (the map rotation handle)', () => {
  const PANO = { imageId: 'img-1', lng: -77.3069, lat: 38.8455 };
  const build = () => tour([stop('s1', 1, [overlay('o1', {
    kind: 'image', mediaId: 'p.jpg',
    display: { mode: 'inWorld', opacity: 0.8, headingDeg: 10, widthM: 4, heightM: 3 },
  })])]);
  const heading = (t: ReturnType<typeof build>) =>
    (t.stops[0].overlays[0].display as { headingDeg: number }).headingDeg;

  it('sets the heading when the fix belongs to this stop panorama', () => {
    expect(heading(setOverlayHeadingManual(build(), 'o1', 123, PANO))).toBe(123);
  });

  it('normalises into [0, 360)', () => {
    expect(heading(setOverlayHeadingManual(build(), 'o1', -90, PANO))).toBe(270);
  });

  it('is refused (same reference) with no fix', () => {
    const t = build();
    expect(setOverlayHeadingManual(t, 'o1', 123, null)).toBe(t);
  });

  it('is refused for a fix that belongs to another panorama', () => {
    const t = build();
    expect(setOverlayHeadingManual(t, 'o1', 123, { ...PANO, imageId: 'img-2' })).toBe(t);
  });

  it('is refused for a non-finite heading and for a non-inWorld overlay', () => {
    const t = build();
    expect(setOverlayHeadingManual(t, 'o1', NaN, PANO)).toBe(t);
    const m = tour([stop('s1', 1, [overlay('o1')])]);
    expect(setOverlayHeadingManual(m, 'o1', 5, PANO)).toBe(m);
  });
});

describe('media overlays and tour defaults', () => {
  const noDefaults = (): Tour => ({ ...tour(), defaults: null });

  it('mediaKindOf reads the kind from the stored extension', () => {
    expect(mediaKindOf('map-ab12.jpg')).toBe('image');
    expect(mediaKindOf('x-ab12.webp')).toBe('image');
    expect(mediaKindOf('x-ab12.m4a')).toBe('audio');
    expect(mediaKindOf('x-ab12.webm')).toBe('audio');
    expect(mediaKindOf('x-ab12.exe')).toBeNull();
  });

  it('hasDefaults needs both a creator and a licence', () => {
    expect(hasDefaults(tour())).toBe(true);
    expect(hasDefaults(noDefaults())).toBe(false);
    expect(hasDefaults({ ...tour(), defaults: { creator: ' ', license: 'CC0' } })).toBe(false);
  });

  it('setTourDefaults writes trimmed defaults and refuses blanks', () => {
    const t = noDefaults();
    const out = setTourDefaults(t, ' Ada ', ' CC0 ');
    expect(out.defaults).toEqual({ creator: 'Ada', license: 'CC0' });
    expect(t.defaults).toBeNull();
    expect(setTourDefaults(t, '', 'CC0')).toBe(t);
    expect(setTourDefaults(t, 'Ada', '  ')).toBe(t);
  });

  it('addMediaOverlay anchors at the stop with an original credit from defaults', () => {
    const t = tour();
    const out = addMediaOverlay(t, 's1', 'image', 'map-ab12.jpg', 'map.jpg');
    const o = out.stops[0].overlays[0];
    expect(o).toMatchObject({
      kind: 'image', mediaId: 'map-ab12.jpg', title: 'map.jpg',
      display: { mode: 'marker', icon: 'photo' },
      anchor: { type: 'geo', lng: t.stops[0].location.lng, lat: t.stops[0].location.lat },
      credit: { type: 'original', creator: 'M. Harrington', license: 'CC-BY-4.0' },
    });
    expect(t.stops[0].overlays.length).toBe(0);
  });

  it('addMediaOverlay produces an audio marker for audio', () => {
    const o = addMediaOverlay(tour(), 's1', 'audio', 'a-1.mp3', 'a.mp3').stops[0].overlays[0];
    expect(o.display).toEqual({ mode: 'marker', icon: 'audio' });
  });

  it('with no defaults it refuses, rather than writing Unknown', () => {
    const t = noDefaults();
    expect(addMediaOverlay(t, 's1', 'image', 'm-1.jpg', 'm.jpg')).toBe(t);
  });

  it('with no defaults, supplied defaults are written with the overlay in one document', () => {
    const out = addMediaOverlay(noDefaults(), 's1', 'image', 'm-1.jpg', 'm.jpg',
      { creator: 'Ada', license: 'CC0' });
    expect(out.defaults).toEqual({ creator: 'Ada', license: 'CC0' });
    expect(out.stops[0].overlays[0].credit).toEqual({ type: 'original', creator: 'Ada', license: 'CC0' });
  });

  it('existing defaults win over supplied ones', () => {
    const out = addMediaOverlay(tour(), 's1', 'image', 'm-1.jpg', 'm.jpg', { creator: 'X', license: 'Y' });
    expect(out.defaults).toEqual({ creator: 'M. Harrington', license: 'CC-BY-4.0' });
  });

  it('refuses a mediaId whose type does not match the kind, or an unknown stop', () => {
    const t = tour();
    expect(addMediaOverlay(t, 's1', 'image', 'a-1.mp3', 'a')).toBe(t);
    expect(addMediaOverlay(t, 's1', 'audio', 'a-1.jpg', 'a')).toBe(t);
    expect(addMediaOverlay(t, 'nope', 'image', 'a-1.jpg', 'a')).toBe(t);
  });

  it('gives a unique id and a title fallback', () => {
    let t = addMediaOverlay(tour(), 's1', 'image', 'm-1.jpg', 'm.jpg');
    t = addMediaOverlay(t, 's1', 'image', 'm-1.jpg', 'm.jpg');
    const ids = t.stops[0].overlays.map((o) => o.id);
    expect(new Set(ids).size).toBe(2);
    expect(addMediaOverlay(tour(), 's1', 'image', 'm-1.jpg', '  ').stops[0].overlays[0].title).toBe('New image');
  });
});

describe('text overlays and the defaults invariant', () => {
  const noDefaults = (): Tour => ({ ...tour(), defaults: null });

  it('defaultsAnswerValid needs a non-blank creator and licence', () => {
    expect(defaultsAnswerValid('Ada', 'CC0')).toBe(true);
    expect(defaultsAnswerValid(' ', 'CC0')).toBe(false);
    expect(defaultsAnswerValid('Ada', '')).toBe(false);
  });

  it('addTextOverlay refuses (same reference) with no defaults and no answer', () => {
    const t = noDefaults();
    expect(addTextOverlay(t, 's1', 'A note')).toBe(t);
  });

  it('addTextOverlay writes a supplied answer onto the tour with the overlay', () => {
    const out = addTextOverlay(noDefaults(), 's1', 'A note', { creator: 'Ada', license: 'CC0' });
    expect(out.defaults).toEqual({ creator: 'Ada', license: 'CC0' });
    expect(out.stops[0].overlays[0].credit).toEqual({ type: 'original', creator: 'Ada', license: 'CC0' });
  });

  it('addTextOverlay with defaults ignores a supplied answer', () => {
    const out = addTextOverlay(tour(), 's1', 'A note', { creator: 'X', license: 'Y' });
    expect(out.defaults).toEqual({ creator: 'M. Harrington', license: 'CC-BY-4.0' });
  });
});

describe('stop location and panorama selection', () => {
  const CAND = { imageId: 'cam-9', lng: -77.31, lat: 38.85 };

  it('setStopLocation moves the stop and optionally sets osmRef; refusals keep the reference', () => {
    const t = tour();
    const out = setStopLocation(t, 's1', -77.4, 38.9);
    expect(out.stops[0].location).toEqual({ lng: -77.4, lat: 38.9 });
    expect(out.stops[0].osmRef).toBeNull();
    expect(setStopLocation(t, 's1', -77.4, 38.9, 'way/12').stops[0].osmRef).toBe('way/12');
    expect(setStopLocation(t, 's1', 181, 0)).toBe(t);
    expect(setStopLocation(t, 's1', 0, -91)).toBe(t);
    expect(setStopLocation(t, 's1', NaN, 0)).toBe(t);
    expect(setStopLocation(t, 'nope', 1, 1)).toBe(t);
  });

  it('selectPanorama writes the imageId and returns a fix built from the SAME candidate', () => {
    const t = tour();
    const r = selectPanorama(t, 's1', CAND)!;
    expect(r.tour.stops[0].panorama.imageId).toBe('cam-9');
    expect(r.fix).toEqual({ imageId: 'cam-9', lng: -77.31, lat: 38.85 });
    expect(r.tour.stops[0].location).toEqual(t.stops[0].location);
  });

  it('selectPanorama drops the cached file of the panorama it replaces', () => {
    const t = tour([stop('s1', 1, [], { panorama: { provider: 'mapillary', imageId: 'old', bearing: 90, cachedMediaId: 'old.jpg' } })]);
    expect(selectPanorama(t, 's1', CAND)!.tour.stops[0].panorama.cachedMediaId).toBeNull();
  });

  it('selectPanorama resets the bearing to the new camera heading, or north if unknown', () => {
    const t = tour();
    expect(t.stops[0].panorama.bearing).toBe(90);
    expect(selectPanorama(t, 's1', { ...CAND, compassAngle: 200.5 })!.tour.stops[0].panorama.bearing).toBe(200.5);
    expect(selectPanorama(t, 's1', CAND)!.tour.stops[0].panorama.bearing).toBe(0);
    expect(selectPanorama(t, 's1', { ...CAND, compassAngle: null })!.tour.stops[0].panorama.bearing).toBe(0);
  });

  const bearingFor = (compassAngle: number | null) =>
    selectPanorama(tour(), 's1', { ...CAND, compassAngle })!.tour.stops[0].panorama.bearing;

  it("selectPanorama stores bearing 0 for Mapillary's -1, not 359", () => {
    // Mapillary reports an unknown compass angle as -1, not null: 25 of
    // Krumlov's 46 flat images do. Normalising it yields 359, and the stop is
    // stored facing almost due north on no evidence at all. This assertion
    // used to read 350 for -10, which was that bug with a rounder number.
    expect(bearingFor(-1)).toBe(0);
    expect(bearingFor(-10)).toBe(0);
  });

  it('selectPanorama treats any negative angle as absent, including -0.0001 and -360', () => {
    expect(bearingFor(-0.0001)).toBe(0);
    expect(bearingFor(-360)).toBe(0);
  });

  it('selectPanorama stores a real 0 as 0 — indistinguishable from unknown, by design', () => {
    // Panorama.bearing is required and non-nullable and the schema does not
    // change, so the document cannot tell "facing north" from "direction
    // unknown". The editor map's wedge is what distinguishes them, and it
    // reads the viewer's report rather than this number.
    expect(bearingFor(0)).toBe(0);
  });

  it('selectPanorama keeps a flat image\'s known angle', () => {
    expect(bearingFor(293.97)).toBe(293.97);
    expect(bearingFor(400)).toBe(40);
  });

  it('selectPanorama refuses an unknown stop, a blank id and a non-finite position', () => {
    const t = tour();
    expect(selectPanorama(t, 'nope', CAND)).toBeNull();
    expect(selectPanorama(t, 's1', { ...CAND, imageId: ' ' })).toBeNull();
    expect(selectPanorama(t, 's1', { ...CAND, lat: NaN })).toBeNull();
    expect(selectPanorama(t, 's1', { ...CAND, lng: 200 })).toBeNull();
  });

  it('the fix opens the gate for the selected stop and for no other', () => {
    const t = tour([stop('s1', 1), stop('s2', 2)]);
    const r = selectPanorama(t, 's1', CAND)!;
    const anchor = { type: 'geo' as const, lng: -77.3, lat: 38.841, altitudeM: 2 };
    const withOv = {
      ...r.tour,
      stops: r.tour.stops.map((s) => s.id === 's1' ? { ...s, overlays: [overlay('o1', {
        kind: 'image', mediaId: 'p.jpg', anchor,
        display: { mode: 'inWorld', opacity: 0.8, headingDeg: 5, widthM: 4, heightM: 3 },
      })] } : s),
    };
    const derived = deriveOverlayHeading(withOv, 'o1', r.fix);
    expect((derived.stops[0].overlays[0].display as { headingDeg: number }).headingDeg)
      .toBeCloseTo(deriveHeading(anchor, CAND), 6);
    // The same fix against a stop that did not select it stays closed.
    expect(deriveOverlayHeading(withOv, 'o1', { ...r.fix, imageId: 'img-2' })).toBe(withOv);
  });
});

describe('sourced credits', () => {
  it('addMediaOverlay uses a given credit and needs no tour defaults for it', () => {
    const t: Tour = { ...tour(), defaults: null };
    const credit = {
      type: 'sourced', source: 'Library of Congress', url: 'https://loc.gov/item/1/',
      license: 'R', creator: 'A. Photographer',
    } as const;
    const out = addMediaOverlay(t, 's1', 'image', 'm-1.jpg', 'Courthouse', undefined, credit);
    expect(out.stops[0].overlays[0].credit).toEqual(credit);
    expect(out.defaults).toBeNull();
    expect(addMediaOverlay(t, 's1', 'image', 'm-1.jpg', 'Courthouse')).toBe(t);
  });
});

describe('naming and describing', () => {
  it('setTourTitle and setTourDescription change only their field and do not mutate', () => {
    const x = tour(); const snap = JSON.stringify(x);
    const y = setTourTitle(x, 'Second Tour');
    expect(y.title).toBe('Second Tour');
    expect(y.id).toBe(x.id);
    expect(y.stops).toBe(x.stops);
    expect(setTourDescription(x, 'A walk').description).toBe('A walk');
    expect(JSON.stringify(x)).toBe(snap);
  });

  it('setStopSummary rewrites one stop\'s text', () => {
    const x = tour([stop('s1', 1), stop('s2', 2)]); const snap = JSON.stringify(x);
    const y = setStopSummary(x, 's2', 'The courthouse stood here.');
    expect(y.stops[1].summary).toBe('The courthouse stood here.');
    expect(y.stops[0]).toBe(x.stops[0]);
    expect(JSON.stringify(x)).toBe(snap);
  });

  it('a new stop carries the placeholder', () => {
    const t = addStop(tour(), 'Courthouse');
    const added = t.stops[t.stops.length - 1];
    expect(added.summary).toBe(PLACEHOLDER_SUMMARY);
  });
});

describe('theme ops', () => {
  const base = () => tour();

  it('stores only what the author set', () => {
    // The brief's example expected archival to arrive with garamond. Nothing in
    // the spec or the backend gives a preset a pairing: a preset is a palette,
    // and the stored theme is {"preset": ...} plus the author's own choices.
    expect(setThemePreset(base(), 'archival').theme).toEqual({
      preset: 'archival', typePairing: 'georgia', typeScale: 'comfortable',
      layout: 'widePanel', overrides: {},
    });
  });

  it('keeps an override that equals the preset value', () => {
    const t = setThemeOverride(setThemePreset(base(), 'archival'), 'accent', '#9c5a24');
    expect(t.theme!.overrides.accent).toBe('#9c5a24');
  });

  it('lowercases a hex on the way in', () => {
    expect(setThemeOverride(base(), 'accent', '#9C5A24').theme!.overrides.accent).toBe('#9c5a24');
  });

  it('refuses a malformed hex by returning the same reference', () => {
    const t = base();
    for (const bad of ['red', '#fff', '#12345g', 'url(x)', '#ffffff;', ''])
      expect(setThemeOverride(t, 'accent', bad)).toBe(t);
  });

  it('returns the same reference when an override is set to what it already is', () => {
    const t = setThemeOverride(base(), 'accent', '#9c5a24');
    expect(setThemeOverride(t, 'accent', '#9C5A24')).toBe(t);
  });

  it('clears the overrides when the preset changes, and keeps type and layout', () => {
    let t = setThemeOverride(base(), 'accent', '#9c5a24');
    t = setTypePairing(setTourLayout(t, 'immersive'), 'plex');
    const out = setThemePreset(t, 'civic');
    expect(out.theme).toEqual({
      preset: 'civic', typePairing: 'plex', typeScale: 'comfortable',
      layout: 'immersive', overrides: {},
    });
  });

  it('returns the same reference when the preset does not change', () => {
    const t = setThemePreset(base(), 'nocturne');
    expect(setThemePreset(t, 'nocturne')).toBe(t);
  });

  it('does not mutate the document it was given', () => {
    const t = setThemeOverride(base(), 'accent', '#9c5a24');
    const frozen = JSON.stringify(t);
    setThemeOverride(t, 'ink', '#000000'); clearThemeOverride(t, 'accent');
    clearThemeOverrides(t); setThemePreset(t, 'civic');
    expect(JSON.stringify(t)).toBe(frozen);
  });

  it('clears one override, and is a no-op when it was not set', () => {
    const t = setThemeOverride(setThemeOverride(base(), 'accent', '#9c5a24'), 'ink', '#000000');
    expect(clearThemeOverride(t, 'accent').theme!.overrides).toEqual({ ink: '#000000' });
    expect(clearThemeOverride(t, 'paper')).toBe(t);
  });

  it('treats a null override from the backend as not set', () => {
    const t = { ...base(), theme: {
      preset: 'nocturne', typePairing: 'georgia', typeScale: 'comfortable',
      layout: 'widePanel', overrides: { accent: null },
    } } as Tour;
    expect(clearThemeOverride(t, 'accent')).toBe(t);
    expect(clearThemeOverrides(t)).toBe(t);
  });

  it('clears every override at once, and is a no-op when there are none', () => {
    const t = setThemeOverride(setThemeOverride(base(), 'accent', '#9c5a24'), 'ink', '#000000');
    expect(clearThemeOverrides(t).theme!.overrides).toEqual({});
    const clean = clearThemeOverrides(t);
    expect(clearThemeOverrides(clean)).toBe(clean);
    const none = base();
    expect(clearThemeOverrides(none)).toBe(none);
  });

  it('sets pairing, scale and layout, and returns the same reference when unchanged', () => {
    const t = setTourLayout(setTypeScale(setTypePairing(base(), 'franklinGaramond'), 'generous'), 'panelLeft');
    expect(t.theme).toMatchObject({ typePairing: 'franklinGaramond', typeScale: 'generous', layout: 'panelLeft' });
    expect(setTypePairing(t, 'franklinGaramond')).toBe(t);
    expect(setTypeScale(t, 'generous')).toBe(t);
    expect(setTourLayout(t, 'panelLeft')).toBe(t);
  });

  it('keeps the overrides when the type or layout changes', () => {
    const t = setThemeOverride(base(), 'accent', '#9c5a24');
    expect(setTypePairing(t, 'plex').theme!.overrides).toEqual({ accent: '#9c5a24' });
  });

  it('refuses a name it does not know', () => {
    const t = base();
    expect(setThemePreset(t, 'sepia' as never)).toBe(t);
    expect(setTypePairing(t, 'comic' as never)).toBe(t);
    expect(setTypeScale(t, 'huge' as never)).toBe(t);
    expect(setTourLayout(t, 'sideways' as never)).toBe(t);
  });
});
