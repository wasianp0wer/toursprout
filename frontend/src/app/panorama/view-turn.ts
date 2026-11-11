/**
 * Whether the view may be turned to a compass bearing, and where to.
 *
 * Kept as a pure function over plain numbers so it can be tested without
 * mapillary-js or a WebGL context, matching how the rest of the panorama
 * folder is arranged. The branch it holds cannot be reached from a spec if it
 * lives inside the adapter: jsdom has no WebGL, and the test double records
 * {imageId, bearing} without modelling camera types.
 *
 * Why there is a branch at all: `setCenter` works in basic image coordinates,
 * and the shift of `delta / 360` assumes x spans the full circle. That is true
 * of a spherical image and of nothing else. On a perspective image x spans the
 * camera's field of view — roughly 70-90 degrees — so the same shift
 * over-rotates by a factor of four or five, and most bearings are not
 * reachable at all. Every hand-guessed bearing in this project's history was
 * wrong, one by 138 degrees; this is the same class of error arriving through
 * the arithmetic instead.
 */

/** The three projections mapillary-js can draw (its own CameraType union). */
export type CameraType = 'spherical' | 'fisheye' | 'perspective';

/**
 * True only for an image Mapillary positively says is NOT spherical.
 *
 * Unknown is deliberately not flat. `Image.cameraType` is documented as
 * undefined if SfM has not been run, and treating unknown as spherical
 * preserves exactly today's behaviour for every image that works today — only
 * a positive statement from Mapillary changes anything. The cost is that a
 * flat image whose SfM has not run would still over-rotate; whether that
 * happens is the one thing in this design that needs a browser
 * (`docs/UNVERIFIED.md`, entry 42, check 3).
 */
export function isFlatCamera(cameraType: string | undefined | null): boolean {
  return cameraType === 'perspective' || cameraType === 'fisheye';
}

/**
 * The basic-image centre that faces `targetBearingDeg`, or null for "do not
 * turn — leave the view where mapillary-js opened it".
 *
 * Reading the current bearing and shifting by the signed difference works
 * whatever the image's orientation; x = 0 is the left edge of the panorama,
 * not due north, and mapping a bearing to x directly pointed every stop in an
 * arbitrary direction (`docs/ENVIRONMENT.md`).
 */
export function centerForBearing(
  cameraType: string | undefined | null,
  currentBearingDeg: number,
  center: [number, number],
  targetBearingDeg: number,
): [number, number] | null {
  if (isFlatCamera(cameraType)) return null;
  const delta = (((targetBearingDeg - currentBearingDeg + 540) % 360) - 180) / 360;
  const x = (((center[0] + delta) % 1) + 1) % 1;
  return [x, center[1]];
}
