import type { OverlayMarker, PanoramaViewer } from './panorama-viewer';
import type { RephotoPlacement } from './rephoto-placement';

/** Records interactions so component behaviour can be asserted without WebGL. */
export class FakeViewer implements PanoramaViewer {
  loaded: { imageId: string; bearing: number }[] = [];
  markers: OverlayMarker[][] = [];
  rephotos: RephotoPlacement[][] = [];
  opacity: Record<string, number> | null = null;
  destinationBearing: number | null = null;
  destroyed = false;
  failNextLoad = false;
  attachedTo: HTMLElement | null = null;

  private markerHandler: ((id: string) => void) | null = null;
  private positionHandler:
    | ((position: { lng: number; lat: number }, imageId: string) => void)
    | null = null;

  attach(container: HTMLElement): void {
    this.attachedTo = container;
  }

  async load(imageId: string, bearing: number): Promise<void> {
    if (this.failNextLoad) {
      this.failNextLoad = false;
      throw new Error('no imagery');
    }
    this.loaded.push({ imageId, bearing });
  }

  setMarkers(markers: OverlayMarker[]): void {
    this.markers.push(markers);
  }

  onMarkerClick(handler: (id: string) => void): void {
    this.markerHandler = handler;
  }

  emitMarkerClick(id: string): void {
    this.markerHandler?.(id);
  }

  setRephotos(rephotos: RephotoPlacement[]): void {
    this.rephotos.push(rephotos);
  }

  setRephotoOpacity(opacities: Record<string, number>): void {
    this.opacity = opacities;
  }

  setDestinationBearing(bearingDeg: number | null): void {
    this.destinationBearing = bearingDeg;
  }

  onPositionChange(
    handler: (position: { lng: number; lat: number }, imageId: string) => void,
  ): void {
    this.positionHandler = handler;
  }

  emitPositionChange(position: { lng: number; lat: number }, imageId: string): void {
    this.positionHandler?.(position, imageId);
  }

  destroy(): void {
    this.destroyed = true;
  }
}
