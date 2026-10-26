/**
 * Debounced autosave: watches the editor's draft and writes the whole
 * document back to the open session, so an author's edits survive a reload
 * without an explicit save action.
 *
 * A rejected save (422, an invalid document) must never cost the author
 * their work: `save()` only ever reads the draft, never writes it back to
 * the store, so a failure leaves the draft exactly as it was. The next edit
 * changes the draft, which the watcher below reacts to regardless of
 * whether `dirty` itself changed value — that is what makes the retry
 * automatic rather than a deadlock the author has to notice and work around.
 *
 * At most one `putTour` is ever on the wire at once: a save requested while
 * one is already in flight is deferred until it settles and then retried
 * against whatever the draft has become by then, rather than firing a
 * second, concurrent PUT. Two concurrent PUTs for two different document
 * versions could resolve out of order, letting the older one overwrite the
 * newer one on disk with the author never told.
 */
import { EffectRef, Injectable, Injector, effect, inject, signal } from '@angular/core';
import { EditorStore } from './editor-store';
import { SessionApi } from '../core/session-api';

/**
 * Long enough to coalesce a burst of edits (a few keystrokes, several
 * document-ops calls in a row) into one request; short enough that a reload
 * moments later never loses anything real.
 */
export const AUTOSAVE_DEBOUNCE_MS = 500;

export type AutosaveStatus = 'idle' | 'saving' | 'error';

/**
 * Pulls a human-readable message out of whatever `SessionApi.putTour`
 * rejects with. An Angular `HttpErrorResponse` carries the backend's 422
 * `detail` string in `.error.detail`; anything else falls back to its own
 * message, then to a generic one, so a save never fails silently.
 */
function messageFrom(err: unknown): string {
  if (err && typeof err === 'object') {
    const body = (err as { error?: unknown }).error;
    if (body && typeof body === 'object') {
      const detail = (body as { detail?: unknown }).detail;
      if (typeof detail === 'string' && detail.length > 0) return detail;
    }
    const message = (err as { message?: unknown }).message;
    if (typeof message === 'string' && message.length > 0) return message;
  }
  return 'The save failed.';
}

@Injectable({ providedIn: 'root' })
export class Autosave {
  private readonly store = inject(EditorStore);
  private readonly api = inject(SessionApi);
  private readonly injector = inject(Injector);

  private watcher: EffectRef | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Non-null while a `putTour` is on the wire. Guards against ever having
   * two PUTs in flight at once for two different versions of the document —
   * if the server resolved them out of order, the OLDER one would win and
   * overwrite the newer one on disk, silently.
   */
  private inFlight: Promise<void> | null = null;

  /**
   * At most one save queued behind the in-flight one. Several debounce
   * firings that all land while a save is in flight coalesce into this one
   * follow-up, which reads the draft again when it finally runs — so it
   * always picks up the latest version, however many edits landed while the
   * first save was still pending.
   */
  private queued: Promise<void> | null = null;

  private readonly _status = signal<AutosaveStatus>('idle');
  readonly status = this._status.asReadonly();

  /** The backend's rejection message, surfaced for as long as the save that
   * produced it has not yet been superseded by a successful one. */
  private readonly _message = signal<string | null>(null);
  readonly message = this._message.asReadonly();

  /**
   * Start watching the draft for changes. Idempotent — re-entering the
   * editor page must not stack a second watcher and a second, competing
   * debounce timer on top of the first.
   */
  start(): void {
    if (this.watcher) return;
    this.watcher = effect(
      () => {
        const draft = this.store.draft();
        const dirty = this.store.dirty();
        if (!draft || !dirty) return;
        this.scheduleSave();
      },
      { injector: this.injector },
    );
  }

  /** Save right now, bypassing the debounce — e.g. before navigating away. */
  async flush(): Promise<void> {
    this.clearTimer();
    await this.save();
  }

  private scheduleSave(): void {
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.save();
    }, AUTOSAVE_DEBOUNCE_MS);
  }

  private clearTimer(): void {
    if (this.timer === null) return;
    clearTimeout(this.timer);
    this.timer = null;
  }

  /**
   * Save the current draft — unless one is already in flight, in which
   * case this call is folded into the single queued follow-up (see
   * `queued` above) rather than firing a second, concurrent PUT.
   */
  private save(): Promise<void> {
    if (this.inFlight) {
      if (!this.queued) {
        // `runSave` catches its own errors (see below) and so never
        // rejects, which is what makes chaining with a plain `.then` safe.
        this.queued = this.inFlight.then(() => this.runSave());
      }
      return this.queued;
    }
    return this.runSave();
  }

  /**
   * Does the actual PUT. `queued` is released the moment the follow-up
   * STARTS running (not when it settles), so an edit arriving during its
   * flight queues a genuinely new follow-up instead of being folded into one
   * that already read the draft. Re-checks `inFlight` because a caller can
   * slip in between the previous save clearing it and this running.
   */
  private async runSave(): Promise<void> {
    this.queued = null;
    if (this.inFlight) return this.save();
    const draft = this.store.draft();
    if (!draft) return;
    this._status.set('saving');
    this.inFlight = (async () => {
      try {
        await this.api.putTour(draft);
        this._status.set('idle');
        this._message.set(null);
        // Only if nothing newer arrived during the flight; otherwise the
        // follow-up is still owed and the draft is genuinely unsaved.
        if (this.store.draft() === draft) this.store.markClean();
      } catch (err) {
        this._status.set('error');
        this._message.set(messageFrom(err));
      } finally {
        this.inFlight = null;
      }
    })();
    await this.inFlight;
  }
}
