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
