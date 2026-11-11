import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom, timeout, TimeoutError } from 'rxjs';
import { ConfigStore } from './config-store';

const MAPILLARY_IMAGES = 'https://graph.mapillary.com/images';
// A stalled connection must not leave the search button disabled until the browser gives up.
const TIMEOUT_MS = 15_000;
// `sequence` was confirmed against the live API on 2026-11-11; `sequence_id` is
// accepted but returns nothing, so do not reach for it. One bad name fails the
// whole request, and neither CI nor the host can make the call to find out.
const FIELDS = 'id,computed_geometry,geometry,is_pano,sequence,captured_at,compass_angle,thumb_256_url';

export interface PanoramaCandidate {
  imageId: string;
  /** The CAMERA's own position, not the subject's. */
  lng: number;
  lat: number;
  isPano?: boolean;
  /** Mapillary's `sequence`: one capture run. Dense runs are thinned — see thinBySpacing. */
  sequenceId: string | null;
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

/**
 * A compass angle Mapillary actually knows, normalised to 0-360, or null.
 *
 * **Mapillary reports an unknown compass angle as `-1`, not `null`** — 25 of
 * Český Krumlov's 46 flat images do. A null check does not catch it: `-1` is a
 * finite number, so the usual `((v % 360) + 360) % 360` turns "unknown" into
 * `359`, and a stop is then stored facing almost due north on no evidence
 * whatever, passing every schema validation because 359 is a legal bearing.
 * Nothing is guessed here — a sentinel is simply read as data — but it is the
 * same failure as the hand-guessed bearings this project has already been
 * bitten by, one of which was wrong by 138 degrees.
 *
 * This is the one home for that fact, because both readers of a compass angle
 * get theirs from Mapillary: `selectPanorama` (a search candidate) and the
 * editor map's `wedgeFor` (the viewer's report of what it loaded).
 */
export function knownCompassAngle(v: number | null | undefined): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return null;
  return ((v % 360) + 360) % 360;
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
 * Flat and fisheye imagery is included: the rule is "whatever the viewer can
 * draw", and mapillary-js draws all three projections. `panoOnly` survives as
 * an argument because the specs exercise it, but no caller passes it — where
 * coverage is phone and dashcam capture, filtering it out leaves the author
 * with an empty list and no way to make a stop at all.
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
    const sequence = img['sequence'];
    out.push({
      imageId: String(img['id']), lng: at[0], lat: at[1], isPano,
      sequenceId: typeof sequence === 'string' && sequence ? sequence : null,
      capturedAt: (img['captured_at'] as number | string | null | undefined) ?? null,
      compassAngle: (img['compass_angle'] as number | null | undefined) ?? null,
      thumbUrl: (img['thumb_256_url'] as string | null | undefined) ?? null,
      distanceM: Math.round(haversineM(lng, lat, at[0], at[1]) * 10) / 10,
    });
  }
  out.sort((a, b) => Number(!a.isPano) - Number(!b.isPano) || a.distanceM - b.distanceM);
  // Thinning runs between the sort and the limit. Either way round matters:
  // thinning a list already cut to 20 would return fewer than 20 where 20
  // distinct vantage points exist.
  return thinBySpacing(out).slice(0, limit);
}

/**
 * How near two frames of one capture run have to be before the second is
 * redundant. The pano-only filter used to do this job without anyone naming
 * it: on Fairfax's 360 coverage the 20 images kept were 20 distinct vantage
 * points, and on phone and dashcam capture they are not. Český Krumlov
 * returns 46 flat images in 17 sequences within 50 m, one sequence
 * contributing 11 frames ninety centimetres apart.
 */
export const MIN_CANDIDATE_SPACING_M = 10;

/**
 * Drop candidates that stand where a better-ranked frame of the SAME capture
 * run already stands, so the list offers distinct vantage points.
 *
 * Walk the ranked list in order and keep a candidate unless an already-kept
 * candidate from its own sequence lies within `minSpacingM`. One frame per
 * sequence would be the wrong rule: Rye's 28 flat images are a single
 * sequence, and the author would be offered one candidate for the whole
 * street. A candidate with no sequence id is never thinned — Graph can omit
 * the field, and two absent ids are not the same capture run.
 *
 * Spacing is measured between the candidates' own positions, not between
 * their `distanceM`: two frames can be equidistant from the query point and
 * still be the same vantage point, or metres apart.
 */
export function thinBySpacing(
  candidates: PanoramaCandidate[], minSpacingM = MIN_CANDIDATE_SPACING_M,
): PanoramaCandidate[] {
  const keptBySequence = new Map<string, PanoramaCandidate[]>();
  const out: PanoramaCandidate[] = [];
  for (const c of candidates) {
    if (c.sequenceId === null) {
      out.push(c);
      continue;
    }
    const kept = keptBySequence.get(c.sequenceId) ?? [];
    if (kept.some((k) => haversineM(k.lng, k.lat, c.lng, c.lat) < minSpacingM)) continue;
    kept.push(c);
    keptBySequence.set(c.sequenceId, kept);
    out.push(c);
  }
  return out;
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
    lng: number, lat: number, radiusM = 50, panoOnly = false, limit = 20,
  ): Promise<PanoramaCandidate[]> {
    const token = this.config.mapillaryToken();
    if (!token) throw new Error('no Mapillary token is configured (set MAPILLARY_TOKEN)');
    try {
      // A known, unaddressed limit: Graph's `limit` is not nearest-first, so
      // on coverage denser than 500 images in 50 m, images nearer than the
      // ones returned can be dropped before ranking ever sees them. Visby,
      // the densest site probed, returned 288 and did not reach the cap. The
      // fix is a smaller radius or paging; neither is worth doing before a
      // real site hits it.
      const res = await firstValueFrom(this.http.get<{ data?: unknown[] }>(MAPILLARY_IMAGES, {
        params: { access_token: token, bbox: bboxAround(lng, lat, radiusM), fields: FIELDS, limit: 500 },
      }).pipe(timeout(TIMEOUT_MS)));
      return rankCandidates(res?.data ?? [], lng, lat, panoOnly, limit);
    } catch (err) {
      throw new Error(mapillaryMessage(err));
    }
  }
}

function mapillaryMessage(err: unknown): string {
  if (err instanceof TimeoutError) return 'Mapillary timed out';
  if (err instanceof HttpErrorResponse) {
    if (err.status === 0) return 'could not reach Mapillary';
    const detail = (err.error as { error?: { message?: unknown } } | null)?.error?.message;
    if (typeof detail === 'string' && detail) return detail;
    return `Mapillary failed (${err.status})`;
  }
  return 'Mapillary failed';
}
