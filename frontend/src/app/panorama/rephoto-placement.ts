/**
 * Turns a georeferenced photograph into a plane transform.
 *
 * Pure by design: the ENU position is passed in rather than computed, so this
 * can be tested without mapillary-js or a WebGL context.
 */

export interface InWorldPlacement {
  id: string;
  imageUrl: string;
  lng: number;
  lat: number;
  altitudeM: number;
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
  placement: InWorldPlacement,
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


/**
 * Convert an anchor's height above the ground into the absolute altitude
 * `geodeticToEnu` expects.
 *
 * Authors think in metres above the pavement; the conversion works in metres
 * above the ellipsoid. Passing the raw value placed the Fairfax photographs
 * 128 m underground, since the local ground sits at ~136 m.
 */
export function geodeticAltitude(anchorAltitude: number, referenceAltitude: number): number {
  return referenceAltitude + anchorAltitude;
}


/**
 * Material options for a draped photograph.
 *
 * `DoubleSide` is not cosmetic. A plane rendered `FrontSide` vanishes the
 * moment the viewer passes behind its normal, and since the heading is
 * authored by eye it will often be roughly edge-on. A photograph standing in
 * the world should be legible from either side rather than disappearing.
 */
export function rephotoMaterialOptions(opacity: number) {
  return {
    transparent: true,
    opacity,
    depthTest: false,
    depthWrite: false,
    side: 2 as const, // THREE.DoubleSide
  };
}
