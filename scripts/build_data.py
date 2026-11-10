"""Build the site's story data and art from the Story Computing Machine source repository.

Everything is read through git plumbing at a pinned revision, so the source working tree is never
touched and does not even need to be checked out at that revision.

    python scripts/build_data.py                 # data + as much art as fits in the time budget
    python scripts/build_data.py --budget 0      # no time limit

The art step is resumable: finished derivatives are skipped, so re-running continues where the
last run stopped. Prose, titles, ratings and art come from the source repository. Which stories are
published, their display prompts and which paintings were withdrawn from public view come from the
existing website's content snapshot when it is available (read-only).
"""

from __future__ import annotations

import argparse
import io
import json
import re
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
RATINGS = ("General", "Teen", "Mature", "Explicit")
COVER_SIZE = (432, 768)          # 9:16, the selected book
TILE = (120, 213)                # one shelf book in the cover atlas
ATLAS_COLS = 17
SCENE_WIDTH = 1440
CHARACTER_WIDTH = 960


# ----------------------------------------------------------------------------- git (read-only)

class Source:
    def __init__(self, repository: Path, revision: str):
        self.repository = repository
        self.commit = self._git("rev-parse", f"{revision}^{{commit}}").strip()
        self.blobs: dict[str, tuple[str, int]] = {}
        for line in self._git("ls-tree", "-r", "-l", self.commit, "stories/").splitlines():
            meta, path = line.split("\t", 1)
            _mode, kind, sha, size = meta.split()
            if kind == "blob":
                self.blobs[path] = (sha, int(size))

    def _git(self, *args: str) -> str:
        return subprocess.check_output(["git", "-C", str(self.repository), *args], text=True, encoding="utf-8")

    def has(self, path: str) -> bool:
        return path in self.blobs

    def read(self, path: str) -> bytes:
        return subprocess.check_output(["git", "-C", str(self.repository), "cat-file", "blob", self.blobs[path][0]])

    def text(self, path: str) -> str:
        return self.read(path).decode("utf-8")

    def first_commit_time(self, path: str) -> str | None:
        lines = self._git("log", "--format=%aI", "--reverse", self.commit, "--", path).splitlines()
        return lines[0] if lines else None


# ----------------------------------------------------------------------------- story parsing

def split_frontmatter(source: str) -> tuple[dict[str, str], str]:
    match = re.match(r"\A---\r?\n(.*?)\r?\n---\r?\n(.*)\Z", source, re.DOTALL)
    if not match:
        return {}, source
    fields = dict(re.findall(r"^([\w-]+):\s*(.*?)\s*$", match.group(1), re.MULTILINE))
    return fields, match.group(2)


def writing_prompt(source: str) -> str | None:
    """The request that started the story: a tagged [WP] line, or the opening Prompt section."""
    section = re.match(
        r"\A\s*#[ \t]+(?:Prompt|Request|User request|Original request)[ \t]*\r?\n(.*?)(?=^#{1,6}[ \t]|\Z)",
        source, re.IGNORECASE | re.MULTILINE | re.DOTALL)
    request = section.group(1) if section else None
    tagged = re.search(r"^\s*(?:>\s*)?\[?(?:WP|SP)\]\s*(.+)$", request if request is not None else source, re.MULTILINE)
    if tagged:
        return tagged.group(1).strip().strip("“”\"")
    return request.strip() if request and request.strip() else None


def rating_of(source: str | None) -> str | None:
    if not source:
        return None
    match = re.search(r"^- \*\*Rating:\*\* (.+)$", source, re.MULTILINE)
    if match and match.group(1).strip() in RATINGS:
        return match.group(1).strip()
    lines = [line.strip() for line in source.splitlines()]
    for index, line in enumerate(lines):
        if line.lower() in {"# rating", "# content rating"}:
            value = next((later for later in lines[index + 1:] if later), None)
            return value if value in RATINGS else None
    return None


def content_notes(source: str | None) -> str | None:
    match = re.search(r"^- \*\*Content notes:\*\* (.+)$", source or "", re.MULTILINE)
    return match.group(1).strip() if match else None


def humanize(stem: str) -> str:
    stem = re.sub(r"^\d+[-_]", "", stem)
    stem = re.sub(r"-(selected|original)$", "", stem)
    small = {"a", "an", "and", "at", "by", "for", "in", "of", "on", "the", "to", "with", "from", "under", "over"}
    words = stem.replace("_", "-").split("-")
    return " ".join(w if (i and w in small) else w.capitalize() for i, w in enumerate(words))


