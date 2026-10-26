# Documentation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the project navigable by one person returning to it cold, and honest about what is unproven.

**Architecture:** Four documents. `ARCHITECTURE.md` says what the parts are and how three flows move between them. `CHANGING-THINGS.md` is the index the author asked for, each entry naming real files. `HANDOFF.md` is consolidated so the current state comes first and history after. `UNVERIFIED.md` gathers everything nobody has seen work, each with the check that closes it.

**Tech Stack:** Markdown. The repository is FastAPI + pydantic + httpx on Python 3.14, and Angular 22 (signals, standalone, router) with Leaflet, mapillary-js and three.js.

**Spec:** `docs/superpowers/specs/2026-10-26-documentation-design.md`
**Umbrella:** `docs/superpowers/specs/2026-10-12-authoring-application-overview.md`

## Global Constraints

- Run through `make` from the repo root. **NEVER call `npx`/`ng`.** Angular's build cache stays disabled.
- **No browser can launch here.** Never claim anything was seen working.
- **Make no live network call and pass no `allowed_domains`.** The earlier authorisation covered one verification run, which is done.
- Use `$TMPDIR`, never `/tmp`.
- **Do not `git add` anything under `.superpowers/`** — gitignored scratch.
- Baseline, which must not move: **320 pytest, 528 Vitest**, lint clean, build clean.
- **Do not edit the ADRs** (`docs/decisions/0001`-`0004`). They are immutable records of their moment; a later record supersedes a wrong one.
- **Do not retire the pipeline.** `content/source/stops.json`, `make content` and `build_tour.py`'s generation stay until the author says otherwise.
- Every factual claim is checked against the repository before it is written.
- Let git use its own config. Do **not** pass `-c user.email=...`. Commits end with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.

## Review Focus

Documentation's failure mode is being false. These are the claims most likely to be wrong and least likely to be noticed.

1. **The bootstrap procedure.** It is already broken and must be **run**, not reasoned about. → Task 1.
2. **File paths and symbol names** that moved during four sub-projects — `align/` is gone, `db.py` and `media.py` are gone, `app.ts` became `viewer-page.ts`. → Tasks 2 and 3.
3. **Counts and sizes**, which have changed at nearly every task. → All tasks.
4. **Claims about what is verified.** Anything needing a browser is unproven, including the whole editor. → Task 4.
5. **Landmines dropped during consolidation** — `HANDOFF.md` records dead ends that cost real debugging time, and reorganising it must not lose them. → Task 3.

---

### Task 1: Fix the bootstrap procedure, by running it

**Files:** `docs/HANDOFF.md`

The documented sequence for loading the real tour does `cp content/media/* content/work/media/`, which sweeps in `content/media/manifest.json`. Sub-project 3b tightened import to refuse any file under `media/` that is not an allowed image or audio type. So export then re-import now fails, and the passage still says it "succeeds with one warning".

- [ ] **Step 1: Run the procedure as written** and record the actual failure.

Start the backend, follow the documented curl sequence, and capture what happens at each step. Do not skip to the fix.

- [ ] **Step 2: Correct it and run the corrected version**

Copy only media (`*.jpg`, `*.m4a`, `pano/`), or copy everything and remove the manifest. Pick whichever is clearer to follow by hand. Then run it end to end: new session, PUT the tour, copy media, export, re-import the exported bundle.

Record the real observed output — `mediaCount`, the export size, what import reports.

- [ ] **Step 3: Rewrite the passage** to match what you observed, including why the manifest must not go in: import now holds media to the same allowlist uploads face, because the published site serves `tour-data/` from the author's own origin.

- [ ] **Step 4: Verify and commit**

`make check` green at 320/528.

