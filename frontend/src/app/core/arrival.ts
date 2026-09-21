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

  // Arrive only at the stop you are actually closest to. A plain radius test
  // is not enough where stops are near each other: the Marr Monument stands
  // 14.6 m from the courthouse, well inside the 30 m radius, so a radius-only
  // rule teleports the tour off the courthouse the moment it loads.
  let nearestIndex: number | null = null;
  let nearestDistance = Infinity;

  stops.forEach((stop, index) => {
    const d = distanceBetween(position, stop.location);
    if (d < nearestDistance) {
      nearestIndex = index;
      nearestDistance = d;
    }
  });

  if (
    nearestIndex === null ||
    nearestIndex === currentIndex ||
    nearestDistance > ARRIVAL_RADIUS_M ||
    next.has(stops[nearestIndex].id)
  ) {
    return { arrivedIndex: null, latched: next };
  }

  next.add(stops[nearestIndex].id);
  return { arrivedIndex: nearestIndex, latched: next };
}
