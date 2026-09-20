import {
  Component,
  DestroyRef,
  ElementRef,
  InjectionToken,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { ConfigStore } from '../core/config-store';
import { TourStore } from '../core/tour-store';
import { MapillaryViewer } from './mapillary-viewer';
import type { PanoramaViewer } from './panorama-viewer';

export const PANORAMA_VIEWER = new InjectionToken<PanoramaViewer>('PANORAMA_VIEWER', {
  providedIn: 'root',
  factory: () => new MapillaryViewer(),
});

@Component({
  selector: 'app-panorama-pane',
  template: `
    <div class="panorama" #container></div>
    @if (loadError()) {
      <p class="pano-error" data-pano-error>
        Street-level imagery is unavailable for this stop.
      </p>
    }
  `,
  styleUrl: './panorama-pane.css',
})
export class PanoramaPane {
  private readonly viewer = inject(PANORAMA_VIEWER);
  private readonly store = inject(TourStore);
  private readonly config = inject(ConfigStore);
  private readonly container = viewChild.required<ElementRef<HTMLElement>>('container');
  protected readonly loadError = signal(false);
  private attached = false;

  constructor() {
    inject(DestroyRef).onDestroy(() => this.viewer.destroy());
    this.viewer.onMarkerClick((id) => this.store.selectOverlay(id));

    effect(() => {
      const stop = this.store.currentStop();
      if (!stop) return;
      if (!this.attached) {
        this.viewer.attach(this.container().nativeElement, this.config.mapillaryToken());
        this.attached = true;
      }
      // Imagery can be withdrawn or replaced upstream; a missing panorama must
      // degrade to a message, not break the rest of the tour.
      this.viewer
        .load(stop.panorama.imageId, stop.panorama.bearing)
        .then(() => this.loadError.set(false))
        .catch(() => this.loadError.set(true));
    });

    effect(() => {
      const selectedId = this.store.selectedOverlay()?.id ?? null;
      this.viewer.setMarkers(
        this.store.overlaysForCurrentStop().map((o) => ({
          id: o.id,
          lng: o.anchor.lng,
          lat: o.anchor.lat,
          selected: o.id === selectedId,
        })),
      );
    });
  }
}
