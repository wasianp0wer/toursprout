# Omeka Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An author searches any Omeka Classic site from the editor and adds one of an item's image or audio files to the current stop, with title, description and a sourced credit filled from Dublin Core.

**Architecture:** The backend does every Omeka call. A new `net_guard.py` refuses non-public addresses, both before each request and at connect time. A new `omeka.py` holds parsing (pure) and fetching (through an `httpx.Client`). Three routes in `main.py` call these. On the frontend, `ToolsApi` gains three methods, `document-ops.ts` gains the credit builder, and a standalone `OmekaPanel` is opened from the outline pane.

**Tech Stack:** FastAPI, pydantic, httpx/httpcore 1.0.9, pytest with `httpx.MockTransport`; Angular 22 standalone components with signals, vitest via `ng test`.

**Spec:** `docs/superpowers/specs/2026-11-20-omeka-import-design.md`. Read it before any task; it has the error table and credit mapping these tasks implement.

## Global Constraints

- Every Omeka route finishes in **≤ 30 s** end to end. The limits are:
  - `OMEKA_REQUEST_TIMEOUT = 10.0` per request;
  - `OMEKA_ROUTE_BUDGET = 30.0` for the whole route;
  - `OMEKA_DOWNLOAD_BUDGET = 25.0` for the download;
  - `OMEKA_ATTEMPTS = 2` (one retry);
  - `MAX_REDIRECTS = 5`.
- Only `http`/`https`, no userinfo, default ports only (80 for http, 443 for https).
- No test touches the network or real DNS. Route tests set `app.state.http_transport` (MockTransport) and `app.state.omeka_resolve` (fake resolver).
- Bytes reach `media/` only through `media_store.store_media`.
- No schema change; `SourcedCredit` is unchanged.
- The author-facing messages are copied **verbatim** from the spec's error table, with `{host}` and `{base}` filled in.
- Outbound HTTP is httpx only, never urllib (`docs/ENVIRONMENT.md`).
- Run tests with:
  - backend: `cd backend && uv run pytest -q`;
  - lint: `cd backend && uv run ruff check app tests`;
  - frontend: `cd frontend && npx ng test --watch=false`.

## Review Focus

1. **Author pastes an item page** (`https://omeka.madelynharrington.net/items/show/7`) into Site → it searches the site, not a 404. Test in Task 2 (`omeka_base` table).
2. **Cloudflare (or any proxy) answers `/api/site` with a 200 HTML page** → the "no Omeka Classic site" message, not a crash or JSON error. Test in Task 2 (`site_from_response`).
3. **Titles with trailing spaces or `html: true` markup** (`"Egyptian Cat Statuette "`) → trimmed plain text in the overlay. Test in Task 2.
4. **The author presses Add twice, or switches stop while an import is in flight** → one overlay, on the stop that was current when Add was pressed. Test in Task 6.
5. **Item with no Rights (fixture item 3, "Medieval Cats")** → Add disabled until a licence is typed; the typed licence is what lands in the credit. Tests in Tasks 5 and 6.

## Tasks, dependencies and parallelism

| Task | Files | Depends on | Parallel-safe with |
|---|---|---|---|
| 1 Address guard | `backend/app/net_guard.py`, `backend/tests/test_net_guard.py` | — | 2, 5 |
| 2 Omeka parsing | `backend/app/omeka.py`, `backend/tests/test_omeka.py` | — (fixtures committed) | 1, 5 |
| 3 Omeka fetching | `backend/app/omeka.py`, `backend/tests/test_omeka_fetch.py` | 1, 2 | 6 |
| 4 Routes | `backend/app/main.py`, `backend/tests/test_omeka_routes.py`, `docs/UNVERIFIED.md` | 3 | 6 |
| 5 Frontend data | `frontend/src/app/core/tools-api.ts` (+spec), `frontend/src/app/editor/document-ops.ts` (+spec) | — | 1, 2 |
| 6 Omeka panel | `frontend/src/app/editor/omeka-panel.{ts,html,css,spec.ts}`, `outline-pane.{ts,html}` (+spec), `docs/FOR-HISTORIANS.md` | 5 | 3, 4 |

