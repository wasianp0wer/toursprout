import { Component, inject, input, output, signal } from '@angular/core';
import { ToolsApi, type OmekaFile, type OmekaItem, type OmekaSite } from '../core/tools-api';
import type { Credit } from '../core/tour.models';
import { omekaCredit, omekaOverlayText } from './document-ops';

/** A file stored on our server, ready for the outline pane to turn into an overlay. */
export interface OmekaAdded {
  stopId: string; kind: 'image' | 'audio'; mediaId: string; title: string; body: string | null; credit: Credit;
}

const SITE_KEY = 'clio-wired.omeka-site';

function readSite(): string {
  try { return localStorage.getItem(SITE_KEY) ?? ''; } catch { return ''; }
}

function writeSite(site: string): void {
  try { localStorage.setItem(SITE_KEY, site); } catch { /* private window or blocked storage */ }
}

/**
 * Search an Omeka Classic site, open an item, add one of its files to a stop.
 * Owns its own search, paging, busy and error state; it never touches the
 * document. It emits `added` only once the server has stored the file, so a
 * failed import changes nothing, and the outline pane does the document half.
 */
@Component({
  selector: 'app-omeka-panel',
  templateUrl: './omeka-panel.html',
  styleUrl: './omeka-panel.css',
})
export class OmekaPanel {
  private readonly tools = inject(ToolsApi);

  readonly stopId = input.required<string>();
  readonly added = output<OmekaAdded>();

  protected readonly siteUrl = signal(readSite());
  protected readonly query = signal('');
  /** What the shown results were searched with; paging and imports use these, not the fields. */
  private searched: { siteUrl: string; query: string; page: number } | null = null;
  protected readonly site = signal<OmekaSite | null>(null);
  protected readonly total = signal(0);
  protected readonly items = signal<OmekaItem[] | null>(null);

  protected readonly openItemId = signal<number | null>(null);
  protected readonly files = signal<OmekaFile[] | null>(null);
  /** Licences the author typed for files that state no rights, by fileId. */
  protected readonly licenses = signal<Record<number, string>>({});

  protected readonly status = signal<'searching' | 'opening' | 'adding' | null>(null);
  protected readonly error = signal<string | null>(null);

  protected async search(): Promise<void> {
    const siteUrl = this.siteUrl().trim();
    const query = this.query().trim();
    if (!siteUrl || this.status()) return;
    writeSite(siteUrl);
    await this.run('searching', async () => {
      const r = await this.tools.omekaSearch(siteUrl, query, 1);
      this.searched = { siteUrl, query, page: r.page };
      this.site.set(r.site);
      this.total.set(r.total);
      this.items.set(r.results);
      this.openItemId.set(null);
      this.files.set(null);
      this.licenses.set({});
    });
  }

  protected async more(): Promise<void> {
    const s = this.searched;
    if (!s || this.status()) return;
    await this.run('searching', async () => {
      const r = await this.tools.omekaSearch(s.siteUrl, s.query, s.page + 1);
      s.page = r.page;
      this.total.set(r.total);
      this.items.update((xs) => [...(xs ?? []), ...r.results]);
    });
  }

  protected async toggleItem(item: OmekaItem): Promise<void> {
    const s = this.searched;
    if (!s || this.status()) return;
    if (this.openItemId() === item.itemId) {
      this.openItemId.set(null);
      this.files.set(null);
      return;
    }
    await this.run('opening', async () => {
      const files = await this.tools.omekaFiles(s.siteUrl, item.itemId);
      this.openItemId.set(item.itemId);
      this.files.set(files);
      this.licenses.set({});
    });
  }

  protected setLicense(fileId: number, value: string): void {
    this.licenses.update((m) => ({ ...m, [fileId]: value }));
  }

  /** Neither the file nor the item states rights, so the author must type a licence. */
  protected needsLicense(item: OmekaItem, file: OmekaFile): boolean {
    return !file.rights?.trim() && !item.rights?.trim();
  }

  protected canAdd(item: OmekaItem, file: OmekaFile): boolean {
    const site = this.site();
    return !!site && !!file.kind && file.importable && !!this.stopId() && !this.status()
      && omekaCredit(site, item, file, this.licenses()[file.fileId]) !== null;
  }

  /**
   * The server fetches and stores the file; only then is `added` emitted,
   * for the stop that was current when Add was pressed. Nothing is fetched
   * until the credit is settled: no stated rights and no typed licence, no import.
   */
  protected async add(item: OmekaItem, file: OmekaFile): Promise<void> {
    const s = this.searched;
    const site = this.site();
    const stopId = this.stopId();
    const kind = file.kind;
    if (!s || !site || !kind || !stopId || this.status()) return;
    const credit = omekaCredit(site, item, file, this.licenses()[file.fileId]);
    if (!credit) return;
    const { title, body } = omekaOverlayText(item, file);
    await this.run('adding', async () => {
      const mediaId = await this.tools.omekaImport(s.siteUrl, item.itemId, file.fileId, title);
      this.added.emit({ stopId, kind, mediaId, title, body, credit });
    });
  }

  private async run(status: 'searching' | 'opening' | 'adding', work: () => Promise<void>): Promise<void> {
    this.status.set(status);
    this.error.set(null);
    try {
      await work();
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : 'The Omeka site could not be reached.');
    } finally {
      this.status.set(null);
    }
  }

  protected fileCount(n: number): string {
    return n === 1 ? '1 file' : `${n} files`;
  }
}
