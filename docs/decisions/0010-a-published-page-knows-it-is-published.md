# 0010 — A published page knows it is published

Status: accepted, 2026-11-17, and revised the same day before it was merged,
which is why this record is rewritten rather than superseded. The decision was
reached in three steps after the 2 s probe, on the same day, each correcting the last; they are told in order below, because the
earlier ones are the reasons for the later ones.

Reverses one decision recorded in `docs/ARCHITECTURE.md`, "Routing: who is
asking": that a published site and the authoring host are one byte-identical
bundle, told apart at runtime by probing `/api/session` once. Everything
else there stands, and the viewer's relationship to `/api` is unchanged
(below). Rests on [0007](0007-serve-it-through-cgi.md), which put the
authoring app on a shared host. The plan is
`docs/superpowers/plans/2026-11-17-publish-mark.md`; its revised Task 2 is the
design as built and the superseded one is kept there as history.

## Problem

`EntryPage` probed `GET /api/session` with a 2 s deadline, and treated a
probe that failed, answered something that was not a session summary, or did
not answer in time as "this is a published site, show the viewer". That was
reasoned for a static host that black-holes `/api`. It was never tried against
the host the author actually deploys to, and that host turned out to be the
case the deadline could not survive.

The deployed authoring host (`area51.reclaimhosting.com`: cPanel and
CloudLinux; the chain is Cloudflare, then Reclaim's own Caddy, then Apache,
then CGI) answered `/api/session` in **12.6 to 14.0 s, and once 73.2 s, to
first byte** (measured). It is not the app and it is not CGI. A cold CGI
request of this application takes 0.20 to 0.32 s locally, of which `import
app.main` is 0.18 s. TLS to the host completes in 0.06 s. A 15 kB favicon
takes 12.2 s on a Cloudflare cache *miss*, which has to go to the origin, and
0.33 s on a *hit*. The latency is in the path to the origin, and a request
that reaches the origin pays it whatever the origin does.

So the 2 s probe always lost. `EntryPage` fell through to "reveal the viewer"
for the author on their own host, who should have reached the editor or the
welcome screen. The design had assumed the probe's answer was cheap on the
authoring host and that only a *static* host could be slow. What was actually
measured was the authoring host being slow. Nothing was measured on a published
site's host, and nothing about its speed is claimed here.

## Decision, in three steps

**1. A published page is told that it is published, at publish time, and does
not infer it.** The proposal was the author's, made when the measurements came
back: a page that is known to be published should say so, not discover it by
timing a request. This part survived every later change.

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
  `expectNone`.

**2. First, the unmarked page got a long deadline (built, then withdrawn).**
The unmarked page kept probing, now with `AUTHORING_HOST_FALLBACK_MS`, 30 s in
place of 2 s, after which it revealed the viewer. That was built and written up
on the reasoning that 30 s is comfortably longer than 14. It is not longer than
73.2: the slowest answer ever measured was more than twice the deadline, so
the fallback still sent an author to the viewer now and then, and in the
meantime showed a blank page for up to 30 s. A deadline on the authoring host
cannot be made right, because the thing being waited for has no known upper
bound, and a wrong fallback is worse than none: the viewer there loads
`tour-data/` from the same slow backend and helps nobody.

**3. So the unmarked page awaits, with no deadline, and reads the answer
three ways.** The author's ruling: an unmarked page is the authoring host by
contract; just await. `SessionApi.get()` takes no timeout, and `EntryPage`
decides on what comes back:

- **Status 0, a 404, or a 200 that is not a session summary** reveals the
  viewer at once. These are what a static host does: refuse, answer 404 for an
  unknown path (no SPA rewrite), or answer `index.html` for every path.
- **A session summary** goes to `/edit` or the welcome screen.
- **Every other 4xx and every 5xx** is `'broken'`: a message carrying the
  status ("The tour service answered with an error (524). Reload to try
  again."), the viewer not shown, nothing navigating, no retry.

After `WAITING_NOTICE_MS` (5 s) with no answer a line, "Waiting for the tour
service…", appears. It is information and decides nothing, and its timer is
cleared on an answer and on destroy.

Why 404 is the only 4xx counted as static: the backend never returns a 4xx on
`GET /api/session` (by reading `main.py`; no test pins it, and `UNVERIFIED.md`
entry 45 item 6 carries the label). On the authoring host, then, a 403, 408 or 429 can only be
the CDN or proxy in front of a *live* backend blocking or throttling it, which
is "failing, not absent", like a 524 (Cloudflare's answer when the origin
outlives its 100 s limit). Revealing the viewer there would hide a failing
backend behind a tour that cannot load. The consequence is that an unmarked
bundle on S3, which answers 403 for a missing key, shows "broken (403)": that
is out of contract, visible, and accepted. This narrowing is the last commit
in the sequence; the first version of step 3 treated every 4xx as static.

## The viewer still never calls `/api`

Unchanged, and still tested. The viewer reads `tour-data/` only. The marked
path is the published visitor's, and it makes no `/api` request at all, so a
published site no longer makes "exactly one request that fails by design"
either. `EntryPage` remains code the public downloads and runs, and stays
small for that reason.

## The trade

A hand-copied, **unpublished** `dist/` (one that never went through
`publish.py`, so it is unmarked) on a static host that **black-holes** `/api`
rather than refusing it will never show the tour. It shows the waiting line
indefinitely. On a host that refuses the request, or answers 404, it shows the
tour at once. A hand-copied `dist/` is not the supported way to publish, and the
author judged it better that this one case fail visibly than that the
authoring host be mistaken for it. Nobody has watched that happen; it is
reasoned, and it is `UNVERIFIED.md` entry 45.

A second residual: status 0 is read as "no backend", so on the authoring host a
proxy that *drops* a long-held connection without answering would reveal the
viewer to an author. Cloudflare answers 524 instead of dropping, which is
why this is probably rare behind Reclaim's chain. It is unchecked.

A third consequence, found on the way, and unrelated to routing. `publish.py`
used to copy each file with `zf.write`, which carries the source's mode into
the zip. The session directory is private (0600) by design, so every
`tour-data/*` in every published site had been 0600. That is right for a
private working copy and wrong for a public site: a zip goes to whatever host
the author puts it on, and what that host's web server runs as, and so whether
a 0600 file would have been served, was never checked. (An earlier version of
this record said it was harmless because cPanel runs Apache as the account
user. Nobody measured that, and it is an inference, not a finding.) Task 1's
first rewrite (`writestr` for `index.html`) would have dropped `index.html` to
0600 as well. Every entry is now written through one helper, `_add`, at
**0644**, with its mtime taken from the source. Checked on a real build after a
real `unzip`: 31 entries, all 0644, `index.html` marked once and otherwise
byte-identical.

## What this does not settle

That a marked `index.html` reveals instantly with no `/api` request on a real
static host, that the unmarked path behaves as reasoned on a refusing, a
404-ing and a black-holing host, that a long-held connection through
Reclaim's chain ends in 524 and not in a drop, and that the zip's permissions
survive a real extraction on the target are all `UNVERIFIED.md` entry 45. It
supersedes entries 20 to 22 on the 2 s deadline.
