import { describe, expect, it } from 'vitest';
import { formatElapsedTime } from '../src/cli-timing.js';

describe('CLI elapsed time formatting', () => {
  it('formats elapsed milliseconds as whole hours, minutes, and seconds', () => {
    expect(formatElapsedTime(0)).toBe('0h 0m 0s');
    expect(formatElapsedTime(3_723_999)).toBe('1h 2m 3s');
    expect(formatElapsedTime(97 * 60 * 60_000 + 42 * 60_000 + 5_000)).toBe('97h 42m 5s');
  });

  it('does not report negative elapsed time', () => {
    expect(formatElapsedTime(-1)).toBe('0h 0m 0s');
  });
});
