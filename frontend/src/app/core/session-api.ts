import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom, timeout, type Observable } from 'rxjs';
import type { Tour } from './tour.models';

export interface SessionSummary {
  open: boolean;
  tourId?: string;
  title?: string;
  stopCount?: number;
  mediaCount?: number;
  /** Media files on disk that no stop references. Present once a tour is open. */
  orphanCount?: number;
}

/** A bundled example tour the welcome screen can offer. */
export interface ExampleSummary {
  id: string;
  title: string;
  description: string;
}

/** What opening an example or importing a tour reports back: the new
 * session, plus anything the backend skipped or repaired along the way. */
export interface ImportResult extends SessionSummary {
  warnings?: string[];
}

/** One file of a loose-file import. `path` is relative to the bundle root
 * (`tour.json`, `media/pano/y.jpg`) and is what the server sees as the
 * filename, so it need not match `file.name`. */
export interface LoosePart {
  path: string;
  file: File;
}

/**
 * The editor's half of the backend: what document is open, and writing it
 * back. Separate from TourApi because TourApi must keep working with no
 * backend at all, and nothing here can.
 */
@Injectable({ providedIn: 'root' })
export class SessionApi {
  private readonly http = inject(HttpClient);

  /**
   * What is open, if anything. The one request a caller may need to make
   * against a host that is not a backend at all, so it takes an optional
   * deadline in milliseconds: the entry page probes '/api/session' to find
   * out whether there is a backend, and a static host may simply never
   * answer. The deadline rejects *and* aborts, so a late answer cannot
   * arrive after the caller has given up. The editor passes none — it only
   * runs against a backend, and would rather wait than guess.
   */
  get(timeoutMs?: number): Promise<SessionSummary> {
    const request = this.http.get<SessionSummary>('/api/session');
    return firstValueFrom(
      timeoutMs === undefined ? request : request.pipe(timeout(timeoutMs)));
  }

  putTour(doc: Tour): Promise<SessionSummary> {
    return firstValueFrom(this.http.put<SessionSummary>('/api/session/tour', doc));
  }

  /** Starts a brand-new skeleton tour. Only valid while nothing is open —
   * the welcome screen is the only caller, and the only screen reached with
   * nothing open. */
  newTour(title: string): Promise<SessionSummary> {
    return this.send(this.http.post<SessionSummary>('/api/session/new', { title }));
  }

  /**
   * Upload one file; resolves to the server-chosen `mediaId`. The client
   * never names the stored file. A refusal rejects with an Error carrying
   * the backend's message so the caller can show it verbatim.
   */
  async uploadMedia(file: File): Promise<string> {
    const form = new FormData();
    form.append('file', file, file.name);
    try {
      const res = await firstValueFrom(
        this.http.post<{ mediaId: string }>('/api/session/media', form));
      return res.mediaId;
    } catch (err) {
      throw new Error(sessionMessage(err));
    }
  }

  /** Closes the open tour, returning to the nothing-open state. Rejects if
   * nothing is open. */
  async close(): Promise<SessionSummary> {
    return this.send(this.http.delete<SessionSummary>('/api/session'));
  }

  async listExamples(): Promise<ExampleSummary[]> {
    const body = await this.send(
      this.http.get<{ examples: ExampleSummary[] }>('/api/session/examples'));
    return body.examples;
  }

  /** Opens a bundled example. Rejects with the backend's message when a tour
   * is already open, the id is unknown, or the example is malformed. */
  async openExample(id: string): Promise<ImportResult> {
    return this.send(this.http.post<ImportResult>(
      `/api/session/examples/${encodeURIComponent(id)}`, null));
  }

  /** Imports a tour from a .zip bundle. */
  async importBundle(file: File): Promise<ImportResult> {
    const form = new FormData();
    form.append('file', file, file.name);
    return this.send(this.http.post<ImportResult>('/api/session/import', form));
  }

  /**
   * Imports a tour from loose files. Each part is filed under its `path`, not
   * the File's own name: the multipart filename is the only channel by which
   * `media/pano/y.jpg` keeps its directory on the way to the server.
   */
  async importFiles(parts: LoosePart[]): Promise<ImportResult> {
    const form = new FormData();
    for (const part of parts) form.append('files', part.file, part.path);
    return this.send(this.http.post<ImportResult>('/api/session/import-files', form));
  }

  /**
   * Fetches the tour as a .zip. Resolves with the blob itself so the caller
   * can report its size: a transfer that resolves is the only proof the
   * download happened, since an `<a download>` click signals nothing.
   */
  async exportBundle(): Promise<Blob> {
    try {
      return await firstValueFrom(
        this.http.get('/api/session/export', { responseType: 'blob' }));
    } catch (err) {
      throw new Error(sessionMessage(await readBlobError(err)));
    }
  }

  /** Awaits a request, turning any rejection into an Error that carries the
   * backend's own message. */
  private async send<T>(request: Observable<T>): Promise<T> {
    try {
      return await firstValueFrom(request);
    } catch (err) {
      throw new Error(sessionMessage(err));
    }
  }
}

/**
 * With `responseType: 'blob'` Angular delivers even a JSON error body as a
 * Blob, so `detail` is unreadable until it is parsed back out. Returns the
 * error with `error` replaced by the parsed body when that works, otherwise
 * unchanged.
 */
async function readBlobError(err: unknown): Promise<unknown> {
  if (!(err instanceof HttpErrorResponse) || !(err.error instanceof Blob)) return err;
  try {
    const parsed: unknown = JSON.parse(await err.error.text());
    return new HttpErrorResponse({
      error: parsed, status: err.status, statusText: err.statusText, url: err.url ?? undefined,
    });
  } catch {
    return err;
  }
}

/** The one place a backend refusal becomes a message an author can read:
 * FastAPI's `detail` when there is one, else something sensible for the status.
 * The wording must be true for any session request, not just uploads.
 *
 * `get()` and `putTour()` deliberately do not use it: the entry page has to
 * tell a dead connection, a non-JSON 200 from a static host and a timeout
 * apart by the shape of the failure, which a flattened string would destroy,
 * and autosave has its own `messageFrom` for putTour. */
function sessionMessage(err: unknown): string {
  if (err instanceof HttpErrorResponse) {
    if (err.status === 0) return 'could not reach the server';
    const detail = (err.error as { detail?: unknown } | null)?.detail;
    if (typeof detail === 'string' && detail) return detail;
    if (err.status === 413) return 'that file is too large for the server to accept';
    return `the request failed (${err.status})`;
  }
  return 'the request failed';
}
