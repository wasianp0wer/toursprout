import {
  Component, DestroyRef, ElementRef, effect, inject, untracked, viewChild,
} from '@angular/core';
import {
  DivIcon, LayerGroup, Map as LeafletMap, Marker, Polygon, Polyline, TileLayer, type LeafletEvent,
} from 'leaflet';
import { ConfigStore } from '../core/config-store';
import { EditorStore } from './editor-store';
import {
  panoramaFixForStop, setOverlayAnchorKeepingHeading, setOverlayHeadingManual, setStopLocation,
} from './document-ops';
import { footprintCorners, headingFromHandle, rotationHandleAt, viewWedge, wedgeFor } from './footprint';
import type { Overlay } from '../core/tour.models';

/** How far in front of the face the rotation handle sits, and the wedge's reach. */
const HANDLE_OFFSET_M = 6;
const WEDGE_RADIUS_M = 25;

/**
 * The editable map: where a top-down view can show position and heading,
 * and every overlay in the stop at once.
 *
 * Thin on purpose. All geometry lives in footprint.ts and all document
 * changes in document-ops.ts; this component only places Leaflet layers and
 * forwards drag results to the store. Container lifecycle follows the
 * viewer's map-pane.ts.
 *
 * The panorama position and rotation handle are drawn only from
 * panoramaFixForStop, the project's single gate: stop.location is the
 * building, not the camera, and is never used as the camera or as a bearing
 * reference.
 *
 * The view wedge follows the same discipline one step further: it comes from
 * wedgeFor over the VIEWER's report of the image it loaded, not from
 * stop.panorama.bearing, because on flat imagery that stored number is a fact
 * about the camera and may stand for "unknown". Until the panorama has
 * loaded there is no wedge.
 */
@Component({
  selector: 'app-edit-map-pane',
  template: `
    @if (store.currentStop(); as stop) {
      <div class="edit-map" #container></div>
      @if (store.selectedOverlay()?.display?.mode === 'inWorld' && !fixed()) {
        <p class="handle-note" data-handle-unavailable>
          The rotation handle needs this stop's panorama position, which is not known yet.
        </p>
      }
    } @else {
      <p class="empty" data-map-empty>Select a stop or overlay to see it on the map.</p>
    }
  `,
  styleUrl: './edit-map-pane.css',
})
export class EditMapPane {
  protected readonly store = inject(EditorStore);
  private readonly config = inject(ConfigStore);
  private readonly container = viewChild<ElementRef<HTMLElement>>('container');

  private map: LeafletMap | null = null;
  private tiles: TileLayer | null = null;
  private readonly layers = new LayerGroup();
  private mountedStopId: string | null = null;
  /** The current stop's location as last painted, so an edit to it can be told from any other repaint. */
  private paintedLocation: { lng: number; lat: number } | null = null;

