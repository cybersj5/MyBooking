// Проверяем, что createExpertAuthApp собирается без ошибок и закрывается
// чисто: это базовый контракт для точки входа server/src/index.ts.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createExpertAuthApp } from '../src/auth/index.ts';
import { openDatabase } from '../src/repository.ts';

const directories: string[] = [];
const apps: Array<Awaited<ReturnType<typeof createExpertAuthApp>>> = [];

afterEach(async () => {
  while (apps.length > 0) await apps.pop()?.close();
  while (directories.length > 0) {
    const dir = directories.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function makeDatabase() {
  const dir = mkdtempSync(join(tmpdir(), 'mybooking-bootstrap-'));
  directories.push(dir);
  return openDatabase(join(dir, 'app.db'));
}

it('createExpertAuthApp поднимается и закрывается без ошибок', async () => {
  const database = makeDatabase();
  const app = await createExpertAuthApp({
    database,
    sendCode: async () => {},
    now: () => Date.parse('2026-10-05T00:00:00.000Z'),
    hmacSecret: 'test-only-hmac',
    allowedOrigin: 'http://127.0.0.1:5173',
    allowedOrigins: ['http://127.0.0.1:5173'],
    consentVersion: 'v1',
    deletionContact: 'owner@example.test',
  });
  apps.push(app);
  expect(typeof app.inject).toBe('function');
  expect(typeof app.close).toBe('function');
  database.close();
});
