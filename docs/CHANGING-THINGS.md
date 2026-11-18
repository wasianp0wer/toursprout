# Changing things

"Where do I change X?" One entry per task. Each lists the real files **in the
order to touch them**, then **what fails if you stop early**. Run everything
through `make` (`make check` runs lint, both test suites and the build).

Several of the project's rules cannot be enforced by a type or an import, so a
backend test reads the other side as **text** and fails when it drifts:

- `test_the_frontend_mode_table_matches_this_one` in
  `backend/tests/test_models.py` (display modes, Python vs TypeScript);
- `test_the_frontend_extension_lists_match_the_allowed_types` and
  `test_the_frontend_droppable_list_matches_the_import_allowlist` in
  `backend/tests/test_media_store.py` (media extensions, and the welcome
  screen's drop filter against the *import* allowlist);
- `test_the_content_pipeline_never_names_the_examples_directory` and
  `test_the_content_make_target_never_names_the_examples_directory` in
  `backend/tests/test_content.py` (the shipped examples are a frozen snapshot,
  so `make content` must not be able to write to them);
- `test_the_frontend_theme_vocabulary_matches_this_one` and
  `test_the_frontend_theme_overrides_have_the_same_thirteen_fields` in
  `backend/tests/test_models.py`, and the font tests in
  `backend/tests/test_fonts.py` (what a tour's theme may name, TypeScript vs
  Python, and the faces and licences those names resolve to; entry 11);
- *"still has nothing that recovers a map measured at the wrong size"* in
  `frontend/src/app/entry/entry-page.spec.ts` (the premise under the
  hidden-wrapper CSS rule). This one is **inverted**: it fails when someone
  makes the code better, because three documents say there is no recovery and
  they have to change in the same breath. A guard like that needs a docstring
  saying so, or the next reader weakens it to get a green build.

That is the pattern to copy whenever you create a rule that lives in two
places, or a guarantee a document makes on code's behalf: this repository's
answer to documentation going stale is a test that fails. This file says
plainly, entry by entry, where a test exists and where it does not.
Where one does not, the step is only a convention; do not trust the green
build to catch it. For the shape of the system see
[`ARCHITECTURE.md`](ARCHITECTURE.md).

A note on additive versus breaking. Widening what a document may contain *within
an existing field* (a new `kind`, a new `display` mode) leaves every existing
document valid and needs no migration. A new optional **field** does not get
that: `extra="forbid"` rejects it for an older reader, so it is a schema
change with a version bump even though no existing document changes (ADR 0005;
`theme` in v4 is the worked example, and its migration step is a version
stamp and nothing else). Anything that makes a previously valid document
invalid, or changes its shape, is a schema change too: see entry 3.

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
bundles live outside this repository, session directories persist between runs (and, on the host, between deploys),
and the committed seed tour is a document too. Without a migration those are
rejected. And `PUT /api/session/tour` does not migrate (`Session.write_tour`
validates against the current schema only), so an old document that reaches
the editor unmigrated cannot even be saved. Migration is the only door.

1. `backend/app/models.py`: change the models; bump `SCHEMA_VERSION` and the
   `schema_version: Literal[N]` on `Tour` (they are two separate places).
2. `backend/app/migration.py`: add a `_vN_to_vN+1` function and one entry in
   `_MIGRATIONS`. **Nothing else.** `migrate` is the single entry point and
   the registry chains the steps, so the call sites — `Session.tour`
   (`session.py`), `_validate_tree` and `missing_media` (`bundle.py`) — do
   not change. A step is pure (dict in, dict out, input never mutated), must
   stamp its own target version rather than `SCHEMA_VERSION` (or it will
   silently relabel the step before it), and must be total: refuse loudly
   rather than drop data, as `_migrate_overlays` does for an unknown kind.
   Where the new rule is a tightening, prefer repairing the document to
   refusing it — `_rename_colliding_overlay_ids` is the pattern — and refuse
   only where there is no honest value to invent, as with a blank licence.
   ADR 0005.
3. `backend/app/session.py`: `skeleton()` reads `SCHEMA_VERSION`, so the
   version itself needs nothing; update the shapes in it if fields changed.
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

**Freeze a fixture of the version you are leaving.** `backend/tests/fixtures/`
holds `fairfax-old-town-v1.json`, `-v2.json` and `-v3.json`, each a
snapshot of the repository's real tour at that version, never refreshed. They
are what makes the chain testable against real content instead of comparing
an already-current document to itself. The next bump, to v5, needs
`…-v4.json` frozen first: snapshot the real tour at v4 before you change the
models.

**Fails if incomplete:** `backend/tests/test_migration.py` (add cases for each
migrated shape; `test_the_real_tour_migrates_and_validates`,
`test_the_real_v2_tour_migrates_and_validates` and
`test_the_v1_fixture_migrates_through_three_steps_to_the_current_version` run
real content through the chain);
`test_the_shipped_tour_is_valid_at_the_current_version` and
`test_build_tour_emits_the_current_schema_shapes`
(the seed and the generator); `test_the_shipped_tour_round_trips_byte_identically`
and `test_a_v1_bundle_is_migrated_on_import` in `backend/tests/test_bundle.py`;
`test_a_version_newer_than_this_build_is_refused` and
`test_unsupported_schema_version_is_refused` in `test_migration.py`. **Nothing fails** if `tour.models.ts`
is left behind and no code uses the changed field, *except* that the frontend's
`integration/real-tour.spec.ts` reads the committed seed tour and asserts its
`schemaVersion`, so bump that literal too; beyond it the schema's TypeScript
mirror has no drift test (see "the third duplication" under entry 8). Also note
that migration runs on **import**, not at startup: a stale `tour.json` already
in a session directory is not migrated by restarting the backend. Re-import the
bundle.

## 4. Add an acquisition tool

1. `backend/app/tools.py`: the function (takes an `httpx.Client`, returns
   data, raises `ToolError` with the HTTP status the route should use, has an
   explicit timeout) and a request model beside the others
   (`PlacesRequest`). All outbound HTTP is `httpx`, never
   `urllib` (`docs/ENVIRONMENT.md`).
2. `backend/app/main.py`: a route under `/api/tools/…` inside `create_app`,
   next to `places`, the one tool left. (Panorama search lives in the browser
   in `core/mapillary-search.ts`, and archive search and narration were
   removed: ADR 0006 says why. Check that the host can reach the service you
   want to add before writing it as a server tool: `GET
   /api/diagnostics/egress` reports what it can reach.) It must carry
   `dependencies=[Depends(_reject_cross_site)]`, be a plain `def` (blocking
   calls belong in the threadpool), map `ToolError` to
   `HTTPException(status_code=exc.status, …)`, and build its client with
   `_tool_client(timeout)` so tests can swap the transport. If the tool
   produces a file, store it with `store_media` and return the `mediaId`
   (the client never names a file).
3. `frontend/src/app/core/tools-api.ts`: a `ToolsApi` method that goes through
   the private `post` helper (which turns failures into messages).
4. A consumer: `editor/inspector-pane.ts` (placing a stop) or
   `editor/outline-pane.ts` (adding content). If the result becomes document
   content, build it in a pure op in `editor/document-ops.ts`
   and have the component only call `store.apply`. Network first, document second: a
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
3. `''` is `EntryPage`, not the viewer. `build_site` marks the zip's
   `index.html` (`mark_published`: valueless `data-published` on `<html>`) and
   writes every entry at 0644; the on-disk `dist/index.html` is deliberately
   left unmarked. `isPublishedPage` in `entry/entry-page.ts` is where the
   decision lives: marked, it reveals the `ViewerPage` it already mounted and
   makes no `/api` request; unmarked, it probes, with the deadline
   `AUTHORING_HOST_FALLBACK_MS` (30 s). **Everything in `EntryPage` is
   downloaded and run by the public**, ADR
   [0010](decisions/0010-a-published-page-knows-it-is-published.md). Keep it
   small, keep the welcome screen inside its `@defer` block (importing
   `WelcomePage` anywhere outside it silently pulls the chunk into the eager
   bundle), and read "Routing: who is asking" in
   [`ARCHITECTURE.md`](ARCHITECTURE.md) before touching `entry/entry-page.css`
   — two of `.viewer-slot[hidden]`'s three declarations (`display: block` and
   `visibility: hidden`) are what keep the viewer's layout box while it is
   hidden, and without the box Leaflet initialises at 0×0 and never recovers.
   The third, `pointer-events: none`, is inertness rather than layout.
