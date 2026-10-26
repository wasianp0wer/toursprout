import {
  Component, ElementRef, computed, inject, input, output, signal, viewChild,
  type AfterViewInit,
} from '@angular/core';
import { SessionApi } from '../core/session-api';

/** What the author's browser calls the archive it saves. */
const BUNDLE_NAME = 'tour.zip';

/** How long an object URL is left alive after the download is handed over.
 * Long enough for the browser to have read the whole archive; see
 * `offerToSave`. */
const REVOKE_DELAY_MS = 1000;

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
    <div class="scrim">
      <!-- The panel is the dialog; the scrim behind it is only the backdrop.
           tabindex so the dialog itself can hold focus: see ngAfterViewInit. -->
      <section
        #surface
        class="panel"
        data-close-dialog
        role="dialog"
        aria-modal="true"
        aria-labelledby="close-dialog-title"
        tabindex="-1"
      >
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
          <!-- The archive was built and handed to the browser; where it
               went is between the browser and the author. Claiming it was
               saved would overclaim on the one screen whose job is honesty
               about losing data. -->
          <p class="kept" data-size role="status">
            {{ BUNDLE_NAME }} — {{ size }} — check your downloads before closing.
          </p>
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
  // Escape is what everyone reaches for to back out, and on this screen of
  // all screens — it is telling the author their only copy is about to be
  // deleted — it must work. Same effect as *Keep working*: the parent takes
  // the dialog down and nothing has happened. Bound on the document because
  // focus can be inside the panel or on the dialog itself, and both must
  // answer the key. (There is deliberately no focus trap; backing out and
  // being heard by a screen reader are what this covers.)
  host: {
    '(document:keydown.escape)': 'cancelled.emit()',
  },
})
export class CloseDialog implements AfterViewInit {
  private readonly api = inject(SessionApi);

  private readonly surface = viewChild.required<ElementRef<HTMLElement>>('surface');

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

  /**
   * Take focus when the dialog opens — the dialog element itself, not a
   * button, so a screen reader announces what has appeared rather than
   * reading one control out of context, and so Escape reaches it without the
   * author having to click something first. Deliberately not the primary
   * action: focus must not sit on a button at the moment a stray Return
   * could press it.
   */
  ngAfterViewInit(): void {
    this.surface().nativeElement.focus();
  }

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

/**
 * Hands a blob to the browser as a download, which needs a URL for it.
 *
 * The anchor goes into the document before it is clicked and comes out
 * again afterwards. Current browsers activate a detached `download` anchor,
 * but being in the document was a real requirement not long ago and is still
 * why every save-a-blob helper appends and removes — and this code sits
 * directly in front of "delete the only copy", where it is not worth being
 * clever about.
 */
function offerToSave(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.hidden = true;
  document.body.append(link);
  try {
    link.click();
  } finally {
    link.remove();
    // Revoked later, never here: the browser is still reading the URL when
    // `click()` returns, and pulling it out from under a save that is still
    // being written cancels it. A tens-of-megabyte bundle is exactly the
    // case where a tick would not be enough, so the delay is generous — an
    // object URL costs nothing to leave lying around for a second.
    setTimeout(() => URL.revokeObjectURL(url), REVOKE_DELAY_MS);
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
