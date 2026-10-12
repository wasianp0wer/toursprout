import type { InWorldPlacement } from './rephoto-placement';

export interface OverlayMarker {
  id: string;
  lng: number;
  lat: number;
  selected: boolean;
  /** Destination markers point at the next stop while walking. */
  kind: 'overlay' | 'destination';
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
  onMarkerClick(handler: (id: string) => void): void;

  /** Photographs draped in the world. */
  setRephotos(rephotos: InWorldPlacement[]): void;
  /**
   * Opacity per rephoto id: 0 shows the present view, 1 the photograph.
   * The whole map is passed at once so the renderer cannot drift out of step
   * with the store.
   */
  setRephotoOpacity(opacities: Record<string, number>): void;
  /** Compass bearing to the next stop, or null to clear the arrow highlight. */
  setDestinationBearing(bearingDeg: number | null): void;
  /** Fires whenever the viewer moves to a different image. */
  onPositionChange(
    handler: (position: { lng: number; lat: number }, imageId: string) => void,
  ): void;

  destroy(): void;
}
