import { describe, expect, it } from 'vitest';
import { endAfterDuration } from '../../src/time/index.js';

describe('actual duration', () => {
  it('ends after 60 elapsed minutes across the Berlin spring-forward transition', () => {
    const startAtMs = 1774744200000;

    expect(endAfterDuration(startAtMs, 60)).toBe(1774747800000);
  });

  it('accepts 15 and 30 elapsed minutes but rejects another duration', () => {
    const startAtMs = 1774745100000;

    expect(endAfterDuration(startAtMs, 15)).toBe(1774746000000);
    expect(endAfterDuration(startAtMs, 30)).toBe(1774746900000);
    expect(() => endAfterDuration(startAtMs, 45)).toThrow(RangeError);
  });
});