  protected fixed = () => panoramaFixForStop(this.store.currentStop(), this.store.panoramaPosition());

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      this.map?.remove();
      this.map = null;
    });

    // The container only exists while a stop is current, so (re)build the map
    // when it appears and drop it when it goes.
    effect(() => {
      const host = this.container()?.nativeElement ?? null;
      const stop = this.store.currentStop();
      if (this.map && this.map.getContainer() !== host) this.teardown();
      if (host && stop && !this.map) this.mount(host);
      if (this.map && stop) this.paint();
    });
  }

  private mount(host: HTMLElement): void {
    const map = new LeafletMap(host, { center: [38.8456, -77.3065], zoom: 19, maxZoom: 21 });
    const url = this.config.tileUrl();
    if (url) {
      this.tiles = new TileLayer(url, { maxZoom: 21, maxNativeZoom: 19, attribution: '&copy; OpenStreetMap contributors' })
        .addTo(map);
    }
    this.layers.addTo(map);
    // A new stop starts where the author is looking, so the store has to know.
    map.on('moveend', () => this.publishCenter());
    this.map = map;
    this.mountedStopId = null;
  }

  private teardown(): void {
    this.layers.clearLayers();
    this.tiles = null;
    this.map?.remove();
    this.map = null;
  }

  private paint(): void {
    const map = this.map;
    const stop = untracked(() => this.store.currentStop());
    if (!map || !stop) return;
    this.layers.clearLayers();

    const selected = this.store.selectedOverlay();
    const fix = this.fixed();

    if (fix) {
      this.tag(new Marker([fix.lat, fix.lng], {
        icon: new DivIcon({ className: 'pano-dot', iconSize: [14, 14], iconAnchor: [7, 7] }),
        interactive: false, keyboard: false,
      }).addTo(this.layers), 'data-panorama-position');
      // The dot says where the camera stood; the wedge says which way it
      // looked, and wedgeFor may well say it is not known. A dot with no
      // wedge is the correct picture for a flat image with no compass angle.
      const wedge = wedgeFor(stop.panorama, this.store.imageryReport());
      if (wedge) {
        this.tag(new Polygon(
          viewWedge(fix, wedge.bearingDeg, wedge.fovDeg, WEDGE_RADIUS_M)
            .map((p) => [p.lat, p.lng] as [number, number]),
          { className: 'view-wedge', interactive: false },
        ).addTo(this.layers), 'data-view-wedge');
      }
    }

    this.stopLocationMarker(stop.id, stop.location);

    for (const o of stop.overlays) this.overlayMarker(o, o.id === selected?.id);

    if (selected && selected.display.mode === 'inWorld') {
      const { headingDeg, widthM } = selected.display;
      const [a, b] = footprintCorners(selected.anchor, headingDeg, widthM);
      this.tag(new Polyline([[a.lat, a.lng], [b.lat, b.lng]], {
        className: 'footprint', interactive: false,
      }).addTo(this.layers), 'data-footprint');
      if (fix) this.rotationHandle(selected);
    }

    // Re-centre only when the stop changes, not after every edit, or the map
    // would snap back under the author's hand mid-drag. The one edit that
    // moves the view is to the stop's own location: typed lat/lng, or a
    // searched address, should be shown. Dragging the ring changes it too,
    // but records the drop as painted first, so that edit does not pan.
    const loc = stop.location;
    const moved = this.paintedLocation !== null
      && (this.paintedLocation.lng !== loc.lng || this.paintedLocation.lat !== loc.lat);
    this.paintedLocation = { lng: loc.lng, lat: loc.lat };
    if (this.mountedStopId !== stop.id) {
      this.mountedStopId = stop.id;
      // A stop already in view keeps the view. A just-added stop sits at the
      // map centre but carries the previous stop's panorama, so its fix is
      // the old camera: jumping there would also make it the next new
      // stop's starting point.
      if (map.getBounds().contains([loc.lat, loc.lng])) {
        const c = map.getCenter();
        this.store.setMapCenter({ lng: c.lng, lat: c.lat });
        return;
      }
      const focus = fix ?? selected?.anchor ?? stop.overlays[0]?.anchor ?? stop.location;
      map.setView([focus.lat, focus.lng], 19);
      // An animated setView reports moveend only once it lands; until then
      // a new stop would start at the previous stop's place.
      this.store.setMapCenter({ lng: focus.lng, lat: focus.lat });
    } else if (moved) {
      map.panTo([loc.lat, loc.lng]);
    }
  }

  private publishCenter(): void {
    const c = this.map?.getCenter();
    if (c) this.store.setMapCenter({ lng: c.lng, lat: c.lat });
  }

  /**
   * The building, drawn so typing its lat/lng shows somewhere, and dragged to
   * move the stop. Only a marker: it is never the camera and never a bearing
   * reference, and dragging it moves the stop alone; overlays stay put.
   */
  private stopLocationMarker(stopId: string, at: { lng: number; lat: number }): void {
    const ring = new Marker([at.lat, at.lng], {
      // Wider than an overlay's 22px marker, and drawn under it, so an overlay
      // anchored on the building (the default) leaves the ring's rim to grab.
      icon: new DivIcon({ className: 'stop-location', iconSize: [32, 32], iconAnchor: [16, 16] }),
      draggable: true, keyboard: true, title: 'Drag to move this stop', alt: 'Drag to move this stop',
      zIndexOffset: -1000,
    }).addTo(this.layers);
    this.tag(ring, 'data-stop-location');
    ring.on('dragend', (e: LeafletEvent) => {
      // Wrapped: panned across the antimeridian the drop can read past ±180,
      // which setStopLocation refuses, leaving the ring where it was dropped.
      const { lat, lng } = (e.target as Marker).getLatLng().wrap();
      // The ring is already under the author's hand: mark the drop as painted
      // before the edit repaints, or paint() would pan to it.
      this.paintedLocation = { lng, lat };
      // A dragged point is no longer the looked-up building, as with typed lat/lng.
      this.store.apply((t) => setStopLocation(t, stopId, lng, lat, null));
    });
  }

  private overlayMarker(o: Overlay, selected: boolean): void {
    const marker = new Marker([o.anchor.lat, o.anchor.lng], {
      icon: new DivIcon({
        className: 'edit-marker' + (selected ? ' selected' : ''),
        html: `<span></span>`, iconSize: [22, 22], iconAnchor: [11, 11],
      }),
      draggable: true, keyboard: true, title: o.title, alt: o.title,
      zIndexOffset: selected ? 1000 : 0,
    }).addTo(this.layers);
    this.tag(marker, 'data-overlay-marker', o.id);
    // Select on click and on dragend, never dragstart: changing the selection
    // repaints (clearLayers), which would remove the marker mid-drag.
    marker.on('click', () => this.store.select(o.id));
    marker.on('dragend', (e: LeafletEvent) => {
      const { lat, lng } = (e.target as Marker).getLatLng();
      this.store.apply((t) => setOverlayAnchorKeepingHeading(
        t, o.id, { lng, lat }, this.fixed(), this.store.manualHeadings()));
      this.store.select(o.id);
    });
  }

  private rotationHandle(o: Overlay): void {
    if (o.display.mode !== 'inWorld') return;
    const at = rotationHandleAt(o.anchor, o.display.headingDeg, HANDLE_OFFSET_M);
    const handle = new Marker([at.lat, at.lng], {
      icon: new DivIcon({ className: 'rotation-handle', html: '<span></span>', iconSize: [18, 18], iconAnchor: [9, 9] }),
      draggable: true, keyboard: false, title: 'Drag to set heading', zIndexOffset: 1100,
    }).addTo(this.layers);
    this.tag(handle, 'data-rotation-handle');
    handle.on('dragend', (e: LeafletEvent) => {
      const drop = (e.target as Marker).getLatLng();
      const heading = headingFromHandle(o.anchor, { lng: drop.lng, lat: drop.lat });
      const before = this.store.draft();
      // Same gate as derivation: refused without THIS stop's panorama fix.
      this.store.apply((t) => setOverlayHeadingManual(t, o.id, heading, this.fixed()));
      if (this.store.draft() !== before) this.store.markHeadingManual(o.id, true);
    });
  }

  /** Put a data attribute on a layer's DOM element, so the rendered map is inspectable. */
  private tag(layer: Marker | Polyline | Polygon, attr: string, value = ''): void {
    const el = layer instanceof Marker ? layer.getElement() : layer.getElement?.();
    el?.setAttribute(attr, value);
  }
}
