import { describe, expect, it } from 'vitest';
import {
  createNpmSecurityDeltaReport,
  createPythonSecurityDeltaReport,
} from '../src/core/security-delta.js';
import { defaultNpmSecurityPolicy } from '../src/core/security.js';
import type { PythonSecurityReport } from '../src/core/python/security.js';
import type {
  NpmSecurityAdvisoryFinding,
  NpmSecurityReport,
  NpmStaticSecurityFinding,
  PackageSecurityAdvisoryFinding,
} from '../src/types.js';

function advisory(
  id: string,
  options: { name?: string; summary?: string; version?: string } = {}
): NpmSecurityAdvisoryFinding {
  return {
    aliases: [],
    id,
    name: options.name ?? 'demo',
    severity: 'warning',
    ...(options.summary ? { summary: options.summary } : {}),
    type: 'vulnerability',
    version: options.version ?? '1.0.0',
  };
}

function lifecycle(
  sha256: string,
  options: { allowed?: boolean; value?: string } = {}
): NpmStaticSecurityFinding {
  return {
    allowed: options.allowed ?? false,
    field: 'scripts.postinstall',
    message: 'demo@1.0.0 declares postinstall lifecycle code',
    name: 'demo',
    severity: 'warning',
    sha256,
    type: 'lifecycle-script',
    value: options.value ?? 'node setup.js',
    version: '1.0.0',
  };
}

function npmReport(
  generatedAt: string,
  options: {
    advisories?: NpmSecurityAdvisoryFinding[];
    errors?: string[];
    ok?: boolean;
    staticFindings?: NpmStaticSecurityFinding[];
  } = {}
): NpmSecurityReport {
  return {
    advisories: options.advisories ?? [],
    errors: options.errors ?? [],
    generatedAt,
    manifestSha256: 'manifest',
    ok: options.ok ?? true,
    packageCount: 1,
    policy: defaultNpmSecurityPolicy,
    provider: { name: 'OSV', url: 'https://api.osv.dev/v1/querybatch' },
    schemaVersion: 1,
    staticFindings: options.staticFindings ?? [],
  };
}

function pythonReport(
  generatedAt: string,
  advisories: PackageSecurityAdvisoryFinding[] = []
): PythonSecurityReport {
  return {
    advisories,
    errors: [],
    generatedAt,
    manifestSha256: 'python-manifest',
    ok: true,
    packageCount: 1,
    policy: { maxReportAgeHours: 72 },
    provider: { name: 'OSV', url: 'https://api.osv.dev/v1/querybatch' },
    schemaVersion: 1,
  };
}

describe('security report deltas', () => {
  it('creates a quiet baseline without treating the initial inventory as new', () => {
    const delta = createNpmSecurityDeltaReport(
      npmReport('2026-08-10T00:00:00.000Z', {
        advisories: [advisory('GHSA-existing')],
        staticFindings: [lifecycle('a'.repeat(64))],
      })
    );

    expect(delta).toMatchObject({
      advisories: { added: [], current: 1, removed: [] },
      comparison: { status: 'baseline-created' },
      lifecycleScripts: { added: [], current: 1, removed: [] },
      summary: { added: 0, current: 2, removed: 0 },
    });
  });

  it('reports only new and resolved exact findings after a successful baseline', () => {
    const previous = npmReport('2026-08-09T00:00:00.000Z', {
      advisories: [advisory('GHSA-old')],
      staticFindings: [lifecycle('a'.repeat(64))],
    });
    const current = npmReport('2026-08-10T00:00:00.000Z', {
      advisories: [advisory('GHSA-new')],
      staticFindings: [lifecycle('b'.repeat(64))],
    });

    const delta = createNpmSecurityDeltaReport(current, previous);

    expect(delta.comparison).toEqual({
      previousGeneratedAt: '2026-08-09T00:00:00.000Z',
      status: 'compared',
    });
    expect(delta.advisories.added.map((finding) => finding.id)).toEqual(['GHSA-new']);
    expect(delta.advisories.removed.map((finding) => finding.id)).toEqual(['GHSA-old']);
    expect(delta.lifecycleScripts.added[0]?.sha256).toBe('b'.repeat(64));
    expect(delta.lifecycleScripts.removed[0]?.sha256).toBe('a'.repeat(64));
    expect(delta.summary).toEqual({ added: 2, current: 2, removed: 2 });
  });

  it('treats an exact approval as resolving a lifecycle finding', () => {
    const previous = npmReport('2026-08-09T00:00:00.000Z', {
      staticFindings: [lifecycle('a'.repeat(64))],
    });
    const current = npmReport('2026-08-10T00:00:00.000Z', {
      staticFindings: [lifecycle('a'.repeat(64), { allowed: true })],
    });

    expect(createNpmSecurityDeltaReport(current, previous)).toMatchObject({
      lifecycleScripts: { added: [], current: 0, removed: [expect.any(Object)] },
      summary: { added: 0, current: 0, removed: 1 },
    });
  });

  it('does not infer resolved findings from an incomplete current scan', () => {
    const previous = npmReport('2026-08-09T00:00:00.000Z', {
      advisories: [advisory('GHSA-existing')],
    });
    const current = npmReport('2026-08-10T00:00:00.000Z', {
      errors: ['OSV unavailable'],
      ok: false,
    });

    expect(createNpmSecurityDeltaReport(current, previous)).toMatchObject({
      advisories: { added: [], removed: [] },
      comparison: { reason: 'current-scan-incomplete', status: 'unavailable' },
      summary: { added: 0, removed: 0 },
    });
  });

  it('uses the same event semantics for Python advisories', () => {
    const previousFinding = advisory('GHSA-python', {
      name: 'demo-python',
      summary: 'old wording',
    });
    const currentFinding = advisory('GHSA-python', {
      name: 'demo-python',
      summary: 'new wording',
    });

    const unchanged = createPythonSecurityDeltaReport(
      pythonReport('2026-08-10T00:00:00.000Z', [currentFinding]),
      pythonReport('2026-08-09T00:00:00.000Z', [previousFinding])
    );

    expect(unchanged).toMatchObject({
      advisories: { added: [], current: 1, removed: [] },
      comparison: { status: 'compared' },
      summary: { added: 0, current: 1, removed: 0 },
    });
  });
});
