import { Component, inject, signal } from '@angular/core';
import { AlignMode, alignModeEnabled } from './align/align-mode';
import { ConfigStore } from './core/config-store';
import { TourApi } from './core/tour-api';
import { TourStore } from './core/tour-store';
import { MapPane } from './map/map-pane';
import { PanoramaPane } from './panorama/panorama-pane';
import { StopPanel } from './stop/stop-panel';

const TOUR_ID = 'fairfax-old-town';

@Component({
  selector: 'app-root',
  imports: [AlignMode, MapPane, PanoramaPane, StopPanel],
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App {
  private readonly api = inject(TourApi);
  private readonly config = inject(ConfigStore);
  protected readonly store = inject(TourStore);
  protected readonly ready = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly aligning = alignModeEnabled(
    typeof location === 'undefined' ? '' : location.search,
  );

  constructor() {
    void this.bootstrap();
  }

  private async bootstrap(): Promise<void> {
    try {
      const [config, tour] = await Promise.all([
        this.api.getConfig(),
        this.api.getTour(TOUR_ID),
      ]);
      this.config.set(config);
      this.store.load(tour);
      this.ready.set(true);
    } catch {
      this.error.set('Could not reach the tour service. Is the backend running on port 8000?');
    }
  }

  protected attribution() {
    return this.config.attribution();
  }

  protected tourTitle() {
    return this.store.tour()?.title ?? '';
  }
}
