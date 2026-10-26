import { describe, expect, it, beforeEach, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { OutlinePane } from './outline-pane';
import { EditorStore } from './editor-store';
import { SessionApi } from '../core/session-api';
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

  describe('add image / add audio', () => {
    const file = (name: string) => new File([new Uint8Array([1])], name);
    const choose = async (sel: string, f: File) => {
      const input = q(sel) as HTMLInputElement;
      Object.defineProperty(input, 'files', { value: [f], configurable: true });
      input.dispatchEvent(new Event('change'));
      // The handler is async and its promise is not returned by dispatchEvent.
      await new Promise((r) => setTimeout(r, 0));
      fixture.detectChanges();
    };
    const overlaysOf = (id: string) => store.draft()!.stops.find((s) => s.id === id)!.overlays;
    let upload: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      upload = vi.fn();
      TestBed.resetTestingModule();
      TestBed.configureTestingModule({
        imports: [OutlinePane], providers: [{ provide: SessionApi, useValue: { uploadMedia: upload } }],
      });
      store = TestBed.inject(EditorStore);
      store.load(tour([stop('a', 1), stop('b', 2, [overlay('o1')])]));
      fixture = TestBed.createComponent(OutlinePane);
      el = fixture.nativeElement;
      store.select('a');
      fixture.detectChanges();
    });

    it('are enabled once a stop is current, and the stale note is gone', () => {
      for (const sel of ['[data-add-image]', '[data-add-audio]']) {
        expect((q(sel) as HTMLButtonElement).disabled).toBe(false);
      }
      expect(q('[data-media-note]')).toBeNull();
      store.select(null); fixture.detectChanges();
      expect((q('[data-add-image]') as HTMLButtonElement).disabled).toBe(true);
    });

    it('uploads, then creates a selected image overlay with the returned mediaId', async () => {
      upload.mockResolvedValue('pic-abc123.jpg');
      await choose('[data-file-image]', file('pic.jpg'));
      expect(upload).toHaveBeenCalledTimes(1);
      const [o] = overlaysOf('a');
      expect(o).toMatchObject({ kind: 'image', mediaId: 'pic-abc123.jpg', credit: { creator: 'M. Harrington' } });
      expect(store.selectedId()).toBe(o.id);
      expect(store.dirty()).toBe(true);
    });

    it('creates an audio overlay', async () => {
      upload.mockResolvedValue('talk-abc123.mp3');
      await choose('[data-file-audio]', file('talk.mp3'));
      expect(overlaysOf('a')[0]).toMatchObject({ kind: 'audio', mediaId: 'talk-abc123.mp3' });
    });

    it('a refused upload leaves the document untouched and shows the backend message', async () => {
      upload.mockRejectedValue(new Error('that file type is not allowed'));
      const before = store.draft();
      await choose('[data-file-image]', file('a.exe'));
      expect(store.draft()).toBe(before);
      expect(store.dirty()).toBe(false);
      expect(store.canUndo()).toBe(false);
      expect(q('[data-outline-error]')?.textContent).toContain('that file type is not allowed');
    });

    it('does not touch the document while the upload is in flight', async () => {
      let resolve!: (id: string) => void;
      upload.mockReturnValue(new Promise<string>((r) => { resolve = r; }));
      const before = store.draft();
      const done = choose('[data-file-image]', file('p.jpg'));
      expect(store.draft()).toBe(before);
      resolve('p-abc123.jpg');
      await done;
      expect(store.draft()).not.toBe(before);
    });

    it('an image button given an audio file shows a message and changes nothing', async () => {
      upload.mockResolvedValue('talk-abc123.mp3');
      const before = store.draft();
      await choose('[data-file-image]', file('talk.mp3'));
      expect(store.draft()).toBe(before);
      expect(q('[data-outline-error]')?.textContent?.length).toBeGreaterThan(0);
    });

    it('says the stop is gone when it was deleted during the upload', async () => {
      let resolve!: (id: string) => void;
      upload.mockReturnValue(new Promise<string>((r) => { resolve = r; }));
      const done = choose('[data-file-image]', file('p.jpg'));
      store.apply((t) => ({ ...t, stops: t.stops.filter((s) => s.id !== 'a') }));
      resolve('p-abc123.jpg');
      await done;
      expect(q('[data-outline-error]')?.textContent).toMatch(/no longer exists/i);
    });

    describe('when the tour has no defaults', () => {
      beforeEach(() => {
        store.load({ ...tour([stop('a', 1)]), defaults: null });
        store.select('a');
        fixture.detectChanges();
      });
      const fill = (creator: string, license: string) => {
        const c = q('[data-defaults-creator]') as HTMLInputElement;
        const l = q('[data-defaults-license]') as HTMLInputElement;
        c.value = creator; c.dispatchEvent(new Event('input'));
        l.value = license; l.dispatchEvent(new Event('input'));
        fixture.detectChanges();
      };

      it('asks for a creator and licence before opening the file chooser', () => {
        const input = q('[data-file-image]') as HTMLInputElement;
        const open = vi.spyOn(input, 'click').mockImplementation(() => {});
        expect(q('[data-defaults-form]')).toBeNull();
        click('[data-add-image]');
        expect(q('[data-defaults-form]')).toBeTruthy();
        expect(open).not.toHaveBeenCalled();
      });

      it('refuses blanks, and writes the defaults with the overlay after a good upload', async () => {
        upload.mockResolvedValue('p-abc123.jpg');
        const input = q('[data-file-image]') as HTMLInputElement;
        const open = vi.spyOn(input, 'click').mockImplementation(() => {});
        click('[data-add-image]');
        fill('Ada', '  ');
        click('[data-defaults-submit]');
        expect(open).not.toHaveBeenCalled();
        expect(q('[data-defaults-error]')).toBeTruthy();
        fill('Ada', 'CC0');
        click('[data-defaults-submit]');
        expect(open).toHaveBeenCalledTimes(1);
        expect(store.draft()!.defaults).toBeNull(); // nothing written yet
        await choose('[data-file-image]', file('p.jpg'));
        expect(store.draft()!.defaults).toEqual({ creator: 'Ada', license: 'CC0' });
        expect(overlaysOf('a')[0].credit).toEqual({ type: 'original', creator: 'Ada', license: 'CC0' });
        expect(q('[data-defaults-form]')).toBeNull();
      });

      it('a text overlay asks first and then carries the answer onto the tour', () => {
        click('[data-add-overlay]');
        expect(q('[data-defaults-form]')).toBeTruthy();
        expect(overlaysOf('a').length).toBe(0);
        expect(store.draft()!.defaults).toBeNull();
        fill('Ada', 'CC0');
        click('[data-defaults-submit]');
        expect(store.draft()!.defaults).toEqual({ creator: 'Ada', license: 'CC0' });
        expect(overlaysOf('a')[0]).toMatchObject({ kind: 'text', credit: { creator: 'Ada', license: 'CC0' } });
        expect(q('[data-defaults-form]')).toBeNull();
      });

      it('an answer given for one tour is not applied to another tour without asking', () => {
        click('[data-add-image]');
        fill('Ada', 'CC0');
        click('[data-defaults-submit]');
        store.load({ ...tour([stop('a', 1)]), id: 'other', defaults: null });
        store.select('a');
        fixture.detectChanges();
        click('[data-add-overlay]');
        expect(q('[data-defaults-form]')).toBeTruthy();
        expect(store.draft()!.defaults).toBeNull();
        expect(overlaysOf('a').length).toBe(0);
      });

      it('says defaults are missing, not that the stop is gone, when the tour changed mid-upload', async () => {
        let resolve!: (id: string) => void;
        upload.mockReturnValue(new Promise<string>((r) => { resolve = r; }));
        click('[data-add-image]');
        fill('Ada', 'CC0');
        click('[data-defaults-submit]');
        const done = choose('[data-file-image]', file('p.jpg'));
        store.load({ ...tour([stop('a', 1)]), id: 'other', defaults: null });
        resolve('p-abc123.jpg');
        await done;
        expect(overlaysOf('a').length).toBe(0);
        const msg = q('[data-outline-error]')?.textContent ?? '';
        expect(msg).toMatch(/creator and licen[cs]e/i);
        expect(msg).not.toMatch(/no longer exists/i);
      });

      it('a refused upload writes no defaults, and the answer is not asked for again', async () => {
        upload.mockRejectedValue(new Error('nope'));
        const input = q('[data-file-image]') as HTMLInputElement;
        const open = vi.spyOn(input, 'click').mockImplementation(() => {});
        click('[data-add-image]');
        fill('Ada', 'CC0');
        click('[data-defaults-submit]');
        const before = store.draft();
        await choose('[data-file-image]', file('p.jpg'));
        expect(store.draft()).toBe(before);
        expect(store.draft()!.defaults).toBeNull();
        click('[data-add-image]');
        expect(q('[data-defaults-form]')).toBeNull();
        expect(open).toHaveBeenCalledTimes(2);
      });
    });
  });
});
