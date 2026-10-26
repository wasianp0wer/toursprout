import { describe, expect, it, beforeEach, vi, type MockInstance } from 'vitest';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Router, provideRouter } from '@angular/router';
import { WelcomePage } from './welcome-page';
import type { ExampleSummary } from '../core/session-api';

/**
 * A File carrying the relative path a directory picker would have given it.
 * `webkitRelativePath` is a read-only accessor, so it has to be defined onto
 * the instance; this is the shape the browser hands us, built by hand because
 * jsdom has neither a file picker nor a drag.
 */
function filed(path: string, name = path.split('/').pop()!): File {
  const file = new File(['x'], name);
  Object.defineProperty(file, 'webkitRelativePath', { value: path });
  return file;
}

/** A dropped file entry, as `webkitGetAsEntry()` returns one. */
function fileEntry(name: string, file = new File(['x'], name)): unknown {
  return {
    isFile: true,
    isDirectory: false,
    name,
    file: (ok: (f: File) => void) => ok(file),
  };
}

/**
 * A dropped directory entry.
 *
 * This fake hands its children back ONE PER BATCH, and only then an empty
 * batch. That is the quirk of the real `readEntries`: it yields a page at a
 * time (Chrome caps a page at 100) and signals the end with an empty array,
 * so a reader that calls it once silently sees only the first page. A fake
 * that returned everything in the first batch would pass a one-call
 * implementation just as happily, and the pagination loop is the part of this
 * module most likely to be rewritten by someone who does not know the quirk.
 */
function dirEntry(name: string, children: unknown[]): unknown {
  return {
    isFile: false,
    isDirectory: true,
    name,
    createReader: () => {
      let next = 0;
      return {
        readEntries: (ok: (entries: unknown[]) => void) => {
          ok(next < children.length ? [children[next++]] : []);
        },
      };
    },
  };
}

/** A DataTransfer offering `items` with entries (a real folder drag). */
function entryTransfer(entries: unknown[]): unknown {
  return { items: entries.map((e) => ({ webkitGetAsEntry: () => e })), files: [] };
}

/** A DataTransfer with files only — a browser without entry support, and
 * what an `<input type="file">` produces. */
function fileTransfer(files: File[]): unknown {
  return { items: [], files };
}

