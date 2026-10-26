import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import type { Tour } from './tour.models';

export interface SessionSummary {
  open: boolean;
  tourId?: string;
  title?: string;
  stopCount?: number;
  mediaCount?: number;
}

/**
 * The editor's half of the backend: what document is open, and writing it
 * back. Separate from TourApi because TourApi must keep working with no
 * backend at all, and nothing here can.
 */
@Injectable({ providedIn: 'root' })
export class SessionApi {
  private readonly http = inject(HttpClient);

  get(): Promise<SessionSummary> {
    return firstValueFrom(this.http.get<SessionSummary>('/api/session'));
  }

  putTour(doc: Tour): Promise<SessionSummary> {
    return firstValueFrom(this.http.put<SessionSummary>('/api/session/tour', doc));
  }

  /** Starts a brand-new skeleton tour. Only valid while nothing is open —
   * the editor page's empty state is the only caller today. */
  newTour(title: string): Promise<SessionSummary> {
    return firstValueFrom(this.http.post<SessionSummary>('/api/session/new', { title }));
  }

  /**
   * Upload one file; resolves to the server-chosen `mediaId`. The client
   * never names the stored file. A refusal rejects with an Error carrying
   * the backend's message so the caller can show it verbatim.
   */
  async uploadMedia(file: File): Promise<string> {
    const form = new FormData();
    form.append('file', file, file.name);
    try {
      const res = await firstValueFrom(
        this.http.post<{ mediaId: string }>('/api/session/media', form));
      return res.mediaId;
    } catch (err) {
      throw new Error(uploadMessage(err));
    }
  }
}

function uploadMessage(err: unknown): string {
  if (err instanceof HttpErrorResponse) {
    if (err.status === 0) return 'could not reach the server to upload that file';
    const detail = (err.error as { detail?: unknown } | null)?.detail;
    if (typeof detail === 'string' && detail) return detail;
    if (err.status === 413) return 'that file is too large to upload';
    return `the upload failed (${err.status})`;
  }
  return 'the upload failed';
}
