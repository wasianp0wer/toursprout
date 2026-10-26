import { Component, computed, inject, input, output, signal } from '@angular/core';
import { SessionApi } from '../core/session-api';

/** What the author's browser calls the archive it saves. */
const BUNDLE_NAME = 'tour.zip';

/**
 * The guard in front of closing a tour.
 *
 * The open tour is the working directory and there is no save: closing it
 * deletes the only copy that exists anywhere. So this screen does three
 * things before it will let that happen — it says which tour and what is in
 * it, it offers the bundle as the way to keep it, and it refuses to arm the
 * cold close until the author has either taken the bundle or said in so many
 * words that they do not want it.
 *
 * *Download tour.zip* fetches the archive as a blob rather than linking to
 * it. An `<a download>` click (which is what the top bar's own Export link
 * is, and stays) tells the page nothing: it cannot know whether the author
 * ended up with a file, and nothing can report the archive's size without
 * building it. One request answers both — the transfer resolving is the
 * proof that releases the gate, and `blob.size` is the exact size to show.
 *
 * A bundle that cannot be built does NOT block the close. `GET
 * /api/session/export` answers 409 when the document references media the
 * archive has not got, which is the worst case there is: the working copy is
 * the only copy *and* it cannot be packaged. Refusing to close would leave
 * the author stuck in a tour they cannot leave, so the failure is reported
 * in the backend's own words and the acknowledgement remains the way out —
 * discarding stays possible, but only ever on purpose.
 */
@Component({
  selector: 'app-close-dialog',
  template: `
    <div class="scrim" data-close-dialog role="dialog" aria-modal="true" aria-labelledby="close-dialog-title">
      <section class="panel">
        <h2 id="close-dialog-title">Close “{{ tourTitle() }}”?</h2>
        <p class="warning">
          This tour — {{ stopCount() }} {{ stopCount() === 1 ? 'stop' : 'stops' }}
          and {{ mediaCount() }} media {{ mediaCount() === 1 ? 'file' : 'files' }} —
          exists only here, in this workbench. Nothing else has a copy of it, and
          closing it deletes the working copy for good.
        </p>
        <p class="lead">Download the bundle and you keep everything: it is a tour you can open again.</p>

        <button type="button" class="primary" data-download [disabled]="downloading()" (click)="download()">
          {{ downloading() ? 'Building ' + BUNDLE_NAME + '…' : 'Download ' + BUNDLE_NAME }}
        </button>

        @if (sizeLabel(); as size) {
          <p class="kept" data-size role="status">Saved {{ BUNDLE_NAME }} — {{ size }}.</p>
        }
        @if (exportFailed(); as message) {
          <p class="failed" data-export-failed role="alert">
            The bundle could not be built: {{ message }}. You can still close the
            tour, but then nothing is kept.
          </p>
        }

        <label class="acknowledge">
          <input
            type="checkbox"
            data-acknowledge
            [checked]="acknowledged()"
            (change)="acknowledged.set($any($event.target).checked)"
          />
          I know this tour will be deleted, and I do not want a copy of it.
        </label>

        <div class="actions">
          <button type="button" class="quiet" data-keep-working (click)="cancelled.emit()">
            Keep working
          </button>
          <button
            type="button"
            class="danger"
            data-confirm-close
            [disabled]="!canClose()"
            (click)="closed.emit()"
          >
            Close and delete
          </button>
        </div>
      </section>
    </div>
  `,
  styleUrl: './close-dialog.css',
})
export class CloseDialog {
  private readonly api = inject(SessionApi);

  /** What is about to be deleted, as the editor knows it right now — the
   * live draft's title and stop count, not the session summary's, which went
   * stale the moment the author renamed the tour or added a stop. */
  readonly tourTitle = input('');
  readonly stopCount = input(0);
  readonly mediaCount = input(0);

  /** The author confirmed. The parent does the teardown: this component
   * knows about keeping a copy, not about closing a session. */
  readonly closed = output<void>();
  readonly cancelled = output<void>();

  protected readonly BUNDLE_NAME = BUNDLE_NAME;

  protected readonly downloading = signal(false);
  /** The size of the archive the author now has, or null if they have not
   * got one. Not a boolean, because the size is worth showing: it is the
   * only confirmation that the file is a tour and not an empty stub. */
  private readonly downloadedBytes = signal<number | null>(null);
  protected readonly exportFailed = signal<string | null>(null);
  protected readonly acknowledged = signal(false);

  protected readonly sizeLabel = computed(() => {
    const bytes = this.downloadedBytes();
    return bytes === null ? null : formatBytes(bytes);
  });

  /** Either the author has the bundle, or they have said they do not want
   * it. Nothing else arms the cold close. */
  protected readonly canClose = computed(
    () => this.downloadedBytes() !== null || this.acknowledged(),
  );

  protected async download(): Promise<void> {
    if (this.downloading()) return;
    this.downloading.set(true);
    this.exportFailed.set(null);
    try {
      const blob = await this.api.exportBundle();
      // Handed over first, and only then counted as downloaded: the gate
      // opens because the author has the file, not because a request
      // happened to return 200.
      offerToSave(blob, BUNDLE_NAME);
      this.downloadedBytes.set(blob.size);
    } catch (err) {
      // SessionApi has already dug the backend's `detail` out of the 409's
      // Blob body, so this is the server's own sentence about which media
      // file is missing. Nothing here could put it better.
      this.exportFailed.set(err instanceof Error && err.message ? err.message : 'the export failed');
    } finally {
      this.downloading.set(false);
    }
  }
}

/** Hands a blob to the browser as a download, which needs a URL for it. */
function offerToSave(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  try {
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
  } finally {
    // Revoked on a later task, never here: the browser is still reading the
    // URL when `click()` returns, and pulling it out from under the save
    // cancels it.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

/**
 * The archive's size, as a person reads sizes. Decimal units, matching what
 * a file manager shows, because the only use for this number is comparing it
 * with the file the author will find on disk.
 */
function formatBytes(bytes: number): string {
  if (bytes < 1000) return `${bytes} bytes`;
  if (bytes < 1_000_000) return `${(bytes / 1000).toFixed(1)} kB`;
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}
