import { MarkerComponent, SimpleMarker, Viewer } from 'mapillary-js';
import type { OverlayMarker, PanoramaViewer } from './panorama-viewer';

const SELECTED = '#e8b04b';
const UNSELECTED = '#2f7fd4';

/**
 * mapillary-js adapter. Two API constraints shape this:
 * markers accept lng/lat only (no altitude), and there is no markerclick
 * event, so clicks are hit-tested against the marker component.
 */
export class MapillaryViewer implements PanoramaViewer {
  private viewer: Viewer | null = null;
  private markerComponent: MarkerComponent | null = null;
  private handler: ((id: string) => void) | null = null;

  attach(container: HTMLElement, accessToken: string): void {
    this.viewer = new Viewer({
      accessToken,
      container,
      component: { cover: false, marker: true, bearing: true, zoom: true },
    });
    this.markerComponent = this.viewer.getComponent('marker') as MarkerComponent;

    this.viewer.on('click', (event) => {
      const point = event.pixelPoint;
      if (!this.markerComponent || !point) return;
      this.markerComponent
        .getMarkerIdAt(point)
        .then((id) => {
          if (id) this.handler?.(id);
        })
        .catch(() => undefined);
    });
  }

  async load(imageId: string, bearing: number): Promise<void> {
    if (!this.viewer) return;
    await this.viewer.moveTo(imageId);
    // Basic image coordinates: x runs 0..1 across the full 360 degrees.
    const normalised = (((bearing % 360) + 360) % 360) / 360;
    this.viewer.setCenter([normalised, 0.5]);
  }

  setMarkers(markers: OverlayMarker[]): void {
    if (!this.markerComponent) return;
    this.markerComponent.removeAll();
    this.markerComponent.add(
      markers.map(
        (m) =>
          new SimpleMarker(m.id, { lng: m.lng, lat: m.lat }, {
            color: m.selected ? SELECTED : UNSELECTED,
            ballColor: m.selected ? SELECTED : UNSELECTED,
            interactive: true,
            radius: 0.7,
          }),
      ),
    );
  }

  onMarkerClick(handler: (id: string) => void): void {
    this.handler = handler;
  }

  destroy(): void {
    this.viewer?.remove();
    this.viewer = null;
    this.markerComponent = null;
  }
}
