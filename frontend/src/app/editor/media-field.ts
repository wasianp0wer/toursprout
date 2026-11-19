import { Component, ElementRef, OnDestroy, effect, inject, input, linkedSignal, signal, viewChild } from '@angular/core';
import { EditorStore } from './editor-store';
import { mediaKindOf, replaceOverlayMedia } from './document-ops';
import { SessionApi } from '../core/session-api';
import { TourApi, audioType } from '../core/tour-api';
import { ActiveRecording, RecordingError, formatWarning, startRecording } from './recorder';
import type { Overlay } from '../core/tour.models';

type MediaKind = 'image' | 'audio';

/**
 * An image or audio overlay's file, shown in the inspector, with a way to
 * replace it by upload, or for audio by recording a new clip. Replacing
 * changes only the overlay's mediaId: title, credit and everything else stay.
 *
 * The upload comes first and the document second, so a refused upload leaves
 * the draft, the undo stack and the dirty flag as they were. Busy and error
 * belong to the overlay they started on: they reset when another overlay is
 * shown, and a late completion never writes onto a different overlay's field.
 * Showing another overlay while recording discards the recording.
 */
@Component({
  selector: 'app-media-field',
  templateUrl: './media-field.html',
  styleUrl: './media-field.css',
})
export class MediaField implements OnDestroy {
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

  /** 'starting' covers the browser's permission prompt. */
  protected readonly recState = signal<'idle' | 'starting' | 'recording'>('idle');
  /** Safari warning for the format this browser records; goes when another overlay is shown. */
  protected readonly recFormatNote = linkedSignal<string, string | null>({ source: () => this.overlay().id, computation: () => null });
  private active: ActiveRecording | null = null;
  /** Bumped by discard and destroy so a start that resolves late can release itself. */
  private startToken = 0;
  /** The overlay the recording is for, captured when Record was pressed. */
  private recTarget: { id: string; kind: MediaKind } | null = null;

  /** The overlay and kind chosen when the button was pressed; selection may move during an upload. */
  private target: { id: string; kind: MediaKind } | null = null;

  constructor() {
    // The field is reused as the selection moves; a recording must not follow it.
    effect(() => {
      const id = this.overlay().id;
      if (this.recTarget && this.recTarget.id !== id) this.cancelRecording();
    });
  }

  protected get kind(): MediaKind {
    return this.overlay().kind === 'audio' ? 'audio' : 'image';
  }

  /** Remember which overlay this replace is for, then open the file chooser. */
  protected choose(): void {
    if (this.busy() || this.recState() !== 'idle') return;
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
    await this.replaceWith(file, target);
  }

  /** Upload a file, then apply it to the overlay it was started for. */
  private async replaceWith(file: File, target: { id: string; kind: MediaKind }): Promise<void> {
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

  protected record(): void {
    if (this.busy() || this.recState() !== 'idle' || this.kind !== 'audio') return;
    this.error.set(null);
    this.recTarget = { id: this.overlay().id, kind: 'audio' };
    void this.beginRecording();
  }

  /**
   * Ask for the microphone. The permission prompt can outlive the overlay or
   * the component: discard, selection change and destroy bump startToken, so a
   * start that resolves late releases its microphone instead of recording.
   */
  private async beginRecording(): Promise<void> {
    this.recState.set('starting');
    this.recFormatNote.set(null);
    const token = ++this.startToken;
    let started: ActiveRecording;
    try {
      started = await startRecording();
    } catch (err) {
      if (token !== this.startToken) return;
      this.error.set(err instanceof RecordingError ? err.message : 'Recording could not be started.');
      this.recState.set('idle');
      this.recTarget = null;
      return;
    }
    if (token !== this.startToken) {
      // Discarded or destroyed while the permission prompt was open: release the microphone now.
      started.cancel();
      return;
    }
    this.active = started;
    this.recFormatNote.set(formatWarning(started.mimeType));
    this.recState.set('recording');
  }

  protected async stopRecording(): Promise<void> {
    const active = this.active;
    const target = this.recTarget;
    if (!active || !target) return;
    this.active = null;
    this.recTarget = null;
    this.recState.set('idle');
    let file: File;
    try {
      file = await active.stop();
    } catch (err) {
      if (this.overlay().id === target.id) this.error.set(err instanceof Error ? err.message : 'The recording failed.');
      return;
    }
    if (this.overlay().id === target.id) this.recFormatNote.set(formatWarning(file.type));
    await this.replaceWith(file, target);
  }

  protected cancelRecording(): void {
    this.startToken++;
    this.active?.cancel();
    this.active = null;
    this.recTarget = null;
    this.recFormatNote.set(null);
    this.recState.set('idle');
  }

  ngOnDestroy(): void {
    this.startToken++;
    this.active?.cancel();
    this.active = null;
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
