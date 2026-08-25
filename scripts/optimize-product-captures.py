"""Create paired metadata-free WebP captures from one DPR2 Playwright PNG."""

from __future__ import annotations

import argparse
from pathlib import Path

from PIL import Image


EXPECTED_DPR2_SIZES = {
    (2880, 1800): (1440, 900),
    (780, 1688): (390, 844),
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("v1_destination", type=Path)
    parser.add_argument("v2_destination", type=Path)
    parser.add_argument("--v1-max-bytes", type=int, required=True)
    parser.add_argument("--v2-max-bytes", type=int, required=True)
    return parser.parse_args()


def save_bounded_webp(image: Image.Image, destination: Path, max_bytes: int) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    # UI captures need more headroom than photography so small type and thin
    # borders remain clean when browsers render either density.
    for quality in range(90, 65, -2):
        image.save(
            destination,
            format="WEBP",
            quality=quality,
            method=6,
            exact=False,
            exif=b"",
            icc_profile=b"",
            xmp=b"",
        )
        if destination.stat().st_size < max_bytes:
            return

    raise SystemExit(
        f"Could not keep {destination.name} below {max_bytes} bytes "
        f"(last size: {destination.stat().st_size} bytes)"
    )


def optimize_pair(
    source: Path,
    v1_destination: Path,
    v2_destination: Path,
    v1_max_bytes: int,
    v2_max_bytes: int,
) -> None:
    with Image.open(source) as image:
        size = image.size
        v1_size = EXPECTED_DPR2_SIZES.get(size)
        if v1_size is None:
            raise SystemExit(
                f"Unexpected DPR2 capture dimensions {size} for {source}; "
                f"expected one of {tuple(EXPECTED_DPR2_SIZES)}"
            )
        v2_image = image.convert("RGB")

    v1_image = v2_image.resize(v1_size, Image.Resampling.LANCZOS)
    save_bounded_webp(v2_image, v2_destination, v2_max_bytes)
    save_bounded_webp(v1_image, v1_destination, v1_max_bytes)

    with Image.open(v1_destination) as v1_output, Image.open(v2_destination) as v2_output:
        if v1_output.size != v1_size or v2_output.size != size:
            raise SystemExit(
                f"Generated capture dimensions do not match the source pair: "
                f"v1={v1_output.size}, v2={v2_output.size}"
            )


if __name__ == "__main__":
    arguments = parse_args()
    optimize_pair(
        arguments.source,
        arguments.v1_destination,
        arguments.v2_destination,
        arguments.v1_max_bytes,
        arguments.v2_max_bytes,
    )
