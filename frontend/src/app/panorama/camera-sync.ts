import type { Camera } from 'three';
import { Matrix4 } from 'three';

/**
 * Point a three.js camera at the pose mapillary-js supplies.
 *
 * Assigning `camera.matrixWorld` directly does not survive a frame:
 * `WebGLRenderer.render` calls `camera.updateMatrixWorld()`, which — with
 * `matrixAutoUpdate` on — recomposes the matrix from position, quaternion and
 * scale and overwrites whatever was assigned. Decomposing into those three
 * properties is what makes the pose stick.
 */
export function syncCamera(camera: Camera, viewMatrix: number[], projectionMatrix: number[]): void {
  const world = new Matrix4().fromArray(viewMatrix).invert();
  world.decompose(camera.position, camera.quaternion, camera.scale);

  camera.projectionMatrix.fromArray(projectionMatrix);
  camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
}
