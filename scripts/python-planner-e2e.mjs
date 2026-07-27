import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  acquireUv,
  HttpPythonIndexClient,
  normalizePlatformCoveragePolicy,
  planPythonApplication,
  UvApplicationResolver,
} from '../dist/index.js';

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'airgap-sync-python-planner-e2e-'));
try {
  const uvPath = await acquireUv({
    cacheDir: path.join(tempRoot, 'tools'),
    uvBin: process.env.UV_BIN,
  });
  const result = await planPythonApplication({
    cacheDir: path.join(tempRoot, 'cache'),
    coveragePolicy: normalizePlatformCoveragePolicy({
      id: 'desktop-x64',
      platforms: ['windows-x86_64', 'linux-glibc-x86_64'],
    }),
    cutoff: new Date().toISOString(),
    index: new HttpPythonIndexClient('https://pypi.org/simple/'),
    intent: {
      application: {
        extras: [],
        features: {},
        name: 'orjson',
        version: '==3.10.18',
      },
      coverage: {
        policyId: 'desktop-x64',
      },
      python: {
        policy: 'constrained',
        version: '>=3.11,<3.12',
      },
      source: {
        indexUrl: 'https://pypi.org/simple/',
        type: 'pypi',
      },
      updatePolicy: 'manual',
    },
    resolver: new UvApplicationResolver(),
    uvPath,
    workDir: path.join(tempRoot, 'work'),
  });

  const platforms = new Set(result.plan.platforms.map((platform) => platform.platformFamilyId));
  if (!platforms.has('windows-x86_64') || !platforms.has('linux-glibc-x86_64')) {
    throw new Error('planner did not cover both requested platform families');
  }
  if (
    !result.plan.wheels.some((wheel) => wheel.filename.includes('win_amd64')) ||
    !result.plan.wheels.some((wheel) => wheel.filename.includes('manylinux'))
  ) {
    throw new Error('planner did not enumerate Windows and manylinux wheel variants');
  }
  if (result.plan.wheels.some((wheel) => !wheel.filename.endsWith('.whl'))) {
    throw new Error('planner selected a source distribution');
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        application: result.plan.application,
        planId: result.plan.planId,
        platforms: result.plan.platforms.map((platform) => ({
          id: platform.platformFamilyId,
          pythonMinor: platform.pythonMinor,
          supportBoundary: platform.supportBoundary,
        })),
        uv: path.basename(uvPath),
        wheels: result.plan.wheels.length,
      },
      null,
      2
    )}\n`
  );
} finally {
  await fs.rm(tempRoot, { force: true, recursive: true });
}
