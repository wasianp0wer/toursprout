import { beforeEach, describe, expect, it } from 'vitest';
import { EditorStore, UNDO_DEPTH } from './editor-store';
import { addTextOverlay, deleteOverlay, deleteStop, updateOverlay } from './document-ops';
import { overlay, stop, tour } from './test-builders';

describe('EditorStore', () => {
  let store: EditorStore;
  beforeEach(() => { store = new EditorStore(); });

  it('starts with no draft and nothing selected', () => {
    expect(store.draft()).toBeNull();
    expect(store.selectedId()).toBeNull();
    expect(store.dirty()).toBe(false);
    expect(store.canUndo()).toBe(false);
  });

  it('loads a document without marking it dirty', () => {
    store.load(tour());
    expect(store.draft()?.id).toBe('t');
    expect(store.dirty()).toBe(false);
  });

  it('applies a transform and marks the draft dirty', () => {
    store.load(tour());
    store.apply((t) => addTextOverlay(t, 's1', 'A note'));
    expect(store.draft()!.stops[0].overlays).toHaveLength(1);
    expect(store.dirty()).toBe(true);
  });

  it('does not mutate the document it was handed', () => {
    const original = tour();
    const snapshot = JSON.stringify(original);
    store.load(original);
    store.apply((t) => addTextOverlay(t, 's1', 'A note'));
    expect(JSON.stringify(original)).toBe(snapshot);
  });

  it('undo restores the previous document exactly', () => {
    store.load(tour());
    const before = JSON.stringify(store.draft());
    store.apply((t) => addTextOverlay(t, 's1', 'A note'));
    expect(JSON.stringify(store.draft())).not.toBe(before);
    store.undo();
    expect(JSON.stringify(store.draft())).toBe(before);
  });

  it('pushes one undo entry per applied transform', () => {
    store.load(tour());
    store.apply((t) => addTextOverlay(t, 's1', 'One'));
    store.apply((t) => addTextOverlay(t, 's1', 'Two'));
    store.undo();
    expect(store.draft()!.stops[0].overlays.map((o) => o.title)).toEqual(['One']);
    store.undo();
    expect(store.draft()!.stops[0].overlays).toHaveLength(0);
    expect(store.canUndo()).toBe(false);
  });

  it('caps the undo stack so a long session cannot grow without bound', () => {
    store.load(tour());
    for (let i = 0; i < UNDO_DEPTH + 10; i += 1) {
      store.apply((t) => updateOverlay(t, 'nothing', { title: `t${i}` }));
    }
    let depth = 0;
    while (store.canUndo()) { store.undo(); depth += 1; }
    expect(depth).toBe(UNDO_DEPTH);
  });

  it('clears the selection when the selected overlay is deleted', () => {
    store.load(tour([stop('s1', 1, [overlay('o1')])]));
    store.select('o1');
    store.apply((t) => deleteOverlay(t, 'o1'));
    expect(store.selectedId()).toBeNull();
  });

  it('clears the selection when the stop containing it is deleted', () => {
    store.load(tour([stop('s1', 1, [overlay('o1')]), stop('s2', 2)]));
    store.select('o1');
    store.apply((t) => deleteStop(t, 's1'));
    expect(store.selectedId()).toBeNull();
  });

  it('keeps a selection that still exists', () => {
    store.load(tour([stop('s1', 1, [overlay('o1'), overlay('o2')])]));
    store.select('o2');
    store.apply((t) => deleteOverlay(t, 'o1'));
    expect(store.selectedId()).toBe('o2');
  });

  it('keeps the draft intact when a transform throws', () => {
    store.load(tour([stop('only', 1)]));
    const before = JSON.stringify(store.draft());
    store.apply((t) => deleteStop(t, 'only'));
    expect(JSON.stringify(store.draft())).toBe(before);
    expect(store.canUndo()).toBe(false);
  });

  it('records the message when a transform throws', () => {
    store.load(tour([stop('only', 1)]));
    store.apply((t) => deleteStop(t, 'only'));
    expect(store.lastError()).toMatch(/at least one stop/);
  });

  it('clears a previous error on the next successful transform', () => {
    store.load(tour([stop('only', 1)]));
    store.apply((t) => deleteStop(t, 'only'));
    store.apply((t) => addTextOverlay(t, 'only', 'A note'));
    expect(store.lastError()).toBeNull();
  });

  it('markSaved clears dirty without touching the draft', () => {
    store.load(tour());
    store.apply((t) => addTextOverlay(t, 's1', 'A note'));
    const draft = store.draft()!;
    store.markSaved(draft);
    expect(store.dirty()).toBe(false);
    expect(store.draft()).toBe(draft);
  });

  it('markSaved ignores a document that is no longer the draft', () => {
    store.load(tour());
    store.apply((t) => addTextOverlay(t, 's1', 'One'));
    const stale = store.draft()!;
    store.apply((t) => addTextOverlay(t, 's1', 'Two'));
    store.markSaved(stale);
    expect(store.dirty()).toBe(true);
  });

  it('is dirty after an undo that follows a save', () => {
    store.load(tour());
    store.apply((t) => addTextOverlay(t, 's1', 'A note'));
    store.markSaved(store.draft()!);
    store.undo();
    expect(store.dirty()).toBe(true);
  });

  it('reports clean again when undo returns to exactly the saved document', () => {
    store.load(tour());
    store.apply((t) => addTextOverlay(t, 's1', 'A note'));
    expect(store.dirty()).toBe(true);
    store.undo();
    expect(store.dirty()).toBe(false);
  });

  it('treats a refused transform (same reference back) as no edit at all', () => {
    store.load(tour());
    store.apply((t) => t);
    expect(store.canUndo()).toBe(false);
    expect(store.dirty()).toBe(false);
  });

  it('tracks manually oriented headings, clears them on load, and keeps them out of the document', () => {
    store.load(tour());
    expect(store.manualHeadings().has('o1')).toBe(false);
    store.markHeadingManual('o1', true);
    expect(store.manualHeadings().has('o1')).toBe(true);
    expect(JSON.stringify(store.draft())).not.toMatch(/manual/i);
    store.markHeadingManual('o1', false);
    expect(store.manualHeadings().has('o1')).toBe(false);
    store.markHeadingManual('o1', true);
    store.load(tour());
    expect(store.manualHeadings().size).toBe(0);
  });

  it('forgets where the map was looking when another tour is loaded', () => {
    store.load(tour());
    expect(store.mapCenter()).toBeNull();
    store.setMapCenter({ lng: -77.3, lat: 38.8 });
    expect(store.mapCenter()).toEqual({ lng: -77.3, lat: 38.8 });
    store.load(tour());
    expect(store.mapCenter()).toBeNull();
  });

  it('forgets a pending defaults answer when another tour is loaded', () => {
    store.load(tour());
    store.setPendingDefaults({ creator: 'Ada', license: 'CC0' });
    expect(store.pendingDefaults()).toEqual({ creator: 'Ada', license: 'CC0' });
    store.load(tour());
    expect(store.pendingDefaults()).toBeNull();
  });

  // Closing a tour leaves this store in the process (it is providedIn root),
  // so "no tour is open" has to be a state it can actually be in — otherwise
  // the next screen is looking at the closed tour's draft.
  it('clear leaves no trace of the tour that was open', () => {
    store.load(tour());
    store.apply((t) => addTextOverlay(t, 's1', 'A note'));
    store.select('s1');
    store.markHeadingManual('o1', true);
    store.setPendingDefaults({ creator: 'Ada', license: 'CC0' });
    store.setPanoramaPosition({ imageId: 'img-1', lng: -77.3, lat: 38.84 });

    store.clear();

    expect(store.draft()).toBeNull();
    expect(store.selectedId()).toBeNull();
    expect(store.canUndo()).toBe(false);
    expect(store.dirty()).toBe(false);
    expect(store.lastError()).toBeNull();
    expect(store.manualHeadings().size).toBe(0);
    expect(store.pendingDefaults()).toBeNull();
    expect(store.panoramaPosition()).toBeNull();
  });
});
