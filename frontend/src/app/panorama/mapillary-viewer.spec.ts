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

/**
 * The one branch in `load`: a flat image's x axis spans the camera's field of
 * view, not the circle, so turning it over-rotates by a factor of four or
 * five. The arithmetic itself lives in view-turn.ts and is tested there; this
 * pins that the adapter asks, and obeys the answer.
 */
describe('MapillaryViewer turning the view', () => {
  const stub = (cameraType: string | undefined) => {
    const viewer = new MapillaryViewer();
    const centers: [number, number][] = [];
    Object.assign(viewer, {
      viewer: {
        moveTo: async () => ({ id: 'img-1', cameraType, compassAngle: 12 }),
        getBearing: async () => 100,
        getCenter: async () => [0.5, 0.4],
        setCenter: (c: [number, number]) => { centers.push(c); },
      },
    });
    return { viewer, centers };
  };

  it('turns a spherical image to the stored bearing', async () => {
    const { viewer, centers } = stub('spherical');
    await viewer.load('img-1', 190);
    expect(centers).toEqual([[0.75, 0.4]]);
  });

  it('does NOT turn a perspective image', async () => {
    const { viewer, centers } = stub('perspective');
    await viewer.load('img-1', 190);
    expect(centers).toEqual([]);
  });

  it('does NOT turn a fisheye image', async () => {
    const { viewer, centers } = stub('fisheye');
    await viewer.load('img-1', 190);
    expect(centers).toEqual([]);
  });

  it('turns when the camera type is undefined, as it does today', async () => {
    const { viewer, centers } = stub(undefined);
    await viewer.load('img-1', 190);
    expect(centers).toEqual([[0.75, 0.4]]);
  });
});
