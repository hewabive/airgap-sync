import { initialPythonApplicationMinors } from './application-intent.js';

export interface PythonApplicationCoverageEntry {
  application: {
    name: string;
    version: string;
  };
  locks: {
    pythonMinor: string;
  }[];
  requestedPythonMinors?: string[];
  skippedPythonMinors?: {
    pythonMinor: string;
    reasons: string[];
  }[];
}

export interface PythonApplicationCoverageLine {
  hasSkippedPythonMinors: boolean;
  text: string;
  warningDetails: string[];
}

function comparePythonMinors(left: string, right: string): number {
  const [leftMajor, leftMinor] = left.split('.').map(Number);
  const [rightMajor, rightMinor] = right.split('.').map(Number);
  return (leftMajor ?? 0) - (rightMajor ?? 0) || (leftMinor ?? 0) - (rightMinor ?? 0);
}

export function formatPythonApplicationCoverageLine(
  applications: PythonApplicationCoverageEntry[]
): PythonApplicationCoverageLine | undefined {
  if (applications.length === 0) {
    return undefined;
  }

  let hasSkippedPythonMinors = false;
  const warningDetails: string[] = [];
  const entries = applications.map((entry) => {
    const bundled = [...new Set(entry.locks.map((lock) => lock.pythonMinor))].sort(
      comparePythonMinors
    );
    const bundledSet = new Set(bundled);
    const requested = [...new Set(entry.requestedPythonMinors ?? initialPythonApplicationMinors)];
    const missing = requested.filter((minor) => !bundledSet.has(minor)).sort(comparePythonMinors);
    hasSkippedPythonMinors ||= missing.length > 0;
    const missingDetail = missing.length > 0 ? ` (skipped: CPython ${missing.join(', ')})` : '';
    for (const pythonMinor of missing) {
      const reasons = entry.skippedPythonMinors?.find(
        (skipped) => skipped.pythonMinor === pythonMinor
      )?.reasons;
      warningDetails.push(
        `${entry.application.name}==${entry.application.version} skipped CPython ${pythonMinor}: ${reasons?.length ? reasons.join('; ') : 'no complete dependency tree was selected'}`
      );
    }
    return `${entry.application.name}==${entry.application.version}: CPython ${bundled.join(', ')}${missingDetail}`;
  });

  return {
    hasSkippedPythonMinors,
    text: `Python application coverage: ${entries.join('; ')}.`,
    warningDetails,
  };
}
