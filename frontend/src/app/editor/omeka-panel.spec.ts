import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { OmekaPanel, type OmekaAdded } from './omeka-panel';
import { ToolsApi, type OmekaFile, type OmekaItem, type OmekaSearch } from '../core/tools-api';

const SITE_KEY = 'clio-wired.omeka-site';
const site = { base: 'https://omeka.madelynharrington.net', title: "Madelyn's Interests and Exhibits" };

/** Shapes as the backend returns them for the live demo site (backend/tests/fixtures/omeka). */
function item(itemId: number, over: Partial<OmekaItem> = {}): OmekaItem {
  return {
    itemId, itemUrl: `${site.base}/items/show/${itemId}`, title: `Item ${itemId}`,
    description: null, creator: null, date: null, rights: null, fileCount: 1, ...over,
  };
}
const fifi = item(2, {
  title: 'John Moisant and Mademoiselle Fifi', description: 'Aviation pioneer John Moisant and his cat',
  creator: 'Unknown', date: 'August 31, 1910', rights: 'Public Domain', fileCount: 2,
});
const cats = item(3, { title: 'Medieval Cats', description: 'Medieval cats doing their jobs', creator: 'unknown' });

const jpeg: OmekaFile = {
  fileId: 2, kind: 'image', filename: 'fifi-and-moisant.jpg', thumbUrl: `${site.base}/files/thumbnails/2.jpg`,
  importable: true, reason: null, title: null, creator: null, rights: null,
};
const pdf: OmekaFile = {
  fileId: 9, kind: null, filename: 'handbill.pdf', thumbUrl: null,
  importable: false, reason: "PDF files can't be added to a tour.", title: null, creator: null, rights: null,
};
const png: OmekaFile = { ...jpeg, fileId: 3, filename: 'Screenshot 2026-09-21 200951.png' };

const page = (results: OmekaItem[], total = results.length, n = 1): OmekaSearch => ({ site, total, page: n, results });