Waves: **{1, 2, 5}** → **{3, 6}** → **4**. Each parallel task runs in its own worktree, and they are merged back one at a time with the full suite run after each merge. **Guard fallback (spec):** if Task 1's connect-time part (Steps 5–8) is not green by Saturday 2026-11-21 midday, merge Task 1 with Steps 1–4 only and add the open item to `docs/UNVERIFIED.md` in Task 4.

---

### Task 1: Address guard

**Files:**
- Create: `backend/app/net_guard.py`
- Test: `backend/tests/test_net_guard.py`

**Interfaces:**
- Produces:
  - `Resolver = Callable[[str, int], list[str]]`: host and port in, IP strings out.
  - `resolve(host: str, port: int) -> list[str]`: `socket.getaddrinfo`, unique addresses.
  - `is_public_address(ip: str) -> bool`.
  - `check_public_url(url: str | httpx.URL, *, resolve: Resolver = resolve) -> httpx.URL`.
    - Raises `tools.ToolError(400, …)`.
    - Returns the parsed URL.
  - `class GuardedBackend(httpcore.NetworkBackend)`.
    - `__init__(self, resolve: Resolver = resolve, inner: httpcore.NetworkBackend | None = None)`.
  - `make_guarded_client(timeout: float, *, resolve: Resolver = resolve) -> httpx.Client`.
    - `trust_env=False`, `follow_redirects=False`, `User-Agent: tools.UA`.
    - Its transport's connection pool uses `GuardedBackend(resolve)`.

- [ ] **Step 1: Write the failing tests for classification and URL checks**

```python
@pytest.mark.parametrize("ip", ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1",
    "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "::1", "fe80::1",
    "fc00::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1"])
def test_non_public_refused(ip): assert not is_public_address(ip)

@pytest.mark.parametrize("ip", ["104.21.46.14", "172.67.222.62", "2606:4700::6810:2e0e"])
def test_public_allowed(ip): assert is_public_address(ip)

PUBLIC = lambda host, port: ["104.21.46.14"]
PRIVATE = lambda host, port: ["10.0.0.5"]
MIXED = lambda host, port: ["104.21.46.14", "127.0.0.1"]

@pytest.mark.parametrize("url", ["ftp://example.org/", "https://a@example.org/",
    "https://example.org:8443/", "http://example.org:443/", "file:///etc/passwd", "not a url"])
def test_bad_url_shapes_refused(url):
    with pytest.raises(ToolError) as e: check_public_url(url, resolve=PUBLIC)
    assert e.value.status == 400

def test_private_resolution_refused_with_spec_message():
    with pytest.raises(ToolError) as e: check_public_url("https://intranet.example/", resolve=PRIVATE)
    assert e.value.message == ("intranet.example points to a private or local network "
                               "address, which the editor will not connect to.")

def test_any_private_address_among_several_refuses(): ...  # MIXED → ToolError 400
def test_ip_literal_checked_without_resolving(): ...       # "http://127.0.0.1/" refused; resolver never called
def test_public_https_and_http_default_ports_pass(): ...   # returns httpx.URL for both
```

- [ ] **Step 2: Run** `cd backend && uv run pytest tests/test_net_guard.py -q`. Expected: FAIL, `ModuleNotFoundError: app.net_guard`.

- [ ] **Step 3: Implement `is_public_address`, `resolve`, `check_public_url` in `backend/app/net_guard.py`**

  - `is_public_address`: `ipaddress.ip_address(ip)`; an IPv6 address with `ipv4_mapped` is judged by the mapped v4; then `.is_global and not .is_multicast`.
  - `check_public_url`, malformed URLs: raise `ToolError(400, "that is not a web address the editor can fetch (only http and https on the usual ports)")` for every bad-shape case.
  - `check_public_url`, resolution: a DNS failure is `ToolError(502, "The editor's server could not reach {host} (the name did not resolve). …")`, using the spec's unreachable message with reason `the name did not resolve`.

