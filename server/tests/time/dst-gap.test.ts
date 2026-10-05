import { describe, expect, it } from 'vitest';
import { possibleInstants } from '../../src/time/index.js';

describe('DST gap', () => {
  it('skips a local start that does not exist in Europe/Berlin', () => {
    expect(possibleInstants('2026-03-29', '02:30', 'Europe/Berlin')).toEqual([]);
  });
});
