import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { EditMapPane } from './edit-map-pane';
import { EditorStore } from './editor-store';
import { overlay, stop, tour } from './test-builders';
import { bearingBetween, distanceBetween } from '../core/geo';
import { rotationHandleAt } from './footprint';
import { addStop, deriveOverlayHeading, setOverlayAnchor, setStopLocation } from './document-ops';
import type { Overlay } from '../core/tour.models';
import { Marker, Point, type Map as LeafletMap } from 'leaflet';

/**
 * Leaflet runs in jsdom, which has no layout: every pixel is 0 and a map has
 * no size. These tests therefore assert on the DOM the pane renders and on
 * store state, and drive drags with real mouse events (Leaflet's own
 * Draggable), moving by pixel deltas, which do not depend on layout.
 */
describe('EditMapPane', () => {
  let store: EditorStore;
  let fixture: ReturnType<typeof TestBed.createComponent<EditMapPane>>;
  let el: HTMLElement;

  const q = (sel: string) => el.querySelector(sel) as HTMLElement | null;
  const qa = (sel: string) => Array.from(el.querySelectorAll(sel)) as HTMLElement[];
  const settle = async () => { fixture.detectChanges(); await fixture.whenStable(); fixture.detectChanges(); };

  const ANCHOR = { type: 'geo' as const, lng: -77.3065, lat: 38.8456, altitudeM: 2 };
  const inWorld = (id = 'o1'): Overlay => overlay(id, {
    kind: 'image', mediaId: 'p.jpg', anchor: ANCHOR,
    display: { mode: 'inWorld', opacity: 0.8, headingDeg: 40, widthM: 6, heightM: 3 },
  });
  const note = (id = 'o2'): Overlay => overlay(id, {
    anchor: { type: 'geo', lng: -77.3063, lat: 38.8457, altitudeM: 2 },
  });
  // DECOY: the building, deliberately far from the camera position.
  const STOP_LOC = { lng: -77.3, lat: 38.84 };
  const PANO = { imageId: 'img-1', lng: -77.3069, lat: 38.8455 };

  const start = async (overlays: Overlay[], selected: string | null, fix: typeof PANO | null = PANO) => {
    store.load(tour([stop('s1', 1, overlays, { location: STOP_LOC })]));
    if (fix) store.setPanoramaPosition(fix);
    store.select(selected ?? 's1');
    if (selected) store.select(selected);
    fixture = TestBed.createComponent(EditMapPane);
    el = fixture.nativeElement;
    await settle();
  };

  /** Drag the element by a pixel delta using the mouse events Leaflet's Draggable listens for. */
  const drag = async (target: HTMLElement, dx: number, dy: number) => {
    const frame = () => new Promise((r) => setTimeout(r, 40));
    const fire = (t: EventTarget, type: string, x: number, y: number) => {
      const e = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 });
      // Leaflet's Draggable tests the legacy `which`, which jsdom leaves at 0.
      Object.defineProperty(e, 'which', { value: 1 });
      t.dispatchEvent(e);
    };
    fire(target, 'mousedown', 100, 100);
    fire(target, 'mousemove', 100 + dx / 2, 100 + dy / 2);
    await frame(); // Draggable applies moves on an animation frame.
    fire(target, 'mousemove', 100 + dx, 100 + dy);
    await frame();
    fire(target, 'mouseup', 100 + dx, 100 + dy);
    await settle();
  };

  const anchorOf = (id: string) => store.draft()!.stops[0].overlays.find((o) => o.id === id)!.anchor;
  const headingOf = (id: string) =>
    (store.draft()!.stops[0].overlays.find((o) => o.id === id)!.display as { headingDeg: number }).headingDeg;

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [EditMapPane] });
    store = TestBed.inject(EditorStore);
  });

  it('shows a hint instead of a map when no stop is selected', async () => {
    store.load(tour());
    fixture = TestBed.createComponent(EditMapPane);
    el = fixture.nativeElement;
    await settle();
    expect(q('[data-map-empty]')).toBeTruthy();
  });

  it('shows every overlay in the stop at once, selected or not', async () => {
    await start([inWorld(), note()], 'o1');
    expect(qa('[data-overlay-marker]').map((m) => m.dataset['overlayMarker']).sort()).toEqual(['o1', 'o2']);
    expect(q('[data-overlay-marker="o1"]')!.classList.contains('selected')).toBe(true);
    expect(q('[data-overlay-marker="o2"]')!.classList.contains('selected')).toBe(false);
  });

  it('shows the overlays of the stop when the stop itself is selected', async () => {
    await start([inWorld(), note()], null);
    expect(qa('[data-overlay-marker]')).toHaveLength(2);
    expect(qa('.selected[data-overlay-marker]')).toHaveLength(0);
  });

  it('clicking a marker selects that overlay', async () => {
    await start([inWorld(), note()], 'o1');
    q('[data-overlay-marker="o2"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await settle();
    expect(store.selectedId()).toBe('o2');
  });

  it('dragging a marker moves lng and lat only, as one undoable edit', async () => {
    await start([inWorld(), note()], 'o1');
    const before = anchorOf('o1');
    await drag(q('[data-overlay-marker="o1"]')!, 60, 0);
    const after = anchorOf('o1');
    expect(after.lng).toBeGreaterThan(before.lng);
    expect(Math.abs(after.lat - before.lat)).toBeLessThan(5e-6); // sub-pixel rounding only
    expect(after.altitudeM).toBe(before.altitudeM);
    expect(store.dirty()).toBe(true);
    store.undo();
    expect(anchorOf('o1')).toEqual(before);
  });

  it('dragging an UNSELECTED marker moves it, and selects it', async () => {
    await start([inWorld(), note()], 'o1');
    const before = anchorOf('o2');
    await drag(q('[data-overlay-marker="o2"]')!, 60, 0);
    expect(anchorOf('o2').lng).toBeGreaterThan(before.lng);
    expect(anchorOf('o1')).toEqual(ANCHOR);
    expect(store.selectedId()).toBe('o2');
  });

  it('dragging a derived overlay re-derives its heading from the new anchor', async () => {
    await start([inWorld()], 'o1');
    await drag(q('[data-overlay-marker="o1"]')!, 60, 0);
    expect(headingOf('o1')).toBeCloseTo(bearingBetween(anchorOf('o1'), PANO), 6);
    expect(store.manualHeadings().has('o1')).toBe(false);
  });

  it('dragging an overlay whose heading is manual leaves the heading alone', async () => {
    await start([inWorld()], 'o1');
    store.markHeadingManual('o1', true);
    const before = headingOf('o1');
    await drag(q('[data-overlay-marker="o1"]')!, 60, 0);
    expect(headingOf('o1')).toBe(before);
  });

  it('draws a footprint and a rotation handle for the selected in-world overlay only', async () => {
    await start([inWorld(), note()], 'o1');
    expect(qa('[data-footprint]')).toHaveLength(1);
    expect(qa('[data-rotation-handle]')).toHaveLength(1);
    store.select('o2');
    await settle();
    expect(q('[data-footprint]')).toBeNull();
    expect(q('[data-rotation-handle]')).toBeNull();
  });

  it('shows the panorama position and view wedge from the gated fix', async () => {
    await start([inWorld()], 'o1');
    expect(q('[data-panorama-position]')).toBeTruthy();
    expect(q('[data-view-wedge]')).toBeTruthy();
  });

  it('without a fix there is no panorama marker, wedge or rotation handle, and nothing falls back to stop.location', async () => {
    await start([inWorld()], 'o1', null);
    expect(q('[data-panorama-position]')).toBeNull();
    expect(q('[data-view-wedge]')).toBeNull();
    expect(q('[data-rotation-handle]')).toBeNull();
    expect(q('[data-handle-unavailable]')).toBeTruthy();
    // The footprint needs no panorama, so the author still sees the plane.
    expect(q('[data-footprint]')).toBeTruthy();
  });

  it("ignores a fix that belongs to another stop's panorama", async () => {
    await start([inWorld()], 'o1', { ...PANO, imageId: 'img-other' });
    expect(q('[data-panorama-position]')).toBeNull();
    expect(q('[data-rotation-handle]')).toBeNull();
  });

  it('dragging the handle sets the heading from the anchor to the drop point and marks it manual', async () => {
    await start([inWorld()], 'o1');
    expect(store.manualHeadings().has('o1')).toBe(false);
    const before = headingOf('o1');
    await drag(q('[data-rotation-handle]')!, 50, 50); // screen right-and-down: south-east
    const after = headingOf('o1');
    expect(after).not.toBe(before);
    // Down-right on screen from a handle placed at 40 degrees swings the
    // heading clockwise; never anything derived from the panorama or building.
    const a = anchorOf('o1');
    expect(after).toBeGreaterThan(40);
    expect(after).toBeLessThan(180);
    // It is exactly the bearing the handle's new spot makes with the anchor:
    // a handle re-rendered for that heading sits on that bearing.
    const h = rotationHandleAt(a, after, 6);
    expect(Math.abs(bearingBetween(a, h) - after)).toBeLessThan(0.01);
    expect(distanceBetween(a, h)).toBeCloseTo(6, 0);
    expect(store.manualHeadings().has('o1')).toBe(true);
    expect(JSON.stringify(store.draft())).not.toMatch(/manual/i);
    // And the way back: deriving through the gate restores the derived heading.
    store.apply((t) => deriveOverlayHeading(t, 'o1', PANO));
    expect(headingOf('o1')).toBeCloseTo(bearingBetween(a, PANO), 6);
  });

  it('a handle drag never uses stop.location: the decoy building does not influence the result', async () => {
    await start([inWorld()], 'o1');
    await drag(q('[data-rotation-handle]')!, 0, -80); // straight up: toward north of the handle
    const a = anchorOf('o1');
    const viaBuilding = bearingBetween(a, STOP_LOC);
    expect(Math.abs(headingOf('o1') - viaBuilding)).toBeGreaterThan(5);
  });

  /** The pane's Leaflet map, which it keeps private: these tests need to move it as an author would. */
  const leaflet = () => (fixture.componentInstance as unknown as { map: LeafletMap }).map;

  it('tells the store where the map is looking, once placed and after every move', async () => {
    await start([note()], null);
    // Placed on the panorama position, since this stop has one.
    expect(store.mapCenter()!.lng).toBeCloseTo(PANO.lng, 6);
    expect(store.mapCenter()!.lat).toBeCloseTo(PANO.lat, 6);

    leaflet().setView([38.9, -77.2], 19, { animate: false });
    const c = leaflet().getCenter();
    expect(store.mapCenter()).toEqual({ lng: c.lng, lat: c.lat });
  });

  /** The Leaflet marker whose element carries `attr`, so its position can be read without layout. */
  const markerTagged = (attr: string, value?: string): Marker | undefined => {
    let found: Marker | undefined;
    leaflet().eachLayer((l) => {
      const e = l instanceof Marker ? l.getElement() : undefined;
      if (e?.hasAttribute(attr) && (value === undefined || e.getAttribute(attr) === value)) found = l as Marker;
    });
    return found;
  };

  it("draws the stop's location as a marker that can be dragged", async () => {
    await start([note()], null);
    const m = markerTagged('data-stop-location')!;
    expect(m).toBeTruthy();
    expect(m.getLatLng()).toMatchObject({ lat: STOP_LOC.lat, lng: STOP_LOC.lng });
    expect(m.options.draggable).toBe(true);
    expect(m.options.keyboard).toBe(true);
    expect(m.options.title).toBe('Drag to move this stop');
    expect(m.options.alt).toBe('Drag to move this stop');
  });

  /** Drop the stop-location ring at `at`, as Leaflet reports the end of a drag. */
  const dropRing = async (at: { lng: number; lat: number }) => {
    const ring = markerTagged('data-stop-location')!;
    ring.setLatLng([at.lat, at.lng]);
    ring.fire('dragend', { target: ring });
    await settle();
  };

  it("dropping the ring moves the stop's location there and clears osmRef, as one undoable edit", async () => {
    store.load(tour([stop('s1', 1, [note()], { location: STOP_LOC, osmRef: 'way/123' })]));
    store.select('s1');
    fixture = TestBed.createComponent(EditMapPane);
    el = fixture.nativeElement;
    await settle();
    const overlaysBefore = store.draft()!.stops[0].overlays;
    await dropRing({ lng: -77.31, lat: 38.85 });
    const s = store.draft()!.stops[0];
    expect(s.location).toEqual({ lng: -77.31, lat: 38.85 });
    expect(s.osmRef).toBeNull();
    expect(s.overlays).toEqual(overlaysBefore); // overlays stay put
    store.undo();
    expect(store.draft()!.stops[0].location).toEqual(STOP_LOC);
    expect(store.draft()!.stops[0].osmRef).toBe('way/123');
  });

  it('a ring dropped past the antimeridian lands at the wrapped longitude', async () => {
    await start([note()], null);
    await dropRing({ lng: 190, lat: 38.85 });
    expect(store.draft()!.stops[0].location).toEqual({ lng: -170, lat: 38.85 });
  });

  it('dropping the ring does not move the map under the author', async () => {
    await start([note()], null);
    const setView = vi.spyOn(leaflet(), 'setView');
    const panTo = vi.spyOn(leaflet(), 'panTo');
    await dropRing({ lng: -77.31, lat: 38.85 });
    expect(store.draft()!.stops[0].location).toEqual({ lng: -77.31, lat: 38.85 }); // the drop did land
    expect(setView).not.toHaveBeenCalled();
    expect(panTo).not.toHaveBeenCalled();
  });

  it("an overlay anchored on the stop's location leaves both it and the ring grabbable", async () => {
    const onStop = overlay('o3', { anchor: { type: 'geo', lng: STOP_LOC.lng, lat: STOP_LOC.lat, altitudeM: 2 } });
    await start([onStop], null);
    const ring = markerTagged('data-stop-location')!;
    const mark = markerTagged('data-overlay-marker', 'o3')!;
    expect(ring.options.draggable).toBe(true);
    expect(mark.options.draggable).toBe(true);
    // The overlay draws above the ring...
    expect(mark.options.zIndexOffset!).toBeGreaterThan(ring.options.zIndexOffset!);
    // ...and the ring is wider than the overlay's 22px, so its rim shows around it.
    const size = (m: Marker) => m.options.icon!.options.iconSize as [number, number];
    expect(size(ring)[0]).toBeGreaterThan(22);
    expect(size(ring)[1]).toBeGreaterThan(22);
    expect(size(mark)).toEqual([22, 22]);
  });

  it("an overlay drag never changes the stop's location", async () => {
    const onStop = overlay('o3', { anchor: { type: 'geo', lng: STOP_LOC.lng, lat: STOP_LOC.lat, altitudeM: 2 } });
    await start([onStop], null);
    await drag(q('[data-overlay-marker="o3"]')!, 60, 0);
    expect(anchorOf('o3').lng).toBeGreaterThan(STOP_LOC.lng); // the drag did land
    expect(store.draft()!.stops[0].location).toEqual(STOP_LOC);
  });

  it("follows the stop's location when it is edited", async () => {
    await start([note()], null);
    const panTo = vi.spyOn(leaflet(), 'panTo');
    store.apply((t) => setStopLocation(t, 's1', -77.31, 38.85));
    await settle();
    expect(markerTagged('data-stop-location')!.getLatLng()).toMatchObject({ lat: 38.85, lng: -77.31 });
    expect(panTo).toHaveBeenCalledTimes(1);
    expect(panTo.mock.calls[0][0]).toEqual([38.85, -77.31]);
  });

  it('holds the view still while an overlay is dragged', async () => {
    await start([inWorld(), note()], 'o1');
    const setView = vi.spyOn(leaflet(), 'setView');
    const panTo = vi.spyOn(leaflet(), 'panTo');
    await drag(q('[data-overlay-marker="o2"]')!, 60, 0);
    expect(anchorOf('o2').lng).toBeGreaterThan(-77.3063); // the drag did land
    expect(setView).not.toHaveBeenCalled();
    expect(panTo).not.toHaveBeenCalled();
  });

  /**
   * jsdom gives the map no size, so its bounds are a single point; give it a
   * screen's worth so "already in view" means what it does in a browser. A
   * fresh Point each call, as Leaflet's own getSize returns: it mutates it.
   */
  const giveSize = () => vi.spyOn(leaflet(), 'getSize').mockImplementation(() => new Point(800, 600));

  it("a stop added where the author is looking keeps the view, not the previous stop's camera", async () => {
    await start([note()], null); // s1's panorama fix is PANO
    giveSize();
    leaflet().setView([38.9, -77.2], 19, { animate: false }); // the author pans away
    const looking = store.mapCenter()!;
    const setView = vi.spyOn(leaflet(), 'setView');
    // As OutlinePane does: add at the map centre, then select it. The new
    // stop copies s1's panorama, so PANO (far from here) is its fix too.
    store.apply((t) => addStop(t, 'New stop', store.mapCenter()));
    const added = store.draft()!.stops[1];
    store.select(added.id);
    await settle();
    expect(added.location).toEqual(looking);
    expect(setView).not.toHaveBeenCalled();
    expect(leaflet().getCenter().lng).toBeCloseTo(looking.lng, 9);
    expect(leaflet().getCenter().lat).toBeCloseTo(looking.lat, 9);
    expect(store.mapCenter()).toEqual(looking);
  });

  it('selecting a stop whose location is out of view still re-centres', async () => {
    const far = { lng: -76.9, lat: 39.1 };
    store.load(tour([
      stop('s1', 1, [], { location: STOP_LOC }),
      stop('s2', 2, [], { location: far }),
    ]));
    store.select('s1');
    fixture = TestBed.createComponent(EditMapPane);
    el = fixture.nativeElement;
    await settle();
    giveSize();
    const setView = vi.spyOn(leaflet(), 'setView');
    store.select('s2');
    await settle();
    expect(setView).toHaveBeenCalledTimes(1);
    expect(setView.mock.calls[0][0]).toEqual([far.lat, far.lng]);
    expect(store.mapCenter()).toEqual(far);
  });

  it("moves an overlay's marker when its lat and lng are typed", async () => {
    await start([note()], 'o2');
    store.apply((t) => setOverlayAnchor(t, 'o2', { lng: -77.305, lat: 38.846 }));
    await settle();
    expect(markerTagged('data-overlay-marker', 'o2')!.getLatLng()).toMatchObject({ lat: 38.846, lng: -77.305 });
  });

  it('tears the map down with the component', async () => {
    await start([inWorld()], 'o1');
    const container = q('.edit-map')!;
    fixture.destroy();
    expect(container.querySelector('.leaflet-map-pane')).toBeNull();
  });
});
