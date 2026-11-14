import type { InWorldPlacement } from './in-world-placement';
import type { MarkerColours } from '../core/theme';

export interface OverlayMarker {
  id: string;
  lng: number;
  lat: number;
  selected: boolean;
  /** Destination markers point at the next stop while walking. */
  kind: 'overlay' | 'destination';
}

/**
 * What mapillary-js says about the image the viewer actually loaded, as
 * against what the document claims about it.
 *
 * The document cannot hold these: `Panorama` says nothing about projection,
 * and its `bearing` is a required non-nullable number, so a stop whose imagery
 * has no compass angle stores `0` and *facing north* is indistinguishable from
 * *direction unknown*. The viewer is the only place that knows, and it knows
 * only once the image has loaded.
 */
export interface ImageryReport {
  /**
   * Which image this is about. Keyed exactly as PanoramaFix is, because a
   * panorama pane can lag a selection change and an unkeyed report would
   * silently be the previous image's.
   */
  imageId: string;
  /** 'spherical' | 'fisheye' | 'perspective', or undefined if SfM has not been run. */
  cameraType: string | undefined;
  /**
   * As Mapillary reports it, sentinel and all: an unknown angle comes back as
   * **-1**, not null. Read it with `knownCompassAngle`, never directly.
   */
  compassAngle: number | null;
}

/**
 * The seam that contains mapillary-js and three.js. Nothing outside the
 * panorama folder should import either directly — mapillary-js was last
 * published in 2023 and is expected to be replaced.
 */
export interface PanoramaViewer {
  attach(container: HTMLElement, accessToken: string): void;
  load(imageId: string, bearing: number): Promise<void>;
  setMarkers(markers: OverlayMarker[]): void;
  /**
   * The colours markers are painted with. A parameter on the viewer and not a
   * root-provided theme store, on purpose: EditPanoramaPane calls setMarkers on
   * this same PanoramaViewer, so a store read inside the implementation would
   * theme the editor's markers with the open tour's colours. As a parameter the
   * editor simply never calls this, the implementation keeps its defaults, and
   * "the editor is never themed" holds by construction. Do not simplify it into
   * a store.
   */
  setMarkerColours(colours: MarkerColours): void;
  onMarkerClick(handler: (id: string) => void): void;

  /** Photographs draped in the world. */
  setInWorldPlacements(placements: InWorldPlacement[]): void;
  /**
   * Opacity per placement id: 0 shows the present view, 1 the photograph.
   * The whole map is passed at once so the renderer cannot drift out of step
   * with the store.
   */
  setInWorldOpacity(opacities: Record<string, number>): void;
  /** Compass bearing to the next stop, or null to clear the arrow highlight. */
  setDestinationBearing(bearingDeg: number | null): void;
  /** Fires whenever the viewer moves to a different image. */
  onPositionChange(
    handler: (position: { lng: number; lat: number }, imageId: string) => void,
  ): void;
  /**
   * Fires with the same move, carrying what mapillary-js says about the image
   * it landed on. The editor's map draws its view wedge from this rather than
   * from the document, because a flat image's stored bearing may mean nothing.
   */
  onImageryReport(handler: (report: ImageryReport) => void): void;

  destroy(): void;
}
