/**
 * Turns a georeferenced photograph into a plane transform.
 *
 * Pure by design: the ENU position is passed in rather than computed, so this
 * can be tested without mapillary-js or a WebGL context.
 */

export interface RephotoPlacement {
  id: string;
  imageUrl: string;
  lng: number;
  lat: number;
  altitude: number;
  /** Compass direction the face of the photograph looks toward. */
  headingDeg: number;
  widthM: number;
  heightM: number;
}

export interface PlaneTransform {
  /** East, north, up — the frame mapillary's geodeticToEnu returns. */
  position: [number, number, number];
  /** Rotation about the up axis, radians. */
  rotationY: number;
  width: number;
  height: number;
}

export function planeTransform(
  placement: RephotoPlacement,
  enu: [number, number, number],
): PlaneTransform {
  // Compass bearings run clockwise; rotation about the up axis runs
  // counter-clockwise, hence the negation.
  const normalised = ((placement.headingDeg % 360) + 360) % 360;

  return {
    position: [enu[0], enu[1], enu[2]],
    rotationY: -(normalised * Math.PI) / 180,
    width: placement.widthM,
    height: placement.heightM,
  };
}
