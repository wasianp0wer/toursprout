# Environment constraints

Findings verified on 2026-09-20. Every one of these was discovered by hitting
the failure first, so treat them as load-bearing rather than advisory.

## Use `httpx` for all outbound HTTP. Never `urllib.request`.

Python's stdlib `urllib.request` silently truncates response bodies through the
sandbox egress proxy, raising `IncompleteRead(N bytes read, M more expected)`.

Measured against `graph.mapillary.com`, identical URL, 10 trials each:

| client | success |
| --- | --- |
| `urllib` + `Accept-Encoding: identity` | 9/10 |
| `urllib` + `Accept-Encoding: gzip` | **0/10** |
| `curl --compressed` | 10/10 |
| `httpx` (HTTP/1.1 and HTTP/2) | 10/10 |
| `requests` | 10/10 |

All egress is routed through `HTTP_PROXY=localhost:<port>`; urllib's proxy
CONNECT handling mismatches the proxied body framing. Retries do not help — it
reproduces on the same URL. Encoding tweaks do not help; gzip is strictly worse.

A working first call proves nothing here: the failure rate is roughly 1-in-10
and depends on payload size.

## Set `UV_CACHE_DIR` before any `uv` command.

The default cache is outside the sandbox-writable tree, so `uv venv` and
`uv pip install` both fail with:

```
error: Failed to initialize cache at `/Users/<user>/.cache/uv`
  Caused by: failed to open file `.../sdists-v9/.git`: Operation not permitted
```

Set it to a gitignored path inside the repo. Bake this into the Makefile rather
than relying on shell state — each command runs in a fresh shell.

```sh
export UV_CACHE_DIR="$PWD/.uv-cache"
```

## Node must be 24 LTS, and the shim does not load non-interactively.

Angular 22.1.7 declares `node: ^22.22.3 || ^24.15.0 || >=26.0.0`. Node 24 is
installed, but `node --version` in a non-interactive shell still reports
v25.8.1 because the fnm/nvm shim initialises only in interactive shells.
Frontend tooling must resolve Node explicitly (a pinned shim path, `.nvmrc` plus
an explicit `fnm exec`, or a Makefile that sets PATH) rather than assuming the
ambient `node`.

## Writes are confined to the project directory.

`~/.claude`, `~/.cache`, and the rest of the home tree are read-only or denied.
Anything that needs to persist belongs in the repo.

## Disable Angular's build cache, or `ng build` aborts silently.

With the default cache enabled, `ng build` exits **134 (SIGABRT) producing no
output at all** — no error message, no stack trace, no `dist/`. The cache is
backed by `lmdb`, which memory-maps files and aborts hard when the sandbox
refuses an operation.

`angular.json` therefore sets:

```json
"cli": { "cache": { "enabled": false } }
```

Do not re-enable it. A silent SIGABRT is extremely easy to misread as a broken
build config, and costs far more than the cache saves on a project this size.

## npm 11 gates install scripts.

`npm install` leaves native packages unbuilt and warns rather than failing.
`npm install-scripts approve esbuild lmdb msgpackr-extract @parcel/watcher`
has been run. New native dependencies will need the same treatment. Note this
was *not* the cause of the SIGABRT above — the cache was.

## `.vscode/` cannot be written.

`ng new` fails with `EPERM` when it reaches `.vscode/extensions.json`. Scaffold
into the scratchpad and `rsync -a --exclude '.vscode'` into place.

## Library notes discovered while wiring the frontend.

- **maplibre-gl v6 has no default export.** `import maplibregl from 'maplibre-gl'`
  fails with TS1192. Use named imports: `import { Map, Marker } from 'maplibre-gl'`.
- **mapillary-js needs no CommonJS allowlist.** Despite depending on the
  unmaintained CJS `virtual-dom`, its ESM build bundles cleanly under esbuild
  with zero warnings. `allowedCommonJsDependencies` is not required.
- **Bundle budgets must be raised.** three.js plus MapLibre put the initial
  bundle at 2.23 MB raw / 487 kB transferred. Budgets are set to 3 MB warn,
  4 MB error.

## Browser end-to-end tests cannot run inside the sandbox.

Playwright installs fine, but no browser engine can start:

- **Chromium** dies at launch with
  `FATAL:base/apple/mach_port_rendezvous_mac.cc:159 Check failed: kr == KERN_SUCCESS.
  bootstrap_check_in org.chromium.Chromium.MachPortRendezvousServer: Permission denied (1100)`.
  Chrome registers a Mach port at startup; the macOS sandbox denies it. No
  command-line flag avoids this — it happens in the browser process before any
  flag is consulted.
- **Firefox** launches its parent process but fails at
  `browserContext.newPage: Cannot read properties of undefined (reading '_page')`,
  i.e. it cannot spawn a content process.
- **WebKit** was not installed after the first two failed.

Two consequences:

1. `make e2e` must be run **outside** Claude Code, from an ordinary terminal.
   The suite itself is correct and complete; only the launch is blocked.
2. Because of that, `src/app/integration/real-tour.spec.ts` renders the real
   committed tour document through the real components under jsdom. It covers
   everything the Playwright suite does except WebGL rendering: navigation
   through all six stops, every overlay's credit, media URLs, and the honesty
   of the synthesized-narration credit.

Also note `ng serve` exhausts the file-descriptor limit here
(`Watchpack Error: EMFILE: too many open files`). The backend serves the built
Angular bundle instead, so the whole app runs from one process on port 8000
with no dev-server watcher and no proxy hop.


## `three` must stay the copy mapillary-js already depends on.

Rephotos are rendered with three.js through `viewer.addCustomRenderer()`. The
version used is `three@0.134.0`, hoisted into the top-level `node_modules` as a
mapillary-js dependency — it is deliberately **not** a direct dependency.

Installing three separately produces two copies sharing one WebGL context,
which fails in ways that are hard to attribute: materials silently not
rendering, `instanceof` checks failing across copies, disposal freeing the
wrong resources. Verify with:

```sh
cd frontend && npm ls three
```

Expect exactly one entry, nested under `mapillary-js`.
