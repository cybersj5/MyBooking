import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createExpertAuthApp } from '../src/auth/index.ts';
import { createExpertAuth } from '../src/auth/expert-auth.ts';
import { createGuestAuth } from '../src/auth/guest-auth.ts';
import { openDatabase } from '../src/repository.ts';
import { immediate } from '../src/repository.ts';

const origin = 'http://localhost:5173';
const consentVersion = 'v1';
const fixtures: Array<{
  app: Awaited<ReturnType<typeof createExpertAuthApp>>;
  database: ReturnType<typeof openDatabase>;
  directory: string;
}> = [];

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await fixture.app.close();
    fixture.database.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

it('proves a guest email for one expert without creating an expert account', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'mybooking-guest-auth-'));
  const database = openDatabase(join(directory, 'test.sqlite'));
  const sent: Array<{ to: string; code: string }> = [];
  const app = await createExpertAuthApp({
    database,
    sendCode: async (message) => {
      sent.push(message);
    },
    now: () => Date.parse('2026-10-05T00:00:00.000Z'),
    hmacSecret: 'test-only-hmac-secret',
    allowedOrigin: origin,
    consentVersion,
  });
  fixtures.push({ app, database, directory });

  const expertChallenge = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/expert/challenges',
    headers: { origin },
    payload: { email: 'expert@example.test', consentVersion, consentAccepted: true },
  });
  expect(expertChallenge.statusCode).toBe(202);
  const expertVerification = await app.inject({
    method: 'POST',
    url: `/api/v1/auth/expert/challenges/${expertChallenge.json().challengeId}/verify`,
    headers: { origin },
    payload: { code: sent.at(-1)?.code },
  });
  expect(expertVerification.statusCode).toBe(200);
  const cookie = String(expertVerification.headers['set-cookie']).split(';')[0];
  const profile = await app.inject({ method: 'GET', url: '/api/v1/me', headers: { cookie } });
  const publicId = profile.json().publicId as string;
  const expertCountBefore = database.prepare('SELECT COUNT(*) AS count FROM experts').get() as {
    count: number;
  };

  const challenge = await app.inject({
    method: 'POST',
    url: `/api/v1/experts/${publicId}/guest-challenges`,
    headers: { origin },
    payload: { email: '  GUEST+Tag@Example.Test  ', consentVersion, consentAccepted: true },
  });
  expect(challenge.statusCode).toBe(202);
  expect(challenge.json()).toEqual({
    challengeId: expect.any(String),
    expiresAt: expect.any(String),
  });
  expect(sent.at(-1)?.to).toBe('guest+tag@example.test');
  expect(challenge.body).not.toContain(sent.at(-1)?.code);

  const verified = await app.inject({
    method: 'POST',
    url: `/api/v1/experts/${publicId}/guest-challenges/${challenge.json().challengeId}/verify`,
    headers: { origin },
    payload: { code: sent.at(-1)?.code },
  });
  expect(verified.statusCode).toBe(200);
  expect(verified.json()).toEqual({
    guestProof: expect.any(String),
    expiresAt: expect.any(String),
  });
  expect(verified.body).not.toContain(sent.at(-1)?.code);
  const expertCountAfter = database.prepare('SELECT COUNT(*) AS count FROM experts').get() as {
    count: number;
  };
  expect(expertCountAfter.count).toBe(expertCountBefore.count);
}, 30_000);

it('binds guest proof to one expert and rejects self booking before consuming proof', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'mybooking-guest-proof-'));
  const database = openDatabase(join(directory, 'test.sqlite'));
  let now = Date.parse('2026-10-05T00:00:00.000Z');
  const sent: Array<{ to: string; code: string }> = [];
  const options = {
    database,
    sendCode: async (message: { to: string; code: string }) => {
      sent.push(message);
    },
    now: () => now,
    hmacSecret: 'test-only-hmac-secret',
    allowedOrigin: origin,
    consentVersion,
  };
  const app = await createExpertAuthApp(options);
  fixtures.push({ app, database, directory });
  const insertExpert = database.prepare(
    'INSERT INTO experts (id,email,publicId,name,timezone,createdAt) VALUES (?,?,?,?,?,?)',
  );
  insertExpert.run('expert-1', 'self@example.test', 'self-public', 'Первый', 'UTC', now);
  insertExpert.run('expert-2', 'other@example.test', 'other-public', 'Второй', 'UTC', now);
  const challenge = await app.inject({
    method: 'POST',
    url: '/api/v1/experts/self-public/guest-challenges',
    headers: { origin },
    payload: { email: ' SELF@EXAMPLE.TEST ', consentVersion, consentAccepted: true },
  });
  expect(challenge.statusCode).toBe(202);
  const verified = await app.inject({
    method: 'POST',
    url: `/api/v1/experts/self-public/guest-challenges/${challenge.json().challengeId}/verify`,
    headers: { origin },
    payload: { code: sent[0].code },
  });
  expect(verified.statusCode).toBe(200);
  const guestProof = verified.json().guestProof as string;
  const identity = createExpertAuth(options) as ReturnType<typeof createExpertAuth> & {
    resolveGuestProof: (
      proof: string,
      publicId: string,
    ) => { ok: boolean; value?: { email: string } };
  };
  expect(identity.resolveGuestProof(guestProof, 'other-public').ok).toBe(false);
  expect(identity.resolveGuestProof(guestProof, 'self-public').ok).toBe(false);
  now += 10 * 60_000;
  expect(identity.resolveGuestProof(guestProof, 'self-public').ok).toBe(false);
}, 30_000);