def slug_id(stem: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", re.sub(r"-(selected|original)$", "", stem.lower())).strip("-")


# ----------------------------------------------------------------------------- reference snapshot

def load_reference(reference: Path | None) -> dict:
    """Published set, display prompts and art curation from the existing site, when present."""
    out = {"catalog": None, "excluded": set(), "titles": {}, "primary": {}}
    if not reference or not (reference / "content" / "catalog.json").exists():
        return out
    content = reference / "content"
    out["catalog"] = {s["slug"]: {k: v for k, v in s.items() if k != "body"}
                      for s in json.loads((content / "catalog.json").read_text(encoding="utf-8"))["stories"]}
    for name in ("characters", "landscapes", "interiors"):
        path = content / f"{name}.json"
        if not path.exists():
            continue
        data = json.loads(path.read_text(encoding="utf-8"))
        out["excluded"].update(item["source"] for item in data.get("excludedSources", []))
        for story in data.get("stories", []):
            for image in story.get("images", []):
                out["titles"][image["source"]] = image["title"]
    locations = content / "story-locations.json"
    if locations.exists():
        for slug, entry in json.loads(locations.read_text(encoding="utf-8")).get("locations", {}).items():
            if entry.get("source"):
                out["primary"][slug] = entry["source"]
    panorama = content / "panorama.json"
    if panorama.exists():
        for stop in json.loads(panorama.read_text(encoding="utf-8")).get("stops", []):
            source = (stop.get("landscape") or {}).get("source")
            if source:
                out["primary"].setdefault(stop["slug"], source)
    return out


# ----------------------------------------------------------------------------- images

def open_image(data: bytes) -> Image.Image:
    image = Image.open(io.BytesIO(data))
    image.load()
    return image.convert("RGB")


def cover_fit(image: Image.Image, size: tuple[int, int]) -> Image.Image:
    target = size[0] / size[1]
    width, height = image.size
    if width / height > target:
        new_width = round(height * target)
        left = (width - new_width) // 2
        image = image.crop((left, 0, left + new_width, height))
    else:
        new_height = round(width / target)
        top = (height - new_height) // 2
        image = image.crop((0, top, width, top + new_height))
    return image.resize(size, Image.LANCZOS)


def fit_width(image: Image.Image, width: int) -> Image.Image:
    if image.width <= width:
        return image
    return image.resize((width, round(image.height * width / image.width)), Image.LANCZOS)


def band_colour(image: Image.Image, top: float, bottom: float) -> str:
    small = image.resize((48, 48), Image.BILINEAR)
    box = small.crop((0, round(48 * top), 48, max(round(48 * top) + 1, round(48 * bottom))))
    pixels = list(box.getdata())
    r, g, b = (round(sum(p[i] for p in pixels) / len(pixels)) for i in range(3))
    return f"#{r:02x}{g:02x}{b:02x}"


def render(job: dict, source: Source) -> dict:
    """Make one derivative. Returns facts about the image that the index needs."""
    image = open_image(source.read(job["source"]))
    facts = {"key": job["key"]}
    out = Path(job["out"])
    out.parent.mkdir(parents=True, exist_ok=True)
    if job["kind"] == "cover":
        fitted = cover_fit(image, COVER_SIZE)
        fitted.save(out, "WEBP", quality=82, method=4)
        cover_fit(image, TILE).save(out.with_name(out.stem + ".tile.png"))
        facts.update(colour=band_colour(fitted, 0, 1), top=band_colour(fitted, 0, .25))
    elif job["kind"] == "scene":
        fitted = fit_width(image, SCENE_WIDTH)
        fitted.save(out, "WEBP", quality=78, method=4)
        facts.update(w=fitted.width, h=fitted.height, sky=band_colour(fitted, 0, .3),
                     ground=band_colour(fitted, .72, 1), mid=band_colour(fitted, .3, .72))
    else:
        fitted = fit_width(image, CHARACTER_WIDTH)
        fitted.save(out, "WEBP", quality=78, method=4)
        facts.update(w=fitted.width, h=fitted.height)
    out.with_suffix(".json").write_text(json.dumps(facts), encoding="utf-8")
    return facts


# ----------------------------------------------------------------------------- build

def collect(source: Source, reference: dict, only: set[str] | None) -> list[dict]:
    directories = sorted({path.split("/")[1] for path in source.blobs if path.count("/") >= 2})
    stories = []
    for slug in directories:
        base = f"stories/{slug}/"
        prose_path = next((base + name for name in ("story.md", "05-story.md") if source.has(base + name)), None)
        if not prose_path or not source.has(base + "title-image.jpg"):
            continue
        if reference["catalog"] is not None and slug not in reference["catalog"]:
            continue                                      # not published
        if only and slug not in only:
            continue
        fields, prose = split_frontmatter(source.text(prose_path))
        bundle = json.loads(source.text(base + "story.json")) if source.has(base + "story.json") else {}
        published = (reference["catalog"] or {}).get(slug, {})
        title = (fields.get("title") or bundle.get("title") or published.get("title") or humanize(slug)).strip("\"'")
        body = prose.strip()
        heading = re.match(r"\A#\s+(.+?)\s*\r?\n", body)
        if heading:                                       # the title is shown by the page, not the prose
            body = body[heading.end():].lstrip()
        prompt_path = next((base + name for name in ("prompt.md", "00-prompt.md") if source.has(base + name)), None)
        prompt = published.get("prompt") or (writing_prompt(source.text(prompt_path)) if prompt_path else None)
        ratings = source.text(base + "ratings.md") if source.has(base + "ratings.md") else None
        created = fields.get("created") or bundle.get("created") or published.get("created")
        created_at = published.get("createdAt") or source.first_commit_time(prose_path) or f"{created}T12:00:00Z"

        art = sorted(path for path in source.blobs
                     if path.startswith(base + "art/") and path.rsplit(".", 1)[-1].lower() in {"png", "webp", "jpg", "jpeg"})
        scenes, characters = [], []
        for path in art:
            kind = path.split("/")[3]
            stem = path.rsplit("/", 1)[-1].rsplit(".", 1)[0]
            if path in reference["excluded"] or stem.endswith("-original"):
                continue
            entry = {"id": slug_id(stem), "title": reference["titles"].get(path) or humanize(stem), "source": path}
            if kind in ("landscapes", "interiors"):
                entry["kind"] = "landscape" if kind == "landscapes" else "interior"
                scenes.append(entry)
            elif kind == "characters":
                characters.append(entry)
        primary = reference["primary"].get(slug)
        scenes.sort(key=lambda s: (s["source"] != primary, s["kind"] != "landscape", s["source"]))
        for group in (scenes, characters):                # ids must be unique within a story
            seen: dict[str, int] = {}
            for entry in group:
                seen[entry["id"]] = seen.get(entry["id"], 0) + 1
                if seen[entry["id"]] > 1:
                    entry["id"] += f"-{seen[entry['id']]}"

        stories.append({
            "slug": slug, "title": title, "created": created, "createdAt": created_at,
            "rating": rating_of(ratings) or published.get("rating") or "General",
            "notes": content_notes(ratings), "canon": bool(bundle.get("canon", fields.get("canon") == "true")),
            "prompt": prompt, "words": len(body.split()), "body": body,
            "coverSource": base + "title-image.jpg", "scenes": scenes, "characters": characters,
        })
    stories.sort(key=lambda s: (s["createdAt"], s["slug"]))   # oldest first: shelf order
    return stories


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--source", type=Path, default=ROOT.parent / "story-computing-machine")
    parser.add_argument("--revision", default="origin/main")
    parser.add_argument("--reference", type=Path, default=ROOT.parent / "storytelling-machine",
                        help="existing website checkout; supplies the published set and art curation")
    parser.add_argument("--out", type=Path, default=ROOT / "site")
    parser.add_argument("--budget", type=float, default=150, help="seconds to spend on art this run; 0 = no limit")
    parser.add_argument("--jobs", type=int, default=2)
    parser.add_argument("--only", nargs="*", help="limit to these story slugs (for testing)")
    args = parser.parse_args()

    started = time.time()
    source = Source(args.source, args.revision)
    reference = load_reference(args.reference)
    stories = collect(source, reference, set(args.only) if args.only else None)
    media, data = args.out / "media", args.out / "data"
    (data / "stories").mkdir(parents=True, exist_ok=True)

    jobs = []
    for story in stories:
        slug = story["slug"]
        jobs.append({"kind": "cover", "key": f"cover:{slug}", "source": story["coverSource"],
                     "out": str(media / "covers" / f"{slug}.webp")})
        for scene in story["scenes"]:
            jobs.append({"kind": "scene", "key": f"scene:{slug}:{scene['id']}", "source": scene["source"],
                         "out": str(media / "scenes" / slug / f"{scene['id']}.webp")})
        for character in story["characters"]:
            jobs.append({"kind": "character", "key": f"character:{slug}:{character['id']}", "source": character["source"],
                         "out": str(media / "characters" / slug / f"{character['id']}.webp")})

    facts: dict[str, dict] = {}
    pending = []
    for job in jobs:
        sidecar = Path(job["out"]).with_suffix(".json")
        if sidecar.exists() and Path(job["out"]).exists():
            facts[job["key"]] = json.loads(sidecar.read_text(encoding="utf-8"))
        else:
            pending.append(job)
    pending.sort(key=lambda j: {"cover": 0, "scene": 1, "character": 2}[j["kind"]])
    print(f"{len(stories)} stories at {source.commit[:12]}; {len(jobs)} images, {len(pending)} to make", flush=True)

    made = failed = 0
    deadline = started + args.budget if args.budget else None
    with ThreadPoolExecutor(max_workers=max(1, args.jobs)) as pool:
        queue = iter(pending)
        running = set()
        while True:
            while len(running) < args.jobs * 2 and (deadline is None or time.time() < deadline):
                job = next(queue, None)
                if job is None:
                    break
                future = pool.submit(render, job, source)
                future.job = job
                running.add(future)
            if not running:
                break
            for future in as_completed(list(running)):
                running.discard(future)
                try:
                    result = future.result()
                    facts[result["key"]] = result
                    made += 1
                except Exception as error:                # a broken image must not sink the build
                    failed += 1
                    print(f"  ! {future.job['source']}: {error}", file=sys.stderr)
                break
    remaining = len(pending) - made - failed

    # Cover atlas for the shelves: one texture, one draw call.
    rows = -(-len(stories) // ATLAS_COLS)
    tiles = [media / "covers" / f"{s['slug']}.tile.png" for s in stories]
    atlas_ready = all(tile.exists() for tile in tiles) and bool(stories)
    if atlas_ready:
        atlas = Image.new("RGB", (ATLAS_COLS * TILE[0], rows * TILE[1]), "#15110d")
        for index, tile in enumerate(tiles):
            atlas.paste(Image.open(tile), ((index % ATLAS_COLS) * TILE[0], (index // ATLAS_COLS) * TILE[1]))
        atlas.save(media / "cover-atlas.webp", "WEBP", quality=84, method=4)

    index = []
    for order, story in enumerate(stories):
        slug = story["slug"]
        (data / "stories" / f"{slug}.json").write_text(
            json.dumps({"slug": slug, "title": story["title"], "body": story["body"]}, ensure_ascii=False),
            encoding="utf-8")
        cover = facts.get(f"cover:{slug}", {})
        scenes = []
        for scene in story["scenes"]:
            fact = facts.get(f"scene:{slug}:{scene['id']}")
            if fact:
                scenes.append({"id": scene["id"], "title": scene["title"], "kind": scene["kind"],
                               "src": f"media/scenes/{slug}/{scene['id']}.webp", "w": fact["w"], "h": fact["h"],
                               "sky": fact["sky"], "mid": fact["mid"], "ground": fact["ground"]})
        characters = []
        for character in story["characters"]:
            fact = facts.get(f"character:{slug}:{character['id']}")
            if fact:
                characters.append({"id": character["id"], "title": character["title"],
                                   "src": f"media/characters/{slug}/{character['id']}.webp", "w": fact["w"], "h": fact["h"]})
        index.append({
            "slug": slug, "title": story["title"], "created": story["created"], "createdAt": story["createdAt"],
            "rating": story["rating"], "notes": story["notes"], "canon": story["canon"], "prompt": story["prompt"],
            "words": story["words"], "tile": order, "cover": f"media/covers/{slug}.webp" if cover else None,
            "colour": cover.get("colour"), "scenes": scenes, "characters": characters,
        })
    library = {
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": {"repository": "BoundlessStudio/story-computing-machine", "commit": source.commit},
        "complete": remaining == 0 and failed == 0 and atlas_ready,
        "atlas": {"src": "media/cover-atlas.webp", "cols": ATLAS_COLS, "rows": rows, "tileW": TILE[0], "tileH": TILE[1]} if atlas_ready else None,
        "totals": {"stories": len(index), "words": sum(s["words"] for s in index),
                   "scenes": sum(len(s["scenes"]) for s in index), "characters": sum(len(s["characters"]) for s in index)},
        "stories": index,
    }
    (data / "library.json").write_text(json.dumps(library, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"made {made}, failed {failed}, remaining {remaining}; atlas {'ready' if atlas_ready else 'waiting for covers'}; "
          f"{time.time() - started:.0f}s", flush=True)
    if remaining:
        print("Run again to continue.")


if __name__ == "__main__":
    main()
