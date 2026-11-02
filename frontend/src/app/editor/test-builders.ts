/**
 * Shared fixtures for the editor's spec files. Both document-ops.spec.ts and
 * editor-store.spec.ts need the same minimal, valid tour/stop/overlay shapes;
 * this is the one place that defines them.
 */
import type { Overlay, Stop, Tour } from '../core/tour.models';

export function overlay(id: string, over: Partial<Overlay> = {}): Overlay {
  return {
    id, kind: 'text',
    anchor: { type: 'geo', lng: -77.3, lat: 38.84, altitudeM: 2 },
    display: { mode: 'marker', icon: 'note' },
    title: 'An overlay', body: 'Body', mediaId: null,
    credit: { type: 'original', creator: 'M', license: 'CC-BY-4.0' },
    ...over,
  };
}

export function stop(
  id: string, order: number, overlays: Overlay[] = [], over: Partial<Stop> = {},
): Stop {
  return {
    id, order, title: `Stop ${order}`, summary: 'summary',
    location: { lng: -77.3, lat: 38.84 }, osmRef: null,
    panorama: { provider: 'mapillary', imageId: `img-${order}`, bearing: 90, cachedMediaId: null },
    overlays,
    ...over,
  };
}

export function tour(stops: Stop[] = [stop('s1', 1)]): Tour {
  return {
    id: 't', schemaVersion: 3, title: 'T', description: '',
    defaults: { creator: 'M. Harrington', license: 'CC-BY-4.0' },
    attribution: [], stops,
  };
}
