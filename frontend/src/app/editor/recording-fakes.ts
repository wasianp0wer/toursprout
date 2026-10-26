import { vi } from 'vitest';

/** Test doubles for MediaRecorder and getUserMedia. They prove control flow, not audio. */
export class FakeMediaRecorder {
  static mimeType = 'audio/webm';
  state: 'inactive' | 'recording' = 'inactive';
  mimeType = FakeMediaRecorder.mimeType;
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public stream: unknown) {}
  start(): void { this.state = 'recording'; }
  stop(): void {
    this.state = 'inactive';
    setTimeout(() => {
      this.ondataavailable?.({ data: new Blob([new Uint8Array([1, 2, 3])]) });
      this.onstop?.();
    }, 0);
  }
}

export interface FakeTrack { stop: ReturnType<typeof vi.fn> }

export function installRecording(opts: { getUserMedia?: () => Promise<unknown>; mimeType?: string } = {}): { tracks: FakeTrack[] } {
  const tracks: FakeTrack[] = [{ stop: vi.fn() }, { stop: vi.fn() }];
  FakeMediaRecorder.mimeType = opts.mimeType ?? 'audio/webm';
  (globalThis as { MediaRecorder?: unknown }).MediaRecorder = FakeMediaRecorder;
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: opts.getUserMedia ?? (() => Promise.resolve({ getTracks: () => tracks })) },
  });
  return { tracks };
}

export function uninstallRecording(): void {
  delete (globalThis as { MediaRecorder?: unknown }).MediaRecorder;
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: undefined });
}
