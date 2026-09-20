import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import type { AppConfig, Tour, TourSummary } from './tour.models';

export const API_BASE = '/api';

@Injectable({ providedIn: 'root' })
export class TourApi {
  private readonly http = inject(HttpClient);

  getConfig(): Promise<AppConfig> {
    return firstValueFrom(this.http.get<AppConfig>(`${API_BASE}/config`));
  }

  listTours(): Promise<TourSummary[]> {
    return firstValueFrom(this.http.get<TourSummary[]>(`${API_BASE}/tours`));
  }

  getTour(id: string): Promise<Tour> {
    return firstValueFrom(this.http.get<Tour>(`${API_BASE}/tours/${id}`));
  }

  /** Media is streamed by the backend with range support; never inline it. */
  mediaUrl(mediaId: string): string {
    return `${API_BASE}/media/${mediaId}`;
  }
}
