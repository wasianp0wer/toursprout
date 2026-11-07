import { Component, ElementRef, inject, signal, viewChild } from '@angular/core';
import { Router } from '@angular/router';
import { SessionApi, type ExampleSummary, type SessionSummary } from '../core/session-api';
import {
  filesWithPaths, readDroppedFiles, sortDrop, type DroppedFile,
} from './dropped-files';

/**
 * The guides, in the order the author chose. Present and placed, pointing
 * nowhere: by the author's decision they are visible but inert, rather than a
 * stubbed `/guides` route or links into the repository's own markdown, so the
 * eventual handbook has somewhere to land and nothing claims today to lead
 * anywhere. They are rendered as plain text, not anchors, because an anchor
 * that does nothing is a promise the screen cannot keep.
 */
const GUIDE_TITLES = [
  'Getting started',
  'Stops and narration',
  'Placing a photograph',
  'Finding panoramas',
  'Publishing your tour',
] as const;

/**
 * The front door: the only screen that can get a tour into the session.
 *
 * Before this existed, opening the app with nothing open reported a failure
 * and the only way in was a `curl` plus two `cp` commands transcribed out of
 * `docs/HANDOFF.md`. All four ways in are here — drop a bundle, drop a loose
 * `tour.json` with its media, start an empty tour, open an example — and all
 * four end the same way: the session now has a tour, so go to the editor.
 *
 * It is reached only from `EntryPage`, and only once `GET /api/session` has
 * answered that nothing is open, so a backend exists by construction and no
 * member of the public can arrive here. That is why nothing below has a
 * no-backend branch. It is a lazy chunk for the same reason: only an author
 * ever reaches it, and the published site must not download it.
 *
 * Every refusal is shown in the backend's own words. The session routes spend
 * real care on them — "a hidden file cannot be part of a tour:
 * media/.hidden.jpg" names the file and the rule — and a generic "import
 * failed" in their place would throw all of it away.
 */
@Component({
  selector: 'app-welcome-page',
  templateUrl: './welcome-page.html',
  styleUrl: './welcome-page.css',
  // A drag released anywhere but the drop zone is the browser's to handle,
  // and what it does is navigate to the file — on the one screen whose job
  // is a first impression, the app would simply vanish and be replaced by a
  // `.zip` download or a page of raw JSON. The window hears every drag that
  // misses, so the refusal belongs here rather than on the zone. The zone's
  // own handler runs first and does the importing; see `blockStrayDrag`.
  host: {
    '(window:dragover)': 'blockStrayDrag($event)',
    '(window:drop)': 'blockStrayDrag($event)',
  },
})
export class WelcomePage {
  private readonly api = inject(SessionApi);
  private readonly router = inject(Router);

  private readonly picker = viewChild<ElementRef<HTMLInputElement>>('picker');
  private readonly folderPicker = viewChild<ElementRef<HTMLInputElement>>('folderPicker');

  protected readonly guides = GUIDE_TITLES;

  /** The examples the backend has. Empty is the normal state for every author
   * but this one, and the screen must still read correctly. */
  protected readonly examples = signal<ExampleSummary[]>([]);

  /** A request is in flight. Everything on this screen opens a tour, and only
   * one tour can be open, so one flag covers the lot. */
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  /** Dropped files that cannot be part of a tour, by the path the author
   * dropped them under. Not an error: the rest of the drop still went. */
  protected readonly skipped = signal<string[]>([]);
  /** Highlights the drop zone while something is over it. */
  protected readonly over = signal(false);
  protected readonly newTitle = signal('');
  protected readonly recoveryKey = signal('');

  constructor() {
    void this.loadExamples();
  }

  private async loadExamples(): Promise<void> {
    try {
      this.examples.set(await this.api.listExamples());
    } catch (err) {
      // Shown rather than swallowed: "no examples are configured" and "the
      // examples could not be listed" look identical on screen otherwise,
      // and the first is normal while the second is a fault worth reporting.
      this.error.set(messageOf(err));
    }
  }

  protected onDragOver(event: DragEvent): void {
    // Without preventDefault the browser treats the drop as a navigation and
    // opens the dropped file in place of the app.
    event.preventDefault();
    this.over.set(true);
  }

  protected onDragLeave(): void {
    this.over.set(false);
  }

  /**
   * Keep a drag that missed the drop zone from navigating the app away.
   *
   * Only `preventDefault`: a near miss does nothing, and the author tries
   * again on the dashed area, which is the largest element on the screen.
   * Importing from wherever the file happened to land would mean the whole
   * page were a drop target, which is not what the dashed border promises.
   *
   * Two exemptions, because the window hears everything and a guard this
   * broad otherwise charges for drags it was never meant to catch:
   *
   * - A text field is answering the drag itself, and correctly. Dropping
   *   selected text into a box is a thing every other text box on the
   *   machine does, and `[data-new-title]` is a box an author may well drop
   *   a tour's name into. Only for a drag carrying no files, though: a
   *   `.zip` released on the title box is still the navigation this guard
   *   exists to stop, the exemption would leave both of its events
   *   unanswered, and the default for a file dropped on a text input is
   *   browser-dependent. The box is small and the odds are low, but this
   *   has never run in a browser, so it is defended by construction.
   * - A `dragover` answered is the browser's signal that a drop is welcome
   *   here, and it draws the cursor to match. Answering it for a drag that
   *   carries no files made the whole page claim to be droppable — the
   *   opposite of what the dashed border says — so only a file drag gets
   *   that answer. The `drop` stays unconditional: it is the navigation
   *   that has to be stopped, and by then there is nothing to promise.
   */
  protected blockStrayDrag(event: DragEvent): void {
    const target = event.target as HTMLElement | null;
    const files = event.dataTransfer?.types?.includes('Files') ?? false;
    if (!files && /^(input|textarea)$/i.test(target?.tagName ?? '')) return;
    if (event.type === 'dragover' && !files) return;
    event.preventDefault();
  }

