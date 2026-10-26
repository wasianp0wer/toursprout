import { Component, inject, signal } from '@angular/core';
import { Autosave } from './autosave';
import { EditMapPane } from './edit-map-pane';
import { EditPanoramaPane } from './edit-panorama-pane';
import { EditorStore } from './editor-store';
import { InspectorPane } from './inspector-pane';
import { OutlinePane } from './outline-pane';
import { SessionApi } from '../core/session-api';
import { TourApi } from '../core/tour-api';

/**
 * The editor's route shell: load whatever is open (or explain that nothing
 * is, and offer to start something) and keep autosave running underneath.
 *
 * Nothing being open is a normal state here, not an error — a fresh
 * checkout has an empty working directory, and that is not a failure the
 * author needs an actionable message about.
 */
@Component({
  selector: 'app-editor-page',
  imports: [OutlinePane, InspectorPane, EditMapPane, EditPanoramaPane],
  templateUrl: './editor-page.html',
  styleUrl: './editor-page.css',
})
export class EditorPage {
  private readonly sessionApi = inject(SessionApi);
  private readonly tourApi = inject(TourApi);
  protected readonly store = inject(EditorStore);
  protected readonly autosave = inject(Autosave);

  protected readonly loading = signal(true);
  protected readonly open = signal(false);
  protected readonly starting = signal(false);
  protected readonly error = signal<string | null>(null);

  constructor() {
    void this.init();
  }

  private async init(): Promise<void> {
    try {
      const summary = await this.sessionApi.get();
      if (summary.open) await this.openDocument();
    } catch {
      this.error.set('Could not reach the editor service. Is the backend running on port 8000?');
    } finally {
      this.loading.set(false);
    }
  }

  private async openDocument(): Promise<void> {
    const tour = await this.tourApi.getTour();
    this.store.load(tour);
    this.autosave.start();
    this.open.set(true);
  }

  protected async startNewTour(): Promise<void> {
    this.starting.set(true);
    this.error.set(null);
    try {
      await this.sessionApi.newTour('Untitled tour');
      await this.openDocument();
    } catch {
      this.error.set('Could not start a new tour.');
    } finally {
      this.starting.set(false);
    }
  }
}
