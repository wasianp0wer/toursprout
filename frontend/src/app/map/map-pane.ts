import {
  AfterViewInit,
  Component,
  DestroyRef,
  ElementRef,
  effect,
  inject,
  viewChild,
} from '@angular/core';
import { type GeoJSONSource, Map as MlMap, type StyleSpecification } from 'maplibre-gl';
import { ConfigStore } from '../core/config-store';
import { TourStore } from '../core/tour-store';
import { routeGeoJson } from './route';

const ROUTE_SOURCE = 'route';

@Component({
  selector: 'app-map-pane',
  template: `<div class="minimap" #container></div>`,
  styleUrl: './map-pane.css',
})
export class MapPane implements AfterViewInit {
  private readonly store = inject(TourStore);
  private readonly config = inject(ConfigStore);
  private readonly container = viewChild.required<ElementRef<HTMLElement>>('container');
  private map: MlMap | null = null;

  constructor() {
    inject(DestroyRef).onDestroy(() => this.map?.remove());

    effect(() => {
      const stop = this.store.currentStop();
      if (!this.map || !stop) return;
      this.map.easeTo({ center: [stop.location.lng, stop.location.lat], zoom: 17 });
      this.paintRoute();
    });
  }

  ngAfterViewInit(): void {
    const style: StyleSpecification = {
      version: 8,
      sources: {
        osm: {
          type: 'raster',
          tiles: [this.config.tileUrl()],
          tileSize: 256,
          attribution: '(c) OpenStreetMap contributors',
        },
      },
      layers: [{ id: 'osm', type: 'raster', source: 'osm' }],
    };

    this.map = new MlMap({
      container: this.container().nativeElement,
      style,
      center: [-77.3065, 38.8456],
      zoom: 16,
      attributionControl: { compact: true },
    });

    this.map.on('load', () => this.paintRoute());
    this.map.on('click', 'stops', (e) => {
      const id = e.features?.[0]?.properties?.['id'] as string | undefined;
      if (!id) return;
      const index = this.store.stops().findIndex((s) => s.id === id);
      if (index >= 0) this.store.goTo(index);
    });
  }

  private paintRoute(): void {
    const map = this.map;
    if (!map || !map.isStyleLoaded()) return;

    const data = routeGeoJson(this.store.stops());
    const existing = map.getSource(ROUTE_SOURCE);
    if (existing) {
      (existing as GeoJSONSource).setData(data);
    } else {
      map.addSource(ROUTE_SOURCE, { type: 'geojson', data });
      map.addLayer({
        id: 'route-line',
        type: 'line',
        source: ROUTE_SOURCE,
        filter: ['==', ['geometry-type'], 'LineString'],
        paint: { 'line-color': '#e8b04b', 'line-width': 3, 'line-opacity': 0.8 },
      });
      map.addLayer({
        id: 'stops',
        type: 'circle',
        source: ROUTE_SOURCE,
        filter: ['==', ['geometry-type'], 'Point'],
        paint: {
          'circle-radius': 9,
          'circle-color': '#2f7fd4',
          'circle-stroke-color': '#fff',
          'circle-stroke-width': 2,
        },
      });
      map.addLayer({
        id: 'stop-labels',
        type: 'symbol',
        source: ROUTE_SOURCE,
        filter: ['==', ['geometry-type'], 'Point'],
        layout: { 'text-field': ['get', 'order'], 'text-size': 12 },
        paint: { 'text-color': '#fff' },
      });
    }

    const current = this.store.currentStop();
    if (current && map.getLayer('stops')) {
      map.setPaintProperty('stops', 'circle-color', [
        'case',
        ['==', ['get', 'id'], current.id],
        '#e8b04b',
        '#2f7fd4',
      ]);
    }
  }
}
