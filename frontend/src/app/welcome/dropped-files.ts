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

/** A drop sorted into what can go to the server, what cannot (named by the
 * path the author would recognise), and why the drop cannot go at all. */
export interface SortedDrop {
  parts: LoosePart[];
  skipped: string[];
  /** A reason to post nothing, in words an author can act on, or null. */
  problem: string | null;
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
 *
 * Every check below is a thing `loose_import` refuses the WHOLE drop over, so
 * every one of them has to be answered here or the author pays a round trip
 * to be told something this screen already knew.
 */
export function sortDrop(dropped: DroppedFile[]): SortedDrop {
  const parts: LoosePart[] = [];
  const skipped: string[] = [];
  const taken = new Set<string>();
  let duplicate: string | null = null;

  for (const { rel, file } of dropped) {
    const path = bundlePathFor(rel);
    if (!belongsInATour(path)) {
      skipped.push(rel);
      continue;
    }
    // Two files that would be the same file in the bundle. `stage_loose_bundle`
    // refuses the drop over it ("the drop contains … more than once", "more
    // than one tour.json"), and it is easy to do by accident: dragging
    // `media/` along with the folder that contains it sends every photograph
    // twice, and a folder holding two tours sends two documents.
    if (taken.has(path)) {
      duplicate ??= path;
      continue;
    }
    taken.add(path);
    parts.push({ path, file });
  }
  return { parts, skipped, problem: problemWith(parts, skipped, duplicate) };
}

/**
 * Whether a file at this bundle path can be part of a tour at all.
 *
 * Two rules, and the second is not decoration. `loose_import._media_name`
 * raises "a hidden file cannot be part of a tour" for a dot-prefixed
 * component anywhere in the path, and refuses the whole drop with it. macOS
 * writes an AppleDouble `._court.jpg` beside the real file whenever the media
 * has been on exFAT, FAT or SMB — which is exactly how photographs travel
 * between a scanner, a laptop and an archive — and that sidecar carries the
 * real file's `.jpg`, so an extension test alone waves it through. Spotlight,
 * thumbnail and version-control directories are the same story one level up.
 */
function belongsInATour(path: string): boolean {
  const segments = path.split('/');
  if (segments.some((segment) => segment.startsWith('.'))) return false;
  return path === 'tour.json' || DROPPABLE_MEDIA_EXTS.includes(extensionOf(path));
}

/**
 * Why this drop cannot be posted, or null. These are the refusals this screen
 * can see coming, answered in the author's terms rather than fetched from the
 * server: the backend's wording for them is about the multipart body it
 * received, which is not a thing the author did.
 */
function problemWith(
  parts: LoosePart[], skipped: string[], duplicate: string | null,
): string | null {
  if (parts.length === 0) {
    return 'Nothing in that drop can be part of a tour. A tour needs a tour.json, and its media folder may hold only images and audio.';
  }
  if (duplicate) {
    return duplicate === 'tour.json'
      ? 'That drop has more than one tour.json in it. A tour is one document and one media folder, so drop just the one tour.'
      : `That drop has ${duplicate} in it twice — probably a media folder dropped along with the folder that contains it. Drop one or the other.`;
  }
  if (!parts.some((part) => part.path === 'tour.json')) {
    // The author's own first use: HANDOFF.md tells them to rename
    // `fairfax-old-town.json` to `tour.json`, and dropping the folder
    // un-renamed sends the media on its own. Naming the file they almost
    // certainly meant saves them reading "the drop has no tour.json" from a
    // server that sounds as though it lost their files.
    // Not any .json: one from inside a `media` directory is the content
    // pipeline's `manifest.json`, never the tour's document, and telling the
    // author to rename that would send them to make the drop worse. The
    // document sits beside `media/`, not in it.
    const document = skipped.find((rel) => extensionOf(rel) === '.json'
      && !rel.split('/').includes('media'));
    return document
      ? `That drop has no tour.json in it. A tour's document has to be named exactly tour.json — rename ${document} and drop it again.`
      : 'That drop has no tour.json in it. A tour needs its document, named tour.json, beside its media folder.';
  }
  return null;
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
  for (const entry of entries) await walk(entry, '', found, 0);
  return found;
}

/**
 * Budgets for the walk. A symlink or junction inside a dropped folder that
 * points at one of its own ancestors descends for ever, and the symptom is
 * the worst one available: the tab wedges with the drop handler still
 * pending and the screen doing nothing at all, with no message and nothing
 * to click. Neither limit can be reached by a real tour — the deepest path
 * in the repository's own media is `media/pano/x.jpg`, two levels — so
 * hitting one means something is wrong with the folder, not with the tour.
 */
const MAX_DEPTH = 16;
const MAX_FILES = 2000;

/** A picker's `FileList` as dropped files. `webkitRelativePath` is set only
 * by a directory picker; for a plain multi-select it is empty and the name is
 * all there is. */
export function filesWithPaths(files: FileList | File[] | null): DroppedFile[] {
  return Array.from(files ?? []).map((file) => ({
    rel: file.webkitRelativePath || file.name,
    file,
  }));
}

async function walk(
  entry: FileSystemEntry, prefix: string, found: DroppedFile[], depth: number,
): Promise<void> {
  if (depth > MAX_DEPTH) throw new Error('that folder is nested deeper than a tour can be');
  if (found.length >= MAX_FILES) throw new Error('that folder holds more files than a tour can');
  const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
  if (entry.isFile) {
    found.push({ rel, file: await fileOf(entry as FileSystemFileEntry) });
    return;
  }
  // Neither a file nor a directory: a drop of something that is not a file at
  // all (a URL, a chunk of text). Nothing to read, and not an error.
  if (!entry.isDirectory) return;
  for (const child of await readAllEntries(entry as FileSystemDirectoryEntry)) {
    await walk(child, rel, found, depth + 1);
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
