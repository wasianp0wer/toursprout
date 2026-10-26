import { describe, expect, it, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { OutlinePane } from './outline-pane';
import { EditorStore } from './editor-store';
import { overlay, stop, tour } from './test-builders';

describe('OutlinePane', () => {
  let store: EditorStore;
  let el: HTMLElement;
  let fixture: ReturnType<typeof TestBed.createComponent<OutlinePane>>;

  const q = (sel: string) => el.querySelector(sel) as HTMLElement | null;
  const click = (sel: string) => { (q(sel) as HTMLElement).click(); fixture.detectChanges(); };

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [OutlinePane] });
    store = TestBed.inject(EditorStore);
    store.load(tour([
      stop('a', 1),
      stop('b', 2, [overlay('o1', { title: 'Note one' })]),
    ]));
    fixture = TestBed.createComponent(OutlinePane);
    el = fixture.nativeElement;
    fixture.detectChanges();
  });

  it('lists stops in order with their overlays', () => {
    // Deliberately out of array order: the outline must follow `order`.
    store.load(tour([stop('b', 2, [overlay('o1', { title: 'Note one' })]), stop('a', 1)]));
    fixture.detectChanges();
    const ids = Array.from(el.querySelectorAll('[data-stop]')).map((n) => n.getAttribute('data-stop'));
    expect(ids).toEqual(['a', 'b']);
    expect(q('[data-overlay="o1"]')?.textContent).toContain('Note one');
  });

  it('clicking selects a stop or an overlay', () => {
    click('[data-stop="a"] [data-select]');
    expect(store.selectedId()).toBe('a');
    click('[data-overlay="o1"] [data-select]');
    expect(store.selectedId()).toBe('o1');
  });

  it('adds a stop and selects it', () => {
    click('[data-add-stop]');
    expect(store.draft()!.stops.length).toBe(3);
    expect(store.selectedStop()?.order).toBe(3);
  });

  it('adds a text overlay to the selected stop', () => {
    expect((q('[data-add-overlay]') as HTMLButtonElement).disabled).toBe(true);
    store.select('a');
    fixture.detectChanges();
    click('[data-add-overlay]');
    expect(store.draft()!.stops.find((s) => s.id === 'a')!.overlays.length).toBe(1);
    expect(store.selectedOverlay()).toBeTruthy();
  });

  it('deletes the selected overlay and stop', () => {
    store.select('o1'); fixture.detectChanges();
    click('[data-delete]');
    expect(store.draft()!.stops.find((s) => s.id === 'b')!.overlays.length).toBe(0);
    store.select('b'); fixture.detectChanges();
    click('[data-delete]');
    expect(store.draft()!.stops.map((s) => s.id)).toEqual(['a']);
  });

  it('surfaces the refusal when deleting the last stop', () => {
    store.select('b'); fixture.detectChanges(); click('[data-delete]');
    store.select('a'); fixture.detectChanges(); click('[data-delete]');
    expect(store.draft()!.stops.length).toBe(1);
    expect(q('[data-outline-error]')?.textContent?.trim().length).toBeGreaterThan(0);
    expect(q('[data-outline-error]')?.textContent).toBe(store.lastError());
  });

  it('moves the selected stop up and down', () => {
    store.select('b'); fixture.detectChanges();
    click('[data-move-up]');
    expect(store.draft()!.stops.find((s) => s.id === 'b')!.order).toBe(1);
    click('[data-move-down]');
    expect(store.draft()!.stops.find((s) => s.id === 'b')!.order).toBe(2);
  });

  it('shows add-image and add-audio disabled with a note about media upload', () => {
    store.select('a'); fixture.detectChanges();
    for (const sel of ['[data-add-image]', '[data-add-audio]']) {
      expect(q(sel)).toBeTruthy();
      expect((q(sel) as HTMLButtonElement).disabled).toBe(true);
    }
    expect(q('[data-media-note]')?.textContent?.toLowerCase()).toContain('media upload');
  });
});
