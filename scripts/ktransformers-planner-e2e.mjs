import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  acquireUv,
  addPythonRuntimeContract,
  createPythonConsumerBundleDocuments,
  HttpPythonIndexClient,
  normalizePlatformCoveragePolicy,
  normalizePythonApplicationRecipe,
  planPythonApplication,
  PythonApplicationPlanningError,
  UvApplicationResolver,
} from '../dist/index.js';

const cutoff = '2026-07-27T00:00:00.000Z';
const recipe = normalizePythonApplicationRecipe(
  JSON.parse(
    await fs.readFile(path.resolve('support/python/recipes/ktransformers-0.6.1.post1.json'), 'utf8')
  )
);
const intent = {
  application: {
    extras: [],
    features: {
      accelerator: 'cuda',
    },
    name: 'ktransformers',
    recipe: 'support/python/recipes/ktransformers-0.6.1.post1.json',
    version: '==0.6.1.post1',
  },
  coverage: {
    policyId: 'desktop-x64',
  },
  python: {
    policy: 'auto',
  },
  source: {
    indexUrl: 'https://pypi.org/simple/',
    type: 'pypi',
  },
  updatePolicy: 'manual',
};

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'airgap-sync-ktransformers-e2e-'));
try {
  const index = new HttpPythonIndexClient('https://pypi.org/simple/');
  const resolver = new UvApplicationResolver();
  let unsupported;
  try {
    await planPythonApplication({
      cacheDir: path.join(tempRoot, 'cache'),
      coveragePolicy: normalizePlatformCoveragePolicy({
        id: 'desktop-x64',
        platforms: ['windows-x86_64', 'linux-glibc-x86_64'],
      }),
      createdAt: cutoff,
      cutoff,
      index,
      intent,
      recipe,
      resolver,
      uvPath: '/unused-for-reviewed-windows-boundary',
      workDir: path.join(tempRoot, 'broad'),
    });
    throw new Error('KTransformers broad coverage unexpectedly produced a partial-ready plan');
  } catch (error) {
    if (!(error instanceof PythonApplicationPlanningError)) {
      throw error;
    }
    unsupported = error.rejectedCandidates.filter(
      (candidate) => candidate.platformFamilyId === 'windows-x86_64'
    );
    if (!unsupported.some((candidate) => candidate.reason.includes('no Windows wheel'))) {
      throw new Error('KTransformers Windows boundary was not reported precisely');
    }
  }

  const uvPath = await acquireUv({
    cacheDir: path.join(tempRoot, 'tools'),
    uvBin: process.env.UV_BIN,
  });
  const result = await planPythonApplication({
    cacheDir: path.join(tempRoot, 'cache'),
    coveragePolicy: normalizePlatformCoveragePolicy({
      id: 'ktransformers-linux-x64',
      platforms: ['linux-glibc-x86_64'],
    }),
    createdAt: cutoff,
    cutoff,
    index,
    intent: {
      ...intent,
      coverage: {
        policyId: 'ktransformers-linux-x64',
      },
    },
    recipe,
    resolver,
    uvPath,
    workDir: path.join(tempRoot, 'linux'),
  });
  const plan = addPythonRuntimeContract(result.plan, {
    recipe,
  });
  const consumer = createPythonConsumerBundleDocuments(plan, {
    genericOwner: 'airgap-packages',
    giteaBaseUrl: 'http://gitea.local',
    publicationId: 'e2e-publication',
    pypiOwner: 'airgap-packages',
  });
  if (
    plan.platforms.length !== 1 ||
    plan.platforms[0].platformFamilyId !== 'linux-glibc-x86_64' ||
    !plan.platforms[0].supportBoundary?.glibc
  ) {
    throw new Error('KTransformers Linux plan has no inferred glibc boundary');
  }
  if (plan.wheels.some((wheel) => !wheel.filename.endsWith('.whl'))) {
    throw new Error('KTransformers plan selected a source distribution');
  }
  if (
    !consumer.locks[0]?.content.includes('--hash=sha256:') ||
    !consumer.contract.platforms[0]?.install.pip.includes('--require-hashes')
  ) {
    throw new Error('KTransformers consumer contract is not hash-complete');
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        application: plan.application,
        consumerContract: consumer.contract,
        linux: {
          packages: plan.platforms[0].packages.length,
          pythonMinor: plan.platforms[0].pythonMinor,
          supportBoundary: plan.platforms[0].supportBoundary,
          wheels: plan.wheels.length,
        },
        planId: plan.planId,
        unsupportedWindowsBranches: unsupported.length,
      },
      null,
      2
    )}\n`
  );
} finally {
  await fs.rm(tempRoot, { force: true, recursive: true });
}
