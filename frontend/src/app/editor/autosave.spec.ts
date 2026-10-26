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
    expect(autosave.status()).toBe('saved');
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
    expect(autosave.status()).toBe('saved');
  });

  it('flush saves immediately without waiting for the debounce', async () => {
    store.load(tour());
    autosave.start();
    store.apply((t) => addStop(t, 'Second'));
    flush();
    await autosave.flush();
    expect(putTour).toHaveBeenCalledTimes(1);
    expect(autosave.status()).toBe('saved');
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
    expect(autosave.status()).toBe('saved');
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

  // Item 1: `dirty` is derived (draft !== last saved document), so an undo
  // after a successful save is an unsaved change like any other.
  it('persists an undo made after a successful save', async () => {
    store.load(tour());
    autosave.start();
    const original = store.draft();
    store.apply((t) => addStop(t, 'Second'));
    flush();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
    expect(putTour).toHaveBeenCalledTimes(1);
    expect(store.dirty()).toBe(false);

    store.undo();
    flush();
    expect(store.draft()).toBe(original);
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
    expect(putTour).toHaveBeenCalledTimes(2);
    expect(putTour).toHaveBeenLastCalledWith(original);
  });

  // The residual of item 1: an undo back to the saved document WHILE an edit's
  // PUT is in flight makes dirty false, so nothing would ever write the undo.
  it('writes an undo made while the edit it undoes is still in flight', async () => {
    const resolvers: Array<(value: SessionSummary) => void> = [];
    putTour.mockImplementation(
      () => new Promise<SessionSummary>((resolve) => { resolvers.push(resolve); }),
    );
    store.load(tour());
    autosave.start();
    const a = store.draft();
    store.apply((t) => addStop(t, 'Second'));
    flush();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
    expect(putTour).toHaveBeenCalledTimes(1);

    store.undo();
    flush();
    expect(store.draft()).toBe(a);
    expect(store.dirty()).toBe(false);

    resolvers[0]({ open: true } as SessionSummary);
    await vi.advanceTimersByTimeAsync(0);
    // Disk holds B, the draft is A: not "saved" yet.
    expect(autosave.status()).not.toBe('saved');
    expect(putTour).toHaveBeenCalledTimes(2);
    expect(putTour).toHaveBeenLastCalledWith(a);

    resolvers[1]({ open: true } as SessionSummary);
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
    expect(autosave.status()).toBe('saved');
    expect(putTour).toHaveBeenCalledTimes(2);
  });

  it('does not save, mark dirty or push undo for a refused transform', async () => {
    store.load(tour());
    autosave.start();
    // Same reference back is the pure layer's contract for a refusal.
    store.apply((t) => t);
    flush();
    expect(store.dirty()).toBe(false);
    expect(store.canUndo()).toBe(false);
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS * 2);
    expect(putTour).not.toHaveBeenCalled();
  });

  // Item 7: a putTour that throws synchronously used to leave inFlight set
  // forever (finally ran before the outer assignment), after which save()
  // and runSave() re-queued each other in an unbounded microtask loop.
  it('survives a putTour that throws synchronously and saves again on the next edit', async () => {
    putTour.mockImplementationOnce(() => { throw new Error('sync boom'); });
    store.load(tour());
    autosave.start();
    store.apply((t) => addStop(t, 'Second'));
    flush();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
    expect(autosave.status()).toBe('error');
    expect(autosave.message()).toBe('sync boom');
    expect(putTour).toHaveBeenCalledTimes(1);

    store.apply((t) => addStop(t, 'Third'));
    flush();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
    expect(putTour).toHaveBeenCalledTimes(2);
    expect(autosave.status()).toBe('saved');
    expect(store.dirty()).toBe(false);
  });

  it('says nothing has been saved yet until a save lands, then that it was saved', async () => {
    store.load(tour());
    autosave.start();
    expect(autosave.status()).toBe('idle');
    store.apply((t) => addStop(t, 'Second'));
    flush();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
    expect(autosave.status()).toBe('saved');
  });
  // Closing a tour has to be able to switch autosave off. Everything below
  // is about the one thing that must not happen afterwards: a save reporting
  // itself against a session that is no longer there.
  describe('stop', () => {
    it('stops watching the draft, and says nothing is in progress', () => {
      store.load(tour());
      autosave.start();
      autosave.stop();
      store.apply((t) => addStop(t, 'Second'));
      flush();
      vi.advanceTimersByTime(AUTOSAVE_DEBOUNCE_MS * 2);
      expect(putTour).not.toHaveBeenCalled();
      expect(autosave.status()).toBe('idle');
      expect(autosave.message()).toBeNull();
    });

    it('cancels a debounced save that has not fired yet', () => {
      store.load(tour());
      autosave.start();
      store.apply((t) => addStop(t, 'Second'));
      flush();
      vi.advanceTimersByTime(AUTOSAVE_DEBOUNCE_MS - 1);
      autosave.stop();
      vi.advanceTimersByTime(AUTOSAVE_DEBOUNCE_MS);
      expect(putTour).not.toHaveBeenCalled();
    });

    // Review Focus 3. The PUT was already on the wire when the tour was
    // closed, so it lands on a session the close has deleted and the backend
    // 409s it. Reporting that would paint "Save failed" over a close that
    // worked, which is the misleading message this whole branch is about.
    it('does not report a save that fails after it was stopped', async () => {
      const { resolvers } = pendingRejections();
      store.load(tour());
      autosave.start();
      editAndDebounce('Second');
      expect(putTour).toHaveBeenCalledTimes(1);

      autosave.stop();
      resolvers[0]({ status: 409, error: { detail: 'no tour is open' } });
      await ticks();

      expect(autosave.status()).toBe('idle');
      expect(autosave.message()).toBeNull();
    });

    it('clears a failure it had already reported', async () => {
      putTour.mockRejectedValue({ status: 422, error: { detail: 'invalid document' } });
      store.load(tour());
      autosave.start();
      store.apply((t) => addStop(t, 'Second'));
      flush();
      await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
      expect(autosave.status()).toBe('error');

      autosave.stop();
      expect(autosave.status()).toBe('idle');
      expect(autosave.message()).toBeNull();
    });

    it('saves again once restarted', () => {
      store.load(tour());
      autosave.start();
      autosave.stop();
      autosave.start();
      editAndDebounce('Second');
      expect(putTour).toHaveBeenCalledTimes(1);
    });
  });

  /** putTour calls that stay pending until the test rejects them. */
  function pendingRejections() {
    const resolvers: Array<(err: unknown) => void> = [];
    putTour.mockImplementation(
      () => new Promise<SessionSummary>((_resolve, reject) => { resolvers.push(reject); }),
    );
    return { resolvers };
  }
});
