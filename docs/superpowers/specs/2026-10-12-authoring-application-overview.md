# From prototype to authoring application: the brief

Umbrella design for turning the Old Town Fairfax walking-tour prototype into a
tool that authors tours. Agreed in conversation on 2026-10-12. Each sub-project
below has its own spec, plan and implementation cycle; this document is the
shared intent they are all checked against.

## What we are building

A single-author, locally-run authoring tool for virtual historical walking
tours. You open or create a tour, place content against a top-down map and real
street-level panoramas simultaneously, record or upload media, and publish a
static site anyone can visit without a server running.

A tour is one portable `.zip` bundle. The save format and the sharing format
are the same thing: there is no separate export step to forget.

Three ideas carry the design:

1. **Content, place and presentation are independent.** The same photograph can
   hang ghosted in the scene or sit on the street as a pin you click, without
   becoming a different kind of object.
2. **Audio is placed content, not a per-stop slot.** Several short clips
   anchored where they are about, instead of one long monologue.
3. **Everything carries provenance**, whether it came from the Library of
   Congress or from the author's own microphone.

The code is documented well enough that the author can return in six months and
both change it and understand why it is the way it is.

## Decisions taken, and what they rule out

| Decision | Consequence |
| --- | --- |
| Authoring is local; viewing is public | Editor and viewer are separately deployable. No accounts, no server-side authorisation, no concurrency. |
| Published form is a **static site, no backend** | The viewer must run with no API. `tour-api.ts` gains a file-backed implementation. The Mapillary token is a public client token, so nothing is lost by shipping it. |
| The bundle is **one `.zip`** | One file to email, archive or deposit. The published static site is a second output of the same serializer, not a second pipeline. |
| **Document model**, not a tour library | Open / save / save-as over bundles. The filesystem is the library. SQLite's `tours` table becomes vestigial and is removed. |
| The **editor owns the tour document** | `content/source/stops.json` retires. The Python content scripts are re-homed as tools the editor calls on demand. |
| Presentation is a separate `display` field | AR becomes a third display target rather than a parallel content hierarchy. |
| `Credit` becomes a union with tour-level defaults | Original work is attributable without inventing a URL. Omeka's Dublin Core maps onto the `sourced` variant. |

## Constraints

- **The existing tour must survive.** Six stops, working rephotography, derived
  bearings. Migration is part of the work, not a cleanup afterwards.
- **No browser can launch in this sandbox.** Playwright specs exist but cannot
  run here. The jsdom integration suites carry the verification weight, and
  anything visual needs the author's eyes outside the sandbox.
- **Derived, never guessed.** All six hand-authored stop bearings were wrong,
  one by 138 degrees. The editor must never let a typed bearing silently
  replace a derived one.
- **TDD throughout**, and the environment landmines in `docs/ENVIRONMENT.md`
  are permanent facts.

## The four sub-projects

Strict order. Sub-project 1 before 2 because the bundle serializes the v2
document and that serializer should not be written twice. 2 before 3 because
the editor needs somewhere to save before anything that saves is worth
building.

| # | Sub-project | Visible result |
| --- | --- | --- |
| 1 | **Schema v2** — split content / anchor / display, credit union, tour defaults, v1 migration | Nothing changes on screen; the existing tour renders identically from a v2 document |
| 2 | **Bundle and publish** — `.zip` read/write, working directory, open / save / save-as, static site export, viewer runs with no API | Old Town Fairfax round-trips through a bundle and the result hosts on a static server |
| 3 | **Editor** — dual-pane placement, numeric inspector, overlay CRUD, media upload, audio recording, content scripts re-homed as tools | A new tour is authored end to end |
| 4 | **Documentation** — architecture map, "where do I change X" index, decision records, in-code rationale | Continuous, with a consolidation pass closing each sub-project |

## Success

The author creates a **second** tour — one that is not Old Town Fairfax —
entirely through the editor, without hand-editing JSON or running
`make content`, and publishes it as a static site.

## Deferred, but designed around

Not built now. Each design decision is checked against them.

- **AR.** A third `display.mode`, reading the same anchors. This is why
  `altitudeM` is pinned to metres above local ground: a phone knows its height
  above the pavement, not above the ellipsoid.
- **Themes.** A tour-level style block the bundle carries and the published
  site reads.
- **Omeka.** An importer producing `sourced` credits from Dublin Core, probably
  with an Omeka-side extension.

## Documentation audience

The author, as a developer: architecture map, a "where do I change X" index
pointing at real files, decision records for the non-obvious calls, and
generous in-code explanation of *why*. Explicitly **not** an end-user manual
for the editor, and not contributor onboarding — the editor may assume an
expert user.
