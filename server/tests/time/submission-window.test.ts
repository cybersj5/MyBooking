import { describe, expect, it } from 'vitest';
import { isWithinSubmissionWindow } from '../../src/time/index.js';

describe('submission window', () => {
  it('includes exactly 24 hours and 30 days before start', () => {
    const nowMs = Date.UTC(2026, 9, 5, 12, 0);
    const earliestStartMs = nowMs + 24 * 60 * 60 * 1000;
    const latestStartMs = nowMs + 30 * 24 * 60 * 60 * 1000;

    expect(isWithinSubmissionWindow(earliestStartMs - 1, nowMs)).toBe(false);
    expect(isWithinSubmissionWindow(earliestStartMs, nowMs)).toBe(true);
    expect(isWithinSubmissionWindow(latestStartMs, nowMs)).toBe(true);
    expect(isWithinSubmissionWindow(latestStartMs + 1, nowMs)).toBe(false);
  });
});
