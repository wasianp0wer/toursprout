import { beforeEach, describe, expect, it } from 'vitest';
import { MapillaryViewer } from './mapillary-viewer';

/**
 * The adapter's one non-obvious duty: mapillary-js draws on demand, so every
 * change to custom content must be followed by triggerRerender() or nothing
 * visibly changes. attach() needs WebGL, which jsdom lacks, so the library
 * handles are stubbed in directly; FakeViewer models the same contract for
 * pane tests.
 */
describe('MapillaryViewer redraw contract', () => {
  let viewer: MapillaryViewer;
  let rerenders: number;

  beforeEach(() => {
    rerenders = 0;
    viewer = new MapillaryViewer();
    Object.assign(viewer, {
      viewer: { triggerRerender: () => { rerenders++; } },
      inWorldRenderer: { setPlacements: () => undefined, setOpacity: () => undefined },
    });
  });

  it('requests a redraw after every placement change', () => {
    viewer.setInWorldPlacements([]);
    viewer.setInWorldPlacements([]);
    expect(rerenders).toBe(2);
  });

  it('requests a redraw after every opacity change', () => {
    viewer.setInWorldOpacity({ a: 0.5 });
    expect(rerenders).toBe(1);
  });
});
