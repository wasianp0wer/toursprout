import { Component, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { SessionApi, type SessionSummary } from '../core/session-api';
import { ViewerPage } from '../viewer/viewer-page';

/**
 * How long the entry page waits for `/api/session` before deciding there is
 * no backend. A published tour is the built app plus `tour-data/` on a static
 * host, and a static host is free to black-hole an unknown path rather than
 * refuse it. Without a deadline that visitor would stare at a hidden viewer
 * until the browser's own connection timeout — minutes, on some networks.
 *
 * Two seconds is long enough that a backend on localhost, or one still
 * starting up, always wins the race, and short enough that a visitor who
 * loses it does not read the page as broken.
 */
export const SESSION_PROBE_TIMEOUT_MS = 2000;

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
 * A published site has no backend, so whether `/api/session` answers is the
 * only signal that separates "authoring" from "published". That makes the
 * probe unavoidable, which leaves one problem: the public visitor must not
 * pay for it. So the viewer is mounted immediately, hidden, and starts its
 * own `tour-data/` fetches concurrently with the probe — the same eager
 * mount '' used to get by being `ViewerPage` itself, for the same reason. A
 * visitor who just navigated here should not wait on a second, sequential
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
  imports: [ViewerPage],
  templateUrl: './entry-page.html',
  styleUrl: './entry-page.css',
})
export class EntryPage {
  private readonly session = inject(SessionApi);
  private readonly router = inject(Router);

  /**
   * 'probing' until the probe settles; then 'published' (show the viewer) or
   * 'welcome' (show the front door). A tour being open has no state of its
   * own: the navigation to '/edit' destroys this component, so 'probing' is
   * what it was last, and the viewer stays hidden on the way out.
   */
  protected readonly decision = signal<'probing' | 'published' | 'welcome'>('probing');

  constructor() {
    void this.probe();
  }

  private async probe(): Promise<void> {
    let summary: SessionSummary;
    try {
      summary = await this.session.get(SESSION_PROBE_TIMEOUT_MS);
    } catch {
      // A refusal, a dead connection, a body that would not parse, a
      // deadline: every one of them means no backend answered, and every
      // one of them belongs to the published-site visitor.
      this.decision.set('published');
      return;
    }
    if (!isSessionSummary(summary)) {
      this.decision.set('published');
      return;
    }
    if (summary.open) {
      void this.router.navigate(['/edit']);
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
