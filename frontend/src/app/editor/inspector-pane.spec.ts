import { describe, expect, it, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { InspectorPane } from './inspector-pane';
import { EditorStore } from './editor-store';
import { overlay, stop, tour } from './test-builders';
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
  const inWorld = (): Overlay => overlay('o1', {
    kind: 'image',
    anchor: { type: 'geo', lng: -77.3, lat: 38.841, altitudeM: 2 },
    display: { mode: 'inWorld', opacity: 0.8, headingDeg: 10, widthM: 4, heightM: 3 },
  });

  const PANO = { lng: -77.3, lat: 38.84 };
  const start = async (o: Overlay, pano: { lng: number; lat: number } | null = PANO) => {
    store.load(tour([stop('s1', 1, [o])]));
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
    await start(inWorld());
    const kind = q('[data-field="kind"]') as HTMLSelectElement;
    kind.value = 'audio'; kind.dispatchEvent(new Event('change')); await settle();
    expect(ov().kind).toBe('audio');
    expect(ov().display.mode).toBe('marker');
    const modes = Array.from(el.querySelectorAll('[data-field="mode"] option')).map((o) => (o as HTMLOptionElement).value);
    expect(modes).toEqual(['marker', 'ambient']);
  });

  it('switching mode to inWorld reveals the in-world fields with a derived heading', async () => {
    await start(overlay('o1', { kind: 'image', anchor: { type: 'geo', lng: -77.3, lat: 38.841, altitudeM: 2 }, display: { mode: 'marker', icon: 'photo' } }));
    const mode = q('[data-field="mode"]') as HTMLSelectElement;
    mode.value = 'inWorld'; mode.dispatchEvent(new Event('change')); await settle();
    expect(ov().display.mode).toBe('inWorld');
    expect(input('[data-field="headingDeg"]')).toBeTruthy();
    expect((ov().display as { headingDeg: number }).headingDeg).toBeCloseTo(180, 3);
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

  it('derive heading replaces the value, using the supplied panorama position', async () => {
    await start(inWorld());
    (q('[data-derive-heading]') as HTMLElement).click(); await settle();
    expect((ov().display as { headingDeg: number }).headingDeg).toBeCloseTo(180, 3);
  });

  it('typing a heading is marked as an override, with a way back, and never enters the document', async () => {
    await start(inWorld());
    await type('[data-field="headingDeg"]', '45');
    expect((ov().display as { headingDeg: number }).headingDeg).toBe(45);
    expect(q('[data-heading-override]')).toBeTruthy();
    expect(JSON.stringify(store.draft())).not.toMatch(/override/i);
    (q('[data-derive-heading]') as HTMLElement).click(); await settle();
    expect(q('[data-heading-override]')).toBeNull();
    expect((ov().display as { headingDeg: number }).headingDeg).toBeCloseTo(180, 3);
    expect(JSON.stringify(store.draft())).not.toMatch(/override/i);
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
});
