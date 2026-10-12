import { Component, computed, inject, signal } from '@angular/core';
import { TourStore } from '../core/tour-store';
import type { Overlay } from '../core/tour.models';

/** The subset of an inWorld display that alignment mode moves. */
export interface InWorldPlacementLike {
  lng: number;
  lat: number;
  altitudeM: number;
  headingDeg: number;
  widthM: number;
  heightM: number;
}

/** One metre per keypress, converted to degrees at the working latitude. */
export const STEP_M = 1;
export const STEP_DEG = 2;
const METRES_PER_DEGREE_LAT = 111_320;
const SCALE_FACTOR = 1.05;
const MIN_SIZE_M = 0.5;

const metresToLat = (m: number) => m / METRES_PER_DEGREE_LAT;
const metresToLng = (m: number, lat: number) =>
  m / (METRES_PER_DEGREE_LAT * Math.cos((lat * Math.PI) / 180));

/** Pure reducer: an anchor and a key in, a new anchor out. */
export function nudgeAnchor(anchor: InWorldPlacementLike, key: string): InWorldPlacementLike {
  const next = { ...anchor };
  // Laptop keyboards often lack PageUp/PageDown, so z and c raise and lower
  // as well. Case-folded so shift or caps lock does not silently do nothing.
  switch (key.length === 1 ? key.toLowerCase() : key) {
    case 'ArrowUp':
      next.lat += metresToLat(STEP_M);
      break;
    case 'ArrowDown':
      next.lat -= metresToLat(STEP_M);
      break;
    case 'ArrowRight':
      next.lng += metresToLng(STEP_M, anchor.lat);
      break;
    case 'ArrowLeft':
      next.lng -= metresToLng(STEP_M, anchor.lat);
      break;
    case 'PageUp':
    case 'z':
      next.altitudeM += STEP_M;
      break;
    case 'PageDown':
    case 'c':
      next.altitudeM -= STEP_M;
      break;
    case '+':
    case '=':
      next.widthM = anchor.widthM * SCALE_FACTOR;
      next.heightM = anchor.heightM * SCALE_FACTOR;
      break;
    case '-':
      next.widthM = Math.max(MIN_SIZE_M, anchor.widthM / SCALE_FACTOR);
      next.heightM = Math.max(MIN_SIZE_M, anchor.heightM / SCALE_FACTOR);
      break;
    case ']':
      next.headingDeg = (anchor.headingDeg + STEP_DEG + 360) % 360;
      break;
    case '[':
      next.headingDeg = (anchor.headingDeg - STEP_DEG + 360) % 360;
      break;
    default:
      return anchor;
  }
  return next;
}

/**
 * Which photograph the arrow keys move.
 *
 * Selecting a rephoto row in the stop panel chooses it; otherwise the first is
 * aligned. Without this the keys always moved the first photograph, leaving
 * any others impossible to position.
 */
export function alignTarget(rephotos: Overlay[], selectedId: string | null): Overlay | null {
  if (rephotos.length === 0) return null;
  return rephotos.find((o) => o.id === selectedId) ?? rephotos[0];
}

export function alignModeEnabled(search: string): boolean {
  return new URLSearchParams(search).get('align') === '1';
}

/**
 * Content-authoring affordance, not an editor: georeferencing a photograph by
 * eye and copying the resulting anchor into content. It exists because the
 * render cannot be seen from the build environment, which would otherwise make
 * every alignment a blind edit-and-reload cycle.
 */
@Component({
  selector: 'app-align-mode',
  template: `
    @let anchor = draft();
    @if (anchor) {
      <aside class="align" data-align-panel>
        <p class="target" data-align-target>{{ target()?.title }}</p>
        <p class="keys">← → ↑ ↓ move · z/c height · +/− size · [ ] heading</p>
        <p class="keys">Select another photograph in the panel to align it.</p>
        <pre data-align-json>{{ json() }}</pre>
        <button type="button" data-align-copy (click)="copy()">copy anchor JSON</button>
      </aside>
    } @else {
      <aside class="align" data-align-panel><p>No rephoto on this stop to align.</p></aside>
    }
  `,
  styles: [`
    .align { position: absolute; top: 0.75rem; left: 0.75rem; z-index: 5;
             background: rgba(15, 17, 20, 0.92); border: 1px solid #e8b04b;
             border-radius: 4px; padding: 0.6rem 0.75rem; font-size: 0.7rem;
             color: #ecebe6; max-width: 22rem; }
    .target { margin: 0 0 0.35rem; color: #e8b04b; font-size: 0.78rem; }
    .keys { margin: 0 0 0.5rem; color: #9aa0ab; }
    pre { margin: 0 0 0.5rem; white-space: pre-wrap; font-size: 0.68rem; }
    button { font: inherit; background: #e8b04b; border: 0; border-radius: 3px;
             padding: 0.3rem 0.55rem; cursor: pointer; }
  `],
  host: { '(document:keydown)': 'onKey($event)' },
})
export class AlignMode {
  private readonly store = inject(TourStore);
  private readonly override = signal<{ id: string; anchor: InWorldPlacementLike } | null>(null);

  protected readonly target = computed<Overlay | null>(() =>
    alignTarget(this.store.inWorldOverlays(), this.store.selectedOverlay()?.id ?? null),
  );

  protected readonly draft = computed<InWorldPlacementLike | null>(() => {
    const target = this.target();
    if (!target || target.display.mode !== 'inWorld') return null;

    const manual = this.override();
    if (manual && manual.id === target.id) return manual.anchor;

    const a = target.anchor;
    const d = target.display;
    return {
      lng: a.lng, lat: a.lat, altitudeM: a.altitudeM,
      headingDeg: d.headingDeg, widthM: d.widthM, heightM: d.heightM,
    };
  });

  /**
   * v2 JSON ready to paste into content: an `anchor` object plus the
   * `display` fields alignment mode moves. Pasting the pre-v2 shape back
   * into a document would silently fail validation.
   */
  protected readonly json = computed(() => {
    const a = this.draft();
    if (!a) return '';
    return JSON.stringify({
      anchor: { type: 'geo', lng: a.lng, lat: a.lat, altitudeM: a.altitudeM },
      display: { mode: 'inWorld', headingDeg: a.headingDeg, widthM: a.widthM, heightM: a.heightM },
    }, null, 2);
  });

  protected onKey(event: KeyboardEvent): void {
    const current = this.draft();
    const target = this.target();
    if (!current || !target) return;
    const next = nudgeAnchor(current, event.key);
    if (next === current) return;
    event.preventDefault();
    this.override.set({ id: target.id, anchor: next });
    this.store.setAlignmentOverride({ id: target.id, anchor: next });
  }

  protected copy(): void {
    void navigator.clipboard?.writeText(this.json());
  }
}
