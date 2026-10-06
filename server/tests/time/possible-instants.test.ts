import { describe, expect, it } from 'vitest';
import { possibleInstants } from '../../src/time/index.js';

describe('local time resolution', () => {
  it('resolves ordinary Berlin local time to one UTC instant', () => {
    expect(possibleInstants('2026-02-10', '15:30', 'Europe/Berlin')).toEqual([
      { epochMilliseconds: 1770733800000, offset: '+01:00' },
    ]);
  });

  it('rejects an invalid date, invalid time and fixed offset in place of an IANA zone', () => {
    expect.soft(() => possibleInstants('2026-02-30', '15:30', 'Europe/Berlin')).toThrow(RangeError);
    expect.soft(() => possibleInstants('2026-02-10', '25:00', 'Europe/Berlin')).toThrow(RangeError);
    expect.soft(() => possibleInstants('2026-02-10', '15:30', '+02:00')).toThrow(RangeError);
  });
});
