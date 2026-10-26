# Welcome-screen branch: findings left open

Written 2026-10-26, at the end of the welcome-screen sub-project
(`docs/superpowers/specs/2026-10-26-welcome-screen-design.md`,
`docs/superpowers/plans/2026-10-26-welcome-screen.md`).

Every item here was found by a review during that work, judged, and
deliberately **not** fixed. Nothing is a known-broken feature: the branch's
`make check` is clean and the final whole-branch review found no Critical
issue. These are the things a reviewer saw, said out loud, and left for
someone with more context or a browser.

They are kept because the alternative was deleting them with the scratch
workspace they were recorded in.

## Follow-ups the final review named, in its own order of priority

1. **`PUT /api/session/tour` can lose work silently, and nothing guards it.**
   `backend/app/main.py` guards it on `is_open` alone — no tour id, no
   version — and `Session.write_tour` overwrites `tour.json` wholesale. So a
   stale *editor* tab's autosave writes its document over whatever tour is
   open now, orphaning that tour's media. This is the same stale-second-tab
   shape as the two import holes this branch closed, one layer down, and it
   is the one remaining way to lose the author's work without saying so. An
   `id` comparison would close it. **This is the top follow-up.**

2. **`import_bundle` still runs its heaviest work on the event loop.**
   `main.py` has it as `async def`, so for any import that is not refused
   (nothing open, or a `force`d one) the full `copyfileobj` plus
   `read_bundle`'s extract-validate-swap of up to 512 MB stalls the
   backend — including the `tour-data/` media the editor is displaying.
   Nothing in its body awaits, so it is the identical one-word change
   `import_files` took in this branch. It is now the only asymmetry left
   between the two import routes.

3. **The `.zip` route wants a `Content-Length` cap — and must not get a copy
   of the loose route's check.** `bundle._check_safe` is metadata-only and
   refuses before `_extract_safely` reads anything, so no uncompressed
   expansion precedes the cap and the loose route's triple write has no
   counterpart here. But the route does still write the whole *compressed*
   archive to `$TMPDIR` before `_check_safe` sees it, with no declared-length
   guard; `_limit_media_upload` is scoped to `/api/session/media` alone.
   `file.size` is a compressed byte count and `MAX_TOTAL_BYTES` is an
   uncompressed one, so comparing them would be wrong.

## Parked minor findings, by the task that produced them

Each was rated Minor by the review that found it, and the final whole-branch
review triaged all of them as "stays parked" except the one it promoted
(the loose-route cap, fixed in this branch) and one it ruled on
(`closing.set(false)`, kept deliberately and now commented).

