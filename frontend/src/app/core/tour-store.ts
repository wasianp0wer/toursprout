import { Injectable, computed, signal } from '@angular/core';
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

  load(tour: Tour): void {
    this._tour.set(tour);
    this._index.set(0);
    this._selectedOverlayId.set(null);
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
  }

  selectOverlay(id: string | null): void {
    if (id !== null && !this.overlaysForCurrentStop().some((o) => o.id === id)) return;
    this._selectedOverlayId.set(id);
  }
}