- [ ] **Step 4: Run Step 2's command.** Expected: PASS. Commit: `git commit -m "Refuse non-public addresses before an Omeka fetch"`

- [ ] **Step 5: Write the failing connect-time tests**

```python
class FakeInner(httpcore.NetworkBackend):
    def __init__(self): self.connected = []
    def connect_tcp(self, host, port, timeout=None, local_address=None, socket_options=None):
        self.connected.append((host, port)); return FakeStream()

def test_connects_to_the_address_it_checked():
    inner = FakeInner()
    GuardedBackend(PUBLIC, inner).connect_tcp("omeka.example", 443)
    assert inner.connected == [("104.21.46.14", 443)]

def test_rebinding_refused_at_connect():
    answers = iter([["104.21.46.14"], ["127.0.0.1"]])
    resolver = lambda h, p: next(answers)
    check_public_url("https://omeka.example/", resolve=resolver)   # first lookup passes
    inner = FakeInner()
    with pytest.raises(httpcore.ConnectError):
        GuardedBackend(resolver, inner).connect_tcp("omeka.example", 443)
    assert inner.connected == []

def test_production_client_uses_guarded_backend():
    c = make_guarded_client(5.0)
    assert isinstance(c._transport._pool._network_backend, GuardedBackend)
    assert c.follow_redirects is False and c._trust_env is False
```

- [ ] **Step 6: Run** `uv run pytest tests/test_net_guard.py -q`. Expected: the three new tests FAIL.

- [ ] **Step 7: Implement `GuardedBackend` and `make_guarded_client`**

  - `connect_tcp`: resolves `host`, raises `httpcore.ConnectError("… points to a private or local network address …")` if any address is non-public, then calls `inner.connect_tcp(first_public_ip, port, …)`. `connect_unix_socket` raises.
  - TLS SNI and certificate checks still use the hostname, because httpcore passes `server_hostname` from the request origin to `start_tls`.
  - `make_guarded_client`: build `httpx.HTTPTransport()`, then replace its `_pool` with `httpcore.ConnectionPool(ssl_context=httpx.create_ssl_context(), network_backend=GuardedBackend(resolve))`. Reaching into `_pool` is accepted; write a one-line comment saying why.

- [ ] **Step 8: Run** `uv run pytest tests/test_net_guard.py -q && uv run ruff check app tests`. Expected: PASS. Commit: `git commit -m "Check the address again at connect time, against DNS rebinding"`

---

### Task 2: Omeka parsing (pure functions)

**Files:**
- Create: `backend/app/omeka.py`
- Test: `backend/tests/test_omeka.py`
- Read: `backend/tests/fixtures/omeka/{site,items,files-1,files-2,files-3}.json`, captured live on 2026-11-20. `files-1` is an MP3 with `fullsize: null`. `files-2` is a JPEG. `files-3` is a PNG with a JPEG `fullsize`, and its item has no Rights.

**Interfaces:**
- Produces, all in `app.omeka`:
  - `omeka_base(raw: str) -> str`.
  - `dublin_core(element_texts: list) -> dict[str, str]`: element name → plain text, several values joined with `"; "`, trimmed, blanks dropped.
  - `site_from_response(resp: httpx.Response, base: str) -> dict`: returns `{"base", "title"}`, or raises `ToolError` per the spec table.
  - `item_summary(item: dict, base: str) -> dict | None`: `None` when `files.count == 0`.
    - Keys: `itemId, itemUrl, title, description, creator, date, rights, fileCount`.
    - Missing fields are `None`, except `title`, which falls back to `""`.
  - `file_summary(f: dict) -> dict`.
    - Keys: `fileId, kind, filename, thumbUrl, importable, reason, title, creator, rights`.
  - `download_url(f: dict) -> str | None`: `fullsize` for image, `original` for audio, `None` if not importable.
  - `AUDIO_TYPES`: frozenset of `media_store.ALLOWED_TYPES` keys starting with `audio/`.

