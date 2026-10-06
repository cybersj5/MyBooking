import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createExpertAuthApp } from '../src/auth/index.ts';
import { openDatabase } from '../src/repository.ts';

const origin = 'http://localhost:5173';
const consentVersion = 'v1';
const start = Date.parse('2026-10-05T00:00:00.000Z');

type SentCode = { to: string; code: string };
type Fixture = Awaited<ReturnType<typeof createFixture>>;
const fixtures: Fixture[] = [];

async function createFixture() {
  const directory = mkdtempSync(join(tmpdir(), 'mybooking-auth-'));
  const database = openDatabase(join(directory, 'test.sqlite'));
  const sent: SentCode[] = [];
  const attempted: SentCode[] = [];
  let currentTime = start;
  let mailFailure = false;
  const createApp = (version: string) =>
    createExpertAuthApp({
      database,
      sendCode: async (message: SentCode) => {
        attempted.push(message);
        if (mailFailure) throw new Error('Simulated SMTP failure');
        sent.push(message);
      },
      now: () => currentTime,
      hmacSecret: 'test-only-hmac-secret',
      allowedOrigin: origin,
      consentVersion: version,
      deletionContact: 'owner@example.test',
    });
  const app = await createApp(consentVersion);
  const fixture = {
    app,
    database,
    directory,
    sent,
    attempted,
    advance(ms: number) {
      currentTime += ms;
    },
    failMail() {
      mailFailure = true;
    },
    async restartWithConsentVersion(version: string) {
      await this.app.close();
      this.app = await createApp(version);
    },
  };
  fixtures.push(fixture);
  return fixture;
}

async function requestCode(fixture: Fixture, email: string, ip = '192.0.2.1') {
  return fixture.app.inject({
    method: 'POST',
    url: '/api/v1/auth/expert/challenges',
    headers: { origin, 'x-forwarded-for': ip },
    remoteAddress: ip,
    payload: { email, consentVersion, consentAccepted: true },
  });
}

async function verifyCode(fixture: Fixture, challengeId: string, code: string) {
  return fixture.app.inject({
    method: 'POST',
    url: `/api/v1/auth/expert/challenges/${challengeId}/verify`,
    headers: { origin },
    payload: { code },
  });
}

function sessionCookie(response: { headers: Record<string, unknown> }) {
  const header = response.headers['set-cookie'];
  const cookie = Array.isArray(header) ? header[0] : header;
  expect(cookie).toContain('mybooking_session=');
  expect(cookie).toContain('HttpOnly');
  expect(cookie).toContain('SameSite=Lax');
  return String(cookie).split(';')[0];
}

async function login(fixture: Fixture, email: string, ip?: string) {
  const challenge = await requestCode(fixture, email, ip);
  expect(challenge.statusCode).toBe(202);
  const code = fixture.sent.at(-1)?.code;
  expect(code).toBeTruthy();
  const verified = await verifyCode(fixture, challenge.json().challengeId, code!);
  expect(verified.statusCode).toBe(200);
  return { cookie: sessionCookie(verified), csrfToken: verified.json().csrfToken };
}

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await fixture.app.close();
    fixture.database.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

