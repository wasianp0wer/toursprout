import { Component, ElementRef, computed, inject, linkedSignal, signal, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { EditorStore } from './editor-store';
import {
  creditText, deriveOverlayHeading, legalKindsFor, legalModesFor, panoramaFixForStop, setCreditText, setInWorldField,
  selectPanorama, setOverlayAnchorKeepingHeading, setStopLocation, setOverlayHeadingManual, setOverlayKind, setOverlayMode, setStopSummary, setStopTitle, updateOverlay,
  type DisplayMode,
} from './document-ops';
import type { InWorldDisplay, OverlayKind } from '../core/tour.models';
import { MapillarySearch, type PanoramaCandidate } from '../core/mapillary-search';
import { ToolsApi, type GeocodeResult } from '../core/tools-api';

type Num = number | null;

/**
 * The number a coordinate field's text commits to, or null when it is not
 * one. `Number`, not `parseFloat`: "38abc" is a typo, not 38. A blank field
 * is null, not the 0 that `Number('')` would make of it.
 */
function parseCoordinate(text: string): number | null {
  const t = text.trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/**
 * Numeric and text fields for the selected stop or overlay. All document
 * changes are delegated to document-ops transforms via store.apply.
 *
 * The manual-heading marker lives on EditorStore (shared with the map's
 * rotation handle) and is never written to the document.
 *
 * Coordinate fields (lng, lat, altitude) are plain text inputs that commit
 * on change (blur, or Enter), not on every keystroke. Most prefixes of a
 * real coordinate ("-", "38.") are not numbers: a number input reports them
 * as "" (so the document never hears them), and committing per keystroke
 * made every prefix that was a number an edit of its own (an undo step, an
 * autosave, a map move), while a refused one (lat 95) left text on screen
 * that the document did not hold. After a commit the field always shows the
 * document's value, so what is on screen is what is saved.
 */
@Component({
  selector: 'app-inspector-pane',
  imports: [FormsModule],
  templateUrl: './inspector-pane.html',
  styleUrl: './inspector-pane.css',
})
export class InspectorPane {
  protected readonly store = inject(EditorStore);
  private readonly tools = inject(ToolsApi);
  private readonly mapillary = inject(MapillarySearch);

  protected readonly overlay = this.store.selectedOverlay;
  protected readonly kinds = computed<OverlayKind[]>(() => {
    const o = this.overlay();
    return o ? legalKindsFor(o) : [];
  });
  /** The reported position, only if it belongs to the selected overlay's stop's panorama. */
  protected readonly fix = computed(() =>
    panoramaFixForStop(this.store.currentStop(), this.store.panoramaPosition()));
  protected readonly stop = this.store.selectedStop;
  protected readonly modes = computed<readonly DisplayMode[]>(() => {
    const o = this.overlay();
    return o ? legalModesFor(o.kind) : [];
  });
  protected readonly inWorld = computed<InWorldDisplay | null>(() => {
    const d = this.overlay()?.display;
    return d?.mode === 'inWorld' ? d : null;
  });
  protected readonly headingOverridden = computed(() => {
    const o = this.overlay();
    return !!o && this.store.manualHeadings().has(o.id);
  });
  protected readonly credit = computed(() => {
    const o = this.overlay();
    return o ? creditText(o.credit) : '';
  });

  private mark(id: string, on: boolean): void {
    this.store.markHeadingManual(id, on);
  }

  protected setAnchor(field: 'lng' | 'lat' | 'altitudeM', input: HTMLInputElement): void {
    const o = this.overlay();
    if (!o) return;
    const v = parseCoordinate(input.value);
    // Enter fires keydown and then change: the second commit sees the same
    // value and must not become a second (empty) undo step.
    if (v !== null && v !== o.anchor[field]) {
      this.store.apply((t) => setOverlayAnchorKeepingHeading(
        t, o.id, { [field]: v }, this.fix(), this.store.manualHeadings()));
    }
    input.value = String(this.overlay()?.anchor[field] ?? input.value);
  }

  protected setInWorld(field: 'widthM' | 'heightM' | 'opacity', v: Num): void {
    const o = this.overlay();
    if (!o || v === null) return;
    this.store.apply((t) => setInWorldField(t, o.id, { [field]: v }));
  }

  /** A typed heading is a manual override, so it passes the same gate as the map's handle. */
  protected setHeading(v: Num): void {
    const o = this.overlay();
    if (!o || v === null) return;
    const before = this.store.draft();
    this.store.apply((t) => setOverlayHeadingManual(t, o.id, v, this.fix()));
    if (this.store.draft() !== before) this.mark(o.id, true);
  }

  protected setText(field: 'title' | 'body', v: string): void {
    const o = this.overlay();
    if (o) this.store.apply((t) => updateOverlay(t, o.id, { [field]: v }));
  }

  protected setCredit(v: string): void {
    const o = this.overlay();
    if (o) this.store.apply((t) => setCreditText(t, o.id, v));
  }

  protected setStopTitle(v: string): void {
    const s = this.stop();
    if (s) this.store.apply((t) => setStopTitle(t, s.id, v));
  }

  protected setStopSummary(v: string): void {
    const s = this.stop();
    if (s) this.store.apply((t) => setStopSummary(t, s.id, v));
  }

  protected setKind(kind: string): void {
    const o = this.overlay();
    if (o) this.store.apply((t) => setOverlayKind(t, o.id, kind as OverlayKind));
  }

  protected setMode(mode: string): void {
    const o = this.overlay();
    if (!o) return;
    const before = this.store.draft();
    this.store.apply((t) => setOverlayMode(t, o.id, mode as DisplayMode, this.fix()));
    if (this.store.draft() !== before) this.mark(o.id, false);
  }

  protected derive(): void {
    const o = this.overlay();
    if (!o || !this.fix()) return;
    this.store.apply((t) => deriveOverlayHeading(t, o.id, this.fix()));
    this.mark(o.id, false);
  }

  // --- placing a stop: location, address lookup, panorama picker -----------

  /** A search in flight; the buttons stay off so results cannot interleave. */
  protected readonly searching = signal(false);
  protected readonly toolError = signal<string | null>(null);
  /**
   * Results are keyed to the stop searched for, and to the location it was
   * searched at: a late reply never shows on another stop, and "N m away"
   * never outlives a move made elsewhere (a ring drag on the map, an undo).
   */
  private readonly found = signal<
    { stopId: string; lng: number; lat: number; panoramas: PanoramaCandidate[] } | null
  >(null);
  protected readonly candidates = computed(() => {
    const f = this.found();
    const s = this.stop();
    return f && s && f.stopId === s.id && f.lng === s.location.lng && f.lat === s.location.lat
      ? f.panoramas : null;
  });

  protected setLocation(field: 'lng' | 'lat', input: HTMLInputElement): void {
    const s = this.stop();
    if (!s) return;
    const v = parseCoordinate(input.value);
    if (v !== null && v !== s.location[field]) {
      const next = { ...s.location, [field]: v };
      const before = this.store.draft();
      // A typed coordinate is no longer the looked-up place, so its OSM
      // reference goes too; the matched name hides itself (see addressMatch).
      this.store.apply((t) => setStopLocation(t, s.id, next.lng, next.lat, null));
      if (this.store.draft() !== before) this.found.set(null); // "near here" no longer is
    }
    input.value = String(this.stop()?.location[field] ?? input.value);
  }

  /**
   * What the last lookup found for a stop: the matched name, or null for no
   * match. Keyed like `found`, and also on the location it left the stop at,
   * so the note goes whenever the stop moves away from it: a typed
   * coordinate, an undo of the lookup.
   */
  private readonly lookedUp = signal<
    { stopId: string; lng: number; lat: number; name: string | null } | null
  >(null);
  protected readonly addressMatch = computed(() => {
    const l = this.lookedUp();
    const s = this.stop();
    return l && s && l.stopId === s.id && l.lng === s.location.lng && l.lat === s.location.lat ? l : null;
  });

  /**
   * The geocoder's matches, waiting for the author to choose one. Keyed like
   * `lookedUp`, on the stop and the location it was at when looked up: a
   * list for another stop, or for a location an undo or a typed coordinate
   * has since left, is stale and never moves anything. Selecting another
   * stop drops it outright (the linkedSignal resets), so it does not come
   * back when the author returns.
   */
  private readonly matches = linkedSignal<string | undefined,
    { stopId: string; lng: number; lat: number; results: GeocodeResult[] } | null>({
    source: () => this.stop()?.id,
    computation: () => null,
  });
  protected readonly addressResults = computed(() => {
    const m = this.matches();
    const s = this.stop();
    return m && s && m.stopId === s.id && m.lng === s.location.lng && m.lat === s.location.lat
      ? m.results : null;
  });
  private readonly addressInput = viewChild<ElementRef<HTMLInputElement>>('address');
  private readonly resultsList = viewChild<ElementRef<HTMLElement>>('results');

  /**
   * List the geocoder's matches under the address field; nothing moves until
   * the author chooses one, even when there is only one, since the first
   * match is often the wrong place of the same name. Nominatim's policy
   * forbids suggestions as the author types, so this runs only on an
   * explicit Look up. A reply for a stop that is no longer selected is
   * dropped whole, error included: the author has moved on.
   */
  protected async lookUpAddress(text: string): Promise<void> {
    const s = this.stop();
    const query = text.trim();
    if (!s || !query || this.searching()) return;
    this.searching.set(true);
    this.toolError.set(null);
    this.lookedUp.set(null);
    this.matches.set(null);
    let results: GeocodeResult[];
    try {
      results = await this.tools.geocode(query);
    } catch (err) {
      if (this.stop()?.id === s.id) {
        this.toolError.set(err instanceof Error ? err.message : 'the address lookup failed');
      }
      return;
    } finally {
      this.searching.set(false);
    }
    if (this.stop()?.id !== s.id) return;
    if (results.length === 0) {
      this.lookedUp.set({ stopId: s.id, ...s.location, name: null });
      return;
    }
    this.matches.set({ stopId: s.id, ...s.location, results });
  }

  /** Move the stop to the chosen match and look for panoramas there, in one step. */
  protected async chooseAddress(match: GeocodeResult): Promise<void> {
    const s = this.stop();
    // Only from the list on screen: a stale one is not a choice the author can see.
    if (!s || !this.addressResults()?.includes(match)) return;
    const { lng, lat, osmRef } = match;
    this.matches.set(null);
    this.store.apply((t) => setStopLocation(t, s.id, lng, lat, osmRef));
    this.found.set(null); // "near here" has moved
    this.lookedUp.set({ stopId: s.id, lng, lat, name: match.name });
    // The clicked button leaves with the list; keep focus in the field, as Escape does.
    this.addressInput()?.nativeElement.focus();
    await this.findPanoramas();
  }

  /** Escape: close the list, and keep focus in the field rather than on a button that is gone. */
  protected closeAddressResults(): void {
    if (!this.addressResults()) return;
    this.matches.set(null);
    this.addressInput()?.nativeElement.focus();
  }

  protected focusFirstAddressResult(): void {
    this.resultsList()?.nativeElement.querySelector<HTMLButtonElement>('button')?.focus();
  }

  protected async findPanoramas(): Promise<void> {
    const s = this.stop();
    if (!s || this.searching()) return;
    await this.search(async () => ({
      stopId: s.id, ...s.location, panoramas: await this.mapillary.panoramas(s.location.lng, s.location.lat),
    }));
  }

  /** The network call completes before anything else: a failure only sets the message. */
  private async search(
    run: () => Promise<NonNullable<ReturnType<typeof this.found>>>,
  ): Promise<void> {
    this.searching.set(true);
    this.toolError.set(null);
    try {
      this.found.set(await run());
    } catch (err) {
      this.toolError.set(err instanceof Error ? err.message : 'the search failed');
    } finally {
      this.searching.set(false);
    }
  }

  /**
   * Choose a panorama. The id written to the document and the position
   * published to the store come from one `selectPanorama` call over this one
   * candidate, so the gate (keyed on imageId) opens with the camera's real
   * position for exactly that image.
   */
  protected usePanorama(candidate: PanoramaCandidate): void {
    const s = this.stop();
    if (!s) return;
    // One candidate in, one {tour, fix} out; nothing is assigned from inside apply.
    const r = selectPanorama(this.store.draft()!, s.id, candidate);
    if (!r) {
      this.toolError.set('That panorama has no usable position, so it was not selected.');
      return;
    }
    this.store.apply(() => r.tour);
    this.store.setPanoramaPosition(r.fix);
    this.toolError.set(null);
  }

  protected captured(at: number | string | null): string {
    if (at === null || at === '') return '';
    const d = new Date(at);
    return Number.isNaN(d.getTime()) ? '' : `, captured ${d.toISOString().slice(0, 10)}`;
  }
}
