# Documentation: so the author can take the project back

Sub-project 4 of 4, the last. See
`docs/superpowers/specs/2026-10-12-authoring-application-overview.md`.

## Why, and what the author actually asked for

The brief was specific. Not an end-user manual, not contributor onboarding:

> Documentation for **you-as-developer**: architecture map, a "where do I
> change X" index pointing at real files, decision records for the non-obvious
> calls, and generous in-code explanation of *why*.

Three sub-projects have since rewritten the schema, deleted the API and the
database, and added a four-surface editor with media upload, recording and
four acquisition tools. The code grew from about 5,700 lines to roughly three
times that. **Nobody has ever seen any of it running**, because no browser can
launch in the development sandbox.

So this sub-project's job is to make the result navigable by one person
returning to it cold, and honest about what is unproven.

## What already exists, and what is missing

**Done, and good.** Four decision records — `0001` the three overlay axes,
`0002` the portable document, `0003` the editor's three surfaces, `0004` media
and acquisition. Reviews judged them candid: `0004` opens its verification
section with "Three shapes rested on recalled documentation; two of those were
wrong", and records an overreach beyond the authorised hosts rather than
burying it. In-code rationale is unusually strong in the places that matter —
`media_store.py`'s "the client never chooses the name", the heading gate's
"do not remove or loosen this", the autosave scheduler's invariants.

**Missing:**

1. **An architecture map.** There is no single document that says what the
   parts are and how a request or an edit flows between them. A reader today
   must infer it from four specs written at four different times, each
   describing the world as it was then.
2. **A "where do I change X" index.** Explicitly asked for; never written.
3. **A `HANDOFF.md` that is true.** It has grown by accretion — a dated
   past-session record with four sub-projects appended to it. Each addition was
   honest, but the document now buries the current state under history, and its
   bootstrap procedure is **actively broken** (below).
4. **An inventory of what is unverified.** It exists, scattered across ADRs,
   HANDOFF items and review notes. It is the single most important thing for
   the author to have in one place, because it is the list of what to check
   first in a browser.

## The broken procedure, which this sub-project must fix first

`docs/HANDOFF.md`'s bootstrap sequence tells the author to
`cp content/media/* content/work/media/`. That sweeps in
`content/media/manifest.json`. Sub-project 3b then tightened bundle import to
refuse any file under `media/` that is not an allowed image or audio type —
correctly, since the import path previously let an `.html` through onto the
author's own origin.

So the documented way to load the real six-stop tour now produces a bundle the
importer refuses, and the passage still claims it "succeeds with one warning".
That is the author's most likely first action.

The refusal is right; the procedure is wrong. Fix the procedure, re-run it, and
write down what actually happened.

## What gets written

- **`docs/ARCHITECTURE.md`** — the parts, their boundaries, and the three flows
  that matter: how a tour is read in the viewer, how an edit reaches disk, and
  how a published site is produced. Short enough to read in one sitting, with
  the reasoning left in the ADRs rather than repeated.
- **`docs/CHANGING-THINGS.md`** — the "where do I change X" index, each entry
  naming real files: add an overlay kind, add a display mode, change the
  schema, add a tool, change what the editor can edit, change what a bundle
  contains, change the published site.
- **`docs/HANDOFF.md`, consolidated** — current state first, history after. It
  keeps its honesty about what is unproven; it stops making the reader
  archaeologise.
- **`docs/UNVERIFIED.md`** — everything no one has seen work, gathered in one
  place, each with the check that would close it. This is the author's
  first-session checklist.

## What this sub-project is not

Not an end-user manual. Not contributor onboarding. Not a rewrite of the ADRs,
which are deliberately immutable records of their moment — if one is wrong, a
later record supersedes it rather than editing it.

**And not the pipeline retirement.** `content/source/stops.json`, `make
content` and `build_tour.py`'s generation stay until the author says
otherwise. Sub-project 3b left that gate closed on purpose; documentation does
not get to open it.

## Testing

Documentation has one failure mode worth testing for: **being false**. Every
factual claim — a path, a command, a count, an endpoint, a field name — must be
checked against the repository, and the bootstrap procedure must be **run**,
not reasoned about.

`make check` must stay green at **320 pytest / 528 Vitest**. Prose changes
nothing; if a count moves, something is wrong.

Where a claim cannot be checked here — anything needing a browser — it is
recorded in `UNVERIFIED.md` rather than asserted.

## Acceptance

A reader who has never seen this repository can, from the documentation alone:
say what the parts are and how they fit; find the file to change for each entry
in the index; follow the bootstrap procedure successfully; and list what has
never been proven to work.

## Risks

- **Documentation drifts from code the moment it is written.** Mitigated by
  pointing at files rather than restating their contents, and by preferring a
  test that fails on drift over a sentence that quietly stops being true —
  the repository already does this twice, for the display-mode table and the
  media extension lists.
- **The consolidation could destroy the record.** `HANDOFF.md` is a genuine
  historical document. Reorganising it must not quietly drop the landmines and
  dead ends that cost real time to discover.
