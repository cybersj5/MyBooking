import { describe, expect, it } from 'vitest';
import { isAlignedStart } from '../../src/time/index.js';

describe('15-minute start alignment', () => {
  it('accepts both repeated Berlin 02:30 instants but rejects offsets from the slot boundary', () => {
    expect(isAlignedStart(1792888200000, 'Europe/Berlin')).toBe(true);
    expect(isAlignedStart(1792891800000, 'Europe/Berlin')).toBe(true);
    expect(isAlignedStart(1792888260000, 'Europe/Berlin')).toBe(false);
    expect(isAlignedStart(1792888201000, 'Europe/Berlin')).toBe(false);
  });
});
