import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { SessionApi } from './session-api';
import type { Tour } from './tour.models';

function tour(): Tour {
  return {
    id: 't', schemaVersion: 5, title: 'Old Town Fairfax', description: '',
    defaults: null, attribution: [], stops: [],
  } as unknown as Tour;
}

describe('SessionApi', () => {
  let api: SessionApi;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    api = TestBed.inject(SessionApi);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('gets the session summary', async () => {
    const promise = api.get();
    const req = http.expectOne('/api/session');
    expect(req.request.method).toBe('GET');
    req.flush({ open: true, title: 'My Tour' });
    expect((await promise).title).toBe('My Tour');
  });

  it('puts the tour document and returns the updated summary', async () => {
    const doc = tour();
    const promise = api.putTour(doc);
    const req = http.expectOne('/api/session/tour');
    expect(req.request.method).toBe('PUT');
    expect(req.request.body).toBe(doc);
    req.flush({ open: true, title: 'Old Town Fairfax' });
    expect((await promise).title).toBe('Old Town Fairfax');
  });

  it('starts a new tour with the given title', async () => {
    const promise = api.newTour('Untitled tour');
    const req = http.expectOne('/api/session/new');
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({ title: 'Untitled tour' });
    req.flush({ open: true, title: 'Untitled tour' });
    expect((await promise).title).toBe('Untitled tour');
  });

  it('surfaces the backend detail when a new tour conflicts with an open one', async () => {
    const p = api.newTour('x');
    http.expectOne('/api/session/new')
        .flush({ detail: 'a tour is already open' }, { status: 409, statusText: 'Conflict' });
    await expect(p).rejects.toThrow('a tour is already open');
  });

  it('uploads a file as multipart and returns the server-chosen mediaId', async () => {
    const file = new File([new Uint8Array([1, 2, 3])], 'pic.jpg', { type: 'image/jpeg' });
    const promise = api.uploadMedia(file);
    const req = http.expectOne('/api/session/media');
    expect(req.request.method).toBe('POST');
    const body = req.request.body as FormData;
    expect(body.get('file')).toBeInstanceOf(File);
    expect((body.get('file') as File).name).toBe('pic.jpg');
    req.flush({ open: true, mediaId: 'pic-abc123.jpg' });
    expect(await promise).toBe('pic-abc123.jpg');
  });

  it('turns a refusal into an Error carrying the backend message', async () => {
    const promise = api.uploadMedia(new File(['x'], 'a.exe'));
    http.expectOne('/api/session/media').flush(
      { detail: 'that file type is not allowed' }, { status: 400, statusText: 'Bad Request' });
    await expect(promise).rejects.toThrow('that file type is not allowed');
  });

  it('gives a useful message for a 413 and for an unreachable server', async () => {
    const a = api.uploadMedia(new File(['x'], 'a.jpg'));
    http.expectOne('/api/session/media').flush('', { status: 413, statusText: 'Payload Too Large' });
    await expect(a).rejects.toThrow(/too large/i);
    expect(await a.catch(e => e.message)).not.toMatch(/upload/i);
    const b = api.uploadMedia(new File(['x'], 'a.jpg'));
    http.expectOne('/api/session/media').error(new ProgressEvent('error'));
    await expect(b).rejects.toThrow(/could not reach/i);
  });

  it('closes the open tour with a DELETE', async () => {
    const promise = api.close();
    const req = http.expectOne('/api/session');
    expect(req.request.method).toBe('DELETE');
    req.flush({ open: false });
    expect((await promise).open).toBe(false);
  });

  it('lists the examples, unwrapping the envelope', async () => {
    const promise = api.listExamples();
    const req = http.expectOne('/api/session/examples');
    expect(req.request.method).toBe('GET');
    req.flush({ examples: [{ id: 'fairfax-old-town', title: 'Old Town', description: 'd' }] });
    expect(await promise).toEqual([{ id: 'fairfax-old-town', title: 'Old Town', description: 'd' }]);
  });

  it('opens an example by id and returns its warnings', async () => {
    const promise = api.openExample('fairfax-old-town');
    const req = http.expectOne('/api/session/examples/fairfax-old-town');
    expect(req.request.method).toBe('POST');
    req.flush({ open: true, title: 'Old Town', orphanCount: 6, warnings: ['w'] });
    const res = await promise;
    expect(res.orphanCount).toBe(6);
    expect(res.warnings).toEqual(['w']);
  });

  it('surfaces the backend detail when opening an example conflicts', async () => {
    const p = api.openExample('fairfax-old-town');
    http.expectOne('/api/session/examples/fairfax-old-town')
        .flush({ detail: 'a tour is already open' }, { status: 409, statusText: 'Conflict' });
    await expect(p).rejects.toThrow('a tour is already open');
  });

  it('imports a zip as multipart under the field `file`', async () => {
    const zip = new File(['z'], 'tour.zip', { type: 'application/zip' });
    const promise = api.importBundle(zip);
    const req = http.expectOne('/api/session/import');
    expect(req.request.method).toBe('POST');
    expect((req.request.body as FormData).get('file')).toBeInstanceOf(File);
    // And deliberately WITHOUT `force`. The route takes that flag to let a
    // caller discard an open tour on purpose, and the welcome screen is the
    // one caller that must never send it: it is shown only when nothing is
    // open, so a 409 from here means its view of the session is stale — a
    // second tab opened something — and refusing is the whole point.
    // Sending `force` to quieten that 409 would delete the other tab's only
    // copy of an unexported tour.
    expect((req.request.body as FormData).get('force')).toBeNull();
    req.flush({ open: true, title: 'Imported' });
    expect((await promise).title).toBe('Imported');
  });

  it('sends each loose part under its relative path', async () => {
    const promise = api.importFiles([
      { path: 'tour.json', file: new File(['{}'], 'tour.json') },
      { path: 'media/pano/p.jpg', file: new File([''], 'p.jpg') },
    ]);
    const req = http.expectOne('/api/session/import-files');
    expect(req.request.method).toBe('POST');
    const names = (req.request.body as FormData).getAll('files').map(f => (f as File).name);
    expect(names).toEqual(['tour.json', 'media/pano/p.jpg']);
    req.flush({ open: true, title: 'Loose' });
    expect((await promise).title).toBe('Loose');
  });

  it('exports the bundle as a blob', async () => {
    const promise = api.exportBundle();
    const req = http.expectOne('/api/session/export');
    expect(req.request.method).toBe('GET');
    expect(req.request.responseType).toBe('blob');
    req.flush(new Blob(['zipbytes']));
    expect((await promise).size).toBe(8);
  });

  it('turns a refused export, close and import into the backend message', async () => {
    const a = api.exportBundle();
    http.expectOne('/api/session/export').flush(
      new Blob([JSON.stringify({ detail: 'media is missing: media/x.jpg' })], { type: 'application/json' }),
      { status: 409, statusText: 'Conflict' });
    await expect(a).rejects.toThrow(/missing/);
    const b = api.close();
    http.expectOne('/api/session').flush(
      { detail: 'no tour is open' }, { status: 409, statusText: 'Conflict' });
    await expect(b).rejects.toThrow('no tour is open');
    const c = api.importFiles([]);
    http.expectOne('/api/session/import-files').error(new ProgressEvent('error'));
    await expect(c).rejects.toThrow(/could not reach/i);
  });

  it('reattaches by recovery key and returns the summary', async () => {
    const promise = api.reattach('0123456789abcdef');
    const req = http.expectOne('/api/session/reattach');
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({ key: '0123456789abcdef' });
    req.flush({ open: true, title: 'Lost', recoveryKey: '0123456789abcdef' });
    expect((await promise).title).toBe('Lost');
  });

  it('rejects a reattach with the backend\'s own words', async () => {
    const promise = api.reattach('0123456789abcdef');
    const rejects = expect(promise).rejects.toThrow('there is no tour with that recovery key');
    http.expectOne('/api/session/reattach').flush(
      { detail: 'there is no tour with that recovery key' },
      { status: 404, statusText: 'Not Found' });
    await rejects;
  });
});
