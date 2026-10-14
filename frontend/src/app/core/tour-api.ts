import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import type { AppConfig, Tour } from './tour.models';

/**
 * Everything the viewer needs, relative to the page.
 *
 * In the editor FastAPI serves these from the open working directory; in a
 * published site they are plain files beside index.html. One set of URLs, so
 * there is no deployment detection and no second code path — which is the
 * whole reason a published tour needs no backend.
 */
export const TOUR_DATA = 'tour-data';

@Injectable({ providedIn: 'root' })
export class TourApi {
  private readonly http = inject(HttpClient);

  getConfig(): Promise<AppConfig> {
    return firstValueFrom(this.http.get<AppConfig>(`${TOUR_DATA}/config.json`));
  }

  getTour(): Promise<Tour> {
    return firstValueFrom(this.http.get<Tour>(`${TOUR_DATA}/tour.json`));
  }

  /** Media is served with Range support by StaticFiles and by any static
   * host, which is what the narration audio needs. Never inline it. */
  mediaUrl(mediaId: string): string {
    return `${TOUR_DATA}/media/${mediaId}`;
  }
}
