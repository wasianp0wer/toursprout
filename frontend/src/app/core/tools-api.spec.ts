import { describe, expect, it, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ToolsApi } from './tools-api';

describe('ToolsApi', () => {
  let api: ToolsApi;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    api = TestBed.inject(ToolsApi);
    http = TestBed.inject(HttpTestingController);
  });

  it('posts a panorama search and unwraps the candidates', async () => {
    const p = api.panoramas(-77.3, 38.84);
    const req = http.expectOne('/api/tools/panoramas');
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({ lng: -77.3, lat: 38.84 });
    req.flush({ candidates: [{ imageId: 'a', lng: 1, lat: 2 }] });
    expect((await p)[0].imageId).toBe('a');
  });

  it('unwraps places and archive results', async () => {
    const pl = api.places(1, 2, ' Courthouse ');
    const r1 = http.expectOne('/api/tools/places');
    expect(r1.request.body).toEqual({ lng: 1, lat: 2, name: 'Courthouse' });
    r1.flush({ places: [{ name: 'X', osmRef: 'way/1', lng: 1, lat: 2 }] });
    expect((await pl)[0].osmRef).toBe('way/1');

    const ar = api.archiveSearch('fairfax');
    const r2 = http.expectOne('/api/tools/archive-search');
    expect(r2.request.body).toEqual({ query: 'fairfax' });
    r2.flush({ results: [{ title: 'T', rights: null }] });
    expect((await ar)[0].rights).toBeNull();
  });

  it('asks the server to fetch an archive image and returns the stored mediaId', async () => {
    const p = api.archiveFetch('https://tile.loc.gov/1.jpg', 'Court House');
    const req = http.expectOne('/api/tools/archive-fetch');
    expect(req.request.body).toEqual({ imageUrl: 'https://tile.loc.gov/1.jpg', title: 'Court House' });
    req.flush({ mediaId: 'court-house-ab12.jpg' });
    expect(await p).toBe('court-house-ab12.jpg');
  });

  it('rejects with the backend message verbatim (502 upstream, 400 missing token)', async () => {
    const p = api.panoramas(1, 2);
    http.expectOne('/api/tools/panoramas').flush(
      { detail: 'Mapillary is not configured' }, { status: 400, statusText: 'Bad Request' });
    await expect(p).rejects.toThrow('Mapillary is not configured');
    const q = api.archiveSearch('x');
    http.expectOne('/api/tools/archive-search').flush(
      { detail: 'the Library of Congress timed out' }, { status: 502, statusText: 'Bad Gateway' });
    await expect(q).rejects.toThrow('the Library of Congress timed out');
  });

  it('says so when the server cannot be reached or gives no message', async () => {
    const p = api.places(1, 2);
    http.expectOne('/api/tools/places').error(new ProgressEvent('error'), { status: 0 });
    await expect(p).rejects.toThrow(/could not reach the server/);
    const q = api.places(1, 2);
    http.expectOne('/api/tools/places').flush({ detail: [{ msg: 'bad' }] }, { status: 422, statusText: 'x' });
    await expect(q).rejects.toThrow(/422/);
  });
});
