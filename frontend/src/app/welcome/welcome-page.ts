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
    const { parts, skipped } = sortDrop(dropped);
    this.skipped.set(skipped);
    if (parts.length === 0) {
      // Posting an empty multipart would come back as "the drop has no
      // tour.json", which is true and sounds like the server lost it.
      this.error.set('Nothing in that drop can be part of a tour. A tour needs a tour.json, and its media folder may hold only images and audio.');
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
