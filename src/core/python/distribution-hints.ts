import type { PlatformLibcFamily } from './platform-family.js';

export interface DistributionHint {
  aliases: string[];
  distributionId: string;
  libc: {
    family: PlatformLibcFamily;
    version: string;
  };
  notes?: string[];
  release: string;
}

export interface DistributionHintCatalog {
  catalogVersion: string;
  entries: DistributionHint[];
  lastReviewedAt: string;
  provenance: {
    title: string;
    url: string;
  }[];
  schemaVersion: 1;
}
