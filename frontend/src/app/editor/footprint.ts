/**
 * Ground geometry for the editable map. Pure: no Leaflet, no DOM, so every
 * coordinate here is checked by arithmetic in footprint.spec.ts, which
 * matters because no browser can run in this project's environment.
 *
 * Conventions: headings are compass degrees (0 = north, clockwise). An
 * in-world plane's FACE looks along its heading; its EXTENT lies across it,
 * so the footprint line runs along heading + 90.
 *
 * Method: a local equirectangular offset, using the metres-to-degrees
 * helpers (core/geo.ts, shared with nudge.ts). Its limits, stated rather than
 * hidden:
 *  - Accurate for the tens of metres a footprint spans at the latitudes this
 *    tour lives at (38.8 N), and fine well into the 60s. The longitude scale
 *    is 1/cos(lat), which diverges at the poles, so above roughly 85 degrees
 *    latitude the results are not meaningful. A walking tour of streets does
 *    not go there.
 *  - Longitude is wrapped into [-180, 180), so a footprint straddling the
 *    antimeridian comes back as two coordinates on opposite sides of it. The
 *    two ends are then NOT a short line in lng/lat space, and a renderer
 *    drawing a straight polyline between them would sweep across the whole
 *    map. Wrapping keeps each coordinate valid; drawing across the seam is
 *    not handled.
 */
import { bearingBetween, metresToLat, metresToLng, type LngLatLike } from '../core/geo';
import { knownCompassAngle } from '../core/mapillary-search';
import { isFlatCamera } from '../panorama/view-turn';
import type { ImageryReport } from '../panorama/panorama-viewer';

const rad = (deg: number) => (deg * Math.PI) / 180;
const wrapLng = (lng: number) => ((((lng + 180) % 360) + 360) % 360) - 180;

/** The point `distanceM` from `origin` along compass bearing `bearingDeg`. */
function offset(origin: LngLatLike, bearingDeg: number, distanceM: number): LngLatLike {
  const east = distanceM * Math.sin(rad(bearingDeg));
  const north = distanceM * Math.cos(rad(bearingDeg));
  return {
    lng: wrapLng(origin.lng + metresToLng(east, origin.lat)),
    lat: origin.lat + metresToLat(north),
  };
}

/**
 * The two ends of the line an in-world plane occupies on the ground: widthM
 * long, centred on the anchor, perpendicular to the heading.
 */
export function footprintCorners(
  anchor: LngLatLike, headingDeg: number, widthM: number,
): [LngLatLike, LngLatLike] {
  const across = headingDeg + 90;
  return [offset(anchor, across + 180, widthM / 2), offset(anchor, across, widthM / 2)];
}

/** Where the rotation handle sits: `offsetM` out from the anchor, in front of the face. */
export function rotationHandleAt(anchor: LngLatLike, headingDeg: number, offsetM: number): LngLatLike {
  return offset(anchor, headingDeg, offsetM);
}

/**
 * The heading a dragged handle means: the bearing from the anchor to where
 * the handle was dropped. Taken from the drop point alone, never from a
 * stop's location.
 */
export function headingFromHandle(anchor: LngLatLike, handle: LngLatLike): number {
  return ((bearingBetween(anchor, handle) % 360) + 360) % 360;
}

/**
 * A field-of-view wedge as a polygon: the camera, then an arc of points
 * `radiusM` away spanning `fovDeg` centred on `bearingDeg`.
 */
export function viewWedge(
  camera: LngLatLike, bearingDeg: number, fovDeg: number, radiusM: number, steps = 8,
): LngLatLike[] {
  const pts: LngLatLike[] = [{ lng: camera.lng, lat: camera.lat }];
  for (let i = 0; i <= steps; i++) {
    pts.push(offset(camera, bearingDeg - fovDeg / 2 + (fovDeg * i) / steps, radiusM));
  }
  return pts;
}

/**
 * 360 imagery: unchanged. The stored bearing is a view direction the visitor
 * can turn to, and this wedge indicates it; a panorama shows every direction,
 * so the angle has never been a claim about what was captured.
 */
export const SPHERICAL_WEDGE_FOV_DEG = 90;

/**
 * Flat imagery: narrower, and a fixed constant rather than a computed figure.
 *
 * Here the wedge means something stronger — this is all the camera caught, and
 * anything anchored outside it will be in the document, render correctly and
 * never be visible. Real phone and dashcam capture runs roughly 70-90 degrees
 * wide, so 60 deliberately under-claims: an indicator that is too narrow
 * disappoints, one that is too wide misleads. Mapillary does return
 * `camera_parameters`, from which the true field of view could be derived;
 * doing so is out of scope.
 */
export const FLAT_WEDGE_FOV_DEG = 60;

/**
 * Which view wedge the edit map should draw for a stop, or null for none.
 *
 * | Reported camera type | Wedge |
 * | --- | --- |
 * | `spherical`, or unknown | the stored bearing, SPHERICAL_WEDGE_FOV_DEG |
 * | flat, compass angle known | the REPORTED angle, FLAT_WEDGE_FOV_DEG |
 * | flat, compass angle unknown (`-1` or absent) | none |
 * | nothing reported yet, or a report for another image | none |
 *
 * The stored bearing is not consulted for flat imagery, and deliberately: it
 * is a fact about where the camera happened to point, not a direction the
 * author chose, and when Mapillary does not know the angle the document can
 * only hold `0`, which is indistinguishable from due north. So the viewer
 * reports what it actually loaded and this trusts that over the document —
 * the same discipline as panoramaFixForStop, which refuses a position fix
 * that belongs to a different image.
 *
 * A document opened fresh therefore draws no wedge until its panorama loads.
 * That is correct, not a degradation: the alternative is a confident
 * 90-degree wedge drawn from a number that may mean nothing.
 */
export function wedgeFor(
  panorama: { imageId: string; bearing: number },
  report: ImageryReport | null,
): { bearingDeg: number; fovDeg: number } | null {
  if (!report || report.imageId !== panorama.imageId) return null;
  if (!isFlatCamera(report.cameraType)) {
    return { bearingDeg: panorama.bearing, fovDeg: SPHERICAL_WEDGE_FOV_DEG };
  }
  // knownCompassAngle, not a null check: Mapillary's "unknown" is -1, which
  // would otherwise draw a wedge pointing within a degree of north.
  const angle = knownCompassAngle(report.compassAngle);
  return angle === null ? null : { bearingDeg: angle, fovDeg: FLAT_WEDGE_FOV_DEG };
}