4. **A published site is served by headers you do not control.** The
   `Cache-Control: no-cache` the `tour_data` route sends applies only in the
   editor; on a static host the document is served by that host. That is why
   `TourApi` asks to revalidate from the client as well — it is the only
   guard that travels with the application. Do not "tidy" it away as
   redundant with the server header (`UNVERIFIED.md` entry 44).
5. What `config.json` holds is `_viewer_config` in `main.py`; the viewer reads
   it through `core/config-store.ts`.
6. Anything the viewer newly needs must come from `tour-data/`. It must never
   reach for `/api` (a published site has none). `EntryPage`'s probe is the
   one `/api` call on the published path, and it belongs to the router, not to
   the viewer.

**Fails if incomplete:** `backend/tests/test_publish.py`
(`test_the_site_contains_the_application_and_the_tour`,
`test_leaflet_media_and_tour_media_do_not_collide`,
`test_the_published_tour_document_is_the_working_one`); the spec *"reads
everything from tour-data/ and never touches /api"* in
`frontend/src/app/core/tour-api.spec.ts`; `viewer/viewer-page.spec.ts` for the
viewer's loading; `entry/entry-page.spec.ts` for the published branch — it
covers a failed probe, a 200 of HTML, a timeout, and (by reading the CSS as
text) the hidden-but-laid-out wrapper. The Playwright suite in
`frontend/tests/e2e/` (`make e2e`) can exercise the real thing but cannot run
inside the Claude Code sandbox; nothing in this repository's `make check`
renders a page.

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

