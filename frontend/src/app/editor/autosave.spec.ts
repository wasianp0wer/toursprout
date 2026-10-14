import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { Autosave, AUTOSAVE_DEBOUNCE_MS } from './autosave';
import { EditorStore } from './editor-store';
import { SessionApi } from '../core/session-api';
import { addStop } from './document-ops';
import { tour } from './test-builders';
import type { SessionSummary } from '../core/session-api';

describe('Autosave', () => {
  let store: EditorStore;
  let autosave: Autosave;
  let putTour: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    putTour = vi.fn(() => Promise.resolve({ open: true } as SessionSummary));
    TestBed.configureTestingModule({
      providers: [
        {
          provide: SessionApi,
          useValue: { putTour, get: vi.fn() } as unknown as SessionApi,
        },
      ],
    });
    store = TestBed.inject(EditorStore);
    autosave = TestBed.inject(Autosave);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function flush(): void {
    TestBed.flushEffects();
  }

  it('does not save when there is no draft', () => {
    autosave.start();
    flush();
    vi.advanceTimersByTime(AUTOSAVE_DEBOUNCE_MS * 2);
    expect(putTour).not.toHaveBeenCalled();
  });

  it('does not save until the debounce elapses', () => {
    store.load(tour());
    autosave.start();
    store.apply((t) => addStop(t, 'Second'));
    flush();
    vi.advanceTimersByTime(AUTOSAVE_DEBOUNCE_MS - 1);
    expect(putTour).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(putTour).toHaveBeenCalledTimes(1);
  });

  it('coalesces several rapid changes into one save', () => {
    store.load(tour());
    autosave.start();
    store.apply((t) => addStop(t, 'Second'));
    flush();
    vi.advanceTimersByTime(100);
    store.apply((t) => addStop(t, 'Third'));
    flush();
    vi.advanceTimersByTime(100);
    store.apply((t) => addStop(t, 'Fourth'));
    flush();
    vi.advanceTimersByTime(AUTOSAVE_DEBOUNCE_MS);
    expect(putTour).toHaveBeenCalledTimes(1);
    expect(putTour).toHaveBeenCalledWith(store.draft());
  });

  it('reports saving then idle around a successful save', async () => {
    let resolvePut!: (value: SessionSummary) => void;
    putTour.mockImplementation(
      () => new Promise<SessionSummary>((resolve) => { resolvePut = resolve; }),
    );
    store.load(tour());
    autosave.start();
    store.apply((t) => addStop(t, 'Second'));
    flush();
    expect(autosave.status()).toBe('idle');
    vi.advanceTimersByTime(AUTOSAVE_DEBOUNCE_MS);
    expect(autosave.status()).toBe('saving');
    resolvePut({ open: true } as SessionSummary);
    await Promise.resolve();
    await Promise.resolve();
    expect(autosave.status()).toBe('idle');
  });

  it('keeps the draft when the save is rejected', async () => {
    putTour.mockRejectedValue({ status: 422, error: { detail: 'invalid document' } });
    store.load(tour());
    autosave.start();
    store.apply((t) => addStop(t, 'Second'));
    flush();
    const before = store.draft();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
    expect(store.draft()).toBe(before);
    expect(autosave.status()).toBe('error');
  });

  it('surfaces the rejection message', async () => {
    putTour.mockRejectedValue({
      status: 422,
      error: { detail: 'a tour must have at least one stop' },
    });
    store.load(tour());
    autosave.start();
    store.apply((t) => addStop(t, 'Second'));
    flush();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
    expect(autosave.message()).toBe('a tour must have at least one stop');
  });

  it('retries on the next change after a rejection', async () => {
    putTour.mockRejectedValueOnce({ status: 422, error: { detail: 'nope' } });
    putTour.mockResolvedValueOnce({ open: true } as SessionSummary);
    store.load(tour());
    autosave.start();
    store.apply((t) => addStop(t, 'Second'));
    flush();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
    expect(autosave.status()).toBe('error');
    expect(putTour).toHaveBeenCalledTimes(1);

    // The next edit — not any spontaneous retry — is what tries again.
    // Must not deadlock: the author who fixes the problem sees it save.
    store.apply((t) => addStop(t, 'Third'));
    flush();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
    expect(putTour).toHaveBeenCalledTimes(2);
    expect(autosave.status()).toBe('idle');
  });

  it('flush saves immediately without waiting for the debounce', async () => {
    store.load(tour());
    autosave.start();
    store.apply((t) => addStop(t, 'Second'));
    flush();
    await autosave.flush();
    expect(putTour).toHaveBeenCalledTimes(1);
    expect(autosave.status()).toBe('idle');
  });
});
