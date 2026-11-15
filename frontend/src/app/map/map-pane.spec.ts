import { describe, expect, it } from 'vitest';
import { routeGeoJson } from './route';
import { pinHtml, routeStyle } from './map-pane';
import { resolveTheme } from '../core/theme';
import type { LineString } from 'geojson';
import type { Stop } from '../core/tour.models';

function stop(order: number, lng: number, lat: number): Stop {
  return {
    id: `s${order}`, order, title: `Stop ${order}`, summary: '',
    location: { lng, lat }, osmRef: null,
    panorama: { provider: 'mapillary', imageId: 'i', bearing: 0, cachedMediaId: null },
    overlays: [],
  };
}

describe('routeGeoJson', () => {
  it('returns an empty collection for no stops', () => {
    expect(routeGeoJson([]).features).toEqual([]);
  });

  it('produces no line for a single stop', () => {
    const fc = routeGeoJson([stop(1, -77.3, 38.84)]);
    expect(fc.features.filter((f) => f.geometry.type === 'LineString')).toHaveLength(0);
  });

  it('still emits the point for a single stop', () => {
    const fc = routeGeoJson([stop(1, -77.3, 38.84)]);
    expect(fc.features).toHaveLength(1);
  });

  it('connects stops in walking order', () => {
    const fc = routeGeoJson([stop(2, -77.2, 38.85), stop(1, -77.3, 38.84)]);
    const line = fc.features.find((f) => f.geometry.type === 'LineString');
    expect((line!.geometry as LineString).coordinates).toEqual([
      [-77.3, 38.84],
      [-77.2, 38.85],
    ]);
  });

  it('emits a point per stop carrying its id and order', () => {
    const fc = routeGeoJson([stop(1, -77.3, 38.84), stop(2, -77.2, 38.85)]);
    const points = fc.features.filter((f) => f.geometry.type === 'Point');
    expect(points).toHaveLength(2);
    expect(points[0].properties).toMatchObject({ id: 's1', order: 1 });
  });

  it('does not mutate the input array', () => {
    const stops = [stop(2, -77.2, 38.85), stop(1, -77.3, 38.84)];
    routeGeoJson(stops);
    expect(stops.map((s) => s.order)).toEqual([2, 1]);
  });
});

describe('the map pane colours', () => {
  const archival = resolveTheme({
    preset: 'archival', typePairing: 'georgia', typeScale: 'comfortable',
    layout: 'widePanel', overrides: {},
  });

  it('builds the current pin from the accent and the others from wayfinding', () => {
    expect(pinHtml(1, true, archival)).toContain('background:#9c5a24');
    expect(pinHtml(1, true, archival)).toContain(`color:${archival.onAccent}`);
    expect(pinHtml(2, false, archival)).toContain('background:#4a6274');
    expect(pinHtml(2, false, archival)).toContain(`color:${archival.onWayfinding}`);
  });

  it('draws the route in the accent', () => {
    expect(routeStyle(archival).color).toBe('#9c5a24');
  });

  it('falls back to the Nocturne values when no theme is set', () => {
    const nocturne = resolveTheme(null);
    expect(pinHtml(1, true, nocturne)).toContain('background:#e8b04b');
    expect(pinHtml(2, false, nocturne)).toContain('background:#2f7fd4');
    // Here the two label colours differ (derived vs pinned), so a swap shows.
    expect(pinHtml(1, true, nocturne)).toContain('color:#121212');
    expect(pinHtml(2, false, nocturne)).toContain('color:#ffffff');
    expect(routeStyle(nocturne).color).toBe('#e8b04b');
  });
});
