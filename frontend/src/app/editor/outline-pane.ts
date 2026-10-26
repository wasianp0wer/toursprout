import { Component, ElementRef, OnDestroy, computed, inject, signal, viewChild } from '@angular/core';
import { EditorStore } from './editor-store';
import {
  addMediaOverlay, addStop, addTextOverlay, deleteOverlay, deleteStop, defaultsAnswerValid, hasDefaults, mediaKindOf, moveStop,
} from './document-ops';
import { SessionApi } from '../core/session-api';
import { ActiveRecording, RecordingError, formatWarning, startRecording } from './recorder';

type MediaKind = 'image' | 'audio';
type PromptKind = MediaKind | 'text' | 'record';

/** The tour as a list: stops in order, each with its overlays. Thin over EditorStore. */
@Component({
  selector: 'app-outline-pane',
  templateUrl: './outline-pane.html',
  styleUrl: './outline-pane.css',
})
export class OutlinePane implements OnDestroy {
  protected readonly store = inject(EditorStore);
  private readonly api = inject(SessionApi);

  private readonly imageInput = viewChild<ElementRef<HTMLInputElement>>('imageInput');
  private readonly audioInput = viewChild<ElementRef<HTMLInputElement>>('audioInput');

  /** An upload is in flight: the document has not been touched yet. */
  protected readonly busy = signal(false);
  /** Why the last add-media attempt did nothing. Never written to the document. */
  private readonly mediaError = signal<string | null>(null);
  protected readonly error = computed(() => this.mediaError() ?? this.store.lastError());

  /** 'starting' covers the browser's permission prompt. */
  protected readonly recState = signal<'idle' | 'starting' | 'recording'>('idle');
  /** Safari warning for the format this browser records; stays up after the clip is added. */
  protected readonly recFormatNote = signal<string | null>(null);
  private active: ActiveRecording | null = null;

  /** Set while the one-time creator/licence prompt is showing. */
  protected readonly promptKind = signal<PromptKind | null>(null);
  protected readonly promptError = signal<string | null>(null);
  protected readonly creator = signal('');
  protected readonly license = signal('');
  /** The stop chosen when the button was pressed; selection may move during an upload. */
  private targetStopId: string | null = null;

  protected readonly stops = computed(() =>
    [...(this.store.draft()?.stops ?? [])].sort((a, b) => a.order - b.order));

  protected addStop(): void {
    this.store.apply((t) => addStop(t, 'New stop'));
    if (this.store.lastError()) return;
    const stops = this.store.draft()!.stops;
    this.store.select(stops[stops.length - 1].id);
  }

  protected addOverlay(): void {
    const stop = this.store.currentStop();
    const doc = this.store.draft();
    if (!stop || !doc) return;
    this.mediaError.set(null);
    if (!hasDefaults(doc) && !this.store.pendingDefaults()) {
      this.targetStopId = stop.id;
      this.promptError.set(null);
      this.promptKind.set('text');
      return;
    }
    this.addText(stop.id);
  }

  private addText(stopId: string): void {
    const before = new Set(
      this.store.draft()?.stops.find((s) => s.id === stopId)?.overlays.map((o) => o.id) ?? []);
    this.store.apply((t) => addTextOverlay(t, stopId, 'New note', this.store.pendingDefaults() ?? undefined));
    const after = this.store.draft()?.stops.find((s) => s.id === stopId);
    const added = after?.overlays.find((o) => !before.has(o.id));
    if (added) this.store.select(added.id);
    else if (!this.store.lastError()) this.mediaError.set(this.refusalMessage(stopId));
  }

  /** Why addTextOverlay / addMediaOverlay returned the tour unchanged, from what we can see. */
  private refusalMessage(stopId: string): string {
    const doc = this.store.draft();
    if (!doc?.stops.some((s) => s.id === stopId)) {
      return 'That stop no longer exists, so nothing was added.';
    }
    if (!hasDefaults(doc) && !this.store.pendingDefaults()) {
      return 'This tour needs a creator and licence before anything can be added.';
    }
    return 'That could not be added.';
  }

  protected addMedia(kind: MediaKind): void {
    const stop = this.store.currentStop();
    const doc = this.store.draft();
    if (!stop || !doc || this.busy()) return;
    this.mediaError.set(null);
    this.targetStopId = stop.id;
    if (!hasDefaults(doc) && !this.store.pendingDefaults()) {
      this.promptError.set(null);
      this.promptKind.set(kind);
      return;
    }
    this.chooseFile(kind);
  }

