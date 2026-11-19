import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { MediaField } from './media-field';
import { EditorStore } from './editor-store';
import { SessionApi } from '../core/session-api';
import { deleteOverlay } from './document-ops';
import { overlay, stop, tour } from './test-builders';
import { installRecording, uninstallRecording } from './recording-fakes';
import type { Overlay } from '../core/tour.models';

describe('MediaField', () => {
  let store: EditorStore;
  let el: HTMLElement;
  let fixture: ReturnType<typeof TestBed.createComponent<MediaField>>;
  let uploadMedia: ReturnType<typeof vi.fn>;

  const q = (sel: string) => el.querySelector(sel) as HTMLElement | null;
  const image = (id: string, mediaId = 'old-1111.jpg'): Overlay =>
    overlay(id, { kind: 'image', mediaId, title: `Title ${id}`, credit: { type: 'original', creator: 'Ada', license: 'CC-BY-4.0' } });
  const audio = (id: string, mediaId = 'old-2222.webm'): Overlay => overlay(id, { kind: 'audio', mediaId });
  const ov = (id: string): Overlay =>
    store.draft()!.stops.flatMap((s) => s.overlays).find((o) => o.id === id)!;
  const flush = async () => { await new Promise((r) => setTimeout(r, 0)); fixture.detectChanges(); };

  /** Open the field on overlay `id` of a tour holding `overlays`. */
  const open = (overlays: Overlay[], id = overlays[0].id) => {
    store.load(tour([stop('s1', 1, overlays)]));
    store.select(id);
    fixture = TestBed.createComponent(MediaField);
    fixture.componentRef.setInput('overlay', store.selectedOverlay());
    el = fixture.nativeElement;
    fixture.detectChanges();
  };
  /** Press Replace, then deliver a file to the hidden input. */
  const choose = async (name = 'new.jpg') => {
    (q('[data-replace-file]') as HTMLButtonElement).click();
    const input = q('[data-media-file]') as HTMLInputElement;
    Object.defineProperty(input, 'files', { value: [new File([new Uint8Array([1])], name)], configurable: true });
    input.dispatchEvent(new Event('change'));
    fixture.detectChanges();
  };

  beforeEach(() => {
    uploadMedia = vi.fn();
    TestBed.configureTestingModule({
      imports: [MediaField],
      providers: [{ provide: SessionApi, useValue: { uploadMedia } }],
    });
    store = TestBed.inject(EditorStore);
  });

  it('shows the image', () => {
    open([image('o1')]);
    const img = q('[data-media-preview]') as HTMLImageElement;
    expect(img.tagName).toBe('IMG');
    expect(img.src.endsWith('tour-data/media/old-1111.jpg')).toBe(true);
    expect(q('[data-media-name]')!.textContent).toContain('old-1111.jpg');
  });

  it('shows a playable audio control with its type', () => {
    open([audio('o1')]);
    const a = q('[data-media-preview]') as HTMLAudioElement;
    expect(a.tagName).toBe('AUDIO');
    expect(a.controls).toBe(true);
    const source = a.querySelector('source')!;
    expect(source.src.endsWith('tour-data/media/old-2222.webm')).toBe(true);
    expect(source.getAttribute('type')).toBe('audio/webm');
    expect(q('[data-media-name]')!.textContent).toContain('old-2222.webm');
  });

  it('offers the image accept list', () => {
    open([image('o1')]);
    expect(q('[data-media-file]')!.getAttribute('accept')).toBe('image/jpeg,image/png,image/webp');
  });

  it('offers the audio accept list', () => {
    open([audio('o1')]);
    expect(q('[data-media-file]')!.getAttribute('accept')).toBe('audio/*,.webm,.m4a,.mp3,.ogg,.wav');
  });

  it('replaces the file and keeps title and credit', async () => {
    open([image('o1')]);
    uploadMedia.mockResolvedValue('new-9999.jpg');
    await choose();
    await flush();
    expect(uploadMedia).toHaveBeenCalledTimes(1);
    expect(ov('o1').mediaId).toBe('new-9999.jpg');
    expect(ov('o1').title).toBe('Title o1');
    expect(ov('o1').credit).toEqual({ type: 'original', creator: 'Ada', license: 'CC-BY-4.0' });
    expect(store.canUndo()).toBe(true);
  });

  it('a refused upload leaves the document untouched', async () => {
    open([image('o1')]);
    const before = store.draft();
    uploadMedia.mockRejectedValue(new Error('too big'));
    await choose();
    await flush();
    expect(q('[data-media-error]')!.textContent).toContain('too big');
    expect(q('[data-media-error]')!.getAttribute('role')).toBe('alert');
    expect(store.draft()).toBe(before);
    expect(store.canUndo()).toBe(false);
    expect(store.dirty()).toBe(false);
  });

  it('falls back to a generic message when the upload throws a non-error', async () => {
    open([image('o1')]);
    uploadMedia.mockRejectedValue('nope');
    await choose();
    await flush();
    expect(q('[data-media-error]')!.textContent).toContain('the upload failed');
  });

  it('refuses a file of the other kind', async () => {
    open([image('o1')]);
    const before = store.draft();
    uploadMedia.mockResolvedValue('x.webm');
    await choose();
    await flush();
    expect(q('[data-media-error]')!.textContent).toContain('That file is audio, not image.');
    expect(store.draft()).toBe(before);
  });

  it('the same file again adds no undo step', async () => {
    open([image('o1')]);
    uploadMedia.mockResolvedValue('old-1111.jpg');
    await choose();
    await flush();
    expect(store.canUndo()).toBe(false);
  });

  it('replaces the overlay pressed on, even after the selection moves', async () => {
    open([image('o1'), image('o2', 'two-2222.jpg')]);
    let resolve!: (id: string) => void;
    uploadMedia.mockReturnValue(new Promise<string>((r) => { resolve = r; }));
    await choose();
    expect(q('[data-media-busy]')).toBeTruthy();
    store.select('o2');
    fixture.componentRef.setInput('overlay', store.selectedOverlay());
    fixture.detectChanges();
    expect(q('[data-media-busy]')).toBeNull();
    resolve('new-9999.jpg');
    await flush();
    expect(ov('o1').mediaId).toBe('new-9999.jpg');
    expect(ov('o2').mediaId).toBe('two-2222.jpg');
    expect(q('[data-media-error]')).toBeNull();
  });

  it('does not write a late failure onto another overlay', async () => {
    open([image('o1'), image('o2', 'two-2222.jpg')]);
    let reject!: (e: Error) => void;
    uploadMedia.mockReturnValue(new Promise<string>((_, r) => { reject = r; }));
    await choose();
    store.select('o2');
    fixture.componentRef.setInput('overlay', store.selectedOverlay());
    fixture.detectChanges();
    reject(new Error('too big'));
    await flush();
    expect(q('[data-media-error]')).toBeNull();
    expect((q('[data-replace-file]') as HTMLButtonElement).disabled).toBe(false);
  });

  it('does not touch the document when the target is gone', async () => {
    open([image('o1'), image('o2', 'two-2222.jpg')]);
    let resolve!: (id: string) => void;
    uploadMedia.mockReturnValue(new Promise<string>((r) => { resolve = r; }));
    await choose();
    store.apply((t) => deleteOverlay(t, 'o1'));
    const afterDelete = store.draft();
    resolve('new-9999.jpg');
    await flush();
    expect(store.draft()).toBe(afterDelete);
    expect(q('[data-media-error]')!.textContent).toContain('The file was uploaded but not applied.');
  });

  it('says File not found when the preview fails, and still offers Replace', () => {
    open([image('o1')]);
    expect(q('[data-media-missing]')).toBeNull();
    q('img')!.dispatchEvent(new Event('error'));
    fixture.detectChanges();
    expect(q('[data-media-missing]')!.textContent).toContain('File not found.');
    expect((q('[data-replace-file]') as HTMLButtonElement).disabled).toBe(false);
  });

  it('clears the missing note when the file changes', async () => {
    open([image('o1')]);
    q('img')!.dispatchEvent(new Event('error'));
    fixture.detectChanges();
    uploadMedia.mockResolvedValue('new-9999.jpg');
    await choose();
    await flush();
    fixture.componentRef.setInput('overlay', store.selectedOverlay());
    fixture.detectChanges();
    expect(q('[data-media-missing]')).toBeNull();
  });

  it('rebuilds the audio element after a replace, so it plays the new file', async () => {
    open([audio('o1')]);
    const before = q('audio');
    uploadMedia.mockResolvedValue('new-3333.webm');
    await choose('new.webm');
    await flush();
    fixture.componentRef.setInput('overlay', store.selectedOverlay());
    fixture.detectChanges();
    expect(q('audio')).not.toBe(before);
    expect(q('audio source')!.getAttribute('src')).toContain('new-3333.webm');
  });

  it('rebuilds the audio element when another audio overlay is shown', () => {
    open([audio('o1'), audio('o2', 'two-4444.webm')]);
    const before = q('audio');
    store.select('o2');
    fixture.componentRef.setInput('overlay', store.selectedOverlay());
    fixture.detectChanges();
    expect(q('audio')).not.toBe(before);
  });

  it('rebuilds the image element when the file changes', () => {
    open([image('o1'), image('o2', 'two-2222.jpg')]);
    const before = q('img');
    store.select('o2');
    fixture.componentRef.setInput('overlay', store.selectedOverlay());
    fixture.detectChanges();
    expect(q('img')).not.toBe(before);
  });

  it('disables Replace while uploading', async () => {
    open([image('o1')]);
    let resolve!: (id: string) => void;
    uploadMedia.mockReturnValue(new Promise<string>((r) => { resolve = r; }));
    await choose();
    expect((q('[data-replace-file]') as HTMLButtonElement).disabled).toBe(true);
    resolve('new-9999.jpg');
    await flush();
    expect((q('[data-replace-file]') as HTMLButtonElement).disabled).toBe(false);
    expect(q('[data-media-busy]')).toBeNull();
  });

  describe('recording a replacement', () => {
    const settle = async () => { await new Promise((r) => setTimeout(r, 5)); fixture.detectChanges(); };
    const click = (sel: string) => { (q(sel) as HTMLElement).click(); fixture.detectChanges(); };
    afterEach(() => uninstallRecording());

    it('offers Record only for audio', () => {
      open([audio('o1')]);
      expect(q('[data-record-replace]')).toBeTruthy();
      open([image('o1')]);
      expect(q('[data-record-replace]')).toBeNull();
    });

    it('records and replaces the clip', async () => {
      installRecording();
      open([audio('o1')]);
      uploadMedia.mockResolvedValue('take2-aaaa.webm');
      click('[data-record-replace]'); await settle();
      expect(q('[data-media-recording]')!.getAttribute('role')).toBe('status');
      expect(q('[data-media-recording]')!.textContent).toContain('Recording from your microphone…');
      expect(uploadMedia).not.toHaveBeenCalled();
      click('[data-record-replace-stop]'); await settle();
      expect(ov('o1').mediaId).toBe('take2-aaaa.webm');
      expect(ov('o1').title).toBe('An overlay');
      expect(q('[data-media-recording]')).toBeNull();
    });

    it('discard leaves the document untouched and releases the microphone', async () => {
      const { tracks } = installRecording();
      open([audio('o1')]);
      const before = store.draft();
      click('[data-record-replace]'); await settle();
      click('[data-record-replace-cancel]'); await settle();
      for (const t of tracks) expect(t.stop).toHaveBeenCalled();
      expect(store.draft()).toBe(before);
      expect(uploadMedia).not.toHaveBeenCalled();
      expect(q('[data-record-replace]')).toBeTruthy();
    });

    it('says why when MediaRecorder is missing', async () => {
      uninstallRecording();
      open([audio('o1')]);
      click('[data-record-replace]'); await settle();
      expect(q('[data-media-error]')!.textContent).toMatch(/cannot record/i);
      expect(q('[data-record-replace]')).toBeTruthy();
    });

    it('says why when permission is denied', async () => {
      installRecording({ getUserMedia: () => Promise.reject(Object.assign(new Error('x'), { name: 'NotAllowedError' })) });
      open([audio('o1')]);
      click('[data-record-replace]'); await settle();
      expect(q('[data-media-error]')!.textContent).toMatch(/refused/i);
      expect(q('[data-record-replace]')).toBeTruthy();
      expect(q('[data-media-recording]')).toBeNull();
    });

    it('releases the microphone when destroyed mid-recording', async () => {
      const { tracks } = installRecording();
      open([audio('o1')]);
      click('[data-record-replace]'); await settle();
      fixture.destroy();
      for (const t of tracks) expect(t.stop).toHaveBeenCalled();
    });

    it('disables Replace and Record while recording', async () => {
      installRecording();
      open([audio('o1')]);
      click('[data-record-replace]'); await settle();
      expect((q('[data-replace-file]') as HTMLButtonElement).disabled).toBe(true);
      expect(q('[data-record-replace]')).toBeNull();
    });

    it('cancels the recording when another overlay is selected', async () => {
      const { tracks } = installRecording();
      open([audio('o1'), audio('o2', 'other-3333.webm')]);
      const before = store.draft();
      click('[data-record-replace]'); await settle();
      expect(q('[data-media-recording]')).toBeTruthy();
      fixture.componentRef.setInput('overlay', ov('o2'));
      fixture.detectChanges(); await settle();
      for (const t of tracks) expect(t.stop).toHaveBeenCalled();
      expect(q('[data-media-recording]')).toBeNull();
      expect(q('[data-media-record-format]')).toBeNull();
      expect(q('[data-record-replace]')).toBeTruthy();
      expect(store.draft()).toBe(before);
    });

    /** getUserMedia that stays pending until `grant()`, standing in for the permission prompt. */
    const pendingPrompt = () => {
      let grant!: () => void;
      const stream = installRecording({ getUserMedia: () => new Promise((r) => { grant = () => r(stream.stream); }) });
      return { tracks: stream.tracks, grant: () => grant() };
    };

    it('releases a late start when another overlay was selected while starting', async () => {
      const { tracks, grant } = pendingPrompt();
      open([audio('o1'), audio('o2', 'other-3333.webm')]);
      click('[data-record-replace]'); await settle();
      fixture.componentRef.setInput('overlay', ov('o2'));
      fixture.detectChanges(); await settle();
      grant(); await settle();
      for (const t of tracks) expect(t.stop).toHaveBeenCalled();
      expect(q('[data-media-recording]')).toBeNull();
      expect(q('[data-record-replace-stop]')).toBeNull();
      expect(q('[data-record-replace]')).toBeTruthy();
    });

    it('releases a late start when destroyed while starting', async () => {
      const { tracks, grant } = pendingPrompt();
      open([audio('o1')]);
      click('[data-record-replace]'); await settle();
      fixture.destroy();
      grant(); await settle();
      for (const t of tracks) expect(t.stop).toHaveBeenCalled();
    });
  });
});
