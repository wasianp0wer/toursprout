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

/**
 * The colour mapping is the path the feature exists for, and WebGL hides it
 * from every other test: FakeViewer substitutes the whole adapter. SimpleMarker
 * keeps its colours in private fields, which is the only place to read them.
 */
describe('MapillaryViewer marker colours', () => {
  const TOUR = { accent: '#111111', wayfinding: '#222222', destination: '#333333' };
  const NOCTURNE = { accent: '#e8b04b', wayfinding: '#2f7fd4', destination: '#5fd08a' };

  const stub = () => {
    const viewer = new MapillaryViewer();
    const painted: { _ballColor: string }[] = [];
    const component = {
      removeAll: () => undefined,
      add: (ms: { _ballColor: string }[]) => { painted.push(...ms); },
    };
    Object.assign(viewer, { markerComponent: component });
    const reattach = () => Object.assign(viewer, { markerComponent: component });
    const paint = () => {
      painted.length = 0;
      viewer.setMarkers([
        { id: 'sel', lng: 0, lat: 0, selected: true, kind: 'overlay' },
        { id: 'not', lng: 0, lat: 0, selected: false, kind: 'overlay' },
        { id: 'dest', lng: 0, lat: 0, selected: false, kind: 'destination' },
      ]);
      return painted.map((m) => m._ballColor);
    };
    return { viewer, paint, reattach };
  };

  it('paints selected, unselected and destination from accent, wayfinding, destination', () => {
    const { viewer, paint } = stub();
    viewer.setMarkerColours(TOUR);
    expect(paint()).toEqual(['#111111', '#222222', '#333333']);
  });

  it('keeps the Nocturne defaults when nothing was set', () => {
    expect(stub().paint()).toEqual(['#e8b04b', '#2f7fd4', '#5fd08a']);
  });

  // The viewer is one root-provided instance shared with the editor, so a
  // tour's colours must not outlive the pane that set them: /edit -> /view ->
  // /edit would otherwise paint the editor's markers in the tour's accent.
  // It is destroy(), not attach(), that resets: the colours effect runs
  // before the attaching one, so an attach-time reset would wipe them.
  it('goes back to the defaults when destroyed', () => {
    const { viewer, paint, reattach } = stub();
    viewer.setMarkerColours(TOUR);
    viewer.destroy();
    reattach(); // destroy() drops the component, as attach() would restore it
    expect(paint()).toEqual(['#e8b04b', '#2f7fd4', '#5fd08a']);
  });
});
