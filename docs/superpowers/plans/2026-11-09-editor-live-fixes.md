# Editor live fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix five problems found testing the editor live: close dialog behind the map, new stops at 0,0/last stop, broken lat/lng inputs, an address lookup replacing "Find places near here", and messy inspector styling.

**Architecture:** Three tracks. Track A (map pane, store, `addStop`, close dialog) and Track B (backend geocode endpoint, `ToolsApi`, inspector pane) touch disjoint files and run in parallel worktrees. Track C (styling pass) touches the CSS and templates of both and runs after they merge.

**Tech Stack:** Angular 22 (signals, standalone, `@angular/build:unit-test` / vitest), Leaflet 1.9, FastAPI + httpx, pytest.

**Spec:** the agreed description in the session of 2026-11-09 (summarised in Global Constraints below).

## Global Constraints

- Frontend tests: `cd frontend && npx ng test --watch=false`. Baseline 614 passing.
- Backend tests: `cd backend && UV_CACHE_DIR=$TMPDIR/uv-cache uv run --offline pytest -q`. Baseline 593 passing.
- Do not touch `backend/uv.lock` (unrelated uncommitted change in the main tree).
- Outbound HTTP is httpx only, with an explicit timeout, using `tools.make_client` / `_tool_client` (User-Agent `tools.UA`).
- Hosted deploy is CGI: one process per request. Any throttle must live on a file, not in memory (pattern: `sessions.sweep_due` / `mark_swept`).
- Nominatim usage policy: identifying User-Agent, at most 1 request/second.
- Match surrounding code: comment density and voice (comments explain *why*), `data-*` attributes as test hooks, dark palette `#0f1114 / #171a1f / #1c2026 / #343a44 / #c9ccd3 / #9aa0ab / #e8b04b / #e8825b`.
- Commit messages in the repo's style (imperative sentence, no prefix), ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. Typing a partial number ("-", "38.", "-77.30") into lat/lng must not rewrite the field under the cursor. Pinned in Task B2.
2. An address with no match, and a Nominatim failure or timeout, change nothing and show a message. Pinned in Tasks B1/B2.
3. Adding the first stop of a tour while the map has never been shown (no map center yet) still gives a valid location. Pinned in Task A2.
4. The close dialog must sit above the panorama (mapillary-js) pane too, not only Leaflet. Pinned in Task A1.
5. Moving the map view when the stop location changes must not fire on an overlay drag (it would snap the map mid-drag). Pinned in Task A3.

---

## Track A — map pane, store, close dialog (one subagent, sequential, worktree `fix-map`)

### Task A1: Close dialog always above the map and panorama

**Files:**
- Modify: `frontend/src/app/editor/edit-map-pane.css` (the uncommitted `isolation: isolate` is already there; keep it)
- Modify: `frontend/src/app/editor/edit-panorama-pane.css` (same isolation)
- Modify: `frontend/src/app/editor/close-dialog.css` (`.scrim` z-index)
- Test: `frontend/src/app/editor/editor-page.spec.ts` or a new `frontend/tests/e2e/close-dialog-stacking.spec.ts` (Playwright), whichever can measure it

**Interfaces:** none.

- [ ] Step 1: Find the root cause first (superpowers:systematic-debugging). Confirm whether the map (Leaflet panes at z-index 400–1000) and the panorama viewer escape their pane into the root stacking context, and check why this came back (the isolation fix was never committed).
- [ ] Step 2: Write a failing test. The behaviour to assert: with the close dialog open over a mounted editor, `document.elementFromPoint` at the center of the map pane and of the panorama pane returns an element inside `[data-close-dialog]` or `.scrim`. If jsdom cannot run layout, write it as a Playwright e2e under `frontend/tests/e2e` following the existing specs there. Run it with the isolation lines reverted to see it fail.
- [ ] Step 3: Apply `isolation: isolate` to both pane hosts and raise `.scrim` to `z-index: 2000`, with a comment that says why.
- [ ] Step 4: Test passes, full frontend suite green. Commit.

### Task A2: New stop starts at the map's current center

**Files:**
- Modify: `frontend/src/app/editor/editor-store.ts` (add map center)
- Modify: `frontend/src/app/editor/edit-map-pane.ts` (publish center on `moveend` and after `setView`)
- Modify: `frontend/src/app/editor/document-ops.ts:80` (`addStop`)
- Modify: `frontend/src/app/editor/outline-pane.ts:51`
- Test: `document-ops.spec.ts`, `editor-store.spec.ts`, `edit-map-pane.spec.ts`, `outline-pane.spec.ts`