`DROPPABLE_MEDIA_EXTS` in `document-ops.ts` — what the welcome screen's drop
filter accepts — is **derived** (`[...IMAGE_EXTS, '.jpeg', ...AUDIO_EXTS]`), so
it is not a fifth copy and needs no edit. It mirrors `bundle.MEDIA_EXTENSIONS`,
which is `ALLOWED_TYPES` plus `.jpeg` on the backend side, and
`test_the_frontend_droppable_list_matches_the_import_allowlist` ties the two
together. Keep both derived rather than listing extensions again: the
filter exists so the author reads "left out" instead of a refusal, and a drop
filter stricter than the import allowlist silently discards media the backend
would have taken.

**The third duplication**: `frontend/src/app/core/tour.models.ts` mirrors
`models.py` by hand with no drift test. `models.py`'s docstring says the
frontend interfaces mirror the exported JSON Schema; in fact
`test_json_schema_exports` only checks the schema has a title and a `stops`
property. Treat the TypeScript mirror as manual until someone writes that test.

**Fails if incomplete:** step 1 without step 2 fails the drift test
(`test_the_frontend_extension_lists_match_the_allowed_types`). Step 1 without a
`SAMPLES` entry fails `test_allowed_types_covers_every_sample`. Nothing fails
for the "four more" list.

## 9. Add a new way of getting a tour into the session

There are four today — a `.zip`, a loose `tour.json` plus its media, a shipped
example, and an empty tour — and they converge on one function. A fifth
belongs in that shape, not beside it.

1. **Produce a bundle zip and hand it to `Session.replace_from`.** Do not
   write to the working directory yourself. `replace_from` → `read_bundle` is
   where the media allowlist, the schema migration, the orphan warnings and
   the staged atomic swap live, and every one of them is a thing a second
   implementation would get subtly wrong. `backend/app/bundle.py` gives you
   `stage_bundle_root(root, document, media_streams)` and `write_bundle`;
   `loose_import.stage_loose_bundle` and `examples.open_example` are the two
   worked examples, and both are short because of it.
2. **Use the import allowlist, never `store_media`.**
   `bundle._check_media_file` preserves file names and nested directories;
   `media_store.store_media` renames every file to `<slug>-<contenthash><ext>`
   and flattens it into `media/`. A tour's document names its media, so the
   upload door breaks every id it touches. See "Media comes in by two doors"
   in [`ARCHITECTURE.md`](ARCHITECTURE.md). This is the single most expensive
   mistake available in this area.
