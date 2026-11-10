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

  it('looks up an address and unwraps the results', async () => {
    const results = [
      { name: 'Fairfax County Courthouse', lng: -77.3064, lat: 38.8462, osmRef: 'way/123' },
      { name: 'Somewhere else', lng: -77.3, lat: 38.8, osmRef: null },
    ];
    const p = api.geocode('Fairfax Courthouse');
    const r = http.expectOne('/api/tools/geocode');
    expect(r.request.method).toBe('POST');
    expect(r.request.body).toEqual({ query: 'Fairfax Courthouse' });
    r.flush({ results });
    expect(await p).toEqual(results);
  });

  it('rejects with the backend message verbatim (502 upstream)', async () => {
    const p = api.geocode('Fairfax');
    http.expectOne('/api/tools/geocode').flush(
      { detail: 'the address lookup failed: timed out' }, { status: 502, statusText: 'Bad Gateway' });
    await expect(p).rejects.toThrow('the address lookup failed: timed out');
  });

  it('says so when the server cannot be reached or gives no message', async () => {
    const p = api.geocode('Fairfax');
    http.expectOne('/api/tools/geocode').error(new ProgressEvent('error'), { status: 0 });
    await expect(p).rejects.toThrow(/could not reach the server/);
    const q = api.geocode('Fairfax');
    http.expectOne('/api/tools/geocode').flush({ detail: [{ msg: 'bad' }] }, { status: 422, statusText: 'x' });
    await expect(q).rejects.toThrow(/422/);
  });

  it('no longer offers the places search', () => {
    expect((api as unknown as { places?: unknown }).places).toBeUndefined();
  });
});