describe('expert email sign-in over HTTP', () => {
  it('creates an incomplete expert after a code and lets only that session finish its profile', async () => {
    const fixture = await createFixture();
    const unauthenticated = await fixture.app.inject({ method: 'GET', url: '/api/v1/me' });
    expect(unauthenticated.statusCode).toBe(401);

    const first = await login(fixture, '  ONE@Example.Test  ');
    const mine = await fixture.app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { cookie: first.cookie },
    });
    expect(mine.statusCode).toBe(200);
    expect(mine.json()).toMatchObject({
      email: 'one@example.test',
      name: null,
      timezone: null,
      profileComplete: false,
    });
    expect(mine.json().publicId).toEqual(expect.any(String));

    const withoutCsrf = await fixture.app.inject({
      method: 'PUT',
      url: '/api/v1/me/profile',
      headers: { origin, cookie: first.cookie },
      payload: { name: 'Анна', timezone: 'Asia/Krasnoyarsk' },
    });
    expect(withoutCsrf.statusCode).not.toBe(200);

    const updated = await fixture.app.inject({
      method: 'PUT',
      url: '/api/v1/me/profile',
      headers: { origin, cookie: first.cookie, 'x-csrf-token': first.csrfToken },
      payload: { name: 'Анна', timezone: 'Asia/Krasnoyarsk' },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({
      name: 'Анна',
      timezone: 'Asia/Krasnoyarsk',
      profileComplete: true,
    });

    const second = await login(fixture, 'two@example.test', '192.0.2.2');
    const other = await fixture.app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { cookie: second.cookie },
    });
    expect(other.statusCode).toBe(200);
    expect(other.json().email).toBe('two@example.test');
    expect(other.json().id).not.toBe(mine.json().id);
    expect(other.json().publicId).not.toBe(mine.json().publicId);
    expect(other.body).not.toContain('Анна');
  });

  it('rejects a used or replaced challenge and exposes no code in HTTP responses', async () => {
    const fixture = await createFixture();
    const first = await requestCode(fixture, 'one@example.test');
    expect(first.statusCode).toBe(202);
    const firstCode = fixture.sent[0].code;
    expect(first.body).not.toContain(firstCode);
    fixture.advance(60_000);
    const second = await requestCode(fixture, 'one@example.test');
    expect(second.statusCode).toBe(202);
    const old = await verifyCode(fixture, first.json().challengeId, firstCode);
    expect(old.statusCode).toBe(400);
    expect(old.json().code).toBe('invalid_challenge');

    const newCode = fixture.sent[1].code;
    const verified = await verifyCode(fixture, second.json().challengeId, newCode);
    expect(verified.statusCode).toBe(200);
    expect(verified.body).not.toContain(newCode);
    const repeat = await verifyCode(fixture, second.json().challengeId, newCode);
    expect(repeat.statusCode).toBe(400);
    expect(repeat.json().code).toBe('invalid_challenge');
  });

  it('rejects expired codes and locks the challenge after the fifth wrong attempt', async () => {
    const fixture = await createFixture();
    const expiring = await requestCode(fixture, 'one@example.test');
    expect(expiring.statusCode).toBe(202);
    const firstCode = fixture.sent[0].code;
    fixture.advance(10 * 60_000);
    const expired = await verifyCode(fixture, expiring.json().challengeId, firstCode);
    expect(expired.statusCode).toBe(400);
    expect(expired.json().code).toBe('invalid_challenge');

    const limited = await requestCode(fixture, 'two@example.test');
    expect(limited.statusCode).toBe(202);
    const actualCode = fixture.sent[1].code;
    const wrongCode = actualCode === '000000' ? '999999' : '000000';
    for (let attempt = 0; attempt < 5; attempt++) {
      const wrong = await verifyCode(fixture, limited.json().challengeId, wrongCode);
      expect(wrong.statusCode).toBe(400);
      expect(wrong.json().code).toBe('invalid_challenge');
    }
    const exhausted = await verifyCode(fixture, limited.json().challengeId, actualCode);
    expect(exhausted.statusCode).toBe(400);
    expect(exhausted.json().code).toBe('invalid_challenge');
  });

  it('limits challenge requests by email and IP without revealing account existence', async () => {
    const fixture = await createFixture();
    const first = await requestCode(fixture, 'one@example.test');
    expect(first.statusCode).toBe(202);
    const tooSoon = await requestCode(fixture, 'one@example.test');
    expect(tooSoon.statusCode).toBe(429);
    expect(tooSoon.headers['retry-after']).toBeDefined();
    expect(fixture.sent).toHaveLength(1);

    for (let count = 1; count < 5; count++) {
      fixture.advance(60_000);
      expect((await requestCode(fixture, 'one@example.test')).statusCode).toBe(202);
    }
    fixture.advance(60_000);
    const hourly = await requestCode(fixture, 'one@example.test');
    expect(hourly.statusCode).toBe(429);
    expect(hourly.json().code).toBe('rate_limited');
    expect(fixture.sent).toHaveLength(5);

    const existingEmailLimit = hourly.json();
    for (let count = 0; count < 20; count++) {
      expect(
        (await requestCode(fixture, `ip-${count}@example.test`, '198.51.100.10')).statusCode,
      ).toBe(202);
    }
    const ipLimited = await requestCode(fixture, 'fresh@example.test', '198.51.100.10');
    expect(ipLimited.statusCode).toBe(429);
    expect(ipLimited.json().code).toBe(existingEmailLimit.code);
    expect(ipLimited.headers['retry-after']).toBeDefined();
  });

  it('expires sessions after 30 days and revokes them immediately on logout', async () => {
    const fixture = await createFixture();
    const first = await login(fixture, 'one@example.test');
    fixture.advance(30 * 24 * 60 * 60_000);
    const expired = await fixture.app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { cookie: first.cookie },
    });
    expect(expired.statusCode).toBe(401);

    const second = await login(fixture, 'two@example.test', '192.0.2.2');
    const logout = await fixture.app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: { origin, cookie: second.cookie, 'x-csrf-token': second.csrfToken },
    });
    expect(logout.statusCode).toBe(204);
    const revoked = await fixture.app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { cookie: second.cookie },
    });
    expect(revoked.statusCode).toBe(401);
  });

  it('rejects a challenge without accepted consent and never sends its code', async () => {
    const fixture = await createFixture();
    const denied = await fixture.app.inject({
      method: 'POST',
      url: '/api/v1/auth/expert/challenges',
      headers: { origin },
      payload: { email: 'one@example.test', consentVersion, consentAccepted: false },
    });
    expect(denied.statusCode).toBe(400);
    expect(fixture.sent).toHaveLength(0);
  });

  it('keeps the accepted consent version and time when the document changes before verification', async () => {
    const fixture = await createFixture();
    const requested = await requestCode(fixture, 'one@example.test');
    expect(requested.statusCode).toBe(202);
    const code = fixture.sent[0].code;

    fixture.advance(90_000);
    await fixture.restartWithConsentVersion('v2');
    const verified = await verifyCode(fixture, requested.json().challengeId, code);
    expect(verified.statusCode).toBe(200);
    const profile = await fixture.app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { cookie: sessionCookie(verified) },
    });
    expect(profile.statusCode).toBe(200);

    const consent = fixture.database
      .prepare('SELECT documentVersion, acceptedAt FROM consent_records WHERE expertId = ?')
      .get(profile.json().id) as { documentVersion: string; acceptedAt: number } | undefined;
    expect(consent).toMatchObject({ documentVersion: 'v1', acceptedAt: start });
  });

  it('returns 503 and invalidates a code when SMTP fails', async () => {
    const fixture = await createFixture();
    fixture.failMail();
    const failed = await requestCode(fixture, 'one@example.test');
    expect(failed.statusCode).toBe(503);
    expect(failed.json().code).toBe('mail_unavailable');
    expect(failed.body).not.toContain(fixture.attempted[0].code);
    expect(fixture.sent).toHaveLength(0);

    const challenge = fixture.database
      .prepare('SELECT id FROM email_challenges WHERE email = ?')
      .get('one@example.test') as { id: string } | undefined;
    expect(challenge).toBeDefined();
    const rejected = await verifyCode(fixture, challenge!.id, fixture.attempted[0].code);
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json().code).toBe('invalid_challenge');
  });

  it('preserves an existing expert profile on a new sign-in', async () => {
    const fixture = await createFixture();
    const first = await login(fixture, 'one@example.test');
    const updated = await fixture.app.inject({
      method: 'PUT',
      url: '/api/v1/me/profile',
      headers: { origin, cookie: first.cookie, 'x-csrf-token': first.csrfToken },
      payload: { name: 'Анна', timezone: 'Asia/Krasnoyarsk' },
    });
    expect(updated.statusCode).toBe(200);

    fixture.advance(60_000);
    const second = await login(fixture, 'ONE@example.test');
    const profile = await fixture.app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { cookie: second.cookie },
    });
    expect(profile.statusCode).toBe(200);
    expect(profile.json()).toMatchObject({
      id: updated.json().id,
      publicId: updated.json().publicId,
      name: 'Анна',
      timezone: 'Asia/Krasnoyarsk',
      profileComplete: true,
    });
  });

  it('rejects a foreign Origin before issuing a code or changing a profile', async () => {
    const fixture = await createFixture();
    const foreign = await fixture.app.inject({
      method: 'POST',
      url: '/api/v1/auth/expert/challenges',
      headers: { origin: 'http://evil.example.test' },
      payload: { email: 'one@example.test', consentVersion, consentAccepted: true },
    });
    expect(foreign.statusCode).toBe(403);
    expect(fixture.sent).toHaveLength(0);

    const session = await login(fixture, 'one@example.test');
    const profile = await fixture.app.inject({
      method: 'PUT',
      url: '/api/v1/me/profile',
      headers: {
        origin: 'http://evil.example.test',
        cookie: session.cookie,
        'x-csrf-token': session.csrfToken,
      },
      payload: { name: 'Чужое имя', timezone: 'UTC' },
    });
    expect(profile.statusCode).toBe(403);
    const mine = await fixture.app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { cookie: session.cookie },
    });
    expect(mine.json()).toMatchObject({ name: null, timezone: null });
  });

  it('accepts a valid IANA timezone outside the supportedValuesOf list', async () => {
    const fixture = await createFixture();
    const session = await login(fixture, 'one@example.test');
    const updated = await fixture.app.inject({
      method: 'PUT',
      url: '/api/v1/me/profile',
      headers: { origin, cookie: session.cookie, 'x-csrf-token': session.csrfToken },
      payload: { name: 'Анна', timezone: 'Etc/GMT+1' },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({ timezone: 'Etc/GMT+1', profileComplete: true });

    const updatedAlias = await fixture.app.inject({
      method: 'PUT',
      url: '/api/v1/me/profile',
      headers: { origin, cookie: session.cookie, 'x-csrf-token': session.csrfToken },
      payload: { name: 'Анна', timezone: 'CET' },
    });
    expect(updatedAlias.statusCode).toBe(200);
    expect(updatedAlias.json()).toMatchObject({ timezone: 'CET', profileComplete: true });
  });
});
