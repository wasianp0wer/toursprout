import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ConfigStore } from './config-store';
import {
  MapillarySearch, bboxAround, haversineM, knownCompassAngle, rankCandidates, thinBySpacing,
  type PanoramaCandidate,
} from './mapillary-search';

const at = (id: unknown, lng: number, lat: number, isPano = true, sequence: string | null = null) =>
  ({ id, computed_geometry: { coordinates: [lng, lat] }, is_pano: isPano,
     ...(sequence === null ? {} : { sequence }) });

describe('bboxAround', () => {
  it('builds a west,south,east,north bbox', () => {
    const [w, s, e, n] = bboxAround(-77.307, 38.845, 50).split(',').map(Number);
    expect(w).toBeLessThan(-77.307); expect(e).toBeGreaterThan(-77.307);
    expect(s).toBeLessThan(38.845); expect(n).toBeGreaterThan(38.845);
  });
});

describe('haversineM', () => {
  it('measures a known distance', () => {
    expect(haversineM(-77.307, 38.845, -77.307, 38.8459)).toBeCloseTo(100, 0);
  });
});

describe('rankCandidates', () => {
  it('takes the camera position, never the query point', () => {
    const [c] = rankCandidates(
      [{ id: 7, computed_geometry: { coordinates: [-77.30, 38.84] },
         geometry: { coordinates: [-1, -1] }, is_pano: true }], -77.307, 38.845, true, 20);
    expect(c.lng).toBe(-77.30); expect(c.lat).toBe(38.84);
    expect(c.imageId).toBe('7');
  });

  it('falls back to geometry when computed_geometry is absent', () => {
    const [c] = rankCandidates(
      [{ id: 1, geometry: { coordinates: [-77.31, 38.85] }, is_pano: true }],
      -77.307, 38.845, true, 20);
    expect(c.lng).toBe(-77.31); expect(c.lat).toBe(38.85);
  });

  it('skips images with no geometry or no id rather than throwing', () => {
    const got = rankCandidates([
      { id: 1, is_pano: true },
      { computed_geometry: { coordinates: [-77.3, 38.84] }, is_pano: true },
      { id: 2, computed_geometry: { coordinates: 'nowhere' }, is_pano: true },
      { id: 3, computed_geometry: { coordinates: [-77.3] }, is_pano: true },
      { id: 4, computed_geometry: { coordinates: [null, 1] }, is_pano: true },
      null,
      at(5, -77.3, 38.84),
    ], -77.307, 38.845, true, 20);
    expect(got.map((c) => c.imageId)).toEqual(['5']);
  });

  it('puts true panoramas before flat images, then nearest first', () => {
    const got = rankCandidates([
      at('flat', -77.307, 38.845, false),
      at('far', -77.305, 38.845),
      at('near', -77.3069, 38.845),
    ], -77.307, 38.845, false, 20);
    expect(got.map((c) => c.imageId)).toEqual(['near', 'far', 'flat']);
  });

  it('carries the sequence id, and null when Mapillary omits it', () => {
    const [withSeq, without] = rankCandidates([
      at('a', -77.3069, 38.845, false, 'Q9GMfRjnXOskmoyDrIFabv'),
      at('b', -77.305, 38.845, false),
    ], -77.307, 38.845, false, 20);
    expect(withSeq.sequenceId).toBe('Q9GMfRjnXOskmoyDrIFabv');
    expect(without.sequenceId).toBeNull();
  });

  it('drops flat images when panoOnly', () => {
    const got = rankCandidates(
      [at('flat', -77.307, 38.845, false), at('pano', -77.307, 38.845)],
      -77.307, 38.845, true, 20);
    expect(got.map((c) => c.imageId)).toEqual(['pano']);
  });

  it('thins the near-identical frames out of the list it returns', () => {
    const images = Array.from({ length: 11 }, (_, i) => {
      const p = east(north(KRUMLOV, 57.5), i * 0.9);
      return { id: `k${i}`, computed_geometry: { coordinates: [p.lng, p.lat] },
               is_pano: false, sequence: 'dense' };
    });
    expect(rankCandidates(images, KRUMLOV.lng, KRUMLOV.lat, false, 20).map((c) => c.imageId))
      .toEqual(['k0']);
  });

  it('thins after the sort and before the limit, so the list still fills to 20', () => {
    // 25 distinct frames 15 m apart in one sequence: none is thinned, and 20
    // survive. Thinning a list already cut to 20 would return fewer.
    const images = Array.from({ length: 25 }, (_, i) => {
      const p = north(KRUMLOV, 20 + i * 15);
      return { id: `d${i}`, computed_geometry: { coordinates: [p.lng, p.lat] },
               is_pano: false, sequence: 'one-sequence' };
    });
    expect(rankCandidates(images, KRUMLOV.lng, KRUMLOV.lat, false, 20)).toHaveLength(20);
  });

  it('trims to the limit', () => {
    const imgs = [1, 2, 3].map((i) => at(i, -77.307 + i / 10000, 38.845));
    expect(rankCandidates(imgs, -77.307, 38.845, true, 2).map((c) => c.imageId)).toEqual(['1', '2']);
  });

  it('carries the metadata fields and rounds the distance to one decimal', () => {
    const [c] = rankCandidates([{
      id: 9, computed_geometry: { coordinates: [-77.3069, 38.845] }, is_pano: true,
      captured_at: 1700000000000, compass_angle: 123.5, thumb_256_url: 'https://x/t.jpg',
    }], -77.307, 38.845, true, 20);
    expect(c).toMatchObject({
      imageId: '9', isPano: true, capturedAt: 1700000000000, compassAngle: 123.5,
      thumbUrl: 'https://x/t.jpg',
    });
    // 0.0001 degrees of longitude at 38.845N is 8.67 m: rounded, 8.7.
    expect(c.distanceM).toBe(8.7);
  });
});

