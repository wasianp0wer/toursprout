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
import { creditLine } from '../core/credit';
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

  it('is schema v2', () => {
    expect(TOUR.schemaVersion).toBe(2);
  });

  it('gives every one of the fifteen overlays a display', () => {
    const overlays = store.stops().flatMap((s) => s.overlays);
    expect(overlays).toHaveLength(15);
    for (const ov of overlays) {
      expect(ov.display).toBeDefined();
    }
  });

  it('has exactly two inWorld overlays across the whole tour', () => {
    const inWorld = store.stops()
      .flatMap((s) => s.overlays)
      .filter((o) => o.display.mode === 'inWorld');
    expect(inWorld).toHaveLength(2);
  });

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
        expect(credit?.textContent?.trim()).toBe(creditLine(ov.credit).attribution);
      }
    }
  });

  it('every stop carries narration pointing at the media endpoint', () => {
    for (let i = 0; i < 6; i++) {
      store.goTo(i);
      const audio = store.overlaysForCurrentStop().find((o) => o.kind === 'audio');
      expect(audio, `stop ${i + 1} has no narration`).toBeDefined();
      store.selectOverlay(audio!.id);
      const source = render().querySelector('audio source');
      expect(source?.getAttribute('src')).toMatch(
        /^tour-data\/media\/narration-.+\.m4a$/,
      );
      expect(source?.getAttribute('type')).toBe('audio/mp4');
    }
  });

  it('renders the archival photograph on the courthouse stop', () => {
    store.goTo(0);
    const image = store
      .overlaysForCurrentStop()
      .find((o) => o.kind === 'image' && o.display.mode === 'marker');
    expect(image).toBeDefined();
    store.selectOverlay(image!.id);
    const img = render().querySelector('img');
    expect(img?.getAttribute('src')).toBe('tour-data/media/courthouse-photo.jpg');
    expect(image!.credit.type).toBe('sourced');
    expect(image!.credit.type === 'sourced' && image!.credit.source).toBe('Library of Congress');
  });

  it('labels synthesized narration honestly rather than as an archival recording', () => {
    store.goTo(0);
    const audio = store.overlaysForCurrentStop().find((o) => o.kind === 'audio');
    expect(creditLine(audio!.credit).attribution.toLowerCase()).toContain('synthesized');
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

  it('the courthouse carries inWorld comparison photographs from more than one era', () => {
    store.goTo(0);
    const inWorld = store.overlaysForCurrentStop().filter((o) => o.display.mode === 'inWorld');
    expect(inWorld.length).toBeGreaterThanOrEqual(2);
  });

  it('every inWorld overlay has a display with a real size and heading', () => {
    for (let i = 0; i < 6; i++) {
      store.goTo(i);
      for (const ov of store.overlaysForCurrentStop()) {
        if (ov.display.mode !== 'inWorld') continue;
        expect(ov.display.widthM).toBeGreaterThan(0);
        expect(ov.display.heightM).toBeGreaterThan(0);
        expect(ov.display.headingDeg).toBeGreaterThanOrEqual(0);
        expect(ov.display.headingDeg).toBeLessThan(360);
      }
    }
  });

  it('every inWorld overlay stands within a short walk of its stop', () => {
    for (const stop of store.stops()) {
      for (const ov of stop.overlays) {
        if (ov.display.mode !== 'inWorld') continue;
        expect(Math.abs(ov.anchor.lng - stop.location.lng)).toBeLessThan(0.002);
        expect(Math.abs(ov.anchor.lat - stop.location.lat)).toBeLessThan(0.002);
      }
    }
  });

  it('every inWorld overlay credits a named archive and the matched item', () => {
    for (const stop of store.stops()) {
      for (const ov of stop.overlays) {
        if (ov.display.mode !== 'inWorld') continue;
        expect(ov.credit.type).toBe('sourced');
        if (ov.credit.type === 'sourced') {
          expect(ov.credit.source).toContain('Library of Congress');
          expect(ov.credit.creator?.length ?? 0).toBeGreaterThan(0);
        }
      }
    }
  });

  it('archive credits name the matched item, not just the archive', () => {
    store.goTo(0);
    const inWorldOverlay = store
      .overlaysForCurrentStop()
      .find((o) => o.display.mode === 'inWorld')!;
    expect(inWorldOverlay.credit.type).toBe('sourced');
    if (inWorldOverlay.credit.type === 'sourced') {
      expect(inWorldOverlay.credit.creator).toMatch(/Fairfax/i);
    }
  });

  it('walking to a stop advances the tour, as the panorama would', () => {
    store.goTo(0);
    store.updateViewerPosition(store.stops()[2].location);
    expect(store.currentIndex()).toBe(2);
  });

  it('every stop except the last exposes a bearing to walk toward', () => {
    for (let i = 0; i < 5; i++) {
      store.goTo(i);
      store.updateViewerPosition(store.stops()[i].location);
      expect(store.bearingToNextStop()).not.toBeNull();
    }
    store.goTo(5);
    store.updateViewerPosition(store.stops()[5].location);
    expect(store.bearingToNextStop()).toBeNull();
  });

  it('the comparison slider is offered only where there is something to compare', () => {
    store.goTo(0);
    expect(store.hasInWorldOverlays()).toBe(true);
    store.goTo(1);
    expect(store.hasInWorldOverlays()).toBe(false);
  });
});