it('limits restored access to one booking and rejects its token after expiry', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'mybooking-guest-access-'));
  const database = openDatabase(join(directory, 'test.sqlite'));
  const sent: Array<{ to: string; code: string }> = [];
  let now = Date.parse('2026-10-05T00:00:00.000Z');
  const app = await createExpertAuthApp({
    database,
    sendCode: async (message) => {
      sent.push(message);
    },
    now: () => now,
    hmacSecret: 'test-only-hmac-secret',
    allowedOrigin: origin,
    consentVersion,
  });
  fixtures.push({ app, database, directory });
  database
    .prepare('INSERT INTO experts (id,email,publicId,name,timezone,createdAt) VALUES (?,?,?,?,?,?)')
    .run('expert-1', 'expert@example.test', 'public-expert', 'Эксперт', 'UTC', now);
  const insertBooking = database.prepare(
    'INSERT INTO bookings (id,expertId,guestEmail,guestName,guestTimezone,startUtc,endUtc,subject,status,version,createdAt) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
  );
  insertBooking.run(
    'booking-1',
    'expert-1',
    'guest@example.test',
    'Гость',
    'UTC',
    now + 86_400_000,
    now + 90_000_000,
    'Встреча 1',
    'pending',
    1,
    now,
  );
  insertBooking.run(
    'booking-2',
    'expert-1',
    'other@example.test',
    'Другой',
    'UTC',
    now + 172_800_000,
    now + 176_400_000,
    'Встреча 2',
    'pending',
    1,
    now,
  );

  const request = (bookingId: string, email: string) =>
    app.inject({
      method: 'POST',
      url: `/api/v1/bookings/${bookingId}/access-challenges`,
      headers: { origin },
      payload: { email, consentVersion, consentAccepted: true },
    });
  const accepted = await request('booking-1', ' GUEST@EXAMPLE.TEST ');
  expect(accepted.statusCode).toBe(202);
  const limitedExisting = await request('booking-1', 'guest@example.test');
  const limitedAbsent = await request('missing-booking', 'guest@example.test');
  expect(limitedExisting.statusCode).toBe(429);
  expect(limitedAbsent.statusCode).toBe(429);
  expect(limitedAbsent.json()).toEqual(limitedExisting.json());
  const absent = await request('missing-booking', 'absent@example.test');
  expect(absent.statusCode).toBe(202);
  expect(absent.json()).toEqual({ requestId: expect.any(String) });
  expect(sent).toHaveLength(1);
  expect(sent[0].to).toBe('guest@example.test');

  const verified = await app.inject({
    method: 'POST',
    url: `/api/v1/bookings/booking-1/access-challenges/${accepted.json().requestId}/verify`,
    headers: { origin },
    payload: { code: sent[0].code },
  });
  expect(verified.statusCode).toBe(200);
  const accessToken = verified.json().accessToken as string;
  expect(accessToken).toEqual(expect.any(String));
  const own = await app.inject({
    method: 'GET',
    url: '/api/v1/bookings/booking-1',
    headers: { authorization: `Bearer ${accessToken}` },
  });
  expect(own.statusCode).toBe(200);
  expect(own.json()).toMatchObject({ id: 'booking-1', topic: 'Встреча 1' });
  expect(own.body).not.toContain('guest@example.test');
  const foreign = await app.inject({
    method: 'GET',
    url: '/api/v1/bookings/booking-2',
    headers: { authorization: `Bearer ${accessToken}` },
  });
  expect(foreign.statusCode).toBe(404);
  const missing = await app.inject({
    method: 'GET',
    url: '/api/v1/bookings/missing-booking',
    headers: { authorization: `Bearer ${accessToken}` },
  });
  expect(missing.statusCode).toBe(404);
  expect(missing.json()).toEqual(foreign.json());
  const byEmail = await app.inject({
    method: 'GET',
    url: '/api/v1/bookings/booking-1?email=guest@example.test',
  });
  expect(byEmail.statusCode).not.toBe(200);
  now += 60_000;
  const replacementRequest = await request('booking-1', 'guest@example.test');
  expect(replacementRequest.statusCode).toBe(202);
  const replacement = await app.inject({
    method: 'POST',
    url: `/api/v1/bookings/booking-1/access-challenges/${replacementRequest.json().requestId}/verify`,
    headers: { origin },
    payload: { code: sent.at(-1)?.code },
  });
  expect(replacement.statusCode).toBe(200);
  const revoked = await app.inject({
    method: 'GET',
    url: '/api/v1/bookings/booking-1',
    headers: { authorization: `Bearer ${accessToken}` },
  });
  expect(revoked.statusCode).not.toBe(200);
  const newToken = replacement.json().accessToken as string;
  const renewed = await app.inject({
    method: 'GET',
    url: '/api/v1/bookings/booking-1',
    headers: { authorization: `Bearer ${newToken}` },
  });
  expect(renewed.statusCode).toBe(200);
  now += 30 * 86_400_000;
  const expired = await app.inject({
    method: 'GET',
    url: '/api/v1/bookings/booking-1',
    headers: { authorization: `Bearer ${newToken}` },
  });
  expect(expired.statusCode).not.toBe(200);
}, 30_000);

