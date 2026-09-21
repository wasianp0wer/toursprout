import {
  type DirectionComponent,
  type MarkerComponent,
  NavigationDirection,
  SimpleMarker,
  Viewer,
} from 'mapillary-js';
import { pickEdgeToward, type DirectionEdge } from './edge-picker';
import type { OverlayMarker, PanoramaViewer } from './panorama-viewer';
import type { RephotoPlacement } from './rephoto-placement';
import { diagnosticsEnabled } from './diagnostics';
import { RephotoRenderer } from './rephoto-renderer';

const SELECTED = '#e8b04b';
const UNSELECTED = '#2f7fd4';
const DESTINATION = '#5fd08a';

/** The edge kinds mapillary-js draws as arrows on the ground. */
const GROUND_ARROW_DIRECTIONS = new Set<NavigationDirection>([
  NavigationDirection.StepForward,
  NavigationDirection.StepBackward,
  NavigationDirection.StepLeft,
  NavigationDirection.StepRight,
  NavigationDirection.Next,
  NavigationDirection.Prev,
]);

/**
 * mapillary-js adapter. Three API constraints shape this:
 * markers accept lng/lat only (no altitude); there is no markerclick event, so
 * clicks are hit-tested; and arrow highlighting is driven by image id through
 * the direction component's configuration.
 */
export class MapillaryViewer implements PanoramaViewer {
  private viewer: Viewer | null = null;
  private markerComponent: MarkerComponent | null = null;
  private directionComponent: DirectionComponent | null = null;
  private rephotoRenderer: RephotoRenderer | null = null;

  private destinationBearing: number | null = null;
  private latestEdges: DirectionEdge[] = [];
  private markerHandler: ((id: string) => void) | null = null;
  private positionHandler:
    | ((position: { lng: number; lat: number }, imageId: string) => void)
    | null = null;

  attach(container: HTMLElement, accessToken: string): void {
    this.viewer = new Viewer({
      accessToken,
      container,
      component: { cover: false, marker: true, bearing: true, zoom: true, direction: true },
    });
    this.markerComponent = this.viewer.getComponent('marker') as MarkerComponent;
    this.directionComponent = this.viewer.getComponent('direction') as DirectionComponent;

    this.rephotoRenderer = new RephotoRenderer(
      typeof location === 'undefined' ? false : diagnosticsEnabled(location.search),
    );
    this.viewer.addCustomRenderer(this.rephotoRenderer);

    this.viewer.on('click', (event) => {
      const point = event.pixelPoint;
      if (!this.markerComponent || !point) return;
      this.markerComponent
        .getMarkerIdAt(point)
        .then((id) => {
          if (id) this.markerHandler?.(id);
        })
        .catch(() => undefined);
    });

    // Walking the street: every move reports where the viewer now stands.
    this.viewer.on('image', (event) => {
      const image = event.image;
      const lngLat = image.computedLngLat ?? image.lngLat;
      this.positionHandler?.({ lng: lngLat.lng, lat: lngLat.lat }, image.id);
    });

    // Ground arrows come from spatial edges; re-pick whenever they change.
    this.viewer.on('spatialedges', (event) => {
      this.latestEdges = event.status.edges.map((edge) => ({
        targetId: edge.target,
        azimuthRad: edge.data.worldMotionAzimuth,
        isGroundArrow: GROUND_ARROW_DIRECTIONS.has(edge.data.direction),
      }));
      this.applyHighlight();
    });
  }

  async load(imageId: string, bearing: number): Promise<void> {
    if (!this.viewer) return;
    await this.viewer.moveTo(imageId);
    await this.faceBearing(bearing);
  }

  /**
   * Turn the view to a compass bearing.
   *
   * `setCenter` works in basic image coordinates, and x = 0 is the left edge
   * of the panorama, not due north — the offset depends on how the image
   * happens to be oriented. Mapping bearing to x directly pointed every stop
   * in an arbitrary direction. Reading the current bearing and shifting by the
   * difference works whatever the image's orientation.
   */
  private async faceBearing(target: number): Promise<void> {
    if (!this.viewer) return;
    try {
      const [current, center] = await Promise.all([
        this.viewer.getBearing(),
        this.viewer.getCenter(),
      ]);
      const delta = (((target - current + 540) % 360) - 180) / 360;
      const x = (((center[0] + delta) % 1) + 1) % 1;
      this.viewer.setCenter([x, center[1]]);
    } catch {
      // A view that will not turn is a cosmetic failure, not a fatal one.
    }
  }

  setMarkers(markers: OverlayMarker[]): void {
    if (!this.markerComponent) return;
    this.markerComponent.removeAll();
    this.markerComponent.add(
      markers.map((m) => {
        const colour =
          m.kind === 'destination' ? DESTINATION : m.selected ? SELECTED : UNSELECTED;
        return new SimpleMarker(m.id, { lng: m.lng, lat: m.lat }, {
          color: colour,
          ballColor: colour,
          interactive: true,
          radius: m.kind === 'destination' ? 1.1 : 0.7,
        });
      }),
    );
  }

  onMarkerClick(handler: (id: string) => void): void {
    this.markerHandler = handler;
  }

  setRephotos(rephotos: RephotoPlacement[]): void {
    this.rephotoRenderer?.setRephotos(rephotos);
    this.requestRedraw();
  }

  setRephotoOpacity(opacity: number): void {
    this.rephotoRenderer?.setOpacity(opacity);
    this.requestRedraw();
  }

  /**
   * Ask the viewer to draw another frame.
   *
   * mapillary-js renders on demand, and custom renderers are only invoked
   * during its own redraws. Without this, changing a rephoto or moving the
   * opacity slider has no visible effect until the user happens to drag the
   * panorama.
   */
  private requestRedraw(): void {
    this.viewer?.triggerRerender();
  }

  setDestinationBearing(bearingDeg: number | null): void {
    this.destinationBearing = bearingDeg;
    this.applyHighlight();
  }

  onPositionChange(
    handler: (position: { lng: number; lat: number }, imageId: string) => void,
  ): void {
    this.positionHandler = handler;
  }

  destroy(): void {
    if (this.viewer && this.rephotoRenderer) {
      this.viewer.removeCustomRenderer(this.rephotoRenderer.id);
    }
    this.rephotoRenderer = null;
    this.directionComponent = null;
    this.viewer?.remove();
    this.viewer = null;
    this.markerComponent = null;
  }

  private applyHighlight(): void {
    if (!this.directionComponent) return;
    const highlightId = pickEdgeToward(this.latestEdges, this.destinationBearing);
    this.directionComponent.configure({ highlightId: highlightId ?? undefined });
  }
}
