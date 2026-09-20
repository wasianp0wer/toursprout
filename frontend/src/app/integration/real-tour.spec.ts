/**
 * Renders the actual committed tour document through the real components.
 *
 * Browser-driven end-to-end tests cannot run in this sandbox (see
 * docs/ENVIRONMENT.md), so this covers the same ground the Playwright suite
 * does for everything that is not WebGL: that the content the pipeline
 * produced parses, navigates, and renders with its credits intact.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { StopPanel } from '../stop/stop-panel';
import { TourStore } from '../core/tour-store';
import type { Tour } from '../core/tour.models';

const TOUR: Tour = JSON.parse(
  readFileSync(join(process.cwd(), '..', 'content', 'tours', 'fairfax-old-town.json'), 'utf8'),
);

describe('the real Fairfax tour', () => {
  let store: TourStore;

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [StopPanel],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    store = TestBed.inject(TourStore);
    store.load(TOUR);
  });

  function render(): HTMLElement {
    const fixture = TestBed.createComponent(StopPanel);
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  it('has six stops in walking order', () => {
    expect(store.stops()).toHaveLength(6);
    expect(store.stops().map((s) => s.order)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('opens on the Historic Courthouse', () => {
    expect(store.currentStop()?.title).toBe('Fairfax County Historic Courthouse');
    expect(render().textContent).toContain('1 of 6');
  });

  it('every stop has a Mapillary panorama id and a cached copy', () => {
    for (const stop of store.stops()) {
      expect(stop.panorama.provider).toBe('mapillary');
      expect(stop.panorama.imageId).toMatch(/^\d+$/);
      expect(stop.panorama.cachedPath).toMatch(/^media\/pano\/.+\.jpg$/);
    }
  });

  it('walks through all six stops and back', () => {
    for (let i = 1; i < 6; i++) {
      store.next();
      expect(store.currentIndex()).toBe(i);
    }
    expect(store.hasNext()).toBe(false);
    for (let i = 4; i >= 0; i--) {
      store.previous();
      expect(store.currentIndex()).toBe(i);
    }
    expect(store.hasPrevious()).toBe(false);
  });

  it('every overlay on every stop renders with a non-empty credit', () => {
    for (let i = 0; i < 6; i++) {
      store.goTo(i);
      const overlays = store.overlaysForCurrentStop();
      expect(overlays.length).toBeGreaterThan(0);

      for (const ov of overlays) {
        store.selectOverlay(ov.id);
        const el = render();
        const credit = el.querySelector('.overlay-detail .credit');
        expect(credit?.textContent?.trim()).toBeTruthy();
        expect(credit?.textContent).toContain(ov.credit.source);
      }
    }
  });

  it('every stop carries narration pointing at the media endpoint', () => {
    for (let i = 0; i < 6; i++) {
      store.goTo(i);
      const audio = store.overlaysForCurrentStop().find((o) => o.kind === 'audio');
      expect(audio, `stop ${i + 1} has no narration`).toBeDefined();
      store.selectOverlay(audio!.id);
      expect(render().querySelector('audio')?.getAttribute('src')).toMatch(
        /^\/api\/media\/narration-.+\.m4a$/,
      );
    }
  });

  it('renders the archival photograph on the courthouse stop', () => {
    store.goTo(0);
    const image = store.overlaysForCurrentStop().find((o) => o.kind === 'image');
    expect(image).toBeDefined();
    store.selectOverlay(image!.id);
    const img = render().querySelector('img');
    expect(img?.getAttribute('src')).toBe('/api/media/courthouse-photo.jpg');
    expect(image!.credit.source).toBe('Library of Congress');
  });

  it('labels synthesized narration honestly rather than as an archival recording', () => {
    store.goTo(0);
    const audio = store.overlaysForCurrentStop().find((o) => o.kind === 'audio');
    expect(audio!.credit.source.toLowerCase()).toContain('synthesized');
  });

  it('credits Mapillary and OpenStreetMap at the tour level', () => {
    const texts = TOUR.attribution.map((a) => a.text).join(' ');
    expect(texts).toContain('Mapillary');
    expect(texts).toContain('OpenStreetMap');
  });

  it('anchors every overlay within a short walk of its stop', () => {
    for (const stop of store.stops()) {
      for (const ov of stop.overlays) {
        expect(Math.abs(ov.anchor.lng - stop.location.lng)).toBeLessThan(0.001);
        expect(Math.abs(ov.anchor.lat - stop.location.lat)).toBeLessThan(0.001);
      }
    }
  });
});
