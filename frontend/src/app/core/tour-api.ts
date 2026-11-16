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

  /** Ask to revalidate rather than trust a stored copy.
   *
   * `tour.json` and `config.json` live at FIXED urls whose contents change
   * underneath them, so a cached copy is not an old version of this tour —
   * it is a different tour. Observed live: a browser held `tour.json` from
   * an earlier session under heuristic freshness (the response carried
   * `ETag` and `Last-Modified` but no `Cache-Control`), answered every
   * `getTour()` out of its own cache, and never contacted the server again.
   * Nothing shook it loose: a hard reload bypasses the cache for the page
   * and its subresources but not for the requests the application makes
   * afterwards, so the editor went on loading one tour while the session
   * held another, and every autosave was refused.
   *
   * The server now sends `Cache-Control: no-cache` on `/tour-data/*`, which
   * is the proper fix — but it governs only what is stored from then on,
   * and on a PUBLISHED site the responses come from someone else's static
   * host whose headers we do not set at all. Asking from this side is the
   * only guard that travels with the application, and it is the one that
   * protects a member of the public reading a tour that has been updated.
   *
   * `no-cache` is not `no-store`: the copy may be kept, it just may not be
   * used without asking, so the 304 the `/tour-data` route was built for
   * still happens and nothing is re-transferred needlessly.
   *
   * `mediaUrl` is deliberately left alone: a media id is a content hash, so
   * that url can never mean a different file, and caching it is the point.
   */
  private static readonly REVALIDATE = { 'Cache-Control': 'no-cache' };

  getConfig(): Promise<AppConfig> {
    return firstValueFrom(this.http.get<AppConfig>(
      `${TOUR_DATA}/config.json`, { headers: TourApi.REVALIDATE }));
  }

  getTour(): Promise<Tour> {
    return firstValueFrom(this.http.get<Tour>(
      `${TOUR_DATA}/tour.json`, { headers: TourApi.REVALIDATE }));
  }

  /** Media is served with Range support by StaticFiles and by any static
   * host, which is what the narration audio needs. Never inline it. */
  mediaUrl(mediaId: string): string {
    return `${TOUR_DATA}/media/${mediaId}`;
  }
}
