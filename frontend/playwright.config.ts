import { defineConfig, devices } from '@playwright/test';
import * as path from 'node:path';

const REPO = path.resolve(__dirname, '..');

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],

  // Chromium cannot start under the macOS sandbox used here: it requires Mach
  // port registration, which the sandbox denies (bootstrap_check_in, EPERM
  // 1100). Firefox does not. See docs/ENVIRONMENT.md.
  projects: [{ name: 'firefox', use: { ...devices['Desktop Firefox'] } }],

  use: {
    baseURL: 'http://localhost:8000',
    trace: 'retain-on-failure',
    video: 'off',
  },

  // One server, not two. FastAPI serves the built Angular bundle, so there is
  // no dev-server file watcher (which exhausts the file-descriptor limit here)
  // and no proxy hop. Run `ng build` before this.
  webServer: {
    command: 'uv run uvicorn app.main:app --port 8000',
    cwd: path.join(REPO, 'backend'),
    url: 'http://localhost:8000/api/health',
    reuseExistingServer: true,
    timeout: 120_000,
    env: { UV_CACHE_DIR: path.join(REPO, '.uv-cache') },
  },
});
