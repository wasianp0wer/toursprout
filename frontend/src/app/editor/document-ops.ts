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
    summary: 'Describe this place.',
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

export function addTextOverlay(tour: Tour, stopId: string, title: string): Tour {
  const id = uniqueId(slugify(title), allIds(tour));
  const stop = tour.stops.find((s) => s.id === stopId);
  if (!stop) return tour;
  const overlay: Overlay = {
    id, kind: 'text',
    anchor: { type: 'geo', lng: stop.location.lng, lat: stop.location.lat, altitudeM: 2 },
    display: { mode: 'marker', icon: 'note' },
    title,
    // Placeholder rather than empty: a text overlay needs a non-blank body to
    // validate, and an invalid draft cannot be saved.
    body: 'Write something about this.',
    mediaId: null,
    credit: defaultCreditFor(tour),
  };
  return mapStop(tour, stopId, (s) => ({ ...s, overlays: [...s.overlays, overlay] }));
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

/** Patch an overlay's geo anchor (lng, lat, altitudeM). */
export function setOverlayAnchor(
  tour: Tour, overlayId: string, patch: Partial<Omit<Overlay['anchor'], 'type'>>,
): Tour {
  return mapOverlay(tour, overlayId, (o) => ({ ...o, anchor: { ...o.anchor, ...patch } }));
}

/**
 * Patch the numeric fields of an inWorld display. A no-op for any other mode,
 * so a stale inspector field cannot grow stray keys on a marker.
 */
export function setInWorldField(
  tour: Tour, overlayId: string,
  patch: Partial<Pick<InWorldDisplay, 'headingDeg' | 'widthM' | 'heightM' | 'opacity'>>,
): Tour {
  return mapOverlay(tour, overlayId, (o) =>
    o.display.mode === 'inWorld' ? { ...o, display: { ...o.display, ...patch } } : o);
}

/**
 * Switch an overlay to another display mode. Refuses an illegal mode for the
 * overlay's kind (returns the tour unchanged). Entering inWorld seeds the
 * heading by derivation from the REAL panorama position. The stop's location
 * is never a substitute: the panorama stands where the camera car drove, tens
 * of metres from the building, and that swings a bearing by up to 178 degrees.
 * With no position known the heading is a placeholder 0 for the author to derive.
 */
export function setOverlayMode(
  tour: Tour, overlayId: string, mode: DisplayMode, panorama: LngLatLike | null,
): Tour {
  return mapOverlay(tour, overlayId, (o) => {
    if (!legalModesFor(o.kind).includes(mode) || o.display.mode === mode) return o;
    if (mode === 'marker') {
      return { ...o, display: { mode, icon: o.kind === 'image' ? 'photo' : o.kind === 'audio' ? 'audio' : 'note' } };
    }
    if (mode === 'ambient') return { ...o, display: { mode, autoplay: false } };
    const headingDeg = panorama ? deriveHeading(o.anchor, panorama) : 0;
    return { ...o, display: { mode, opacity: 0.8, headingDeg, widthM: 4, heightM: 3 } };
  });
}

/**
 * Re-derive an inWorld overlay's heading from the real panorama position.
 * Returns the tour untouched when the position is unknown: never guess.
 */
export function deriveOverlayHeading(
  tour: Tour, overlayId: string, panorama: LngLatLike | null,
): Tour {
  if (!panorama) return tour;
  const o = tour.stops.flatMap((s) => s.overlays).find((x) => x.id === overlayId);
  if (!o) return tour;
  return setInWorldField(tour, overlayId, { headingDeg: deriveHeading(o.anchor, panorama) });
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

export function setStopTitle(tour: Tour, stopId: string, title: string): Tour {
  return mapStop(tour, stopId, (s) => ({ ...s, title }));
}
