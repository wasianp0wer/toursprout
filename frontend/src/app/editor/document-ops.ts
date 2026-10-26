/**
 * Pure transforms over a tour document.
 *
 * Every function here returns a new document and never mutates its input. The
 * undo stack holds references to previous documents, so an in-place change
 * would rewrite history as well as the present.
 *
 * These exist as free functions rather than methods on the store so the
 * editor's whole logic can be tested without Angular, a map, or a browser —
 * which matters here more than usual, because no browser runs in this
 * project's development environment at all.
 */
import { bearingBetween, type LngLatLike } from '../core/geo';
import type {
  Credit, Display, InWorldDisplay, Overlay, OverlayKind, Stop, Tour,
} from '../core/tour.models';

export type DisplayMode = Display['mode'];

/**
 * Mirrors DISPLAY_MODES_BY_KIND in backend/app/models.py. A rejection is a
 * renderer limitation, not a limit of the model. The backend validates the
 * same table; a test asserts the two agree, so this copy cannot drift silently.
 */
export const DISPLAY_MODES_BY_KIND: Readonly<Record<OverlayKind, readonly DisplayMode[]>> = {
  text: ['marker'],
  image: ['marker', 'inWorld'],
  audio: ['marker', 'ambient'],
};

export function legalModesFor(kind: OverlayKind): readonly DisplayMode[] {
  return DISPLAY_MODES_BY_KIND[kind];
}

/**
 * What a new stop's text says until the author writes their own. The backend
 * skeleton uses the same words. The viewer shows the summary, and "Narrate
 * this text" reads it, so it must never be synthesised and credited as if it
 * were the author's: see `narrationSource`.
 */
export const PLACEHOLDER_SUMMARY = 'Describe this place.';

export class LastStopError extends Error {
  constructor() {
    // Tour.stops has min_length=1. Producing an empty tour would make the
    // draft unsaveable, which is a worse failure than refusing the delete.
    super('a tour must have at least one stop');
    this.name = 'LastStopError';
  }
}

export function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'untitled';
}

