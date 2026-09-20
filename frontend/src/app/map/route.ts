import type { Feature, FeatureCollection } from 'geojson';
import type { Stop } from '../core/tour.models';

/** Builds the route line and stop markers. Pure, so it can be tested without WebGL. */
export function routeGeoJson(stops: Stop[]): FeatureCollection {
  const ordered = [...stops].sort((a, b) => a.order - b.order);
  const features: Feature[] = ordered.map((s) => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [s.location.lng, s.location.lat] },
    properties: { id: s.id, order: s.order, title: s.title },
  }));

  if (ordered.length > 1) {
    features.unshift({
      type: 'Feature',
      geometry: {
        type: 'LineString',
        coordinates: ordered.map((s) => [s.location.lng, s.location.lat]),
      },
      properties: {},
    });
  }

  return { type: 'FeatureCollection', features };
}
