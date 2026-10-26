# Changing things

"Where do I change X?" One entry per task. Each lists the real files **in the
order to touch them**, then **what fails if you stop early**. Run everything
through `make` (`make check` runs lint, both test suites and the build).

Two of the project's rules are duplicated across Python and TypeScript, and a
backend test reads the TypeScript source and fails when the copies drift:

- `test_the_frontend_mode_table_matches_this_one` in
  `backend/tests/test_models.py` (display modes);
- `test_the_frontend_extension_lists_match_the_allowed_types` in
  `backend/tests/test_media_store.py` (media extensions).

That is the pattern to copy whenever you create a third duplicated rule: this
repository's answer to documentation going stale is a test that fails. This
file says plainly, entry by entry, where a test exists and where it does not.
Where one does not, the step is only a convention; do not trust the green
build to catch it. For the shape of the system see
[`ARCHITECTURE.md`](ARCHITECTURE.md).

A note on additive versus breaking. Widening what a v2 document may contain
(a new `kind`, a new `display` mode, a new optional field) leaves every
existing document valid and needs no migration. Anything that makes a
previously valid document invalid, or changes its shape, is a schema change:
see entry 3.

---

## 1. Add an overlay kind (say `video`)

1. `backend/app/models.py`: add the member to the `kind: Literal[...]` on
   `Overlay`; add a row to `DISPLAY_MODES_BY_KIND`; add the payload rule to
   `Overlay._payload_matches_kind` (text needs a body, image and audio need a
   `media_id`; a new kind needs its own).
2. If the kind carries uploaded media, accept its types first: entry 8.
3. `frontend/src/app/core/tour.models.ts`: add it to `OverlayKind`.
4. `frontend/src/app/editor/document-ops.ts`: add the row to
   `DISPLAY_MODES_BY_KIND`; teach `mediaKindOf`, `legalKindsFor`,
   `addMediaOverlay` and the icon choices in `setOverlayMode` and
   `defaultDisplayFor` about it.
5. Viewer: `frontend/src/app/stop/stop-panel.ts` has an `@switch
   (selected.kind)`. Add the `@case`.
