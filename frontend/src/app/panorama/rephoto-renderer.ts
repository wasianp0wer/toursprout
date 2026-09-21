import {
  type ICustomRenderer,
  type IViewer,
  type LngLatAlt,
  RenderPass,
  geodeticToEnu,
} from 'mapillary-js';
import {
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  TextureLoader,
  WebGLRenderer,
} from 'three';
import { syncCamera } from './camera-sync';
import { planeTransform, type RephotoPlacement } from './rephoto-placement';

/**
 * Draws historical photographs as planes standing in the world.
 *
 * Tags cannot carry an image texture, so a custom renderer is the supported
 * route. The three.js version is whatever mapillary-js depends on (0.134),
 * deliberately not installed separately: two three.js copies sharing one WebGL
 * context fail in ways that are hard to diagnose.
 */
export class RephotoRenderer implements ICustomRenderer {
  readonly id = 'rephoto-renderer';
  readonly renderPass = RenderPass.Opaque;

  private renderer: WebGLRenderer | null = null;
  private readonly scene = new Scene();
  private readonly camera = new PerspectiveCamera();
  private readonly loader = new TextureLoader();
  private reference: LngLatAlt | null = null;
  private placements: RephotoPlacement[] = [];
  private readonly meshes = new Map<string, Mesh>();
  private opacity = 0;

  onAdd(_viewer: IViewer, reference: LngLatAlt, context: WebGLRenderingContext): void {
    this.reference = reference;
    this.renderer = new WebGLRenderer({
      canvas: context.canvas as HTMLCanvasElement,
      context,
    });
    this.renderer.autoClear = false;
    this.rebuild();
  }

  onReference(_viewer: IViewer, reference: LngLatAlt): void {
    this.reference = reference;
    this.rebuild();
  }

  onRemove(): void {
    this.disposeMeshes();
    this.renderer = null;
  }

  setRephotos(placements: RephotoPlacement[]): void {
    this.placements = placements;
    this.rebuild();
  }

  setOpacity(value: number): void {
    this.opacity = Math.min(1, Math.max(0, value));
    for (const mesh of this.meshes.values()) {
      const material = mesh.material as MeshBasicMaterial;
      material.opacity = this.opacity;
      mesh.visible = this.opacity > 0.01;
    }
  }

  render(_context: WebGLRenderingContext, viewMatrix: number[], projectionMatrix: number[]): void {
    if (!this.renderer || this.meshes.size === 0 || this.opacity <= 0.01) return;

    syncCamera(this.camera, viewMatrix, projectionMatrix);

    this.renderer.resetState();
    this.renderer.render(this.scene, this.camera);
  }

  private rebuild(): void {
    this.disposeMeshes();
    const reference = this.reference;
    if (!reference) return;

    for (const placement of this.placements) {
      const enu = geodeticToEnu(
        placement.lng, placement.lat, placement.altitude,
        reference.lng, reference.lat, reference.alt,
      ) as [number, number, number];

      const transform = planeTransform(placement, enu);
      const material = new MeshBasicMaterial({
        transparent: true,
        opacity: this.opacity,
        depthTest: false,
      });

      // A texture that fails to load leaves an untextured plane rather than
      // breaking the tour.
      this.loader.load(
        placement.imageUrl,
        (texture) => {
          material.map = texture;
          material.needsUpdate = true;
        },
        undefined,
        () => console.warn(`rephoto texture failed to load: ${placement.imageUrl}`),
      );

      const mesh = new Mesh(new PlaneGeometry(transform.width, transform.height), material);
      mesh.position.set(transform.position[0], transform.position[1], transform.position[2]);
      mesh.rotation.set(
        transform.rotation[0],
        transform.rotation[1],
        transform.rotation[2],
        transform.rotationOrder,
      );
      mesh.visible = this.opacity > 0.01;

      this.scene.add(mesh);
      this.meshes.set(placement.id, mesh);
    }
  }

  private disposeMeshes(): void {
    for (const mesh of this.meshes.values()) {
      this.scene.remove(mesh);
      mesh.geometry.dispose();
      const material = mesh.material as MeshBasicMaterial;
      material.map?.dispose();
      material.dispose();
    }
    this.meshes.clear();
  }
}