/** Append a numeric suffix until the id is free. Ids are stable once set. */
export function uniqueId(base: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base}-${n}`;
    if (!used.has(candidate)) return candidate;
  }
}

function allIds(tour: Tour): string[] {
  return [
    ...tour.stops.map((s) => s.id),
    ...tour.stops.flatMap((s) => s.overlays.map((o) => o.id)),
  ];
}

export function renumberStops(stops: Stop[]): Stop[] {
  return stops.map((s, i) => ({ ...s, order: i + 1 }));
}

export function addStop(tour: Tour, title: string): Tour {
  const id = uniqueId(slugify(title), allIds(tour));
  const last = tour.stops[tour.stops.length - 1];
  const stop: Stop = {
    id, order: tour.stops.length + 1, title,
    summary: PLACEHOLDER_SUMMARY,
    // Start where the previous stop is: an author adds the next stop near the
    // last one far more often than at the origin, and (0, 0) is in the ocean.
    location: last ? { ...last.location } : { lng: 0, lat: 0 },
    osmRef: null,
    panorama: last
      ? { ...last.panorama }
      : { provider: 'mapillary', imageId: '0', bearing: 0, cachedPath: null },
    overlays: [],
  };
  return { ...tour, stops: renumberStops([...tour.stops, stop]) };
}

export function deleteStop(tour: Tour, stopId: string): Tour {
  const remaining = tour.stops.filter((s) => s.id !== stopId);
  if (remaining.length === 0) throw new LastStopError();
  return { ...tour, stops: renumberStops(remaining) };
}

export function moveStop(tour: Tour, stopId: string, delta: number): Tour {
  const from = tour.stops.findIndex((s) => s.id === stopId);
  if (from < 0) return tour;
  const to = from + delta;
  if (to < 0 || to >= tour.stops.length) return tour; // clamp, do not throw
  const stops = [...tour.stops];
  const [moved] = stops.splice(from, 1);
  stops.splice(to, 0, moved);
  return { ...tour, stops: renumberStops(stops) };
}

export function defaultCreditFor(tour: Tour): Credit {
  return {
    type: 'original',
    creator: tour.defaults?.creator?.trim() || 'Unknown',
    license: tour.defaults?.license?.trim() || 'All rights reserved',
  };
}

export function addTextOverlay(
  tour: Tour, stopId: string, title: string,
  supplied?: { creator: string; license: string },
): Tour {
  const stop = tour.stops.find((s) => s.id === stopId);
  if (!stop) return tour;
  // Same invariant as addMediaOverlay: the author's own writing is never
  // credited to "Unknown". No defaults and no answer: refuse, same reference.
  const base = withDefaults(tour, supplied);
  if (!base) return tour;
  const id = uniqueId(slugify(title), allIds(base));
  const overlay: Overlay = {
    id, kind: 'text',
    anchor: { type: 'geo', lng: stop.location.lng, lat: stop.location.lat, altitudeM: 2 },
    display: { mode: 'marker', icon: 'note' },
    title,
    // Placeholder rather than empty: a text overlay needs a non-blank body to
    // validate, and an invalid draft cannot be saved.
    body: 'Write something about this.',
    mediaId: null,
    credit: defaultCreditFor(base),
  };
  return mapStop(base, stopId, (s) => ({ ...s, overlays: [...s.overlays, overlay] }));
}

export function deleteOverlay(tour: Tour, overlayId: string): Tour {
  return {
    ...tour,
    stops: tour.stops.map((s) => ({
      ...s, overlays: s.overlays.filter((o) => o.id !== overlayId),
    })),
  };
}

export function updateOverlay(
  tour: Tour, overlayId: string, patch: Partial<Overlay>,
): Tour {
  // `id` is deliberately not patchable: the document references overlays by
  // id, and a renaming author does not expect their links to move. Copy and
  // delete rather than destructure-and-discard, which trips noUnusedLocals.
  const safe: Partial<Overlay> = { ...patch };
  delete (safe as { id?: string }).id;
  return {
    ...tour,
    stops: tour.stops.map((s) => ({
      ...s,
      overlays: s.overlays.map((o) => (o.id === overlayId ? { ...o, ...safe } : o)),
    })),
  };
}

export function setOverlayKind(tour: Tour, overlayId: string, kind: OverlayKind): Tour {
  return {
    ...tour,
    stops: tour.stops.map((s) => ({
      ...s,
      overlays: s.overlays.map((o) => {
        if (o.id !== overlayId) return o;
        const legal = legalModesFor(kind);
        const display = legal.includes(o.display.mode)
          ? o.display
          : defaultDisplayFor(kind, o);
        return { ...o, kind, display };
      }),
    })),
  };
}

function defaultDisplayFor(kind: OverlayKind, previous: Overlay): Display {
  const icon = kind === 'image' ? 'photo' : kind === 'audio' ? 'audio' : 'note';
  if (legalModesFor(kind).includes('marker')) return { mode: 'marker', icon };
  // Unreachable today — every kind can be a marker — but the table is the
  // authority, not this assumption, so fall back to the kind's first legal mode.
  return previous.display;
}

function mapStop(tour: Tour, stopId: string, fn: (s: Stop) => Stop): Tour {
  return { ...tour, stops: tour.stops.map((s) => (s.id === stopId ? fn(s) : s)) };
}

/**
 * The compass direction an in-world overlay's face must look to meet the
 * panorama that views it.
 *
 * Derived, never typed. Every hand-authored bearing in this project's history
 * was wrong, one by 138 degrees, which put the subject behind the viewer.
 */
export function deriveHeading(anchor: LngLatLike, panorama: LngLatLike): number {
  const bearing = bearingBetween(anchor, panorama);
  return ((bearing % 360) + 360) % 360;
}

function mapOverlay(tour: Tour, overlayId: string, fn: (o: Overlay) => Overlay): Tour {
  return {
    ...tour,
    stops: tour.stops.map((s) => ({
      ...s, overlays: s.overlays.map((o) => (o.id === overlayId ? fn(o) : o)),
    })),
  };
}

function findOverlay(tour: Tour, overlayId: string): { stop: Stop; overlay: Overlay } | null {
  for (const stop of tour.stops) {
    const overlay = stop.overlays.find((o) => o.id === overlayId);
    if (overlay) return { stop, overlay };
  }
  return null;
}

/**
 * A reported panorama position, keyed to WHICH panorama it belongs to. The
 * panorama pane can lag a selection change; an unkeyed position would then
 * silently be the previous panorama's, and a heading derived from it points
 * the photograph the wrong way.
 */
export interface PanoramaFix extends LngLatLike {
  imageId: string;
}

/** A search candidate: a fix plus the direction the camera faced, if known. */
export interface PanoramaChoice extends PanoramaFix {
  compassAngle?: number | null;
}

/**
 * The fix, but only if it belongs to this stop's panorama. Null otherwise.
 * This is the single gate every derivation passes through.
 */
export function panoramaFixForStop(stop: Stop | null, fix: PanoramaFix | null): PanoramaFix | null {
  if (!stop || !fix) return null;
  return fix.imageId === stop.panorama.imageId ? fix : null;
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * Patch an overlay's geo anchor (lng, lat, altitudeM). Returns the tour
 * unchanged (same reference) if any supplied value is non-finite or out of
 * range (|lng| <= 180, |lat| <= 90).
 */
export function setOverlayAnchor(
  tour: Tour, overlayId: string, patch: Partial<Omit<Overlay['anchor'], 'type'>>,
): Tour {
  if (!findOverlay(tour, overlayId)) return tour;
  for (const [k, v] of Object.entries(patch)) {
    if (!isNum(v)) return tour;
    if (k === 'lng' && Math.abs(v) > 180) return tour;
    if (k === 'lat' && Math.abs(v) > 90) return tour;
  }
  return mapOverlay(tour, overlayId, (o) => ({ ...o, anchor: { ...o.anchor, ...patch } }));
}

/**
 * Move an overlay's anchor and keep its derived heading true. A derived
 * heading is a function of the anchor (the bearing to the camera), so after a
 * move it is re-derived — unless the author set it by hand (`manual`) or no
 * fix for THIS stop's panorama is available, in which case it is left alone.
 * One document, so one undo step.
 */
export function setOverlayAnchorKeepingHeading(
  tour: Tour, overlayId: string, patch: Partial<Omit<Overlay['anchor'], 'type'>>,
  fix: PanoramaFix | null, manual: ReadonlySet<string>,
): Tour {
  const moved = setOverlayAnchor(tour, overlayId, patch);
  if (moved === tour || manual.has(overlayId)) return moved;
  const found = findOverlay(moved, overlayId);
  if (!found || found.overlay.display.mode !== 'inWorld') return moved;
  return deriveOverlayHeading(moved, overlayId, fix);
}

/**
 * Patch the numeric fields of an inWorld display. A no-op (same reference)
 * for any other mode, for non-finite values, and for non-positive sizes.
 * Opacity is clamped to [0, 1]; heading is normalised into [0, 360).
 */
export function setInWorldField(
  tour: Tour, overlayId: string,
  patch: Partial<Pick<InWorldDisplay, 'headingDeg' | 'widthM' | 'heightM' | 'opacity'>>,
): Tour {
  const found = findOverlay(tour, overlayId);
  if (!found || found.overlay.display.mode !== 'inWorld') return tour;
  const clean: typeof patch = {};
  for (const [k, v] of Object.entries(patch) as [keyof typeof patch, number][]) {
    if (!isNum(v)) return tour;
    if ((k === 'widthM' || k === 'heightM') && v <= 0) return tour;
    clean[k] = k === 'opacity' ? Math.min(1, Math.max(0, v))
      : k === 'headingDeg' ? ((v % 360) + 360) % 360 : v;
  }
  return mapOverlay(tour, overlayId, (o) =>
    o.display.mode === 'inWorld' ? { ...o, display: { ...o.display, ...clean } } : o);
}

/**
 * Switch an overlay to another display mode. Returns the tour unchanged (same
 * reference) for a mode illegal for the kind, or the mode it already has.
 *
 * Switching TO inWorld is also refused unless `fix` is a position for THIS
 * stop's panorama: `headingDeg` is a required number with no neutral "unset",
 * so the only honest alternative to a derived heading is no switch at all.
 * The stop's own location is never a substitute: the panorama stands where
 * the camera car drove, tens of metres from the building, and that swings a
 * bearing by up to 178 degrees.
 */
export function setOverlayMode(
  tour: Tour, overlayId: string, mode: DisplayMode, fix: PanoramaFix | null,
): Tour {
  const found = findOverlay(tour, overlayId);
  if (!found) return tour;
  const { stop, overlay } = found;
  if (!legalModesFor(overlay.kind).includes(mode) || overlay.display.mode === mode) return tour;
  if (mode === 'marker') {
    const icon = overlay.kind === 'image' ? 'photo' : overlay.kind === 'audio' ? 'audio' : 'note';
    return mapOverlay(tour, overlayId, (o) => ({ ...o, display: { mode, icon } }));
  }
  if (mode === 'ambient') {
    return mapOverlay(tour, overlayId, (o) => ({ ...o, display: { mode, autoplay: false } }));
  }
  const usable = panoramaFixForStop(stop, fix);
  if (!usable) return tour;
  const headingDeg = deriveHeading(overlay.anchor, usable);
  return mapOverlay(tour, overlayId, (o) => ({
    ...o, display: { mode, opacity: 0.8, headingDeg, widthM: 4, heightM: 3 },
  }));
}

/**
 * Re-derive an inWorld overlay's heading from the real position of ITS
 * stop's panorama. Same reference back when the fix is missing or belongs to
 * another panorama: never guess, never fall back to stop.location.
 */
export function deriveOverlayHeading(
  tour: Tour, overlayId: string, fix: PanoramaFix | null,
): Tour {
  const found = findOverlay(tour, overlayId);
  if (!found) return tour;
  const usable = panoramaFixForStop(found.stop, fix);
  if (!usable) return tour;
  return setInWorldField(tour, overlayId, {
    headingDeg: deriveHeading(found.overlay.anchor, usable),
  });
}

/**
 * Set an inWorld overlay's heading by hand (the map's rotation handle).
 *
 * A deliberate manual override, but it passes through the same gate as
 * derivation: refused (same reference) unless `fix` is the position of THIS
 * stop's panorama. The value itself comes from the author's drag, never from
 * stop.location. Gating it means a manual heading always has a way back
 * (deriveOverlayHeading needs the same fix) and is only ever set while the
 * author can see where the camera really stood.
 */
export function setOverlayHeadingManual(
  tour: Tour, overlayId: string, headingDeg: number, fix: PanoramaFix | null,
): Tour {
  const found = findOverlay(tour, overlayId);
  if (!found || !panoramaFixForStop(found.stop, fix)) return tour;
  return setInWorldField(tour, overlayId, { headingDeg });
}

// Mirror ALLOWED_TYPES in backend/app/media_store.py; a backend test reads
// these two lines and fails if the sets drift.
const IMAGE_EXTS = ['.jpg', '.png', '.webp'];
const AUDIO_EXTS = ['.wav', '.m4a', '.mp3', '.ogg', '.webm'];

/**
 * What may be in a dropped folder on the welcome screen: the *import*
 * allowlist, not the upload one. The two differ, deliberately — import
 * (`bundle.MEDIA_EXTENSIONS`) accepts `.jpeg`, while the upload table above
 * has no `.jpeg` row because `store_media` names the file itself and picks
 * one extension per sniffed type. Derived from the two lists rather than
 * written out a third time so the drop filter cannot drift from the kinds
 * the editor understands; a backend test ties it to the import allowlist.
 */
export const DROPPABLE_MEDIA_EXTS = [...IMAGE_EXTS, '.jpeg', ...AUDIO_EXTS];

/**
 * What kind of media a stored id is. The backend picks the extension by
 * sniffing the bytes (see ALLOWED_TYPES in backend/app/media_store.py), so the
 * extension is the server's verdict, not the author's claim. Null when the
 * extension is not one the server stores.
 */
export function mediaKindOf(mediaId: string): 'image' | 'audio' | null {
  const dot = mediaId.lastIndexOf('.');
  const ext = dot < 0 ? '' : mediaId.slice(dot).toLowerCase();
  if (IMAGE_EXTS.includes(ext)) return 'image';
  if (AUDIO_EXTS.includes(ext)) return 'audio';
  return null;
}

/**
 * Kinds an author may switch this overlay to. Image and audio need media
 * (the backend rejects them without a mediaId), and media now comes from
 * upload, so an attached mediaId offers the kind its stored type allows. A
 * stored type we do not recognise offers both rather than strand the author.
 * The overlay's current kind always stays listed so the selector can show it.
 */
export function legalKindsFor(overlay: Overlay): OverlayKind[] {
  const kinds: OverlayKind[] = ['text'];
  if (overlay.mediaId) {
    const media = mediaKindOf(overlay.mediaId);
    if (media) kinds.push(media); else kinds.push('image', 'audio');
  }
  if (!kinds.includes(overlay.kind)) kinds.push(overlay.kind);
  return kinds;
}

/** True when the tour carries a usable creator AND licence. */
export function hasDefaults(tour: Tour): boolean {
  return !!tour.defaults?.creator?.trim() && !!tour.defaults?.license?.trim();
}

/** The one rule for an answer to the creator/licence prompt. */
export function defaultsAnswerValid(creator: string, license: string): boolean {
  return !!creator.trim() && !!license.trim();
}

/** The tour with usable defaults: itself, or with `supplied` written on; null if neither. */
function withDefaults(tour: Tour, supplied?: { creator: string; license: string }): Tour | null {
  if (hasDefaults(tour)) return tour;
  if (!supplied) return null;
  const out = setTourDefaults(tour, supplied.creator, supplied.license);
  return hasDefaults(out) ? out : null;
}

/** Write the tour's default creator and licence. Same reference for a blank. */
export function setTourDefaults(tour: Tour, creator: string, license: string): Tour {
  const c = creator.trim();
  const l = license.trim();
  if (!c || !l) return tour;
  return { ...tour, defaults: { creator: c, license: l } };
}

/**
 * Add an image or audio overlay for media that is ALREADY uploaded: callers
 * upload first and call this only with the server's `mediaId`, so a refused
 * upload never reaches the document.
 *
 * Credit comes from the tour's defaults. If the tour has none, `supplied`
 * (the author's answer to the one-time prompt) is written onto the tour in
 * the same document as the overlay, so it is one undo step. With neither, the
 * tour is returned unchanged (same reference): a silent `Unknown` credit on
 * the author's own work is exactly what this refuses to do. The media's
 * stored type must match `kind`, and the stop must exist. No heading is
 * produced: the display is a marker.
 */
export function addMediaOverlay(
  tour: Tour, stopId: string, kind: 'image' | 'audio', mediaId: string, title: string,
  supplied?: { creator: string; license: string },
  credit?: Credit,
): Tour {
  const stop = tour.stops.find((s) => s.id === stopId);
  if (!stop || mediaKindOf(mediaId) !== kind) return tour;
  // A credit given by the caller (an archive's, or the narrator's) already
  // names who made the work, so the tour's defaults are not needed for it.
  const base = credit ? tour : withDefaults(tour, supplied);
  if (!base) return tour;
  const text = title.trim() || (kind === 'image' ? 'New image' : 'New audio');
  const overlay: Overlay = {
    id: uniqueId(slugify(text), allIds(base)), kind,
    anchor: { type: 'geo', lng: stop.location.lng, lat: stop.location.lat, altitudeM: 2 },
    display: { mode: 'marker', icon: kind === 'image' ? 'photo' : 'audio' },
    title: text, body: null, mediaId,
    credit: credit ?? defaultCreditFor(base),
  };
  return mapStop(base, stopId, (s) => ({ ...s, overlays: [...s.overlays, overlay] }));
}

/** The credit's human-facing text: creator for original, source for sourced. */
export function creditText(credit: Credit): string {
  return credit.type === 'original' ? credit.creator : credit.source;
}

export function setCreditText(tour: Tour, overlayId: string, text: string): Tour {
  return mapOverlay(tour, overlayId, (o) => ({
    ...o,
    credit: o.credit.type === 'original'
      ? { ...o.credit, creator: text }
      : { ...o.credit, source: text },
  }));
}

/** Rename the tour. The tour's id is fixed when it is created and is not touched. */
export function setTourTitle(tour: Tour, title: string): Tour {
  return { ...tour, title };
}

export function setTourDescription(tour: Tour, description: string): Tour {
  return { ...tour, description };
}

/** The stop's text: what the viewer's stop panel shows, and what narration reads. */
export function setStopSummary(tour: Tour, stopId: string, summary: string): Tour {
  return mapStop(tour, stopId, (s) => ({ ...s, summary }));
}

export function setStopTitle(tour: Tour, stopId: string, title: string): Tour {
  return mapStop(tour, stopId, (s) => ({ ...s, title }));
}

/**
 * Move a stop. `osmRef` is set only when given (a place picked from the OSM
 * search); undefined leaves it alone. Same reference for a bad coordinate.
 */
export function setStopLocation(
  tour: Tour, stopId: string, lng: number, lat: number, osmRef?: string | null,
): Tour {
  if (!tour.stops.some((s) => s.id === stopId)) return tour;
  if (!isNum(lng) || !isNum(lat) || Math.abs(lng) > 180 || Math.abs(lat) > 90) return tour;
  return mapStop(tour, stopId, (s) => ({
    ...s, location: { lng, lat }, ...(osmRef === undefined ? {} : { osmRef }),
  }));
}

/**
 * Choose a panorama for a stop from a search candidate. Returns the new tour
 * AND the fix to publish, both built from this one `candidate`, so the
 * position can never belong to a different image than the id written.
 * The stop's own location is never consulted: a candidate's lng/lat is where
 * the camera stood. Null (nothing to change or publish) for an unknown stop,
 * a blank id or an unusable position.
 *
 * The replaced panorama's cached file is dropped (it renders the old image)
 * and its bearing is reset (it was set for the old image).
 */
export function selectPanorama(
  tour: Tour, stopId: string, candidate: PanoramaChoice,
): { tour: Tour; fix: PanoramaFix } | null {
  const { imageId, lng, lat } = candidate;
  if (!tour.stops.some((s) => s.id === stopId)) return null;
  if (typeof imageId !== 'string' || !imageId.trim()) return null;
  if (!isNum(lng) || !isNum(lat) || Math.abs(lng) > 180 || Math.abs(lat) > 90) return null;
  const bearing = isNum(candidate.compassAngle) ? ((candidate.compassAngle % 360) + 360) % 360 : 0;
  const next = mapStop(tour, stopId, (s) => ({
    // bearing and cachedPath belonged to the image being replaced. The new
    // view starts where the camera faced, or north when that is unknown.
    ...s, panorama: { ...s.panorama, imageId, cachedPath: null, bearing },
  }));
  return { tour: next, fix: { imageId, lng, lat } };
}

/**
 * A sourced credit for an archive result. The licence is the archive's
 * stated rights; when it states none, only what the author typed is used,
 * and with neither this is null: nothing is invented. Null also when the
 * result has no url to cite.
 */
export function archiveCredit(
  result: {
    creator: string | null; itemUrl: string | null; imageUrl: string | null; rights: string | null;
  },
  authorLicense?: string,
): Credit | null {
  const license = result.rights?.trim() || authorLicense?.trim() || '';
  const url = result.itemUrl?.trim() || result.imageUrl?.trim() || '';
  if (!license || !url) return null;
  return {
    type: 'sourced', source: 'Library of Congress', url, license,
    creator: result.creator?.trim() || null,
  };
}

/** The words to narrate for a selection, and the stop the audio belongs to. */
export function narrationSource(
  tour: Tour, selectedId: string | null,
): { stopId: string; text: string; title: string } | null {
  if (!selectedId) return null;
  for (const s of tour.stops) {
    if (s.id === selectedId) {
      const text = s.summary.trim();
      // The placeholder is not the author's words; narrating it would store
      // audio of "Describe this place." and credit it to them.
      return text && text !== PLACEHOLDER_SUMMARY ? { stopId: s.id, text, title: `Narration of ${s.title} (synthesised voice)` } : null;
    }
    const o = s.overlays.find((x) => x.id === selectedId);
    if (o) {
      const text = (o.body ?? '').trim();
      return text ? { stopId: s.id, text, title: `Narration of ${o.title} (synthesised voice)` } : null;
    }
  }
  return null;
}
