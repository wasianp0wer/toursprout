# Ship From a Workstation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the *shipping* half of the deploy off GitHub Actions and onto the author's own machine, because Reclaim's firewall drops GitHub's runner addresses, while keeping every gate and every ordering property the CI pipeline already had.

**Architecture:** `.github/workflows/deploy.yml` keeps all of its logic but loses its `push` trigger, so it is manual-only and ready for the day the firewall opens. A new `deploy/deploy.sh` reproduces its ship half — the same rsync order, the same excludes, the same modes, the same `.htaccess` merge, the same stdin-fed `.env`, the same remote install — reading its configuration from a gitignored `deploy/deploy.env` instead of GitHub secrets, and delegating lint/test/build to the existing `make check` so the Makefile's pinned Node still applies. A new `.github/workflows/ci.yml` keeps build-and-test running on every push, so `main` is not permanently red.

**Tech Stack:** bash, rsync, ssh, GNU make, GitHub Actions; tests in pytest driving the real script with PATH stubs for `ssh`, `rsync`, `make`, `uv` and `git`.

**Spec:** no separate spec. The thing being reproduced is `.github/workflows/deploy.yml` at `9577775`, and the runbook it belongs to is `docs/DEPLOY.md`. The reason for the move is in the commit that follows this plan and in ADR 0008 (Task 3).

## Global Constraints

- **Never `--delete`.** No rsync in this script may carry `--delete`, `--delete-excluded` or `--remove-source-files`. A deploy that destroys a historian's in-progress tour is a failure condition; sessions live outside the deploy tree (`~/.clio-wired/sessions`) and *also* nothing is ever deleted.
- **The front controller goes first.** `.htaccess` is staged and merged before `app.cgi`, before `backend/`, before `content/`, and before the `.env` write. Until it is in place the document root is uncontained, and writing `backend/.env` first would publish `MAPILLARY_TOKEN` by URL.
- **`MAPILLARY_TOKEN` travels over stdin**, never in an argv, so it is not in a process listing or a shell history.
- **`backend/.env` is written only when absent.** It is host-owned state.
- **Modes are explicit:** `--chmod=F644` for `.htaccess`, `--chmod=F755` for `app.cgi` and `deploy/merge-htaccess.sh`; `rsync -rlt` carries none, and a wrong mode on either file Apache reads is 500 on every URL.
- **`uv export --no-dev --no-hashes --no-emit-project`**, unchanged: `uvicorn[standard]` must stay off the host.
- **Production runs from `main` with a clean tree.** `--target DIR` is the rehearsal path and relaxes both.
- **The config file holds a token**, so the script refuses one that is group- or world-readable.
- **Python 3.12** stays the floor; nothing here changes `backend/pyproject.toml`.

## Review Focus

Five things the pipeline-to-script translation can get wrong that no happy-path test would catch:

1. **A config value containing whitespace** silently mangles rsync's `-e "ssh …"` string, so the deploy either fails obscurely or connects somewhere unintended. Pinned in Task 1, Step 13.
2. **A remote command failing mid-sequence and the script carrying on**, which on the `.htaccess` merge means continuing to ship with the document root uncontained. Pinned in Task 1, Step 15.
3. **`--target` not reaching every remote path**, leaving a "rehearsal" that writes into production. Pinned in Task 1, Step 11.
4. **Checks running after the first remote write**, which would ship untested code and only then notice. Pinned in Task 1, Step 9.
5. **A refusal that has already done something** — a missing variable or a loose config file detected after the first rsync. Every refusal test in Task 1 asserts that no `ssh` and no `rsync` ran.

---

### Task 1: `deploy/deploy.sh`

**Files:**
- Create: `deploy/deploy.sh` (mode 755)
- Create: `deploy/deploy.env.example`
- Create: `backend/tests/test_deploy_script.py`
- Modify: `.gitignore` (add `deploy/deploy.env`)

