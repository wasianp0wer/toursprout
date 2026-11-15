import type { ImageryReport, OverlayMarker, PanoramaViewer } from './panorama-viewer';
import type { InWorldPlacement } from './in-world-placement';
import type { MarkerColours } from '../core/theme';

/** Records interactions so component behaviour can be asserted without WebGL. */
export class FakeViewer implements PanoramaViewer {
  loaded: { imageId: string; bearing: number }[] = [];
  /**
   * Every report the viewer has made. MapillaryViewer gets these from
   * mapillary-js; nothing here can, so pane and store tests drive them
   * through emitImageryReport, which is what lets the wedge be tested with
   * no WebGL.
   */
  imageryReports: ImageryReport[] = [];
  markers: OverlayMarker[][] = [];
  /** Each setMarkers call with the colours in force at that moment, to pin effect order. */
  markerCalls: { markers: OverlayMarker[]; colours: MarkerColours | null }[] = [];
  /** The last colours set; null until called, which is what the editor must stay at. */
  markerColours: MarkerColours | null = null;
  inWorldPlacements: InWorldPlacement[][] = [];
  opacity: Record<string, number> | null = null;
  destinationBearing: number | null = null;
  destroyed = false;
  /**
   * How many redraws the viewer was asked for. mapillary-js renders on demand,
   * so MapillaryViewer requests one after every placement or opacity change
   * (see its requestRedraw); this models that so a pane test can assert a scene
   * mutation was not left stale.
   */
  rerenders = 0;
  failNextLoad = false;
  attachedTo: HTMLElement | null = null;

  private markerHandler: ((id: string) => void) | null = null;
  private positionHandler:
    | ((position: { lng: number; lat: number }, imageId: string) => void)
    | null = null;
  private reportHandler: ((report: ImageryReport) => void) | null = null;

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
    this.markerCalls.push({ markers, colours: this.markerColours });
  }

  setMarkerColours(colours: MarkerColours): void {
    this.markerColours = colours;
  }

  onMarkerClick(handler: (id: string) => void): void {
    this.markerHandler = handler;
  }

  emitMarkerClick(id: string): void {
    this.markerHandler?.(id);
  }

  setInWorldPlacements(placements: InWorldPlacement[]): void {
    this.inWorldPlacements.push(placements);
    this.rerenders++;
  }

  setInWorldOpacity(opacities: Record<string, number>): void {
    this.opacity = opacities;
    this.rerenders++;
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

  onImageryReport(handler: (report: ImageryReport) => void): void {
    this.reportHandler = handler;
  }

  emitImageryReport(report: ImageryReport): void {
    this.imageryReports.push(report);
    this.reportHandler?.(report);
  }

  destroy(): void {
    this.destroyed = true;
  }
}