- [ ] **Step 1: Write the failing tests**

```python
@pytest.mark.parametrize("raw,base", [
    ("omeka.madelynharrington.net", "https://omeka.madelynharrington.net"),
    ("https://omeka.madelynharrington.net/", "https://omeka.madelynharrington.net"),
    ("https://omeka.madelynharrington.net/items/show/7", "https://omeka.madelynharrington.net"),
    ("https://example.org/omeka/items/browse?tags=x#top", "https://example.org/omeka"),
    ("https://example.org/omeka/admin/items", "https://example.org/omeka"),
    ("http://example.org/omeka/collections/show/2", "http://example.org/omeka"),
    ("  https://example.org/exhibits/show/fairfax  ", "https://example.org"),
])
def test_omeka_base(raw, base): assert omeka_base(raw) == base

def test_dublin_core_from_live_item():   # items.json[0]: Title, Creator 'Ronald Reagan White House', Rights 'Public domain'
def test_dublin_core_strips_html_and_trims():
    # {"html": True, "text": "<p>The <em>cupola</em> &amp; dome </p>"} → "The cupola & dome"
def test_dublin_core_joins_repeats_and_ignores_other_sets():  # two Creators → "A; B"; "Item Type Metadata" ignored
def test_item_summary_live_item_3_has_no_rights():
    s = item_summary(items[2], BASE)
    assert s["itemUrl"] == f"{BASE}/items/show/3" and s["rights"] is None and s["title"] == "Medieval Cats"
def test_item_summary_trims_trailing_space():  # item 5 → "Egyptian Cat Statuette"
def test_item_summary_none_without_files():
def test_file_summary_image_png_uses_jpeg_fullsize():   # files-3: kind "image", importable, download_url endswith ".jpg" in /fullsize/
def test_file_summary_audio_mp3():                      # files-1: kind "audio", download_url == original
def test_file_summary_pdf_not_importable():             # mime application/pdf → importable False, reason "PDF files can't be added to a tour"
def test_file_summary_image_without_fullsize_not_importable():  # tiff, fullsize None → reason mentions the type

SITE_MESSAGES = {
  "disabled": "The Omeka site at omeka.example has its API turned off. Someone with an administrator login can turn it on: in the Omeka admin, go to Settings → API, tick Enable API access, and save. Then search again.",
  "notomeka": "There is no Omeka Classic site at https://omeka.example. Check the address is the site's home page, for example https://example.org or https://example.org/omeka. (Omeka S sites are not supported yet.)",
}
def test_site_live(): # 200 site.json → {"base": BASE, "title": "Madelyn's Interests and Exhibits"}
def test_site_api_disabled():          # 403 {"message":"API is disabled"} → ToolError 409, SITE_MESSAGES["disabled"]
def test_site_other_403():             # 403 {"message":"Invalid key."} → 409, message contains "Invalid key." and "signed-in access"
def test_site_404():                   # → 404, SITE_MESSAGES["notomeka"]
def test_site_html_200_is_not_omeka(): # 200 text/html "<html>Just a moment...</html>" → 404 notomeka
def test_site_5xx():                   # 503 → 502 "The Omeka site at omeka.example had an error (503). Try again in a minute."
def test_site_blank_title_falls_back_to_host():
```

- [ ] **Step 2: Run** `uv run pytest tests/test_omeka.py -q`. Expected: FAIL, module missing.
- [ ] **Step 3: Implement the functions in `backend/app/omeka.py`**
  - Strip HTML with stdlib `html.parser` and `html.unescape`.
  - The PDF reason is `"PDF files can't be added to a tour"`. Any other type gets `"{mime} files can't be added to a tour"`.
  - Use the Markdown-free form of the spec's messages, as in the test strings above (no `**` or backticks).
