import { Injectable, signal } from '@angular/core';
import type { AppConfig, Attribution } from './tour.models';

/** Runtime configuration from the backend. The Mapillary token lives here, never in source. */
@Injectable({ providedIn: 'root' })
export class ConfigStore {
  private readonly _config = signal<AppConfig | null>(null);
  readonly config = this._config.asReadonly();

  set(config: AppConfig): void {
    this._config.set(config);
  }

  mapillaryToken(): string {
    return this._config()?.mapillaryToken ?? '';
  }

  tileUrl(): string {
    return this._config()?.tileUrl ?? '';
  }

  attribution(): Attribution[] {
    return this._config()?.attribution ?? [];
  }
}
