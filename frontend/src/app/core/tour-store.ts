import { Injectable, computed, signal } from '@angular/core';
import { detectArrival } from './arrival';
import { bearingBetween, type LngLatLike } from './geo';
import type { GeoQuadAnchorLike } from '../align/align-mode';
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
  private readonly _rephotoOpacity = signal<Record<string, number>>({});
  private readonly _alignmentOverride = signal<GeoQuadAnchorLike | null>(null);
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
  /** Opacity per rephoto id, so each photograph can be viewed on its own. */
  readonly rephotoOpacities = this._rephotoOpacity.asReadonly();

  /** The stop the tour is heading toward, or null at the end. */
  readonly nextStop = computed<Stop | null>(() => this.stops()[this._index() + 1] ?? null);

  /** Compass bearing from the viewer to the next stop; null until both are known. */
  readonly bearingToNextStop = computed<number | null>(() => {
    const from = this._viewerPosition();
    const to = this.nextStop();
    return from && to ? bearingBetween(from, to.location) : null;
  });

  readonly hasRephotos = computed(() => this.rephotos().length > 0);

  /** The photographs draped at the current stop, in document order. */
  readonly rephotos = computed<Overlay[]>(() =>
    this.overlaysForCurrentStop().filter((o) => o.kind === 'rephoto'),
  );

  opacityFor(id: string): number {
    return this._rephotoOpacity()[id] ?? 0;
  }

  load(tour: Tour): void {
    this._tour.set(tour);
    this._index.set(0);
    this._selectedOverlayId.set(null);
    this._viewerPosition.set(null);
    this._latched = new Set();
    this.resetRephotoOpacities();
  }

  /**
   * Feed viewer movement in. The store decides whether it counts as arriving,
   * which keeps that rule in one testable place rather than in a component.
   */
  updateViewerPosition(position: LngLatLike, imageId?: string): void {
    this._viewerPosition.set(position);

    // A stop's own panorama stands on the road, not at the stop, and can sit
    // nearer to a neighbouring stop than to its own. Standing at the vantage
    // point the tour just loaded is not walking anywhere, so it cannot count
    // as arriving somewhere else.
    if (imageId && imageId === this.currentStop()?.panorama.imageId) return;

    const { arrivedIndex, latched } = detectArrival({
      position,
      stops: this.stops(),
      currentIndex: this._index(),
      latched: this._latched,
    });
    this._latched = latched;
    if (arrivedIndex !== null) this.arriveAt(arrivedIndex);
  }

  /** Move because the viewer walked here, as opposed to skipping with goTo. */
  arriveAt(index: number): void {
    this.goTo(index);
  }

  /** Alignment mode only: live-replace the current stop's rephoto anchor. */
  setAlignmentOverride(anchor: GeoQuadAnchorLike | null): void {
    this._alignmentOverride.set(anchor);
  }

  setRephotoOpacity(id: string, value: number): void {
    this._rephotoOpacity.update((all) => ({
      ...all,
      [id]: Math.min(1, Math.max(0, value)),
    }));
  }

  /**
   * Show the first photograph and hide the rest.
   *
   * Several semi-transparent photographs over one building overlap into a
   * muddle, so a stop opens with one legible comparison and the others
   * waiting behind their own sliders.
   */
  private resetRephotoOpacities(): void {
    const defaults: Record<string, number> = {};
    this.rephotos().forEach((o, index) => {
      defaults[o.id] = index === 0 ? 0.7 : 0;
    });
    this._rephotoOpacity.set(defaults);
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
    this.resetRephotoOpacities();
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
