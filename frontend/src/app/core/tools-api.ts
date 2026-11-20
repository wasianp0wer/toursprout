import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';

/** One match for an address, best first, as the backend's Nominatim lookup returns it. */
export interface GeocodeResult {
  name: string;
  lng: number;
  lat: number;
  osmRef: string | null;
}

export interface OmekaSite { base: string; title: string }

export interface OmekaItem {
  itemId: number; itemUrl: string; title: string; description: string | null;
  creator: string | null; date: string | null; rights: string | null; fileCount: number;
}

/** `rawCount` is how many items the page held before file-less ones were dropped from `results`. */
export interface OmekaSearch { site: OmekaSite; total: number; page: number; rawCount: number; results: OmekaItem[] }

export interface OmekaFile {
  fileId: number; kind: 'image' | 'audio' | null; filename: string; thumbUrl: string | null;
  importable: boolean; reason: string | null;
  title: string | null; creator: string | null; rights: string | null;
}

/**
 * The acquisition tools. A sibling of SessionApi rather than part of it:
 * SessionApi is the open document (read, write, upload), while these are
 * stateless searches over third parties. Every failure rejects with an Error carrying the
 * backend's message, so a caller shows it verbatim and changes nothing.
 */
@Injectable({ providedIn: 'root' })
export class ToolsApi {
  private readonly http = inject(HttpClient);

  /**
   * Through the backend, not straight to Nominatim: its usage policy wants an
   * identifying User-Agent and one request a second, which only the server
   * can keep to.
   */
  async geocode(query: string): Promise<GeocodeResult[]> {
    return (await this.post<{ results: GeocodeResult[] }>('geocode', { query })).results;
  }

  omekaSearch(siteUrl: string, query: string, page = 1): Promise<OmekaSearch> {
    return this.post<OmekaSearch>('omeka-search', { siteUrl, query, page });
  }

  async omekaFiles(siteUrl: string, itemId: number): Promise<OmekaFile[]> {
    return (await this.post<{ files: OmekaFile[] }>('omeka-files', { siteUrl, itemId })).files;
  }

  /** Resolves to the stored mediaId of the imported file. */
  async omekaImport(siteUrl: string, itemId: number, fileId: number, title: string): Promise<string> {
    return (await this.post<{ mediaId: string }>(
      'omeka-import', { siteUrl, itemId, fileId, title })).mediaId;
  }

  private async post<T>(tool: string, body: object): Promise<T> {
    try {
      return await firstValueFrom(this.http.post<T>(`/api/tools/${tool}`, body));
    } catch (err) {
      throw new Error(toolMessage(err, tool));
    }
  }
}

function toolMessage(err: unknown, tool: string): string {
  if (err instanceof HttpErrorResponse) {
    if (err.status === 0) return `could not reach the server for ${tool}`;
    const detail = (err.error as { detail?: unknown } | null)?.detail;
    if (typeof detail === 'string' && detail) return detail;
    return `${tool} failed (${err.status})`;
  }
  return `${tool} failed`;
}