  protected submitDefaults(): void {
    const kind = this.promptKind();
    if (!kind) return;
    const creator = this.creator().trim();
    const license = this.license().trim();
    if (!defaultsAnswerValid(creator, license)) {
      this.promptError.set('Enter both a creator and a licence.');
      return;
    }
    this.store.setPendingDefaults({ creator, license });
    this.promptKind.set(null);
    if (kind === 'record') {
      void this.beginRecording();
    } else if (kind === 'text') {
      const stopId = this.targetStopId ?? this.store.currentStop()?.id;
      this.targetStopId = null;
      if (stopId) this.addText(stopId);
    } else {
      this.chooseFile(kind);
    }
  }

  protected record(): void {
    const stop = this.store.currentStop();
    const doc = this.store.draft();
    if (!stop || !doc || this.busy() || this.recState() !== 'idle') return;
    this.mediaError.set(null);
    this.targetStopId = stop.id;
    if (!hasDefaults(doc) && !this.store.pendingDefaults()) {
      this.promptError.set(null);
      this.promptKind.set('record');
      return;
    }
    void this.beginRecording();
  }

  private async beginRecording(): Promise<void> {
    this.recState.set('starting');
    try {
      this.active = await startRecording();
    } catch (err) {
      this.mediaError.set(err instanceof RecordingError ? err.message : 'Recording could not be started.');
      this.recState.set('idle');
      this.targetStopId = null;
      return;
    }
    this.recFormatNote.set(formatWarning(this.active.mimeType));
    this.recState.set('recording');
  }

  protected async stopRecording(): Promise<void> {
    const active = this.active;
    if (!active) return;
    this.active = null;
    this.recState.set('idle');
    let file: File;
    try {
      file = await active.stop();
    } catch (err) {
      this.mediaError.set(err instanceof Error ? err.message : 'The recording failed.');
      this.targetStopId = null;
      return;
    }
    await this.addUploaded('audio', file);
  }

  protected cancelRecording(): void {
    this.active?.cancel();
    this.active = null;
    this.targetStopId = null;
    this.recState.set('idle');
  }

  protected cancelDefaults(): void {
    this.promptKind.set(null);
  }

  private chooseFile(kind: MediaKind): void {
    (kind === 'image' ? this.imageInput() : this.audioInput())?.nativeElement.click();
  }

  /**
   * Upload FIRST, change the document SECOND. `store.apply` is not reached
   * until `uploadMedia` has resolved with a mediaId, so a refused upload (it
   * throws) leaves the draft, undo stack and dirty flag exactly as they were.
   */
  protected async onFile(kind: MediaKind, event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    try { input.value = ''; } catch { /* a file input may refuse; harmless */ }
    const stopId = this.targetStopId ?? this.store.currentStop()?.id ?? null;
    this.targetStopId = null;
    if (!file || !stopId) return;
    await this.addUploaded(kind, file, stopId);
  }

  /** The one upload-then-create path, shared by file choice and recording. */
  private async addUploaded(kind: MediaKind, file: File, knownStop?: string): Promise<void> {
    const stopId = knownStop ?? this.targetStopId ?? this.store.currentStop()?.id ?? null;
    this.targetStopId = null;
    if (!stopId) return;
    this.busy.set(true);
    this.mediaError.set(null);
    let mediaId: string;
    try {
      mediaId = await this.api.uploadMedia(file);
    } catch (err) {
      this.mediaError.set(err instanceof Error ? err.message : 'the upload failed');
      this.busy.set(false);
      return;
    }
    this.busy.set(false);
    const stored = mediaKindOf(mediaId);
    if (stored !== kind) {
      this.mediaError.set(`That file is ${stored ?? 'not a supported type'}, not ${kind}.`);
      return;
    }
    const before = this.store.draft();
    this.store.apply((t) => addMediaOverlay(t, stopId, kind, mediaId, file.name, this.store.pendingDefaults() ?? undefined));
    const after = this.store.draft();
    if (after === before) {
      this.mediaError.set(`${this.refusalMessage(stopId)} The file was uploaded but not added.`);
      return;
    }
    const added = after!.stops.find((s) => s.id === stopId)?.overlays.at(-1);
    if (added) this.store.select(added.id);
  }

  ngOnDestroy(): void {
    this.active?.cancel();
    this.active = null;
  }

  protected remove(): void {
    const id = this.store.selectedId();
    if (!id) return;
    if (this.store.selectedOverlay()) this.store.apply((t) => deleteOverlay(t, id));
    else this.store.apply((t) => deleteStop(t, id));
  }

  protected move(delta: number): void {
    const stop = this.store.selectedStop();
    if (stop) this.store.apply((t) => moveStop(t, stop.id, delta));
  }
}
