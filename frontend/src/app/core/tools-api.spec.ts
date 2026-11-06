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

  it('unwraps places', async () => {
    const pl = api.places(1, 2, ' Courthouse ');
    const r1 = http.expectOne('/api/tools/places');
    expect(r1.request.body).toEqual({ lng: 1, lat: 2, name: 'Courthouse' });
    r1.flush({ places: [{ name: 'X', osmRef: 'way/1', lng: 1, lat: 2 }] });
    expect((await pl)[0].osmRef).toBe('way/1');
  });

  it('rejects with the backend message verbatim (502 upstream)', async () => {
    const p = api.places(1, 2);
    http.expectOne('/api/tools/places').flush(
      { detail: 'Overpass is down' }, { status: 502, statusText: 'Bad Gateway' });
    await expect(p).rejects.toThrow('Overpass is down');
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
