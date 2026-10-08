import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from '@playwright/test';

const systemChromium = '/usr/bin/chromium';
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
  ?? (existsSync(systemChromium) ? systemChromium : undefined);

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 120_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:5173',
    headless: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions: { executablePath, args: process.env.PLAYWRIGHT_NO_PROXY === '1' ? ['--no-proxy-server'] : [] },
  },
  webServer: process.env.PLAYWRIGHT_BASE_URL ? undefined : {
    command: 'npm run dev',
    url: 'http://127.0.0.1:5173',
    timeout: 60_000,
    reuseExistingServer: process.env.PLAYWRIGHT_REUSE_SERVER === '1',
    env: { NODE_ENV: 'test', DATABASE_PATH: process.env.PLAYWRIGHT_DATABASE_PATH ?? join(tmpdir(), `experiment-browser-${randomUUID()}.sqlite`) },
  },
});
