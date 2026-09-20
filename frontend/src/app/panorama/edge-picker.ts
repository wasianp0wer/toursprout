/**
 * Chooses which ground arrow leads toward the next stop.
 *
 * Kept as a pure function over plain records so mapillary-js types stay inside
 * the adapter, matching how the rest of the panorama folder is arranged.
 */

export interface DirectionEdge {
  targetId: string;
  /** Counter-clockwise radians from east, as mapillary-js reports it. */
  azimuthRad: number;
  /** True for edges mapillary-js renders as arrows on the ground. */
  isGroundArrow: boolean;
}

/** Beyond this, an arrow is not meaningfully "toward" the destination. */
export const MAX_ARROW_DEVIATION_DEG = 60;

/** mapillary azimuth (counter-clockwise from east) to compass bearing. */
function azimuthToBearing(azimuthRad: number): number {
  return (((90 - (azimuthRad * 180) / Math.PI) % 360) + 360) % 360;
}

/** Smallest absolute angle between two bearings, in degrees. */
function angularDifference(a: number, b: number): number {
  return Math.abs((((a - b + 540) % 360) + 360) % 360 - 180);
}

export function pickEdgeToward(
  edges: DirectionEdge[],
  targetBearingDeg: number | null,
): string | null {
  if (targetBearingDeg === null) return null;

  let best: string | null = null;
  let bestDeviation = MAX_ARROW_DEVIATION_DEG;

  for (const edge of edges) {
    if (!edge.isGroundArrow) continue;
    const deviation = angularDifference(azimuthToBearing(edge.azimuthRad), targetBearingDeg);
    if (deviation <= bestDeviation) {
      best = edge.targetId;
      bestDeviation = deviation;
    }
  }

  return best;
}
