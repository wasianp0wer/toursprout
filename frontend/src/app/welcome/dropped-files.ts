/**
 * Turning a drag-and-drop, or a file picker's `FileList`, into a flat list of
 * files that still know where they sat.
 *
 * This is its own file because a dropped *folder* cannot be read from
 * `DataTransfer.files` at all: that list holds only the files, with the
 * directories thrown away. The paths are the point — the repository's own
 * tour references six panoramas as `media/pano/pano-*.jpg`, so a flat list of
 * names would import a document pointing at files that are not where it says.
 * Reading them needs `webkitGetAsEntry`, which is callback-based, recursive
 * and batched, and none of that belongs in a component.
 *
 * It also sorts a drop into the parts of a bundle — see `sortDrop`, which is
 * where `manifest.json` is kept out of the post rather than refused by it.
 *
 * No browser runs in this project's development environment, so every shape
 * here is one a browser produces and a test has to build by hand.
 */
import { DROPPABLE_MEDIA_EXTS } from '../editor/document-ops';
import type { LoosePart } from '../core/session-api';

/** One dropped file and the path it had where the author dropped it from,
 * relative to what they dropped: `tour.json`, `media/pano/p.jpg`. */
export interface DroppedFile {
  rel: string;
  file: File;
}

/** A drop sorted into what can go to the server and what cannot, the latter
 * named by the path the author would recognise. */
export interface SortedDrop {
  parts: LoosePart[];
  skipped: string[];
}

/**
 * Sort a drop into the parts of a bundle and the files that cannot be in one.
 *
 * The filtering happens HERE, before anything is posted, and that is the
 * point of the whole loose-file path. `POST /api/session/import-files`
 * refuses a file it does not recognise and refuses the entire drop with it —
 * correctly; it is the backend's defence in depth. But `content/media/` holds
 * a `manifest.json` beside the photographs, so `cp content/media/*` sweeps it
 * in and a drag of that folder would carry it along. Posting it means the
 * author loses the drop and reads a refusal; filtering it means they keep the
 * drop and read a notice naming the one file left out.
 */
export function sortDrop(dropped: DroppedFile[]): SortedDrop {
  const parts: LoosePart[] = [];
  const skipped: string[] = [];
  for (const { rel, file } of dropped) {
    const path = bundlePathFor(rel);
    if (path === 'tour.json' || DROPPABLE_MEDIA_EXTS.includes(extensionOf(path))) {
      parts.push({ path, file });
    } else {
      skipped.push(rel);
    }
  }
  return { parts, skipped };
}

/**
 * Where a dropped file belongs in a bundle: `tour.json` at the root, anything
 * else under `media/`, keeping whatever directories it had below that.
 *
 * The leading segments up to and including a `media` directory are dropped so
 * that both halves of the same drop land in the same place: dragging the
 * `media` folder gives `media/pano/p.jpg`, dragging its parent gives
 * `content/media/pano/p.jpg`, and the bundle wants `media/pano/p.jpg` from
 * either. A file with no `media` in its path was dropped on its own, and is
 * filed directly under `media/`.
 */
function bundlePathFor(rel: string): string {
  const segments = rel.split('/');
  if (segments[segments.length - 1] === 'tour.json') return 'tour.json';
  const media = segments.indexOf('media');
  return ['media', ...segments.slice(media + 1)].join('/');
}

function extensionOf(path: string): string {
  const dot = path.lastIndexOf('.');
  return dot < 0 ? '' : path.slice(dot).toLowerCase();
}

/**
 * Every file in a drop, with its relative path.
 *
 * `items` is tried first because it is the only way to see a folder. A
 * browser that offers no entry for an item (or no `items` at all) falls back
 * to `files`, where `webkitRelativePath` carries the path if anything does —
 * which is what a `<input type="file">` gives us, and what the fallback
 * exists for.
 */
export async function readDroppedFiles(transfer: DataTransfer | null): Promise<DroppedFile[]> {
  if (!transfer) return [];
  // Synchronously, before the first await: a DataTransfer is emptied the
  // moment the drop handler returns, so the entries must already be in hand
  // by the time this function suspends.
  const entries = Array.from(transfer.items ?? [])
    .map((item) => item.webkitGetAsEntry?.() ?? null)
    .filter((entry): entry is FileSystemEntry => entry !== null);
  if (entries.length === 0) return filesWithPaths(transfer.files);

  const found: DroppedFile[] = [];
  for (const entry of entries) await walk(entry, '', found);
  return found;
}

/** A picker's `FileList` as dropped files. `webkitRelativePath` is set only
 * by a directory picker; for a plain multi-select it is empty and the name is
 * all there is. */
export function filesWithPaths(files: FileList | File[] | null): DroppedFile[] {
  return Array.from(files ?? []).map((file) => ({
    rel: file.webkitRelativePath || file.name,
    file,
  }));
}

async function walk(entry: FileSystemEntry, prefix: string, found: DroppedFile[]): Promise<void> {
  const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
  if (entry.isFile) {
    found.push({ rel, file: await fileOf(entry as FileSystemFileEntry) });
    return;
  }
  // Neither a file nor a directory: a drop of something that is not a file at
  // all (a URL, a chunk of text). Nothing to read, and not an error.
  if (!entry.isDirectory) return;
  for (const child of await readAllEntries(entry as FileSystemDirectoryEntry)) {
    await walk(child, rel, found);
  }
}

function fileOf(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

/**
 * A directory's children. `readEntries` hands them over in batches and
 * signals the end with an empty one, so one call is not enough — Chrome caps
 * a batch at 100 entries, and a tour's media folder can hold more than that.
 */
async function readAllEntries(dir: FileSystemDirectoryEntry): Promise<FileSystemEntry[]> {
  const reader = dir.createReader();
  const all: FileSystemEntry[] = [];
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>(
      (resolve, reject) => reader.readEntries(resolve, reject));
    if (batch.length === 0) return all;
    all.push(...batch);
  }
}