- **Task 1.** `close()` gates on `is_open` (tour.json present), so a working dir existing without tour.json returns 409 and cannot be cleared via this route. `new(force=True)` still clears it, so not a dead end. Brief-mandated behaviour.
- **Task 1.** `shutil.rmtree` can raise OSError partway, leaving a partially deleted directory and surfacing as a 500. Inherited from `new`, not introduced here; no test covers it.
- **Task 1.** `test_close_removes_the_working_directory` asserts `is_open`/summary but not `not session.path.exists()`. One extra assertion would pin removal directly.
- **Task 2.** examples.py:185 `_inside`'s refusal message names neither the example nor the manifest key, so `"mediaDir": "../../.."` reports a bare `..`.
- **Task 2.** test_examples.py:185 one of six parametrised "escape" ids (`"media"`) is not an escape attempt and would pass with the guard removed; all six raise KeyError, so the loose `(KeyError, ExampleError)` tuple would not notice a traversal id caught later in the pipeline. Brief-derived shape.
- **Task 2.** test_examples.py:231 asserts the Fairfax warnings by count plus substring, so six warnings about the wrong six files would pass.
- **Task 2.** test_examples.py:166 "source media untouched" compares relative names only, not bytes or mtimes.
- **Task 2.** the media ExampleError message (`could not read media/{rel}`) omits the example id, unlike the module's other messages, so the route detail names the file but not the example. Cosmetic.
- **Task 3.** loose_import.py:62-67 no size or entry-count cap before staging, where the zip route refuses from metadata before writing (`_check_safe`, MAX_ENTRIES/MAX_TOTAL_BYTES). A large drop is materialised twice on disk then refused, and tour.json is parsed uncapped. Amplification of existing exposure (Starlette has already spooled the parts), not a new one; matching the caps is a bigger change than this round should carry.
- **Task 3.** main.py:252 `async def` runs the branch's heaviest blocking disk work on the event loop (copy, deflate, extract, validate, swap). Not a regression — `import_bundle` already runs `replace_from` on the loop — but `upload_media` is plain `def` for exactly this reason, so both import routes should move to the threadpool together in a later change.
- **Task 3.** the repeated-path check is case-sensitive, so `Photo.jpg` and `photo.jpg` collide on a case-insensitive filesystem without being caught. The zip route has the same gap; a repo-level issue, not this task's.
- **Task 4.** the blob-parse test asserts /missing/ rather than the verbatim detail, and readBlobError's non-JSON and empty-blob fallbacks have no test.
- **Task 4.** only the 413 string is asserted not to say "upload"; the unreachable and generic fallbacks were also reworded and are unchecked.
- **Task 4.** openExample does not assert the empty body, and encodeURIComponent is not exercised with an id containing `/` or a space.
- **Task 4.** `uploadMedia` keeps its own try/catch duplicating `send()`, and five methods are marked `async` only to return `send(...)`.
- **Task 4.** the get/putTour raw-rejection asymmetry is documented only on `sessionMessage`, not at the two methods where a reader might "fix" it.
- **Task 4.** the report's original concern section is stale — superseded by its own fix section.
- **Task 5.** the mechanism's rationale appears in five places (app.routes.ts, entry-page.ts class and method docstrings, entry-page.html, entry-page.css) plus the spec comments; a change to the mechanism would mean editing five prose copies.
- **Task 5.** session-api.ts:48-56 the rewritten `get()` docstring documents the new deadline but not the raw-rejection asymmetry it sits on. Reviewer also observed entry-page.ts:71-77 catches shape-blind, so the recorded "branch on the failure's shape" rationale has no consumer today.
- **Task 5.** the navigation `.catch` can call `decision.set('published')` after destruction — a harmless signal write on a dead component that nobody reads. Re-reviewer rated it Minor at most and did not require a fix.
- **Task 5.** the destroy guard is a manual `gone` boolean where `takeUntilDestroyed` would be idiomatic. Functionally fine.
- **Task 6.** `dragleave` on child elements will flicker the drop-zone highlight. Cosmetic and not verifiable without a browser.
- **Task 6.** `busy` means both "a request is in flight" and "this screen is finished"; the template already needs `@if (busy() && !error())` because of it, so the next control keying off `busy` for a spinner will spin forever.
- **Task 6.** entry-page.spec.ts:203 ties Ruling 10's guard to the builder's cwd via `process.cwd()`; `import.meta.url` would be independent of invocation.
- **Task 6.** welcome-page.spec.ts has no `afterEach(() => http.verify())`, so an unexpected request to a different URL goes unnoticed and one test deliberately leaves a request unflushed. Note this is house convention — no spec in the repo calls verify().
- **Task 6.** untested paths — readDroppedFiles' rejection branch, loadExamples' catch (whose docstring argues it matters because "no examples configured" and "could not list examples" otherwise look identical), and the over() highlight.
- **Task 6.** the two-inputs rationale is written out twice at similar length (welcome-page.html:25-30 and welcome-page.ts:172-180).
- **Task 6.** MAX_FILES has no test and counts only files, not directory nodes, so a cyclic tree of file-less directories is bounded only by depth. Re-reviewer notes removing MAX_FILES would go unnoticed by the suite; removing MAX_DEPTH is what blows up.
Task 6: minor (deferred) — A REGRESSION FROM MY OWN RULING 13: the window-level guard's `preventDefault` on `window:drop` also blocks dropping text into the `[data-new-title]` input, and `preventDefault` on `dragover` shows a "can drop here" cursor over the whole page while the welcome screen is mounted. Neither is covered by a test. Listeners are correctly scoped — Angular host listeners attach on creation and detach on destroy, and inside `@defer` that means only while the welcome screen is mounted, so the editor's own drag handling is unaffected. FLAG TO THE FINAL REVIEW: this is a self-inflicted cost of the stray-drop guard, and whether the guard is worth it is a judgment the final review should make rather than inherit.
- **Task 6.** the "could not be read" message does not say which limit was hit.
- **Task 6.** the rename hint is suppressed when the real document sits inside media/ by mistake (e.g. media/mytour.json); the author gets the accurate generic message instead.
- **Task 7.** formatBytes has no GB tier, so a 1.2 GB bundle reads "1200.0 MB".
- **Task 7.** editor-page.ts:145 `closing.set(false)` runs before the DELETE, so a refused close destroys the dialog and the author's download/acknowledge state with it; they must re-acknowledge to retry. Deserves a deliberate decision rather than being a side effect of unmount order.
- **Task 7.** editor-page.spec.ts has no http.verify(), so refreshMediaCount's GET is left unflushed in five tests and nothing would catch the probe firing when it should not.
- **Task 7.** a second Download click while one is in flight is correct in code (early return plus [disabled]) but untested.
- **Task 7.** close-dialog.spec.ts's focus test does not pin Minor 4's move — the assertions would all have passed on the old structure where the scrim held role="dialog", so putting the role back on the scrim would not fail. One `expect(dialog.classList.contains('panel')).toBe(true)` would pin it.
- **Task 7.** Minor 1's new assertion was not mutation-checked.
- **Task 8.** none; all six went into the fix round.
- **Task 8.** the corrected entry 14 does not mention the drop would also show a skipped-files notice listing scripts, json and .pyc files.
- **Task 8.** UNVERIFIED.md entry 20 has one long unwrapped line.
- **Task 8.** on a failed probe nothing on screen points the reader at the Network tab; the old message's HANDOFF pointer is gone, though UNVERIFIED entry 1 covers it.

## Known pre-existing noise, not from this branch

- The backend suite emits deprecation warnings from starlette/anyio
  (`anyio.abc.BlockingPortal`) and from fastapi's testclient about httpx.
- `ng build` warns that `leaflet`, used by `edit-map-pane.ts`, is not ESM and
  may cause optimization bailouts.
- The frontend run emits six `Not implemented: Window's scrollTo() method`
  lines from jsdom.

All three predate this work and were confirmed as such during it.
