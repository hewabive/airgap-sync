import { describe, expect, it } from 'vitest';
import {
  ElapsedTimeTracker,
  formatElapsedTime,
  formatElapsedTimeSummary,
} from '../src/cli-timing.js';

describe('CLI elapsed time formatting', () => {
  it('formats elapsed milliseconds as whole hours, minutes, and seconds', () => {
    expect(formatElapsedTime(0)).toBe('0h 0m 0s');
    expect(formatElapsedTime(3_723_999)).toBe('1h 2m 3s');
    expect(formatElapsedTime(97 * 60 * 60_000 + 42 * 60_000 + 5_000)).toBe('97h 42m 5s');
  });

  it('does not report negative elapsed time', () => {
    expect(formatElapsedTime(-1)).toBe('0h 0m 0s');
  });

  it('aggregates repeated stages while preserving their first-seen order', () => {
    let now = 0;
    const tracker = new ElapsedTimeTracker('Preparation', () => now);

    now = 1_000;
    tracker.switchTo('Download npm packages');
    now = 3_000;
    tracker.switchTo('Scan manifests');
    now = 4_000;
    tracker.switchTo('Download npm packages');
    now = 7_000;

    expect(tracker.summary()).toEqual({
      stages: [
        { elapsedMs: 1_000, label: 'Preparation' },
        { elapsedMs: 5_000, label: 'Download npm packages' },
        { elapsedMs: 1_000, label: 'Scan manifests' },
      ],
      totalMs: 7_000,
    });
  });

  it('formats a stage breakdown followed by the total time', () => {
    expect(
      formatElapsedTimeSummary({
        stages: [
          { elapsedMs: 62_000, label: 'Preparation' },
          { elapsedMs: 3_600_000, label: 'Publish npm packages' },
        ],
        totalMs: 3_662_000,
      })
    ).toBe(
      [
        'Elapsed time by stage:',
        '  Preparation: 0h 1m 2s',
        '  Publish npm packages: 1h 0m 0s',
        'Total elapsed time: 1h 1m 2s',
      ].join('\n')
    );
  });
});
