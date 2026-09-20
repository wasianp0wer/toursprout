import { describe, expect, it } from 'vitest';
import { MAX_ARROW_DEVIATION_DEG, pickEdgeToward, type DirectionEdge } from './edge-picker';

const HALF_PI = Math.PI / 2;

function edge(targetId: string, azimuthRad: number, isGroundArrow = true): DirectionEdge {
  return { targetId, azimuthRad, isGroundArrow };
}

// mapillary azimuth is counter-clockwise from east:
//   0 = east (bearing 90), PI/2 = north (bearing 0), PI = west (bearing 270)
const EAST = edge('east', 0);
const NORTH = edge('north', HALF_PI);
const WEST = edge('west', Math.PI);
const SOUTH = edge('south', -HALF_PI);
const ALL = [EAST, NORTH, WEST, SOUTH];

describe('pickEdgeToward', () => {
  it('picks the north edge for a northward bearing', () => {
    expect(pickEdgeToward(ALL, 0)).toBe('north');
  });

  it('picks the east edge for an eastward bearing', () => {
    expect(pickEdgeToward(ALL, 90)).toBe('east');
  });

  it('picks the south edge for a southward bearing', () => {
    expect(pickEdgeToward(ALL, 180)).toBe('south');
  });

  it('picks the west edge for a westward bearing', () => {
    expect(pickEdgeToward(ALL, 270)).toBe('west');
  });

  it('wraps around north correctly', () => {
    expect(pickEdgeToward(ALL, 350)).toBe('north');
    expect(pickEdgeToward(ALL, 10)).toBe('north');
  });

  it('returns null when no bearing is known', () => {
    expect(pickEdgeToward(ALL, null)).toBeNull();
  });

  it('returns null when there are no edges', () => {
    expect(pickEdgeToward([], 90)).toBeNull();
  });

  it('ignores edges that are not ground arrows', () => {
    const edges = [edge('pano', HALF_PI, false), edge('walk', Math.PI)];
    expect(pickEdgeToward(edges, 0)).toBeNull();
  });

  it('returns null when every arrow points too far from the target', () => {
    expect(pickEdgeToward([SOUTH], 0)).toBeNull();
  });

  it('accepts a lone arrow just inside the deviation limit', () => {
    const offBy = MAX_ARROW_DEVIATION_DEG - 5;
    expect(pickEdgeToward([EAST], 90 - offBy)).toBe('east');
  });

  it('rejects a lone arrow just outside the deviation limit', () => {
    const offBy = MAX_ARROW_DEVIATION_DEG + 5;
    expect(pickEdgeToward([EAST], 90 - offBy)).toBeNull();
  });

  it('prefers a nearer arrow over one merely within the limit', () => {
    // Bearing 35 is 35 degrees off north and 55 off east: north should win.
    expect(pickEdgeToward(ALL, 35)).toBe('north');
  });

  it('picks the closest of two candidates on the same side', () => {
    const near = edge('near', HALF_PI - 0.1);
    const far = edge('far', HALF_PI - 0.6);
    expect(pickEdgeToward([far, near], 0)).toBe('near');
  });
});
