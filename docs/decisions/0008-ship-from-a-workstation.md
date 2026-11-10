# 0008 — Ship from a workstation, because the host drops the runners

Status: accepted, 2026-11-10.

**This does not supersede [0007](0007-serve-it-through-cgi.md), and it changes
nothing about how the application runs.** CGI behind the Apache front
controller, `app.cgi` and its shell wrapper, the hand-made virtualenv at
`$DEPLOY_PATH/.venv`, the document-root contract, the file-based sweep throttle,
the 3.12 floor, the `.htaccess` merge that keeps the shared password — all of
0007 stands, untouched and still the mechanism. What moved is **the trigger and
the machine**: a push to `main` no longer ships, and the ten remote operations
0007's deploy performs now run from `deploy/deploy.sh` on the author's own Mac
instead of from a GitHub-hosted runner. The ordering properties 0007 argued for
are the same ordering properties, in the same order, with the same modes and
excludes; they are simply enforced by a script and its tests rather than by a
workflow file.

The runbook for it is `docs/DEPLOY.md`, steps 5b and 6.

## Problem

`.github/workflows/deploy.yml` was written, reviewed and never able to run.
Reclaim's firewall **permits the author's own address and drops GitHub's
hosted-runner addresses at the TCP level**: the connection is not refused and
not authenticated, it is dropped, so nothing in the pipeline can diagnose it
beyond a timeout.

The two observations that pin it, which are worth recording because neither is
reproducible from this repository:

- The same key, the same user and the same `DEPLOY_HOST` succeed from the
  author's Mac.
  `ssh -i ~/.ssh/clio_deploy -o IdentitiesOnly=yes USER@area51.reclaimhosting.com 'hostname -f; pwd'`
  lands in `/home/USER`.
- The workflow's *Check the host is reachable* step — added to tell a DNS
  mistake apart from a network one — reports
  `Cannot open TCP 22 to DEPLOY_HOST from this runner`, after resolving the
  host correctly.

So the failure is neither a secret nor a host key nor a port. `DEPLOY_HOST` is
the **server**, `area51.reclaimhosting.com` → `143.110.219.49`; the author's own
domain is Cloudflare-proxied and times out on 22, which is a different mistake
the runbook already covers (step 5's `DEPLOY_HOST` row). Both addresses were
checked. What is left is the firewall, and a shared host's firewall is not ours
to change.

The decision is therefore not "how do we fix the pipeline" but "what ships the
code, given that the one machine which can reach the host is a laptop."

## Decision

### 1. The ship half moves to `deploy/deploy.sh`, run by hand

A single bash script, run from the repository root, reading its configuration
from a gitignored `deploy/deploy.env` instead of from repository secrets. It is
a **transcription** of the workflow's ship half rather than a reimplementation:
the same `mkdir -p`, the same six rsyncs in the same order with the same
excludes and the same `--chmod` flags, the same `merge-htaccess.sh` invocation
between the staged `.htaccess` and `app.cgi`, the same only-if-absent
`backend/.env` fed over stdin, the same `pip install` into the venv it refuses
to create. Lint, tests and build are not reimplemented at all: the script calls
`make check`, so the Makefile's pinned Node 24 (the ambient one is v25, which
Angular 22 rejects) applies exactly as it does by hand.

Two things in it are new, and both exist because the properties that the
workflow got from being a workflow had to be got some other way:

- **The refusals happen before the first remote command**, and more than one is
  reported at once. A refusal has therefore never done anything, which is what
  the *Check configuration* step bought in the pipeline.
- **`deploy/deploy.env`'s mode is checked.** The file holds
  `MAPILLARY_TOKEN`; a group- or world-readable config file is refused, and a
  `stat` that answers in neither BSD nor GNU spelling is also refused, because
  unknown is not the same as fine. GitHub Secrets had this property for free.

### 2. The gates move from the trigger into the script

The pipeline expressed "production deploys run from `main`" as a `push` trigger
on that branch, which is not an expressible thing in a script that anyone can
type. So `deploy/deploy.sh` refuses to run when `git rev-parse --abbrev-ref
HEAD` is not `main`, and refuses a working tree with uncommitted changes —
because `rsync` ships the **tree**, not the commit, and a deploy that cannot be
named in the history afterwards is one nobody can reason about. `--target DIR`
relaxes both, which is also the rehearsal path, and relaxing both is correct
there: rehearsing a branch, mid-change, against a directory nobody uses is what
a rehearsal is.

This is a real loss of strength and worth stating plainly: a trigger cannot be
skipped and a gate inside a script can be edited out by whoever is typing. What
replaces the trigger's authority is `backend/tests/test_deploy_script.py`, which
drives the real script with `ssh`, `rsync`, `make`, `uv` and `git` stubbed on
`PATH` and asserts the orderings, the modes, the absence of `--delete`, that the
token never reaches an argv, that `make check` precedes the first remote
command, that `--target` reaches **every** remote path, and that each refusal
logged no `ssh` and no `rsync` at all. Those are the properties a transcription
loses quietly, and they are now the thing a reviewer reads instead of a diff of
YAML.

### 3. The host key comes from `~/.ssh/known_hosts`, not from a pinned variable

The one substantive divergence from the pipeline. A fresh runner has no history
with the host, so `deploy.yml` writes the `DEPLOY_HOST_KEY` variable into a
throwaway `known_hosts` and pins it. A workstation does have that history:
`deploy/deploy.sh` sets `StrictHostKeyChecking=yes` and names **no**
`UserKnownHostsFile`, so the pin is the author's own `~/.ssh/known_hosts`
entry, put there by one interactive `ssh` whose fingerprint they checked.

