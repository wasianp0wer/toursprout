import { beforeEach, describe, expect, it } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { EditPanoramaPane } from './edit-panorama-pane';
import { EditorStore } from './editor-store';
import { overlay, stop, tour } from './test-builders';
import { PANORAMA_VIEWER } from '../panorama/panorama-pane';
import { FakeViewer } from '../panorama/fake-viewer';
import { deriveHeading, panoramaFixForStop } from './document-ops';
import type { Overlay } from '../core/tour.models';

describe('EditPanoramaPane', () => {
  let fake: FakeViewer;
  let store: EditorStore;
  let fixture: ReturnType<typeof TestBed.createComponent<EditPanoramaPane>>;
  let el: HTMLElement;

  const q = (sel: string) => el.querySelector(sel) as HTMLElement | null;
  const settle = async () => { fixture.detectChanges(); await fixture.whenStable(); fixture.detectChanges(); };
  const key = (k: string, init: KeyboardEventInit = {}, target: EventTarget = document) => {
    const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init });
    target.dispatchEvent(e);
    return e;
  };

  const photo = (id = 'o1'): Overlay => overlay(id, {
    kind: 'image', mediaId: 'p.jpg',
    anchor: { type: 'geo', lng: -77.3065, lat: 38.8456, altitudeM: 2 },
    display: { mode: 'inWorld', opacity: 0.8, headingDeg: 40, widthM: 6, heightM: 3 },
  });
  const note = (id = 'n1'): Overlay => overlay(id);
  const o1 = () => store.draft()!.stops[0].overlays.find((o) => o.id === 'o1')!;
  const disp = () => o1().display as { headingDeg: number; widthM: number; heightM: number; opacity: number };
  const lastPlacements = () => fake.inWorldPlacements[fake.inWorldPlacements.length - 1];

  const start = async (overlays: Overlay[], selected: string | null = 's1') => {
    store.load(tour([stop('s1', 1, overlays), stop('s2', 2, [])]));
    if (selected) store.select(selected);
    fixture = TestBed.createComponent(EditPanoramaPane);
    el = fixture.nativeElement;
    await settle();
  };

  beforeEach(() => {
    fake = new FakeViewer();
    TestBed.configureTestingModule({
      imports: [EditPanoramaPane],
      providers: [{ provide: PANORAMA_VIEWER, useValue: fake }],
    });
    store = TestBed.inject(EditorStore);
  });

  describe('rendering', () => {
    it('attaches and loads the current stop panorama', async () => {
      await start([photo()]);
      expect(fake.attachedTo).toBeTruthy();
      expect(fake.loaded).toEqual([{ imageId: 'img-1', bearing: 90 }]);
    });

    it('shows a hint and loads nothing when no stop is selected', async () => {
      await start([photo()], null);
      expect(q('[data-pano-empty]')).toBeTruthy();
      expect(fake.loaded).toEqual([]);
    });

    it('loads the new panorama when the selection moves to another stop', async () => {
      await start([photo()]);
      store.select('s2');
      await settle();
      expect(fake.loaded.map((l) => l.imageId)).toEqual(['img-1', 'img-2']);
    });

    it('does not reload the panorama when an overlay is edited', async () => {
      await start([photo()], 'o1');
      key('ArrowUp');
      key('ArrowUp');
      await settle();
      expect(fake.loaded).toHaveLength(1);
    });

    it('drapes inWorld overlays and marks the rest', async () => {
      await start([photo(), note()]);
      expect(lastPlacements().map((p) => p.id)).toEqual(['o1']);
      const markers = fake.markers[fake.markers.length - 1];
      expect(markers.map((m) => m.id)).toContain('n1');
    });

    it('reports a load failure instead of breaking', async () => {
      fake.failNextLoad = true;
      await start([photo()]);
      await new Promise((r) => setTimeout(r));
      await settle();
      expect(q('[data-pano-error]')).toBeTruthy();
    });

    it('destroys the viewer with the pane', async () => {
      await start([photo()]);
      fixture.destroy();
      expect(fake.destroyed).toBe(true);
    });
  });

  describe('the panorama position (the seam that turns the editor on)', () => {
    it('publishes the position keyed by the image the viewer reports as loaded', async () => {
      await start([photo()]);
      fake.emitPositionChange({ lng: -77.3069, lat: 38.8455 }, 'img-1');
      expect(store.panoramaPosition()).toEqual({ imageId: 'img-1', lng: -77.3069, lat: 38.8455 });
      expect(panoramaFixForStop(store.currentStop(), store.panoramaPosition())).toBeTruthy();
    });

    it('keys by the LOADED image, not the requested one', async () => {
      // The viewer was asked for img-1 but reports having landed on another image
      // (walked a step, or mapillary substituted). The fix must say so, and the
      // gate must then refuse it for this stop.
      await start([photo()]);
      fake.emitPositionChange({ lng: -77.31, lat: 38.846 }, 'img-neighbour');
      expect(store.panoramaPosition()?.imageId).toBe('img-neighbour');
      expect(panoramaFixForStop(store.currentStop(), store.panoramaPosition())).toBeNull();
    });

    it("publishes the viewer's imagery report, so the map can draw an honest wedge", async () => {
      await start([photo()]);
      const report = { imageId: 'img-1', cameraType: 'perspective', compassAngle: -1 };
      fake.emitImageryReport(report);
      expect(store.imageryReport()).toEqual(report);
    });

    it('publishes a report for the LOADED image, even when it is not this stop\'s', async () => {
      // Walking a step away is a real move; the report says which image it is
      // about, and wedgeFor is what refuses it for this stop.
      await start([photo()]);
      fake.emitImageryReport({ imageId: 'img-neighbour', cameraType: 'spherical', compassAngle: 12 });
      expect(store.imageryReport()!.imageId).toBe('img-neighbour');
    });

    it('does not mark a requested image as loaded before the viewer reports it', async () => {
      await start([photo()]);
      expect(fake.loaded).toHaveLength(1);
      expect(store.panoramaPosition()).toBeNull();
    });

    it('never offers the stop location as a position', async () => {
      await start([photo()]);
      expect(store.panoramaPosition()).toBeNull();
    });
  });

  describe('keyboard nudging of the selected inWorld overlay', () => {
    it('moves it north, south, east and west through the document', async () => {
      await start([photo()], 'o1');
      const a = o1().anchor;
      key('ArrowUp'); expect(o1().anchor.lat).toBeGreaterThan(a.lat);
      key('ArrowDown'); key('ArrowDown'); expect(o1().anchor.lat).toBeLessThan(a.lat);
      key('ArrowRight'); expect(o1().anchor.lng).toBeGreaterThan(a.lng);
      key('ArrowLeft'); key('ArrowLeft'); expect(o1().anchor.lng).toBeLessThan(a.lng);
    });

    it('raises and lowers with z and c', async () => {
      await start([photo()], 'o1');
      key('z'); expect(o1().anchor.altitudeM).toBe(3);
      key('c'); key('c'); expect(o1().anchor.altitudeM).toBe(1);
    });

    it('resizes with + and - preserving aspect', async () => {
      await start([photo()], 'o1');
      key('+');
      expect(disp().widthM).toBeGreaterThan(6);
      expect(disp().widthM / disp().heightM).toBeCloseTo(2, 6);
    });

    it('never touches heading: [ and ] are not handled, heading is derived only', async () => {
      await start([photo()], 'o1');
      const e = key(']');
      key('[');
      expect(disp().headingDeg).toBe(40);
      expect(e.defaultPrevented).toBe(false);
    });

    it('makes each keypress one undoable edit', async () => {
      await start([photo()], 'o1');
      const before = o1().anchor.lat;
      key('ArrowUp');
      store.undo();
      expect(o1().anchor.lat).toBe(before);
    });

    it('prevents default only for keys it handles', async () => {
      await start([photo()], 'o1');
      expect(key('ArrowUp').defaultPrevented).toBe(true);
      expect(key('q').defaultPrevented).toBe(false);
    });

    it('does nothing when no overlay, or a marker overlay, is selected', async () => {
      await start([photo(), note()], 'n1');
      const before = store.draft();
      expect(key('ArrowUp').defaultPrevented).toBe(false);
      store.select('s1');
      key('ArrowUp');
      expect(store.draft()).toBe(before);
    });

    it('ignores keys typed into an input, so the inspector keeps its arrow keys', async () => {
      await start([photo()], 'o1');
      const input = document.createElement('input');
      document.body.appendChild(input);
      const before = store.draft();
      const e = key('ArrowUp', {}, input);
      input.remove();
      expect(store.draft()).toBe(before);
      expect(e.defaultPrevented).toBe(false);
    });

    it('ignores keys with ctrl or meta held, so undo and browser shortcuts survive', async () => {
      await start([photo()], 'o1');
      const before = store.draft();
      key('z', { metaKey: true });
      key('c', { ctrlKey: true });
      expect(store.draft()).toBe(before);
    });

    it('stops listening once destroyed', async () => {
      await start([photo()], 'o1');
      fixture.destroy();
      const before = store.draft();
      key('ArrowUp');
      expect(store.draft()).toBe(before);
    });
  });

  describe('buttons and opacity', () => {
    it('adjusts altitude and size with buttons through the same reducer', async () => {
      await start([photo()], 'o1');
      (q('[data-altitude-up]') as HTMLButtonElement).click();
      expect(o1().anchor.altitudeM).toBe(3);
      (q('[data-altitude-down]') as HTMLButtonElement).click();
      expect(o1().anchor.altitudeM).toBe(2);
      (q('[data-size-up]') as HTMLButtonElement).click();
      expect(disp().widthM).toBeGreaterThan(6);
      (q('[data-size-down]') as HTMLButtonElement).click();
      expect(disp().widthM).toBeCloseTo(6, 6);
    });

    it('sets opacity in the document and clamps it', async () => {
      await start([photo()], 'o1');
      const range = q('[data-opacity]') as HTMLInputElement;
      range.value = '0.3';
      range.dispatchEvent(new Event('input'));
      expect(disp().opacity).toBeCloseTo(0.3, 6);
    });

    it('shows controls only for a selected inWorld overlay', async () => {
      await start([photo(), note()], 'n1');
      expect(q('[data-controls]')).toBeNull();
      store.select('o1');
      await settle();
      expect(q('[data-controls]')).toBeTruthy();
    });
  });

  describe('triggerRerender after every scene mutation', () => {
    it('re-renders on first placement', async () => {
      await start([photo()]);
      expect(fake.rerenders).toBeGreaterThan(0);
    });

    it.each(['ArrowUp', 'ArrowLeft', 'z', 'c', '+', '-'])('re-renders after %s', async (k) => {
      await start([photo()], 'o1');
      await settle();
      const before = fake.rerenders;
      key(k);
      await settle();
      expect(fake.rerenders).toBeGreaterThan(before);
    });

    it('re-renders after an opacity change, and the viewer sees the value', async () => {
      await start([photo()], 'o1');
      const before = fake.rerenders;
      const range = q('[data-opacity]') as HTMLInputElement;
      range.value = '0.25';
      range.dispatchEvent(new Event('input'));
      await settle();
      expect(fake.rerenders).toBeGreaterThan(before);
      expect(fake.opacity).toEqual({ o1: 0.25 });
    });

    it('re-renders after undo', async () => {
      await start([photo()], 'o1');
      key('ArrowUp');
      await settle();
      const before = fake.rerenders;
      store.undo();
      await settle();
      expect(fake.rerenders).toBeGreaterThan(before);
      expect(lastPlacements()[0].lat).toBe(38.8456);
    });

    it('keeps a derived heading true as the overlay is nudged, but not a manual one', async () => {
      await start([photo()], 'o1');
      const pano = { lng: -77.3069, lat: 38.8455 };
      fake.emitPositionChange(pano, 'img-1');
      key('ArrowRight');
      const derived = disp().headingDeg;
      expect(derived).toBeCloseTo(deriveHeading(o1().anchor, pano), 6);
      store.markHeadingManual('o1', true);
      key('ArrowRight');
      key('ArrowRight');
      expect(disp().headingDeg).toBe(derived);
    });

    it('shows the moved position to the viewer', async () => {
      await start([photo()], 'o1');
      key('ArrowUp');
      await settle();
      expect(lastPlacements()[0].lat).toBeGreaterThan(38.8456);
    });
  });
});