/**
 * Fixtures are built from the shapes the 2026-11-11 probe actually found
 * (design §1.1 and §9.1) rather than invented: the thinning rule exists
 * because of these numbers, so a test on different ones proves little.
 */
const KRUMLOV = { lng: 14.3153, lat: 48.8109 };
const RYE = { lng: 0.7311, lat: 50.9509 };
// Metres per degree of latitude under haversineM's own earth radius, so that a
// fixture placed "57.5 m north" measures 57.5 m when the thinner measures it.
// bboxAround's 111_320 is a different (and here wrong) constant: using it put
// a frame meant to be 10.0 m away at 9.99 m, on the wrong side of the rule.
const M_PER_DEG = (Math.PI * 6_371_000) / 180;
const north = (p: { lng: number; lat: number }, m: number) => ({ ...p, lat: p.lat + m / M_PER_DEG });
const east = (p: { lng: number; lat: number }, m: number) =>
  ({ ...p, lng: p.lng + m / (M_PER_DEG * Math.cos((p.lat * Math.PI) / 180)) });
const cand = (
  imageId: string, pos: { lng: number; lat: number },
  sequenceId: string | null, from: { lng: number; lat: number },
): PanoramaCandidate => ({
  imageId, ...pos, isPano: false, sequenceId, capturedAt: null, compassAngle: null,
  thumbUrl: null, distanceM: Math.round(haversineM(from.lng, from.lat, pos.lng, pos.lat) * 10) / 10,
});

describe('knownCompassAngle', () => {
  it("reads Mapillary's -1 as unknown, not as a bearing", () => {
    // 25 of Krumlov's 46 flat images report -1. A finite-number check passes
    // it and the usual normalisation yields 359: almost due north, stored on
    // no evidence whatever, and a legal bearing that every validation accepts.
    expect(knownCompassAngle(-1)).toBeNull();
    expect(knownCompassAngle(-0.0001)).toBeNull();
    expect(knownCompassAngle(-360)).toBeNull();
  });

  it('is null for an absent or unusable angle', () => {
    expect(knownCompassAngle(null)).toBeNull();
    expect(knownCompassAngle(undefined)).toBeNull();
    expect(knownCompassAngle(NaN)).toBeNull();
    expect(knownCompassAngle(Infinity)).toBeNull();
  });

  it('normalises a known angle into 0-360', () => {
    expect(knownCompassAngle(0)).toBe(0);
    expect(knownCompassAngle(293.97)).toBe(293.97);
    expect(knownCompassAngle(360)).toBe(0);
    expect(knownCompassAngle(400)).toBe(40);
  });
});

