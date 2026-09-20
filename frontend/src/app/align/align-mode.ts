import { Component, computed, inject, signal } from '@angular/core';
import { TourStore } from '../core/tour-store';

export interface GeoQuadAnchorLike {
  lng: number;
  lat: number;
  altitude: number;
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
export function nudgeAnchor(anchor: GeoQuadAnchorLike, key: string): GeoQuadAnchorLike {
  const next = { ...anchor };
  switch (key) {
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
      next.altitude += STEP_M;
      break;
    case 'PageDown':
      next.altitude -= STEP_M;
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
        <p class="keys">← → ↑ ↓ move · PgUp/PgDn height · +/− size · [ ] heading</p>
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
    .keys { margin: 0 0 0.5rem; color: #9aa0ab; }
    pre { margin: 0 0 0.5rem; white-space: pre-wrap; font-size: 0.68rem; }
    button { font: inherit; background: #e8b04b; border: 0; border-radius: 3px;
             padding: 0.3rem 0.55rem; cursor: pointer; }
  `],
  host: { '(document:keydown)': 'onKey($event)' },
})
export class AlignMode {
  private readonly store = inject(TourStore);
  private readonly override = signal<GeoQuadAnchorLike | null>(null);

  protected readonly draft = computed<GeoQuadAnchorLike | null>(() => {
    const manual = this.override();
    if (manual) return manual;
    const rephoto = this.store.overlaysForCurrentStop().find((o) => o.kind === 'rephoto');
    if (!rephoto || rephoto.anchor.type !== 'geoQuad') return null;
    const a = rephoto.anchor;
    return {
      lng: a.lng, lat: a.lat, altitude: a.altitude,
      headingDeg: a.headingDeg, widthM: a.widthM, heightM: a.heightM,
    };
  });

  protected readonly json = computed(() => {
    const a = this.draft();
    return a ? JSON.stringify({ type: 'geoQuad', ...a }, null, 2) : '';
  });

  protected onKey(event: KeyboardEvent): void {
    const current = this.draft();
    if (!current) return;
    const next = nudgeAnchor(current, event.key);
    if (next === current) return;
    event.preventDefault();
    this.override.set(next);
    this.store.setAlignmentOverride(next);
  }

  protected copy(): void {
    void navigator.clipboard?.writeText(this.json());
  }
}
