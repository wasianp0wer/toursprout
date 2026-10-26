/**
 * The editor's draft, selection, undo stack and last error, as plain signals.
 *
 * No DOM, no HTTP, no map: `apply` takes a pure document transform (from
 * document-ops.ts) and runs it against the current draft, so the whole of
 * the editor's state machine is testable without a browser.
 */
import { Injectable, computed, signal } from '@angular/core';
import type { PanoramaFix } from './document-ops';
import type { Overlay, Stop, Tour } from '../core/tour.models';

/** How many past documents the undo stack keeps, so a long session cannot grow without bound. */
export const UNDO_DEPTH = 50;

@Injectable({ providedIn: 'root' })
export class EditorStore {
  private readonly _draft = signal<Tour | null>(null);
  private readonly _selectedId = signal<string | null>(null);
  /**
   * The document last known to be on disk (or just loaded). `dirty` is
   * derived from it rather than stored, so no edit path can forget to set it.
   */
  private readonly _savedDoc = signal<Tour | null>(null);
  private readonly _lastError = signal<string | null>(null);
  private readonly _undoStack = signal<Tour[]>([]);

  private readonly _panoramaPosition = signal<PanoramaFix | null>(null);

  /**
   * Where the panorama being viewed actually stands (keyed by its imageId so
   * a lagging pane cannot supply the previous panorama's position), or null until something
   * supplies it (the panorama pane, from mapillary-js). Heading
   * derivation uses this and nothing else: stop.location is the building,
   * not the camera, and deriving from it can point a photo backwards.
   */
  readonly panoramaPosition = this._panoramaPosition.asReadonly();
  setPanoramaPosition(pos: PanoramaFix | null): void {
    this._panoramaPosition.set(pos);
  }

  private readonly _pendingDefaults = signal<{ creator: string; license: string } | null>(null);

  /**
   * The author's answer to the one-time creator/licence prompt, held until
   * the first successful add writes it onto the tour. Lives here, not in a
   * pane, so `load` can clear it: an answer given for one tour must never be
   * written onto another without asking. Never part of the document.
   */
  readonly pendingDefaults = this._pendingDefaults.asReadonly();
  setPendingDefaults(v: { creator: string; license: string } | null): void {
    this._pendingDefaults.set(v);
  }

  private readonly _manualHeadings = signal<ReadonlySet<string>>(new Set());

  /**
   * Overlay ids whose heading the author set by hand (typed, or dragged on
   * the map). Editor-only UI state shared by the inspector and the map; never
   * written to the document. Cleared by `load`.
   */
  readonly manualHeadings = this._manualHeadings.asReadonly();
  markHeadingManual(id: string, on: boolean): void {
    const next = new Set(this._manualHeadings());
    if (on) next.add(id); else next.delete(id);
    this._manualHeadings.set(next);
  }

  readonly draft = this._draft.asReadonly();
  readonly selectedId = this._selectedId.asReadonly();
  /** Unsaved changes exist: the draft is not the document last saved. Undoing back to it is clean. */
  readonly dirty = computed(() => this._draft() !== this._savedDoc());
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
    this.clear();
    this._draft.set(tour);
    this._savedDoc.set(tour);
  }

  /**
   * Back to no tour at all — for closing one.
   *
   * This store is providedIn root, so it outlives the editor page: without
   * this, a closed tour's draft, selection and undo history would still be
   * sitting here, and whatever opened next would be looking at them. Every
   * field resets, which is also what `load` needs, so `load` is this plus
   * the new document and nothing else can drift out of step with it.
   */
  clear(): void {
    this._draft.set(null);
    this._selectedId.set(null);
    this._savedDoc.set(null);
    this._lastError.set(null);
    this._undoStack.set([]);
    this._manualHeadings.set(new Set());
    this._pendingDefaults.set(null);
    // Keyed by imageId, so a stale fix is already ignored for another
    // panorama; cleared anyway, because with no tour open there is no
    // camera standing anywhere.
    this._panoramaPosition.set(null);
  }

  select(id: string | null): void {
    this._selectedId.set(id);
  }

  /**
   * Record that `doc` is now on disk — for Autosave to call once a PUT has
   * landed. Ignored unless `doc` is still the draft: a newer edit made during
   * the flight is genuinely unsaved. Leaves selection and undo untouched.
   *
   * The reference guard is load-bearing. Without it a slow PUT for version A
   * resolving after the author has typed version B would record A as saved
   * and flip `dirty` false while B exists only in memory, so the autosave
   * watcher would never fire for it and a reload would lose the edit.
   */
  markSaved(doc: Tour): void {
    if (this._draft() === doc) this._savedDoc.set(doc);
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
    // A refused transform returns the SAME tour reference by contract, and
    // this identity check is the only way anyone learns it was refused: there
    // is no result flag. It is not an edit, so it must not push undo, dirty
    // the draft or trigger a save. Every op in document-ops.ts therefore has
    // to return `tour` itself on refusal, never an equal copy: a "tidied" op
    // that always spreads a new object would push a phantom undo step and
    // fire an autosave for a change that did not happen, and nothing would
    // fail loudly. `dirty` is the same identity test (draft !== savedDoc).
    if (next === current) return;
    const stack = [...this._undoStack(), current];
    this._undoStack.set(stack.length > UNDO_DEPTH ? stack.slice(stack.length - UNDO_DEPTH) : stack);
    this._draft.set(next);
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
