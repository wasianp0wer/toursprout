import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { OutlinePane } from './outline-pane';
import { EditorStore } from './editor-store';
import { SessionApi } from '../core/session-api';
import { ToolsApi, type ArchiveResult } from '../core/tools-api';
import { overlay, stop, tour } from './test-builders';
import { installRecording, uninstallRecording } from './recording-fakes';

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
  describe('record audio', () => {
    let upload: ReturnType<typeof vi.fn>;
    const settle = async () => { await new Promise((r) => setTimeout(r, 5)); fixture.detectChanges(); };

    beforeEach(() => {
      upload = vi.fn();
      TestBed.resetTestingModule();
      TestBed.configureTestingModule({
        imports: [OutlinePane], providers: [{ provide: SessionApi, useValue: { uploadMedia: upload } }],
      });
      store = TestBed.inject(EditorStore);
      store.load(tour([stop('a', 1)]));
      fixture = TestBed.createComponent(OutlinePane);
      el = fixture.nativeElement;
      store.select('a');
      fixture.detectChanges();
    });
    afterEach(() => uninstallRecording());

    it('says plainly that this browser cannot record, and stays usable', async () => {
      uninstallRecording();
      click('[data-record]'); await settle();
      expect(q('[data-outline-error]')?.textContent).toMatch(/cannot record/i);
      expect((q('[data-record]') as HTMLButtonElement).disabled).toBe(false);
      expect(store.draft()!.stops[0].overlays.length).toBe(0);
    });

    it('says why when the microphone is refused', async () => {
      installRecording({ getUserMedia: () => Promise.reject(Object.assign(new Error('x'), { name: 'NotAllowedError' })) });
      click('[data-record]'); await settle();
      expect(q('[data-outline-error]')?.textContent).toMatch(/refused/i);
      expect(q('[data-record-stop]')).toBeNull();
      expect((q('[data-record]') as HTMLButtonElement).disabled).toBe(false);
    });

    it('records, uploads through the shared path, creates the overlay and releases the microphone', async () => {
      const { tracks } = installRecording();
      upload.mockResolvedValue('recording-abc123.webm');
      click('[data-record]'); await settle();
      expect(q('[data-record-stop]')).toBeTruthy();
      expect(upload).not.toHaveBeenCalled();
      click('[data-record-stop]'); await settle();
      expect(upload).toHaveBeenCalledTimes(1);
      expect((upload.mock.calls[0][0] as File).name).toBe('recording.webm');
      expect(store.draft()!.stops[0].overlays[0]).toMatchObject({ kind: 'audio', mediaId: 'recording-abc123.webm' });
      for (const t of tracks) expect(t.stop).toHaveBeenCalled();
      expect(q('[data-record-stop]')).toBeNull();
    });

    it('puts the Safari limitation in front of the author while recording, and keeps it after', async () => {
      installRecording();
      upload.mockResolvedValue('recording-abc123.webm');
      click('[data-record]'); await settle();
      expect(q('[data-record-format]')?.textContent).toMatch(/Safari cannot play/);
      click('[data-record-stop]'); await settle();
      expect(q('[data-record-format]')?.textContent).toMatch(/Safari cannot play/);
    });

    it('shows no Safari warning when the browser records MP4', async () => {
      installRecording({ mimeType: 'audio/mp4' });
      upload.mockResolvedValue('recording-abc123.m4a');
      click('[data-record]'); await settle();
      expect(q('[data-record-format]')).toBeNull();
    });

    it('cancel releases the microphone and uploads nothing', async () => {
      const { tracks } = installRecording();
      click('[data-record]'); await settle();
      click('[data-record-cancel]'); await settle();
      for (const t of tracks) expect(t.stop).toHaveBeenCalled();
      expect(upload).not.toHaveBeenCalled();
      expect(q('[data-record-stop]')).toBeNull();
    });

    it('a refused upload shows the message and leaves the document alone', async () => {
      installRecording();
      upload.mockRejectedValue(new Error('too big'));
      click('[data-record]'); await settle();
      click('[data-record-stop]'); await settle();
      expect(q('[data-outline-error]')?.textContent).toContain('too big');
      expect(store.dirty()).toBe(false);
      expect(store.draft()!.stops[0].overlays.length).toBe(0);
    });

    it('destroying the pane mid-recording releases the microphone', async () => {
      const { tracks } = installRecording();
      click('[data-record]'); await settle();
      expect(q('[data-record-stop]')).toBeTruthy();
      for (const t of tracks) expect(t.stop).not.toHaveBeenCalled();
      fixture.destroy();
      for (const t of tracks) expect(t.stop).toHaveBeenCalled();
    });

    it('releases a microphone granted after the pane was destroyed during the prompt', async () => {
      let grant!: (s: unknown) => void;
      const { tracks, stream } = installRecording({ getUserMedia: () => new Promise((r) => { grant = r; }) });
      click('[data-record]'); await settle();
      fixture.destroy();
      grant(stream); await new Promise((r) => setTimeout(r, 5));
      for (const t of tracks) expect(t.stop).toHaveBeenCalled();
    });

    it('lets the author discard while the permission prompt is open, and releases a late grant', async () => {
      let grant!: (s: unknown) => void;
      const { tracks, stream } = installRecording({ getUserMedia: () => new Promise((r) => { grant = r; }) });
      click('[data-record]'); await settle();
      expect(q('[data-record-stop]')).toBeNull();
      click('[data-record-cancel]');
      expect(q('[data-record]')).toBeTruthy();
      grant(stream); await settle();
      for (const t of tracks) expect(t.stop).toHaveBeenCalled();
      expect(q('[data-record-stop]')).toBeNull();
      expect(upload).not.toHaveBeenCalled();
    });

    it('clears the format note on discard', async () => {
      installRecording();
      click('[data-record]'); await settle();
      expect(q('[data-record-format]')).toBeTruthy();
      click('[data-record-cancel]'); await settle();
      expect(q('[data-record-format]')).toBeNull();
    });

    it('takes the format from the clip when the recorder did not say, so MP4 gets no false warning', async () => {
      installRecording({ reported: '', chunkType: 'audio/mp4' });
      upload.mockResolvedValue('recording-abc123.m4a');
      click('[data-record]'); await settle();
      click('[data-record-stop]'); await settle();
      expect((upload.mock.calls[0][0] as File).name).toBe('recording.m4a');
      expect(q('[data-record-format]')).toBeNull();
    });

    it('asks for creator and licence first when the tour has none', async () => {
      installRecording();
      store.load({ ...tour([stop('a', 1)]), defaults: null }); store.select('a'); fixture.detectChanges();
      click('[data-record]'); await settle();
      expect(q('[data-defaults-form]')).toBeTruthy();
      expect(q('[data-record-stop]')).toBeNull();
    });

    it('is disabled with no current stop', () => {
      store.select(null); fixture.detectChanges();
      expect((q('[data-record]') as HTMLButtonElement).disabled).toBe(true);
    });
  });

  describe('archive search and narration', () => {
    let upload: ReturnType<typeof vi.fn>;
    let archiveSearch: ReturnType<typeof vi.fn>;
    let narrate: ReturnType<typeof vi.fn>;
    let fetchMock: ReturnType<typeof vi.fn>;
    const settle = async () => { await new Promise((r) => setTimeout(r, 5)); fixture.detectChanges(); };
    const press = async (sel: string, i = 0) => {
      (el.querySelectorAll(sel)[i] as HTMLElement).click(); await settle();
    };
    const typeInto = async (sel: string, value: string, i = 0) => {
      const n = el.querySelectorAll(sel)[i] as HTMLInputElement;
      n.value = value; n.dispatchEvent(new Event('input')); await settle();
    };
    const result = (over: Partial<ArchiveResult> = {}): ArchiveResult => ({
      title: 'Courthouse, 1920', date: '1920', creator: 'A. Photographer',
      thumbUrl: 'https://tile.loc.gov/t.jpg', imageUrl: 'https://tile.loc.gov/full.jpg',
      itemUrl: 'https://www.loc.gov/item/123/', rights: 'No known restrictions', ...over,
    });
    const overlaysOf = () => store.draft()!.stops.find((s) => s.id === 'a')!.overlays;
    const search = async (results: ArchiveResult[]) => {
      archiveSearch.mockResolvedValue(results);
      await press('[data-archive-open]');
      await typeInto('[data-archive-query]', 'fairfax courthouse');
      await press('[data-archive-search]');
    };

    beforeEach(() => {
      upload = vi.fn();
      archiveSearch = vi.fn();
      narrate = vi.fn();
      fetchMock = vi.fn().mockResolvedValue({
        ok: true, blob: async () => new Blob([new Uint8Array([1])], { type: 'image/jpeg' }),
      });
      vi.stubGlobal('fetch', fetchMock);
      TestBed.resetTestingModule();
      TestBed.configureTestingModule({
        imports: [OutlinePane],
        providers: [
          { provide: SessionApi, useValue: { uploadMedia: upload } },
          { provide: ToolsApi, useValue: { archiveSearch, narrate } },
        ],
      });
      store = TestBed.inject(EditorStore);
      store.load(tour([stop('a', 1, [overlay('o1', { body: 'Overlay words' })], { summary: 'Stop words' })]));
      fixture = TestBed.createComponent(OutlinePane);
      el = fixture.nativeElement;
      store.select('a');
      fixture.detectChanges();
    });
    afterEach(() => vi.unstubAllGlobals());

    it('lists results with their rights', async () => {
      await search([result()]);
      expect(q('[data-archive-result="0"]')?.textContent).toContain('Courthouse, 1920');
      expect(q('[data-archive-result="0"]')?.textContent).toContain('No known restrictions');
      expect(archiveSearch).toHaveBeenCalledWith('fairfax courthouse');
    });

    it('inserts a result: fetches, uploads, then adds a sourced image overlay', async () => {
      upload.mockResolvedValue('pic-1.jpg');
      await search([result()]);
      await press('[data-archive-insert]');
      expect(fetchMock).toHaveBeenCalledWith('https://tile.loc.gov/full.jpg');
      expect(upload).toHaveBeenCalledTimes(1);
      const added = overlaysOf().at(-1)!;
      expect(added.mediaId).toBe('pic-1.jpg');
      expect(added.title).toBe('Courthouse, 1920');
      expect(added.credit).toEqual({
        type: 'sourced', source: 'Library of Congress', url: 'https://www.loc.gov/item/123/',
        license: 'No known restrictions', creator: 'A. Photographer',
      });
      expect(store.selectedId()).toBe(added.id);
    });

    it('works on a tour with no defaults: the archive credit needs none', async () => {
      store.load({ ...tour([stop('a', 1)]), defaults: null }); store.select('a');
      upload.mockResolvedValue('pic-1.jpg');
      await search([result()]);
      await press('[data-archive-insert]');
      expect(q('[data-defaults-form]')).toBeNull();
      expect(overlaysOf().length).toBe(1);
    });

    it('null rights: refuses to insert until the author supplies a licence, then uses it', async () => {
      upload.mockResolvedValue('pic-1.jpg');
      await search([result({ rights: null })]);
      expect(q('[data-archive-result="0"]')?.textContent).toMatch(/no rights/i);
      const before = store.draft();
      await press('[data-archive-insert]');
      expect(q('[data-outline-error]')?.textContent).toMatch(/licence/i);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(upload).not.toHaveBeenCalled();
      expect(store.draft()).toBe(before);
      await typeInto('[data-archive-license]', 'Public domain (author-verified)');
      await press('[data-archive-insert]');
      expect(overlaysOf().at(-1)!.credit).toMatchObject({ type: 'sourced', license: 'Public domain (author-verified)' });
    });

    it('a failed image download changes nothing and shows why', async () => {
      fetchMock.mockResolvedValue({ ok: false, status: 404 });
      await search([result()]);
      const before = store.draft();
      await press('[data-archive-insert]');
      expect(q('[data-outline-error]')?.textContent).toMatch(/download/i);
      expect(upload).not.toHaveBeenCalled();
      expect(store.draft()).toBe(before);
      expect(store.dirty()).toBe(false);
    });

    it('a download that cannot reach the archive (CORS, offline) shows the failure', async () => {
      fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
      await search([result()]);
      const before = store.draft();
      await press('[data-archive-insert]');
      expect(q('[data-outline-error]')?.textContent).toMatch(/download/i);
      expect(store.draft()).toBe(before);
    });

    it('a refused upload changes nothing', async () => {
      upload.mockRejectedValue(new Error('that file type is not allowed'));
      await search([result()]);
      const before = store.draft();
      await press('[data-archive-insert]');
      expect(q('[data-outline-error]')?.textContent).toContain('that file type is not allowed');
      expect(store.draft()).toBe(before);
    });

    it('a failed search shows the message and keeps the document', async () => {
      archiveSearch.mockRejectedValue(new Error('the Library of Congress timed out'));
      const before = store.draft();
      await press('[data-archive-open]');
      await typeInto('[data-archive-query]', 'x');
      await press('[data-archive-search]');
      expect(q('[data-outline-error]')?.textContent).toContain('the Library of Congress timed out');
      expect(store.draft()).toBe(before);
    });

    it('narrates a stop summary into an audio overlay with the synthesiser credit', async () => {
      narrate.mockResolvedValue({
        mediaId: 'nar-1.m4a', credit: { source: 's', license: 'Generated for this tour', creator: 'macOS voice Samantha' },
      });
      await press('[data-narrate]');
      expect(narrate).toHaveBeenCalledWith('Stop words');
      const added = overlaysOf().at(-1)!;
      expect(added).toMatchObject({ kind: 'audio', mediaId: 'nar-1.m4a', display: { mode: 'marker' } });
      expect(added.credit).toEqual({ type: 'original', creator: 'macOS voice Samantha', license: 'Generated for this tour' });
      expect(store.selectedId()).toBe(added.id);
    });

    it('narrates a selected overlay body into the same stop', async () => {
      narrate.mockResolvedValue({ mediaId: 'nar-2.m4a', credit: { source: 's', license: 'L', creator: 'C' } });
      store.select('o1'); fixture.detectChanges();
      await press('[data-narrate]');
      expect(narrate).toHaveBeenCalledWith('Overlay words');
      expect(overlaysOf().length).toBe(2);
    });

    it('narrate is off when there is nothing to say', async () => {
      store.load(tour([stop('a', 1, [], { summary: ' ' })])); store.select('a'); fixture.detectChanges();
      expect((q('[data-narrate]') as HTMLButtonElement).disabled).toBe(true);
    });

    it('a failed narration shows its message and leaves the document half-way nowhere', async () => {
      narrate.mockRejectedValue(new Error('speech synthesis is not available'));
      const before = store.draft();
      await press('[data-narrate]');
      expect(q('[data-outline-error]')?.textContent).toContain('speech synthesis is not available');
      expect(store.draft()).toBe(before);
      expect(store.dirty()).toBe(false);
    });
  });
});
