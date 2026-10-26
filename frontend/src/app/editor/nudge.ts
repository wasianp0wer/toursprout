import { metresToLat, metresToLng } from '../core/geo';

/** The subset of an inWorld display the editor's keyboard nudging works on. Heading rides along untouched: this reducer never changes it. */
export interface InWorldPlacementLike {
  lng: number;
  lat: number;
  altitudeM: number;
  headingDeg: number;
  widthM: number;
  heightM: number;
}

/** One metre per keypress, converted to degrees at the working latitude. */
export const STEP_M = 1;
const SCALE_FACTOR = 1.05;
const MIN_SIZE_M = 0.5;

/**
 * Pure reducer: an anchor and a key in, a new anchor out. Deliberately has no
 * heading keys: a heading must pass through the panorama-fix gate in
 * document-ops (derive, or setOverlayHeadingManual), and this reducer has no
 * fix to offer.
 */
export function nudgeAnchor(anchor: InWorldPlacementLike, key: string): InWorldPlacementLike {
  const next = { ...anchor };
  // Laptop keyboards often lack PageUp/PageDown, so z and c raise and lower
  // as well. Case-folded so shift or caps lock does not silently do nothing.
  switch (key.length === 1 ? key.toLowerCase() : key) {
    case 'ArrowUp':
      next.lat += metresToLat(STEP_M);
      break;
    case 'ArrowDown':
      next.lat -= metresToLat(STEP_M);
      break;
    case 'ArrowRight':
      next.lng += metresToLng(STEP_M, anchor.lat);
      break;
    case 'ArrowLeft':
      next.lng -= metresToLng(STEP_M, anchor.lat);
      break;
    case 'PageUp':
    case 'z':
      next.altitudeM += STEP_M;
      break;
    case 'PageDown':
    case 'c':
      next.altitudeM -= STEP_M;
      break;
    case '+':
    case '=':
      next.widthM = anchor.widthM * SCALE_FACTOR;
      next.heightM = anchor.heightM * SCALE_FACTOR;
      break;
    case '-':
      next.widthM = Math.max(MIN_SIZE_M, anchor.widthM / SCALE_FACTOR);
      next.heightM = Math.max(MIN_SIZE_M, anchor.heightM / SCALE_FACTOR);
      break;
    default:
      return anchor;
  }
  return next;
}
