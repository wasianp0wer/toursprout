import type { OverlayMarker, PanoramaViewer } from './panorama-viewer';

/** Records interactions so component behaviour can be asserted without WebGL. */
export class FakeViewer implements PanoramaViewer {
  loaded: { imageId: string; bearing: number }[] = [];
  markers: OverlayMarker[][] = [];
  destroyed = false;
  failNextLoad = false;
  attachedTo: HTMLElement | null = null;
  private handler: ((id: string) => void) | null = null;

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
    this.handler = handler;
  }

  emitMarkerClick(id: string): void {
    this.handler?.(id);
  }

  destroy(): void {
    this.destroyed = true;
  }
}
