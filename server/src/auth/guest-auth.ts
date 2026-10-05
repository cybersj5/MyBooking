import { createHmac, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  consumeChallenge,
  consumeGuestProof,
  createGuestProof,
  failChallenge,
  findBooking,
  findExpertByPublicId,
  findGuestProof,
  getGuestChallenge,
  guestChallengeLimits,
  hasGuestAccess,
  immediate,
  insertGuestChallenge,
  invalidateChallenge,
  replaceGuestAccess,
  replaceGuestChallenges,
  type AuthDatabase,
} from '../repository.js';

const codeLifetime = 10 * 60_000;
const accessLifetime = 30 * 24 * 60 * 60_000;
const hour = 60 * 60_000;

export type GuestAuthOptions = {
  database: AuthDatabase;
  sendCode: (message: { to: string; code: string }) => Promise<void>;
  now: () => number;
  hmacSecret: string;
  consentVersion: string;
};

type Failure =
  'consent_outdated' | 'rate_limited' | 'mail_unavailable' | 'invalid_challenge' | 'not_found';
type Result<T> = { ok: true; value: T } | { ok: false; reason: Failure };

function digest(secret: string, purpose: string, value: string) {
  return createHmac('sha256', secret).update(purpose).update('\0').update(value).digest('hex');
}

function equals(left: string, right: string) {
  const a = Buffer.from(left, 'hex');
  const b = Buffer.from(right, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createGuestAuth(options: GuestAuthOptions) {
  const { database, hmacSecret, now } = options;

  async function issue(
    purpose: 'guest_booking' | 'booking_access',
    target: string,
    email: string,
    version: string,
    ip: string,
  ): Promise<Result<{ id: string; expiresAt: string }>> {
    if (version !== options.consentVersion) return { ok: false, reason: 'consent_outdated' };
    const at = now();
    const id = randomUUID();
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const ipHash = digest(hmacSecret, 'ip', ip);
    const result = immediate(database, () => {
      const limits = guestChallengeLimits(database, email, ipHash, at - hour);
      if (
        (limits.recentEmail !== undefined && at - limits.recentEmail < 60_000) ||
        limits.emailHour >= 5 ||
        limits.ipHour >= 20
      )
        return 'rate_limited' as const;
      const expert =
        purpose === 'guest_booking' ? findExpertByPublicId(database, target) : undefined;
      if (purpose === 'guest_booking' && !expert) return 'not_found' as const;
      const booking = purpose === 'booking_access' ? findBooking(database, target) : undefined;
      const matchingBooking = booking?.guestEmail === email ? booking : undefined;
      replaceGuestChallenges(database, purpose, email, at);
      insertGuestChallenge(database, {
        id,
        purpose,
        email,
        ipHash,
        codeHash: digest(hmacSecret, `code:${id}`, code),
        expertId: expert?.id,
        bookingId: matchingBooking?.id,
        now: at,
        expiresAt: at + codeLifetime,
        consentVersion: version,
      });
      return purpose === 'booking_access' && !matchingBooking
        ? ('decoy' as const)
        : ('created' as const);
    });
    if (result === 'rate_limited' || result === 'not_found') return { ok: false, reason: result };
    if (result === 'created') {
      try {
        await options.sendCode({ to: email, code });
      } catch {
        immediate(database, () => invalidateChallenge(database, id, now()));
        if (purpose === 'guest_booking') return { ok: false, reason: 'mail_unavailable' };
      }
    }
    return { ok: true, value: { id, expiresAt: new Date(at + codeLifetime).toISOString() } };
  }

  function verify(
    purpose: 'guest_booking' | 'booking_access',
    target: string,
    id: string,
    code: string,
  ): Result<{ token: string; expiresAt: string }> {
    const at = now();
    const token = randomBytes(32).toString('hex');
    const value = immediate(database, () => {
      const challenge = getGuestChallenge(database, id, purpose);
      if (
        !challenge ||
        challenge.consumedAt !== null ||
        challenge.replacedAt !== null ||
        challenge.expiresAt <= at ||
        challenge.attempts >= 5
      )
        return undefined;
      const expert =
        purpose === 'guest_booking' ? findExpertByPublicId(database, target) : undefined;
      if (purpose === 'guest_booking' && (!expert || challenge.expertId !== expert.id))
        return undefined;
      if (purpose === 'booking_access' && challenge.bookingId !== target) return undefined;
      if (!equals(challenge.codeHash, digest(hmacSecret, `code:${id}`, code))) {
        failChallenge(database, id);
        return undefined;
      }
      consumeChallenge(database, id, at);
      if (purpose === 'guest_booking' && challenge.expertId) {
        createGuestProof(database, {
          id: randomUUID(),
          expertId: challenge.expertId,
          email: challenge.email,
          tokenHash: digest(hmacSecret, 'guest-proof', token),
          now: at,
          expiresAt: at + codeLifetime,
        });
        return at + codeLifetime;
      }
      if (purpose === 'booking_access' && challenge.bookingId) {
        replaceGuestAccess(database, {
          id: randomUUID(),
          bookingId: challenge.bookingId,
          tokenHash: digest(hmacSecret, 'guest-access', token),
          now: at,
          expiresAt: at + accessLifetime,
        });
        return at + accessLifetime;
      }
      return undefined;
    });
    if (!value) return { ok: false, reason: 'invalid_challenge' };
    return { ok: true, value: { token, expiresAt: new Date(value).toISOString() } };
  }

  function resolveGuestProof(proof: string, publicId: string) {
    if (!/^[a-f0-9]{64}$/.test(proof)) return { ok: false as const };
    const expert = findExpertByPublicId(database, publicId);
    if (!expert) return { ok: false as const };
    const record = findGuestProof(
      database,
      digest(hmacSecret, 'guest-proof', proof),
      expert.id,
      now(),
    );
    if (!record || record.email === expert.email) return { ok: false as const };
    return { ok: true as const, value: { email: record.email, proofId: record.id } };
  }

  function consumeProof(proofId: string) {
    consumeGuestProof(database, proofId, now());
  }
  function createBookingAccess(bookingId: string, verifiedEmail: string) {
    if (!database.inTransaction) throw new Error('Booking access requires an active transaction');
    const booking = findBooking(database, bookingId);
    if (!booking || booking.guestEmail !== verifiedEmail.trim().toLowerCase())
      throw new Error('Booking and verified email do not match');
    const at = now();
    const token = randomBytes(32).toString('hex');
    replaceGuestAccess(database, {
      id: randomUUID(),
      bookingId,
      tokenHash: digest(hmacSecret, 'guest-access', token),
      now: at,
      expiresAt: at + accessLifetime,
    });
    return { token, expiresAt: new Date(at + accessLifetime).toISOString() };
  }
  function canReadBooking(bookingId: string, token: string) {
    return (
      /^[a-f0-9]{64}$/.test(token) &&
      hasGuestAccess(database, bookingId, digest(hmacSecret, 'guest-access', token), now())
    );
  }
  return { issue, verify, resolveGuestProof, consumeProof, createBookingAccess, canReadBooking };
}
