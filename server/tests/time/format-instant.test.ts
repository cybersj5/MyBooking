import { describe, expect, it } from 'vitest';
import { formatInstant } from '../../src/time/index.js';

describe('instant formatting', () => {
  it('represents one UTC instant in Berlin and UTC without changing the instant', () => {
    const epochMilliseconds = 1792888200000;
    const berlin = formatInstant(epochMilliseconds, 'Europe/Berlin');
    const utc = formatInstant(epochMilliseconds, 'UTC');

    expect(berlin).toBe('2026-10-25T02:30:00+02:00');
    expect(utc).toBe('2026-10-25T00:30:00+00:00');
    expect(Date.parse(berlin)).toBe(epochMilliseconds);
    expect(Date.parse(utc)).toBe(epochMilliseconds);
  });
});
