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
