import { describe, expect, it, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { StopPanel } from './stop-panel';
import { TourStore } from '../core/tour-store';
import type { Overlay, Tour } from '../core/tour.models';

const CREDIT = {
  source: 'Library of Congress',
  url: 'https://loc.gov/x',
  license: 'No known restrictions',
  creator: 'National Photo Company',
};

function overlay(over: Partial<Overlay> = {}): Overlay {
  return {
    id: 'ov-1',
    kind: 'text',
    anchor: { type: 'geo', lng: -77.3, lat: 38.84, altitude: 2 },
    title: 'The 1800 Courthouse',
    body: 'Built in 1800.',
    mediaId: null,
    credit: CREDIT,
    ...over,
  } as Overlay;
}

function tour(overlays: Overlay[]): Tour {
  return {
    id: 't', schemaVersion: 1, title: 'Old Town Fairfax', description: '', attribution: [],
    stops: [{
      id: 's1', order: 1, title: 'Historic Courthouse',
      summary: 'The county seat since 1800.',
      location: { lng: -77.3, lat: 38.84 }, osmRef: null,
      panorama: { provider: 'mapillary', imageId: 'i', bearing: 0, cachedPath: null },
      overlays,
    }],
  };
}

describe('StopPanel', () => {
  let store: TourStore;

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [StopPanel],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    store = TestBed.inject(TourStore);
  });

  function render(): HTMLElement {
    const fixture = TestBed.createComponent(StopPanel);
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  it('shows the current stop title and summary', () => {
    store.load(tour([overlay()]));
    const el = render();
    expect(el.textContent).toContain('Historic Courthouse');
    expect(el.textContent).toContain('The county seat since 1800.');
  });

  it('shows the stop position in the tour', () => {
    store.load(tour([overlay()]));
    expect(render().textContent).toContain('1 of 1');
  });

  it('renders the selected text overlay body', () => {
    store.load(tour([overlay()]));
    store.selectOverlay('ov-1');
    expect(render().textContent).toContain('Built in 1800.');
  });

  it('always renders the credit for a selected overlay', () => {
    store.load(tour([overlay()]));
    store.selectOverlay('ov-1');
    const text = render().textContent ?? '';
    expect(text).toContain('Library of Congress');
    expect(text).toContain('No known restrictions');
  });

  it('renders an audio element for audio overlays', () => {
    store.load(tour([overlay({ id: 'ov-a', kind: 'audio', body: null, mediaId: 'narration-s1.m4a' })]));
    store.selectOverlay('ov-a');
    expect(render().querySelector('audio')?.getAttribute('src')).toBe('/api/media/narration-s1.m4a');
  });

  it('renders an img for image overlays', () => {
    store.load(tour([overlay({ id: 'ov-i', kind: 'image', body: null, mediaId: 'photo.jpg' })]));
    store.selectOverlay('ov-i');
    expect(render().querySelector('img')?.getAttribute('src')).toBe('/api/media/photo.jpg');
  });

  it('lists every overlay on the stop so all content is reachable', () => {
    store.load(tour([overlay(), overlay({ id: 'ov-2', title: 'Second' })]));
    expect(render().querySelectorAll('[data-overlay-item]')).toHaveLength(2);
  });

  it('disables both controls on a single-stop tour', () => {
    store.load(tour([overlay()]));
    const el = render();
    expect(el.querySelector<HTMLButtonElement>('[data-prev]')?.disabled).toBe(true);
    expect(el.querySelector<HTMLButtonElement>('[data-next]')?.disabled).toBe(true);
  });

  it('shows no overlay detail until one is selected', () => {
    store.load(tour([overlay()]));
    expect(render().querySelector('.overlay-detail')).toBeNull();
  });
});
