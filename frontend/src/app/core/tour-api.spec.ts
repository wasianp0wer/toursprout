import { describe, expect, it, beforeEach } from 'vitest';
import { of } from 'rxjs';
import { TestBed } from '@angular/core/testing';
import { HttpClient, provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TourApi, audioType } from './tour-api';

describe('TourApi', () => {
  let api: TourApi;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    api = TestBed.inject(TourApi);
    http = TestBed.inject(HttpTestingController);
  });

  it('requests the tour', async () => {
    const promise = api.getTour();
    const req = http.expectOne('tour-data/tour.json');
    expect(req.request.method).toBe('GET');
    req.flush({ id: 'fairfax-old-town', stops: [] });
    expect((await promise).id).toBe('fairfax-old-town');
  });

  it('refuses to read the document or the config out of the browser cache', () => {
    // The document lives at a FIXED url and changes under it, so a cached
    // copy is a different tour. Observed live: a browser held `tour.json`
    // from an earlier session under heuristic freshness — the response
    // carried validators but no `Cache-Control` — answered every
    // `getTour()` locally, and never contacted the server again. A hard
    // reload does not help, because it bypasses the cache for the page and
    // its subresources but NOT for requests the application makes
    // afterwards, so the editor loaded one tour while the session held
    // another and every autosave was refused.
    //
    // The server now sends `Cache-Control: no-cache`, but that only governs
    // responses stored from then on, and on a PUBLISHED site it is some
    // other host's static server answering and we set none of its headers.
    // Asking to revalidate from this side is the only guard that travels
    // with the application. `no-cache` still permits the 304 the route was
    // built for; it forbids using the copy without asking.
    //
    // Media is deliberately NOT included: a media id is a content hash, so
    // its url never means a different file and caching it is the point.
    for (const [call, url] of [
      [() => api.getTour(), 'tour-data/tour.json'],
      [() => api.getConfig(), 'tour-data/config.json'],
    ] as const) {
      call();
      const req = http.expectOne(url);
      expect(req.request.headers.get('Cache-Control'), url).toBe('no-cache');
      req.flush({});
    }
  });

  it('requests config', async () => {
    const promise = api.getConfig();
    http.expectOne('tour-data/config.json').flush({ mapillaryToken: 't', tileUrl: 'u', attribution: [] });
    expect((await promise).mapillaryToken).toBe('t');
  });

  it('builds media urls that hit the range-capable endpoint', () => {
    expect(api.mediaUrl('narration-x.m4a')).toBe('tour-data/media/narration-x.m4a');
  });

  it('names the MIME type for recorded WebM and Ogg audio', () => {
    expect(audioType('rec-abc.webm')).toBe('audio/webm');
    expect(audioType('rec-abc.ogg')).toBe('audio/ogg');
  });

  it('reads everything from tour-data/ and never touches /api', async () => {
    const seen: string[] = [];
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: HttpClient, useValue: { get: (url: string) => { seen.push(url); return of({}); } } },
      ],
    });
    const directApi = TestBed.inject(TourApi);

    await directApi.getConfig();
    await directApi.getTour();
    const mediaUrl = directApi.mediaUrl('court-1863.jpg');

    expect(seen).toEqual(['tour-data/config.json', 'tour-data/tour.json']);
    expect(mediaUrl).toBe('tour-data/media/court-1863.jpg');
    expect([...seen, mediaUrl].some((u) => u.includes('/api'))).toBe(false);
  });
});