3. **Filter in the frontend, refuse in the backend — both.** The route refuses
   a part it does not recognise and refuses the whole drop with it, which is
   correct defence in depth and a terrible way for an author to find out that
   one `manifest.json` came along. So `welcome/dropped-files.ts` answers every
   refusal it can see coming (`sortDrop`, `problemWith`) and reports what it
   left out; the backend stays strict. Add a new refusal in `loose_import.py`
   and you add its counterpart there, or the author pays a round trip to be
   told something the screen already knew.
4. `backend/app/main.py`: the route, under `/api/session/…`, with
   `dependencies=[Depends(_reject_cross_site)]`. Map the module's exceptions
   (`BundleError`, `ExampleError` → 400; an unknown id → 404) and refuse with
   409 if a tour is already open *when the route replaces rather than
   imports* — `new` and `examples` do, `import` and `import-files`
   deliberately do not, because the welcome screen is the only caller and it
   is only reachable with nothing open. Call
   `session.write_config(_viewer_config(app.state.cfg))` afterwards, as every
   other way in does, or the viewer has no Mapillary token.
5. `frontend/src/app/core/session-api.ts`: the method, going through `send`
   so a failure arrives as an `Error` carrying the backend's own `detail`.
6. `frontend/src/app/welcome/welcome-page.ts`: the control, calling
   `this.open(() => …)`. That helper owns the whole shape — set `busy`, show
   the backend's message on failure, navigate to `/edit` only on success, and
   leave `busy` set if the navigation itself fails so nothing can be used
   against a session that now has a tour in it. Do not reimplement it.

**Fails if incomplete:** `backend/tests/test_examples.py` and
`test_loose_import.py` are the patterns to copy, and
`test_opening_the_fairfax_example_matches_the_recorded_figures` is the one
that catches step 2 — it pins `stopCount` 6, `mediaCount` 15, `orphanCount` 0
and the surviving `media/pano/` paths against the repository's real content.
Step 4's dependency is covered by a per-route test and nothing more —
`test_delete_session_refuses_cross_site` in `test_session_api.py`,
`test_post_example_refuses_cross_site` in `test_examples.py`,
`test_refuses_cross_site` in `test_loose_import.py` — so **a new route that
forgets `_reject_cross_site` fails nothing until you write its test**. Write
it with the route. **Nothing fails** if you skip step 3: the drop simply
gets refused whole, with the server's wording, which is the defect the front
door was built to remove.

## 10. Change what `/` decides, or add a route

`frontend/src/app/app.routes.ts` is still the whole router, and its comment is
the argument for each route's eagerness; read it before moving anything.

1. `app.routes.ts`. `''` is `EntryPage` (eager), `view` and `**` are
   `ViewerPage` (eager), `edit` is lazy, and `**` must stay last. A new
   authoring route is lazy. A new route that a *published* site could reach
   is a different question — there are only two such URLs, `/` and
   `index.html` — and the answer is almost certainly no.
2. `frontend/src/app/entry/entry-page.ts` for the decision itself. The three
   outcomes and why each is what it is are in "Routing: who is asking"
   ([`ARCHITECTURE.md`](ARCHITECTURE.md)). Two rules that are not obvious from
   the code: a non-JSON 200 must be treated as "no backend", because that is
   what a static host with SPA rewriting answers and the cost of believing it
   is showing the workbench to the public; and anything that resolves the
   probe must also check `gone`, because the visitor may have navigated away
   inside the probe window and deciding on their behalf would move them.
3. `entry/entry-page.html` and `entry-page.css` together. The viewer is
   mounted from the first paint and hidden, so its `tour-data/` fetches run
   concurrently with the probe; hiding it with `display: none` gives Leaflet a
   0×0 container and there is no `invalidateSize` anywhere to recover — a
   guard test in `entry-page.spec.ts` stops that stopping being true without
   anyone noticing. If you need the probing state to show something, add it to
   the `probing` branch — do not reveal the viewer earlier.
4. `AUTHORING_HOST_FALLBACK_MS` if the deadline is what is wrong. It applies
   to an unmarked page only, and exists so that an unpublished bundle
   hand-copied onto a host that black-holes `/api/session` degrades instead of
   hanging. The cost of raising it is a longer blank page for that visitor; the
   cost of lowering it is an author on a slow host being sent to the viewer,
   which is what the old 2 s did (the host answers in 12-73 s).

