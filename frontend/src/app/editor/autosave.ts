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

  private async save(): Promise<void> {
    const draft = this.store.draft();
    if (!draft) return;
    this._status.set('saving');
    try {
      await this.api.putTour(draft);
      this._status.set('idle');
      this._message.set(null);
    } catch (err) {
      this._status.set('error');
      this._message.set(messageFrom(err));
    }
  }
}