- [ ] **Step 4: Run Step 2's command, plus ruff.** Expected: PASS. Commit: `git commit -m "Parse Omeka Classic sites, items and files"`

---

### Task 3: Omeka fetching

**Files:**
- Modify: `backend/app/omeka.py`
- Test: `backend/tests/test_omeka_fetch.py`

**Interfaces:**
- Consumes:
  - from Task 1: `check_public_url(url, resolve=)`, `Resolver`;
  - from Task 2: `site_from_response`, `item_summary`, `download_url`;
  - from `tools`: `ToolError`, `_describe`;
  - from `media_store`: `sniff`.
- Produces:
  - Constants (values from Global Constraints): `OMEKA_REQUEST_TIMEOUT`, `OMEKA_ROUTE_BUDGET`, `OMEKA_DOWNLOAD_BUDGET`, `OMEKA_ATTEMPTS`, `MAX_REDIRECTS`.
  - `get_site(client, base, *, deadline: float, resolve: Resolver) -> dict`.
  - `search_items(client, base, query: str, page: int, *, deadline, resolve) -> dict`: returns `{"total": int, "page": int, "results": [item_summary…]}`.
    - Items with no files are dropped from `results`.
    - `total` comes from the `Omeka-Total-Results` header, or 0.
  - `list_files(client, base, item_id: int, *, deadline, resolve) -> list[dict]`: raw file records.
  - `fetch_file(client, url: str, kind: str, *, deadline, resolve, max_bytes: int) -> bytes`.
  - `deadline` is a `time.monotonic()` value. The route computes it once as `monotonic() + OMEKA_ROUTE_BUDGET`.

- [ ] **Step 1: Write the failing tests** (MockTransport client; `resolve=PUBLIC`):

```python
def test_search_live_shape():      # /api/items?search=a&page=1 → items.json, header Omeka-Total-Results: 6
    r = search_items(c, BASE, "a", 1, deadline=far(), resolve=PUBLIC)
    assert r["total"] == 6 and [x["itemId"] for x in r["results"]] == [1, 2, 3, 5, 6, 7]
def test_search_sends_query_and_page():   # handler asserts params search=cupola, page=2
def test_get_json_bad_json_is_502():
def test_redirect_rechecked_each_hop():   # 302 Location http://10.0.0.1/ with resolve mapping that host private → ToolError 400, second request never made
def test_too_many_redirects():            # 6 hops → ToolError 502
def test_unreachable_message():           # handler raises httpx.ConnectError → 502, message starts "The editor's server could not reach omeka.example ("
def test_deadline_spent_is_504():         # deadline=monotonic()-1 → ToolError 504 "The Omeka site at omeka.example took too long to answer. Try again, or try a smaller file."
def test_fetch_file_image_ok():           # JPEG magic bytes → returned
def test_fetch_file_wrong_kind():         # kind "image", body is MP3 (ID3) → 502
def test_fetch_file_declared_too_big():   # Content-Length max_bytes+1 → 502 before body read
def test_fetch_file_streamed_too_big():   # no Content-Length, body > max_bytes → 502
def test_fetch_file_retries_once_on_5xx(): # 503 then 200 → ok; 503,503 → 502; exactly 2 requests
def test_fetch_file_4xx_no_retry():       # 404 → 502 at once, 1 request
def test_per_request_timeout_never_exceeds_remaining_budget():  # handler captures request.extensions["timeout"]; all ≤ remaining and ≤ 10.0
```

- [ ] **Step 2: Run** `uv run pytest tests/test_omeka_fetch.py -q`. Expected: FAIL (`ImportError` on `search_items`).
- [ ] **Step 3: Implement**
  - Write one private `_get(client, url, *, params, deadline, resolve, stream=False)`.
    - It calls `check_public_url` before every hop and follows redirects by hand.
    - Per-request timeout: `min(OMEKA_REQUEST_TIMEOUT, deadline - monotonic())`.
    - `httpx.HTTPError` becomes the spec's 502 unreachable message.
    - Running out of time becomes the 504.
  - `get_site` feeds its response to `site_from_response`.
  - `fetch_file` is `fetch_archive_image` from commit `67bf589` (`git show 67bf589^:backend/app/tools.py`), with the cap, hops, attempts and deadline changed to this task's values.