describe('WelcomePage', () => {
  let http: HttpTestingController;
  let navigate: MockInstance<Router['navigate']>;
  let fixture: ComponentFixture<WelcomePage>;
  let el: HTMLElement;

  const q = (sel: string) => el.querySelector(sel) as HTMLElement | null;

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [WelcomePage],
      providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])],
    });
    http = TestBed.inject(HttpTestingController);
    navigate = vi.spyOn(TestBed.inject(Router), 'navigate');
    navigate.mockResolvedValue(true);
  });

  /** The screen's work is promise-based and the app is zoneless, so
   * whenStable alone can run before an awaited request has resolved: a
   * macrotask tick first lets the promise chain finish. */
  async function settle(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  }

  /** Mounts the screen and answers its examples request. */
  async function mount(examples: ExampleSummary[] = []): Promise<void> {
    fixture = TestBed.createComponent(WelcomePage);
    el = fixture.nativeElement;
    fixture.detectChanges();
    http.expectOne('/api/session/examples').flush({ examples });
    await settle();
  }

  /** Dispatches a drop on the drop zone. jsdom has no DragEvent worth using,
   * and `dataTransfer` is not settable on an Event, so it is defined on. */
  async function drop(transfer: unknown): Promise<void> {
    const event = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', { value: transfer });
    q('[data-drop-zone]')!.dispatchEvent(event);
    await settle();
  }

  const FAIRFAX: ExampleSummary = {
    id: 'fairfax-old-town', title: 'Old Town Fairfax', description: 'Six stops',
  };

  it('offers a button per example and opens one', async () => {
    await mount([FAIRFAX]);

    const button = q('[data-example="fairfax-old-town"]');
    expect(button?.textContent).toContain('Old Town Fairfax');
    button!.click();
    await settle();

    const req = http.expectOne('/api/session/examples/fairfax-old-town');
    expect(req.request.method).toBe('POST');
    req.flush({ open: true, title: 'Old Town Fairfax', stopCount: 6 });
    await settle();

    expect(navigate).toHaveBeenCalledWith(['/edit']);
  });

  it('reads correctly with no examples configured', async () => {
    // The state every author but this one is in: no example button at all,
    // and the two ways in that do not depend on content still offered.
    await mount([]);

    expect(el.querySelectorAll('[data-example]').length).toBe(0);
    expect(q('[data-drop-zone]')).toBeTruthy();
    expect(q('[data-new-tour]')).toBeTruthy();
    expect(q('[data-new-title]')).toBeTruthy();
    expect(q('[data-browse]')).toBeTruthy();
    expect(q('[data-error]')).toBeNull();
  });

  it('creates a new tour from a title and goes to the editor', async () => {
    await mount([]);

    const title = q('[data-new-title]') as HTMLInputElement;
    title.value = 'Clifton';
    title.dispatchEvent(new Event('input'));
    await settle();
    q('[data-new-tour]')!.click();
    await settle();

    const req = http.expectOne('/api/session/new');
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({ title: 'Clifton' });
    req.flush({ open: true, title: 'Clifton' });
    await settle();

    expect(navigate).toHaveBeenCalledWith(['/edit']);
  });

  it('sends a dropped .zip to the bundle route', async () => {
    await mount([]);
    const zip = new File(['z'], 'tour.zip', { type: 'application/zip' });

    await drop(fileTransfer([zip]));

    const req = http.expectOne('/api/session/import');
    const sent = (req.request.body as FormData).get('file') as File;
    expect(sent.name).toBe('tour.zip');
    req.flush({ open: true, title: 'Imported' });
    await settle();
    expect(navigate).toHaveBeenCalledWith(['/edit']);
  });

  it('sends dropped loose files with their relative paths', async () => {
    await mount([]);

    await drop(fileTransfer([filed('tour.json'), filed('media/pano/p.jpg')]));

    const req = http.expectOne('/api/session/import-files');
    const names = (req.request.body as FormData).getAll('files').map((f) => (f as File).name);
    // The nested path survives: it is the only channel by which media/pano/
    // keeps its directory, and the repository's own tour needs it.
    expect(names).toEqual(['tour.json', 'media/pano/p.jpg']);
    req.flush({ open: true, title: 'Loose' });
    await settle();
    expect(navigate).toHaveBeenCalledWith(['/edit']);
  });

  it('walks a dropped folder through its entries', async () => {
    await mount([]);

    await drop(entryTransfer([
      fileEntry('tour.json'),
      dirEntry('media', [dirEntry('pano', [fileEntry('p.jpg')]), fileEntry('court.jpg')]),
    ]));

    const req = http.expectOne('/api/session/import-files');
    const names = (req.request.body as FormData).getAll('files').map((f) => (f as File).name);
    expect(names).toEqual(['tour.json', 'media/pano/p.jpg', 'media/court.jpg']);
  });

  it('files a loose media file that was dropped on its own under media/', async () => {
    await mount([]);

    await drop(fileTransfer([new File(['{}'], 'tour.json'), new File(['x'], 'court.jpg')]));

    const req = http.expectOne('/api/session/import-files');
    const names = (req.request.body as FormData).getAll('files').map((f) => (f as File).name);
    expect(names).toEqual(['tour.json', 'media/court.jpg']);
  });

  it('skips files that are not image or audio and names them', async () => {
    // The manifest.json landmine, in the UI this time. `cp content/media/*`
    // sweeps in manifest.json, and the loose-file route refuses it outright
    // — correctly, it is the backend's defence in depth — so the filter has
    // to run here, before the post, or the author gets a refusal instead of
    // a notice and the whole drop is lost.
    await mount([]);

    await drop(fileTransfer([
      filed('tour.json'), filed('media/court.jpg'), filed('media/manifest.json'),
    ]));

    const req = http.expectOne('/api/session/import-files');
    const names = (req.request.body as FormData).getAll('files').map((f) => (f as File).name);
    expect(names).toEqual(['tour.json', 'media/court.jpg']);
    expect(q('[data-skipped]')?.textContent).toContain('media/manifest.json');
    expect(q('[data-error]')).toBeNull();

    req.flush({ open: true, title: 'Loose' });
    await settle();
    expect(navigate).toHaveBeenCalledWith(['/edit']);
  });

  it('posts nothing when every dropped file was skipped', async () => {
    await mount([]);

    await drop(fileTransfer([filed('manifest.json')]));

    // An empty multipart would come back as "the drop has no tour.json",
    // which is true but unhelpful: nothing was sent at all.
    http.expectNone('/api/session/import-files');
    expect(q('[data-skipped]')?.textContent).toContain('manifest.json');
    expect(q('[data-error]')?.textContent).toBeTruthy();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('sends files chosen through the browse link', async () => {
    await mount([]);
    const input = q('[data-picker]') as HTMLInputElement;
    const clicked = vi.spyOn(input, 'click');

    q('[data-browse]')!.click();
    expect(clicked).toHaveBeenCalled();

    // jsdom's FileList is read-only, so the files are defined onto the input
    // the way the browser would have filled them in.
    Object.defineProperty(input, 'files', { value: [filed('tour.json')], writable: true });
    input.dispatchEvent(new Event('change'));
    await settle();

    http.expectOne('/api/session/import-files').flush({ open: true });
    await settle();
    expect(navigate).toHaveBeenCalledWith(['/edit']);
  });

  it('keeps nested media paths when a folder is chosen rather than dragged', async () => {
    // The author browses instead of dragging. A plain file input hands back
    // a flat list with no paths, so the six panoramas in the repository's own
    // media/pano/ would be filed directly under media/ and the import would
    // refuse the drop for media the author believed they had supplied —
    // which is why there is a directory picker as well as a file picker.
    await mount([]);
    const input = q('[data-picker-folder]') as HTMLInputElement;
    const clicked = vi.spyOn(input, 'click');

    q('[data-browse-folder]')!.click();
    expect(clicked).toHaveBeenCalled();

    // What a directory picker gives back: every file's webkitRelativePath
    // starts with the chosen folder's own name.
    Object.defineProperty(input, 'files', {
      writable: true,
      value: [filed('fairfax/tour.json'), filed('fairfax/media/pano/p.jpg')],
    });
    input.dispatchEvent(new Event('change'));
    await settle();

    const req = http.expectOne('/api/session/import-files');
    const names = (req.request.body as FormData).getAll('files').map((f) => (f as File).name);
    expect(names).toEqual(['tour.json', 'media/pano/p.jpg']);
    req.flush({ open: true, title: 'Old Town Fairfax' });
    await settle();
    expect(navigate).toHaveBeenCalledWith(['/edit']);
  });

  it('says so when the tour opened but the editor could not be reached', async () => {
    // The editor is a lazy chunk and the hop to it can fail on a dropped
    // connection. A tour is open by then, so every control here would 409:
    // the author needs to be told what happened, not shown the browser's
    // own "Failed to fetch dynamically imported module".
    navigate.mockRejectedValue(new Error('Failed to fetch dynamically imported module'));
    await mount([]);

    q('[data-new-tour]')!.click();
    await settle();
    http.expectOne('/api/session/new').flush({ open: true, title: 'Untitled tour' });
    await settle();

    expect(q('[data-error]')?.textContent).toMatch(/editor could not be loaded/i);
    expect(q('[data-error]')?.textContent).toMatch(/reload/i);
    // And nothing here can be used against the session that now has a tour
    // in it, nor does a progress note contradict the explanation.
    expect((q('[data-new-tour]') as HTMLButtonElement).disabled).toBe(true);
    expect((q('[data-browse]') as HTMLButtonElement).disabled).toBe(true);
    expect(q('[data-working]')).toBeNull();
  });

  it('skips a dot-prefixed sidecar instead of posting it', async () => {
    // macOS writes an AppleDouble `._court.jpg` beside the real one whenever
    // the media has been on exFAT, FAT or SMB — which is how a historian
    // moves photographs between machines. It has a .jpg extension, so an
    // extension-only filter posts it, and `loose_import._media_name` then
    // refuses THE WHOLE DROP with "a hidden file cannot be part of a tour".
    // Same failure as manifest.json, different filename.
    await mount([]);

    await drop(fileTransfer([
      filed('tour.json'), filed('media/court.jpg'), filed('media/._court.jpg'),
    ]));

    const req = http.expectOne('/api/session/import-files');
    const names = (req.request.body as FormData).getAll('files').map((f) => (f as File).name);
    expect(names).toEqual(['tour.json', 'media/court.jpg']);
    expect(q('[data-skipped]')?.textContent).toContain('media/._court.jpg');
    expect(q('[data-error]')).toBeNull();
    req.flush({ open: true, title: 'Old Town Fairfax' });
    await settle();
    expect(navigate).toHaveBeenCalledWith(['/edit']);
  });

  it('skips a file inside a dot-prefixed directory', async () => {
    await mount([]);

    await drop(fileTransfer([
      filed('tour.json'), filed('media/court.jpg'), filed('media/.thumbs/court.jpg'),
    ]));

    const req = http.expectOne('/api/session/import-files');
    const names = (req.request.body as FormData).getAll('files').map((f) => (f as File).name);
    expect(names).toEqual(['tour.json', 'media/court.jpg']);
    expect(q('[data-skipped]')?.textContent).toContain('media/.thumbs/court.jpg');
  });

  it('refuses a drop holding two tours rather than letting the server refuse it', async () => {
    await mount([]);

    await drop(fileTransfer([
      filed('clifton/tour.json'), filed('fairfax/tour.json'), filed('fairfax/media/court.jpg'),
    ]));

    http.expectNone('/api/session/import-files');
    expect(q('[data-error]')?.textContent).toMatch(/more than one tour\.json/i);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('refuses a drop in which two files would be the same media file', async () => {
    // `media/` dragged along with its parent: both halves map to the same
    // place in the bundle, and `stage_loose_bundle` refuses the lot.
    await mount([]);

    await drop(fileTransfer([
      filed('tour.json'), filed('media/court.jpg'), filed('fairfax/media/court.jpg'),
    ]));

    http.expectNone('/api/session/import-files');
    expect(q('[data-error]')?.textContent).toContain('media/court.jpg');
    expect(q('[data-error]')?.textContent).toMatch(/twice/i);
  });

  it('names the document to rename when a drop has no tour.json', async () => {
    // This author's own first use: HANDOFF.md has them rename
    // fairfax-old-town.json to tour.json. Dropped un-renamed, the media
    // alone would post and the server would answer "the drop has no
    // tour.json" — which reads as though it lost the files.
    await mount([]);

    await drop(fileTransfer([
      filed('fairfax-old-town.json'), filed('media/court.jpg'),
    ]));

    http.expectNone('/api/session/import-files');
    expect(q('[data-error]')?.textContent).toContain('fairfax-old-town.json');
    expect(q('[data-error]')?.textContent).toContain('tour.json');
    expect(navigate).not.toHaveBeenCalled();
  });

  it('does not offer manifest.json as the document to rename', async () => {
    // The media folder dropped on its own. The only .json in it is the
    // pipeline's manifest, which lives INSIDE media/ and is never the tour's
    // document, so telling the author to rename it would send them to make
    // the drop worse.
    await mount([]);

    await drop(fileTransfer([filed('media/court.jpg'), filed('media/manifest.json')]));

    http.expectNone('/api/session/import-files');
    const message = q('[data-error]')?.textContent ?? '';
    expect(message).toMatch(/no tour\.json/i);
    expect(message).not.toContain('manifest.json');
  });

  it('gives up on a folder that contains itself', async () => {
    // A symlink or junction pointing at an ancestor. Without a budget the
    // walk never returns: the tab wedges with the handler pending and the
    // screen simply doing nothing, which is the worst failure on offer.
    await mount([]);
    const loop: Record<string, unknown> = {
      isFile: false, isDirectory: true, name: 'media',
    };
    loop['createReader'] = () => {
      let next = 0;
      return {
        readEntries: (ok: (entries: unknown[]) => void) => {
          ok(next++ === 0 ? [loop] : []);
        },
      };
    };

    await drop(entryTransfer([loop]));

    http.expectNone('/api/session/import-files');
    expect(q('[data-error]')?.textContent).toMatch(/could not be read/i);
  });

  it('stops a drop that misses the drop zone from navigating away', async () => {
    // Released a few pixels outside the dashed border, Chrome opens the file
    // in place of the app — on the one screen whose job is the first
    // impression. The guard is on the window, so the app survives a near miss.
    await mount([]);

    for (const type of ['dragover', 'drop']) {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'dataTransfer', { value: fileTransfer([]) });
      window.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
    }
    await settle();

    // Blocked, not silently imported from wherever it landed.
    http.expectNone('/api/session/import-files');
    http.expectNone('/api/session/import');
  });

  it('shows the backend message when opening an example conflicts', async () => {
    await mount([FAIRFAX]);

    q('[data-example="fairfax-old-town"]')!.click();
    await settle();
    http.expectOne('/api/session/examples/fairfax-old-town').flush(
      { detail: 'a tour is already open; close it first' },
      { status: 409, statusText: 'Conflict' });
    await settle();

    expect(q('[data-error]')?.textContent).toContain('a tour is already open; close it first');
    expect(navigate).not.toHaveBeenCalled();
  });

  it('shows the backend message when a new tour conflicts', async () => {
    // Another tab opened something between the probe and this click.
    await mount([]);

    q('[data-new-tour]')!.click();
    await settle();
    http.expectOne('/api/session/new').flush(
      { detail: 'a tour is already open' }, { status: 409, statusText: 'Conflict' });
    await settle();

    expect(q('[data-error]')?.textContent).toContain('a tour is already open');
    expect(navigate).not.toHaveBeenCalled();
  });

  it('shows the backend message when an import is refused', async () => {
    await mount([]);

    await drop(fileTransfer([new File(['z'], 'junk.zip')]));
    http.expectOne('/api/session/import').flush(
      { detail: 'that .zip has no tour.json' }, { status: 400, statusText: 'Bad Request' });
    await settle();

    // Verbatim: three tasks' worth of effort went into these messages, and a
    // generic "import failed" would throw all of it away.
    expect(q('[data-error]')?.textContent).toContain('that .zip has no tour.json');
    expect(navigate).not.toHaveBeenCalled();
  });

  it('lists the guides as inert text under a note that they are unwritten', async () => {
    await mount([]);

    const guides = q('[data-guides]')!;
    const titles = [...guides.querySelectorAll('li')].map((li) => li.textContent?.trim());
    expect(titles).toEqual([
      'Getting started', 'Stops and narration', 'Placing a photograph',
      'Finding panoramas', 'Publishing your tour',
    ]);
    // Visible but inert, by the author's decision: nothing here navigates or
    // takes a click, so nothing can lead to a page that does not exist.
    expect(guides.querySelectorAll('a, button').length).toBe(0);
    expect(guides.textContent).toMatch(/not written yet/i);
  });
});
