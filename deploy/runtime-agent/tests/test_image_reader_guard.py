"""Bedrock-safe image_reader (TEAM-3938 crash class).

Bedrock's Converse API rejects any image >8000px on a side with a
ValidationException that aborts the whole agent turn — a persona that reads a
full-page Playwright screenshot dies identically on every retry. main.py wraps
image_reader so oversized files are downscaled (or tiled, for tall pages)
before they ever reach the model.

main.py cannot be imported (module top-level installs Node, fetches S3, chdirs),
so — like tests/test_prompt_cache.py — the pieces under test are extracted from
the shipped source via ast and exec'd in a controlled namespace.
"""

import ast
import io
import os
from pathlib import Path

import pytest
from PIL import Image

MAIN_PY = Path(__file__).resolve().parent.parent / "main.py"
_TREE = ast.parse(MAIN_PY.read_text())

_NAMES = {"_fit_edge", "_encode_image", "prepare_image_blocks", "image_reader"}
_CONSTS = {"IMAGE_MAX_EDGE", "IMAGE_MAX_BYTES", "IMAGE_MAX_TILES", "IMAGE_TILE_ASPECT", "_IMAGE_FORMATS"}

BEDROCK_MAX_PX = 8000
BEDROCK_MAX_BYTES = 3_750_000


def _load():
    body = []
    for node in _TREE.body:
        if isinstance(node, ast.FunctionDef) and node.name in _NAMES:
            node.decorator_list = []  # strip @tool — exercise the plain function
            body.append(node)
        elif isinstance(node, ast.Assign) and any(
            isinstance(t, ast.Name) and t.id in _CONSTS for t in node.targets
        ):
            body.append(node)
    assert {n.name for n in body if isinstance(n, ast.FunctionDef)} == _NAMES
    ns = {"os": os, "tool": lambda f: f}
    exec(compile(ast.Module(body=body, type_ignores=[]), str(MAIN_PY), "exec"), ns)  # noqa: S102
    return ns


@pytest.fixture(scope="module")
def guard():
    return _load()


def _png(path, w, h, color=(30, 120, 200)):
    Image.new("RGB", (w, h), color).save(path, format="PNG")
    return str(path)


def _dims(block):
    with Image.open(io.BytesIO(block["image"]["source"]["bytes"])) as im:
        return im.size


def _images(blocks):
    return [b for b in blocks if "image" in b]


def _assert_bedrock_safe(blocks):
    assert _images(blocks), "no image block produced"
    for b in _images(blocks):
        w, h = _dims(b)
        assert w <= BEDROCK_MAX_PX and h <= BEDROCK_MAX_PX
        assert len(b["image"]["source"]["bytes"]) <= BEDROCK_MAX_BYTES
        assert b["image"]["format"] in {"png", "jpeg", "gif", "webp"}


def test_default_tool_is_registered_as_image_reader():
    """Blueprints call `image_reader` — the wrapper must keep the strands tool name,
    and the raw strands image_reader must no longer be imported."""
    src = MAIN_PY.read_text()
    assert "\ndef image_reader(image_path: str)" in src
    loader = next(n for n in _TREE.body if isinstance(n, ast.FunctionDef) and n.name == "_load_builtin_tools")
    imported = {
        alias.name
        for n in ast.walk(loader)
        if isinstance(n, ast.ImportFrom) and n.module == "strands_tools"
        for alias in n.names
    }
    assert "image_reader" not in imported


def test_in_limit_image_passes_through_untouched(guard, tmp_path):
    p = _png(tmp_path / "viewport.png", 1440, 900)
    blocks = guard["prepare_image_blocks"](p)
    assert blocks == [{"image": {"format": "png", "source": {"bytes": Path(p).read_bytes()}}}]


def test_tall_page_screenshot_is_tiled_within_limits(guard, tmp_path):
    """The exact TEAM-3938 shape: 1440px-wide full-page screenshot, >8000px tall."""
    p = _png(tmp_path / "design-mockup-full.png", 1440, 12000)
    blocks = guard["prepare_image_blocks"](p)
    _assert_bedrock_safe(blocks)
    imgs = _images(blocks)
    assert 1 < len(imgs) <= guard["IMAGE_MAX_TILES"]
    assert "12000px" in blocks[0]["text"] and "tiles" in blocks[0]["text"]
    # Tiles are labelled top→bottom so the model can reason about page order.
    labels = [b["text"] for b in blocks if "text" in b and b["text"].startswith("Tile ")]
    assert labels[0].startswith("Tile 1/") and "y=0-" in labels[0]
    assert len(labels) == len(imgs)


def test_tile_count_is_capped_by_growing_tiles_not_dropping_content(guard, tmp_path):
    p = _png(tmp_path / "very-tall.png", 800, 40000)
    blocks = guard["prepare_image_blocks"](p)
    _assert_bedrock_safe(blocks)
    imgs = _images(blocks)
    assert len(imgs) == guard["IMAGE_MAX_TILES"]
    # Every tile is scaled to fit the max edge, so heights are bounded and readable.
    for b in imgs:
        w, h = _dims(b)
        assert max(w, h) <= guard["IMAGE_MAX_EDGE"]


def test_huge_square_image_is_downscaled_to_max_edge(guard, tmp_path):
    p = _png(tmp_path / "poster.png", 9000, 9000)
    blocks = guard["prepare_image_blocks"](p)
    _assert_bedrock_safe(blocks)
    imgs = _images(blocks)
    assert len(imgs) == 1
    assert max(_dims(imgs[0])) == guard["IMAGE_MAX_EDGE"]
    assert "downscaled" in blocks[0]["text"]


def test_oversized_bytes_fall_back_to_jpeg(guard, tmp_path):
    """Noise doesn't compress: a 1500x1500 PNG lands well over 3.5MB and must be re-encoded."""
    import random
    rng = random.Random(0)
    img = Image.frombytes("RGB", (1500, 1500), bytes(rng.getrandbits(8) for _ in range(1500 * 1500 * 3)))
    p = tmp_path / "noise.png"
    img.save(p, format="PNG")
    assert os.path.getsize(p) > guard["IMAGE_MAX_BYTES"]
    blocks = guard["prepare_image_blocks"](str(p))
    _assert_bedrock_safe(blocks)
    assert _images(blocks)[0]["image"]["format"] == "jpeg"


def test_palette_png_round_trips(guard, tmp_path):
    p = tmp_path / "palette.png"
    Image.new("P", (1440, 9000)).save(p, format="PNG")
    blocks = guard["prepare_image_blocks"](str(p))
    _assert_bedrock_safe(blocks)


def test_tool_never_raises(guard, tmp_path):
    tool = guard["image_reader"]
    missing = tool(str(tmp_path / "nope.png"))
    assert missing["status"] == "error" and "not found" in missing["content"][0]["text"]

    bogus = tmp_path / "not-an-image.png"
    bogus.write_text("hello")
    bad = tool(str(bogus))
    assert bad["status"] == "error" and "Could not read image" in bad["content"][0]["text"]

    ok = tool(_png(tmp_path / "ok.png", 640, 480))
    assert ok["status"] == "success" and "image" in ok["content"][0]