6. Editor: the way to create one, in `editor/outline-pane.ts` / `.html`
   (a new add button, and the file input's `accept`).

**Fails if incomplete:**
`test_display_modes_table_covers_every_kind` (a kind with no table row, or a
row with no kind) and `test_the_frontend_mode_table_matches_this_one` (the
TypeScript row missing or wrong) in `backend/tests/test_models.py`. Once
`OverlayKind` is widened in TypeScript, the `Record<OverlayKind, …>` table
fails to compile until step 4 adds its row (`make build`, `make
frontend-test`).
**Nothing fails** if you skip step 5: the `@switch` has no default, so the
viewer silently shows nothing for the new kind. Nothing fails if you skip step
3 either, because `tour.models.ts` has no drift test.
`test_display_mode_matrix` is parametrised by hand; add the new kind's rows.

## 2. Add a display mode (say `billboard`)

1. `backend/app/models.py`: a new `XDisplay` class with its own literal `mode`;
   add it to the `Display` union; put the mode in the relevant
   `DISPLAY_MODES_BY_KIND` rows. This is a renderer limitation, not a model
   one (ADR 0001): a cell stays out of the table until something can draw it.
2. `frontend/src/app/core/tour.models.ts`: the matching interface and the
   `Display` union.
3. `frontend/src/app/editor/document-ops.ts`: the `DISPLAY_MODES_BY_KIND`
   table, and a branch in `setOverlayMode` to build the display (if it needs
   the camera's position, route it through `panoramaFixForStop` as `inWorld`
   does).
4. Draw it, in **both** places. The viewer builds its scene from
   `frontend/src/app/panorama/panorama-pane.ts` and the editor from
   `frontend/src/app/editor/edit-panorama-pane.ts`; each has its own
   `if (o.display.mode === …)` loop. Extend `PanoramaViewer`
   (`panorama/panorama-viewer.ts`), then `panorama/mapillary-viewer.ts` and
   `panorama/fake-viewer.ts`. If the visitor controls it (as the opacity
   slider does), `core/tour-store.ts` and `stop/stop-panel.ts` too.
5. Editor controls: `editor/inspector-pane.ts` / `.html`, and
   `editor/edit-map-pane.ts` if it has a footprint.

**Fails if incomplete:** `test_the_frontend_mode_table_matches_this_one` fails
when the TypeScript table lacks a mode the backend allows. It does **not**
fail for a mode added only on the TypeScript side, because the test's
"should not allow" check uses a hard-coded set `{"marker", "inWorld",
"ambient"}`: **add your new mode to that set in the test**, or the
protection is quietly half-off. `test_display_mode_matrix` needs rows for the
new mode. Nothing fails if you forget one of the two panorama panes in step 4;
that duplication is real, so touch both.

## 3. Change the schema

Anything that changes the shape or meaning of `tour.json`: renamed or removed
fields, new required fields, tightened validation.

**Why a migration is then mandatory.** The model is strict (`extra="forbid"`)
and `Tour.schema_version` is a `Literal`, so a document of the old shape
simply stops validating. Old documents are not hypothetical: exported
bundles live outside this repository, `content/work/` persists between runs,
and the committed seed tour is a document too. Without a migration those are
rejected. And `PUT /api/session/tour` does not migrate (`Session.write_tour`
validates against the current schema only), so an old document that reaches
the editor unmigrated cannot even be saved. Migration is the only door.

1. `backend/app/models.py`: change the models; bump `SCHEMA_VERSION` and the
   `schema_version: Literal[N]` on `Tour` (they are two separate places).
2. `backend/app/migration.py`: add the step. It is pure (dict in, dict out,
   input never mutated) and must be total: refuse loudly rather than drop
   data, as `_migrate_overlays` does for an unknown kind. Today's function is
   named `migrate_v1_to_v2` and accepts only v1 and current; the call sites
   are `Session.tour` (`session.py`), `_validate_tree` and `missing_media`
   (`bundle.py`). A v3 means chaining steps behind one entry point.
3. `backend/app/session.py`: `skeleton()` hard-codes `"schemaVersion": 2`
   (it does not read `SCHEMA_VERSION`); update it.
4. `frontend/src/app/core/tour.models.ts`: mirror the change by hand, and the
   `schemaVersion` literal on `Tour`. Then fix the compile errors this causes
   in `editor/document-ops.ts` and `editor/test-builders.ts`.
5. The seed tour: `content/scripts/build_tour.py` (it emits
   `SCHEMA_VERSION`) then `make content` regenerates
   `content/tours/fairfax-old-town.json`. Hand-edits to that JSON are
   overwritten. Beware: `stops.json` has drifted from the committed tour, so
   `make content` would revert the hand alignment; whether to retire the
   pipeline is the author's open call (`HANDOFF.md`, Outstanding item 2).
6. Backend fixtures that build documents (`_minimal_doc` in
   `backend/tests/test_bundle.py`, helpers in `test_models.py`).

**Fails if incomplete:** `backend/tests/test_migration.py` (add cases for each
migrated shape; `test_the_real_tour_migrates_and_validates` and
`test_the_real_tour_loses_nothing` run the seed tour through it);
`test_the_shipped_tour_is_valid_v2` and `test_build_tour_emits_schema_version_two`
(the seed and the generator); `test_the_shipped_tour_round_trips_byte_identically`
and `test_a_v1_bundle_is_migrated_on_import` in `backend/tests/test_bundle.py`;
`test_schema_version_one_is_rejected_by_the_model` in `test_models.py` (rename
and update it when the version moves). **Nothing fails** if `tour.models.ts`
is left behind and no code uses the changed field; the schema's TypeScript
mirror has no drift test (see "the third duplication" under entry 8). Also note
that migration runs on **import**, not at startup: a stale `tour.json` already
in `content/work/` is not migrated by restarting the backend. Re-import the
bundle.

## 4. Add an acquisition tool

1. `backend/app/tools.py`: the function (takes an `httpx.Client`, returns
   data, raises `ToolError` with the HTTP status the route should use, has an
   explicit timeout) and a request model beside the others
   (`PanoramaRequest`, `ArchiveRequest`, …). All outbound HTTP is `httpx`, never
   `urllib` (`docs/ENVIRONMENT.md`).
2. `backend/app/main.py`: a route under `/api/tools/…` inside `create_app`,
   next to the existing four. It must carry
   `dependencies=[Depends(_reject_cross_site)]`, be a plain `def` (blocking
   calls belong in the threadpool), map `ToolError` to
   `HTTPException(status_code=exc.status, …)`, and build its client with
   `_tool_client(timeout)` so tests can swap the transport. If the tool
   produces a file, store it with `store_media` and return the `mediaId`
   (the client never names a file), as `tool_narrate` does.
3. `frontend/src/app/core/tools-api.ts`: a `ToolsApi` method that goes through
   the private `post` helper (which turns failures into messages).
4. A consumer: `editor/inspector-pane.ts` (placing a stop) or
   `editor/outline-pane.ts` (adding content). If the result becomes document
   content, build it in a pure op in `editor/document-ops.ts`
   (`archiveCredit` and `narrationSource` are the examples) and have the
   component only call `store.apply`. Network first, document second: a
   failed call must leave the draft untouched.

**Fails if incomplete:** `backend/tests/test_tools.py` (tests inject
`httpx.MockTransport` through `app.state.http_transport`, so nothing
touches the network) and the `TOOLS` dict at the top of that file, which
drives `test_cross_site_refused`. **Register your tool in `TOOLS`**: a route
that forgot `_reject_cross_site` fails nothing if it is not listed there.
Frontend: `core/tools-api.spec.ts`.

## 5. Change what the editor can edit

1. If it is a new *field*, it is a schema change first: entry 3 (or entry 1/2
   for a kind or mode).
2. `frontend/src/app/editor/document-ops.ts`: a pure function
   `(tour, …) => Tour`. Never mutate; **return the same reference to refuse**
   (a bad value, a missing id, a missing panorama fix), because
   `EditorStore.apply` treats an identical reference as "not an edit". Throw
   only for a refusal the author must be told about (`LastStopError` is the
   model). Anything involving a heading goes through `panoramaFixForStop`.
3. `frontend/src/app/editor/document-ops.spec.ts`: test it, including the
   refusal. This is where editor behaviour is proven, since no browser runs.
4. The surface that exposes it, calling `store.apply(t => op(t, …))`:
   `editor/outline-pane.ts` (structure and content), `editor/inspector-pane.ts`
   (fields), `editor/edit-map-pane.ts` (position, heading handle),
   `editor/edit-panorama-pane.ts` (nudging, opacity). Each has a `.html` or an
   inline template; add no document logic to either.
5. If the edit is not purely local (it needs the server first, as an upload
   does), do the network step first and call `apply` only on success.

**Fails if incomplete:** `document-ops.spec.ts` for the op and the surface's
own spec (for example `inspector-pane.spec.ts`) for the wiring. There is no
test tying an op to the backend: if an op can produce a document the schema
rejects, the author finds out as an `error` status on `Autosave` (a 422 from
the PUT) and not in CI. Test the op with a document shape the backend
accepts.

## 6. Change what a bundle contains

A bundle is `bundle.json`, `tour.json` and `media/`, as a zip.

1. `backend/app/bundle.py`: `_ALLOWED_ROOT_FILES` (the import allowlist; it
   exists because the working directory is copied onto the author's public
   origin, and "reject known-bad names" loses), `write_bundle` (what export
   includes or skips), `_validate_tree` (what import checks). If the container
   format changes incompatibly, bump `BUNDLE_VERSION`; `_check_bundle_version`
   then refuses newer bundles. `bundleVersion` is independent of
   `schemaVersion`.
2. `backend/app/session.py`: `Session.new` writes `bundle.json`
   (`_write_bundle_json`), and `Session.summary` counts media.
3. Remember publishing: `publish.build_site` copies the whole working
   directory, so a new file in the bundle is also a new public file.
   `config.json` is the one thing that is published but not exported;
   `write_bundle` excludes it by name.
4. Export's missing-media check is `bundle.missing_media`, used by
   `export_bundle` in `main.py`.

**Fails if incomplete:** `backend/tests/test_bundle.py`, in particular
`test_round_trip_preserves_the_document_and_media`,
`test_an_unexpected_root_file_is_refused`,
`test_an_unexpected_file_outside_media_in_a_subdirectory_is_refused`,
`test_config_json_is_excluded_from_exported_bundles`,
`test_a_bundle_version_newer_than_this_build_understands_is_refused`; and
`backend/tests/test_publish.py` for what lands in the site.

## 7. Change the published site

1. `backend/app/publish.py`: `build_site` is the whole of it. It writes the
   application at the zip root and the working directory under `tour-data/`.
2. The contract with the viewer is the relative URLs in
   `frontend/src/app/core/tour-api.ts` (`TOUR_DATA`) and
   `<base href="./">` in `frontend/src/index.html`. Change the layout in
   `publish.py` and those together, or not at all. The viewer must keep
   working from files with no server; `app.routes.ts` keeps `**` pointing at
   `ViewerPage` so `https://host/tour/index.html` does not render a blank
   page.
3. What `config.json` holds is `_viewer_config` in `main.py`; the viewer reads
   it through `core/config-store.ts`.
4. Anything the viewer newly needs must come from `tour-data/`. It must never
   reach for `/api` (a published site has none).

**Fails if incomplete:** `backend/tests/test_publish.py`
(`test_the_site_contains_the_application_and_the_tour`,
`test_leaflet_media_and_tour_media_do_not_collide`,
`test_the_published_tour_document_is_the_working_one`); the spec *"reads
everything from tour-data/ and never touches /api"* in
`frontend/src/app/core/tour-api.spec.ts`; `viewer/viewer-page.spec.ts` for the
viewer's loading. The Playwright suite in `frontend/tests/e2e/` (`make e2e`) can
exercise the real thing but cannot run inside the Claude Code sandbox; nothing
in this repository's `make check` renders a page.

## 8. Change which media types are accepted

This rule lives in **three** places. Missing the third is how they drift.

1. **The backend allowlist**: `backend/app/media_store.py`. Add the type to
   `ALLOWED_TYPES` (sniffed MIME type to the one extension it is stored
   under) **and** teach `_sniff_type` its signature (a prefix in `_MAGIC`, or
   a branch for container formats like RIFF and ISO-BMFF). Update the message
   text in `sniff`. Bundle import needs no separate edit: `bundle.py` builds
   `_MEDIA_EXTENSIONS` from `ALLOWED_TYPES` (plus `.jpeg`) and sniffs with the
   same `_sniff_type`.
2. **The frontend mirror**: `frontend/src/app/editor/document-ops.ts`, the
   `IMAGE_EXTS` and `AUDIO_EXTS` arrays. They decide what *kind* a stored id
   is (`mediaKindOf`). Keep each on **one line** starting `const IMAGE_EXTS =`
   / `const AUDIO_EXTS =` with single-quoted `'.ext'` strings: the test finds
   them with a regex over the source.
3. **The test that ties them**:
   `test_the_frontend_extension_lists_match_the_allowed_types` in
   `backend/tests/test_media_store.py`. It does not need editing to pass, but
   its neighbour does: add a sample with a **real signature** to `SAMPLES` in
   the same file, or `test_allowed_types_covers_every_sample` fails (and
   `test_each_allowed_type_round_trips` is how the sniffing is proven).

**Four more copies the drift test does not see.** Check each by hand:

- `frontend/src/app/editor/outline-pane.html`: the `accept=` attributes on
  the image and audio file inputs (what the file picker offers).
- `frontend/src/app/core/tour-api.ts`: `AUDIO_TYPE_BY_EXTENSION`, which gives
  the `<source type>` for audio in the viewer (audio types only). Without an
  entry the viewer sends no `type` and a static host's guess decides whether
  it plays. Its spec checks only `.webm` and `.ogg`.
- `backend/app/main.py`: the `mimetypes.add_type` calls, for the editor's own
  process (`.m4a` and `.wav` only; the stdlib is wrong for these). A new type
  whose extension the stdlib mistypes needs a line.
- `frontend/src/app/editor/recorder.ts`: `extensionFor`, only a hint for what
  the browser records; the server picks the real extension.

**The third duplication**: `frontend/src/app/core/tour.models.ts` mirrors
`models.py` by hand with no drift test. `models.py`'s docstring says the
frontend interfaces mirror the exported JSON Schema; in fact
`test_json_schema_exports` only checks the schema has a title and a `stops`
property. Treat the TypeScript mirror as manual until someone writes that test.

**Fails if incomplete:** step 1 without step 2 fails the drift test
(`test_the_frontend_extension_lists_match_the_allowed_types`). Step 1 without a
`SAMPLES` entry fails `test_allowed_types_covers_every_sample`. Nothing fails
for the "four more" list.

---

## Quick index

| I want to change… | Start at |
| --- | --- |
| a field, a validation rule | `backend/app/models.py`, then entry 3 |
| what a visitor sees for a stop | `frontend/src/app/stop/stop-panel.ts`, `panorama/panorama-pane.ts` |
| how an in-world photograph is placed | `panorama/in-world-placement.ts` (pure), `panorama/in-world-renderer.ts` |
| the walking and arrival logic | `core/arrival.ts`, `core/tour-store.ts` |
| the editor's undo, selection or dirty state | `editor/editor-store.ts` |
| autosave timing or retry | `editor/autosave.ts` |
| an upload limit or the media id scheme | `backend/app/media_store.py` |
| import safety limits | `backend/app/bundle.py` (`MAX_TOTAL_BYTES`, `MAX_ENTRIES`) |
| a route or its error status | `backend/app/main.py` |
| where the working directory lives | `backend/app/config.py` (`Settings.work_dir`) |
| the seed tour | `content/source/stops.json`, `content/scripts/build_tour.py` (`make content`); `stops.json` has drifted and `make content` would revert the hand alignment, so see `HANDOFF.md` Outstanding item 2 first |
