import { describe, expect, it, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { InspectorPane } from './inspector-pane';
import { EditorStore } from './editor-store';
import { overlay, stop, tour } from './test-builders';
import { MapillarySearch, type PanoramaCandidate } from '../core/mapillary-search';
import { ToolsApi, type PlaceCandidate } from '../core/tools-api';
import { vi } from 'vitest';
import { deriveHeading } from './document-ops';
import type { Overlay } from '../core/tour.models';

describe('InspectorPane', () => {
  let store: EditorStore;
  let el: HTMLElement;
  let fixture: ReturnType<typeof TestBed.createComponent<InspectorPane>>;

  const q = (sel: string) => el.querySelector(sel) as HTMLElement | null;
  const input = (sel: string) => q(sel) as HTMLInputElement;
  const settle = async () => { fixture.detectChanges(); await fixture.whenStable(); fixture.detectChanges(); };
  const type = async (sel: string, value: string) => {
    const i = input(sel); i.value = value; i.dispatchEvent(new Event('input')); await settle();
  };
  const ov = (): Overlay => store.selectedOverlay()!;
  const ANCHOR = { type: 'geo' as const, lng: -77.3, lat: 38.841, altitudeM: 2 };
  const heading = () => (ov().display as { headingDeg: number }).headingDeg;
  const inWorld = (): Overlay => overlay('o1', {
    kind: 'image', mediaId: 'p.jpg',
    anchor: ANCHOR,
    display: { mode: 'inWorld', opacity: 0.8, headingDeg: 10, widthM: 4, heightM: 3 },
  });

  // DECOY: stop.location is far from PANO on purpose (the building versus the
  // camera). A derivation that reads stop.location gives a different heading.
  const STOP_LOC = { lng: -77.5, lat: 38.7 };
  const PANO = { imageId: 'img-1', lng: -77.31, lat: 38.85 };
  const start = async (
    o: Overlay, pano: { imageId: string; lng: number; lat: number } | null = PANO,
    loc = STOP_LOC,
  ) => {
    store.load(tour([stop('s1', 1, [o], { location: loc })]));
    if (pano) store.setPanoramaPosition(pano);
    store.select(o.id);
    fixture = TestBed.createComponent(InspectorPane);
    el = fixture.nativeElement;
    await settle();
  };

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [InspectorPane] });
    store = TestBed.inject(EditorStore);
  });

  it('shows a hint when nothing is selected', async () => {
    store.load(tour());
    fixture = TestBed.createComponent(InspectorPane);
    el = fixture.nativeElement;
    await settle();
    expect(q('[data-inspector-empty]')).toBeTruthy();
    expect(q('[data-field="lng"]')).toBeNull();
  });

  it('reflects the selected overlay and omits in-world fields for a marker', async () => {
    await start(overlay('o1', { title: 'Hello' }));
    expect(input('[data-field="title"]').value).toBe('Hello');
    expect(input('[data-field="lng"]').value).toBe('-77.3');
    expect(input('[data-field="altitudeM"]').value).toBe('2');
    for (const f of ['headingDeg', 'widthM', 'heightM', 'opacity']) {
      expect(q(`[data-field="${f}"]`)).toBeNull();
    }
  });

  it('writes numeric edits to the document', async () => {
    await start(inWorld());
    await type('[data-field="lat"]', '38.9');
    expect(ov().anchor.lat).toBe(38.9);
    await type('[data-field="widthM"]', '7');
    await type('[data-field="opacity"]', '0.5');
    const d = ov().display as { widthM: number; opacity: number };
    expect(d.widthM).toBe(7);
    expect(d.opacity).toBe(0.5);
  });

  it('writes text edits for title, body and credit', async () => {
    await start(overlay('o1'));
    await type('[data-field="title"]', 'New title');
    await type('[data-field="body"]', 'New body');
    await type('[data-field="credit"]', 'Someone');
    expect(ov().title).toBe('New title');
    expect(ov().body).toBe('New body');
    expect(ov().credit.type === 'original' && ov().credit.creator).toBe('Someone');
  });

  it('ignores an emptied numeric field rather than writing null', async () => {
    await start(overlay('o1'));
    await type('[data-field="lng"]', '');
    expect(ov().anchor.lng).toBe(-77.3);
  });

  it('offers only the legal display modes for the kind', async () => {
    await start(overlay('o1'));
    const modes = () => Array.from(el.querySelectorAll('[data-field="mode"] option')).map((o) => (o as HTMLOptionElement).value);
    expect(modes()).toEqual(['marker']);
  });

  it('changes kind through setOverlayKind, coercing an illegal mode', async () => {
    // audio is only offered when the attached media is audio
    await start({ ...inWorld(), mediaId: 'p.mp3' });
    const kind = q('[data-field="kind"]') as HTMLSelectElement;
    kind.value = 'audio'; kind.dispatchEvent(new Event('change')); await settle();
    expect(ov().kind).toBe('audio');
    expect(ov().display.mode).toBe('marker');
    const modes = Array.from(el.querySelectorAll('[data-field="mode"] option')).map((o) => (o as HTMLOptionElement).value);
    expect(modes).toEqual(['marker', 'ambient']);
  });

  it('switching mode to inWorld reveals the in-world fields with a derived heading', async () => {
    await start(overlay('o1', { kind: 'image', mediaId: 'p.jpg', anchor: ANCHOR, display: { mode: 'marker', icon: 'photo' } }));
    const mode = q('[data-field="mode"]') as HTMLSelectElement;
    mode.value = 'inWorld'; mode.dispatchEvent(new Event('change')); await settle();
    expect(ov().display.mode).toBe('inWorld');
    expect(input('[data-field="headingDeg"]')).toBeTruthy();
    expect(heading()).toBeCloseTo(deriveHeading(ANCHOR, PANO), 6);
    expect(q('[data-heading-override]')).toBeNull();
  });

  it('disables derive with an explanation while the panorama position is unknown', async () => {
    await start(inWorld(), null);
    expect((q('[data-derive-heading]') as HTMLButtonElement).disabled).toBe(true);
    expect(q('[data-derive-unavailable]')?.textContent?.length).toBeGreaterThan(0);
    (q('[data-derive-heading]') as HTMLElement).click(); await settle();
    expect((ov().display as { headingDeg: number }).headingDeg).toBe(10);
    store.setPanoramaPosition(PANO); await settle();
    expect((q('[data-derive-heading]') as HTMLButtonElement).disabled).toBe(false);
    expect(q('[data-derive-unavailable]')).toBeNull();
  });

  it('derive heading replaces the value, using the supplied panorama position, not the stop', async () => {
    await start(inWorld());
    (q('[data-derive-heading]') as HTMLElement).click(); await settle();
    expect(heading()).not.toBeCloseTo(deriveHeading(ANCHOR, STOP_LOC), 0);
    expect(heading()).toBeCloseTo(deriveHeading(ANCHOR, PANO), 6);
  });

  it('courthouse numbers: derive gives about 105 through the DOM', async () => {
    const court = overlay('o1', {
      kind: 'image', mediaId: 'c.jpg',
      anchor: { type: 'geo', lng: -77.30732, lat: 38.84562, altitudeM: 2 },
      display: { mode: 'inWorld', opacity: 0.8, headingDeg: 0, widthM: 4, heightM: 3 },
    });
    // DECOY: stop.location is on the far side of the anchor from the camera,
    // so deriving from it gives about 285 (backwards); the panorama position
    // gives about 105.
    await start(court, { imageId: 'img-1', lng: -77.306888, lat: 38.845534 },
      { lng: -77.30732 * 2 + 77.306888, lat: 38.84562 * 2 - 38.845534 });
    (q('[data-derive-heading]') as HTMLElement).click(); await settle();
    expect(heading()).toBeGreaterThan(100);
    expect(heading()).toBeLessThan(110);
  });

  it('a position for a different panorama disables derive and the inWorld switch', async () => {
    await start(inWorld(), { ...PANO, imageId: 'previous-pano' });
    expect((q('[data-derive-heading]') as HTMLButtonElement).disabled).toBe(true);
    (q('[data-derive-heading]') as HTMLElement).click(); await settle();
    expect(heading()).toBe(10);
    store.setPanoramaPosition(PANO); await settle();
    expect((q('[data-derive-heading]') as HTMLButtonElement).disabled).toBe(false);
  });

  it('refuses the inWorld switch while the position is unknown, with the option disabled and explained', async () => {
    await start(overlay('o1', { kind: 'image', mediaId: 'p.jpg', display: { mode: 'marker', icon: 'photo' } }), null);
    const opt = q('[data-field="mode"] option[value="inWorld"]') as HTMLOptionElement;
    expect(opt.disabled).toBe(true);
    expect(q('[data-derive-unavailable]')).toBeTruthy();
    const mode = q('[data-field="mode"]') as HTMLSelectElement;
    mode.value = 'inWorld'; mode.dispatchEvent(new Event('change')); await settle();
    expect(ov().display.mode).toBe('marker');
    store.setPanoramaPosition(PANO); await settle();
    expect((q('[data-field="mode"] option[value="inWorld"]') as HTMLOptionElement).disabled).toBe(false);
  });

  it('offers only the kind the attached media type allows', async () => {
    const kinds = () => Array.from(el.querySelectorAll('[data-field="kind"] option')).map((o) => (o as HTMLOptionElement).value);
    await start(overlay('o1'));
    expect(kinds()).toEqual(['text']);
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ imports: [InspectorPane] });
    store = TestBed.inject(EditorStore);
    await start(overlay('o1', { mediaId: 'm.jpg' }));
    expect(kinds()).toEqual(['text', 'image']);
  });

  it('typing a heading is marked as an override, with a way back, and never enters the document', async () => {
    await start(inWorld());
    await type('[data-field="headingDeg"]', '45');
    expect((ov().display as { headingDeg: number }).headingDeg).toBe(45);
    expect(q('[data-heading-override]')).toBeTruthy();
    expect(JSON.stringify(store.draft())).not.toMatch(/override/i);
    (q('[data-derive-heading]') as HTMLElement).click(); await settle();
    expect(q('[data-heading-override]')).toBeNull();
    expect(heading()).toBeCloseTo(deriveHeading(ANCHOR, PANO), 6);
    expect(JSON.stringify(store.draft())).not.toMatch(/override/i);
  });

  it('refuses a typed heading while the panorama position is unknown, and does not mark it manual', async () => {
    await start(inWorld(), null);
    expect(input('[data-field="headingDeg"]').disabled).toBe(true);
    await type('[data-field="headingDeg"]', '45');
    expect(heading()).toBe(10);
    expect(store.manualHeadings().has('o1')).toBe(false);
    expect(q('[data-heading-override]')).toBeNull();
    expect(store.canUndo()).toBe(false);
  });

  it('refuses a typed heading for a different panorama\'s position', async () => {
    await start(inWorld(), { ...PANO, imageId: 'previous-pano' });
    await type('[data-field="headingDeg"]', '45');
    expect(heading()).toBe(10);
    expect(store.manualHeadings().has('o1')).toBe(false);
  });

  it('editing the anchor re-derives a derived heading', async () => {
    await start(inWorld());
    await type('[data-field="lng"]', '-77.2995');
    expect(heading()).toBeCloseTo(deriveHeading(ov().anchor, PANO), 6);
  });

  it('editing the anchor leaves a manual heading alone', async () => {
    await start(inWorld());
    await type('[data-field="headingDeg"]', '45');
    await type('[data-field="lng"]', '-77.2995');
    expect(heading()).toBe(45);
  });

  it('a refused mode switch does not clear the manual flag', async () => {
    await start(inWorld());
    await type('[data-field="headingDeg"]', '45');
    expect(store.manualHeadings().has('o1')).toBe(true);
    store.setPanoramaPosition(null);
    // Switching to the mode it already has is refused (same reference).
    const comp = fixture.componentInstance as unknown as { setMode(m: string): void };
    comp.setMode('inWorld');
    expect(store.manualHeadings().has('o1')).toBe(true);
  });

  it('shows stop fields for a selected stop', async () => {
    store.load(tour());
    store.select('s1');
    fixture = TestBed.createComponent(InspectorPane);
    el = fixture.nativeElement;
    await settle();
    expect(input('[data-field="stop-title"]').value).toBe('Stop 1');
    expect(q('[data-field="lng"]')).toBeNull();
  });

  it('edits the stop text, which is what the viewer shows', async () => {
    store.load(tour());
    store.select('s1');
    fixture = TestBed.createComponent(InspectorPane);
    el = fixture.nativeElement;
    await settle();
    const ta = q('[data-field="stop-summary"]') as HTMLTextAreaElement;
    ta.value = 'The old courthouse.';
    ta.dispatchEvent(new Event('input'));
    await settle();
    expect(store.draft()!.stops[0].summary).toBe('The old courthouse.');
  });
});

