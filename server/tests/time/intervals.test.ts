import { describe, expect, it } from 'vitest';
import { contains, overlaps } from '../../src/time/index.js';

describe('half-open time intervals', () => {
  it('allows adjacent bookings and rejects a candidate beyond one availability interval', () => {
    const first = {
      startAtMs: Date.UTC(2026, 9, 5, 10, 0),
      endAtMs: Date.UTC(2026, 9, 5, 10, 30),
    };
    const adjacent = {
      startAtMs: Date.UTC(2026, 9, 5, 10, 30),
      endAtMs: Date.UTC(2026, 9, 5, 11, 0),
    };
    const availability = {
      startAtMs: Date.UTC(2026, 9, 5, 10, 0),
      endAtMs: Date.UTC(2026, 9, 5, 11, 0),
    };
    const beyondEnd = {
      startAtMs: Date.UTC(2026, 9, 5, 10, 45),
      endAtMs: Date.UTC(2026, 9, 5, 11, 15),
    };

    expect(overlaps(first, adjacent)).toBe(false);
    expect(contains(availability, first)).toBe(true);
    expect(contains(availability, adjacent)).toBe(true);
    expect(contains(availability, beyondEnd)).toBe(false);
  });

  it('rejects empty or reversed intervals before evaluating relations', () => {
    const valid = { startAtMs: 0, endAtMs: 20 };

    expect.soft(() => overlaps({ startAtMs: 10, endAtMs: 10 }, valid)).toThrow(RangeError);
    expect.soft(() => contains(valid, { startAtMs: 15, endAtMs: 10 })).toThrow(RangeError);
  });
});
