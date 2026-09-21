import { describe, expect, it } from 'vitest';
import { Matrix4, PerspectiveCamera } from 'three';
import { syncCamera } from './camera-sync';

/** A view matrix for a camera sitting 5 m east, 3 m north, 2 m up. */
function viewMatrixAt(x: number, y: number, z: number): number[] {
  const world = new Matrix4().makeTranslation(x, y, z);
  return world.clone().invert().toArray();
}

describe('syncCamera', () => {
  it('places the camera where the view matrix says it is', () => {
    const camera = new PerspectiveCamera();
    syncCamera(camera, viewMatrixAt(5, 3, 2), new Matrix4().toArray());

    // three.js recomputes matrixWorld from position/quaternion on every render;
    // this reproduces that step, which is what discarded the old assignment.
    camera.updateMatrixWorld(true);

    expect(camera.matrixWorld.elements[12]).toBeCloseTo(5, 6);
    expect(camera.matrixWorld.elements[13]).toBeCloseTo(3, 6);
    expect(camera.matrixWorld.elements[14]).toBeCloseTo(2, 6);
  });

  it('survives three.js recomputing the world matrix', () => {
    const camera = new PerspectiveCamera();
    const view = viewMatrixAt(10, -4, 1);
    syncCamera(camera, view, new Matrix4().toArray());

    camera.updateMatrixWorld(true);
    const after = camera.matrixWorld.clone();

    // Render again: nothing should drift back toward the origin.
    camera.updateMatrixWorld(true);
    expect(camera.matrixWorld.elements).toEqual(after.elements);
    expect(camera.matrixWorld.elements[12]).toBeCloseTo(10, 6);
  });

  it('applies the projection matrix it is given', () => {
    const camera = new PerspectiveCamera();
    const projection = new Matrix4().makePerspective(-1, 1, 1, -1, 0.1, 100).toArray();
    syncCamera(camera, viewMatrixAt(0, 0, 0), projection);
    expect(camera.projectionMatrix.toArray()).toEqual(projection);
  });

  it('keeps the projection inverse consistent with the projection', () => {
    const camera = new PerspectiveCamera();
    const projection = new Matrix4().makePerspective(-1, 1, 1, -1, 0.1, 100).toArray();
    syncCamera(camera, viewMatrixAt(0, 0, 0), projection);

    const roundTrip = camera.projectionMatrix
      .clone()
      .multiply(camera.projectionMatrixInverse)
      .toArray();
    const identity = new Matrix4().toArray();
    roundTrip.forEach((v, i) => expect(v).toBeCloseTo(identity[i], 6));
  });

  it('preserves camera orientation, not just position', () => {
    const camera = new PerspectiveCamera();
    // A camera rotated a quarter turn about the up axis.
    const world = new Matrix4().makeRotationZ(Math.PI / 2).setPosition(1, 2, 3);
    syncCamera(camera, world.clone().invert().toArray(), new Matrix4().toArray());
    camera.updateMatrixWorld(true);

    world.toArray().forEach((v, i) => {
      expect(camera.matrixWorld.elements[i]).toBeCloseTo(v, 6);
    });
  });
});
