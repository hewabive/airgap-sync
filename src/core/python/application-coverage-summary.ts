import { initialPythonApplicationMinors } from './application-intent.js';

export interface PythonApplicationCoverageEntry {
  application: {
    name: string;
    version: string;
  };
  locks: {
    pythonMinor: string;
  }[];
}

export interface PythonApplicationCoverageLine {
  hasMissingInitialMinors: boolean;
  text: string;
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

  let hasMissingInitialMinors = false;
  const entries = applications.map((entry) => {
    const bundled = [...new Set(entry.locks.map((lock) => lock.pythonMinor))].sort(
      comparePythonMinors
    );
    const bundledSet = new Set(bundled);
    const missing = initialPythonApplicationMinors.filter((minor) => !bundledSet.has(minor));
    hasMissingInitialMinors ||= missing.length > 0;
    const missingDetail = missing.length > 0 ? ` (not bundled: CPython ${missing.join(', ')})` : '';
    return `${entry.application.name}==${entry.application.version}: CPython ${bundled.join(', ')}${missingDetail}`;
  });

  return {
    hasMissingInitialMinors,
    text: `Python application coverage: ${entries.join('; ')}.`,
  };
}
