import { describe, expect, it } from 'vitest';
import { endAfterDuration, overlaps } from '../../src/time/index.js';

describe('epoch millisecond inputs', () => {
  it('rejects fractional instants in durations and intervals', () => {
    expect.soft(() => endAfterDuration(1000.5, 15)).toThrow(RangeError);
    expect
      .soft(() => overlaps({ startAtMs: 0.5, endAtMs: 20 }, { startAtMs: 10, endAtMs: 30 }))
      .toThrow(RangeError);
  });
});
