"""Generate spoken narration for each stop from its editorial text.

The voice is synthesized, and its credit block says so. Nothing here should be
mistaken for an archival recording.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
MEDIA = REPO / "content" / "media"
SOURCE = REPO / "content" / "source" / "stops.json"
VOICE = "Samantha"

CREDIT = {
    "source": "Synthesized narration, generated for this prototype",
    "url": "https://support.apple.com/guide/mac-help/mchlp2290/mac",
    "license": "Generated for this prototype; not an archival recording",
    "creator": f"macOS speech synthesis, voice {VOICE}",
}


def synth(text: str, dest: Path) -> None:
    aiff = dest.with_suffix(".aiff")
    subprocess.run(["say", "-v", VOICE, "-o", str(aiff), text], check=True)
    subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-i", str(aiff),
         "-c:a", "aac", "-b:a", "96k", str(dest)],
        check=True)
    aiff.unlink()


def main() -> int:
    MEDIA.mkdir(parents=True, exist_ok=True)
    manifest_path = MEDIA / "manifest.json"
    manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else {}

    for stop in json.loads(SOURCE.read_text()):
        media_id = f"narration-{stop['id']}.m4a"
        synth(stop["narration"], MEDIA / media_id)
        size = (MEDIA / media_id).stat().st_size
        if size == 0:
            print(f"  {media_id} produced no audio", file=sys.stderr)
            return 1
        manifest[media_id] = {"file": media_id, "credit": CREDIT}
        print(f"  {media_id:<48} {size:>8} bytes")

    manifest_path.write_text(json.dumps(manifest, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
