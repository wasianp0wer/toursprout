import { HttpErrorResponse } from '@angular/common/http';
import { Component, inject, signal } from '@angular/core';
import { ConfigStore } from '../core/config-store';
import { TourApi } from '../core/tour-api';
import { TourStore } from '../core/tour-store';
import { MapPane } from '../map/map-pane';
import { PanoramaPane } from '../panorama/panorama-pane';
import { StopPanel } from '../stop/stop-panel';

@Component({
  selector: 'app-viewer-page',
  imports: [MapPane, PanoramaPane, StopPanel],
  templateUrl: './viewer-page.html',
  styleUrl: './viewer-page.css',
})
export class ViewerPage {
  private readonly api = inject(TourApi);
  private readonly config = inject(ConfigStore);
  protected readonly store = inject(TourStore);
  protected readonly ready = signal(false);
  protected readonly error = signal<string | null>(null);

  constructor() {
    if (typeof window !== 'undefined' && location.search.includes('diag=1')) {
      // Diagnostics only: lets tour state be watched while walking the street.
      (window as unknown as { __tour?: unknown }).__tour = this.store;
    }
    void this.bootstrap();
  }

  private async bootstrap(): Promise<void> {
    try {
      const [config, tour] = await Promise.all([
        this.api.getConfig(),
        this.api.getTour(),
      ]);
      this.config.set(config);
      this.store.load(tour);
      this.ready.set(true);
    } catch (err) {
      this.error.set(bootstrapFailureMessage(err));
    }
  }

  protected attribution() {
    return this.config.attribution();
  }

  protected tourTitle() {
    return this.store.tour()?.title ?? '';
  }
}

/**
 * A 404 and a dead connection need opposite fixes, and the viewer used to
 * report both as "is the backend running". A 404 means the backend answered:
 * it is up, but the working directory holds no tour, so `tour-data/` has
 * nothing to serve. Pointing that reader at a server they have already
 * started costs them the whole search.
 *
 * The remedy it names has to be one that still exists, and that has changed
 * once already: this message used to say "open or import one in the editor",
 * which stopped being true when the welcome screen took over creating a tour
 * and the editor's empty state was removed — `/edit` with nothing open now
 * bounces to `/`. The start screen is the remedy, so the message says so.
 * `viewer-page.spec.ts` pins that, because naming a fix that cannot work is
 * the exact defect this message was written to correct.
 */
function bootstrapFailureMessage(err: unknown): string {
  if (err instanceof HttpErrorResponse && err.status === 404) {
    return 'No tour is open. Go to the start screen at / to create one, import a bundle, or open the example.';
  }
  return 'Could not reach the tour service. Is the backend running on port 8000?';
}
