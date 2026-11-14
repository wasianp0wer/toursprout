import { describe, expect, it, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { StopPanel } from './stop-panel';
import { TourStore } from '../core/tour-store';
import type { Overlay, Tour } from '../core/tour.models';

const CREDIT = {
  type: 'sourced' as const,
  source: 'Library of Congress',
  url: 'https://loc.gov/x',
  license: 'No known restrictions',
  creator: 'National Photo Company',
};

function overlay(over: Partial<Overlay> = {}): Overlay {
  return {
    id: 'ov-1',
    kind: 'text',
    anchor: { type: 'geo', lng: -77.3, lat: 38.84, altitudeM: 2 },
    display: { mode: 'marker', icon: 'note' },
    title: 'The 1800 Courthouse',
    body: 'Built in 1800.',
    mediaId: null,
    credit: CREDIT,
    ...over,
  } as Overlay;
}

function tour(overlays: Overlay[]): Tour {
  return {
    id: 't', schemaVersion: 4, title: 'Old Town Fairfax', description: '',
    defaults: null, attribution: [],
    stops: [{
      id: 's1', order: 1, title: 'Historic Courthouse',
      summary: 'The county seat since 1800.',
      location: { lng: -77.3, lat: 38.84 }, osmRef: null,
      panorama: { provider: 'mapillary', imageId: 'i', bearing: 0, cachedMediaId: null },
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
    expect(render().querySelector('audio')).not.toBeNull();
  });

  // I2: a published static site has no FastAPI process to apply
  // `mimetypes.add_type`, and some static hosts answer `.m4a` with
  // "audio/mp4a-latm" (not a browser-recognised container) rather than
  // "audio/mp4". The `<audio>` tag itself carries no `[src]`/`type` any
  // more; the `<source>` child supplies a browser-recognised type derived
  // from the mediaId, so playback does not depend on the host's MIME table.
  it('gives an .m4a overlay a source with a browser-recognised type', () => {
    store.load(tour([overlay({ id: 'ov-a', kind: 'audio', body: null, mediaId: 'narration-s1.m4a' })]));
    store.selectOverlay('ov-a');
    const source = render().querySelector('audio source');
    expect(source?.getAttribute('src')).toBe('tour-data/media/narration-s1.m4a');
    expect(source?.getAttribute('type')).toBe('audio/mp4');
  });

  it('renders an img for image overlays', () => {
    store.load(tour([overlay({ id: 'ov-i', kind: 'image', body: null, mediaId: 'photo.jpg' })]));
    store.selectOverlay('ov-i');
    expect(render().querySelector('img')?.getAttribute('src')).toBe('tour-data/media/photo.jpg');
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

  const IN_WORLD_PHOTO = {
    id: 'court-1863', kind: 'image' as const,
    anchor: { type: 'geo' as const, lng: -77.3, lat: 38.8, altitudeM: 6 },
    display: { mode: 'inWorld' as const, opacity: 0.7,
               headingDeg: 200, widthM: 18, heightM: 14 },
    title: 'Fairfax Court House, 1863', body: null, mediaId: 'court-1863.jpg',
    credit: CREDIT,
  };

  it('shows no comparison slider when the stop has no in-world photograph', () => {
    store.load(tour([overlay()]));
    expect(render().querySelector('[data-in-world-opacity]')).toBeNull();
  });

  it('shows the comparison slider when the stop has an in-world photograph', () => {
    store.load(tour([IN_WORLD_PHOTO as never]));
    expect(render().querySelector('[data-in-world-opacity]')).not.toBeNull();
  });

  it('labels the slider ends then and now', () => {
    store.load(tour([IN_WORLD_PHOTO as never]));
    const text = render().textContent ?? '';
    expect(text).toContain('then');
    expect(text).toContain('now');
  });

  it('moving the slider updates that photograph only', () => {
    store.load(tour([IN_WORLD_PHOTO as never]));
    const slider = render().querySelector<HTMLInputElement>('[data-in-world-opacity]')!;
    slider.value = '0.25';
    slider.dispatchEvent(new Event('input'));
    expect(store.opacityFor('court-1863')).toBeCloseTo(0.25, 3);
  });

  const IN_WORLD_PHOTO_2 = {
    ...IN_WORLD_PHOTO, id: 'court-1918', title: 'Fairfax Court House, about 1918',
    display: { ...IN_WORLD_PHOTO.display, opacity: 0 },
  };

  it('gives every photograph its own slider', () => {
    store.load(tour([IN_WORLD_PHOTO as never, IN_WORLD_PHOTO_2 as never]));
    expect(render().querySelectorAll('[data-in-world-opacity]')).toHaveLength(2);
  });

  it('labels each slider with its photograph', () => {
    store.load(tour([IN_WORLD_PHOTO as never, IN_WORLD_PHOTO_2 as never]));
    const text = render().textContent ?? '';
    expect(text).toContain('Fairfax Court House, 1863');
    expect(text).toContain('Fairfax Court House, about 1918');
  });

  it('moves one photograph without disturbing the other', () => {
    store.load(tour([IN_WORLD_PHOTO as never, IN_WORLD_PHOTO_2 as never]));
    const el = render();
    const second = el.querySelectorAll<HTMLInputElement>('[data-in-world-opacity]')[1];
    second.value = '0.9';
    second.dispatchEvent(new Event('input'));
    expect(store.opacityFor('court-1918')).toBeCloseTo(0.9, 3);
    expect(store.opacityFor('court-1863')).toBeCloseTo(0.7, 3);
  });

  it('opens with the first photograph showing and the second hidden', () => {
    store.load(tour([IN_WORLD_PHOTO as never, IN_WORLD_PHOTO_2 as never]));
    const sliders = render().querySelectorAll<HTMLInputElement>('[data-in-world-opacity]');
    expect(Number(sliders[0].value)).toBeCloseTo(0.7, 3);
    expect(Number(sliders[1].value)).toBe(0);
  });

  // Pinned, not endorsed (docs/decisions/0001-three-axes-for-overlays.md,
  // "Costs"; docs/HANDOFF.md, Outstanding item 7). v1's badge read REPHOTO
  // and its `@switch` had no case for that kind, so selecting one of these
  // rendered title and credit only. v2 has no 'rephoto' kind -- this overlay
  // is 'image' -- so the badge now reads IMAGE and selecting it also shows
  // an <img>, on top of the plane already ghosted into the panorama. Both
  // are arguably improvements; nobody has decided, so these tests make the
  // current, accidental behaviour explicit rather than leaving it to drift.
  it('badges an in-world image overlay as image, same as a marker image', () => {
    store.load(tour([IN_WORLD_PHOTO as never]));
    const badge = render().querySelector('[data-overlay-item] .kind');
    expect(badge?.textContent?.trim()).toBe('image');
  });

  it('selecting an in-world image overlay also renders an img thumbnail', () => {
    store.load(tour([IN_WORLD_PHOTO as never]));
    store.selectOverlay('court-1863');
    const img = render().querySelector<HTMLImageElement>('.overlay-detail img');
    expect(img?.getAttribute('src')).toBe('tour-data/media/court-1863.jpg');
  });
});
