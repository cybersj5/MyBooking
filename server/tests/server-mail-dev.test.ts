// Тест локального логгера почты. Подменяет process.stderr.write, чтобы
// перехватить строку без зависимости от реального SMTP.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDevMailLogger } from '../src/mail/dev-logger.ts';

type Write = (chunk: string | Uint8Array, ...args: unknown[]) => boolean;
const writes: string[] = [];
const originalWrite = process.stderr.write.bind(process.stderr);

beforeEach(() => {
  writes.length = 0;
  (process.stderr as unknown as { write: Write }).write = ((chunk: string | Uint8Array) => {
    writes.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  }) as Write;
});

afterEach(() => {
  (process.stderr as unknown as { write: Write }).write = originalWrite;
});

describe('createDevMailLogger', () => {
  it('пишет в stderr строку с to, code и меткой [dev-mail]', async () => {
    const logger = createDevMailLogger();
    await logger.sendCode({ to: 'x@y.z', code: '123456' });
    const joined = writes.join('');
    expect(joined).toContain('[dev-mail]');
    expect(joined).toContain('to=x@y.z');
    expect(joined).toContain('code=123456');
    expect(joined).toMatch(/ts=\d{4}-\d{2}-\d{2}T/);
  });
});
