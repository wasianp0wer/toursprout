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
});