describe('OmekaPanel', () => {
  let tools: { omekaSearch: ReturnType<typeof vi.fn>; omekaFiles: ReturnType<typeof vi.fn>; omekaImport: ReturnType<typeof vi.fn> };
  let fixture: ReturnType<typeof TestBed.createComponent<OmekaPanel>>;
  let el: HTMLElement;
  let emitted: OmekaAdded[];

  const q = (sel: string) => el.querySelector(sel) as HTMLElement | null;
  const all = (sel: string) => Array.from(el.querySelectorAll(sel)) as HTMLElement[];
  /** Handlers are async; let their awaited promises resolve before looking. */
  const settle = async () => {
    for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0));
    fixture.detectChanges();
  };
  const type = (sel: string, value: string) => {
    const input = q(sel) as HTMLInputElement;
    input.value = value;
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
  };
  const click = async (sel: string) => { (q(sel) as HTMLElement).click(); await settle(); };

  const create = (stopId = 'a') => {
    fixture = TestBed.createComponent(OmekaPanel);
    fixture.componentRef.setInput('stopId', stopId);
    emitted = [];
    fixture.componentInstance.added.subscribe((e) => emitted.push(e));
    el = fixture.nativeElement;
    fixture.detectChanges();
  };
  const search = async (siteUrl = 'omeka.madelynharrington.net', query = 'cat') => {
    type('[data-omeka-site]', siteUrl);
    type('[data-omeka-query]', query);
    await click('[data-omeka-search]');
  };

  beforeEach(() => {
    try { localStorage.removeItem(SITE_KEY); } catch { /* none */ }
    tools = {
      omekaSearch: vi.fn().mockResolvedValue(page([fifi, cats])),
      omekaFiles: vi.fn().mockImplementation(async (_s: string, id: number) => (id === 2 ? [jpeg, pdf] : [png])),
      omekaImport: vi.fn().mockResolvedValue('fifi-abc123.jpg'),
    };
    TestBed.configureTestingModule({ imports: [OmekaPanel], providers: [{ provide: ToolsApi, useValue: tools }] });
    create();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    try { localStorage.removeItem(SITE_KEY); } catch { /* none */ }
  });

  it('searches with the typed site and query and lists items with file counts', async () => {
    await search('omeka.madelynharrington.net', 'courthouse');
    expect(tools.omekaSearch).toHaveBeenCalledWith('omeka.madelynharrington.net', 'courthouse', 1);
    expect(el.textContent).toContain(site.title);
    expect(q('[data-omeka-item="2"]')?.textContent).toContain('John Moisant and Mademoiselle Fifi');
    expect(q('[data-omeka-item="2"]')?.textContent).toContain('2 files');
    expect(q('[data-omeka-item="3"]')?.textContent).toContain('1 file');
    expect(q('[data-omeka-item="3"]')?.textContent).not.toContain('1 files');
  });

  it('remembers the site address across panel instances', async () => {
    await search('omeka.madelynharrington.net', 'cat');
    create();
    expect((q('[data-omeka-site]') as HTMLInputElement).value).toBe('omeka.madelynharrington.net');
  });

  it('survives localStorage throwing', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    create();
    expect((q('[data-omeka-site]') as HTMLInputElement).value).toBe('');
    await search();
    expect(tools.omekaSearch).toHaveBeenCalledTimes(1);
    expect(q('[data-omeka-item="2"]')).toBeTruthy();
  });

  it('opens an item and lists its files, non-importable ones with their reason and no Add button', async () => {
    await search();
    await click('[data-omeka-item="2"]');
    expect(tools.omekaFiles).toHaveBeenCalledWith('omeka.madelynharrington.net', 2);
    expect(el.textContent).toContain('August 31, 1910');
    expect(el.textContent).toContain('Public Domain');
    const good = q('[data-omeka-file="2"]')!;
    expect(good.textContent).toContain('fifi-and-moisant.jpg');
    expect(good.querySelector('[data-omeka-add]')).toBeTruthy();
    expect(good.querySelector('img')?.getAttribute('src')).toBe(jpeg.thumbUrl);
    const bad = q('[data-omeka-file="9"]')!;
    expect(bad.textContent).toContain("PDF files can't be added to a tour.");
    expect(bad.querySelector('[data-omeka-add]')).toBeNull();
  });

  it('shows the server message verbatim on a failed search', async () => {
    const detail = 'The Omeka site at omeka.example has its API turned off. Someone with an administrator login '
      + 'can turn it on: in the Omeka admin, go to **Settings → API**, tick **Enable API access**, and save. Then search again.';
    tools.omekaSearch.mockRejectedValue(new Error(detail));
    await search('omeka.example', 'cat');
    expect(q('[data-omeka-error]')?.textContent?.trim()).toBe(detail);
    expect(q('[data-omeka-item]')).toBeNull();
  });

  it('shows "Nothing found." on zero results', async () => {
    tools.omekaSearch.mockResolvedValue(page([], 0));
    await search();
    expect(q('[data-omeka-none]')?.textContent?.trim()).toBe('Nothing found.');
  });

  it('Add is disabled for a file with no rights until a licence is typed', async () => {
    await search();
    await click('[data-omeka-item="3"]');
    const add = () => q('[data-omeka-file="3"] [data-omeka-add]') as HTMLButtonElement;
    expect(q('[data-omeka-file="3"]')?.textContent).toContain('No rights statement');
    expect(add().disabled).toBe(true);
    type('[data-omeka-file="3"] [data-omeka-license]', '   ');
    expect(add().disabled).toBe(true);
    type('[data-omeka-file="3"] [data-omeka-license]', 'CC BY 4.0');
    expect(add().disabled).toBe(false);
    await click('[data-omeka-file="3"] [data-omeka-add]');
    expect(emitted[0].credit).toMatchObject({ license: 'CC BY 4.0' });
  });

  it('emits added with the credit, title and body after omekaImport resolves', async () => {
    await search();
    await click('[data-omeka-item="2"]');
    expect(q('[data-omeka-file="2"] [data-omeka-license]')).toBeNull();
    await click('[data-omeka-file="2"] [data-omeka-add]');
    expect(tools.omekaImport).toHaveBeenCalledWith('omeka.madelynharrington.net', 2, 2, 'John Moisant and Mademoiselle Fifi');
    expect(emitted).toEqual([{
      stopId: 'a', kind: 'image', mediaId: 'fifi-abc123.jpg',
      title: 'John Moisant and Mademoiselle Fifi', body: 'Aviation pioneer John Moisant and his cat',
      credit: {
        type: 'sourced', source: site.title, url: `${site.base}/items/show/2`,
        license: 'Public Domain', creator: 'Unknown',
      },
    }]);
  });

  it('emits for the stop that was current when Add was pressed', async () => {
    let resolve!: (id: string) => void;
    tools.omekaImport.mockReturnValue(new Promise<string>((r) => { resolve = r; }));
    await search();
    await click('[data-omeka-item="2"]');
    await click('[data-omeka-file="2"] [data-omeka-add]');
    expect(q('[data-omeka-adding]')).toBeTruthy();
    fixture.componentRef.setInput('stopId', 'b');
    fixture.detectChanges();
    resolve('fifi-abc123.jpg');
    await settle();
    expect(emitted.map((e) => e.stopId)).toEqual(['a']);
  });

  it('a second Add press while importing does nothing', async () => {
    let resolve!: (id: string) => void;
    tools.omekaImport.mockReturnValue(new Promise<string>((r) => { resolve = r; }));
    await search();
    await click('[data-omeka-item="2"]');
    const add = q('[data-omeka-file="2"] [data-omeka-add]') as HTMLButtonElement;
    add.click();
    add.click();  // straight through, even if the disabled state has not rendered yet
    await settle();
    expect(add.disabled).toBe(true);
    resolve('fifi-abc123.jpg');
    await settle();
    expect(tools.omekaImport).toHaveBeenCalledTimes(1);
    expect(emitted.length).toBe(1);
  });

  it('emits nothing when omekaImport rejects, and shows the error', async () => {
    tools.omekaImport.mockRejectedValue(new Error('That file is larger than 25 MB, so it cannot be added.'));
    await search();
    await click('[data-omeka-item="2"]');
    await click('[data-omeka-file="2"] [data-omeka-add]');
    expect(emitted).toEqual([]);
    expect(q('[data-omeka-error]')?.textContent?.trim()).toBe('That file is larger than 25 MB, so it cannot be added.');
    expect((q('[data-omeka-file="2"] [data-omeka-add]') as HTMLButtonElement).disabled).toBe(false);
  });

  it('More results asks for the next page and appends', async () => {
    tools.omekaSearch
      .mockResolvedValueOnce(page([fifi], 2, 1))
      .mockResolvedValueOnce(page([cats], 2, 2));
    await search('omeka.madelynharrington.net', 'cat');
    expect(all('[data-omeka-item]').length).toBe(1);
    await click('[data-omeka-more]');
    expect(tools.omekaSearch).toHaveBeenLastCalledWith('omeka.madelynharrington.net', 'cat', 2);
    expect(all('[data-omeka-item]').map((n) => n.getAttribute('data-omeka-item'))).toEqual(['2', '3']);
    expect(q('[data-omeka-more]')).toBeNull();
  });
});
