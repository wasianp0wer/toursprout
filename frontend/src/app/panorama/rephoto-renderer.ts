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
import { createDiagnostics, type Diagnostics } from './diagnostics';
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
  private readonly diag: Diagnostics;
  private frames = 0;

  constructor(diagnosticsOn = false) {
    this.diag = createDiagnostics(diagnosticsOn);
  }

  onAdd(_viewer: IViewer, reference: LngLatAlt, context: WebGLRenderingContext): void {
    this.reference = reference;
    const canvas = context.canvas as HTMLCanvasElement;
    this.renderer = new WebGLRenderer({ canvas, context });
    this.renderer.autoClear = false;
    // Match the context we are borrowing. Without this three.js applies its own
    // pixel ratio and viewport, and mapillary's own draws inherit them — which
    // shows up as the panorama going soft at the edges.
    this.renderer.setPixelRatio(1);
    this.diag.log('onAdd', {
      reference,
      canvas: { width: canvas.width, height: canvas.height },
      placements: this.placements.length,
      opacity: this.opacity,
    });
    this.rebuild();
  }

  onReference(_viewer: IViewer, reference: LngLatAlt): void {
    this.diag.log('onReference', reference);
    this.reference = reference;
    this.rebuild();
  }

  onRemove(): void {
    this.disposeMeshes();
    this.renderer = null;
  }

  setRephotos(placements: RephotoPlacement[]): void {
    this.diag.log('setRephotos', {
      count: placements.length,
      ids: placements.map((p) => p.id),
      haveReference: this.reference !== null,
    });
    this.placements = placements;
    this.rebuild();
  }

  setOpacity(value: number): void {
    this.diag.log('setOpacity', { value, meshes: this.meshes.size });
    this.opacity = Math.min(1, Math.max(0, value));
    for (const mesh of this.meshes.values()) {
      const material = mesh.material as MeshBasicMaterial;
      material.opacity = this.opacity;
      mesh.visible = this.opacity > 0.01;
    }
  }

  render(context: WebGLRenderingContext, viewMatrix: number[], projectionMatrix: number[]): void {
    this.frames += 1;
    if (!this.renderer || this.meshes.size === 0 || this.opacity <= 0.01) {
      this.diag.once('render skipped', {
        hasRenderer: !!this.renderer,
        meshes: this.meshes.size,
        opacity: this.opacity,
      });
      return;
    }

    syncCamera(this.camera, viewMatrix, projectionMatrix);

    if (this.frames % 120 === 1) {
      const first = [...this.meshes.values()][0];
      this.diag.log('render', {
        frame: this.frames,
        camera: this.camera.position.toArray().map((n) => Math.round(n * 100) / 100),
        firstMesh: first?.position.toArray().map((n) => Math.round(n * 100) / 100),
        distance: first ? Math.round(this.camera.position.distanceTo(first.position)) : null,
        opacity: this.opacity,
        visible: first?.visible,
        hasTexture: !!(first?.material as MeshBasicMaterial | undefined)?.map,
      });
    }

    // Save and restore the viewport around our draw. three.js writes its own,
    // and mapillary renders after us in the same context.
    const viewport = context.getParameter(context.VIEWPORT) as Int32Array;
    this.renderer.resetState();
    this.renderer.render(this.scene, this.camera);
    context.viewport(viewport[0], viewport[1], viewport[2], viewport[3]);
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
          this.diag.log('texture loaded', {
            id: placement.id,
            size: [texture.image?.width, texture.image?.height],
          });
        },
        undefined,
        (err) => {
          console.warn(`rephoto texture failed to load: ${placement.imageUrl}`, err);
          this.diag.log('texture failed', placement.imageUrl);
        },
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

      this.diag.log('placed', {
        id: placement.id,
        enu: enu.map((n) => Math.round(n * 100) / 100),
        size: [transform.width, transform.height],
        headingDeg: placement.headingDeg,
        url: placement.imageUrl,
      });
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
