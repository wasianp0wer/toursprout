import { distanceBetween, type LngLatLike } from './geo';
import type { Stop } from './tour.models';

/** Close enough to count as standing at a stop. */
export const ARRIVAL_RADIUS_M = 30;

/**
 * How far you must get before a stop can trigger again. The gap above
 * ARRIVAL_RADIUS_M is deliberate: without it, lingering on the boundary would
 * re-fire arrival every time the viewer nudged position.
 */
export const LATCH_RELEASE_M = 45;

export interface ArrivalInput {
  position: LngLatLike;
  stops: Stop[];
  currentIndex: number;
  latched: ReadonlySet<string>;
}

export interface ArrivalResult {
  arrivedIndex: number | null;
  latched: ReadonlySet<string>;
}

export function detectArrival(input: ArrivalInput): ArrivalResult {
  const { position, stops, currentIndex, latched } = input;
  const next = new Set(latched);

  // Release latches for stops we have walked well clear of.
  for (const stop of stops) {
    if (next.has(stop.id) && distanceBetween(position, stop.location) > LATCH_RELEASE_M) {
      next.delete(stop.id);
    }
  }

  let bestIndex: number | null = null;
  let bestDistance = Infinity;

  stops.forEach((stop, index) => {
    if (index === currentIndex || next.has(stop.id)) return;
    const d = distanceBetween(position, stop.location);
    if (d <= ARRIVAL_RADIUS_M && d < bestDistance) {
      bestIndex = index;
      bestDistance = d;
    }
  });

  if (bestIndex !== null) next.add(stops[bestIndex].id);
  return { arrivedIndex: bestIndex, latched: next };
}