That is the stronger pin, not a shortcut: the fingerprint was compared once, by
a person, against the host's own console, rather than copied out of a scan and
pasted into a settings page where nothing ever looks at it again. It fails
closed in both directions. No entry means `Host key verification failed` and a
deploy that ships nothing; a **changed** key means the same, which is wanted —
Reclaim rebuilding the server is the innocent explanation and someone answering
in its place is the other one. `docs/DEPLOY.md` step 5b says which message means
which, because at 11pm they look identical.

### 4. `deploy.yml` is kept intact, manual-only, and CI is split out of it

The workflow loses its `push` trigger and nothing else. Not a step, not a
comment, not the *Check the host is reachable* step that diagnosed this in the
first place. It is the only executable record of what the ship sequence is, it
is where the sequence will go back to living if the firewall opens, and a
half-deleted workflow would be worth neither.

But a workflow that no longer runs on a push takes the build and the tests with
it, and `main` going permanently un-gated is not an acceptable price for a
firewall rule. So `.github/workflows/ci.yml` carries the build-and-test half:
`on: [push, pull_request]`, Node 24, `npm ci`, `ng build`, `ng test`, Python
3.12, `uv sync`, `ruff`, `pytest`. It **references no secret and no repository
variable anywhere**, which is what makes its `pull_request` trigger safe, and
is the reason the split is tidier than the thing it replaces: `deploy.yml` holds
the SSH key and runs only by hand, `ci.yml` holds nothing and runs on
everything.

One thing was caught by splitting, and is the reason to mention the split in a
record at all: `backend/tests/test_versions.py` read `deploy.yml` by name and
asserted its one `python-version:` pin matched the floor. After the split that
is the manual-only workflow, while `ci.yml`'s pin — the one gating every push —
was unguarded and free to drift from `>=3.12` and from the host's 3.12.15. The
test still passed. The guard had stopped covering the thing it was written to
cover, silently, which is the characteristic failure of a check that names a
file. It now iterates `.github/workflows/` instead, so a third workflow is
covered without anyone remembering.

### 5. The alternatives, and why each lost

**Allowlisting GitHub's runner ranges on the host.** The ranges are published,
at `api.github.com/meta`, and that is where the idea dies rather than where it
starts: it is thousands of Azure CIDRs which rotate, GitHub documents that it
is not to be used as a firewall allowlist, and no shared host is going to take
a list that needs re-pasting whenever Azure moves. The supported way to get a
stable egress address is a **larger runner** with static IP ranges, which
requires **GitHub Enterprise Cloud**. For a six-historian PhD project that is
not a trade-off, it is a different budget.

**A self-hosted runner on the author's Mac.** This genuinely works — the
firewall would see the home address, which is the address it permits — and it
would keep the deploy automatic on merge. It loses on two counts, neither of
them technical. It puts a long-running agent with repository access on a
personal laptop, which is a standing obligation to keep patched and a new thing
that can be compromised; and it needs the Mac awake and online at merge time,
so the automation it buys is automation that silently does not happen whenever
the laptop is shut. A script the author runs on purpose is the same work with
none of that: if the machine has to be there anyway, it may as well be a person
there with it.

**cPanel Git Version Control, with the host pulling.** The host has no Node 24
— no Node at all worth building with — so the Angular bundle could not be built
there, which means committing the built bundle to the repository. That is a
large generated artefact in every diff, a merge conflict per branch, and the
end of "the build is reproducible from source" as anything a reviewer can
check. Rejected for the same reason the previous branch rejected it.

## What is given up

- **A deploy is no longer automatic on merge.** Merging to `main` runs the
  tests and ships nothing; someone has to type `deploy/deploy.sh`. The runbook's
  step 10 says so, and this is the thing most likely to surprise the author in
  three months.
- **The deploy now needs the author's machine**, with its key, its
  `known_hosts` entry and its `deploy/deploy.env`. There is no path that ships
  from anywhere else, and that is a single point of failure named rather than
  hidden.
- **The `main`-only and clean-tree gates are advisory where they used to be
  structural** (decision 2).
- **A rotated `MAPILLARY_TOKEN` in `deploy/deploy.env` still does not reach the
  host**, unchanged from the pipeline: `backend/.env` is host-owned state and
  is written only when absent.

## The thing that would reverse this

**Ask Reclaim to allowlist a few addresses.** It is a support request, not a
project, and it is worth sending: if they permit even a small set of addresses
for port 22, `deploy.yml` is sitting there intact and the pipeline resumes with
a single edit to its `on:` block. Nothing in this record is built to be
permanent, and nothing here is blocked on the answer — the script ships today
either way, which is why the request is a line in the runbook rather than a
dependency.

## What is not known

- **`deploy/deploy.sh` has never run against the host** (`UNVERIFIED.md` entry
  41). Its tests prove the orderings and the refusals against stubs; rsync's
  real behaviour, the host's `pip`, Apache's reading of the modes and the merge
  against a real `.htaccess` are all out of a stub's reach. The first real run
  is `docs/DEPLOY.md` step 6's rehearsal against staging.
- **Whether the firewall rule is what we think it is.** "Permits the author's
  address, drops GitHub's" is an inference from two observations, both of which
  are recorded above. A rule keyed on something else — a rate limit, a
  geo-block, a reputation list — would look identical from here, and only
  Reclaim can say.
- **Everything 0007 left open stays open**, and this record closes none of it:
  the front controller has still never been read by Apache, the CGI path has
  still never run on the host, and the `.htaccess` merge has still never met a
  real Directory Privacy password. Moving which machine runs `rsync` does not
  touch any of that.
