# Story Animation Machine

The Living Library, where the book on the stand opens into the world of its story.

The room is the reading room from the [Story Computing Machine website](https://stories.rgbknights.com/):
marble shelves, the brass loom, the walnut desk, and a school of books with one book for every
published story. Scroll and the next book flies to the stand. This site keeps that room and adds:

- **The book opens.** Click the book (or *Step inside*, or press Enter). It lifts off the stand,
  its cover swings back, the first page is a painting of the story's first place, and light from
  the page carries you into that place.
- **The place comes to life.** [World Labs Atlas](https://docs.atlas-beta.worldlabs.ai/how-to-use-atlas)
  reads the painting's depth, then paints the rest of the place around the painter's viewpoint in
  the same hand. You can turn all the way round, look up and down, and lean. A world takes about
  two minutes to make, is made once, and is kept.
- **The story is told there.** *Read* opens the full story beside the place.
- **Doors on the desk.** The location studies on the desk are ways in: click one to step into
  that place. Character studies open in the viewer as before.
- **A date rule on the desk.** Every story in the order it was written, July on the left.
  Click or drag along it to move through the collection.
- **Find a story** in the header (or press `/`).
- Books whose worlds have been made shed more light in the school and carry a ✦.

Links are shareable: `?story=<slug>` opens the library at a book, `&in=1` steps inside,
`&scene=<id>` picks the place, `&read=1` opens the story.

## Run it

Requires Python 3.10+ with Pillow, and Node.js 22.9 or later.

```powershell
python -m pip install pillow
python scripts/build_data.py --budget 0      # stories + art from ../story-computing-machine (read-only)
npm install                                  # optional: adds sharp, which stores world views ~6x smaller
copy .env.example .env                       # then put your World Labs key in .env
npm start                                    # http://localhost:8787/
```

`build_data.py` reads the source repository through git at `origin/main` and never touches its
working tree. Prose, titles, ratings and art come from the source; the published set, display
prompts and withdrawn artwork come from the existing website's `content/` snapshot when
`../storytelling-machine` is present. Output goes to `site/data` and `site/media` (git-ignored,
about 450 MB). The art step is resumable; re-run it after new stories land.

## Make worlds ahead of time

Opening a book makes its world on the spot. To make them in advance instead:

```powershell
node --env-file-if-exists=.env scripts/make-worlds.mjs --list                  # what exists
node --env-file-if-exists=.env scripts/make-worlds.mjs --next 5 --dry-run      # what the next 5 would be
node --env-file-if-exists=.env scripts/make-worlds.mjs --next 5                # newest stories without a world
node --env-file-if-exists=.env scripts/make-worlds.mjs not-today/whale-city the-upward-rain
```

A story named without a place means its first place; `story/place` picks one (place ids are the
`scenes[].id` values in `site/data/library.json`, and the file names under `site/media/scenes/`).
Worlds already made are skipped. It runs two at a time and shares `worlds/` with the server.

On 10 November 2026 a world (one depth estimate plus about 27 generated views) cost roughly
300 API credits, about $0.30: 12 worlds and 2 draft splats took a $10.00 balance to $6.20.
At that rate one place for each of the 307 stories is about $90. Prices can change during the
beta; the World Labs usage page is the authority.

## How a world is made

| Step | Atlas task | What happens | Time |
| --- | --- | --- | --- |
| 1 | `images2PosedRGBD` | The painting gets a camera and a depth map. The site shows it in relief at once. | ~7 s |
| 2 | `atlasGenerate` | About 26 new views from a small ring at the painter's eye: a level ring, a row tilted up, a row tilted down, two side steps. | 1.5–2.5 min |
| 3 | `posedImages2Splats` (optional) | The views are fused into Gaussian splats for free movement. | 2–20 min |

The site renders steps 1 and 2 directly as posed pictures with depth (`site/js/world.js`), which
keeps every brushstroke of the original. Step 3 is off by default: in testing, draft splats of
these wide outdoor scenes were much softer than the views they were made from. Set
`WORLD_SPLATS=on` to offer it as a "Make it walkable" button.

Worlds are stored under `worlds/<story>/<scene>/` (git-ignored). Each is a small state machine in
`world.json`; Atlas submissions carry idempotency keys derived from it, so a restart or a second
visitor can never start or bill the same step twice.

## Spending and safety

- The API key lives only in `.env` on the server. The browser never sees it.
- `WORLD_GENERATION=local` (the default) lets only this machine start a world. `open` lets any
  visitor; `off` serves existing worlds only.
- `WORLD_AUTOSTART=on` (the default) starts a world when a book is opened. With `off` the reader
  presses *Bring this place to life* first.
- `WORLD_DAILY_LIMIT` and `WORLD_CONCURRENCY` cap new worlds per day and at once. Set a monthly
  spend limit on the World Labs project as the outer guardrail.
- Atlas does not report what a task cost through the API. Check the World Labs usage page after
  the first few worlds before opening generation to the public.

## Layout

```
scripts/build_data.py     source repo -> site/data, site/media
scripts/make-worlds.mjs   make worlds from the command line
server/server.mjs         static site + /api (zero dependencies)
server/worlds.mjs         the on-demand pipeline and its cache
server/rig.mjs            where Atlas's cameras stand
server/atlas.mjs          Atlas API client
site/js/room.js           the Living Library (ported from the website, then extended)
site/js/room-performance.js   its render budget (ported unchanged)
site/js/world.js          the world renderer
site/js/reader.js         story prose
site/js/main.js           joins the room, the worlds and the server
site/css/room.css         the website's room and header styles, plus this site's additions
site/css/world.css        the world view and reader
site/vendor/              three.js r187 and Spark 2.4 (MIT)
```

`room.js` was produced from `storytelling-machine/static/living-library.js`; the header comment
in the file lists what was added. That repository is not modified.

## Not done yet

- Deployment. The existing website runs on Cloudflare Workers; this server is plain Node with
  worlds on local disk. Hosting it needs either a Node host with a persistent disk or a port of
  `server/worlds.mjs` to a Worker with R2 storage.
- The library, gallery and per-story reader pages of the existing website are not reproduced
  here; the story is read inside its world.
