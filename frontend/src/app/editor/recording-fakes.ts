import { vi } from 'vitest';

/** Test doubles for MediaRecorder and getUserMedia. They prove control flow, not audio. */
export class FakeMediaRecorder {
  static mimeType = 'audio/webm';
  /** What the recorder reports as its own type ('' simulates browsers that leave it empty). */
  static reported: string | null = null;
  static chunkType = 'audio/webm';
  static supportsMp4 = false;
  static isTypeSupported(t: string): boolean { return FakeMediaRecorder.supportsMp4 && t === 'audio/mp4'; }
  state: 'inactive' | 'recording' = 'inactive';
  mimeType: string;
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public stream: unknown, opts?: { mimeType?: string }) {
    this.mimeType = opts?.mimeType ?? FakeMediaRecorder.reported ?? FakeMediaRecorder.mimeType;
  }
  start(): void { this.state = 'recording'; }
  stop(): void {
    this.state = 'inactive';
    setTimeout(() => {
      this.ondataavailable?.({ data: new Blob([new Uint8Array([1, 2, 3])], { type: FakeMediaRecorder.chunkType }) });
      this.onstop?.();
    }, 0);
  }
}

export interface FakeTrack { stop: ReturnType<typeof vi.fn> }

export function installRecording(opts: { getUserMedia?: () => Promise<unknown>; mimeType?: string; reported?: string; chunkType?: string; supportsMp4?: boolean } = {}): { tracks: FakeTrack[]; stream: unknown } {
  const tracks: FakeTrack[] = [{ stop: vi.fn() }, { stop: vi.fn() }];
  FakeMediaRecorder.mimeType = opts.mimeType ?? 'audio/webm';
  FakeMediaRecorder.reported = opts.reported ?? null;
  FakeMediaRecorder.chunkType = opts.chunkType ?? opts.mimeType ?? 'audio/webm';
  FakeMediaRecorder.supportsMp4 = opts.supportsMp4 ?? false;
  (globalThis as { MediaRecorder?: unknown }).MediaRecorder = FakeMediaRecorder;
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: opts.getUserMedia ?? (() => Promise.resolve({ getTracks: () => tracks })) },
  });
  return { tracks, stream: { getTracks: () => tracks } };
}

export function uninstallRecording(): void {
  delete (globalThis as { MediaRecorder?: unknown }).MediaRecorder;
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: undefined });
}
