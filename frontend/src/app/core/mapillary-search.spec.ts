import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ConfigStore } from './config-store';
import { MapillarySearch, bboxAround, haversineM, rankCandidates } from './mapillary-search';

const at = (id: unknown, lng: number, lat: number, isPano = true) =>
  ({ id, computed_geometry: { coordinates: [lng, lat] }, is_pano: isPano });

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

  it('drops flat images when panoOnly', () => {
    const got = rankCandidates(
      [at('flat', -77.307, 38.845, false), at('pano', -77.307, 38.845)],
      -77.307, 38.845, true, 20);
    expect(got.map((c) => c.imageId)).toEqual(['pano']);
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
