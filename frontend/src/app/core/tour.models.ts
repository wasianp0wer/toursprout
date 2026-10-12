/**
 * Mirrors the pydantic models in backend/app/models.py, which are the single
 * source of truth for the schema. Field names match the JSON aliases exactly.
 *
 * Three independent axes: `kind` is what an overlay is, `anchor` is where it
 * is, `display` is how it is drawn.
 */

export interface OriginalCredit {
  type: 'original';
  creator: string;
  license: string;
}

export interface SourcedCredit {
  type: 'sourced';
  source: string;
  url: string;
  license: string;
  creator: string | null;
}

export type Credit = OriginalCredit | SourcedCredit;

export interface GeoAnchor {
  type: 'geo';
  lng: number;
  lat: number;
  /** Metres above LOCAL GROUND, not above the ellipsoid. See geodeticAltitude(). */
  altitudeM: number;
}

/** One member today; `type` is already literal so a second is additive. */
export type Anchor = GeoAnchor;

export interface MarkerDisplay {
  mode: 'marker';
  icon: 'note' | 'photo' | 'audio' | 'place';
}

export interface InWorldDisplay {
  mode: 'inWorld';
  /** The value the stop OPENS at; the visitor's slider moves from there. */
  opacity: number;
  /** Compass direction the face looks toward. */
  headingDeg: number;
  widthM: number;
  heightM: number;
}

export interface AmbientDisplay {
  mode: 'ambient';
  autoplay: boolean;
}

export type Display = MarkerDisplay | InWorldDisplay | AmbientDisplay;

export type OverlayKind = 'text' | 'image' | 'audio';

export interface Overlay {
  id: string;
  kind: OverlayKind;
  anchor: Anchor;
  display: Display;
  title: string;
  body: string | null;
  mediaId: string | null;
  credit: Credit;
}

export interface TourDefaults {
  creator: string;
  license: string;
}

export interface Panorama {
  provider: 'mapillary';
  imageId: string;
  bearing: number;
  cachedPath: string | null;
}

export interface Stop {
  id: string;
  order: number;
  title: string;
  summary: string;
  location: { lng: number; lat: number };
  osmRef: string | null;
  panorama: Panorama;
  overlays: Overlay[];
}

export interface Attribution {
  text: string;
  url: string;
  license: string;
}

export interface Tour {
  id: string;
  /**
   * Narrowed to the literal pydantic enforces (`Literal[2]` in
   * backend/app/models.py), not `number`: a file-backed viewer with no
   * Python in the path (the migration lives only in app.migration) must
   * fail to compile against a v1 document rather than accept it silently.
   */
  schemaVersion: 2;
  title: string;
  description: string;
  /**
   * Optional, not just nullable: the on-disk content/tours/*.json has no
   * `defaults` key at all when the author set none. The API fills it in as
   * `"defaults": null` (pydantic's default), but a reader of the file
   * directly sees no key, and both must satisfy this type.
   */
  defaults?: TourDefaults | null;
  attribution: Attribution[];
  stops: Stop[];
}

export interface TourSummary {
  id: string;
  title: string;
  description: string;
  stopCount: number;
}

export interface AppConfig {
  mapillaryToken: string;
  tileUrl: string;
  attribution: Attribution[];
}
