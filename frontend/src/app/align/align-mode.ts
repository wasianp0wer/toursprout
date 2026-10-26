import { Component, computed, inject, signal } from '@angular/core';
import { TourStore } from '../core/tour-store';
import { nudgeAnchor, type InWorldPlacementLike } from '../editor/nudge';
import type { Overlay } from '../core/tour.models';

/**
 * Which photograph the arrow keys move.
 *
 * Selecting a photograph row in the stop panel chooses it; otherwise the
 * first is aligned. Without this the keys always moved the first photograph,
 * leaving any others impossible to position.
 */
export function alignTarget(overlays: Overlay[], selectedId: string | null): Overlay | null {
  if (overlays.length === 0) return null;
  return overlays.find((o) => o.id === selectedId) ?? overlays[0];
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
      <aside class="align" data-align-panel><p>No photograph on this stop to align.</p></aside>
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
   * An `anchor` object plus the `display` fields alignment mode moves, in
   * v2 shape. Paste this over the `anchor` key (and add this `display` key
   * alongside it) on the matching entry in content/source/stops.json's
   * `rephotos[]`, then run `make content`: build_tour.py
   * (content/scripts/build_tour.py, `in_world_overlay`) reads this split
   * shape directly, alongside the original flat one. `headingDeg` here is
   * derived afresh from the panorama's position when the tour is built, so
   * whatever value is pasted is ignored on input -- it is only shown here as
   * a live preview of the current aim.
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