**Fails if incomplete:** `frontend/src/app/entry/entry-page.spec.ts` covers
all three outcomes, the timeout, the HTML-200 case, the concurrent viewer
bootstrap, the already-left case, and the CSS declarations (read as text,
because jsdom computes no layout). `app.spec.ts` covers the route table
itself: `''` to the entry page, `view` to the viewer, `edit` to the editor.
**Nothing
fails** if you break the published site's *appearance* — no test in this
repository renders a page, so entries 19 to 22 of
[`UNVERIFIED.md`](UNVERIFIED.md) are the only check that exists.

## 11. Change what an author can theme

A theme is a preset, thirteen colour overrides, a type pairing, a type scale
and a layout, stored in `tour.json` (ADR
[0009](decisions/0009-the-look-is-in-the-document.md)). **`core/theme.ts` is
the one place the token set is defined**; every other copy is derived from it
or checked against it. Adding a *value* to an existing choice (a fifth preset,
a fourth layout) is a vocabulary change; adding a *token* is a schema change as
well, so start at entry 3.

1. `frontend/src/app/core/theme.ts`: the four vocabulary arrays
   (`PRESET_NAMES`, `TYPE_PAIRINGS`, `TYPE_SCALES`, `LAYOUT_NAMES`) **each on
   one line with single-quoted strings**, because a backend test finds them by
   regex over the source; the `PRESETS` table; and, for a token, the
   `ThemeOverrides` interface, `OVERRIDABLE_TOKENS` and, for a token the viewer
   paints, the `ColourToken` union and `CSS_TOKEN_SET`; `OVERRIDABLE_TOKENS` and
   `CSS_TOKEN_SET` are `Record`s over their key types, so forgetting one is a
   compile error, then `resolveTheme`'s derivation. If the token is one a
   preset pins only to reproduce the pre-theming appearance, add it to
   `LEGACY_PINS` too, so the pin yields once the author overrides a core
   colour; a token that is not derived from the core must stay off that list.
   If you change a derivation **ratio**, measure it: `theme.spec.ts` holds a
   contrast floor per painted pair per preset, and it is the only thing that
   will notice.
2. `backend/app/models.py`: the matching `Literal` on `Theme`, or the field on
   `ThemeOverrides`. A token is `HexColor | None` and nothing else: do not add
   a free-form string to a theme, ever. Everything the viewer interpolates must
   be an enumerated name or a six-digit hex, which is what makes an imported
   bundle safe to serve from the author's origin.
3. `frontend/src/app/core/tour.models.ts`: the mirror, by hand.
4. If it is a type pairing: the `@font-face` rules (a latin and a latin-ext
   pair per face, 14 today) and the `[data-type-pairing='…']` rules in
   `frontend/src/styles.css`, the files in
   `frontend/src/assets/fonts/`, and an `OFL-<family>.txt` per family (the
   licence is the condition on redistributing them, and `angular.json` copies
   it to `fonts/` by an explicit `assets` entry, because nothing resolves a
   `url()` to a text file). Keep `font-weight: 400 600` on a variable face:
   it is what lets a UA `bold` heading land on a real 600.