describe('InspectorPane: placing a stop', () => {
  let store: EditorStore;
  let el: HTMLElement;
  let fixture: ReturnType<typeof TestBed.createComponent<InspectorPane>>;
  let panoramas: ReturnType<typeof vi.fn>;
  let places: ReturnType<typeof vi.fn>;

  const q = (sel: string) => el.querySelector(sel) as HTMLElement | null;
  const qa = (sel: string) => Array.from(el.querySelectorAll(sel)) as HTMLElement[];
  const settle = async () => { fixture.detectChanges(); await fixture.whenStable(); fixture.detectChanges(); };
  const type = async (sel: string, value: string) => {
    const i = q(sel) as HTMLInputElement; i.value = value; i.dispatchEvent(new Event('input')); await settle();
  };
  const click = async (sel: string, i = 0) => {
    qa(sel)[i].click(); await new Promise((r) => setTimeout(r)); await settle();
  };
  const cand = (imageId: string, lng: number, lat: number): PanoramaCandidate => ({
    imageId, lng, lat, capturedAt: 1_500_000_000_000, thumbUrl: null, distanceM: 12.3,
  });
  const ANCHOR = { type: 'geo' as const, lng: -77.3, lat: 38.841, altitudeM: 2 };
  const A = cand('cam-A', -77.31, 38.85);
  const B = cand('cam-B', -77.29, 38.83);
  const STOP_LOC = { lng: -77.5, lat: 38.7 };

  beforeEach(async () => {
    panoramas = vi.fn();
    places = vi.fn();
    TestBed.configureTestingModule({
      imports: [InspectorPane],
      providers: [
        { provide: ToolsApi, useValue: { places } },
        { provide: MapillarySearch, useValue: { panoramas } },
      ],
    });
    store = TestBed.inject(EditorStore);
    store.load(tour([stop('s1', 1, [overlay('o1', {
      kind: 'image', mediaId: 'p.jpg', anchor: ANCHOR,
      display: { mode: 'inWorld', opacity: 0.8, headingDeg: 10, widthM: 4, heightM: 3 },
    })], { location: STOP_LOC })]));
    store.select('s1');
    fixture = TestBed.createComponent(InspectorPane);
    el = fixture.nativeElement;
    await settle();
  });

  it('edits the stop location in the document', async () => {
    expect((q('[data-field="stop-lng"]') as HTMLInputElement).value).toBe('-77.5');
    await type('[data-field="stop-lat"]', '38.9');
    expect(store.selectedStop()!.location).toEqual({ lng: -77.5, lat: 38.9 });
    await type('[data-field="stop-lng"]', '999');
    expect(store.selectedStop()!.location.lng).toBe(-77.5);
  });

  it('searches near the stop location and lists candidates', async () => {
    panoramas.mockResolvedValue([A, B]);
    await click('[data-find-panoramas]');
    expect(panoramas).toHaveBeenCalledWith(STOP_LOC.lng, STOP_LOC.lat);
    expect(qa('[data-candidate]').map((n) => n.getAttribute('data-candidate'))).toEqual(['cam-A', 'cam-B']);
  });

  it('clears the candidate list when the stop location is edited', async () => {
    panoramas.mockResolvedValue([A]);
    await click('[data-find-panoramas]');
    expect(qa('[data-candidate]').length).toBe(1);
    await type('[data-field="stop-lat"]', '38.9');
    expect(qa('[data-candidate]').length).toBe(0);
  });

  it('selecting resets the bearing to the candidate camera heading', async () => {
    panoramas.mockResolvedValue([{ ...A, compassAngle: 123 }]);
    await click('[data-find-panoramas]');
    await click('[data-use-panorama]');
    expect(store.selectedStop()!.panorama.bearing).toBe(123);
  });

  it('says so when there are no candidates', async () => {
    panoramas.mockResolvedValue([]);
    await click('[data-find-panoramas]');
    expect(q('[data-panorama-none]')).toBeTruthy();
  });

  it('shows a failure message and leaves the document untouched', async () => {
    const before = store.draft();
    panoramas.mockRejectedValue(new Error('Mapillary is not configured'));
    await click('[data-find-panoramas]');
    expect(q('[data-tool-error]')?.textContent).toContain('Mapillary is not configured');
    expect(store.draft()).toBe(before);
    expect(store.dirty()).toBe(false);
  });

  it('selecting a candidate sets the imageId AND publishes THAT candidate\'s position', async () => {
    panoramas.mockResolvedValue([A, B]);
    await click('[data-find-panoramas]');
    await click('[data-candidate="cam-B"] [data-use-panorama]');
    expect(store.selectedStop()!.panorama.imageId).toBe('cam-B');
    expect(store.panoramaPosition()).toEqual({ imageId: 'cam-B', lng: B.lng, lat: B.lat });
    expect(store.dirty()).toBe(true);
    // One undo step reverts the document.
    store.undo();
    expect(store.selectedStop()!.panorama.imageId).toBe('img-1');
  });

  it('closes the chain: after picking, deriving an inWorld overlay uses the candidate position', async () => {
    panoramas.mockResolvedValue([A, B]);
    await click('[data-find-panoramas]');
    await click('[data-candidate="cam-A"] [data-use-panorama]');
    store.select('o1'); await settle();
    expect((q('[data-derive-heading]') as HTMLButtonElement).disabled).toBe(false);
    await click('[data-derive-heading]');
    const heading = (store.selectedOverlay()!.display as { headingDeg: number }).headingDeg;
    expect(heading).toBeCloseTo(deriveHeading(ANCHOR, A), 6);
    expect(heading).not.toBeCloseTo(deriveHeading(ANCHOR, B), 0);
    expect(heading).not.toBeCloseTo(deriveHeading(ANCHOR, STOP_LOC), 0);
  });

  it('keeps the gate shut for a stop whose panorama was never selected', async () => {
    store.setPanoramaPosition({ imageId: 'img-other', lng: 1, lat: 1 });
    store.select('o1'); await settle();
    expect((q('[data-derive-heading]') as HTMLButtonElement).disabled).toBe(true);
  });

  it('searches places by the stop location and applies the chosen one', async () => {
    const place: PlaceCandidate = { name: 'Old Courthouse', osmRef: 'way/77', lng: -77.31, lat: 38.846 };
    places.mockResolvedValue([place]);
    await click('[data-find-places]');
    expect(places).toHaveBeenCalledWith(STOP_LOC.lng, STOP_LOC.lat);
    await click('[data-place="way/77"] [data-use-place]');
    expect(store.selectedStop()!.location).toEqual({ lng: -77.31, lat: 38.846 });
    expect(store.selectedStop()!.osmRef).toBe('way/77');
  });

  it('a place search failure shows its message and changes nothing', async () => {
    const before = store.draft();
    places.mockRejectedValue(new Error('every Overpass mirror failed'));
    await click('[data-find-places]');
    expect(q('[data-tool-error]')?.textContent).toContain('every Overpass mirror failed');
    expect(store.draft()).toBe(before);
  });
});