- [ ] **Step 4: Run the whole backend suite plus ruff.** Expected: PASS. Commit: `git commit -m "Fetch from Omeka through the guard, within a 30 s budget"`

---

### Task 4: Routes

**Files:**
- Modify: `backend/app/main.py` (the acquisition tools section, after `tool_geocode`)
- Modify: `docs/UNVERIFIED.md` (new entry: the Omeka live check, spec "Live check" steps 3–5; plus the connect-time guard if Task 1 fell back)
- Test: `backend/tests/test_omeka_routes.py`

**Interfaces:**
- Consumes: Task 3's functions; Task 1's `make_guarded_client`, `resolve`; Task 2's `omeka_base`, `file_summary`, `download_url`.
- Produces three HTTP contracts (Task 5 calls them). Each is `POST` with `Depends(_reject_cross_site)` and a plain `def`.
  - `/api/tools/omeka-search`:
    - Body: `{siteUrl: str ≤2000, query: str 1..300 non-blank (stripped), page: int 1..1000 = 1}`.
    - Returns: `{site: {base, title}, total, page, results}`.
  - `/api/tools/omeka-files`:
    - Body: `{siteUrl, itemId: int ≥1}`.
    - Returns: `{files: [file_summary…]}`.
  - `/api/tools/omeka-import`:
    - Body: `{siteUrl, itemId, fileId: int ≥1, title: str ≤300 = ""}`.
    - Returns: `{...session.summary(), mediaId}`.
    - 409 if no tour is open.
    - 404 `"That file is no longer on the Omeka item."` if `fileId` is not in the item's files.
    - 400 with the file's `reason` if it is not importable.
    - `MediaError` → 400.
  - Request models live in `omeka.py`: `OmekaSearchRequest`, `OmekaFilesRequest`, `OmekaImportRequest`.
- Client: when `app.state.http_transport` is set (tests), use `tools.make_client(transport, OMEKA_REQUEST_TIMEOUT)`. Otherwise use `make_guarded_client(OMEKA_REQUEST_TIMEOUT)`.
- Resolver: `getattr(app.state, "omeka_resolve", net_guard.resolve)`.

- [ ] **Step 1: Write the failing tests** (pattern of `tests/test_tools.py`: `client` fixture, `mock()`, plus `client.app.state.omeka_resolve = PUBLIC`; open a tour as `test_api.py` does):

```python
def test_cross_site_refused(tool)            # all three → 403 with Sec-Fetch-Site: cross-site
def test_search_live(client)                 # site.json + items.json → 200, site.title, total 6
def test_search_api_disabled_message(client) # 403 disabled → 409, detail contains "Settings → API"
def test_search_blank_query_422(client)
def test_files_live(client)                  # files-3.json → [{"kind": "image", "importable": True, ...}]
def test_import_stores_fullsize(client)      # fullsize URL returns JPEG bytes → mediaId ends ".jpg"; handler asserts the fetched URL is fullsize, not original
def test_import_ignores_client_url(client)   # extra "url": "http://evil/" in body → 422 or ignored; no request to evil
def test_import_no_tour_409(client)
def test_import_unknown_file_404(client)
def test_import_pdf_400(client)
def test_import_private_site_400(client)     # omeka_resolve → private; no transport request made
```

- [ ] **Step 2: Run** `uv run pytest tests/test_omeka_routes.py -q`. Expected: FAIL with 404 (routes missing).
- [ ] **Step 3: Implement the three routes.** Each computes `deadline = time.monotonic() + omeka.OMEKA_ROUTE_BUDGET` once, and maps `ToolError` to `HTTPException(status, message)` as `tool_places` does. Import stores with `store_media(session.path, body, title or "omeka", max_file_bytes=cfg.max_media_file_bytes, max_session_bytes=cfg.max_session_media_bytes)`.
- [ ] **Step 4: Add the `docs/UNVERIFIED.md` entry in that file's existing format.**
- [ ] **Step 5: Run the full backend suite plus ruff.** Expected: PASS. Commit: `git commit -m "Omeka search, files and import routes"`