  protected async onDrop(event: DragEvent): Promise<void> {
    event.preventDefault();
    this.over.set(false);
    if (this.busy()) return;
    this.reset();
    let dropped: DroppedFile[];
    try {
      dropped = await readDroppedFiles(event.dataTransfer);
    } catch {
      // A folder the browser would not read: unreadable permissions, or a
      // file that disappeared mid-walk. The browse link reads files one at a
      // time and is the way out.
      this.error.set('That folder could not be read. Try choosing the files instead.');
      return;
    }
    await this.ingest(dropped);
  }

  protected browse(): void {
    this.picker()?.nativeElement.click();
  }

  /**
   * The folder half of browsing, and not a convenience. A plain file input
   * gives back a flat list with no `webkitRelativePath`, so a tour whose
   * media sits in `media/pano/` would arrive with its panoramas filed
   * directly under `media/` — and the import would then refuse the drop for
   * media the author thought they had supplied, naming files they cannot
   * find. The directory picker is the only browse path that keeps the
   * nesting the loose-file route exists to carry.
   */
  protected browseFolder(): void {
    this.folderPicker()?.nativeElement.click();
  }

  protected async onPicked(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const dropped = filesWithPaths(input.files);
    // Cleared so that choosing the same files again fires `change` again.
    try { input.value = ''; } catch { /* a file input may refuse; harmless */ }
    if (this.busy()) return;
    this.reset();
    await this.ingest(dropped);
  }

  /**
   * One drop, one import. A single `.zip` is a packaged bundle and goes to
   * the bundle route; anything else is a loose `tour.json` with its media and
   * goes to the loose-file route, filtered first.
   */
  private async ingest(dropped: DroppedFile[]): Promise<void> {
    if (dropped.length === 0) return;
    if (dropped.length === 1 && dropped[0].rel.toLowerCase().endsWith('.zip')) {
      await this.open(() => this.api.importBundle(dropped[0].file));
      return;
    }
    const { parts, skipped, problem } = sortDrop(dropped);
    this.skipped.set(skipped);
    if (problem) {
      // Something `loose_import` would refuse the whole drop over, which this
      // screen could see coming. Posting it anyway would cost the author a
      // round trip to be told, in the server's terms, about a multipart body
      // they never saw.
      this.error.set(problem);
      return;
    }
    await this.open(() => this.api.importFiles(parts));
  }

  protected async newTour(): Promise<void> {
    if (this.busy()) return;
    this.reset();
    // The same forgiving default the editor's empty state used: a title is
    // the one thing a new tour needs, and it is editable the moment the
    // editor opens, so an empty box is not worth refusing over.
    const title = this.newTitle().trim() || 'Untitled tour';
    await this.open(() => this.api.newTour(title));
  }

  /**
   * Reattach to a tour by the key shown in its editor. Trimmed and
   * lower-cased, because the key is copied off paper and the server's
   * whitelist is lowercase hex only: a stray space or a capital is the
   * likeliest mistake and not worth a round trip to be refused for. Anything
   * else wrong with it is the server's to say, in its own words.
   */
  protected async reattach(): Promise<void> {
    if (this.busy()) return;
    const key = this.recoveryKey().trim().toLowerCase();
    if (!key) return;
    this.reset();
    await this.open(() => this.api.reattach(key));
  }

  protected async openExample(id: string): Promise<void> {
    if (this.busy()) return;
    this.reset();
    await this.open(() => this.api.openExample(id));
  }

  /**
   * Run one of the four ways in, then hand off to the editor.
   *
   * The navigation happens only after the call resolves, so a refusal — a
   * 409 because another tab opened something, a bundle that failed
   * validation — leaves the author here, reading why, with the screen's
   * state untouched and the controls live again.
   *
   * A failed *navigation* is the opposite situation and is handled
   * separately. The editor is a lazy chunk, so the hop can fail for a reason
   * that has nothing to do with the author — a connection dropped mid-fetch
   * — and by then the tour IS open. Everything on this screen would now 409,
   * and the browser's own "Failed to fetch dynamically imported module" is
   * exactly the misleading message this feature exists to stop shipping. So
   * say what happened, and deliberately leave `busy` set: it is the one flag
   * every control here consults, so nothing can be used against a session
   * that already has a tour in it. A reload goes straight to the editor,
   * because the entry page's probe will find the tour open.
   */
  private async open(call: () => Promise<SessionSummary>): Promise<void> {
    this.busy.set(true);
    try {
      await call();
    } catch (err) {
      this.error.set(messageOf(err));
      this.busy.set(false);
      return;
    }
    // `navigate` resolving false (a guard refused) strands the author just as
    // thoroughly as it rejecting, and silently, so both land here.
    const arrived = await this.router.navigate(['/edit']).catch(() => false);
    if (!arrived) {
      this.error.set('The tour is open, but the editor could not be loaded. Reload this page to go there — nothing has been lost.');
    }
  }

  private reset(): void {
    this.error.set(null);
    this.skipped.set([]);
  }
}

/** `SessionApi` rejects with an Error whose message is the backend's own
 * `detail`, so there is nothing to translate; the fallback is for a
 * programming fault, which has no message an author could act on. */
function messageOf(err: unknown): string {
  return err instanceof Error && err.message ? err.message : 'That did not work.';
}