describe('thinBySpacing', () => {
  it("collapses Krumlov's 11 near-identical frames in one sequence to one", () => {
    // 57.5 m out, then 0.9 m apart along the street: all 11 inside 10 m of
    // the first, and all 11 would otherwise occupy over half the list.
    const frames = Array.from({ length: 11 }, (_, i) =>
      cand(`k${i}`, east(north(KRUMLOV, 57.5), i * 0.9), '9NrMXWUXTiSDWGqNL2irrA', KRUMLOV));
    // The probe found these spanning 57.5 m to 58.4 m from the query point.
    expect(frames[0].distanceM).toBeCloseTo(57.5, 1);
    expect(frames[10].distanceM).toBeLessThan(58.5);
    expect(thinBySpacing(frames).map((c) => c.imageId)).toEqual(['k0']);
  });

  it("leaves Rye's single sequence a usable spread along its street", () => {
    // 28 images, all one sequence, nearest 40 m; keeping one per sequence
    // would offer the author one candidate for the entire street.
    const frames = Array.from({ length: 28 }, (_, i) =>
      cand(`r${i}`, north(RYE, 40 + i * 6), 'Q9GMfRjnXOskmoyDrIFabv', RYE));
    // 6 m apart, so every other frame clears the 10 m rule: 14 of the 28.
    expect(thinBySpacing(frames).map((c) => c.imageId))
      .toEqual(['r0', 'r2', 'r4', 'r6', 'r8', 'r10', 'r12', 'r14', 'r16', 'r18', 'r20', 'r22', 'r24', 'r26']);
  });

  it('keeps two frames 0.9 m apart in DIFFERENT sequences', () => {
    const a = cand('953230175442807', north(KRUMLOV, 23), '9NrMXWUXTiSDWGqNL2irrA', KRUMLOV);
    const b = cand('514486621381530', north(KRUMLOV, 23.9), 'dOwlXaqhImEkvyRAMYgPUW', KRUMLOV);
    expect(thinBySpacing([a, b]).map((c) => c.imageId)).toEqual([a.imageId, b.imageId]);
  });

  it('never thins candidates with no sequence id', () => {
    // Two nulls are not "the same sequence": Graph can omit the field, and
    // collapsing on it would leave one candidate for every such image.
    const frames = Array.from({ length: 5 }, (_, i) =>
      cand(`n${i}`, east(north(KRUMLOV, 57.5), i * 0.9), null, KRUMLOV));
    expect(thinBySpacing(frames)).toHaveLength(5);
  });

  it('cannot thin a sparse site at all', () => {
    const frames = [0, 1, 2].map((i) =>
      cand(`s${i}`, north(KRUMLOV, 20 + i * 11), 'one-sequence', KRUMLOV));
    expect(thinBySpacing(frames)).toHaveLength(3);
  });

  it('measures between the candidates themselves, not between their distances', () => {
    // Both are 23.0 m from the query point and 0.9 m from each other: a rule
    // reading distanceM would see a gap of zero and drop one of a pair that
    // is genuinely one vantage point, or keep a pair that is not.
    const a = cand('a', north(KRUMLOV, 23), 'seq', KRUMLOV);
    const b = cand('b', east(north(KRUMLOV, 22.98), 0.9), 'seq', KRUMLOV);
    expect(a.distanceM).toBe(b.distanceM);
    expect(thinBySpacing([a, b]).map((c) => c.imageId)).toEqual(['a']);
  });
});

describe('MapillarySearch', () => {
  let search: MapillarySearch;
  let http: HttpTestingController;
  let config: ConfigStore;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    search = TestBed.inject(MapillarySearch);
    http = TestBed.inject(HttpTestingController);
    config = TestBed.inject(ConfigStore);
  });

  it('asks Mapillary directly, with the token and the panorama fields', async () => {
    config.set({ mapillaryToken: 'MLY|t' } as never);
    const p = search.panoramas(-77.307, 38.845);
    const req = http.expectOne((r) => r.url === 'https://graph.mapillary.com/images');
    expect(req.request.method).toBe('GET');
    expect(req.request.params.get('access_token')).toBe('MLY|t');
    expect(req.request.params.get('fields')).toContain('computed_geometry');
    expect(req.request.params.get('fields')).toContain('thumb_256_url');
    expect(req.request.params.get('limit')).toBe('500');
    expect(req.request.params.get('bbox')!.split(',')).toHaveLength(4);
    req.flush({ data: [at(1, -77.3069, 38.845)] });
    expect((await p).map((c) => c.imageId)).toEqual(['1']);
  });

  it('asks for the sequence, and lists flat imagery without being asked to', async () => {
    config.set({ mapillaryToken: 'MLY|t' } as never);
    const p = search.panoramas(14.3153, 48.8109);
    const req = http.expectOne((r) => r.url === 'https://graph.mapillary.com/images');
    expect(req.request.params.get('fields')).toContain('sequence');
    // Český Krumlov: 46 flat images, no panoramas. Today this list is empty.
    req.flush({ data: [at('304177654440052', 14.3153, 48.8110, false, 'KkmbK5LiUsI_cQBJ6LuHpw')] });
    expect((await p).map((c) => c.imageId)).toEqual(['304177654440052']);
  });

  it('explains itself when no token is configured, without asking Mapillary', async () => {
    await expect(search.panoramas(1, 2)).rejects.toThrow(/Mapillary token/);
    http.expectNone(() => true);
  });

  it('rejects with a readable message when Mapillary refuses', async () => {
    config.set({ mapillaryToken: 'bad' } as never);
    const p = search.panoramas(1, 2);
    http.expectOne((r) => r.url === 'https://graph.mapillary.com/images').flush(
      { error: { message: 'Invalid OAuth access token.' } },
      { status: 400, statusText: 'Bad Request' });
    await expect(p).rejects.toThrow('Invalid OAuth access token.');
  });

  afterEach(() => vi.useRealTimers());

  it('gives up after 15 seconds so the search button is not stuck', async () => {
    vi.useFakeTimers();
    config.set({ mapillaryToken: 't' } as never);
    const p = search.panoramas(1, 2);
    const assertion = expect(p).rejects.toThrow(/timed out/);
    http.expectOne((r) => r.url === 'https://graph.mapillary.com/images');
    await vi.advanceTimersByTimeAsync(14_999);
    await vi.advanceTimersByTimeAsync(2);
    await assertion;
  });

  it('says so when Mapillary cannot be reached', async () => {
    config.set({ mapillaryToken: 't' } as never);
    const p = search.panoramas(1, 2);
    http.expectOne((r) => r.url === 'https://graph.mapillary.com/images').error(new ProgressEvent('error'));
    await expect(p).rejects.toThrow(/could not reach Mapillary/);
  });
});
