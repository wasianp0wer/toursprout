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
import type { Tour } from '../core/tour.models';

/**
 * Long enough to coalesce a burst of edits (a few keystrokes, several
 * document-ops calls in a row) into one request; short enough that a reload
 * moments later never loses anything real.
 */
export const AUTOSAVE_DEBOUNCE_MS = 500;

export type AutosaveStatus = 'idle' | 'saving' | 'saved' | 'error';

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

  /**
   * Which run of this service a save belongs to. `start()` and `stop()` both
   * bump it, and every save captures it when it is asked for; a save whose
   * generation is no longer the current one may neither start nor report
   * anything.
   *
   * A counter rather than a "stopped" flag, because a request on the wire
   * cannot be recalled and `stop()` deliberately leaves `inFlight` set
   * (nulling it would permit two concurrent PUTs for two versions of the
   * document). With a flag, a PUT for the tour that was just closed could
   * settle AFTER the author had opened another one and `start()` had cleared
   * the flag — and the 409 for the deleted session would then be reported in
   * the NEW tour's editor, which is the same misleading message displaced
   * one tour to the right. A counter never comes back round.
   */
  private generation = 0;

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
    this.generation++;
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

  /**
   * Stop watching, and stop reporting — for closing a tour.
   *
   * This service is providedIn root, so it outlives the editor page. Closing
   * a tour deletes the session it has been saving to, and without this the
   * watcher would go on PUTting the stale draft at a session that is no
   * longer there; the 409 that comes back would paint "Save failed" over a
   * close that worked, which is exactly the misleading message this branch
   * exists to remove. That is also why the close sequence stops autosave
   * BEFORE it deletes the session, not after.
   *
   * A request already on the wire cannot be recalled, so the generation
   * counter silences its outcome as well: what the server says about a tour
   * that is being closed is no longer news the author can act on, good or
   * bad — and it must not be said about the tour they open next either,
   * which is why that guard is a counter and not a flag. Anything queued
   * behind the in-flight save is dropped for the same reason.
   */
  stop(): void {
    this.generation++;
    this.clearTimer();
    this.watcher?.destroy();
    this.watcher = null;
    this.queued = null;
    this._status.set('idle');
    this._message.set(null);
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
    // Captured here, where the save is asked for, so a follow-up chained
    // onto an in-flight save still belongs to the run that wanted it.
    const generation = this.generation;
    if (this.inFlight) {
      if (!this.queued) {
        // `runSave` catches its own errors (see below) and so never
        // rejects, which is what makes chaining with a plain `.then` safe.
        this.queued = this.inFlight.then(() => this.runSave(generation));
      }
      return this.queued;
    }
    return this.runSave(generation);
  }

  /**
   * Calls putTour so that a synchronous throw becomes a rejection. Otherwise
   * the IIFE's `finally` would clear `inFlight` before the outer assignment
   * set it, leaving it non-null forever and save()/runSave() queueing each
   * other in an unbounded microtask loop.
   */
  private callPut(draft: Tour): Promise<unknown> {
    try {
      return Promise.resolve(this.api.putTour(draft));
    } catch (err) {
      return Promise.reject(err);
    }
  }

  /**
   * Does the actual PUT. `queued` is released the moment the follow-up
   * STARTS running (not when it settles), so an edit arriving during its
   * flight queues a genuinely new follow-up instead of being folded into one
   * that already read the draft. Re-checks `inFlight` because a caller can
   * slip in between the previous save clearing it and this running.
   */
  private async runSave(generation: number): Promise<void> {
    this.queued = null;
    // A follow-up chained onto an in-flight save cannot be unchained, so a
    // stop (or a restart) between the two is caught here instead.
    if (generation !== this.generation) return;
    if (this.inFlight) return this.save();
    const draft = this.store.draft();
    if (!draft) return;
    this._status.set('saving');
    this.inFlight = (async () => {
      try {
        await this.callPut(draft);
        // Stopped or restarted mid-flight: this save belongs to a tour that
        // is being closed, so neither its success nor the draft's state is
        // anything to report — least of all against whatever is open now.
        if (generation !== this.generation) return;
        this._message.set(null);
        // Only if nothing newer arrived during the flight; otherwise the
        // follow-up is still owed and the draft is genuinely unsaved.
        this.store.markSaved(draft);
        if (this.store.draft() === draft) {
          this._status.set('saved');
        } else if (!this.store.dirty()) {
          // The draft moved on and came back to the last-saved document (an
          // undo during the flight): `dirty` is false so the watcher will
          // never fire, yet disk holds `draft`, not the current draft. Owe
          // the follow-up here. Chained behind this in-flight save, it
          // re-reads the draft when it starts, like any queued save.
          // (If dirty, the watcher has already scheduled one.)
          void this.save();
        }
      } catch (err) {
        if (generation !== this.generation) return;
        this._status.set('error');
        this._message.set(messageFrom(err));
      } finally {
        this.inFlight = null;
      }
    })();
    await this.inFlight;
  }
}
