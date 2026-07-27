import type { PlatformCoveragePolicy } from './coverage-policy.js';
import {
  builtInDistributionHintCatalog,
  type DistributionHint,
  type DistributionHintCatalog,
} from './distribution-hints.js';
import { getBuiltInPlatformFamily, type PlatformFamily } from './platform-family.js';

export interface PlatformCoverageExplanation {
  family: PlatformFamily;
  glibc:
    | {
        knownCompatibleExamples: DistributionHint[];
        knownIncompatibleExamples: DistributionHint[];
        minimum: string;
        source: 'advanced-constraint';
      }
    | {
        source: 'inferred-during-planning';
      }
    | undefined;
}

export interface PlatformCoveragePolicyExplanation {
  catalog: {
    lastReviewedAt: string;
    version: string;
  };
  id: string;
  platforms: PlatformCoverageExplanation[];
  version: number;
  wheelStrategy: 'all-compatible';
}

export function compareCompatibilityVersions(left: string, right: string): number {
  const leftParts = left.split('.').map(Number);
  const rightParts = right.split('.').map(Number);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}

export function explainPlatformCoveragePolicy(
  policy: PlatformCoveragePolicy,
  catalog: DistributionHintCatalog = builtInDistributionHintCatalog
): PlatformCoveragePolicyExplanation {
  return {
    catalog: {
      lastReviewedAt: catalog.lastReviewedAt,
      version: catalog.catalogVersion,
    },
    id: policy.id,
    platforms: policy.platforms.map((platformId) => {
      const family = getBuiltInPlatformFamily(platformId);
      if (!family) {
        throw new Error(`Unknown platform family: ${platformId}`);
      }
      if (family.libc !== 'glibc') {
        return {
          family,
          glibc: undefined,
        };
      }
      const minimum = policy.linux?.oldestSupportedGlibc;
      if (!minimum) {
        return {
          family,
          glibc: {
            source: 'inferred-during-planning',
          },
        };
      }
      const glibcHints = catalog.entries.filter((entry) => entry.libc.family === 'glibc');
      return {
        family,
        glibc: {
          knownCompatibleExamples: glibcHints.filter(
            (entry) => compareCompatibilityVersions(entry.libc.version, minimum) >= 0
          ),
          knownIncompatibleExamples: glibcHints.filter(
            (entry) => compareCompatibilityVersions(entry.libc.version, minimum) < 0
          ),
          minimum,
          source: 'advanced-constraint',
        },
      };
    }),
    version: policy.version,
    wheelStrategy: policy.wheelStrategy,
  };
}
