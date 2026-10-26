import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { EditorStore } from './editor-store';
import {
  creditText, deriveOverlayHeading, legalModesFor, setCreditText, setInWorldField,
  setOverlayAnchor, setOverlayKind, setOverlayMode, setStopTitle, updateOverlay,
  type DisplayMode,
} from './document-ops';
import type { InWorldDisplay, OverlayKind } from '../core/tour.models';

type Num = number | null;

/**
 * Numeric and text fields for the selected stop or overlay. All document
 * changes are delegated to document-ops transforms via store.apply.
 *
 * `manualHeading` is editor-only UI state (overlay ids whose heading the
 * author typed by hand). It is never written to the document.
 */
@Component({
  selector: 'app-inspector-pane',
  imports: [FormsModule],
  templateUrl: './inspector-pane.html',
  styleUrl: './inspector-pane.css',
})
export class InspectorPane {
  protected readonly store = inject(EditorStore);
  protected readonly kinds: readonly OverlayKind[] = ['text', 'image', 'audio'];
  private readonly manualHeading = signal<ReadonlySet<string>>(new Set());

  protected readonly overlay = this.store.selectedOverlay;
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
    return !!o && this.manualHeading().has(o.id);
  });
  protected readonly credit = computed(() => {
    const o = this.overlay();
    return o ? creditText(o.credit) : '';
  });

  private mark(id: string, on: boolean): void {
    const next = new Set(this.manualHeading());
    if (on) next.add(id); else next.delete(id);
    this.manualHeading.set(next);
  }

  protected setAnchor(field: 'lng' | 'lat' | 'altitudeM', v: Num): void {
    const o = this.overlay();
    if (!o || !Number.isFinite(v)) return;
    this.store.apply((t) => setOverlayAnchor(t, o.id, { [field]: v as number }));
  }

  protected setInWorld(field: 'headingDeg' | 'widthM' | 'heightM' | 'opacity', v: Num): void {
    const o = this.overlay();
    if (!o || v === null || !Number.isFinite(v)) return;
    this.store.apply((t) => setInWorldField(t, o.id, { [field]: v }));
    if (field === 'headingDeg') this.mark(o.id, true);
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

  protected setKind(kind: string): void {
    const o = this.overlay();
    if (o) this.store.apply((t) => setOverlayKind(t, o.id, kind as OverlayKind));
  }

  protected setMode(mode: string): void {
    const o = this.overlay();
    if (!o) return;
    this.store.apply((t) => setOverlayMode(t, o.id, mode as DisplayMode, this.store.panoramaPosition()));
    this.mark(o.id, false);
  }

  protected derive(): void {
    const o = this.overlay();
    if (!o || !this.store.panoramaPosition()) return;
    this.store.apply((t) => deriveOverlayHeading(t, o.id, this.store.panoramaPosition()));
    this.mark(o.id, false);
  }
}
