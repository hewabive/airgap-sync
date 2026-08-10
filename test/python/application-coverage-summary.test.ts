import { describe, expect, it } from 'vitest';
import { formatPythonApplicationCoverageLine } from '../../src/core/python/application-coverage-summary.js';

describe('Python application coverage summary', () => {
  it('makes Python minors missing from the initial envelope explicit', () => {
    expect(
      formatPythonApplicationCoverageLine([
        {
          application: { name: 'ktransformers', version: '0.6.1.post1' },
          locks: [{ pythonMinor: '3.12' }, { pythonMinor: '3.11' }, { pythonMinor: '3.12' }],
          requestedPythonMinors: ['3.10', '3.11', '3.12', '3.13'],
          skippedPythonMinors: [
            { pythonMinor: '3.10', reasons: ['application requires Python >=3.11'] },
            { pythonMinor: '3.13', reasons: ['maintained recipe supports Python <3.13'] },
          ],
        },
      ])
    ).toEqual({
      hasSkippedPythonMinors: true,
      text: 'Python application coverage: ktransformers==0.6.1.post1: CPython 3.11, 3.12 (skipped: CPython 3.10, 3.13).',
      warningDetails: [
        'ktransformers==0.6.1.post1 skipped CPython 3.10: application requires Python >=3.11',
        'ktransformers==0.6.1.post1 skipped CPython 3.13: maintained recipe supports Python <3.13',
      ],
    });
  });

  it('does not warn about Python minors outside the requested range', () => {
    expect(
      formatPythonApplicationCoverageLine([
        {
          application: { name: 'demo', version: '1.0.0' },
          locks: [{ pythonMinor: '3.12' }],
          requestedPythonMinors: ['3.12'],
        },
      ])
    ).toEqual({
      hasSkippedPythonMinors: false,
      text: 'Python application coverage: demo==1.0.0: CPython 3.12.',
      warningDetails: [],
    });
  });

  it('reports complete initial-envelope coverage without a warning detail', () => {
    expect(
      formatPythonApplicationCoverageLine([
        {
          application: { name: 'demo', version: '1.0.0' },
          locks: ['3.13', '3.10', '3.12', '3.11'].map((pythonMinor) => ({ pythonMinor })),
        },
      ])
    ).toEqual({
      hasSkippedPythonMinors: false,
      text: 'Python application coverage: demo==1.0.0: CPython 3.10, 3.11, 3.12, 3.13.',
      warningDetails: [],
    });
  });
});
