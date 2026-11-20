import { describe, expect, it, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ToolsApi, type OmekaFile, type OmekaSearch } from './tools-api';

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

  it('posts omeka-search and returns the payload', async () => {
    const payload: OmekaSearch = {
      site: { base: 'https://omeka.example', title: 'T' }, total: 0, page: 1, results: [],
    };
    const p = api.omekaSearch('omeka.example', 'courthouse');
    const r = http.expectOne('/api/tools/omeka-search');
    expect(r.request.method).toBe('POST');
    expect(r.request.body).toEqual({ siteUrl: 'omeka.example', query: 'courthouse', page: 1 });
    r.flush(payload);
    expect(await p).toEqual(payload);
  });

  it('posts omeka-files and unwraps the files', async () => {
    const files: OmekaFile[] = [{
      fileId: 9, kind: 'image', filename: 'a.jpg', thumbUrl: null, importable: true,
      reason: null, title: null, creator: null, rights: null,
    }];
    const p = api.omekaFiles('omeka.example', 3);
    const r = http.expectOne('/api/tools/omeka-files');
    expect(r.request.body).toEqual({ siteUrl: 'omeka.example', itemId: 3 });
    r.flush({ files });
    expect(await p).toEqual(files);
  });

  it('omekaImport resolves to mediaId', async () => {
    const p = api.omekaImport('omeka.example', 3, 9, 'A title');
    const r = http.expectOne('/api/tools/omeka-import');
    expect(r.request.body).toEqual({ siteUrl: 'omeka.example', itemId: 3, fileId: 9, title: 'A title' });
    r.flush({ mediaId: 'a-1.jpg' });
    expect(await p).toBe('a-1.jpg');
  });

  it('surfaces the server detail verbatim', async () => {
    const detail = 'The Omeka site at x has its API turned off. Ask the admin to enable it.';
    const p = api.omekaSearch('x', 'q');
    http.expectOne('/api/tools/omeka-search').flush({ detail }, { status: 409, statusText: 'Conflict' });
    await expect(p).rejects.toThrow(detail);
  });
});
