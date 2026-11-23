import { HttpErrorResponse } from '@angular/common/http';
import { DOCUMENT } from '@angular/common';
import { Component, computed, DestroyRef, effect, ElementRef, inject, signal } from '@angular/core';
import { Title } from '@angular/platform-browser';
import { ConfigStore } from '../core/config-store';
import { cssVariablesFor, resolveTheme } from '../core/theme';
import { TourApi } from '../core/tour-api';
import { TourStore } from '../core/tour-store';
import { MapPane } from '../map/map-pane';
import { PanoramaPane } from '../panorama/panorama-pane';
import { StopPanel } from '../stop/stop-panel';

@Component({
  selector: 'app-viewer-page',
  imports: [MapPane, PanoramaPane, StopPanel],
  templateUrl: './viewer-page.html',
  styleUrl: './viewer-page.css',
})
export class ViewerPage {
  private readonly api = inject(TourApi);
  private readonly config = inject(ConfigStore);
  private readonly document = inject(DOCUMENT);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  protected readonly store = inject(TourStore);
  /** Public: Task 4 hands it to the map and the panorama. */
  readonly resolved = computed(() => resolveTheme(this.store.tour()?.theme));
  protected readonly ready = signal(false);
  protected readonly error = signal<string | null>(null);

  constructor() {
    if (typeof window !== 'undefined' && location.search.includes('diag=1')) {
      // Diagnostics only: lets tour state be watched while walking the street.
      (window as unknown as { __tour?: unknown }).__tour = this.store;
    }
    // On the viewer's own element, never :root. EntryPage routes from this
    // page to /edit within one page load, so tokens on the document would
    // outlive the viewer and sit there while the editor is on screen.
    effect(() => {
      const r = this.resolved();
      const el = this.host.nativeElement;
      for (const [name, value] of Object.entries(cssVariablesFor(r))) {
        el.style.setProperty(name, value);
      }
      // Not a colour, so cssVariablesFor does not carry it.
      el.style.setProperty('--type-scale', String(r.scaleFactor));
      el.setAttribute('data-layout', r.layout);
      el.setAttribute('data-type-pairing', r.typePairing);
    });
    this.bindFavicon(inject(DestroyRef));
    this.bindTitle(inject(DestroyRef));
    void this.bootstrap();
  }

  /**
   * The one thing the viewer must put on the document, since a favicon lives
   * in the head. For the same reason as the tokens above (EntryPage routes to
   * /edit within one page load), it is put back when the viewer is destroyed.
   */
  private bindFavicon(destroyRef: DestroyRef): void {
    let original: { href: string | null; type: string | null } | null = null;
    const link = () => this.document.head.querySelector<HTMLLinkElement>('link[rel~="icon"]');
    effect(() => {
      const icon = this.store.tour()?.icon;
      const el = link();
      if (!icon || !el) return;
      original ??= { href: el.getAttribute('href'), type: el.getAttribute('type') };
      el.setAttribute('href', this.api.mediaUrl(icon));
      el.setAttribute('type', 'image/png');
    });
    destroyRef.onDestroy(() => {
      const el = link();
      if (!original || !el) return;
      for (const [name, value] of Object.entries(original)) {
        if (value === null) el.removeAttribute(name);
        else el.setAttribute(name, value);
      }
    });
  }

  /**
   * The tab is named after the tour, on the preview and the published site
   * alike. Put back on destroy for the same reason as the favicon.
   */
  private bindTitle(destroyRef: DestroyRef): void {
    const title = inject(Title);
    const original = title.getTitle();
    effect(() => {
      const name = this.store.tour()?.title;
      if (name) title.setTitle(name);
    });
    destroyRef.onDestroy(() => title.setTitle(original));
  }

  private async bootstrap(): Promise<void> {
    try {
      const [config, tour] = await Promise.all([
        this.api.getConfig(),
        this.api.getTour(),
      ]);
      this.config.set(config);
      this.store.load(tour);
      this.ready.set(true);
    } catch (err) {
      this.error.set(bootstrapFailureMessage(err));
    }
  }

  protected attribution() {
    return this.config.attribution();
  }

  protected tourTitle() {
    return this.store.tour()?.title ?? '';
  }
}

/**
 * A 404 and a dead connection need opposite fixes, and the viewer used to
 * report both as "is the backend running". A 404 means the backend answered:
 * it is up, but the working directory holds no tour, so `tour-data/` has
 * nothing to serve. Pointing that reader at a server they have already
 * started costs them the whole search.
 *
 * The remedy it names has to be one that still exists, and that has changed
 * once already: this message used to say "open or import one in the editor",
 * which stopped being true when the welcome screen took over creating a tour
 * and the editor's empty state was removed — `/edit` with nothing open now
 * bounces to `/`. The start screen is the remedy, so the message says so.
 * `viewer-page.spec.ts` pins that, because naming a fix that cannot work is
 * the exact defect this message was written to correct.
 */
function bootstrapFailureMessage(err: unknown): string {
  if (err instanceof HttpErrorResponse && err.status === 404) {
    return 'No tour is open. Go to the start screen at / to create one, import a bundle, or open the example.';
  }
  return 'Could not reach the tour service. Is the backend running on port 8000?';
}
