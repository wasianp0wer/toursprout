import { describe, expect, it, beforeEach } from 'vitest';
import { of } from 'rxjs';
import { TestBed } from '@angular/core/testing';
import { HttpClient, provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TourApi } from './tour-api';

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

  it('requests config', async () => {
    const promise = api.getConfig();
    http.expectOne('tour-data/config.json').flush({ mapillaryToken: 't', tileUrl: 'u', attribution: [] });
    expect((await promise).mapillaryToken).toBe('t');
  });

  it('builds media urls that hit the range-capable endpoint', () => {
    expect(api.mediaUrl('narration-x.m4a')).toBe('tour-data/media/narration-x.m4a');
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
