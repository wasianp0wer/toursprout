/**
 * The editor's draft, selection, undo stack and last error, as plain signals.
 *
 * No DOM, no HTTP, no map: `apply` takes a pure document transform (from
 * document-ops.ts) and runs it against the current draft, so the whole of
 * the editor's state machine is testable without a browser.
 */
import { Injectable, computed, signal } from '@angular/core';
import type { Overlay, Stop, Tour } from '../core/tour.models';

/** How many past documents the undo stack keeps, so a long session cannot grow without bound. */
export const UNDO_DEPTH = 50;

@Injectable({ providedIn: 'root' })
export class EditorStore {
  private readonly _draft = signal<Tour | null>(null);
  private readonly _selectedId = signal<string | null>(null);
  private readonly _dirty = signal(false);
  private readonly _lastError = signal<string | null>(null);
  private readonly _undoStack = signal<Tour[]>([]);

  readonly draft = this._draft.asReadonly();
  readonly selectedId = this._selectedId.asReadonly();
  readonly dirty = this._dirty.asReadonly();
  readonly lastError = this._lastError.asReadonly();
  readonly canUndo = computed(() => this._undoStack().length > 0);

  readonly selectedStop = computed<Stop | null>(() => {
    const draft = this._draft();
    const id = this._selectedId();
    if (!draft || !id) return null;
    return draft.stops.find((s) => s.id === id) ?? null;
  });

  readonly selectedOverlay = computed<Overlay | null>(() => {
    const draft = this._draft();
    const id = this._selectedId();
    if (!draft || !id) return null;
    for (const stop of draft.stops) {
      const found = stop.overlays.find((o) => o.id === id);
      if (found) return found;
    }
    return null;
  });

  /**
   * The stop the map and panorama should be showing right now: the selected
   * stop itself, or the stop that owns the selected overlay. Null when
   * nothing is selected — the editor has no notion of "current" on its own,
   * unlike TourStore's walking order.
   */
  readonly currentStop = computed<Stop | null>(() => {
    const selectedStop = this.selectedStop();
    if (selectedStop) return selectedStop;
    const draft = this._draft();
    const overlay = this.selectedOverlay();
    if (!draft || !overlay) return null;
    return draft.stops.find((s) => s.overlays.some((o) => o.id === overlay.id)) ?? null;
  });

  /** Replace the draft wholesale. Loading a document is not an edit. */
  load(tour: Tour): void {
    this._draft.set(tour);
    this._selectedId.set(null);
    this._dirty.set(false);
    this._lastError.set(null);
    this._undoStack.set([]);
  }

  select(id: string | null): void {
    this._selectedId.set(id);
  }

  /**
   * Run a pure document transform against the current draft.
   *
   * A throwing transform (e.g. LastStopError) leaves the draft and undo
   * stack untouched and records the message instead: a failed edit is not
   * an edit, and must not reach a click handler as an exception.
   */
  apply(fn: (tour: Tour) => Tour): void {
    const current = this._draft();
    if (!current) return;
    let next: Tour;
    try {
      next = fn(current);
    } catch (err) {
      this._lastError.set(err instanceof Error ? err.message : String(err));
      return;
    }
    const stack = [...this._undoStack(), current];
    this._undoStack.set(stack.length > UNDO_DEPTH ? stack.slice(stack.length - UNDO_DEPTH) : stack);
    this._draft.set(next);
    this._dirty.set(true);
    this._lastError.set(null);
    this.pruneDanglingSelection();
  }

  undo(): void {
    const stack = this._undoStack();
    if (stack.length === 0) return;
    const previous = stack[stack.length - 1];
    this._undoStack.set(stack.slice(0, -1));
    this._draft.set(previous);
    this.pruneDanglingSelection();
  }

  /** Clear the selection if it no longer names a stop or overlay in the draft. */
  private pruneDanglingSelection(): void {
    const id = this._selectedId();
    if (!id) return;
    const draft = this._draft();
    if (!draft) {
      this._selectedId.set(null);
      return;
    }
    const exists = draft.stops.some(
      (s) => s.id === id || s.overlays.some((o) => o.id === id),
    );
    if (!exists) this._selectedId.set(null);
  }
}
