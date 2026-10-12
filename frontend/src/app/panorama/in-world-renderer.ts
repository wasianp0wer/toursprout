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
import {
  geodeticAltitude,
  planeTransform,
  inWorldMaterialOptions,
  type InWorldPlacement,
} from './in-world-placement';

/**
 * Draws historical photographs as planes standing in the world.
 *
 * Tags cannot carry an image texture, so a custom renderer is the supported
 * route. The three.js version is whatever mapillary-js depends on (0.134),
 * deliberately not installed separately: two three.js copies sharing one WebGL
 * context fail in ways that are hard to diagnose.
 */
export class InWorldRenderer implements ICustomRenderer {
  readonly id = 'in-world-renderer';
  readonly renderPass = RenderPass.Opaque;

  private renderer: WebGLRenderer | null = null;
  private readonly scene = new Scene();
  private readonly camera = new PerspectiveCamera();
  private readonly loader = new TextureLoader();
  private reference: LngLatAlt | null = null;
  private placements: InWorldPlacement[] = [];
  private readonly meshes = new Map<string, Mesh>();
  private opacity: Record<string, number> = {};
  private readonly diag: Diagnostics;
  private frames = 0;

  constructor(diagnosticsOn = false) {
    this.diag = createDiagnostics(diagnosticsOn);
    if (diagnosticsOn && typeof window !== 'undefined') {
      // Diagnostics only: lets the scene graph be interrogated from the
      // console, since a WebGL scene cannot be inspected any other way.
      (window as unknown as { __inWorld?: unknown }).__inWorld = this;
    }
  }

  /** Diagnostics only. */
  inspect() {
    const meshes = [...this.meshes.entries()].map(([id, mesh]) => ({
      id,
      position: mesh.position.toArray(),
      rotation: [mesh.rotation.x, mesh.rotation.y, mesh.rotation.z, mesh.rotation.order],
      visible: mesh.visible,
      inScene: mesh.parent === this.scene,
      material: {
        opacity: (mesh.material as MeshBasicMaterial).opacity,
        transparent: (mesh.material as MeshBasicMaterial).transparent,
        side: (mesh.material as MeshBasicMaterial).side,
        hasMap: !!(mesh.material as MeshBasicMaterial).map,
        visible: (mesh.material as MeshBasicMaterial).visible,
      },
    }));
    return {
      frames: this.frames,
      opacity: this.opacity,
      hasRenderer: !!this.renderer,
      reference: this.reference,
      sceneChildren: this.scene.children.length,
      camera: {
        position: this.camera.position.toArray(),
        near: this.camera.near,
        far: this.camera.far,
        projection: this.camera.projectionMatrix.elements.slice(0, 4),
      },
      meshes,
    };
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

  setPlacements(placements: InWorldPlacement[]): void {
    this.diag.log('setPlacements', {
      count: placements.length,
      ids: placements.map((p) => p.id),
      haveReference: this.reference !== null,
    });
    this.placements = placements;
    this.rebuild();
  }

  setOpacity(opacities: Record<string, number>): void {
    this.diag.log('setOpacity', { opacities, meshes: this.meshes.size });
    this.opacity = opacities;
    for (const [id, mesh] of this.meshes.entries()) {
      const value = this.opacityOf(id);
      const material = mesh.material as MeshBasicMaterial;
      material.opacity = value;
      mesh.visible = value > 0.01;
    }
  }

  private opacityOf(id: string): number {
    return Math.min(1, Math.max(0, this.opacity[id] ?? 0));
  }

  render(context: WebGLRenderingContext, viewMatrix: number[], projectionMatrix: number[]): void {
    this.frames += 1;
    const anyVisible = [...this.meshes.keys()].some((id) => this.opacityOf(id) > 0.01);
    if (!this.renderer || this.meshes.size === 0 || !anyVisible) {
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
        placement.lng,
        placement.lat,
        geodeticAltitude(placement.altitudeM, reference.alt),
        reference.lng, reference.lat, reference.alt,
      ) as [number, number, number];

      const transform = planeTransform(placement, enu);
      const material = new MeshBasicMaterial(inWorldMaterialOptions(this.opacityOf(placement.id)));

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
          console.warn(`in-world texture failed to load: ${placement.imageUrl}`, err);
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
      mesh.visible = this.opacityOf(placement.id) > 0.01;

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
