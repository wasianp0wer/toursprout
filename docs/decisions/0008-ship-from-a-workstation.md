# 0008 — Ship from a workstation, because one deploy in nine is not a deploy

Status: accepted, 2026-11-10.

**This does not supersede [0007](0007-serve-it-through-cgi.md), and it changes
nothing about how the application runs.** CGI behind the Apache front
controller, `app.cgi` and its shell wrapper, the hand-made virtualenv at
`$DEPLOY_PATH/.venv`, the document-root contract, the file-based sweep throttle,
the 3.12 floor, the `.htaccess` merge that keeps the shared password — all of
0007 stands, untouched and still the mechanism. What moved is **the trigger and
the machine**: a push to `main` no longer ships, and the ten remote operations
0007's deploy performs now run from `deploy/deploy.sh` on the author's own Mac
instead of from a GitHub-hosted runner — eleven, counting the one the script has
to add for the modes (decision 1). The ordering properties 0007 argued for are
the same ordering properties, in the same order, with the same modes and
excludes; they are simply enforced by a script and its tests rather than by a
workflow file.

The runbook for it is `docs/DEPLOY.md`, steps 5b and 6.

## Problem

`.github/workflows/deploy.yml` was written, reviewed, and **reaches the host
about one time in nine.**

Nine runs have got as far as the network. Eight timed out at TCP 22; one
shipped.

| # | When (UTC) | Result |
| --- | --- | --- |
| 1 | 2026-11-09 21:44 | `ssh: connect to host *** port 22: Connection timed out` |
| 2 | 2026-11-09 22:02 | the same |
| 3 | **2026-11-09 22:15** | **TCP 22 open — a full production deploy, every step succeeded** |
| 4 | 2026-11-10 05:43 | timed out |
| 5 | 2026-11-10 13:36 | timed out |
| 6 | 2026-11-10 16:29 | timed out |
| 7 | 2026-11-10 16:33 | timed out |
| 8 | 2026-11-10 16:46 | timed out |
| 9 | 2026-11-10 17:07 | timed out, with the runner's own egress address logged at last: `20.55.86.178` |

**The success was the third attempt, not the first**, and that ordering carries
more weight than the ratio does. The natural reading of one success followed by
six failures is that the successful deploy changed something on the host —
tripped a protection, exhausted something, taught a firewall an address it then
stopped trusting. Runs 1 and 2 rule that out: the same timeout, with the same
signature, was already happening before anything had ever shipped. Whatever the
cause is, it predates the deploy that worked.

**Nine samples give no power to detect a change in the rate, and this record
does not claim one.** Nov 9 was 1 of 3 and Nov 10 is 0 of 6, which is nowhere
near significant — and the same arithmetic forbids the opposite claim, so the
odds are not known to be stable either. "About one in nine" is the whole
record's figure, not a property of the host.

What run 9 added is the runner's own address, which nothing had been recording:
`20.55.86.178`, Microsoft Azure, inside GitHub's published Actions range
`20.55.0.0/17`. So the runner was where GitHub says its runners are, and none
of the eight timeouts is a DNS mistake, a wrong port, a wrong key or a wrong
secret — run 3 authenticated and shipped with the same ones.

Two consequences, because both are tempting and neither works:

- **An allowlist is not a practical ask of a shared host.** GitHub publishes
  **8,350** Actions ranges at `api.github.com/meta`, and documents that the
  list is not to be used as a firewall allowlist. The number is the argument;
  no adjective improves on it.
- **Retrying inside a job cannot help.** A runner's egress address is fixed for
  the job's lifetime, so a retry loop around the `ssh` step retries the same
  address against the same condition. Only a fresh run draws a new address,
  which is a re-run button rather than a retry.

### What we believed at first, and what measurement showed

This record first said that Reclaim's firewall permits the author's own address
and drops GitHub's hosted-runner addresses at the TCP level. That was a
reasonable inference from the two observations available at the time, and both
observations still stand:

- The same key, the same user and the same `DEPLOY_HOST` succeed from the
  author's Mac.
  `ssh -i ~/.ssh/clio_deploy -o IdentitiesOnly=yes USER@area51.reclaimhosting.com 'hostname -f; pwd'`
  lands in `/home/USER`.
- The workflow's *Check the host is reachable* step — added to tell a DNS
  mistake apart from a network one — reported
  `Cannot open TCP 22 to DEPLOY_HOST from this runner`, after resolving the
  host correctly.

