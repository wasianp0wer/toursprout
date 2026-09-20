export interface OverlayMarker {
  id: string;
  lng: number;
  lat: number;
  selected: boolean;
}

/**
 * The seam that contains mapillary-js. Nothing outside the panorama folder
 * should import from 'mapillary-js' directly — the library was last published
 * in 2023 and is expected to be replaced.
 */
export interface PanoramaViewer {
  attach(container: HTMLElement, accessToken: string): void;
  load(imageId: string, bearing: number): Promise<void>;
  setMarkers(markers: OverlayMarker[]): void;
  onMarkerClick(handler: (id: string) => void): void;
  destroy(): void;
}
