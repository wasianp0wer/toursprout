import { Component, ElementRef, inject, input, linkedSignal, viewChild } from '@angular/core';
import { EditorStore } from './editor-store';
import { mediaKindOf, replaceOverlayMedia } from './document-ops';
import { SessionApi } from '../core/session-api';
import { TourApi, audioType } from '../core/tour-api';
import type { Overlay } from '../core/tour.models';

type MediaKind = 'image' | 'audio';

/**
 * An image or audio overlay's file, shown in the inspector, with a way to
 * replace it by upload. Replacing changes only the overlay's mediaId: title,
 * credit and everything else stay.
 *
 * The upload comes first and the document second, so a refused upload leaves
 * the draft, the undo stack and the dirty flag as they were. Busy and error
 * belong to the overlay they started on: they reset when another overlay is
 * shown, and a late completion never writes onto a different overlay's field.
 */
@Component({
  selector: 'app-media-field',
  templateUrl: './media-field.html',
  styleUrl: './media-field.css',
})
export class MediaField {
  private readonly store = inject(EditorStore);
  private readonly session = inject(SessionApi);
  protected readonly api = inject(TourApi);
  protected readonly audioType = audioType;

  readonly overlay = input.required<Overlay>();

  private readonly fileInput = viewChild<ElementRef<HTMLInputElement>>('fileInput');

  /** An upload is in flight for the shown overlay: the document has not been touched yet. */
  protected readonly busy = linkedSignal<string, boolean>({ source: () => this.overlay().id, computation: () => false });
  /** Why the last replace did nothing. Never written to the document. */
  protected readonly error = linkedSignal<string, string | null>({ source: () => this.overlay().id, computation: () => null });
  /** The preview could not load the file; resets when the mediaId changes. */
  protected readonly missing = linkedSignal<string, string | null>({ source: () => this.overlay().mediaId ?? '', computation: () => null });

  /** The overlay and kind chosen when the button was pressed; selection may move during an upload. */
  private target: { id: string; kind: MediaKind } | null = null;

  protected get kind(): MediaKind {
    return this.overlay().kind === 'audio' ? 'audio' : 'image';
  }

  /** Remember which overlay this replace is for, then open the file chooser. */
  protected choose(): void {
    if (this.busy()) return;
    const o = this.overlay();
    this.target = { id: o.id, kind: this.kind };
    this.fileInput()?.nativeElement.click();
  }

  /** The chosen file: upload it, then apply it to the overlay the button was pressed on. */
  protected async onFile(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    try { input.value = ''; } catch { /* a file input may refuse; harmless */ }
    const target = this.target ?? { id: this.overlay().id, kind: this.kind };
    this.target = null;
    if (!file) return;
    // Only the field still showing the target overlay may show its state.
    const mine = () => this.overlay().id === target.id;
    if (mine()) { this.busy.set(true); this.error.set(null); }
    let mediaId: string;
    try {
      mediaId = await this.session.uploadMedia(file);
    } catch (err) {
      if (mine()) { this.error.set(err instanceof Error ? err.message : 'the upload failed'); this.busy.set(false); }
      return;
    }
    if (mine()) this.busy.set(false);
    this.applyMedia(target, mediaId, mine);
  }

  /**
   * The document half, for a file already stored. Applied to the captured id
   * whatever is selected now; a refusal leaves the document untouched.
   */
  private applyMedia(target: { id: string; kind: MediaKind }, mediaId: string, mine: () => boolean): void {
    const fail = (message: string) => { if (mine()) this.error.set(message); };
    const stored = mediaKindOf(mediaId);
    if (stored !== target.kind) {
      fail(`That file is ${stored ?? 'not a supported type'}, not ${target.kind}.`);
      return;
    }
    const exists = this.store.draft()?.stops.some((s) => s.overlays.some((o) => o.id === target.id));
    if (!exists) {
      fail('The file was uploaded but not applied.');
      return;
    }
    // The same file again returns the same tour, which adds no undo step.
    this.store.apply((t) => replaceOverlayMedia(t, target.id, mediaId));
  }
}
