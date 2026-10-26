"""Tours that ship with the application, openable in one request.

Getting the hand-authored Old Town Fairfax tour into the editor used to be a
documented procedure: a `curl` to create a session, a `curl` to PUT the
document, and two `cp`s to put the media where the viewer looks for it.
`docs/HANDOFF.md` had to shout about the `cp` step, because forgetting it
produces a tour whose every photograph and narration clip 404s. This module
is that procedure, done once and correctly.

An example is a directory under `content/examples/` holding `example.json`
(what the welcome screen shows) and a frozen `tour.json`. Its media is NOT
frozen with it: `mediaDir` points at the shared `content/media/`, because
`make content` regenerates those files byte-stably under the same names,
whereas it rewrites the document — which is the thing that drifts, and so the
thing worth freezing. Nothing in that pipeline writes to `content/examples/`.

Opening one stages a bundle in a temp directory and hands it to
`Session.replace_from`, so every guarantee import already makes is made here
too and none of them is reimplemented. That routing is also the only correct
one: the document names its media by exact name (`court-1863.jpg`) and by
nested path (`media/pano/pano-historic-courthouse.jpg`), and `media_store`'s
upload path deliberately renames every file to `<slug>-<contenthash><ext>`
and flattens it into `media/`. Through that path the example would arrive with
all nine of its media ids broken.
"""

from __future__ import annotations

import json
import tempfile
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import IO

from .bundle import MEDIA_EXTENSIONS, stage_bundle_root, write_bundle
from .config import Settings
from .session import Session

EXAMPLES_DIRNAME = "examples"
MANIFEST_NAME = "example.json"


class ExampleError(Exception):
    """A shipped example is malformed. The message is shown to the author."""


@dataclass(frozen=True)
class Example:
    """One entry on the welcome screen's shelf."""

    id: str
    title: str
    description: str


def list_examples(cfg: Settings) -> list[Example]:
    """Every example under `content/examples/`, sorted by id.

    A directory with no `example.json` is not an example and is skipped — the
    directory could be anything, including a half-made one. A manifest that IS
    there but is malformed is skipped too, for a reason about the surface this
    feeds rather than about the file: this list is the welcome screen, the
    app's front door, which must read correctly when there are no examples at
    all. Failing the whole list over one bad entry would put a misleading error
    across a screen whose drop zone works perfectly well — and "another
    misleading error message" is the thing this feature exists to remove.
    `open_example` is where a malformed example is refused out loud, because
    there the author has asked for that one by name.
    """
    root = Path(cfg.content_dir) / EXAMPLES_DIRNAME
    if not root.is_dir():
        return []
    examples = []
    for path in sorted(root.iterdir()):
        if not (path / MANIFEST_NAME).is_file():
            continue
        try:
            meta = _read_manifest(path)
            # The directory name is the id: it is what the route's path carries
            # and what `open_example` resolves, and an identifier that appears
            # in a URL gets exactly one source of truth.
            examples.append(Example(
                id=path.name,
                title=_required_str(meta, "title", path),
                description=_required_str(meta, "description", path),
            ))
        except ExampleError:
            continue
    return examples


def open_example(session: Session, cfg: Settings, example_id: str) -> list[str]:
    """Open a shipped example as the session's tour, returning import warnings.

    Raises `KeyError` if there is no such example and `ExampleError` if the
    example itself is malformed; `BundleError` propagates from the import,
    which is the one that can tell the author what is actually wrong with the
    document. Whatever was open is replaced only once the staged bundle has
    validated — that is `read_bundle`'s staging-and-swap, not something this
    function arranges.
    """
    example_dir = _example_dir(cfg, example_id)
    meta = _read_manifest(example_dir)
    content_root = Path(cfg.content_dir).resolve()

    document_path = _inside(
        content_root, example_dir / _required_str(meta, "document", example_dir)
    )
    media_dir = _inside(
        content_root, example_dir / _required_str(meta, "mediaDir", example_dir)
    )
    if not media_dir.is_dir():
        raise ExampleError(f"{example_id}: mediaDir does not exist: {media_dir}")

    try:
        document = json.loads(document_path.read_text())
    except OSError as exc:
        raise ExampleError(f"{example_id}: could not read its document: {exc}") from exc
    except json.JSONDecodeError as exc:
        raise ExampleError(
            f"{example_id}: its document is not valid JSON: {exc}"
        ) from exc

    with tempfile.TemporaryDirectory() as tmp_name:
        tmp = Path(tmp_name)
        root = tmp / "bundle"
        stage_bundle_root(root, document, _media_streams(media_dir))
        zip_path = tmp / "example.zip"
        write_bundle(root, zip_path)
        return session.replace_from(zip_path)


def _example_dir(cfg: Settings, example_id: str) -> Path:
    """Resolve an id to its directory, refusing anything that is not a single
    plain path component.

    The id arrives in a URL path, so this is checked before the filesystem is
    touched with it at all. `_inside` below is the second line of defence, for
    paths the manifest supplies rather than the caller.
    """
    if example_id in ("", ".", "..") or example_id != Path(example_id).name:
        raise KeyError(example_id)
    path = Path(cfg.content_dir) / EXAMPLES_DIRNAME / example_id
    if not (path / MANIFEST_NAME).is_file():
        raise KeyError(example_id)
    return path


def _read_manifest(example_dir: Path) -> dict:
    try:
        meta = json.loads((example_dir / MANIFEST_NAME).read_text())
    except OSError as exc:
        raise ExampleError(
            f"{example_dir.name}: could not read {MANIFEST_NAME}: {exc}"
        ) from exc
    except json.JSONDecodeError as exc:
        raise ExampleError(
            f"{example_dir.name}: {MANIFEST_NAME} is not valid JSON: {exc}"
        ) from exc
    if not isinstance(meta, dict):
        raise ExampleError(f"{example_dir.name}: {MANIFEST_NAME} is not an object")
    return meta


def _required_str(meta: dict, key: str, example_dir: Path) -> str:
    value = meta.get(key)
    if not isinstance(value, str):
        raise ExampleError(
            f"{example_dir.name}: {MANIFEST_NAME} has no string {key!r}"
        )
    return value


def _inside(content_root: Path, path: Path) -> Path:
    """Keep a manifest-supplied relative path inside `content_dir`.

    `document` and `mediaDir` are read from a file, and a file is a thing that
    can be edited: `"mediaDir": "../../.."` would otherwise stage the whole
    repository into a bundle.
    """
    resolved = path.resolve()
    if not resolved.is_relative_to(content_root):
        raise ExampleError(
            f"{path.name} resolves outside the content directory: {resolved}"
        )
    return resolved


def _media_streams(media_dir: Path) -> Iterator[tuple[str, IO[bytes]]]:
    """Every media file under `media_dir`, with its path relative to it.

    The extension filter is what drops `content/media/manifest.json`. That
    file is the media pipeline's own bookkeeping and has never been part of a
    tour; sweeping it in with the rest of the directory is exactly the bug the
    documented `cp content/media/* …` step had, and `read_bundle` would refuse
    the whole bundle over it rather than skip it.

    Each file is opened for exactly as long as `stage_bundle_root` spends
    copying it — the `with` closes as the generator is resumed — so an example
    with a hundred media files does not need a hundred open descriptors.
    """
    for path in sorted(media_dir.rglob("*")):
        if not path.is_file() or path.suffix.lower() not in MEDIA_EXTENSIONS:
            continue
        with path.open("rb") as fh:
            yield path.relative_to(media_dir).as_posix(), fh
