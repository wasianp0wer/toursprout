import {
  Component, DestroyRef, ElementRef, computed, effect, inject, signal, untracked, viewChild,
} from '@angular/core';
import { ConfigStore } from '../core/config-store';
import { TourApi } from '../core/tour-api';
import { EditorStore } from './editor-store';
import { setInWorldField, setOverlayAnchor } from './document-ops';
import { nudgeAnchor, type InWorldPlacementLike } from './nudge';
import { PANORAMA_VIEWER } from '../panorama/panorama-pane';
import type { InWorldPlacement } from '../panorama/in-world-placement';
import type { OverlayMarker } from '../panorama/panorama-viewer';
import type { Overlay } from '../core/tour.models';

/**
 * Keys the pane will act on. Heading keys are deliberately absent: a heading
 * is derived from where the panorama stands (or dragged on the map, behind
 * the same gate), never nudged blind from here.
 */
const HANDLED_KEYS = new Set([
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'PageUp', 'PageDown', 'z', 'c', '+', '=', '-',
]);

/**
 * The editable panorama: the current stop's panorama with its overlays, and
 * for the selected inWorld overlay keyboard nudging, altitude and size
 * buttons and an opacity slider. It replaces the old URL-flag alignment stopgap.
 *
 * This pane is also what fills EditorStore.panoramaPosition. The viewer
 * reports the image it actually landed on (not the one it was asked for) and
 * we publish that image's id with its position, so the store's gate can tell
 * whose position it is. Until the first report the editor cannot orient
 * anything.
 *
 * mapillary-js draws on demand; MapillaryViewer requests a redraw inside
 * setInWorldPlacements and setInWorldOpacity, so every scene change here goes
 * through those two calls and none writes to the scene any other way.
 */
@Component({
  selector: 'app-edit-panorama-pane',
  template: `
    <div class="panorama" #container></div>
    @if (!store.currentStop()) {
      <p class="empty" data-pano-empty>Select a stop or overlay to see its panorama.</p>
    }
    @if (loadError()) {
      <p class="pano-error" data-pano-error>Street-level imagery is unavailable for this stop.</p>
    }
    @if (target(); as o) {
      <aside class="controls" data-controls>
        <p class="keys">Arrows move · z/c height · +/− size</p>
        <button type="button" data-altitude-up (click)="nudge('z')">Raise</button>
        <button type="button" data-altitude-down (click)="nudge('c')">Lower</button>
        <button type="button" data-size-up (click)="nudge('+')">Larger</button>
        <button type="button" data-size-down (click)="nudge('-')">Smaller</button>
        <label>Opacity
          <input type="range" min="0" max="1" step="0.05" data-opacity
                 [value]="opacityOf(o)" (input)="setOpacity(o, $event)" />
        </label>
      </aside>
    }
  `,
  styleUrl: './edit-panorama-pane.css',
  host: { '(document:keydown)': 'onKey($event)' },
})
export class EditPanoramaPane {
  protected readonly store = inject(EditorStore);
  private readonly viewer = inject(PANORAMA_VIEWER);
  private readonly config = inject(ConfigStore);
  private readonly api = inject(TourApi);
  private readonly container = viewChild.required<ElementRef<HTMLElement>>('container');
  protected readonly loadError = signal(false);
  private attached = false;

  /** The selected overlay, if it is one the controls can act on. */
  protected readonly target = computed<Overlay | null>(() => {
    const o = this.store.selectedOverlay();
    return o && o.display.mode === 'inWorld' ? o : null;
  });

  /** Only the id: edits to the stop must not look like a different panorama. */
  private readonly imageId = computed(() => this.store.currentStop()?.panorama.imageId ?? null);

  constructor() {
    inject(DestroyRef).onDestroy(() => this.viewer.destroy());

    // The id comes from the viewer's own report of the image it has loaded.
    // Using the requested id here would let a lagging load publish the
    // previous panorama's position as this one's.
    this.viewer.onPositionChange((position, imageId) =>
      this.store.setPanoramaPosition({ imageId, lng: position.lng, lat: position.lat }),
    );

    effect(() => {
      const imageId = this.imageId();
      if (!imageId) return;
      if (!this.attached) {
        this.viewer.attach(this.container().nativeElement, this.config.mapillaryToken());
        this.attached = true;
      }
      const bearing = untracked(() => this.store.currentStop()?.panorama.bearing ?? 0);
      this.viewer
        .load(imageId, bearing)
        .then(() => this.loadError.set(false))
        .catch(() => this.loadError.set(true));
    });

    effect(() => {
      const stop = this.store.currentStop();
      const selectedId = this.store.selectedOverlay()?.id ?? null;
      const markers: OverlayMarker[] = [];
      const placements: InWorldPlacement[] = [];
      const opacities: Record<string, number> = {};
      for (const o of stop?.overlays ?? []) {
        if (o.display.mode === 'marker') {
          markers.push({
            id: o.id, lng: o.anchor.lng, lat: o.anchor.lat,
            selected: o.id === selectedId, kind: 'overlay',
          });
        } else if (o.display.mode === 'inWorld' && o.mediaId) {
          placements.push({
            id: o.id, imageUrl: this.api.mediaUrl(o.mediaId),
            lng: o.anchor.lng, lat: o.anchor.lat, altitudeM: o.anchor.altitudeM,
            headingDeg: o.display.headingDeg, widthM: o.display.widthM, heightM: o.display.heightM,
          });
          opacities[o.id] = o.display.opacity;
        }
      }
      this.viewer.setMarkers(markers);
      this.viewer.setInWorldPlacements(placements);
      this.viewer.setInWorldOpacity(opacities);
    });
  }

  protected opacityOf(o: Overlay): number {
    return o.display.mode === 'inWorld' ? o.display.opacity : 0;
  }

  protected setOpacity(o: Overlay, event: Event): void {
    const value = Number((event.target as HTMLInputElement).value);
    this.store.apply((t) => setInWorldField(t, o.id, { opacity: value }));
  }

  protected onKey(event: KeyboardEvent): void {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (isTextEntry(event.target)) return;
    if (!HANDLED_KEYS.has(event.key.length === 1 ? event.key.toLowerCase() : event.key)) return;
    if (this.nudge(event.key)) event.preventDefault();
  }

  /** Apply one nudge as a single undoable edit. True if it changed anything. */
  protected nudge(key: string): boolean {
    const o = this.target();
    if (!o || o.display.mode !== 'inWorld') return false;
    const d = o.display;
    const from: InWorldPlacementLike = {
      lng: o.anchor.lng, lat: o.anchor.lat, altitudeM: o.anchor.altitudeM,
      headingDeg: d.headingDeg, widthM: d.widthM, heightM: d.heightM,
    };
    const to = nudgeAnchor(from, key);
    if (to === from) return false;
    this.store.apply((t) => setInWorldField(
      setOverlayAnchor(t, o.id, { lng: to.lng, lat: to.lat, altitudeM: to.altitudeM }),
      o.id, { widthM: to.widthM, heightM: to.heightM },
    ));
    return true;
  }
}

function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}
