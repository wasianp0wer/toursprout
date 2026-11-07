import { HttpErrorResponse } from '@angular/common/http';
import { Component, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { Autosave } from './autosave';
import { CloseDialog } from './close-dialog';
import { EditMapPane } from './edit-map-pane';
import { EditPanoramaPane } from './edit-panorama-pane';
import { EditorStore } from './editor-store';
import { InspectorPane } from './inspector-pane';
import { OutlinePane } from './outline-pane';
import { setTourDescription, setTourTitle } from './document-ops';
import { ConfigStore } from '../core/config-store';
import { SessionApi } from '../core/session-api';
import { TourApi } from '../core/tour-api';

/**
 * The editor's route shell: load whatever is open and keep autosave running
 * underneath, plus the one way out — closing the tour.
 *
 * Nothing being open is no longer something this page explains. The welcome
 * screen at '/' owns getting a tour into the session, and an editor that
 * also offered to start one would be a second front door, so arriving here
 * with nothing open simply goes there.
 */
@Component({
  selector: 'app-editor-page',
  imports: [OutlinePane, InspectorPane, EditMapPane, EditPanoramaPane, CloseDialog],
  templateUrl: './editor-page.html',
  styleUrl: './editor-page.css',
})
export class EditorPage {
  private readonly sessionApi = inject(SessionApi);
  private readonly tourApi = inject(TourApi);
  private readonly config = inject(ConfigStore);
  private readonly router = inject(Router);
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
  protected readonly error = signal<string | null>(null);
  /** The close dialog is up. */
  protected readonly closing = signal(false);
  /** Why the close itself failed, if it did. Separate from `error`, which
   * replaces the whole editor: a refused close leaves the tour open and
   * editable, and hiding it behind a fatal message would be a lie. */
  protected readonly closeFailed = signal<string | null>(null);
  /**
   * How many media files the session holds: the one number on the close
   * dialog that cannot be read off the draft, because media lives on disk
   * rather than in the document. Seeded when the tour is opened and re-read
   * when the dialog opens (see `askToClose`), since this is the figure the
   * author is deciding against when they destroy data. Everything else the
   * dialog says comes from the live draft.
   */
  protected readonly mediaCount = signal(0);
  /** The key that names this session on the server, shown so a historian
   * can write it down and get back to the tour if the browser forgets them. */
  protected readonly recoveryKey = signal<string | null>(null);

  constructor() {
    void this.init();
  }

  private async init(): Promise<void> {
    try {
      const summary = await this.sessionApi.get();
      if (!summary.open) {
        // `navigate` resolving false (a guard refused) strands the author as
        // thoroughly as it rejecting, and silently, so both land here. With
        // the empty state gone there is nothing else on this route to see.
        const arrived = await this.router.navigate(['/']).catch(() => false);
        if (!arrived) {
          this.error.set('No tour is open, and the start screen could not be reached. Reload this page to go there.');
        }
        return;
      }
      this.mediaCount.set(summary.mediaCount ?? 0);
      this.recoveryKey.set(summary.recoveryKey ?? null);
      await this.openDocument();
    } catch (err) {
      this.error.set(initFailureMessage(err));
    } finally {
      this.loading.set(false);
    }
  }

  private async openDocument(): Promise<void> {
    // The editor is useful without a basemap, so a failed config request
    // must not stop the document opening; the panes just see empty values.
    const [config, tour] = await Promise.all([
      this.tourApi.getConfig().catch(() => null),
      this.tourApi.getTour(),
    ]);
    if (config) {
      this.config.set(config);
    }
    this.store.load(tour);
    this.autosave.start();
    this.open.set(true);
  }

  /** What the Copy button last did, so success and failure are both visible:
   * silent success is indistinguishable from silent failure, and this is a
   * string the historian may have to retype on another laptop. */
  protected readonly copyState = signal<'idle' | 'copied' | 'failed'>('idle');
  private copyTimer: ReturnType<typeof setTimeout> | undefined;

  protected async copyRecoveryKey(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.recoveryKey() ?? '');
      this.copyState.set('copied');
    } catch {
      // Unavailable or blocked (an insecure context, a denied permission).
      // The field is selectable, so the key can still be copied by hand.
      this.copyState.set('failed');
    }
    clearTimeout(this.copyTimer);
    this.copyTimer = setTimeout(() => this.copyState.set('idle'), 2000);
  }

  protected askToClose(): void {
    this.closeFailed.set(null);
    this.closing.set(true);
    void this.refreshMediaCount();
  }

  /**
   * Re-read the media count for the dialog. Media is uploaded without
   * touching the document, so the figure from when the tour was opened can
   * be out of date by the time the author decides to delete it — and "15
   * media files" when it is really 17 is worst exactly here.
   *
   * Nothing waits for this: the dialog is already up, with the count it has,
   * and the download and the close are unaffected. A failed probe is not
   * news the author can act on, so it is kept rather than reported — saying
   * "the media count could not be checked" on this screen would read as a
   * failure to close. Strictly more accurate than before, and no less
   * reliable.
   */
  private async refreshMediaCount(): Promise<void> {
    try {
      const summary = await this.sessionApi.get();
      if (summary.open && summary.mediaCount !== undefined) {
        this.mediaCount.set(summary.mediaCount);
      }
    } catch {
      // Keep the figure the tour was opened with.
    }
  }

  /**
   * Close the tour, in this order: stop autosave, delete the session, clear
   * the draft, go to the front door.
   *
   * The order is the whole point. Autosave is stopped FIRST because a PUT
   * already on the wire lands on a session this is about to delete, comes
   * back 409, and would put "Save failed" on screen over a close that
   * worked — the misleading message this branch exists to remove. Clearing
   * the draft matters for the same reason: EditorStore is providedIn root
   * and outlives this page, so a closed tour left in it is a tour the next
   * screen can still see.
   *
   * Called only from the close dialog's confirmation, which does not arm
   * until the author has the bundle or has said they do not want it.
   *
   * `closing.set(false)` is FIRST, and that is a decision rather than a
   * consequence of unmount order. Dismissing the dialog before the DELETE
   * means a failed close leaves the author back on the editor with the
   * dialog shut, so a second attempt costs them the export gate again. That
   * is the safe default: re-acknowledging before a second attempt to delete
   * the only copy of their tour is cheap, and an armed dialog left hanging
   * over a close that did not happen is one click from doing it by accident.
   */
  protected async closeTour(): Promise<void> {
    this.closing.set(false);
    this.autosave.stop();
    try {
      await this.sessionApi.close();
    } catch (err) {
      // Nothing was closed, so put the editor back exactly as it was,
      // autosave included: the author's next keystroke must still be saved.
      this.autosave.start();
      this.closeFailed.set(err instanceof Error && err.message ? err.message : 'the request failed');
      return;
    }
    this.store.clear();
    const arrived = await this.router.navigate(['/']).catch(() => false);
    if (!arrived) {
      this.error.set('The tour is closed. Reload this page to go back to the start screen.');
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
