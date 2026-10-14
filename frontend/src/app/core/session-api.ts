import { HttpClient } from '@angular/common/http';
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
}
