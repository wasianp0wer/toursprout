import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';

export interface PlaceCandidate {
  name: string;
  osmRef: string;
  kind?: string;
  lng: number;
  lat: number;
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

  async places(lng: number, lat: number, name?: string): Promise<PlaceCandidate[]> {
    const body = name?.trim() ? { lng, lat, name: name.trim() } : { lng, lat };
    return (await this.post<{ places: PlaceCandidate[] }>('places', body)).places;
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
