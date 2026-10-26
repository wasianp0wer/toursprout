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

/**
 * A browser-recognised MIME type for a narration clip, derived from the
 * `mediaId`'s own extension rather than trusted to whatever the static host
 * serving a published site guesses. `main.py`'s `mimetypes.add_type` only
 * fixes this for the editor's own FastAPI process; a published site has no
 * such process, and the stdlib table (or Apache's default one) answers
 * `.m4a` with "audio/mp4a-latm" — an RTP/SDP payload name no browser
 * recognises as playable — rather than "audio/mp4". The `<source [type]>`
 * this feeds in stop-panel.ts is what makes narration playback not depend
 * on the host's MIME table at all. An unrecognised extension gets no type
 * rather than a guessed one that might be wrong.
 */
const AUDIO_TYPE_BY_EXTENSION: Record<string, string> = {
  m4a: 'audio/mp4',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  webm: 'audio/webm',
  ogg: 'audio/ogg',
};

export function audioType(mediaId: string): string {
  const ext = mediaId.split('.').pop()?.toLowerCase() ?? '';
  return AUDIO_TYPE_BY_EXTENSION[ext] ?? '';
}

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
