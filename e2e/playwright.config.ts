import { defineConfig } from '@playwright/test';
import { resolve } from 'node:path';

const baseURL = 'http://127.0.0.1:4173';

export default defineConfig({
  testDir: './src',
  projects: [
    { name: 'desktop', use: { viewport: { width: 1280, height: 800 } } },
    { name: 'phone', use: { viewport: { width: 390, height: 844 }, isMobile: true } },
  ],
  use: {
    baseURL,
    browserName: 'chromium',
    channel: process.env.PLAYWRIGHT_BROWSER_CHANNEL,
    colorScheme: 'light',
  },
  webServer: {
    command:
      'npm exec --workspace @mybooking/web -- vite --host 127.0.0.1 --port 4173 --strictPort',
    cwd: resolve(import.meta.dirname, '..'),
    url: baseURL,
    reuseExistingServer: false,
  },
});
