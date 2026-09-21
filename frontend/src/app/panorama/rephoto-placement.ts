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
  /** Euler rotation, radians, in the same east/north/up frame. */
  rotation: [number, number, number];
  /**
   * Intrinsic order the rotation must be applied in. ZYX means "stand the
   * plane upright about X first, then swing it about the up axis". The
   * default XYZ applies Z first, which does nothing to a normal that starts
   * along Z and leaves every photograph facing south.
   */
  rotationOrder: 'ZYX';
  width: number;
  height: number;
}

export function planeTransform(
  placement: RephotoPlacement,
  enu: [number, number, number],
): PlaneTransform {
  // The scene is ENU — east, north, UP — so "up" is +Z, not three.js's usual
  // +Y. A PlaneGeometry's normal starts along +Z, which here points at the
  // sky: left alone the photograph lies flat on the ground and is invisible
  // edge-on. Rotating a quarter turn about X stands it upright, which leaves
  // it facing south; a further turn about the up axis aims it at the wanted
  // compass heading.
  const heading = ((placement.headingDeg % 360) + 360) % 360;
  const aboutUp = ((180 - heading) * Math.PI) / 180;

  return {
    position: [enu[0], enu[1], enu[2]],
    rotation: [Math.PI / 2, 0, aboutUp],
    rotationOrder: 'ZYX',
    width: placement.widthM,
    height: placement.heightM,
  };
}
