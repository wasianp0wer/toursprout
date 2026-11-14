import {
  AfterViewInit,
  Component,
  DestroyRef,
  ElementRef,
  computed,
  effect,
  inject,
  input,
  viewChild,
} from '@angular/core';
import { DivIcon, Map as LeafletMap, Marker, Polyline, TileLayer } from 'leaflet';
import { ConfigStore } from '../core/config-store';
import { resolveTheme, type ResolvedTheme } from '../core/theme';
import { TourStore } from '../core/tour-store';
import { routeGeoJson } from './route';

/** A numbered pin's markup; the current stop takes the accent, the rest wayfinding. */
export function pinHtml(order: number, current: boolean, theme: ResolvedTheme): string {
  const background = current ? theme.accent : theme.wayfinding;
  const colour = current ? theme.onAccent : theme.onWayfinding;
  return `<span style="background:${background};color:${colour}">${order}</span>`;
}

/** Inline colours, because Leaflet's SVG and DOM icons cannot read CSS custom properties from here. */
export function routeStyle(theme: ResolvedTheme): { color: string; weight: number; opacity: number } {
  return { color: theme.accent, weight: 4, opacity: 0.85 };
}

/**
 * The tour minimap.
 *
 * Leaflet rather than a WebGL engine: the basemap is raster OSM tiles and the
 * only overlays are a polyline and six pins, so vector tiles, GPU styling and
 * a worker pipeline would all go unused. Leaflet draws the line as SVG and the
 * pins as DOM, with no worker involved.
 */
@Component({
  selector: 'app-map-pane',
  template: `<div class="minimap" #container></div>`,
  styleUrl: './map-pane.css',
})
export class MapPane implements AfterViewInit {
  private readonly store = inject(TourStore);
  private readonly config = inject(ConfigStore);
  private readonly container = viewChild.required<ElementRef<HTMLElement>>('container');

  /** The resolved tour theme; without one the map is Nocturne, as it always was. */
  readonly theme = input<ResolvedTheme | null>(null);
  private readonly colours = computed(() => this.theme() ?? resolveTheme(null));

  private map: LeafletMap | null = null;
  private route: Polyline | null = null;
  private markers = new Map<string, Marker>();

  constructor() {
    inject(DestroyRef).onDestroy(() => this.map?.remove());

    effect(() => {
      // A late or changed theme repaints the route and pins already on the map.
      this.colours();
      const stop = this.store.currentStop();
      if (!this.map || !stop) return;
      this.map.setView([stop.location.lat, stop.location.lng], 17);
      this.paintRoute();
    });
  }

  ngAfterViewInit(): void {
    this.map = new LeafletMap(this.container().nativeElement, {
      center: [38.8456, -77.3065],
      zoom: 16,
      zoomControl: true,
      attributionControl: true,
    });

    new TileLayer(this.config.tileUrl(), {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap contributors',
    }).addTo(this.map);

    this.paintRoute();
    this.centreOnCurrentStop();
  }

  /**
   * The effect that follows the tour cannot run before the map exists, so the
   * opening stop has to be centred once the map is up.
   */
  private centreOnCurrentStop(): void {
    const stop = this.store.currentStop();
    if (this.map && stop) this.map.setView([stop.location.lat, stop.location.lng], 17);
  }

  private paintRoute(): void {
    const map = this.map;
    if (!map) return;

    const features = routeGeoJson(this.store.stops()).features;
    const currentId = this.store.currentStop()?.id;

    const line = features.find((f) => f.geometry.type === 'LineString');
    if (line) {
      // GeoJSON is lng/lat; Leaflet wants lat/lng.
      const path = (line.geometry as GeoJSON.LineString).coordinates.map(
        ([lng, lat]) => [lat, lng] as [number, number],
      );
      if (this.route) {
        this.route.setLatLngs(path);
        this.route.setStyle(routeStyle(this.colours()));
      } else {
        this.route = new Polyline(path, routeStyle(this.colours())).addTo(map);
      }
    }

    for (const feature of features) {
      if (feature.geometry.type !== 'Point') continue;
      const [lng, lat] = (feature.geometry as GeoJSON.Point).coordinates;
      const id = feature.properties?.['id'] as string;
      const order = feature.properties?.['order'] as number;
      const title = feature.properties?.['title'] as string;
      const current = id === currentId;

      const existing = this.markers.get(id);
      if (existing) {
        existing.setLatLng([lat, lng]);
        existing.setIcon(this.pin(order, current));
        existing.setZIndexOffset(this.stacking(order, current));
        continue;
      }

      const marker = new Marker([lat, lng], {
        icon: this.pin(order, current),
        title,
        keyboard: true,
        alt: `Stop ${order}: ${title}`,
        // Stops can stand metres apart — the monument is 14.6 m from the
        // courthouse — so later pins must draw above earlier ones rather than
        // disappearing beneath them.
        zIndexOffset: this.stacking(order, current),
        riseOnHover: true,
      }).addTo(map);

      marker.on('click', () => {
        const index = this.store.stops().findIndex((s) => s.id === id);
        if (index >= 0) this.store.goTo(index);
      });

      this.markers.set(id, marker);
    }
  }

  /**
   * Stops can stand metres apart — the monument is 14.6 m from the courthouse —
   * so pins overlap. The stop the tour is on always draws on top; the rest
   * stack in walking order.
   */
  private stacking(order: number, current: boolean): number {
    return current ? 1000 : order * 10;
  }

  /** A numbered pin, highlighted when it is the stop the tour is on. */
  private pin(order: number, current: boolean): DivIcon {
    return new DivIcon({
      className: 'stop-pin',
      html: pinHtml(order, current, this.colours()),
      iconSize: [26, 26],
      iconAnchor: [13, 13],
    });
  }
}
