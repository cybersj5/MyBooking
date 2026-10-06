import { createHmac, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { createGuestAuth } from './guest-auth.js';
import {
  challengeLimits,
  consumeChallenge,
  createExpert,
  createExpertSession,
  failChallenge,
  findActiveSession,
  findExpertByEmail,
  findExpertById,
  getChallenge,
  immediate,
  insertChallenge,
  invalidateChallenge,
  recordExpertConsent,
  replaceChallenges,
  revokeSession,
  updateExpertProfile,
  type AuthDatabase,
  type ExpertRow,
} from '../repository.js';

const challengeLifetime = 10 * 60_000;
const sessionLifetime = 30 * 24 * 60 * 60_000;
const hour = 60 * 60_000;

export type ExpertAuthOptions = {
  database: AuthDatabase;
  sendCode: (message: { to: string; code: string }) => Promise<void>;
  now: () => number;
  hmacSecret: string;
  allowedOrigin: string;
  consentVersion: string;
  secureCookies?: boolean;
};

export type AuthFailure =
  'consent_outdated' | 'rate_limited' | 'mail_unavailable' | 'invalid_challenge';
type Result<T> = { ok: true; value: T } | { ok: false; reason: AuthFailure };

function digest(secret: string, purpose: string, value: string) {
  return createHmac('sha256', secret).update(purpose).update('\0').update(value).digest('hex');
}

function hashEquals(left: string, right: string) {
  const leftBuffer = Buffer.from(left, 'hex');
  const rightBuffer = Buffer.from(right, 'hex');
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function profileComplete(expert: ExpertRow) {
  return expert.name !== null && expert.timezone !== null;
}

function safeProfile(expert: ExpertRow) {
  return { ...expert, profileComplete: profileComplete(expert) };
}

function validTimezone(value: string) {
  if (!/^[A-Za-z]/.test(value)) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export function createExpertAuth(options: ExpertAuthOptions) {
  const { database, now, hmacSecret, consentVersion } = options;
  const guest = createGuestAuth(options);

  async function requestChallenge(
    email: string,
    acceptedVersion: string,
    ip: string,
  ): Promise<Result<{ challengeId: string; expiresAt: string }>> {
    if (acceptedVersion !== consentVersion) return { ok: false, reason: 'consent_outdated' };
    const at = now();
    const ipHash = digest(hmacSecret, 'ip', ip);
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const id = randomUUID();
    const codeHash = digest(hmacSecret, `code:${id}`, code);
    const limited = immediate(database, () => {
      const limits = challengeLimits(database, email, ipHash, at - hour);
      if (
        (limits.recentEmail !== undefined && at - limits.recentEmail < 60_000) ||
        limits.emailHour >= 5 ||
        limits.ipHour >= 20
      )
        return true;
      replaceChallenges(database, email, at);
      insertChallenge(database, {
        id,
        email,
        ipHash,
        codeHash,
        now: at,
        expiresAt: at + challengeLifetime,
        consentVersion: acceptedVersion,
        consentAcceptedAt: at,
      });
      return false;
    });
    if (limited) return { ok: false, reason: 'rate_limited' };
    try {
      await options.sendCode({ to: email, code });
    } catch {
      immediate(database, () => invalidateChallenge(database, id, now()));
      return { ok: false, reason: 'mail_unavailable' };
    }
    return {
      ok: true,
      value: { challengeId: id, expiresAt: new Date(at + challengeLifetime).toISOString() },
    };
  }

  function verifyChallenge(
    id: string,
    code: string,
  ): Result<{ token: string; csrfToken: string; profileComplete: boolean }> {
    const token = randomBytes(32).toString('hex');
    const at = now();
    const expert = immediate(database, () => {
      const challenge = getChallenge(database, id);
      if (
        !challenge ||
        challenge.consumedAt !== null ||
        challenge.replacedAt !== null ||
        challenge.expiresAt <= at ||
        challenge.attempts >= 5 ||
        !challenge.consentVersion ||
        challenge.consentAcceptedAt === null
      )
        return undefined;
      const submittedHash = digest(hmacSecret, `code:${challenge.id}`, code);
      if (!hashEquals(challenge.codeHash, submittedHash)) {
        failChallenge(database, challenge.id);
        return undefined;
      }
      consumeChallenge(database, challenge.id, at);
      let owner = findExpertByEmail(database, challenge.email);
      if (!owner) {
        const expertId = randomUUID();
        createExpert(database, {
          id: expertId,
          email: challenge.email,
          publicId: randomBytes(12).toString('hex'),
          now: at,
        });
        owner = findExpertById(database, expertId);
      }
      if (!owner) throw new Error('Expert creation failed');
      recordExpertConsent(database, {
        id: randomUUID(),
        expertId: owner.id,
        version: challenge.consentVersion,
        now: challenge.consentAcceptedAt,
      });
      createExpertSession(database, {
        id: randomUUID(),
        expertId: owner.id,
        tokenHash: digest(hmacSecret, 'session', token),
        now: at,
        expiresAt: at + sessionLifetime,
      });
      return owner;
    });
    if (!expert) return { ok: false, reason: 'invalid_challenge' };
    return {
      ok: true,
      value: {
        token,
        csrfToken: digest(hmacSecret, 'csrf', token),
        profileComplete: profileComplete(expert),
      },
    };
  }

  function currentSession(token: string | undefined) {
    if (!token || !/^[a-f0-9]{64}$/.test(token)) return undefined;
    const session = findActiveSession(database, digest(hmacSecret, 'session', token), now());
    if (!session) return undefined;
    const expert = findExpertById(database, session.expertId);
    if (!expert) return undefined;
    return { sessionId: session.id, expert, csrfToken: digest(hmacSecret, 'csrf', token) };
  }

  function getProfile(expert: ExpertRow, csrfToken: string) {
    return { ...safeProfile(expert), csrfToken };
  }

  function updateProfile(expertId: string, name: string, timezone: string) {
    if (!validTimezone(timezone)) return undefined;
    immediate(database, () => updateExpertProfile(database, expertId, name, timezone));
    const expert = findExpertById(database, expertId);
    return expert && safeProfile(expert);
  }

  function logout(sessionId: string) {
    immediate(database, () => revokeSession(database, sessionId, now()));
  }

  return {
    requestChallenge,
    verifyChallenge,
    currentSession,
    getProfile,
    updateProfile,
    logout,
    resolveGuestProof: guest.resolveGuestProof,
  };
}

export const expertSessionMaxAgeSeconds = sessionLifetime / 1000;
