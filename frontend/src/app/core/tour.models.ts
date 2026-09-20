/**
 * Mirrors the pydantic models in backend/app/models.py, which are the single
 * source of truth for the schema. Field names match the JSON aliases exactly.
 */

export interface Credit {
  source: string;
  url: string;
  license: string;
  creator: string | null;
}

export interface GeoAnchor {
  type: 'geo';
  lng: number;
  lat: number;
  /** Carried for the map layer and future image anchors; mapillary-js markers ignore it. */
  altitude: number;
}

export interface GeoQuadAnchor {
  type: 'geoQuad';
  lng: number;
  lat: number;
  altitude: number;
  /** Compass direction the face of the photograph looks toward. */
  headingDeg: number;
  widthM: number;
  heightM: number;
}

/** Discriminated on `type`, mirroring the pydantic union. */
export type Anchor = GeoAnchor | GeoQuadAnchor;

export type OverlayKind = 'text' | 'image' | 'audio' | 'rephoto';

export interface Overlay {
  id: string;
  kind: OverlayKind;
  anchor: Anchor;
  title: string;
  body: string | null;
  mediaId: string | null;
  credit: Credit;
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
  schemaVersion: number;
  title: string;
  description: string;
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
