import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { ConfigStore } from './config-store';

const MAPILLARY_IMAGES = 'https://graph.mapillary.com/images';
const FIELDS = 'id,computed_geometry,geometry,is_pano,captured_at,compass_angle,thumb_256_url';

export interface PanoramaCandidate {
  imageId: string;
  /** The CAMERA's own position, not the subject's. */
  lng: number;
  lat: number;
  isPano?: boolean;
  capturedAt: number | string | null;
  compassAngle?: number | null;
  thumbUrl: string | null;
  distanceM: number;
}

/** west,south,east,north: Mapillary's order, the reverse of the Overpass bbox the backend builds. */
export function bboxAround(lng: number, lat: number, radiusM: number): string {
  const dlat = radiusM / 111_320;
  const dlng = radiusM / (111_320 * Math.cos((lat * Math.PI) / 180));
  return `${lng - dlng},${lat - dlat},${lng + dlng},${lat + dlat}`;
}

export function haversineM(lng1: number, lat1: number, lng2: number, lat2: number): number {
  const r = 6_371_000;
  const rad = (d: number) => (d * Math.PI) / 180;
  const p1 = rad(lat1);
  const p2 = rad(lat2);
  const a = Math.sin((p2 - p1) / 2) ** 2
    + Math.cos(p1) * Math.cos(p2) * Math.sin(rad(lng2 - lng1) / 2) ** 2;
  return 2 * r * Math.asin(Math.sqrt(a));
}

type Raw = Record<string, unknown>;

/** A [lng, lat] pair from a GeoJSON-ish point, or null if it is missing or malformed. */
function coordinatesOf(geom: unknown): [number, number] | null {
  const c = (geom as { coordinates?: unknown } | null | undefined)?.coordinates;
  if (!Array.isArray(c) || c.length !== 2) return null;
  const [x, y] = c;
  return typeof x === 'number' && typeof y === 'number' && Number.isFinite(x) && Number.isFinite(y)
    ? [x, y] : null;
}

/**
 * Imagery near a point, true 360 panoramas first, nearest first.
 *
 * `lng`/`lat` on each candidate are where the CAMERA stood (Mapillary's
 * `computed_geometry`, else `geometry`), never the query point. The editor
 * derives a stop's view bearing from that position; deriving it from the stop
 * itself faces the photograph 178 degrees backwards on the real tour, because
 * the stop is the building and the camera was on the street. A malformed
 * geometry skips that image rather than failing the whole search.
 */
export function rankCandidates(
  images: unknown[], lng: number, lat: number, panoOnly: boolean, limit: number,
): PanoramaCandidate[] {
  const out: PanoramaCandidate[] = [];
  for (const raw of images) {
    const img = (raw ?? {}) as Raw;
    const geom = img['computed_geometry'] || img['geometry'];
    if (!geom || !img['id']) continue;
    const at = coordinatesOf(geom);
    if (!at) continue;
    const isPano = Boolean(img['is_pano']);
    if (panoOnly && !isPano) continue;
    out.push({
      imageId: String(img['id']), lng: at[0], lat: at[1], isPano,
      capturedAt: (img['captured_at'] as number | string | null | undefined) ?? null,
      compassAngle: (img['compass_angle'] as number | null | undefined) ?? null,
      thumbUrl: (img['thumb_256_url'] as string | null | undefined) ?? null,
      distanceM: Math.round(haversineM(lng, lat, at[0], at[1]) * 10) / 10,
    });
  }
  out.sort((a, b) => Number(!a.isPano) - Number(!b.isPano) || a.distanceM - b.distanceM);
  return out.slice(0, limit);
}

/**
 * Panorama search, run from the browser. The production host cannot reach
 * graph.mapillary.com (its connections are silently dropped), but the browser
 * already talks to it for every panorama mapillary-js renders. Only metadata
 * comes back here; no image bytes touch our server.
 */
@Injectable({ providedIn: 'root' })
export class MapillarySearch {
  private readonly http = inject(HttpClient);
  private readonly config = inject(ConfigStore);

  async panoramas(
    lng: number, lat: number, radiusM = 50, panoOnly = true, limit = 20,
  ): Promise<PanoramaCandidate[]> {
    const token = this.config.mapillaryToken();
    if (!token) throw new Error('no Mapillary token is configured (set MAPILLARY_TOKEN)');
    try {
      const res = await firstValueFrom(this.http.get<{ data?: unknown[] }>(MAPILLARY_IMAGES, {
        params: { access_token: token, bbox: bboxAround(lng, lat, radiusM), fields: FIELDS, limit: 500 },
      }));
      return rankCandidates(res?.data ?? [], lng, lat, panoOnly, limit);
    } catch (err) {
      throw new Error(mapillaryMessage(err));
    }
  }
}

function mapillaryMessage(err: unknown): string {
  if (err instanceof HttpErrorResponse) {
    if (err.status === 0) return 'could not reach Mapillary';
    const detail = (err.error as { error?: { message?: unknown } } | null)?.error?.message;
    if (typeof detail === 'string' && detail) return detail;
    return `Mapillary failed (${err.status})`;
  }
  return 'Mapillary failed';
}
