export interface LngLatLike {
  lng: number;
  lat: number;
}

const EARTH_RADIUS_M = 6_371_000;

const toRad = (deg: number) => (deg * Math.PI) / 180;
const toDeg = (rad: number) => (rad * 180) / Math.PI;

/** Compass bearing in degrees: 0 is north, increasing clockwise. */
export function bearingBetween(from: LngLatLike, to: LngLatLike): number {
  const phi1 = toRad(from.lat);
  const phi2 = toRad(to.lat);
  const dLambda = toRad(to.lng - from.lng);

  const y = Math.sin(dLambda) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLambda);

  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/** Great-circle distance in metres. */
export function distanceBetween(from: LngLatLike, to: LngLatLike): number {
  const phi1 = toRad(from.lat);
  const phi2 = toRad(to.lat);
  const dPhi = phi2 - phi1;
  const dLambda = toRad(to.lng - from.lng);

  const a = Math.sin(dPhi / 2) ** 2 + Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLambda / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(a));
}

const METRES_PER_DEGREE_LAT = 111_320;

/** Metres north to degrees of latitude. */
export const metresToLat = (m: number) => m / METRES_PER_DEGREE_LAT;
/** Metres east to degrees of longitude at `lat`. Diverges toward the poles. */
export const metresToLng = (m: number, lat: number) =>
  m / (METRES_PER_DEGREE_LAT * Math.cos((lat * Math.PI) / 180));