**Interfaces:**
- Consumes: `deploy/merge-htaccess.sh` (already shipped; invoked on the host as `bash <dir>/deploy/merge-htaccess.sh <dest> <new>`), and `make check` from the repository `Makefile`.
- Produces: `deploy/deploy.sh [--target DIR] [--config FILE]`, exit 0 on success and non-zero on any refusal or remote failure. Task 3 documents this signature; nothing else calls it.

**Design the implementer must not vary:**

Configuration, sourced from `--config` (default `deploy/deploy.env`, resolved against the repository root, which is `$(cd "$(dirname "$0")/.." && pwd)` — not `git rev-parse`, so the script's own paths do not depend on a stubbed or absent git):

| Variable | Required | Default |
| --- | --- | --- |
| `DEPLOY_HOST` | yes | — |
| `DEPLOY_USER` | yes | — |
| `DEPLOY_PATH` | yes | — |
| `MAPILLARY_TOKEN` | yes | — |
| `DEPLOY_PORT` | no | `22` |
| `SSH_KEY` | no | `$HOME/.ssh/clio_deploy` |

The ssh options, as an array, so there is one place they are written:

```sh
SSH_OPTS=(-p "$DEPLOY_PORT" -i "$SSH_KEY" -o IdentitiesOnly=yes
          -o StrictHostKeyChecking=yes -o BatchMode=yes
          -o ServerAliveInterval=30 -o ServerAliveCountMax=4)
```

`StrictHostKeyChecking=yes` and no `UserKnownHostsFile`: on a workstation the
host key is already in `~/.ssh/known_hosts`, verified interactively once, and
that is a better pin than re-pasting a blob. If the entry is absent this fails
closed, which is the wanted behaviour. `BatchMode=yes` because the key has no
passphrase.

rsync gets `-rlt --itemize-changes` and `--rsh` built from the same array;
`$RSH` is `ssh ${SSH_OPTS[*]}`, which is why Step 13 refuses whitespace.

The remote sequence, in this order and no other:

1. `ssh … "mkdir -p '<dir>/backend' '<dir>/content' '<dir>/deploy' '<dir>/frontend/dist/frontend/browser'"`
2. `rsync --chmod=F644 .htaccess <remote>:<dir>/.htaccess.new`
3. `rsync --chmod=F755 deploy/merge-htaccess.sh <remote>:<dir>/deploy/`
4. `ssh … "bash '<dir>/deploy/merge-htaccess.sh' '<dir>/.htaccess' '<dir>/.htaccess.new'"`
5. `rsync --chmod=F755 app.cgi <remote>:<dir>/`
6. `rsync --exclude .venv --exclude .env --exclude __pycache__ --exclude .pytest_cache --exclude .ruff_cache --exclude uv.lock backend/ <remote>:<dir>/backend/`
7. `rsync frontend/dist/frontend/browser/ <remote>:<dir>/frontend/dist/frontend/browser/`
8. `rsync --exclude /work content/ <remote>:<dir>/content/`
9. `printf 'MAPILLARY_TOKEN=%s\n' "$MAPILLARY_TOKEN" | ssh … "umask 077 && if [ -e '<dir>/backend/.env' ]; then cat > /dev/null; echo …; else cat > '<dir>/backend/.env' && echo …; fi"`
10. `ssh … "bash -s"` with the install heredoc: refuse if `<dir>/.venv/bin/python` is not executable, else `pip install -r <dir>/backend/requirements.txt`, then `chmod 755 <dir>/app.cgi` and `chmod 644 <dir>/.htaccess`.

Steps 1–10 above are a transcription of `.github/workflows/deploy.yml`; take the
wording of the remote commands from that file rather than re-deriving them, and
keep its comments where they explain a choice the script is also making.

- [ ] **Step 1: Write the harness and the first failing test**

`backend/tests/test_deploy_script.py` gets a module docstring in the house
style (see `backend/tests/test_merge_htaccess.py`) saying why these tests
exist: they are the only thing that will run this script before the host does,
so they pin the orderings and the refusals, not the happy path.

Then a `run_deploy` fixture that:
- makes a temp dir with `bin/` containing executable stubs named `ssh`,
  `rsync`, `make`, `uv` and `git`. Each appends its own `$0` basename and all
  arguments, one line, to `$STUB_LOG`, then exits `${STUB_EXIT_<NAME>:-0}`.
  The `ssh` stub also drains stdin to `/dev/null`. The `git` stub answers
  `rev-parse --abbrev-ref HEAD` with `${FAKE_BRANCH:-main}` and
  `status --porcelain` with `$FAKE_DIRTY` (empty by default).
- writes a config file, mode 600, with the five values below, and
  `SSH_KEY` pointed at a temp file so no real key is read:
  `DEPLOY_HOST=host.example`, `DEPLOY_USER=deployer`,
  `DEPLOY_PATH=/home/deployer/tours`, `MAPILLARY_TOKEN=tok-SENTINEL-123`.
- runs `deploy/deploy.sh` with `PATH="<tmp>/bin:$PATH"`, `cwd` the repository
  root, and returns `(CompletedProcess, log_lines)`.

First test: `test_a_clean_run_on_main_succeeds` — exit 0, and the log contains
a `make` line and at least one `rsync` line.

- [ ] **Step 2: Run it to verify it fails**

Run: `cd backend && uv run --no-sync pytest tests/test_deploy_script.py -q`
Expected: FAIL — `deploy/deploy.sh` does not exist.

- [ ] **Step 3: Write `deploy/deploy.sh` through the happy path**

`set -euo pipefail`. Argument parsing, config loading and the ten remote steps
above. `chmod 755` it.

- [ ] **Step 4: Run it to verify it passes**

Expected: PASS.

- [ ] **Step 5: Test and pin the orderings**

```python
def test_the_front_controller_is_installed_before_anything_else(run_deploy):
    _, log = run_deploy()
    assert index_of(log, ".htaccess.new") < index_of(log, "app.cgi")
    assert index_of(log, "merge-htaccess.sh") < index_of(log, "app.cgi")
    assert index_of(log, "merge-htaccess.sh") < index_of(log, "backend/")
    assert index_of(log, "merge-htaccess.sh") < index_of(log, "MAPILLARY_TOKEN=")
```

The last assertion needs the `.env` step to be findable in the log without the
token's value appearing in an argv, so match the remote command's
`backend/.env` substring rather than the token.

- [ ] **Step 6: Test that nothing is ever deleted**

```python
def test_no_rsync_can_delete(run_deploy):
    _, log = run_deploy()
    rsyncs = [l for l in log if l.startswith("rsync ")]
    assert rsyncs
    for line in rsyncs:
        assert "--delete" not in line
        assert "--remove-source-files" not in line
```

- [ ] **Step 7: Test that the token is not in any argv**

```python
def test_the_token_never_appears_in_an_argument(run_deploy):
    _, log = run_deploy()
    assert any("backend/.env" in l for l in log)
    for line in log:
        assert "tok-SENTINEL-123" not in line
```

- [ ] **Step 8: Test the modes and the export flags**

One test asserting `--chmod=F644` is on the `.htaccess` line, `--chmod=F755`
on the `app.cgi` and `merge-htaccess.sh` lines; one asserting the `uv` line
carries `export`, `--no-dev` and `--no-emit-project`.

- [ ] **Step 9: Test that the checks run before the first remote command** (Review Focus 4)

```python
def test_checks_run_before_the_first_remote_command(run_deploy):
    _, log = run_deploy()
    first_remote = min(i for i, l in enumerate(log)
                       if l.startswith(("ssh ", "rsync ")))
    assert index_of(log, "make ") < first_remote
```

and a second test: with `STUB_EXIT_MAKE=1`, exit is non-zero and no `ssh` or
`rsync` line was logged.

- [ ] **Step 10: Run the tests; implement whatever they catch; commit**

```bash
git add deploy/deploy.sh backend/tests/test_deploy_script.py
git commit -m "Ship from a workstation: the deploy script, and what it must not do"
```

- [ ] **Step 11: Test that `--target` reaches every remote path** (Review Focus 3)

```python
def test_target_replaces_the_production_path_everywhere(run_deploy):
    _, log = run_deploy(args=["--target", "/home/deployer/tours-staging"])
    remote = [l for l in log if l.startswith(("ssh ", "rsync "))]
    assert remote
    for line in remote:
        assert "/home/deployer/tours\b" not in line + " "
        assert "/home/deployer/tours " not in line.replace("-staging", "-s")
```

Write the assertion so it cannot pass by accident: assert every remote line
that mentions a deploy path mentions `tours-staging`, and that no remote line
contains `/home/deployer/tours/` or `/home/deployer/tours'`.

- [ ] **Step 12: Test the production gates**

Three tests, each asserting non-zero exit, an error message naming the reason,
and no `ssh`/`rsync` in the log: `FAKE_BRANCH=other` with no `--target`;
`FAKE_DIRTY=" M frontend/src/x.css"` with no `--target`. A fourth test: both
of those conditions *with* `--target` succeed, because rehearsal is the point.

- [ ] **Step 13: Test the refusals around the config file** (Review Focus 1, 5)

Four tests, each non-zero with nothing logged: config file absent; a required
variable empty (and the message names it); config file mode `0644`; a config
value containing a space (`DEPLOY_HOST="host.example extra"`).

- [ ] **Step 14: Implement the refusals**

The mode check reads `stat` portably — try `stat -f '%Lp'` then `stat -c '%a'`
— and refuses if the low six bits are non-zero. The whitespace check runs over
`DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_PORT`, `SSH_KEY` and the resolved deploy
directory.

- [ ] **Step 15: Test that a failing remote command stops the deploy** (Review Focus 2)

With `STUB_EXIT_SSH=1`: exit non-zero, and the log's last line is the first
`ssh`, with no rsync after it. Then with the stub arranged to fail only on the
`merge-htaccess.sh` invocation: exit non-zero and no `app.cgi` line.

- [ ] **Step 16: Write `deploy/deploy.env.example` and gitignore the real one**

The example carries every variable with a comment each, empty values, and a
header saying to `cp deploy/deploy.env.example deploy/deploy.env && chmod 600
deploy/deploy.env`. Add `deploy/deploy.env` to `.gitignore` next to
`backend/.env`, with a comment saying why (it holds `MAPILLARY_TOKEN`).

- [ ] **Step 17: Run the whole backend suite and commit**

Run: `cd backend && uv run --no-sync pytest -q`
Expected: every test passes, including the pre-existing 593.

```bash
git add deploy/ backend/tests/test_deploy_script.py .gitignore
git commit -m "Refuse a deploy that would ship untested, unordered or unreadable"
```

---

### Task 2: Split CI from shipping

**Files:**
- Create: `.github/workflows/ci.yml`
- Modify: `.github/workflows/deploy.yml` (the `on:` block and its header comment only)

**Interfaces:**
- Consumes: nothing from Task 1. Parallel-safe with Task 1 — no file overlap.
- Produces: nothing other tasks read.

- [ ] **Step 1: Write `.github/workflows/ci.yml`**

`on: [push, pull_request]`, `permissions: contents: read`, one job on
`ubuntu-24.04`: checkout, Node 24, `npm ci`, `npx ng build`,
`npx ng test --watch=false`, Python 3.12, `python -m pip install uv`,
`uv sync`, `uv run ruff check app tests ../content/scripts`, `uv run pytest -q`.
No secrets referenced anywhere in the file — that is the point of the split,
and the comment at the top should say so.

Lift the step bodies and the comments explaining the pins (Node 24 vs Angular
22, Python 3.12 vs the host, `uv sync` vs the stale lockfile) from
`deploy.yml`'s sections 1–3.

- [ ] **Step 2: Remove the `push` trigger from `deploy.yml`**

Delete the `push: branches: [main]` trigger, leaving `workflow_dispatch`.
Replace the comment above `on:` with one saying that this workflow cannot
reach the host from GitHub's runners — the host's firewall drops them, which
the *Check the host is reachable* step reports — so shipping happens from
`deploy/deploy.sh` on a workstation, and this file is kept, intact and
manual-only, for the day that changes. Do not touch any step.

- [ ] **Step 3: Verify both files parse**

Run: `python -c "import yaml,sys; [yaml.safe_load(open(p)) for p in sys.argv[1:]]" .github/workflows/ci.yml .github/workflows/deploy.yml`
Expected: no output, exit 0.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/
git commit -m "Keep CI green and shipping manual, now that the runners cannot reach the host"
```

---

### Task 2b: Point the version guard at the workflow that now runs

Added during integration, not in the original plan. `backend/tests/test_versions.py`
reads `.github/workflows/deploy.yml` and asserts it carries **exactly one**
`python-version:` pin equal to the `requires-python` floor. After Task 2 that
is the manual-only workflow, while `ci.yml`'s pin — the one gating every push
and pull request — is unguarded and can silently drift from the floor and from
the host's 3.12.15. The test still passes, so nothing is red; the guard has
simply stopped covering the thing it was written to cover.

**Files:**
- Modify: `backend/tests/test_versions.py`

**Interfaces:**
- Consumes: `.github/workflows/ci.yml` from Task 2. Depends on it; not
  parallel-safe with it.

- [ ] **Step 1: Make the existing test fail for the right reason**

Temporarily change `ci.yml`'s pin to `"3.13"` and run the test. It passes —
that is the bug. Keep the broken `ci.yml` in place for Step 2.

- [ ] **Step 2: Write the failing assertion**

Extend `test_the_deploy_tests_on_the_interpreter_the_floor_names` to check both
workflows, or add a sibling test, so that **every** workflow under
`.github/workflows/` carrying a `python-version:` pin is checked: exactly one
pin per file, each equal to `>=`-stripped `requires-python`, each `3.12`.
Iterating the directory rather than naming the two files is the point — a third
workflow added later is covered without anyone remembering to add it here.
Run it against the broken `ci.yml`: expect FAIL naming `ci.yml` and `3.13`.

- [ ] **Step 3: Restore `ci.yml`'s pin to `"3.12"` and re-run**

Expected: PASS. Update the module and test docstrings — "the interpreter CI
tests on" now means `ci.yml`, and `deploy.yml`'s pin matters only to a manual
run, which is a distinction worth one sentence.

- [ ] **Step 4: Commit**

```bash
git add backend/tests/test_versions.py
git commit -m "Guard the Python pin in every workflow, not just the one that stopped running"
```

---

### Task 3: The runbook, the record and the unverified list

**Files:**
- Modify: `docs/DEPLOY.md` (step 5, step 6, and a new step between them)
- Create: `docs/decisions/0008-ship-from-a-workstation.md`
- Modify: `docs/decisions/README.md` (one index line)
- Modify: `docs/UNVERIFIED.md` (one new entry)

**Interfaces:**
- Consumes: the finished `deploy/deploy.sh` from Task 1 and the two workflow
  files from Task 2. Depends on both; not parallel-safe with either.
- Produces: nothing.

- [ ] **Step 1: Read the finished script and the two workflows**

Document what they do, not what this plan said they would.

- [ ] **Step 2: Rewrite `docs/DEPLOY.md` step 5 and add step 5b**

Step 5 keeps the GitHub table — the secrets are still what the manual workflow
needs — but gains a sentence at the top saying the pipeline cannot currently
reach the host, that step 5b is the path that works, and that the GitHub
configuration is worth doing anyway so a manual run is one button away if the
firewall opens.

New **step 5b, "Configure your own machine"**: the `cp … && chmod 600` of
`deploy/deploy.env.example`, a row per variable (the same meanings as the
secrets table, plus `SSH_KEY`), and the one difference worth stating — the host
key comes from your own `~/.ssh/known_hosts`, verified once interactively, so
there is no `DEPLOY_HOST_KEY` to paste; a host key that changes will stop the
deploy, which is the wanted behaviour.

- [ ] **Step 3: Rewrite step 6 to rehearse with the script**

`deploy/deploy.sh --target /home/USER/tours-staging`. Keep every warning the
section already carries — read step 7 first, have `mv .htaccess
.htaccess.broken` in a second terminal — and replace the "you should see in the
log" list with the script's own ordered output. Keep the failure list, adding
the script's refusals (loose config mode, missing variable, dirty tree, not on
`main`) and noting that `Host key verification failed` here means
`~/.ssh/known_hosts` has no entry for `DEPLOY_HOST`, fixed by one interactive
`ssh` to it.

- [ ] **Step 4: Write ADR 0008**

Title: *ship from a workstation, because the host drops the runners*. The
forces: Reclaim's firewall permits the author's address and drops GitHub's
hosted runners at the TCP level, confirmed by the same key and the same
`DEPLOY_HOST` succeeding from a Mac and timing out from a runner. The
alternatives and why they lost — allowlisting GitHub's ranges (thousands of
rotating Azure CIDRs, published at `api.github.com/meta`, so not a list a
shared host will take), a self-hosted runner on the author's Mac (works, since
the firewall sees the home address, but puts a long-running agent with repo
access on a personal laptop and needs it awake), host-pull via cPanel's Git
Version Control (the host has no Node 24, so the built bundle would have to be
committed). What is given up: a deploy is no longer automatic on merge, and the
`main`-only, clean-tree gates now live in a script rather than in a trigger.
What is kept: 0007's whole mechanism, and the tests and orderings that protect
it. Say explicitly that 0007 is not superseded — only the trigger moved.

- [ ] **Step 5: Add the index line and the UNVERIFIED entry**

`docs/decisions/README.md` gets one line in the house style. `docs/UNVERIFIED.md`
gets an entry: `deploy/deploy.sh` has never run against the host, its tests
prove the orderings and the refusals and nothing about rsync's or Apache's
behaviour, and the first real run is step 6's rehearsal against staging.

- [ ] **Step 6: Commit**

```bash
git add docs/
git commit -m "Say how to ship from a workstation, and record why"
```

---

## Self-Review

**Spec coverage.** There is no spec document; the thing reproduced is
`deploy.yml`'s ship half, and Task 1's design table transcribes all ten of its
remote operations in order, with its excludes, its modes and its
only-if-absent `.env`. The two halves it does *not* reproduce are the host-key
pin (replaced, deliberately, by the workstation's `known_hosts` — Task 3
Step 2 documents the swap) and the *Check the host is reachable* preflight,
which has nothing to diagnose from a machine that can already reach the host.

**Step scan.** Steps 3, 14 and Task 2 Step 1 name an outcome rather than
transcribing a body, because the design table and the existing workflow
determine the body. Step 11's first draft carried a `\b` inside a Python string
literal, which is a backspace and would have made the test vacuous; the step
now states the assertion in prose and says to write it so it cannot pass by
accident. That is the one place in this plan where the test must be reasoned
about rather than copied.

**Type consistency.** The script's two flags (`--target`, `--config`), the six
config variables, and the stub environment names (`STUB_LOG`,
`STUB_EXIT_<NAME>`, `FAKE_BRANCH`, `FAKE_DIRTY`) are used with the same
spellings in every step that mentions them.

**Review Focus.** All five lines have a step: 1 → Step 13, 2 → Step 15,
3 → Step 11, 4 → Step 9, 5 → Steps 12 and 13.

**Proportion.** The plan is longer than `deploy.sh` will be, which for a
150-line shell script that cannot be tried out before it runs against a live
host is the right side to err on: most of the length is the ordering table and
the refusal tests, and both are decisions rather than transcription.
