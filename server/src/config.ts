// Конфигурация сервера из переменных окружения.
// Все обязательные поля валидируются заранее: сервер не стартует, если
// переменная пуста или значение привести к ожидаемому типу нельзя.
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export type MailConfig = {
  user: string | null;
  appPassword: string | null;
  from: string | null;
  devMailLog: boolean;
};

export type Config = {
  port: number;
  host: string;
  dbPath: string;
  allowedOrigins: string[];
  hmacSecret: string;
  systemKey: string;
  consentVersion: string;
  deletionContact: string;
  secureCookies: boolean;
  mail: MailConfig;
};

function readString(env: NodeJS.ProcessEnv, name: string): string | null {
  const value = env[name];
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function readBoolean(env: NodeJS.ProcessEnv, name: string): boolean {
  const value = env[name];
  if (typeof value !== 'string') return false;
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true';
}

function readNumber(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const value = env[name];
  if (typeof value !== 'string' || value.trim().length === 0) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return parsed;
}

function readOrigins(env: NodeJS.ProcessEnv): string[] {
  const raw = env.ALLOWED_ORIGINS;
  if (typeof raw !== 'string' || raw.trim().length === 0) return [];
  return raw
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function ensureDir(dbPath: string): void {
  const absolute = resolve(dbPath);
  const dir = dirname(absolute);
  mkdirSync(dir, { recursive: true });
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const hmacSecret = readString(env, 'MYBOOKING_HMAC_SECRET');
  if (!hmacSecret) throw new Error('MYBOOKING_HMAC_SECRET is required');

  const systemKey = readString(env, 'MYBOOKING_SYSTEM_KEY');
  if (!systemKey) throw new Error('MYBOOKING_SYSTEM_KEY is required');

  const deletionContact = readString(env, 'MYBOOKING_DELETION_CONTACT');
  if (!deletionContact) throw new Error('MYBOOKING_DELETION_CONTACT is required');

  const allowedOrigins = readOrigins(env);
  if (allowedOrigins.length === 0) {
    throw new Error('ALLOWED_ORIGINS must contain at least one origin');
  }

  const dbPath = readString(env, 'MYBOOKING_DB_PATH') ?? './data/mybooking.db';
  try {
    ensureDir(dbPath);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`MYBOOKING_DB_PATH is not writable: ${reason}`, { cause: error });
  }

  const mailUser = readString(env, 'GMAIL_USER');
  const devMailLog = readBoolean(env, 'MYBOOKING_DEV_MAIL_LOG');
  if (!mailUser && !devMailLog) {
    throw new Error('set MYBOOKING_DEV_MAIL_LOG=1 or provide GMAIL_USER');
  }

  return {
    port: readNumber(env, 'MYBOOKING_PORT', 3000),
    host: readString(env, 'MYBOOKING_HOST') ?? '127.0.0.1',
    dbPath,
    allowedOrigins,
    hmacSecret,
    systemKey,
    consentVersion: readString(env, 'MYBOOKING_CONSENT_VERSION') ?? '1',
    deletionContact,
    secureCookies: readBoolean(env, 'MYBOOKING_SECURE_COOKIES'),
    mail: {
      user: mailUser,
      appPassword: readString(env, 'GMAIL_APP_PASSWORD'),
      from: readString(env, 'MAIL_FROM'),
      devMailLog,
    },
  };
}
