/**
 * Microphone recording over MediaRecorder. Nothing here can be heard or
 * seen in tests; what it guarantees, and what the specs prove, is that
 * unsupported browsers and refused microphones produce a clear message,
 * and that the microphone is always released.
 */

export class RecordingError extends Error {}

export interface ActiveRecording {
  /** The container the browser actually chose, e.g. "audio/webm". */
  readonly mimeType: string;
  /** Stop, release the microphone, and return the clip. */
  stop(): Promise<File>;
  /** Stop and release the microphone, discarding the clip. */
  cancel(): void;
}

/** A reason recording cannot work here, or null if it can be attempted. */
export function recordingUnavailable(): string | null {
  if (typeof MediaRecorder === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
    return 'This browser cannot record audio. Use "Add audio" to upload a file instead.';
  }
  return null;
}

/** Whether visitors on Safari can play what this browser records. */
export function safariCanPlay(mimeType: string): boolean {
  return mimeType.startsWith('audio/mp4') || mimeType.startsWith('audio/aac');
}

export function formatWarning(mimeType: string): string | null {
  if (safariCanPlay(mimeType)) return null;
  const name = mimeType.startsWith('audio/ogg') ? 'Ogg' : 'WebM';
  return `This browser records ${name} audio, which Safari cannot play. Visitors using Safari will hear nothing from this clip. `
    + 'For a tour everyone can hear, upload an MP3 or M4A with "Add audio" instead, or record in Safari.';
}

function extensionFor(mimeType: string): string {
  if (mimeType.startsWith('audio/mp4')) return 'm4a';
  if (mimeType.startsWith('audio/ogg')) return 'ogg';
  return 'webm';
}

function describeMicFailure(err: unknown): string {
  const name = (err as { name?: string } | null)?.name;
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'Microphone access was refused. Allow the microphone for this page in your browser settings and try again.';
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    return 'No microphone was found. Connect one and try again.';
  }
  return 'The microphone could not be used. Another application may be holding it.';
}

export async function startRecording(): Promise<ActiveRecording> {
  const unavailable = recordingUnavailable();
  if (unavailable) throw new RecordingError(unavailable);

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    throw new RecordingError(describeMicFailure(err));
  }
  const release = () => stream.getTracks().forEach((t) => t.stop());

  let recorder: MediaRecorder;
  try {
    recorder = new MediaRecorder(stream);
    const chunks: Blob[] = [];
    recorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunks.push(e.data); };
    let finish: (blob: Blob | null) => void = () => undefined;
    const done = new Promise<Blob | null>((resolve) => { finish = resolve; });
    let discard = false;
    recorder.onstop = () => {
      release();
      finish(discard ? null : new Blob(chunks, { type: recorder.mimeType || 'audio/webm' }));
    };
    recorder.onerror = () => { release(); finish(null); };
    recorder.start();
    const mimeType = recorder.mimeType || 'audio/webm';
    const halt = () => {
      if (recorder.state !== 'inactive') recorder.stop();
      else release();
    };
    return {
      mimeType,
      async stop() {
        halt();
        const blob = await done;
        if (!blob || blob.size === 0) throw new RecordingError('Nothing was recorded.');
        return new File([blob], `recording.${extensionFor(mimeType)}`, { type: blob.type });
      },
      cancel() { discard = true; halt(); release(); },
    };
  } catch {
    release();
    throw new RecordingError('Recording could not be started in this browser.');
  }
}
