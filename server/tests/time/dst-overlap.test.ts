import { describe, expect, it } from 'vitest';
import { possibleInstants } from '../../src/time/index.js';

describe('DST overlap', () => {
  it('returns both Berlin 02:30 instants in UTC order with explicit offsets', () => {
    expect(possibleInstants('2026-10-25', '02:30', 'Europe/Berlin')).toEqual([
      { epochMilliseconds: 1792888200000, offset: '+02:00' },
      { epochMilliseconds: 1792891800000, offset: '+01:00' },
    ]);
  });
});
