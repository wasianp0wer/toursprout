# Toolchain is pinned explicitly: the ambient `node` is v25, which Angular 22
# rejects, and the fnm shim only initialises in interactive shells.
NODE_BIN := /Users/maddiepersonal/.local/share/fnm/node-versions/v24.21.0/installation/bin
export PATH := $(NODE_BIN):$(PATH)
export UV_CACHE_DIR := $(CURDIR)/.uv-cache
export npm_config_cache := $(CURDIR)/.npm-cache
export PLAYWRIGHT_BROWSERS_PATH := $(CURDIR)/.playwright

.PHONY: check backend-test frontend-test lint build serve content e2e clean

## Everything that can run in this sandbox.
check: lint backend-test frontend-test build

backend-test:
	cd backend && uv run pytest -q

frontend-test:
	cd frontend && npx ng test --watch=false

lint:
	cd backend && uv run ruff check app tests ../content/scripts

build:
	cd frontend && npx ng build

## Serve the API and, if built, the frontend at http://localhost:8000
serve: build
	cd backend && uv run uvicorn app.main:app --port 8000 --reload

## Regenerate tour content: panoramas, archival images, narration, tour JSON.
content:
	@echo "content: regenerates fairfax-old-town.json from stops.json; hand-edits to the JSON (e.g. de48b0d's rephoto alignment) are NOT read back and will be overwritten."
	cd backend && uv run python ../content/scripts/probe_coverage.py
	cd backend && uv run python ../content/scripts/fetch_media.py
	cd backend && uv run python ../content/scripts/fetch_rephotos.py
	cd backend && uv run python ../content/scripts/make_narration.py
	cd backend && uv run python ../content/scripts/build_tour.py

## Browser end-to-end tests. Requires running OUTSIDE the Claude Code sandbox:
## Chromium cannot register Mach ports under it. See docs/ENVIRONMENT.md.
e2e: build
	cd frontend && npx playwright test

clean:
	rm -rf frontend/dist backend/tours.db test-results playwright-report
