import { afterEach, describe, expect, it, vi } from 'vitest';
import { RecordingError, formatWarning, recordingUnavailable, startRecording } from './recorder';
import { FakeMediaRecorder, installRecording, uninstallRecording } from './recording-fakes';

describe('recorder', () => {
  afterEach(() => uninstallRecording());

  it('reports unavailable, with a way forward, when MediaRecorder is absent', async () => {
    uninstallRecording();
    expect(recordingUnavailable()).toMatch(/cannot record.*upload/i);
    await expect(startRecording()).rejects.toBeInstanceOf(RecordingError);
  });

  it('turns a refused microphone into a message that names permission', async () => {
    installRecording({ getUserMedia: () => Promise.reject(Object.assign(new Error('x'), { name: 'NotAllowedError' })) });
    await expect(startRecording()).rejects.toThrow(/refused/i);
  });

  it('turns a missing microphone into a message that says so', async () => {
    installRecording({ getUserMedia: () => Promise.reject(Object.assign(new Error('x'), { name: 'NotFoundError' })) });
    await expect(startRecording()).rejects.toThrow(/no microphone/i);
  });

  it('stops every track when recording ends, and returns a file', async () => {
    const { tracks } = installRecording();
    const rec = await startRecording();
    expect(tracks.every((t) => t.stop.mock.calls.length === 0)).toBe(true);
    const file = await rec.stop();
    expect(tracks.length).toBeGreaterThan(0);
    for (const t of tracks) expect(t.stop).toHaveBeenCalled();
    expect(file.name).toBe('recording.webm');
    expect(file.size).toBeGreaterThan(0);
  });

  it('stops every track on cancel too', async () => {
    const { tracks } = installRecording();
    const rec = await startRecording();
    rec.cancel();
    for (const t of tracks) expect(t.stop).toHaveBeenCalled();
  });

  it('releases the microphone when the recorder fails to start', async () => {
    const { tracks } = installRecording();
    vi.spyOn(FakeMediaRecorder.prototype, 'start').mockImplementation(() => { throw new Error('boom'); });
    await expect(startRecording()).rejects.toBeInstanceOf(RecordingError);
    for (const t of tracks) expect(t.stop).toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it('warns about Safari for WebM and Ogg but not for MP4', () => {
    expect(formatWarning('audio/webm;codecs=opus')).toMatch(/Safari cannot play/);
    expect(formatWarning('audio/ogg')).toMatch(/Ogg/);
    expect(formatWarning('audio/mp4')).toBeNull();
  });
});