```bash
git add docs/HANDOFF.md
git commit -m "$(cat <<'EOF'
Fix the bootstrap procedure the media allowlist broke

Copying all of content/media/ swept manifest.json into the working
directory, and import now refuses it — correctly, since that path
previously let executable content onto the author's own origin. The
procedure was wrong, not the refusal. Re-run and recorded.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: `ARCHITECTURE.md` and `CHANGING-THINGS.md`

**Files:** create `docs/ARCHITECTURE.md`, `docs/CHANGING-THINGS.md`

- [ ] **Step 1: Read the code before writing about it**

`backend/app/` whole, and `frontend/src/app/{core,editor,viewer,panorama,map,stop}/`. Check every path and symbol you intend to name.

- [ ] **Step 2: Write `ARCHITECTURE.md`**

The parts, their boundaries, and **three flows**:

1. **A tour is read.** `tour-data/config.json`, `tour.json`, `media/` — relative to the page, identical in the editor and a published site, which is why a published site needs no backend.
2. **An edit reaches disk.** A surface calls a pure op in `document-ops.ts` → `EditorStore.apply` → debounced whole-document `PUT` → validate-then-`os.replace`.
3. **A site is published.** The built app plus the working directory under `tour-data/`, zipped.

Say what each layer may **not** do — the viewer never calls `/api`, components never contain document logic, the client never names a stored file, headings are never typed without the gate. Those constraints are the architecture; the file list is not.

Point at ADRs for reasoning instead of repeating it. Keep it readable in one sitting.

- [ ] **Step 3: Write `CHANGING-THINGS.md`**

One entry per task, each naming real files and the order to touch them. At minimum:

- add an overlay kind; add a display mode; change the schema (and why a migration is then mandatory)
- add an acquisition tool; change what the editor can edit; change what a bundle contains; change the published site
- change what media types are accepted (**three places**: the backend allowlist, the frontend mirror, and the test that ties them — say so, since missing the third is the trap)

For each, name the test that will fail if the change is incomplete. The repository already has two cross-language drift tests; point at them as the pattern.

- [ ] **Step 4: Verify every path you named**

Grep for each file and symbol. A path that does not exist is the defect this task most easily ships.

- [ ] **Step 5: Verify and commit.** `make check` green at 320/528.

---

### Task 3: Consolidate `HANDOFF.md`

**Files:** `docs/HANDOFF.md`, `README.md`

- [ ] **Step 1: Inventory what must survive**

Before restructuring, list every landmine, dead end and open question in the current file — the MapLibre failure, `urllib` truncation, the Node version pin, the disabled Angular build cache, mapillary-js's on-demand rendering, `geodeticToEnu`'s absolute altitude, the `de48b0d` / `stops.json` drift, the unfinished alignment. **These cost real debugging time; losing one is the failure mode.**

- [ ] **Step 2: Restructure**

Current state first: what the application is now, how to run it, what works. History after, dated, with its landmines intact. Keep the honest register — this document's value is that it says what is broken.

Outstanding items get their true state. **Item 1 (alignment) and item 2 (`stops.json`) both remain open**; item 2 is now the author's explicit decision, with the editor able to take ownership whenever they say.

- [ ] **Step 3: Sweep `README.md`** for the same accuracy: counts, commands, what the project now is.

- [ ] **Step 4: Verify and commit.** `make check` green at 320/528.

---

### Task 4: `UNVERIFIED.md`

**Files:** create `docs/UNVERIFIED.md`; link it from `README.md` and `HANDOFF.md`

This is the most useful document in the sub-project: the author's first-session checklist, because almost everything visual is unproven.

- [ ] **Step 1: Gather, from the ADRs, HANDOFF, and the specs**

At minimum:

- **The entire editor.** No browser has run. Nothing has been seen.
- **A published site.** Never opened. Served once from `python3 -m http.server` during sub-project 2's review, and probed with curl.
- **Narration on a published site.** The `.m4a` MIME fix covers the editor's FastAPI; a static host sets its own headers, which is why the viewer now carries a `<source type>`.
- **The recorded-audio round trip.** Chromium's EBML and Firefox's OggS pass the sniffer; Safari's MP4 brand is the risk — `isom`, `iso5`, `mp42`, `M4A ` pass, `dash` and `cmfc` would be refused. The closing test is one clip per browser, first 32-64 bytes committed as fixtures.
- **`archive-fetch`'s redirect path.** Unit-tested both ways; no real loc.gov URL redirected.
- **Overpass in practice.** 34-42 s observed on one network with one 502, against timeouts now raised to 45 s on that single observation.
- **Three Overpass mirrors**, never exercised.
- **The rephoto alignment itself**, open since the prototype.
- **Microphone permission flows.**

Each entry: what is unproven, why it could not be checked here, and **the specific thing to do that would close it**.

- [ ] **Step 2: Order it by what to do first.** The first session with a browser should start at the top and work down.

- [ ] **Step 3: Verify and commit.** `make check` green at 320/528.

---

### Task 5: In-code rationale pass

**Files:** across `backend/app/` and `frontend/src/app/`

The brief asked for "generous in-code explanation of *why*". Much of it is already there and strong. This is a **pass**, not a rewrite.

- [ ] **Step 1: Find the gaps**

Look for code whose *reason* is not evident and not written down — especially anything a future reader might "simplify" into a bug. Known candidates: the single-member `Anchor` alias; `apply`'s same-reference refusal contract; the eager viewer route versus the lazy editor; `markSaved`'s reference guard; the per-hop redirect check.

- [ ] **Step 2: Add only what earns its place**

A comment saying *what* the line does is noise. A comment saying why it must stay, or what breaks without it, is the deliverable. **Delete any comment you find that is now false** — a wrong comment is worse than none.

- [ ] **Step 3: Verify and commit.** `make check` green at 320/528. Report how many comments you added, corrected, and removed.
