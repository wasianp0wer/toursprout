import { Injectable, computed, signal } from '@angular/core';
import { detectArrival } from './arrival';
import { bearingBetween, type LngLatLike } from './geo';
import type { InWorldPlacementLike } from '../editor/nudge';
import type { Overlay, Stop, Tour } from './tour.models';

/**
 * Tour navigation state. Deliberately free of DOM, HTTP and map concerns so it
 * can be tested directly and reused by any view.
 */
@Injectable({ providedIn: 'root' })
export class TourStore {
  private readonly _tour = signal<Tour | null>(null);
  private readonly _index = signal(0);
  private readonly _selectedOverlayId = signal<string | null>(null);
  private readonly _viewerPosition = signal<LngLatLike | null>(null);
  private readonly _overlayOpacity = signal<Record<string, number>>({});
  private readonly _alignmentOverride =
    signal<{ id: string; anchor: InWorldPlacementLike } | null>(null);
  private _latched: ReadonlySet<string> = new Set();

  readonly tour = this._tour.asReadonly();
  readonly currentIndex = this._index.asReadonly();

  /** Stops in walking order, whichever order the document happened to list them in. */
  readonly stops = computed<Stop[]>(() => {
    const tour = this._tour();
    return tour ? [...tour.stops].sort((a, b) => a.order - b.order) : [];
  });

  readonly currentStop = computed<Stop | null>(() => this.stops()[this._index()] ?? null);

  readonly overlaysForCurrentStop = computed<Overlay[]>(
    () => this.currentStop()?.overlays ?? [],
  );

  readonly selectedOverlay = computed<Overlay | null>(() => {
    const id = this._selectedOverlayId();
    return id ? (this.overlaysForCurrentStop().find((o) => o.id === id) ?? null) : null;
  });

  readonly hasNext = computed(() => this._index() < this.stops().length - 1);
  readonly hasPrevious = computed(() => this._index() > 0);

  readonly viewerPosition = this._viewerPosition.asReadonly();
  readonly alignmentOverride = this._alignmentOverride.asReadonly();
  /** Opacity per draped overlay id, so each photograph can be viewed on its own. */
  readonly overlayOpacities = this._overlayOpacity.asReadonly();

  /** The stop the tour is heading toward, or null at the end. */
  readonly nextStop = computed<Stop | null>(() => this.stops()[this._index() + 1] ?? null);

  /** Compass bearing from the viewer to the next stop; null until both are known. */
  readonly bearingToNextStop = computed<number | null>(() => {
    const from = this._viewerPosition();
    const to = this.nextStop();
    return from && to ? bearingBetween(from, to.location) : null;
  });

  readonly hasInWorldOverlays = computed(() => this.inWorldOverlays().length > 0);

  /** The overlays drawn as planes standing in the world, in document order. */
  readonly inWorldOverlays = computed<Overlay[]>(() =>
    this.overlaysForCurrentStop().filter((o) => o.display.mode === 'inWorld'),
  );

  opacityFor(id: string): number {
    return this._overlayOpacity()[id] ?? 0;
  }

  load(tour: Tour): void {
    this._tour.set(tour);
    this._index.set(0);
    this._selectedOverlayId.set(null);
    this._viewerPosition.set(null);
    this._latched = new Set();
    this.resetOverlayOpacities();
  }

  /**
   * Feed viewer movement in. The store decides whether it counts as arriving,
   * which keeps that rule in one testable place rather than in a component.
   */
  updateViewerPosition(position: LngLatLike, imageId?: string): void {
    this._viewerPosition.set(position);

    const { arrivedIndex, latched } = detectArrival({
      position,
      imageId,
      stops: this.stops(),
      currentIndex: this._index(),
      latched: this._latched,
    });
    this._latched = latched;
    if (arrivedIndex !== null) this.arriveAt(arrivedIndex);
  }

  /** Diagnostics only: the current arrival-latch set. */
  latchedStopIds(): string[] {
    return [...this._latched];
  }

  /** Move because the viewer walked here, as opposed to skipping with goTo. */
  arriveAt(index: number): void {
    this.goTo(index);
  }

  /** Alignment mode only: live-replace the current stop's inWorld anchor. */
  setAlignmentOverride(override: { id: string; anchor: InWorldPlacementLike } | null): void {
    this._alignmentOverride.set(override);
  }

  setOverlayOpacity(id: string, value: number): void {
    this._overlayOpacity.update((all) => ({
      ...all,
      [id]: Math.min(1, Math.max(0, value)),
    }));
  }

  /**
   * Seed each draped overlay's opacity from what the author set.
   *
   * v1 hardcoded "first at 0.7, rest hidden" here. That rule now lives in the
   * document, so the author decides which comparison a stop opens on.
   */
  private resetOverlayOpacities(): void {
    const defaults: Record<string, number> = {};
    for (const o of this.inWorldOverlays()) {
      if (o.display.mode === 'inWorld') defaults[o.id] = o.display.opacity;
    }
    this._overlayOpacity.set(defaults);
  }

  next(): void {
    if (this.hasNext()) this.goTo(this._index() + 1);
  }

  previous(): void {
    if (this.hasPrevious()) this.goTo(this._index() - 1);
  }

  goTo(index: number): void {
    if (index < 0 || index >= this.stops().length) return;
    this._index.set(index);
    this._selectedOverlayId.set(null);
    this.resetOverlayOpacities();
    // Latch the destination: without this, skipping to a stop you are already
    // standing near would immediately re-trigger arrival at that same stop.
    const stop = this.stops()[index];
    if (stop) this._latched = new Set([...this._latched, stop.id]);
  }

  selectOverlay(id: string | null): void {
    if (id !== null && !this.overlaysForCurrentStop().some((o) => o.id === id)) return;
    this._selectedOverlayId.set(id);
  }
}
