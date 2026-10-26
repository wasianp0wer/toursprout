import { describe, expect, it, vi } from 'vitest';
import type { Mesh } from 'three';
import { InWorldRenderer } from './in-world-renderer';
import type { InWorldPlacement } from './in-world-placement';

/**
 * No WebGL in jsdom, so the renderer is driven without onAdd: the reference
 * is set directly and TextureLoader.load is replaced with a counter. What is
 * under test is the scene-graph bookkeeping, which is where the editor's
 * per-keystroke setPlacements calls used to dispose and refetch everything.
 */
interface Internals {
  reference: { lng: number; lat: number; alt: number } | null;
  loader: { load: unknown };
  meshes: Map<string, Mesh>;
}

const place = (over: Partial<InWorldPlacement> = {}): InWorldPlacement => ({
  id: 'a', imageUrl: '/media/a.jpg',
  lng: -77.3065, lat: 38.8456, altitudeM: 2,
  headingDeg: 40, widthM: 6, heightM: 3,
  ...over,
});

function rig() {
  const renderer = new InWorldRenderer();
  const internals = renderer as unknown as Internals;
  internals.reference = { lng: -77.3065, lat: 38.8456, alt: 0 };
  const load = vi.fn();
  internals.loader.load = load;
  return { renderer, internals, load };
}

describe('InWorldRenderer.setPlacements', () => {
  it('builds a mesh and requests a texture per placement', () => {
    const { renderer, internals, load } = rig();
    renderer.setPlacements([place(), place({ id: 'b', imageUrl: '/media/b.jpg' })]);
    expect(internals.meshes.size).toBe(2);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('updates in place, without a rebuild, when only transforms change', () => {
    const { renderer, internals, load } = rig();
    renderer.setPlacements([place()]);
    const mesh = internals.meshes.get('a')!;
    const material = mesh.material;
    const x = mesh.position.x;

    renderer.setPlacements([place({ lng: -77.3064, headingDeg: 90 })]);

    expect(load).toHaveBeenCalledTimes(1); // no texture refetch
    expect(internals.meshes.get('a')).toBe(mesh); // same mesh object
    expect(mesh.material).toBe(material); // the textured material is kept
    expect(mesh.position.x).not.toBe(x); // but it did move
  });

  it('resizes the plane in place when width or height change', () => {
    const { renderer, internals, load } = rig();
    renderer.setPlacements([place()]);
    const mesh = internals.meshes.get('a')!;
    renderer.setPlacements([place({ widthM: 9 })]);
    expect(internals.meshes.get('a')).toBe(mesh);
    expect(load).toHaveBeenCalledTimes(1);
    expect((mesh.geometry as unknown as { parameters: { width: number } }).parameters.width).toBe(9);
  });

  it('rebuilds when an image URL changes', () => {
    const { renderer, internals, load } = rig();
    renderer.setPlacements([place()]);
    const mesh = internals.meshes.get('a')!;
    renderer.setPlacements([place({ imageUrl: '/media/other.jpg' })]);
    expect(load).toHaveBeenCalledTimes(2);
    expect(internals.meshes.get('a')).not.toBe(mesh);
  });

  it('rebuilds when the set of ids changes', () => {
    const { renderer, internals, load } = rig();
    renderer.setPlacements([place()]);
    renderer.setPlacements([place(), place({ id: 'b', imageUrl: '/media/b.jpg' })]);
    expect(load).toHaveBeenCalledTimes(3); // a again, plus b
    expect(internals.meshes.size).toBe(2);
    renderer.setPlacements([]);
    expect(internals.meshes.size).toBe(0);
  });
});