5. If it is a layout: a `:host([data-layout='…'])` block in
   `viewer/viewer-page.css`, and check the narrow-width stacking still wins
   (the 900 px media query repeats the layouts' specificity on purpose).
6. If it is a token the viewer paints: consume it as `var(--token)` in the
   viewer's stylesheets, and **write it on the viewer's host element, never
   `:root`** (`ARCHITECTURE.md`, "What each layer may not do"). A colour that
   is not CSS — a Leaflet option, an inline style, mapillary-js's WebGL
   markers — must be handed over as a value: `setMarkerColours` for the
   markers, `MapPane`'s `theme` input for the pins and route. Never through a
   root-provided store, because the editor shares the `PanoramaViewer`.
7. `frontend/src/app/editor/theme-dialog.ts` and `.html`: the control; and
   `editor/theme-preview.ts` / `.css`, which draws the miniature from the same
   tokens.
8. `frontend/src/app/editor/document-ops.ts` and `.spec.ts` if it needs an op
   (entry 5). Every op compares against the *defaulted* theme, so a tour with
   no stored theme still returns the same reference for a change that did not
   happen.

**Fails if incomplete:** the drift tests read the other side as text.
`test_the_frontend_theme_vocabulary_matches_this_one` and
`test_the_frontend_theme_overrides_have_the_same_thirteen_fields` in
`backend/tests/test_models.py` fail when `theme.ts` and the Python `Literal`s
or `ThemeOverrides` disagree; the font tests in `backend/tests/test_fonts.py`
fail when a pairing has no `[data-type-pairing]` rule, when a rule names a
family nothing declares, when a declared family has no licence file, and when
`angular.json` stops copying the licences; and the preview's token-subset test
in `editor/theme-dialog.spec.ts` (*"uses only token names the viewer also
defines"*) fails when the miniature reads a token the viewer does not define —
which is also the test that noticed `--on-accent` was read by nothing, and
which compares against the viewer's stylesheets *and* the names
`cssVariablesFor` emits, so a rename on either side fails it. The Nocturne
table in `core/theme.spec.ts` fails if a preset value drifts from what the
application shipped, and the contrast suite beside it (*"contrast, for every
pair the viewer paints"*) fails if a derivation, a preset colour or a new
painted pair puts text below its floor on any of the four presets. The
`BELOW_AA` table there is the list of pairs knowingly under the standard, and
it prunes itself: a pair that rises above AA fails until its entry is
deleted. **Nothing fails** for a `font-weight` descriptor
"tidied" to a single value, for a layout block that renders badly, for a font
that resolves at build time and 404s on a published site, or for the preview
drifting from the viewer in any way a token name does not show: all of those
are `UNVERIFIED.md` entry 43.

---

## Quick index

| I want to change… | Start at |
| --- | --- |
| a field, a validation rule | `backend/app/models.py`, then entry 3 |
| what an author can theme: a preset, a colour, a typeface, a layout | `frontend/src/app/core/theme.ts` (the one definition), then entry 11 |
| what a visitor sees for a stop | `frontend/src/app/stop/stop-panel.ts`, `panorama/panorama-pane.ts` |
| how an in-world photograph is placed | `panorama/in-world-placement.ts` (pure), `panorama/in-world-renderer.ts` |
| the walking and arrival logic | `core/arrival.ts`, `core/tour-store.ts` |
| the editor's undo, selection or dirty state | `editor/editor-store.ts` |
| autosave timing or retry | `editor/autosave.ts` |
| an upload limit | `backend/app/config.py` (`Settings.max_media_file_bytes`, `max_session_media_bytes`: the live values; `DEFAULT_MAX_FILE_BYTES` and `DEFAULT_MAX_SESSION_BYTES` in `backend/app/media_store.py` are only their defaults) |
| the media id scheme | `backend/app/media_store.py` |
| import safety limits | `backend/app/config.py` (`Settings.max_bundle_bytes`, `max_bundle_entries`: the live values; `DEFAULT_MAX_BUNDLE_BYTES` and `DEFAULT_MAX_ENTRIES` in `backend/app/bundle.py` are only their defaults) |
| a route or its error status | `backend/app/main.py` |
| where session directories live, how long they are kept, or a resource cap | `backend/app/config.py` (`Settings.sessions_dir`, `session_retention_days_*`, `max_*`); the sid and the sweep are in `backend/app/sessions.py` |
| the seed tour | `content/source/stops.json`, `content/scripts/build_tour.py` (`make content`); `stops.json` has drifted and `make content` would revert the hand alignment, so see `HANDOFF.md` Outstanding item 2 first |
| a way of getting a tour into the session | entry 9; produce a bundle zip and hand it to `Session.replace_from`, never `store_media` |
| what `/` decides, or a route | `frontend/src/app/app.routes.ts`, then entry 10 |
| the welcome screen's drop filter or its messages | `frontend/src/app/welcome/dropped-files.ts` (pure), then `welcome-page.ts` |
| the close dialog's gate, or the bundle download | `frontend/src/app/editor/close-dialog.ts`; the teardown order is `editor-page.ts`'s `closeTour` |
| a shipped example | `content/examples/<id>/example.json`; `backend/app/examples.py` reads it. `make content` must keep leaving that directory alone, and `test_content.py` fails if a script or the `content:` recipe names it |