it('denies an incomplete expert access to their booking', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'mybooking-incomplete-expert-'));
  const database = openDatabase(join(directory, 'test.sqlite'));
  const sent: Array<{ to: string; code: string }> = [];
  const now = Date.parse('2026-10-05T00:00:00.000Z');
  const app = await createExpertAuthApp({
    database,
    sendCode: async (message) => {
      sent.push(message);
    },
    now: () => now,
    hmacSecret: 'test-only-hmac-secret',
    allowedOrigin: origin,
    consentVersion,
  });
  fixtures.push({ app, database, directory });
  const challenge = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/expert/challenges',
    headers: { origin },
    payload: { email: 'incomplete@example.test', consentVersion, consentAccepted: true },
  });
  expect(challenge.statusCode).toBe(202);
  const verified = await app.inject({
    method: 'POST',
    url: `/api/v1/auth/expert/challenges/${challenge.json().challengeId}/verify`,
    headers: { origin },
    payload: { code: sent[0].code },
  });
  expect(verified.statusCode).toBe(200);
  const cookie = String(verified.headers['set-cookie']).split(';')[0];
  const profile = await app.inject({ method: 'GET', url: '/api/v1/me', headers: { cookie } });
  expect(profile.json().profileComplete).toBe(false);
  database
    .prepare(
      'INSERT INTO bookings (id,expertId,guestEmail,guestName,guestTimezone,startUtc,endUtc,subject,status,version,createdAt) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    )
    .run(
      'incomplete-booking',
      profile.json().id,
      'guest@example.test',
      'Гость',
      'UTC',
      now + 86_400_000,
      now + 90_000_000,
      'Встреча',
      'pending',
      1,
      now,
    );

  const booking = await app.inject({
    method: 'GET',
    url: '/api/v1/bookings/incomplete-booking',
    headers: { cookie },
  });
  expect(booking.statusCode).toBe(403);
  expect(booking.json().code).toBe('profile_incomplete');
}, 30_000);

it('creates initial access for one new booking inside its transaction', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'mybooking-initial-access-'));
  const database = openDatabase(join(directory, 'test.sqlite'));
  const now = Date.parse('2026-10-05T00:00:00.000Z');
  const options = {
    database,
    sendCode: async () => {},
    now: () => now,
    hmacSecret: 'test-only-hmac-secret',
    allowedOrigin: origin,
    consentVersion,
  };
  const app = await createExpertAuthApp(options);
  fixtures.push({ app, database, directory });
  database
    .prepare('INSERT INTO experts (id,email,publicId,name,timezone,createdAt) VALUES (?,?,?,?,?,?)')
    .run('expert-1', 'expert@example.test', 'public-expert', 'Эксперт', 'UTC', now);
  const guest = createGuestAuth(options) as ReturnType<typeof createGuestAuth> & {
    createBookingAccess: (
      bookingId: string,
      verifiedEmail: string,
    ) => { token: string; expiresAt: string };
  };
  const access = immediate(database, () => {
    database
      .prepare(
        'INSERT INTO bookings (id,expertId,guestEmail,guestName,guestTimezone,startUtc,endUtc,subject,status,version,createdAt) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      )
      .run(
        'new-booking',
        'expert-1',
        'guest@example.test',
        'Гость',
        'UTC',
        now + 86_400_000,
        now + 90_000_000,
        'Встреча',
        'pending',
        1,
        now,
      );
    return guest.createBookingAccess('new-booking', 'guest@example.test');
  });
  expect(access.token).toEqual(expect.any(String));
  const stored = database
    .prepare('SELECT tokenHash FROM guest_access WHERE bookingId = ?')
    .get('new-booking') as { tokenHash: string } | undefined;
  expect(stored).toBeDefined();
  expect(stored?.tokenHash).not.toBe(access.token);
  const own = await app.inject({
    method: 'GET',
    url: '/api/v1/bookings/new-booking',
    headers: { authorization: `Bearer ${access.token}` },
  });
  expect(own.statusCode).toBe(200);
  const foreign = await app.inject({
    method: 'GET',
    url: '/api/v1/bookings/other-booking',
    headers: { authorization: `Bearer ${access.token}` },
  });
  expect(foreign.statusCode).toBe(404);
}, 30_000);