---

### Task 5: Frontend data layer

**Files:**
- Modify: `frontend/src/app/core/tools-api.ts`, `frontend/src/app/core/tools-api.spec.ts`
- Modify: `frontend/src/app/editor/document-ops.ts`, `frontend/src/app/editor/document-ops.spec.ts`

**Interfaces:**
- Consumes: Task 4's HTTP contracts. Only their shapes matter here; tests use `HttpTestingController`.
- Produces, in `tools-api.ts`:
  - `export interface OmekaSite { base: string; title: string }`.
  - `export interface OmekaItem { itemId: number; itemUrl: string; title: string; description: string | null; creator: string | null; date: string | null; rights: string | null; fileCount: number }`.
  - `export interface OmekaSearch { site: OmekaSite; total: number; page: number; results: OmekaItem[] }`.
  - `export interface OmekaFile { fileId: number; kind: 'image' | 'audio' | null; filename: string; thumbUrl: string | null; importable: boolean; reason: string | null; title: string | null; creator: string | null; rights: string | null }`.
  - `ToolsApi` methods:
    - `omekaSearch(siteUrl: string, query: string, page = 1): Promise<OmekaSearch>`;
    - `omekaFiles(siteUrl: string, itemId: number): Promise<OmekaFile[]>`;
    - `omekaImport(siteUrl: string, itemId: number, fileId: number, title: string): Promise<string>` (resolves to the mediaId).
- Produces, in `document-ops.ts`:
  - `omekaCredit(site: OmekaSite, item: OmekaItem, file: OmekaFile, authorLicense?: string): Credit | null`.
  - `omekaOverlayText(item: OmekaItem, file: OmekaFile): { title: string; body: string | null }`.
  - `addMediaOverlay(...)` gains a trailing `body?: string | null`. Existing callers are unchanged, and the new overlay's `body` is `body?.trim() || null`.

- [ ] **Step 1: Write the failing tests**

```ts
it('posts omeka-search and returns the payload')            // URL /api/tools/omeka-search, body {siteUrl, query, page: 1}
it('omekaImport resolves to mediaId')
it('surfaces the server detail verbatim')                    // 409 {detail: 'The Omeka site at x has its API turned off. …'} → Error.message equals it

const site = { base: 'https://omeka.example', title: "Madelyn's Interests and Exhibits" };
it('omekaCredit prefers file fields over item fields')       // file.rights 'CC0', item.rights 'Public domain' → license 'CC0'
it('omekaCredit uses the item rights when the file has none')
it('omekaCredit uses the typed licence only when Omeka states none')  // item 3 shape + 'CC BY 4.0' → license 'CC BY 4.0'
it('omekaCredit is null with no rights and no typed licence')         // also null for '   '
it('omekaCredit source falls back to the host when title is blank')  // source 'omeka.example'
it('omekaCredit url is the item page and creator may be null')
it('omekaOverlayText falls back title → item title → filename, body is the description')
it('addMediaOverlay writes body in the same change')         // one draft change; overlay.body === 'desc'
it('addMediaOverlay without body keeps body null')            // existing behaviour pinned
```

- [ ] **Step 2: Run** `cd frontend && npx ng test --watch=false`. Expected: the new specs FAIL, because the methods and functions don't exist yet.
- [ ] **Step 3: Implement.** `omekaCredit` takes the shape of the deleted `archiveCredit` (`git show 67bf589^:frontend/src/app/editor/document-ops.ts`), with `source = site.title.trim() || new URL(site.base).host`.
- [ ] **Step 4: Run the full frontend suite.** Expected: PASS. Commit: `git commit -m "Omeka tool client and credit mapping"`

