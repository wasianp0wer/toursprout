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
import { TourApi } from '../core/tour-api';
import { TourStore } from '../core/tour-store';
import type { OverlayMarker } from './panorama-viewer';
import type { InWorldPlacement } from './rephoto-placement';
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
  private readonly api = inject(TourApi);
  private readonly container = viewChild.required<ElementRef<HTMLElement>>('container');
  protected readonly loadError = signal(false);
  private attached = false;

  constructor() {
    inject(DestroyRef).onDestroy(() => this.viewer.destroy());
    this.viewer.onMarkerClick((id) => this.store.selectOverlay(id));
    this.viewer.onPositionChange((position, imageId) =>
      this.store.updateViewerPosition(position, imageId),
    );

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
      const markers: OverlayMarker[] = [];
      const placements: InWorldPlacement[] = [];
      for (const o of this.store.overlaysForCurrentStop()) {
        if (o.display.mode === 'marker') {
          markers.push({
            id: o.id,
            lng: o.anchor.lng,
            lat: o.anchor.lat,
            selected: o.id === selectedId,
            kind: 'overlay' as const,
          });
        } else if (o.display.mode === 'inWorld' && o.mediaId) {
          placements.push({
            id: o.id,
            imageUrl: this.api.mediaUrl(o.mediaId),
            lng: o.anchor.lng,
            lat: o.anchor.lat,
            altitudeM: o.anchor.altitudeM,
            headingDeg: o.display.headingDeg,
            widthM: o.display.widthM,
            heightM: o.display.heightM,
          });
        }
        // `ambient` is drawn nowhere: it is heard, not seen.
      }

      // The highlighted arrow only helps when you are already facing roughly
      // the right way; the destination marker tells you where to turn when
      // you are not.
      const next = this.store.nextStop();
      if (next) {
        markers.push({
          id: `destination-${next.id}`,
          lng: next.location.lng,
          lat: next.location.lat,
          selected: false,
          kind: 'destination' as const,
        });
      }

      this.viewer.setMarkers(markers);

      // Alignment mode nudges one photograph live, so the author sees the
      // effect of each keypress without a reload. Match by id: matching by
      // position meant only the first photograph could ever be aligned.
      const override = this.store.alignmentOverride();
      this.viewer.setRephotos(
        override
          ? placements.map((r) => (r.id === override.id ? { ...r, ...override.anchor } : r))
          : placements,
      );
    });

    effect(() => this.viewer.setRephotoOpacity(this.store.overlayOpacities()));

    effect(() => this.viewer.setDestinationBearing(this.store.bearingToNextStop()));
  }
}
