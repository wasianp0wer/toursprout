import {
  type DirectionComponent,
  type MarkerComponent,
  NavigationDirection,
  SimpleMarker,
  Viewer,
} from 'mapillary-js';
import { pickEdgeToward, type DirectionEdge } from './edge-picker';
import { centerForBearing } from './view-turn';
import type { ImageryReport, OverlayMarker, PanoramaViewer } from './panorama-viewer';
import type { InWorldPlacement } from './in-world-placement';
import { diagnosticsEnabled } from './diagnostics';
import { InWorldRenderer } from './in-world-renderer';

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
  private inWorldRenderer: InWorldRenderer | null = null;

  private destinationBearing: number | null = null;
  private latestEdges: DirectionEdge[] = [];
  private markerHandler: ((id: string) => void) | null = null;
  private positionHandler:
    | ((position: { lng: number; lat: number }, imageId: string) => void)
    | null = null;
  private reportHandler: ((report: ImageryReport) => void) | null = null;

  attach(container: HTMLElement, accessToken: string): void {
    this.viewer = new Viewer({
      accessToken,
      container,
      component: { cover: false, marker: true, bearing: true, zoom: true, direction: true },
    });
    this.markerComponent = this.viewer.getComponent('marker') as MarkerComponent;
    this.directionComponent = this.viewer.getComponent('direction') as DirectionComponent;

    this.inWorldRenderer = new InWorldRenderer(
      typeof location === 'undefined' ? false : diagnosticsEnabled(location.search),
    );
    this.viewer.addCustomRenderer(this.inWorldRenderer);

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

    // Walking the street: every move reports where the viewer now stands, and
    // what kind of image it is. Both come off the same event because both are
    // facts about the image actually loaded, keyed by its id; firing them here
    // rather than in `load` also covers the author walking the street with the
    // ground arrows, which moves the image without going through `load`.
    this.viewer.on('image', (event) => {
      const image = event.image;
      const lngLat = image.computedLngLat ?? image.lngLat;
      this.positionHandler?.({ lng: lngLat.lng, lat: lngLat.lat }, image.id);
      this.reportHandler?.(reportFor(image));
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
    // moveTo resolves to the Image, which is the only thing that knows the
    // projection — and whether the view may be turned at all depends on it.
    const image = await this.viewer.moveTo(imageId);
    await this.faceBearing(bearing, cameraTypeOf(image));
  }

  /**
   * Turn the view to a compass bearing, where the imagery allows it.
   *
   * The decision and the arithmetic are in view-turn.ts, which explains why a
   * flat image must not be turned and is unit-tested without a WebGL context.
   * A null answer means leave the view exactly where mapillary-js opened it.
   */
  private async faceBearing(target: number, cameraType: string | undefined): Promise<void> {
    if (!this.viewer) return;
    try {
      const [current, center] = await Promise.all([
        this.viewer.getBearing(),
        this.viewer.getCenter(),
      ]);
      const next = centerForBearing(cameraType, current, center as [number, number], target);
      if (next) this.viewer.setCenter(next);
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

  setInWorldPlacements(placements: InWorldPlacement[]): void {
    this.inWorldRenderer?.setPlacements(placements);
    this.requestRedraw();
  }

  setInWorldOpacity(opacities: Record<string, number>): void {
    this.inWorldRenderer?.setOpacity(opacities);
    this.requestRedraw();
  }

  /**
   * Ask the viewer to draw another frame.
   *
   * mapillary-js renders on demand, and custom renderers are only invoked
   * during its own redraws. Without this, changing an in-world placement or
   * moving the opacity slider has no visible effect until the user happens to
   * drag the panorama.
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

  onImageryReport(handler: (report: ImageryReport) => void): void {
    this.reportHandler = handler;
  }

  destroy(): void {
    if (this.viewer && this.inWorldRenderer) {
      this.viewer.removeCustomRenderer(this.inWorldRenderer.id);
    }
    this.inWorldRenderer = null;
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

/**
 * `Image.cameraType` is typed `string` but documented as undefined when SfM
 * has not been run, so it is read as possibly-undefined at this one boundary
 * rather than trusted. Everything downstream treats unknown as spherical.
 */
function cameraTypeOf(image: { cameraType?: string }): string | undefined {
  return image.cameraType ?? undefined;
}

/** `Image` to ImageryReport. compassAngle is passed through raw, -1 included. */
function reportFor(image: { id: string; cameraType?: string; compassAngle?: number }): ImageryReport {
  return {
    imageId: image.id,
    cameraType: cameraTypeOf(image),
    compassAngle: typeof image.compassAngle === 'number' ? image.compassAngle : null,
  };
}
