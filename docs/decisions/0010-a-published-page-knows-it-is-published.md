# 0010 — A published page knows it is published

Status: accepted, 2026-11-17.

Reverses one decision recorded in `docs/ARCHITECTURE.md`, "Routing: who is
asking": that a published site and the authoring host are **one byte-identical
bundle**, told apart at runtime by probing `/api/session` once. Everything
else there stands, and the viewer's relationship to `/api` is unchanged
(below). Rests on [0007](0007-serve-it-through-cgi.md), which put the
authoring app on a shared host. The plan is
`docs/superpowers/plans/2026-11-17-publish-mark.md`.

## Problem

`EntryPage` probed `GET /api/session` with a 2 s deadline, and treated a
probe that failed, answered something that was not a session summary, or did
not answer in time as "this is a published site, show the viewer". That was
reasoned for a static host that black-holes `/api`. It was never tried against
the host the author actually deploys to, and that host turned out to be the
case the deadline could not survive.

The deployed authoring host (`area51.reclaimhosting.com`: cPanel and
CloudLinux, behind Cloudflare and Reclaim's own proxy) answers
`/api/session` in **12 to 73 seconds, measured**. It is not the app and it is
not CGI. A cold CGI request of this application takes about 0.2 s locally,
0.18 s of that being `import app.main`. TLS to the host completes in 0.06 s.
A 15 kB favicon takes 12.2 s on a Cloudflare cache *miss*, which has to go to
the origin, and 0.33 s on a *hit*. The latency is in the path to the origin,
and a request that reaches the origin pays it whatever the origin does.

So the 2 s probe always lost. `EntryPage` fell through to "reveal the viewer"
for the author on their own host, who should have reached the editor or the
welcome screen. The design had assumed the probe's answer was cheap on the
authoring host and that only the *published* host could be slow. The measured
fact is the reverse.

## Decision

**A published page is told that it is published, at publish time, and does
not infer it.** The reversal was the author's own proposal, made when the
measurements came back: a page that is known to be published should say so,
not discover it by timing a request.

The contract has three parts.

- `publish.py` `mark_published(html)` adds the valueless attribute
  `data-published` to the first `<html` tag of the zip's `index.html`, and to
  nothing else. It is a no-op if the mark is already there or there is no
  `<html` tag.
- The on-disk `dist/index.html`, which the authoring host serves, is **never
  marked**. Only the copy written into the zip is. This is what keeps the
  two audiences separable at all, and `build_site` marking the zip entry
  rather than the build output is the whole of it.
- `isPublishedPage(doc)` in `entry/entry-page.ts` is the presence of
  `data-published` on `<html>`. A marked page reveals the viewer at once and
  makes **zero** `/api` requests; `entry-page.spec.ts` pins that with
  `expectNone`. An unmarked page probes as before.

The probe's deadline is now `AUTHORING_HOST_FALLBACK_MS` (30 s), which
replaces `SESSION_PROBE_TIMEOUT_MS` (2 s). A refused connection or a 200 of
HTML on an unmarked page still reveals the viewer immediately; only the
*deadline* got long. That is the point: the common unmarked case is the
authoring host, which must be allowed to be slow.

## The viewer still never calls `/api`

Unchanged, and still tested. The viewer reads `tour-data/` only. The marked
path is the published visitor's, and it makes no `/api` request at all, so a
published site no longer makes "exactly one request that fails by design"
either. `EntryPage` remains code the public downloads and runs, and stays
small for that reason.

## The trade

The 30 s fallback exists for one case only: an **unpublished** bundle, one
that never went through `publish.py`, hand-copied onto a host with no backend
that black-holes `/api` instead of refusing it. That visitor now waits up to
30 s on a blank page instead of 2 s. A hand-copied `dist/` is not the
supported way to publish, and the author judged it better that it degrade
slowly than that the authoring host be mistaken for it. Nobody has watched
that happen; it is reasoned, and it is `UNVERIFIED.md` entry 45.

A second, smaller consequence, found on the way. `publish.py` used to copy
each file with `zf.write`, which carries the source's mode into the zip.
The session directory is private (0600) by design, so every `tour-data/*` in
every published site had been 0600. That is right for a private working copy
and wrong for a public site. It was harmless only because cPanel runs Apache
as the account user. Task 1's first rewrite (`writestr` for `index.html`)
would have dropped `index.html` to 0600 as well. Every entry is now written
through one helper, `_add`, at **0644**, with its mtime taken from the
source. Checked on a real build after a real `unzip`: 31 entries, all 0644.

## What this does not settle

That an unpublished hand-copy degrades acceptably, that a marked
`index.html` reveals instantly with no `/api` request on a real static host,
and that the zip's permissions survive a real extraction on the target are
all `UNVERIFIED.md` entry 45. It supersedes entries 20 to 22 on the 2 s
deadline.
