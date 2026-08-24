"""Create metadata-free, size-bounded WebP marketing captures from Playwright PNGs."""

from __future__ import annotations

import argparse
from pathlib import Path

from PIL import Image


EXPECTED_SIZES = {(1440, 900), (390, 844)}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("destination", type=Path)
    parser.add_argument("--max-bytes", type=int, required=True)
    return parser.parse_args()


def optimize(source: Path, destination: Path, max_bytes: int) -> None:
    with Image.open(source) as image:
        size = image.size
        if size not in EXPECTED_SIZES:
            raise SystemExit(f"Unexpected capture dimensions {size} for {source}")
        flattened = image.convert("RGB")

    destination.parent.mkdir(parents=True, exist_ok=True)
    for quality in range(82, 47, -3):
        flattened.save(
            destination,
            format="WEBP",
            quality=quality,
            method=6,
            exact=False,
            exif=b"",
            icc_profile=b"",
            xmp=b"",
        )
        if destination.stat().st_size <= max_bytes:
            return

    raise SystemExit(
        f"Could not keep {destination.name} below {max_bytes} bytes "
        f"(last size: {destination.stat().st_size} bytes)"
    )


if __name__ == "__main__":
    arguments = parse_args()
    optimize(arguments.source, arguments.destination, arguments.max_bytes)
