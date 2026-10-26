import { Component, computed, inject } from '@angular/core';
import { EditorStore } from './editor-store';
import { addStop, addTextOverlay, deleteOverlay, deleteStop, moveStop } from './document-ops';

/** The tour as a list: stops in order, each with its overlays. Thin over EditorStore. */
@Component({
  selector: 'app-outline-pane',
  templateUrl: './outline-pane.html',
  styleUrl: './outline-pane.css',
})
export class OutlinePane {
  protected readonly store = inject(EditorStore);

  protected readonly stops = computed(() =>
    [...(this.store.draft()?.stops ?? [])].sort((a, b) => a.order - b.order));

  protected addStop(): void {
    this.store.apply((t) => addStop(t, 'New stop'));
    if (this.store.lastError()) return;
    const stops = this.store.draft()!.stops;
    this.store.select(stops[stops.length - 1].id);
  }

  protected addOverlay(): void {
    const stop = this.store.currentStop();
    if (!stop) return;
    const before = new Set(stop.overlays.map((o) => o.id));
    this.store.apply((t) => addTextOverlay(t, stop.id, 'New note'));
    const after = this.store.draft()!.stops.find((s) => s.id === stop.id);
    const added = after?.overlays.find((o) => !before.has(o.id));
    if (added) this.store.select(added.id);
  }

  protected remove(): void {
    const id = this.store.selectedId();
    if (!id) return;
    if (this.store.selectedOverlay()) this.store.apply((t) => deleteOverlay(t, id));
    else this.store.apply((t) => deleteStop(t, id));
  }

  protected move(delta: number): void {
    const stop = this.store.selectedStop();
    if (stop) this.store.apply((t) => moveStop(t, stop.id, delta));
  }
}
