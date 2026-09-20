import { describe, expect, it, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
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

  it('requests the tour by id', async () => {
    const promise = api.getTour('fairfax-old-town');
    const req = http.expectOne('/api/tours/fairfax-old-town');
    expect(req.request.method).toBe('GET');
    req.flush({ id: 'fairfax-old-town', stops: [] });
    expect((await promise).id).toBe('fairfax-old-town');
  });

  it('requests config', async () => {
    const promise = api.getConfig();
    http.expectOne('/api/config').flush({ mapillaryToken: 't', tileUrl: 'u', attribution: [] });
    expect((await promise).mapillaryToken).toBe('t');
  });

  it('builds media urls that hit the range-capable endpoint', () => {
    expect(api.mediaUrl('narration-x.m4a')).toBe('/api/media/narration-x.m4a');
  });
});