---

### Task 6: Omeka panel

**Files:**
- Create: `frontend/src/app/editor/omeka-panel.ts`, `omeka-panel.html`, `omeka-panel.css`, `omeka-panel.spec.ts`
- Modify: `frontend/src/app/editor/outline-pane.ts`, `outline-pane.html`, `outline-pane.spec.ts`
- Modify: `docs/FOR-HISTORIANS.md`: a short "Importing from Omeka" section. It covers: the site's API must be on (Settings → API); only public items; images come in as Omeka's large JPEG; a missing licence must be typed.

**Interfaces:**
- Consumes: from Task 5, `ToolsApi.omekaSearch/omekaFiles/omekaImport`, `omekaCredit`, `omekaOverlayText`, and `addMediaOverlay(..., body)`.
- Produces:
  - `OmekaPanel` (standalone, selector `app-omeka-panel`), with `input.required<string>()` named `stopId`.
  - It has an `output<OmekaAdded>()` named `added`, where `OmekaAdded = { stopId: string; kind: 'image' | 'audio'; mediaId: string; title: string; body: string | null; credit: Credit }`.
  - The outline pane gets a toolbar button `data-omeka-open` labelled **Import from Omeka**, disabled without `store.currentStop()`. It toggles the panel.
  - On `added`, the outline pane calls `createFromMedia(kind, mediaId, title, stopId, credit, …, body)`; that is, `createFromMedia` gains a trailing `body`.
- `data-` hooks (tests use these):
  - search form: `data-omeka-site`, `data-omeka-query`, `data-omeka-search`;
  - results: `data-omeka-item="<itemId>"` (click to open), `data-omeka-file="<fileId>"`, `data-omeka-license`, `data-omeka-add`, `data-omeka-more`;
  - messages: `data-omeka-error`, `data-omeka-none`.
- Site address persistence: `localStorage` key `clio-wired.omeka-site`, with every read and write wrapped in try/catch.
- Layout: as the spec's sketch. Use the existing editor CSS tokens. Status notes use the `.note` / `.note.warning` idiom.

- [ ] **Step 1: Write the failing tests** (fake `ToolsApi` resolving the fixture shapes):

```ts
it('searches with the typed site and query and lists items with file counts')
it('remembers the site address across panel instances')       // and survives localStorage throwing
it('opens an item and lists its files, non-importable ones with their reason and no Add button')
it('shows the server message verbatim on a failed search')       // 'API turned off… Settings → API…'
it('shows "Nothing found." on zero results')
it('Add is disabled for a file with no rights until a licence is typed')   // Review Focus 5
it('emits added with the credit, title and body after omekaImport resolves')
it('emits for the stop that was current when Add was pressed')  // stopId input changes mid-import; emitted stopId is the original (Review Focus 4)
it('a second Add press while importing does nothing')             // omekaImport called once (Review Focus 4)
it('emits nothing when omekaImport rejects, and shows the error')
it('More results asks for the next page and appends')
// outline-pane.spec.ts
it('Import from Omeka is disabled without a current stop')
it('an added event creates one overlay with body and credit, in one undo step, and selects it')
```

- [ ] **Step 2: Run** `npx ng test --watch=false`. Expected: the new specs FAIL.
- [ ] **Step 3: Implement the panel and the outline-pane wiring.**
- [ ] **Step 4: Run the full frontend suite, then `make build`.** Expected: PASS, and the build succeeds.
- [ ] **Step 5: Write the `docs/FOR-HISTORIANS.md` section.** Commit: `git commit -m "Import from Omeka panel in the editor"`

---

### After all tasks

- [ ] `make check` passes: lint, backend, frontend, build.
- [ ] Local live smoke test: `make serve`, open a tour, import item 2 (JPEG) and item 1 (MP3) from `https://omeka.madelynharrington.net`, then try item 3 (no Rights) and type a licence.
- [ ] Production steps 3–5 of the spec's live check happen after a deploy. Deploys are manual and the author runs them.
