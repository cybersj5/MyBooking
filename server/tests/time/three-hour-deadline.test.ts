import { describe, expect, it } from 'vitest';
import { isBeforeThreeHourDeadline } from '../../src/time/index.js';

describe('three-hour deadline', () => {
  it('permits an action exactly three hours before start but not one millisecond later', () => {
    const startAtMs = Date.UTC(2026, 9, 5, 15, 0);
    const deadlineMs = Date.UTC(2026, 9, 5, 12, 0);

    expect(isBeforeThreeHourDeadline(startAtMs, deadlineMs)).toBe(true);
    expect(isBeforeThreeHourDeadline(startAtMs, deadlineMs + 1)).toBe(false);
  });
});
