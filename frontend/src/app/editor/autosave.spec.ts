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

  it('clears dirty on a successful save', async () => {
    store.load(tour());
    autosave.start();
    store.apply((t) => addStop(t, 'Second'));
    flush();
    expect(store.dirty()).toBe(true);
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
    expect(store.dirty()).toBe(false);
  });

  it('leaves dirty set when the save is rejected', async () => {
    putTour.mockRejectedValue({ status: 422, error: { detail: 'nope' } });
    store.load(tour());
    autosave.start();
    store.apply((t) => addStop(t, 'Second'));
    flush();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
    expect(store.dirty()).toBe(true);
  });

  // Review Focus 4, concurrency case: the debounce can refire while a save
  // from an earlier edit is still on the wire (a slow network, a slow
  // backend). A naive implementation fires a second, concurrent PUT for a
  // different version of the document; if the server resolves them out of
  // order, the OLDER one wins and silently overwrites the newer one on
  // disk. This must never happen: at most one PUT is ever in flight, and
  // whatever runs next always reads the draft again, so it is never stale.
  it('never lets an older save overwrite a newer one when saves overlap', async () => {
    const sent: unknown[] = [];
    const resolvers: Array<(value: SessionSummary) => void> = [];
    putTour.mockImplementation((doc: unknown) => {
      sent.push(doc);
      return new Promise<SessionSummary>((resolve) => { resolvers.push(resolve); });
    });

    store.load(tour());
    autosave.start();

    store.apply((t) => addStop(t, 'Second'));
    flush();
    vi.advanceTimersByTime(AUTOSAVE_DEBOUNCE_MS);
    expect(putTour).toHaveBeenCalledTimes(1); // save #1 is now in flight

    // A further edit lands while save #1 is still unresolved.
    store.apply((t) => addStop(t, 'Third'));
    flush();
    vi.advanceTimersByTime(AUTOSAVE_DEBOUNCE_MS);
    // The debounce elapsed again, but save #1 has not settled yet: this
    // must NOT have fired a second, concurrent PUT.
    expect(putTour).toHaveBeenCalledTimes(1);

    const latestDraft = store.draft();
    resolvers[0]({ open: true } as SessionSummary); // let save #1 settle
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // Only now does the queued follow-up fire — reading the draft again,
    // so it sends the LATEST version, not the stale one from before.
    expect(putTour).toHaveBeenCalledTimes(2);
    expect(sent[1]).toBe(latestDraft);

    resolvers[1]({ open: true } as SessionSummary);
    await Promise.resolve();
    await Promise.resolve();
    expect(autosave.status()).toBe('idle');
  });

  function pendingPuts() {
    const sent: unknown[] = [];
    const resolvers: Array<(value: SessionSummary) => void> = [];
    putTour.mockImplementation((doc: unknown) => {
      sent.push(doc);
      return new Promise<SessionSummary>((resolve) => { resolvers.push(resolve); });
    });
    return { sent, resolvers };
  }

  async function ticks(n = 6): Promise<void> {
    for (let i = 0; i < n; i++) await Promise.resolve();
  }

  function editAndDebounce(name: string): void {
    store.apply((t) => addStop(t, name));
    flush();
    vi.advanceTimersByTime(AUTOSAVE_DEBOUNCE_MS);
  }

  // An edit that lands while the queued follow-up is itself on the wire must
  // get its own PUT; it must not be folded into a follow-up that already
  // read the draft before the edit.
  it('saves an edit made during the follow-up save\'s flight', async () => {
    const { sent, resolvers } = pendingPuts();
    store.load(tour());
    autosave.start();

    editAndDebounce('Second');
    expect(putTour).toHaveBeenCalledTimes(1); // first flight
    editAndDebounce('Third');
    expect(putTour).toHaveBeenCalledTimes(1);

    resolvers[0]({ open: true } as SessionSummary);
    await ticks();
    expect(putTour).toHaveBeenCalledTimes(2); // follow-up now in flight

    editAndDebounce('Fourth'); // lands during the follow-up's flight
    const newest = store.draft();
    expect(putTour).toHaveBeenCalledTimes(2);

    resolvers[1]({ open: true } as SessionSummary);
    await ticks();
    expect(putTour).toHaveBeenCalledTimes(3);
    expect(sent[2]).toBe(newest);

    resolvers[2]({ open: true } as SessionSummary);
    await ticks();
    expect(store.dirty()).toBe(false);
  });

  it('does not mark clean when the draft changed during the save', async () => {
    const { resolvers } = pendingPuts();
    store.load(tour());
    autosave.start();

    editAndDebounce('Second');
    editAndDebounce('Third'); // changes the draft during flight #1
    resolvers[0]({ open: true } as SessionSummary);
    await ticks();
    // The follow-up is still on the wire, so the newest edit is unsaved.
    expect(putTour).toHaveBeenCalledTimes(2);
    expect(store.dirty()).toBe(true);
  });

  // A save()/flush() slipping into the microtask gap between one save
  // clearing inFlight and the queued follow-up starting must not produce two
  // concurrent PUTs. Sweep the injection point across the gap.
  it.each([0, 1, 2, 3, 4, 5, 6])(
    'never has two PUTs in flight when flush() runs %i microtasks after a save settles',
    async (n) => {
      let live = 0;
      let maxLive = 0;
      const resolvers: Array<(value: SessionSummary) => void> = [];
      putTour.mockImplementation(() => {
        live++;
        maxLive = Math.max(maxLive, live);
        return new Promise<SessionSummary>((resolve) => {
          resolvers.push((v) => { live--; resolve(v); });
        });
      });
      store.load(tour());
      autosave.start();

      editAndDebounce('Second');
      editAndDebounce('Third'); // queues a follow-up
      resolvers[0]({ open: true } as SessionSummary);
      for (let i = 0; i < n; i++) await Promise.resolve();
      void autosave.flush();
      await ticks(10);
      expect(maxLive).toBe(1);
    },
  );
});
