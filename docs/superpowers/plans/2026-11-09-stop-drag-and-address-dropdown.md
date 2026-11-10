# Stop drag and address dropdown Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Let the author drag the stop's location ring on the editor map, and replace the address lookup's auto-pick with a dropdown of matches.

**Root cause (from debugging, 2026-11-09):** The grey `data-stop-location` ring added in `edit-map-pane.ts` is `interactive: false`. The stop's location has never been draggable. The author dragged the ring, nothing moved, and "Find panoramas near here" searched 50 m around the unchanged location. `MapillarySearch.panoramas` is unchanged since before the last round, so the search is not itself broken.

**Tech Stack:** Angular 22 signals, Leaflet 1.9, vitest via `npx ng test --watch=false` (baseline 677 pass). Backend untouched (613 pass).

## Global Constraints

- Test-first: each behaviour gets a failing test, seen failing, before code.
- Match surrounding code: comments explain why, and `data-*` attributes are the test hooks. Palette `#0f1114 / #171a1f / #1c2026 / #343a44 / #c9ccd3 / #9aa0ab / #e8b04b / #e8825b`.
- Commits: an imperative sentence with a why-body, ending `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Nominatim policy forbids as-you-type suggestions. The list appears only after an explicit Look up.

## Review Focus

1. An overlay anchored exactly on the stop's location (the default for new overlays) must not make the ring ungrabbable, and the overlay must stay draggable. Pinned in Task 1.
2. Dropping the ring must not pan the map under the author's hand. Pinned in Task 1.
3. A stale dropdown (results for another stop, or for the stop before an undo) must never move a stop. Pinned in Task 2.
4. Dropping the ring clears `osmRef`, as a hand-typed coordinate does. Pinned in Task 1.

---

### Task 1: Draggable stop-location ring

**Files:** Modify `frontend/src/app/editor/edit-map-pane.ts`, `edit-map-pane.css`; test `edit-map-pane.spec.ts`.
**Depends on:** none. **Parallel-safe with Task 2:** yes, no shared files.

- [ ] Failing tests:
  - The `data-stop-location` marker is draggable.
  - Firing `dragend` at a new latlng applies `setStopLocation(tour, stopId, lng, lat, null)`: the stop's location is the drop point and `osmRef` is null.
  - After that drop, neither `setView` nor `panTo` is called.
  - With an overlay anchored at the stop's exact location, both the ring and the overlay marker are still draggable, the overlay marker's z-index is above the ring's, and the ring's icon is larger than the overlay's 22px so its rim stays grabbable around it.
  - An overlay drag still never changes `stop.location`.
- [ ] Implement:
  - The ring becomes `draggable: true`, `keyboard: true` with `title`/`alt` "Drag to move this stop".
  - Its icon is 32×32 and hollow, with a cursor of grab, and it gets a negative `zIndexOffset` so overlays draw above it.
  - On `dragend`, set `paintedLocation` to the drop point BEFORE `store.apply`, so the repaint does not `panTo`.
  - Update the comment that says no drag changes the stop's location.
- [ ] Green, full suite green, commit.

### Task 2: Address results dropdown

**Files:** Modify `frontend/src/app/editor/inspector-pane.html`, `inspector-pane.ts`, `inspector-pane.css`; test `inspector-pane.spec.ts`.
**Depends on:** none (uses existing `ToolsApi.geocode(query): Promise<GeocodeResult[]>`, up to 5 results). **Parallel-safe with Task 1:** yes.

- [ ] Failing tests:
  - Look up with 3 results moves nothing. It shows a list `data-address-results` directly under the address row with 3 options `data-address-result` showing each `name`.
  - Choosing one applies `setStopLocation` with that result's lng/lat/osmRef, shows the existing `data-address-match` "Moved to" note, runs the panorama search, and closes the list.
  - With 1 result, the list still shows: the author confirms.
  - With 0 results, the existing `data-address-none` message shows and there is no list.
  - Escape, a new Look up, or selecting another stop closes or replaces the list. Results are keyed to the stop id, so a list for stop A never moves stop B, and a late reply for a deselected stop is dropped.
  - Keyboard: the options are buttons (Tab/Enter work), and ArrowDown from the address input focuses the first option.
- [ ] Implement:
  - The dropdown panel is absolutely positioned under the input, full width, with the palette's raised surface `#171a1f`, a `#343a44` border, rows that highlight on hover and focus, and a z-index above the inspector content.
  - Keep the `searching` / `data-tool-error` behaviour.
- [ ] Green, full suite green, commit.

## Execution

Tasks 1 and 2 run in parallel in separate worktrees. Merge Task 1, run the full suite, merge Task 2, run the full suite, then one review of the combined diff.
