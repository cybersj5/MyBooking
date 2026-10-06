import Fastify from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { registerPrivacyRoutes } from '../src/privacy/index.ts';

const apps: Array<ReturnType<typeof Fastify>> = [];

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});

it('publishes the current consent and necessary cookie notice without a session', async () => {
  const app = Fastify({ logger: false });
  apps.push(app);
  registerPrivacyRoutes(app, {
    consentVersion: 'v1',
    deletionContact: 'owner@example.test',
  });

  const response = await app.inject({ method: 'GET', url: '/api/v1/privacy' });

  expect(response.statusCode).toBe(200);
  expect(response.headers['set-cookie']).toBeUndefined();
  const body = response.json();
  expect(Object.keys(body).sort()).toEqual(
    ['consentVersion', 'summary', 'document', 'deletionContact', 'cookieNotice'].sort(),
  );
  expect(body.consentVersion).toBe('v1');
  expect(body.deletionContact).toBe('owner@example.test');
  expect(body.summary).toEqual(expect.any(String));
  expect(body.summary.length).toBeGreaterThan(0);
  expect(body.document).toEqual(expect.any(String));
  expect(body.document).toContain('owner@example.test');
  expect(body.document).toMatch(/данн|почт/i);
  expect(body.document).toMatch(/удал/i);
  expect(body.cookieNotice).toMatch(/необходим/i);
  expect(body.cookieNotice).toMatch(/сесси/i);
  expect(body.cookieNotice).toMatch(/30 дн/i);
  expect(body.cookieNotice).toMatch(/удал/i);
  expect(body.cookieNotice).toMatch(/необязательн.*нет/i);
});

it('refuses to register privacy without a configured deletion contact', async () => {
  const app = Fastify({ logger: false });
  apps.push(app);

  expect(() => registerPrivacyRoutes(app, { consentVersion: 'v1', deletionContact: '' })).toThrow();
  expect((await app.inject({ method: 'GET', url: '/api/v1/privacy' })).statusCode).toBe(404);
});

it('does not issue a guest code without current consent', async () => {
  const { createExpertAuthApp } = await import('../src/auth/index.ts');
  const { openDatabase } = await import('../src/repository.ts');
  const directory = mkdtempSync(join(tmpdir(), 'mybooking-privacy-guest-'));
  const database = openDatabase(join(directory, 'test.sqlite'));
  const sent: Array<{ to: string; code: string }> = [];
  const app = await createExpertAuthApp({
    database,
    sendCode: async (message) => {
      sent.push(message);
    },
    now: () => Date.parse('2026-10-05T00:00:00.000Z'),
    hmacSecret: 'test-only-hmac-secret',
    allowedOrigin: 'http://localhost:5173',
    consentVersion: 'v1',
    deletionContact: 'owner@example.test',
  });
  try {
    const request = (consent: Record<string, unknown>) =>
      app.inject({
        method: 'POST',
        url: '/api/v1/experts/public-id/guest-challenges',
        headers: { origin: 'http://localhost:5173' },
        payload: { email: 'guest@example.test', ...consent },
      });

    const unchecked = await request({ consentVersion: 'v1' });
    expect(unchecked.statusCode).toBe(400);
    expect(unchecked.json().code).toBe('invalid_input');

    const stale = await request({ consentVersion: 'v0', consentAccepted: true });
    expect(stale.statusCode).toBe(400);
    expect(stale.json().code).toBe('consent_outdated');

    expect(sent).toHaveLength(0);
    const challenges = database.prepare('SELECT COUNT(*) AS count FROM email_challenges').get() as {
      count: number;
    };
    expect(challenges.count).toBe(0);
  } finally {
    await app.close();
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

it('serves privacy from the main app and requires a deletion contact to start', async () => {
  const { createExpertAuthApp } = await import('../src/auth/index.ts');
  const { openDatabase } = await import('../src/repository.ts');
  const directory = mkdtempSync(join(tmpdir(), 'mybooking-privacy-app-'));
  const database = openDatabase(join(directory, 'test.sqlite'));
  const options = {
    database,
    sendCode: async () => {},
    now: () => Date.parse('2026-10-05T00:00:00.000Z'),
    hmacSecret: 'test-only-hmac-secret',
    allowedOrigin: 'http://localhost:5173',
    consentVersion: 'v1',
    deletionContact: 'owner@example.test',
  };
  let app: Awaited<ReturnType<typeof createExpertAuthApp>> | undefined;
  try {
    app = await createExpertAuthApp(options);
    const response = await app.inject({ method: 'GET', url: '/api/v1/privacy' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      consentVersion: 'v1',
      deletionContact: 'owner@example.test',
    });

    const missingContact = { ...options };
    Reflect.deleteProperty(missingContact, 'deletionContact');
    await expect(createExpertAuthApp(missingContact)).rejects.toThrow();
  } finally {
    await app?.close();
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
