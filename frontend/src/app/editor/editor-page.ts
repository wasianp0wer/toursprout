import { HttpErrorResponse } from '@angular/common/http';
import { Component, computed, inject, signal } from '@angular/core';
import { Autosave } from './autosave';
import { EditMapPane } from './edit-map-pane';
import { EditPanoramaPane } from './edit-panorama-pane';
import { EditorStore } from './editor-store';
import { InspectorPane } from './inspector-pane';
import { OutlinePane } from './outline-pane';
import { setTourDescription, setTourTitle } from './document-ops';
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

  /** The only save feedback the author gets, so it says what is true. */
  protected readonly saveLabel = computed(() => {
    switch (this.autosave.status()) {
      case 'saving': return 'Saving…';
      case 'saved': return this.store.dirty() ? 'Unsaved changes' : 'All changes saved';
      case 'error': return 'Save failed';
      default: return this.store.dirty() ? 'Unsaved changes' : 'No changes yet';
    }
  });

  protected readonly loading = signal(true);
  protected readonly open = signal(false);
  protected readonly starting = signal(false);
  protected readonly error = signal<string | null>(null);
  /** What the author types before starting a new tour; the tour's id is slugged from it. */
  protected readonly newTitle = signal('');

  constructor() {
    void this.init();
  }

  private async init(): Promise<void> {
    try {
      const summary = await this.sessionApi.get();
      if (summary.open) await this.openDocument();
    } catch (err) {
      this.error.set(initFailureMessage(err));
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
      await this.sessionApi.newTour(this.newTitle().trim() || 'Untitled tour');
      await this.openDocument();
    } catch {
      this.error.set('Could not start a new tour.');
    } finally {
      this.starting.set(false);
    }
  }

  protected setTitle(v: string): void {
    this.store.apply((t) => setTourTitle(t, v));
  }

  protected setDescription(v: string): void {
    this.store.apply((t) => setTourDescription(t, v));
  }
}

/**
 * Two different failures reached the same message. A dead connection means
 * the backend is not up. A 404 means it answered, and the session says a
 * tour is open, but `tour-data/tour.json` did not arrive — under `ng serve`
 * that is a dev server started before `proxy.conf.json` gained `/tour-data`,
 * since the proxy config is read once at startup. Naming the port in that
 * case sends the reader to a server that is already running.
 */
function initFailureMessage(err: unknown): string {
  if (err instanceof HttpErrorResponse && err.status === 404) {
    return 'A tour is open, but its data could not be read (404 on tour-data/tour.json). Under `ng serve`, restart the dev server so it picks up the /tour-data proxy; otherwise see docs/HANDOFF.md.';
  }
  return 'Could not reach the editor service. Is the backend running on port 8000?';
}
