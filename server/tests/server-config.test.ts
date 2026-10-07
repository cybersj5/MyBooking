// Тесты для server/src/config.ts: парсинг env, значения по умолчанию
// и обязательные поля. Не подменяет process.env напрямую, чтобы не ломать
// другие тесты в параллельном запуске Vitest.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';

const directories: string[] = [];

function makeDbPath() {
  const dir = mkdtempSync(join(tmpdir(), 'mybooking-config-'));
  directories.push(dir);
  return join(dir, 'app.db');
}

function baseEnv(overrides: Record<string, string | undefined> = {}) {
  const dbPath = makeDbPath();
  return {
    MYBOOKING_HMAC_SECRET: 'test-hmac',
    MYBOOKING_SYSTEM_KEY: 'test-system',
    MYBOOKING_DELETION_CONTACT: 'owner@example.test',
    ALLOWED_ORIGINS: 'http://127.0.0.1:5173',
    MYBOOKING_DB_PATH: dbPath,
    MYBOOKING_DEV_MAIL_LOG: '1',
    ...overrides,
  };
}

afterEach(() => {
  while (directories.length > 0) {
    const dir = directories.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('loadConfig', () => {
  it('возвращает полный объект Config при валидном окружении', () => {
    const config = loadConfig(baseEnv());
    expect(config).toMatchObject({
      port: 3000,
      host: '127.0.0.1',
      allowedOrigins: ['http://127.0.0.1:5173'],
      hmacSecret: 'test-hmac',
      systemKey: 'test-system',
      consentVersion: '1',
      deletionContact: 'owner@example.test',
      secureCookies: false,
      mail: {
        user: null,
        appPassword: null,
        from: null,
        devMailLog: true,
      },
    });
    expect(config.dbPath.length).toBeGreaterThan(0);
  });

  it('бросает ошибку, если не задан MYBOOKING_HMAC_SECRET', () => {
    expect(() => loadConfig(baseEnv({ MYBOOKING_HMAC_SECRET: '' }))).toThrow(
      /MYBOOKING_HMAC_SECRET is required/,
    );
    expect(() => loadConfig(baseEnv({ MYBOOKING_HMAC_SECRET: undefined }))).toThrow(
      /MYBOOKING_HMAC_SECRET is required/,
    );
  });

  it('бросает ошибку, если не задан MYBOOKING_SYSTEM_KEY', () => {
    expect(() => loadConfig(baseEnv({ MYBOOKING_SYSTEM_KEY: '' }))).toThrow(
      /MYBOOKING_SYSTEM_KEY is required/,
    );
  });

  it('бросает ошибку, если не задан MYBOOKING_DELETION_CONTACT', () => {
    expect(() => loadConfig(baseEnv({ MYBOOKING_DELETION_CONTACT: '' }))).toThrow(
      /MYBOOKING_DELETION_CONTACT is required/,
    );
  });

  it('бросает ошибку, если ALLOWED_ORIGINS пустой', () => {
    expect(() => loadConfig(baseEnv({ ALLOWED_ORIGINS: '' }))).toThrow(
      /ALLOWED_ORIGINS must contain at least one origin/,
    );
    expect(() => loadConfig(baseEnv({ ALLOWED_ORIGINS: ' , , ' }))).toThrow(
      /ALLOWED_ORIGINS must contain at least one origin/,
    );
  });

  it('парсит список ALLOWED_ORIGINS, отбрасывая пустые элементы', () => {
    const config = loadConfig(baseEnv({ ALLOWED_ORIGINS: 'a,b, c ,' }));
    expect(config.allowedOrigins).toEqual(['a', 'b', 'c']);
  });

  it('читает MYBOOKING_SECURE_COOKIES как true только для 1/true', () => {
    expect(loadConfig(baseEnv({ MYBOOKING_SECURE_COOKIES: '1' })).secureCookies).toBe(true);
    expect(loadConfig(baseEnv({ MYBOOKING_SECURE_COOKIES: 'true' })).secureCookies).toBe(true);
    expect(loadConfig(baseEnv({ MYBOOKING_SECURE_COOKIES: 'TRUE' })).secureCookies).toBe(true);
    expect(loadConfig(baseEnv({ MYBOOKING_SECURE_COOKIES: '0' })).secureCookies).toBe(false);
    expect(loadConfig(baseEnv({ MYBOOKING_SECURE_COOKIES: 'no' })).secureCookies).toBe(false);
  });

  it('читает MYBOOKING_DEV_MAIL_LOG аналогично', () => {
    expect(loadConfig(baseEnv({ MYBOOKING_DEV_MAIL_LOG: '1' })).mail.devMailLog).toBe(true);
    expect(loadConfig(baseEnv({ MYBOOKING_DEV_MAIL_LOG: 'true' })).mail.devMailLog).toBe(true);
    expect(
      loadConfig(baseEnv({ MYBOOKING_DEV_MAIL_LOG: '0', GMAIL_USER: 'sender@example.test' })).mail
        .devMailLog,
    ).toBe(false);
  });

  it('бросает ошибку, если GMAIL_USER пуст и DEV_MAIL_LOG выключен', () => {
    expect(() => loadConfig(baseEnv({ GMAIL_USER: '', MYBOOKING_DEV_MAIL_LOG: '0' }))).toThrow(
      /set MYBOOKING_DEV_MAIL_LOG=1 or provide GMAIL_USER/,
    );
  });

  it('читает параметры Gmail SMTP', () => {
    const config = loadConfig(
      baseEnv({
        MYBOOKING_DEV_MAIL_LOG: '0',
        GMAIL_USER: 'sender@example.test',
        GMAIL_APP_PASSWORD: 'app-pass',
        MAIL_FROM: 'from@example.test',
      }),
    );
    expect(config.mail).toEqual({
      user: 'sender@example.test',
      appPassword: 'app-pass',
      from: 'from@example.test',
      devMailLog: false,
    });
  });

  it('парсит MYBOOKING_PORT как число', () => {
    expect(loadConfig(baseEnv({ MYBOOKING_PORT: '4321' })).port).toBe(4321);
  });

  it('бросает ошибку, если MYBOOKING_PORT не число', () => {
    expect(() => loadConfig(baseEnv({ MYBOOKING_PORT: 'abc' }))).toThrow(
      /MYBOOKING_PORT must be a non-negative integer/,
    );
  });

  it('использует значение по умолчанию для MYBOOKING_DB_PATH', () => {
    const config = loadConfig(baseEnv({ MYBOOKING_DB_PATH: undefined }));
    expect(config.dbPath).toBe('./data/mybooking.db');
  });
});
