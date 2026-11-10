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

/**
 * Controls under `root` that the editor stylesheet cannot put below their
 * label text. styles.css sets each label to a column with the control
 * inside it, so a control outside any label, or one whose label has no text
 * before it, renders unlabelled or side by side with its neighbour. Hidden
 * file inputs are opened by a button and have no label of their own.
 * Returns a description of each offender, so a failure names it.
 */
export function controlsWithoutLabelAbove(root: HTMLElement): string[] {
  const describe = (c: Element) =>
    c.outerHTML.slice(0, c.outerHTML.indexOf('>') + 1);
  return Array.from(root.querySelectorAll('input, select, textarea'))
    .filter((c) => !(c instanceof HTMLInputElement && (c.type === 'file' || c.type === 'hidden')))
    .filter((c) => {
      const label = c.closest('label');
      if (!label) return true;
      // The label's text up to the control: what reads above it.
      const range = document.createRange();
      range.setStart(label, 0);
      range.setEndBefore(c);
      return range.toString().trim() === '';
    })
    .map(describe);
}
