import { describe, expect, it, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { SessionApi } from './session-api';
import type { Tour } from './tour.models';

function tour(): Tour {
  return {
    id: 't', schemaVersion: 2, title: 'Old Town Fairfax', description: '',
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
    const b = api.uploadMedia(new File(['x'], 'a.jpg'));
    http.expectOne('/api/session/media').error(new ProgressEvent('error'));
    await expect(b).rejects.toThrow(/could not reach/i);
  });
});