**The inference was too strong, and run 3 is what broke it.** A rule that drops
those addresses cannot also let a hosted runner open TCP 22 and complete a
production deploy. What has been measured is a failure *rate* with an unknown
cause, not a rule: a TCP-level timeout looks identical whether it comes from a
firewall, a rate limit, a reputation list, a shared host's connection cap or a
bad route, and only Reclaim can see which. `DEPLOY_HOST` is the **server**,
`area51.reclaimhosting.com` → `143.110.219.49`; the author's own domain is
Cloudflare-proxied and times out on 22, which is a different mistake the
runbook already covers (step 5's `DEPLOY_HOST` row). Both addresses were
checked.

The decision is therefore not "how do we fix the pipeline", and no longer "what
ships the code, given that nothing in CI can reach the host" — CI
demonstrably can, sometimes. It is "what should shipping feel like, when the
automatic path works one time in nine."

## Decision

Decided 2026-11-10, and the reason is the author's own: **CI reaches the host
roughly one time in nine, and for a solo-developer project a deterministic
manual deploy is worth more than a lottery.** A deploy-on-push that half-works
is worse than no deploy-on-push at all. After every merge you would have to go
and find out whether the code shipped; and once you are checking by hand, you
may as well ship by hand and read the result. One person, one machine, one
command, one answer on the screen.

Reachability is the measurement. Determinism is the reason, and the two are
worth keeping apart: a host that answered every time would not by itself
reverse this decision (see *The thing that would reverse this*), and a host
that answered half the time would make it stronger rather than weaker.

### 1. The ship half moves to `deploy/deploy.sh`, run by hand

A single bash script, run from the repository root, reading its configuration
from a gitignored `deploy/deploy.env` instead of from repository secrets. It is
a **transcription** of the workflow's ship half rather than a reimplementation:
the same `mkdir -p`, the same six rsyncs in the same order with the same
excludes, the same `merge-htaccess.sh` invocation between the staged
`.htaccess` and `app.cgi`, the same only-if-absent `backend/.env` fed over
stdin, the same `pip install` into the venv it refuses to create. Lint, tests
and build are not reimplemented at all: the script calls `make check`, so the
Makefile's pinned Node 24 (the ambient one is v25, which Angular 22 rejects)
applies exactly as it does by hand.

**One thing a transcription could not carry, and it took a review to notice:
the `--chmod` flags.** The workflow's `--chmod=F644`/`F755` worked because it
ran on ubuntu-24.04's GNU rsync; `/usr/bin/rsync` on macOS is Apple's openrsync
and rejects a literal mode outright — `rsync: --chmod=F644: invalid argument`,
exit 1, nothing transferred — and there is no spelling of it that works, since
openrsync takes only relative forms and documents `--chmod` as needing
`--perms`, which `-rlt` does not pass. Copied across unchanged, the flag made
every deploy die at the first rsync. The *modes* are therefore the same 755 and
644 and are still part of the contract; what sets them moved to the host. The
script `chmod 755`s `app.cgi` in its own `ssh` the moment it arrives — not only
in the install step at the end, because between those two points sit
`backend/`, the bundle, `content/`, the `.env` write and a `pip install`, which
on a first deploy is minutes of 500 on every URL — and `.htaccess` needs
nothing of its own, because `merge-htaccess.sh` chmods 644 before its atomic
`mv`. That is the eleventh remote operation.

Two things in it were new from the start, and both exist because the properties
that the workflow got from being a workflow had to be got some other way. (A
third, the one-deploy-at-a-time lock, belongs in *What is given up* below
rather than here, because it was not got some other way until a review noticed
it had gone.)

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
comment, not the *Check the host is reachable* step that measured this in the
first place — and which, on run 3, is the step that said `TCP 22 open`. It is
the only executable record of what the ship sequence is, it is where the
sequence would go back to living if this project ever wants an automatic deploy
again, and a half-deleted workflow would be worth neither. It is also still
usable: a `workflow_dispatch` run is worth a try whenever you want one, and
costs a timeout when it is not your day.

But a workflow that no longer runs on a push takes the build and the tests with
it, and `main` going permanently un-gated is not an acceptable price for
shipping by hand. So `.github/workflows/ci.yml` carries the build-and-test half:
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
starts: **8,350 of them**, Azure CIDRs which rotate, and GitHub documents that
the list is not to be used as a firewall allowlist. No shared host is going to
take a list of 8,350 ranges that needs re-pasting whenever Azure moves, and
asking for a few addresses instead asks for the wrong thing — the address a run
draws is not ours to choose, as run 9's `20.55.86.178` shows. The supported way
to get a stable egress address is a **larger runner** with static IP ranges,
which requires **GitHub Enterprise Cloud**. For a six-historian PhD project
that is not a trade-off, it is a different budget.

**A retry loop around the `ssh` step, to play the one-in-nine odds inside one
run.** It cannot work, and the reason is worth knowing before anyone writes it:
a runner's egress address is fixed for the job's lifetime, so every retry
leaves from the same address into the same condition. A loop would turn a
two-minute failure into a twenty-minute one and ship nothing. Re-running the
workflow is the only thing that draws a new address, and that is a button, not
a loop.

**Keeping the `push` trigger and living with the failures.** This is the
alternative the decision above is actually chosen against, and it is not
absurd: one merge in nine would ship for free. It loses on the thing the
decision names — after a merge you would not know whether the code was live
without going to look, and a red deploy on every second or third push is a
signal that teaches you to ignore signals. One deploy you typed beats nine
notifications you have learned to dismiss.

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
- **`deploy.yml`'s `concurrency: {group: deploy, cancel-in-progress: false}`
  went with the trigger**, and this record did not notice it until a review of
  the branch did. The workflow got one-deploy-at-a-time from GitHub for free,
  with the comment "two rsyncs into the same tree must not interleave" beside
  it; a script has no such thing, and is far easier to run twice than a
  workflow was — two terminals, or a second go because the first looked stuck
  during `make check`. It is the clearest example of what decision 1 calls a
  transcription losing a property quietly: nothing in the script was wrong, the
  property was simply not there any more. `deploy/deploy.sh` now takes a
  `.deploy.lock` directory (`mkdir` is atomic everywhere; macOS has no
  `flock(1)`) after the refusals and before `make check`, releasing it on exit,
  and refuses with a message that says to `rmdir` it if nothing is running. The
  guarantee is back, but it is now a thing in this repository that has to keep
  working rather than a line of YAML that could not fail — and, unlike the
  workflow's, it has never met a second deploy (`UNVERIFIED.md` entry 41).
- **A rotated `MAPILLARY_TOKEN` in `deploy/deploy.env` still does not reach the
  host**, unchanged from the pipeline: `backend/.env` is host-owned state and
  is written only when absent.

## The thing that would reverse this

**Not a firewall change, because the firewall story is not the reason any
more.** Even a host that answered every time would leave the question the
decision actually turns on: would a failed deploy be impossible to miss, and is
there anyone but the author to miss it? So two things together would reverse
this, and either alone would not:

1. **A path from CI that is reliable enough to trust without checking** — which
   means knowing why eight runs in nine time out, and having that fixed by
   whoever can see it, not inferred from here.
2. **More than one person shipping**, at which point "someone types the
   command" stops being a plan and the cost of an unnoticed non-deploy goes up.

`deploy.yml` is kept intact for exactly that day: the pipeline resumes with a
single edit to its `on:` block, and nothing in this record is built to be
permanent. Asking Reclaim what the timeouts are is still worth doing — it is a
support request, not a project — but it is a line in the runbook rather than a
dependency, and the answer would inform point 1 rather than settle it.

## What is not known

- **A *production* run of `deploy/deploy.sh`** (`UNVERIFIED.md` entry 41). The
  script has run against the real host once, as `docs/DEPLOY.md` step 6's
  rehearsal on 2026-11-10: all eleven remote operations completed, the
  `.htaccess` merge ran on the host, the only-when-absent `backend/.env` logic
  ran, the host-side `chmod`s set the modes, and `rsync` with no `--chmod`
  transferred correctly from macOS. But that target was a staging **directory
  with no subdomain**, so nothing the script wrote was ever served by Apache,
  and the run that ships to the historians has not happened yet.
- **Whether the `.deploy.lock` directory keeps two real deploys apart.** The
  suite takes and releases it against a temp directory; a second
  `deploy/deploy.sh` arriving while the first is mid-`rsync` has never
  happened.
- **Why eight runs in nine time out.** The earlier answer — a firewall keyed on
  the address — is ruled out by run 3 and is not replaced by another: a rate
  limit, a connection cap, a reputation list or a bad route would all look
  identical from here, and only Reclaim can see which. Nor is the *rate* known
  to be anything but the ratio of nine runs; see *Problem*.
- **What 0007 left open is now partly closed, and the rest of it is still
  open.** The 2026-11-09 production deploy, plus the author's confirmation that
  the live site serves and works, closed the big ones: Apache executes
  `app.cgi`, the front controller's rules fire, cPanel accepted a document root
  outside `public_html`, the host's pip 23.2.1 installed the exported
  `requirements.txt`, and `merge-htaccess.sh` composed an `.htaccess` Apache
  reads. What is still open is the merge meeting a **real Directory Privacy
  password**, `index.html`'s missing `no-cache` header on the host
  (`UNVERIFIED.md` entry 40), and CGI under the load of several historians at
  once. Moving which machine runs `rsync` touched none of that either way.
