import { DOCUMENT } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import { Component, DestroyRef, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { SessionApi, type SessionSummary } from '../core/session-api';
import { ViewerPage } from '../viewer/viewer-page';
import { WelcomePage } from '../welcome/welcome-page';

/**
 * How long an unmarked page waits before it says so. The line is
 * information, not a decision: the viewer stays hidden, nothing navigates,
 * and the line goes when the answer comes. There is deliberately no deadline
 * anywhere on this page — the deployed authoring host has been measured
 * answering `/api/session` in 12–14 s usually and once in 73.2 s, so any
 * deadline misroutes an author eventually, and an unmarked page *is* the
 * authoring host by contract, where falling back to the viewer helps nobody
 * (the viewer loads `tour-data/` from the same backend).
 */
export const WAITING_NOTICE_MS = 5_000;

/**
 * Whether `publish.py` marked this page as a published site's `index.html`.
 * Presence is the signal (`<html data-published>`, no value). The on-disk
 * `dist/index.html` that the authoring host serves is deliberately unmarked.
 */
export function isPublishedPage(doc: Document): boolean {
  return 'published' in doc.documentElement.dataset;
}

/**
 * What '' resolves to: the one route that has to work out who is asking.
 *
 * Three audiences arrive at the same URL. A member of the public opening a
 * published tour must get the tour. An author with a tour open should land in
 * the editor. An author with nothing open needs a front door — somewhere to
 * import a bundle or open an example — and that is the only one of the three
 * who should ever see a welcome screen. Being asked to import a `.zip`
 * because an author's workbench leaked into a published site is the failure
 * this component exists to prevent.
 *
 * A published site is marked at publish time (see `isPublishedPage`), and a
 * marked page decides 'published' immediately and makes no `/api` request at
 * all. Only an unmarked page — the authoring host — probes `/api/session` to
 * learn whether a tour is open. The viewer is mounted immediately, hidden,
 * and starts its own `tour-data/` fetches concurrently with the probe — the
 * same eager mount '' used to get by being `ViewerPage` itself, for the same
 * reason. A visitor who just navigated here should not wait on a second, sequential
 * round trip before the tour can even begin loading. It is hidden rather
 * than shown because in an authoring checkout with nothing open those
 * fetches 404, and the viewer's "no tour is open" message must not flash up
 * in front of someone we are about to send somewhere else.
 *
 * This component stays small and eager for the same reason. The welcome
 * screen is the lazy chunk: only an author ever reaches it.
 */
@Component({
  selector: 'app-entry-page',
  // WelcomePage is used only inside this template's `@defer` block, which
  // is what lets the compiler turn this static import into a dynamic one
  // and give the welcome screen its own chunk. Using it anywhere outside
  // that block would silently pull it into the eager bundle.
  imports: [ViewerPage, WelcomePage],
  templateUrl: './entry-page.html',
  styleUrl: './entry-page.css',
})
export class EntryPage {
  private readonly session = inject(SessionApi);
  private readonly router = inject(Router);

  /**
   * 'probing' until the probe settles; then 'published' (show the viewer),
   * 'welcome' (show the front door) or 'broken' (the backend answered with a
   * 5xx: say so, show nothing else). A tour being open has no state of its
   * own: the navigation to '/edit' destroys this component, so 'probing' is
   * what it was last, and the viewer stays hidden on the way out — unless
   * that navigation fails, which falls back to 'published'.
   */
  protected readonly decision = signal<'probing' | 'published' | 'welcome' | 'broken'>('probing');

  /** The status of the 5xx behind 'broken', for the message. */
  protected readonly brokenStatus = signal(0);

  /** Whether the probe has been outstanding for `WAITING_NOTICE_MS`. Shown
   * as a line of text and read by nothing else: it decides nothing. */
  protected readonly waiting = signal(false);

  /** Whether this component is still the page. See `probe()`. */
  private gone = false;

  constructor() {
    let notice: ReturnType<typeof setTimeout> | undefined;
    this.stopNotice = () => { clearTimeout(notice); notice = undefined; this.waiting.set(false); };
    inject(DestroyRef).onDestroy(() => { this.gone = true; this.stopNotice(); });
    if (isPublishedPage(inject(DOCUMENT))) {
      this.decision.set('published');
      return;
    }
    notice = setTimeout(() => this.waiting.set(true), WAITING_NOTICE_MS);
    void this.probe();
  }

  /** Clears the waiting-line timer and hides the line; safe to call twice. */
  private readonly stopNotice: () => void;

  /**
   * Only reached on an unmarked page, i.e. the authoring host, which has a
   * backend by definition and may be slow to answer. So there is no deadline:
   * `get()` is called without one and the answer is read three ways.
   *
   * 1. Static-host signatures reveal the viewer at once: a refused or dead
   *    connection (status 0), any 4xx (a plain static host with no SPA
   *    rewrite answers `/api/session` with a 404, and that is exactly the
   *    published case the viewer exists for), or a 200 that is not a
   *    session summary.
   * 2. A session summary routes to the editor or the welcome screen.
   * 3. Any 5xx is 'broken', not static. Cloudflare answers 524 when the
   *    origin outlives its 100 s limit; reading that as "no backend" would
   *    put the viewer in front of an author whose backend is merely
   *    failing. Nothing is revealed and nothing navigates.
   */
  private async probe(): Promise<void> {
    let answer: unknown;
    let failure: unknown;
    try {
      answer = await this.session.get();
    } catch (err) {
      failure = err;
    }
    this.stopNotice();

    // The visitor may have left '' inside the probe window — straight to
    // '/view', say. Deciding on behalf of a component that is no longer the
    // page would at best set a signal nobody reads, and at worst navigate
    // them to '/edit' out of wherever they actually went.
    if (this.gone) return;

    if (failure instanceof HttpErrorResponse && failure.status >= 500) {
      this.brokenStatus.set(failure.status);
      this.decision.set('broken');
      return;
    }
    if (failure !== undefined || !isSessionSummary(answer)) {
      this.decision.set('published');
      return;
    }
    if (answer.open) {
      void this.router.navigate(['/edit']).catch(() => {
        // The editor is a lazy chunk, so this navigation can fail for a
        // reason that has nothing to do with the author: a dropped
        // connection mid-fetch. Without this the page would stay hidden and
        // empty for good, which is the exact failure '' used to have. A
        // backend did answer, so `tour-data/` is being served and the
        // viewer is an honest fallback: the author sees their tour, just
        // not the editor.
        this.decision.set('published');
      });
      return;
    }
    this.decision.set('welcome');
  }
}

/**
 * A 200 is not proof of a backend. A static host with SPA rewriting answers
 * every unknown path with `index.html`, so `/api/session` comes back as a
 * page of HTML with a 200. `HttpClient`'s JSON parsing rejects most of those
 * on its own, but not all of them — a host could answer `null`, or a JSON
 * file that happens to sit at that path — and the cost of believing one is
 * showing the author's workbench to the public. So the shape is checked:
 * only an object carrying a boolean `open` is a session summary.
 */
function isSessionSummary(body: unknown): body is SessionSummary {
  return typeof body === 'object' && body !== null
      && typeof (body as { open?: unknown }).open === 'boolean';
}