**Interfaces:**
- Produces: `EditorStore.mapCenter: Signal<{lng:number;lat:number} | null>`, `EditorStore.setMapCenter(c: {lng:number;lat:number} | null): void`. Cleared by `load`.
- Produces: `addStop(tour: Tour, title: string, at?: {lng:number;lat:number} | null): Tour`. `at` wins when given; otherwise the existing fallback (last stop's location, else 0,0).

- [ ] Step 1: Failing tests:
  - `addStop(tour, 'New stop', {lng: -77.3, lat: 38.8})` → the new stop's `location` equals `{lng: -77.3, lat: 38.8}`. With `at` omitted or null → the old behaviour, unchanged.
  - The store's `load` resets `mapCenter` to null.
  - The map pane calls `store.setMapCenter` with the Leaflet center after a `moveend`.
  - Outline "Add stop" with `store.mapCenter()` set → the new stop is at that center.
- [ ] Step 2: Run, see them fail. Implement. The panorama is still copied from the last stop, as today.
- [ ] Step 3: Green, full suite green. Commit.

### Task A3: Map follows the stop's location

**Files:**
- Modify: `frontend/src/app/editor/edit-map-pane.ts` (`paint`)
- Modify: `frontend/src/app/editor/edit-map-pane.css` (style for the stop marker)
- Test: `frontend/src/app/editor/edit-map-pane.spec.ts`

**Interfaces:** consumes `stop.location` only.

- [ ] Step 1: Diagnose with superpowers:systematic-debugging. Known so far: `paint` re-centers only when `stop.id` changes and prefers the panorama fix, and `stop.location` is never drawn. So editing lat/lng shows no change.
- [ ] Step 2: Failing tests:
  - The current stop's location is drawn as a non-draggable marker tagged `data-stop-location`, at `[location.lat, location.lng]`.
  - Changing the current stop's location through `store.apply(setStopLocation…)` pans the map so the new location is in view.
  - Dragging an overlay (an anchor change with the location unchanged) does NOT call `setView` or `panTo`.
  - Typing an overlay's lat/lng moves its marker. This already happens on repaint; pin it.
- [ ] Step 3: Implement. Remember the last painted `location` per stop, and `panTo` only when it differs. A stop change still uses the existing focus rule.
- [ ] Step 4: Green, full suite green. Commit.

## Track B — address lookup and lat/lng inputs (one subagent, sequential, worktree `fix-inspector`)

### Task B1: Backend geocode endpoint

**Files:**
- Modify: `backend/app/tools.py` (add `geocode`, `GeocodeRequest`, constants)
- Modify: `backend/app/main.py` (route next to `/api/tools/places`, ~line 753)
- Test: `backend/tests/test_tools.py`, `backend/tests/test_api.py` (follow how the places tests mock transport)

**Interfaces:**
- Produces: `POST /api/tools/geocode`, body `{"query": str}` (1–200 chars after strip). Response `{"results": [{"name": str, "lng": float, "lat": float, "osmRef": str | null}]}`, at most 5, in Nominatim's order. Same `_reject_cross_site` dependency as places.
- `tools.geocode(client, query, *, stamp_dir: Path) -> list[dict]`. Calls `https://nominatim.openstreetmap.org/search` with `q`, `format=jsonv2`, `limit=5`. `osmRef` is `f"{osm_type}/{osm_id}"` when both are present (`osm_type` is already a word: node/way/relation). Entries with non-numeric or out-of-range lat/lon are dropped.
- Throttle: a file stamp (same mtime idea as `sessions.sweep_due`) in the sessions dir. If the last call was under 1.0 s ago, wait out the rest (≤1 s, via a `_sleep` seam) and then call. `NOMINATIM_TIMEOUT = 10.0`.
- Errors: upstream failure or timeout → `ToolError(502, "the address lookup failed: <_describe>")`. Blank query → 422 (pydantic).

- [ ] Step 1: Failing tests, using a mock transport:
  - Parses two results, builds `osmRef`, and keeps the order.
  - Drops an entry with `lat: "abc"`.
  - An empty array gives `[]` (the route returns 200 with `results: []`).
  - Upstream 500 or a timeout gives 502 with a message that starts "the address lookup failed".
  - The User-Agent header is `tools.UA`.
  - The throttle sleeps the remainder when the stamp is 0.3 s old (fake clock and fake sleep), and does not sleep when it is 2 s old.
  - A whitespace-only query gives 422.
- [ ] Step 2: Run, see them fail. Implement. Green. Full backend suite green. Commit.

### Task B2: Lat/lng inputs stop reverting under the cursor

**Files:**
- Modify: `frontend/src/app/editor/inspector-pane.html`, `inspector-pane.ts`
- Test: `frontend/src/app/editor/inspector-pane.spec.ts`

- [ ] Step 1: Diagnose with superpowers:systematic-debugging. The likely cause: `[ngModel]` is bound to the document. Each keystroke writes the parsed number back, so "38." → 38 → the field is rewritten to "38", and an out-of-range value is refused while the field keeps the bad text. Confirm this before fixing.
- [ ] Step 2: Failing tests, for the stop lng/lat AND the overlay lng/lat/altitude fields:
  - Typing "38." leaves the input reading "38.". Committing then sets 38.
  - Typing "-" changes nothing and the field still reads "-".
  - Committing an out-of-range value (lat 95) leaves the document unchanged and the field shows the document's value again. Commit means blur, or Enter.
  - A location changed from elsewhere (the map, or the address lookup) updates the field when it is not focused.
- [ ] Step 3: Implement. Commit on `change` (blur/Enter) instead of every keystroke, or keep the local text while focused. Pick whichever needs fewer moving parts, and use one approach for all coordinate fields.
- [ ] Step 4: Green, full suite green. Commit.

### Task B3: Address lookup replaces "Find places near here"

**Files:**
- Modify: `frontend/src/app/core/tools-api.ts` (+ spec)
- Modify: `frontend/src/app/editor/inspector-pane.html`, `inspector-pane.ts` (+ spec)

**Interfaces:**
- Consumes: B1's route.
- Produces: `ToolsApi.geocode(query: string): Promise<GeocodeResult[]>`, with `GeocodeResult = { name: string; lng: number; lat: number; osmRef: string | null }`.
- Remove `ToolsApi.places`, `PlaceCandidate` and the inspector's places UI (`findPlaces`, `usePlace`, `placeResults`, `data-find-places`, `data-place*`), along with their tests. The backend `/api/tools/places` stays.

- [ ] Step 1: Failing tests:
  - `ToolsApi.geocode('Fairfax Courthouse')` POSTs `/api/tools/geocode` with `{query: 'Fairfax Courthouse'}` and returns `results`.
  - The inspector shows an address input (`data-address`) and a button (`data-lookup-address`, label "Look up"). Enter in the input also submits.
  - On a result: the stop's location is the first result's lng/lat, `osmRef` is set, the matched name is shown (`data-address-match`), and a panorama search runs automatically, so candidates render.
  - Empty results: "No match for that address." (`data-address-none`), and the document is unchanged.
  - Rejection: the message shows in `data-tool-error`, and the document is unchanged.
  - A late reply for a stop that is no longer selected is ignored. Reuse the `found`/`stopId` keying.
  - "Find places near here" is gone. "Find panoramas near here" stays.
- [ ] Step 2: Run, see them fail. Implement. Green, full suite green. Commit.

## Track C — editor styling pass (after A and B merge)

### Task C1: Tidy editor UI

**Files:** `frontend/src/app/editor/*.css`, the editor templates as needed (`inspector-pane.html`, `outline-pane.html`, `editor-page.html`), optionally shared form rules in `frontend/src/styles.css` scoped under `app-editor-page`.

- [ ] Step 1: Find out why inputs render unstyled and side by side. Run `ng build` (production) and serve `dist` (or `ng serve`). Screenshot the editor with Playwright: a stop selected, an overlay selected, the outline add forms, and the address lookup. Check that component styles actually apply in the production build. If the production build styles correctly, record that live may be blocked by a host Content-Security-Policy on inline `<style>`, so the user can check the response headers.
- [ ] Step 2: Fix: labels above full-width controls, consistent vertical rhythm (0.5rem), one control style (input/select/textarea/button, focus ring in `#e8b04b`), grouped related fields (location: lng/lat side by side in a two-column row only if both fit at the sidebar's 15rem minimum, otherwise stacked), and candidate lists with aligned thumbnail/text/button. Same treatment in the outline pane's forms and the header.
- [ ] Step 3: Pin with tests where styling has behaviour: the `data-*` hooks still exist, and a Playwright layout check that each inspector `label` has its control below its text (control top > label text top). Before/after screenshots are kept in the scratchpad, not the repo.
- [ ] Step 4: Full suites green. Commit.

## Execution order

| Task | Depends on | Parallel-safe with |
|---|---|---|
| A1 → A2 → A3 (one worktree) | — | B1–B3 |
| B1 → B2 → B3 (one worktree) | B3 needs B1 | A1–A3 |
| C1 | A3, B3 merged | — |

Merge A, run both suites, then merge B, run both suites, then do C1 on main.
