import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { semanticDigest } from '../../src/core/canonical-json.js';
import * as fs from '../../src/core/fs.js';
import type { ActivePythonApplicationPlan } from '../../src/core/python/active-plan-store.js';
import {
  downloadPythonApplicationPlans,
  readPythonApplicationBundleIndex,
  type PythonApplicationDownloadProgressEvent,
  verifyPythonApplicationBundle,
} from '../../src/core/python/application-bundle.js';
import {
  pythonApplicationTargetId,
  pythonApplicationVariantId,
} from '../../src/core/python/application-paths.js';
import { normalizePlatformCoveragePolicy } from '../../src/core/python/coverage-policy.js';
import {
  createPythonEnvironmentPlan,
  type PythonEnvironmentPlan,
} from '../../src/core/python/environment-plan.js';
import { comparePythonEnvironmentPlans } from '../../src/core/python/plan-diff.js';
import type { PythonSeedManifest } from '../../src/core/python/bundle.js';

let tempDir: string;

function createPlan(options: {
  application: string;
  filename: string;
  sha256: string;
  size: number;
  sourceUrl: string;
  version?: string;
  wheelVersion?: string;
}): PythonEnvironmentPlan {
  const policy = normalizePlatformCoveragePolicy({
    id: 'linux-x64',
    platforms: ['linux-glibc-x86_64'],
  });
  return createPythonEnvironmentPlan({
    application: {
      name: options.application,
      version: options.version ?? '1.0.0',
    },
    coverage: {
      digest: 'a'.repeat(64),
      families: [],
      policy,
    },
    createdAt: '2026-07-27T00:00:00.000Z',
    intent: {
      application: {
        extras: [],
        features: {},
        name: options.application,
      },
      coverage: { policyId: policy.id },
      python: { policy: 'auto' },
      source: { type: 'pypi' },
      updatePolicy: 'manual',
    },
    platforms: [
      {
        packages: [
          {
            dependencies: [],
            name: 'shared',
            version: options.wheelVersion ?? '1.0.0',
            wheels: [options.filename],
          },
        ],
        platformFamilyId: 'linux-glibc-x86_64',
        pylockPath: 'lock/linux-glibc-x86_64--py311.pylock.toml',
        pythonMinor: '3.11',
        rejectedReasons: [],
        requirementsLockPath: 'lock/linux-glibc-x86_64--py311.requirements.lock',
        requiresPython: '>=3.11,<3.12',
        status: 'supported',
      },
    ],
    resolver: {
      engine: 'uv',
      policyVersion: 1,
      version: '0.11.16',
    },
    runtimeContract: {
      platforms: [
        {
          implementation: 'CPython',
          platformFamilyId: 'linux-glibc-x86_64',
          provisionedExternally: true,
          pythonMinor: '3.11',
          requiresPython: '>=3.11,<3.12',
          systemPrerequisites: [],
        },
      ],
    },
    schemaVersion: 2,
    wheels: [
      {
        filename: options.filename,
        package: 'shared',
        platforms: ['linux-glibc-x86_64'],
        sha256: options.sha256,
        size: options.size,
        url: options.sourceUrl,
        version: options.wheelVersion ?? '1.0.0',
      },
    ],
  });
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function wheelBuffer(version: string): Buffer {
  const filename = Buffer.from(`shared-${version}.dist-info/METADATA`);
  const content = Buffer.from(
    `Metadata-Version: 2.3\nName: shared\nVersion: ${version}\nRequires-Python: >=3.11\n\n`
  );
  const checksum = crc32(content);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt32LE(checksum, 14);
  local.writeUInt32LE(content.byteLength, 18);
  local.writeUInt32LE(content.byteLength, 22);
  local.writeUInt16LE(filename.byteLength, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt32LE(checksum, 16);
  central.writeUInt32LE(content.byteLength, 20);
  central.writeUInt32LE(content.byteLength, 24);
  central.writeUInt16LE(filename.byteLength, 28);
  const localRecord = Buffer.concat([local, filename, content]);
  const centralRecord = Buffer.concat([central, filename]);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(centralRecord.byteLength, 12);
  end.writeUInt32LE(localRecord.byteLength, 16);
  return Buffer.concat([localRecord, centralRecord, end]);
}

function activePlan(plan: PythonEnvironmentPlan): ActivePythonApplicationPlan {
  const targetId = pythonApplicationTargetId(plan.application.name, plan.coverage.policy.id);
  const content = [
    'lock-version = "1.0"',
    'created-by = "uv 0.11.16"',
    '',
    '[[packages]]',
    'name = "shared"',
    'version = "1.0.0"',
    'wheels = []',
    '',
  ].join('\n');
  const digest = semanticDigest(content);
  return {
    diff: comparePythonEnvironmentPlans(undefined, plan, '2026-07-27T00:00:00.000Z'),
    evidence: [
      {
        platformFamilyId: 'linux-glibc-x86_64',
        pylock: {
          content,
          digest,
          lock: {
            createdBy: 'uv 0.11.16',
            defaultGroups: [],
            dependencyGroups: [],
            environments: [],
            extras: [],
            format: 'pylock',
            packages: [],
            sourcePath: 'fixture',
            version: '1.0',
          },
          platformTarget: 'x86_64-manylinux_2_17',
        },
        pythonMinor: '3.11',
      },
    ],
    manifest: {
      diffPath: 'plan-diff.json',
      evidence: [
        {
          digest,
          path: 'lock/linux-glibc-x86_64--py311.pylock.toml',
          platformFamilyId: 'linux-glibc-x86_64',
          platformTarget: 'x86_64-manylinux_2_17',
          pythonMinor: '3.11',
        },
      ],
      planId: plan.planId,
      planPath: 'environment-plan.json',
      schemaVersion: 1,
      targetId,
      targetIndex: 1,
    },
    plan,
  };
}

describe('Python application bundle', () => {
  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'airgap-sync-python-app-bundle-'));
  });

  afterEach(async () => {
    await fs.remove(tempDir);
  });

  it.each([1, 2])(
    'requires one new download for a schema-v%s application bundle',
    async (schemaVersion) => {
      const bundleDir = path.join(tempDir, 'bundle');
      await fs.writeJson(
        path.join(bundleDir, 'python/application-index.json'),
        {
          applications: [],
          artifacts: [],
          createdAt: '2026-07-27T00:00:00.000Z',
          schemaVersion,
          summary: { applications: 0, artifacts: 0, totalBytes: 0 },
        },
        { spaces: 2 }
      );

      await expect(readPythonApplicationBundleIndex(bundleDir)).rejects.toThrow(
        'schemaVersion 1/2 or runtime-transfer artifacts are obsolete'
      );
    }
  );

  it('deduplicates shared wheels while retaining independent plans and locks', async () => {
    const content = wheelBuffer('1.0.0');
    const sha256 = createHash('sha256').update(content).digest('hex');
    const source = path.join(tempDir, 'shared-1.0.0-py3-none-any.whl');
    await fs.writeFile(source, content);
    const bundleDir = path.join(tempDir, 'bundle');
    const sourceUrl = pathToFileURL(source).toString();
    const first = activePlan(
      createPlan({
        application: 'first-app',
        filename: path.basename(source),
        sha256,
        size: content.byteLength,
        sourceUrl,
      })
    );
    const second = activePlan(
      createPlan({
        application: 'second-app',
        filename: path.basename(source),
        sha256,
        size: content.byteLength,
        sourceUrl,
      })
    );

    const progress: PythonApplicationDownloadProgressEvent[] = [];
    const report = await downloadPythonApplicationPlans({
      bundleDir,
      generatedAt: '2026-07-28T00:00:00.000Z',
      onProgress: (event) => progress.push(event),
      targets: [
        { activePlan: first, targetId: first.manifest.targetId },
        { activePlan: second, targetId: second.manifest.targetId },
      ],
    });

    expect(report).toMatchObject({
      downloaded: 1,
      errors: [],
      incrementalBytes: content.byteLength,
      totalBytes: content.byteLength,
    });
    expect(progress[0]).toEqual({
      current: 0,
      detail: '2 application plans',
      status: 'start',
      total: 1,
    });
    expect(progress).toContainEqual(
      expect.objectContaining({
        bytes: 0,
        current: 0,
        detail: `download ${path.basename(source)}`,
        status: 'progress',
        total: 1,
        totalBytes: content.byteLength,
      })
    );
    expect(progress).toContainEqual({
      current: 1,
      detail: `downloaded ${path.basename(source)}`,
      status: 'progress',
      total: 1,
    });
    expect(progress.at(-1)).toEqual({
      current: 1,
      status: 'done',
      total: 1,
    });
    const index = await readPythonApplicationBundleIndex(bundleDir);
    expect(index).toMatchObject({
      summary: {
        applications: 2,
        artifacts: 1,
        totalBytes: content.byteLength,
      },
    });
    expect(index?.artifacts[0]?.references).toHaveLength(2);
    expect(index?.artifacts[0]?.references[0]?.cells).toEqual(['linux-glibc-x86_64--py311']);
    expect(index?.applications.map((application) => application.locks[0]?.file)).toEqual([
      expect.stringContaining('first-app--linux-x64/lock/'),
      expect.stringContaining('second-app--linux-x64/lock/'),
    ]);
    const compatibilityManifest = await fs.readJson<PythonSeedManifest>(
      path.join(bundleDir, 'python-seed-manifest.json')
    );
    expect(compatibilityManifest).toMatchObject({
      packages: [
        {
          files: [
            {
              coreMetadata: {
                name: 'shared',
                version: '1.0.0',
              },
            },
          ],
          name: 'shared',
          version: '1.0.0',
        },
      ],
    });
    expect(compatibilityManifest.packages[0]?.files[0]?.file).toContain('python/artifacts/wheels/');
    expect(await verifyPythonApplicationBundle(bundleDir)).toMatchObject({ errors: [] });
    const prerequisitePath = index!.applications[0]!.prerequisiteReportPath;
    const firstPrerequisite = await fs.readFile(path.join(bundleDir, prerequisitePath), 'utf8');
    expect(JSON.parse(firstPrerequisite)).toMatchObject({
      generatedAt: first.plan.createdAt,
      planId: first.plan.planId,
    });

    const repeated = await downloadPythonApplicationPlans({
      bundleDir,
      generatedAt: '2026-07-29T00:00:00.000Z',
      targets: [
        { activePlan: first, targetId: first.manifest.targetId },
        { activePlan: second, targetId: second.manifest.targetId },
      ],
    });
    expect(repeated).toMatchObject({
      downloaded: 0,
      existing: 1,
      incrementalBytes: 0,
    });
    await expect(fs.readFile(path.join(bundleDir, prerequisitePath), 'utf8')).resolves.toBe(
      firstPrerequisite
    );
  });

  it('stores independently installable versions from one application selection', async () => {
    const firstContent = wheelBuffer('1.0.0');
    const secondContent = wheelBuffer('2.0.0');
    const firstSha = createHash('sha256').update(firstContent).digest('hex');
    const secondSha = createHash('sha256').update(secondContent).digest('hex');
    const firstSource = path.join(tempDir, 'shared-1.0.0-py3-none-any.whl');
    const secondSource = path.join(tempDir, 'shared-2.0.0-py3-none-any.whl');
    await fs.writeFile(firstSource, firstContent);
    await fs.writeFile(secondSource, secondContent);
    const first = activePlan(
      createPlan({
        application: 'demo-app',
        filename: path.basename(firstSource),
        sha256: firstSha,
        size: firstContent.byteLength,
        sourceUrl: pathToFileURL(firstSource).toString(),
        version: '0.25.1',
      })
    );
    const second = activePlan(
      createPlan({
        application: 'demo-app',
        filename: path.basename(secondSource),
        sha256: secondSha,
        size: secondContent.byteLength,
        sourceUrl: pathToFileURL(secondSource).toString(),
        version: '0.26.0',
        wheelVersion: '2.0.0',
      })
    );
    const selectionId = pythonApplicationTargetId('demo-app', 'linux-x64');
    const bundleDir = path.join(tempDir, 'bundle-versions');

    await downloadPythonApplicationPlans({
      bundleDir,
      targets: [
        {
          activePlan: first,
          selectionId,
          targetId: pythonApplicationVariantId('demo-app', '0.25.1', 'linux-x64'),
        },
        {
          activePlan: second,
          selectionId,
          targetId: pythonApplicationVariantId('demo-app', '0.26.0', 'linux-x64'),
        },
      ],
    });

    const index = await readPythonApplicationBundleIndex(bundleDir);
    expect(index?.applications.map((application) => application.application.version)).toEqual([
      '0.25.1',
      '0.26.0',
    ]);
    expect(
      index?.applications.every((application) => application.selectionId === selectionId)
    ).toBe(true);
    expect(index?.summary.applications).toBe(2);
    expect(await verifyPythonApplicationBundle(bundleDir)).toMatchObject({ errors: [] });
  });

  it('recovers from an interrupted multi-artifact download without activating a partial index', async () => {
    const firstContent = wheelBuffer('1.0.0');
    const secondContent = wheelBuffer('2.0.0');
    const firstSha = createHash('sha256').update(firstContent).digest('hex');
    const secondSha = createHash('sha256').update(secondContent).digest('hex');
    const firstSource = path.join(tempDir, 'shared-1.0.0-py3-none-any.whl');
    const secondSource = path.join(tempDir, 'shared-2.0.0-py3-none-any.whl');
    await fs.writeFile(firstSource, firstContent);
    const bundleDir = path.join(tempDir, 'bundle');
    const first = activePlan(
      createPlan({
        application: 'first-app',
        filename: path.basename(firstSource),
        sha256: firstSha,
        size: firstContent.byteLength,
        sourceUrl: pathToFileURL(firstSource).toString(),
      })
    );
    const second = activePlan(
      createPlan({
        application: 'second-app',
        filename: path.basename(secondSource),
        sha256: secondSha,
        size: secondContent.byteLength,
        sourceUrl: pathToFileURL(secondSource).toString(),
        wheelVersion: '2.0.0',
      })
    );
    const targets = [
      { activePlan: first, targetId: first.manifest.targetId },
      { activePlan: second, targetId: second.manifest.targetId },
    ];

    const interrupted = await downloadPythonApplicationPlans({
      bundleDir,
      targets,
    });

    expect(interrupted).toMatchObject({
      downloaded: 1,
      errors: [expect.objectContaining({ status: 'error' })],
    });
    expect(await readPythonApplicationBundleIndex(bundleDir)).toBeUndefined();

    await fs.writeFile(secondSource, secondContent);
    const recovered = await downloadPythonApplicationPlans({
      bundleDir,
      targets,
    });

    expect(recovered).toMatchObject({
      downloaded: 1,
      errors: [],
      existing: 1,
    });
    expect(await readPythonApplicationBundleIndex(bundleDir)).toMatchObject({
      summary: {
        applications: 2,
        artifacts: 2,
      },
    });
    expect(await verifyPythonApplicationBundle(bundleDir)).toMatchObject({ errors: [] });
  });

  it('downloads independent application artifacts concurrently', async () => {
    const firstContent = wheelBuffer('1.0.0');
    const secondContent = wheelBuffer('2.0.0');
    const firstUrl = 'https://files.test/shared-1.0.0-py3-none-any.whl';
    const secondUrl = 'https://files.test/shared-2.0.0-py3-none-any.whl';
    const bodies = new Map([
      [firstUrl, firstContent],
      [secondUrl, secondContent],
    ]);
    const first = activePlan(
      createPlan({
        application: 'first-app',
        filename: path.basename(firstUrl),
        sha256: createHash('sha256').update(firstContent).digest('hex'),
        size: firstContent.byteLength,
        sourceUrl: firstUrl,
      })
    );
    const second = activePlan(
      createPlan({
        application: 'second-app',
        filename: path.basename(secondUrl),
        sha256: createHash('sha256').update(secondContent).digest('hex'),
        size: secondContent.byteLength,
        sourceUrl: secondUrl,
        wheelVersion: '2.0.0',
      })
    );
    let release!: () => void;
    const bothStarted = new Promise<void>((resolve) => {
      release = resolve;
    });
    let active = 0;
    let maxActive = 0;
    const fetchImplementation = (async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : input.toString();
      const body = bodies.get(url);
      if (!body) {
        return new Response(null, { status: 404 });
      }
      active += 1;
      maxActive = Math.max(maxActive, active);
      if (active === 2) {
        release();
      }
      await bothStarted;
      active -= 1;
      return new Response(body);
    }) as typeof globalThis.fetch;

    const report = await downloadPythonApplicationPlans({
      bundleDir: path.join(tempDir, 'bundle'),
      concurrency: 2,
      fetch: fetchImplementation,
      targets: [
        { activePlan: first, targetId: first.manifest.targetId },
        { activePlan: second, targetId: second.manifest.targetId },
      ],
    });

    expect(maxActive).toBe(2);
    expect(report).toMatchObject({ downloaded: 2, errors: [] });
  });

  it('resumes a stalled application artifact download', async () => {
    const content = wheelBuffer('1.0.0');
    const sourceUrl = 'https://files.test/shared-1.0.0-py3-none-any.whl';
    const splitAt = Math.floor(content.byteLength / 2);
    const ranges: (string | null)[] = [];
    const plan = activePlan(
      createPlan({
        application: 'first-app',
        filename: path.basename(sourceUrl),
        sha256: createHash('sha256').update(content).digest('hex'),
        size: content.byteLength,
        sourceUrl,
      })
    );
    const fetchImplementation: typeof globalThis.fetch = (_input, init) => {
      ranges.push(new Headers(init?.headers).get('range'));
      if (ranges.length === 1) {
        return Promise.resolve(
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(content.subarray(0, splitAt));
              },
            }),
            { headers: { 'Content-Length': String(content.byteLength) } }
          )
        );
      }
      return Promise.resolve(
        new Response(content.subarray(splitAt), {
          headers: {
            'Content-Range': `bytes ${String(splitAt)}-${String(content.byteLength - 1)}/${String(content.byteLength)}`,
          },
          status: 206,
        })
      );
    };

    const report = await downloadPythonApplicationPlans({
      bundleDir: path.join(tempDir, 'resumed-bundle'),
      fetch: fetchImplementation,
      retryDelaysMs: [1],
      stallTimeoutMs: 20,
      targets: [{ activePlan: plan, targetId: plan.manifest.targetId }],
    });

    expect(report).toMatchObject({ downloaded: 1, errors: [] });
    expect(ranges).toEqual([null, `bytes=${String(splitAt)}-`]);
  });

  it('uses the activated content index for incremental checks and leaves full hashing to verify', async () => {
    const content = wheelBuffer('1.0.0');
    const source = path.join(tempDir, 'shared-1.0.0-py3-none-any.whl');
    const bundleDir = path.join(tempDir, 'bundle');
    await fs.writeFile(source, content);
    const plan = activePlan(
      createPlan({
        application: 'first-app',
        filename: path.basename(source),
        sha256: createHash('sha256').update(content).digest('hex'),
        size: content.byteLength,
        sourceUrl: pathToFileURL(source).toString(),
      })
    );
    const targets = [{ activePlan: plan, targetId: plan.manifest.targetId }];
    await downloadPythonApplicationPlans({ bundleDir, targets });
    const index = await readPythonApplicationBundleIndex(bundleDir);
    const artifactPath = path.join(bundleDir, index!.artifacts[0]!.file);
    await fs.writeFile(artifactPath, Buffer.alloc(content.byteLength));

    const repeated = await downloadPythonApplicationPlans({ bundleDir, targets });

    expect(repeated).toMatchObject({ downloaded: 0, errors: [], existing: 1 });
    expect((await verifyPythonApplicationBundle(bundleDir)).errors).toContain(
      `Python application artifact SHA-256 mismatch: ${index!.artifacts[0]!.file}`
    );
  });

  it('rejects an open dependency edge in a planned compatibility cell', async () => {
    const content = wheelBuffer('1.0.0');
    const sha256 = createHash('sha256').update(content).digest('hex');
    const source = path.join(tempDir, 'shared-1.0.0-py3-none-any.whl');
    await fs.writeFile(source, content);
    const original = createPlan({
      application: 'first-app',
      filename: path.basename(source),
      sha256,
      size: content.byteLength,
      sourceUrl: pathToFileURL(source).toString(),
    });
    const { planId, ...input } = original;
    expect(planId).toMatch(/^[a-f0-9]{64}$/u);
    const plan = createPythonEnvironmentPlan({
      ...input,
      platforms: original.platforms.map((platform) => ({
        ...platform,
        packages: platform.packages.map((pkg) => ({
          ...pkg,
          dependencies: ['missing-leaf'],
        })),
      })),
    });
    const bundleDir = path.join(tempDir, 'open-edge-bundle');

    await downloadPythonApplicationPlans({
      bundleDir,
      targets: [{ activePlan: activePlan(plan), targetId: activePlan(plan).manifest.targetId }],
    });

    expect((await verifyPythonApplicationBundle(bundleDir)).errors).toContain(
      'Python application first-app--linux-x64 has an open dependency edge in linux-glibc-x86_64--py311: shared==1.0.0 -> missing-leaf'
    );
  });

  it('preserves unselected references during a partial target update', async () => {
    const oldContent = wheelBuffer('1.0.0');
    const oldSha = createHash('sha256').update(oldContent).digest('hex');
    const oldSource = path.join(tempDir, 'shared-1.0.0-py3-none-any.whl');
    await fs.writeFile(oldSource, oldContent);
    const bundleDir = path.join(tempDir, 'bundle');
    const first = activePlan(
      createPlan({
        application: 'first-app',
        filename: path.basename(oldSource),
        sha256: oldSha,
        size: oldContent.byteLength,
        sourceUrl: pathToFileURL(oldSource).toString(),
      })
    );
    const second = activePlan(
      createPlan({
        application: 'second-app',
        filename: path.basename(oldSource),
        sha256: oldSha,
        size: oldContent.byteLength,
        sourceUrl: pathToFileURL(oldSource).toString(),
      })
    );
    await downloadPythonApplicationPlans({
      bundleDir,
      targets: [
        { activePlan: first, targetId: first.manifest.targetId },
        { activePlan: second, targetId: second.manifest.targetId },
      ],
    });

    const newContent = wheelBuffer('2.0.0');
    const newSha = createHash('sha256').update(newContent).digest('hex');
    const newSource = path.join(tempDir, 'shared-2.0.0-py3-none-any.whl');
    await fs.writeFile(newSource, newContent);
    const updatedFirst = activePlan(
      createPlan({
        application: 'first-app',
        filename: path.basename(newSource),
        sha256: newSha,
        size: newContent.byteLength,
        sourceUrl: pathToFileURL(newSource).toString(),
        version: '2.0.0',
        wheelVersion: '2.0.0',
      })
    );
    await downloadPythonApplicationPlans({
      bundleDir,
      partial: true,
      targets: [{ activePlan: updatedFirst, targetId: updatedFirst.manifest.targetId }],
    });

    const index = await readPythonApplicationBundleIndex(bundleDir);
    expect(index?.applications).toHaveLength(2);
    expect(index?.artifacts).toHaveLength(2);
    expect(index?.artifacts.find((artifact) => artifact.sha256 === oldSha)?.references).toEqual([
      expect.objectContaining({
        targetId: second.manifest.targetId,
      }),
    ]);
  });

  it('replaces every stale version variant in a partially updated selection', async () => {
    const oldContent = wheelBuffer('1.0.0');
    const oldSha = createHash('sha256').update(oldContent).digest('hex');
    const oldSource = path.join(tempDir, 'shared-1.0.0-py3-none-any.whl');
    await fs.writeFile(oldSource, oldContent);
    const bundleDir = path.join(tempDir, 'bundle-selection');
    const oldPlan = activePlan(
      createPlan({
        application: 'first-app',
        filename: path.basename(oldSource),
        sha256: oldSha,
        size: oldContent.byteLength,
        sourceUrl: pathToFileURL(oldSource).toString(),
        version: '0.25.1',
      })
    );
    const selectionId = pythonApplicationTargetId('first-app', 'linux-x64');
    await downloadPythonApplicationPlans({
      bundleDir,
      targets: [
        {
          activePlan: oldPlan,
          selectionId,
          targetId: pythonApplicationVariantId('first-app', '0.25.1', 'linux-x64'),
        },
      ],
    });

    const newContent = wheelBuffer('2.0.0');
    const newSha = createHash('sha256').update(newContent).digest('hex');
    const newSource = path.join(tempDir, 'shared-2.0.0-py3-none-any.whl');
    await fs.writeFile(newSource, newContent);
    const newPlan = activePlan(
      createPlan({
        application: 'first-app',
        filename: path.basename(newSource),
        sha256: newSha,
        size: newContent.byteLength,
        sourceUrl: pathToFileURL(newSource).toString(),
        version: '0.26.0',
        wheelVersion: '2.0.0',
      })
    );
    await downloadPythonApplicationPlans({
      bundleDir,
      partial: true,
      targets: [
        {
          activePlan: newPlan,
          selectionId,
          targetId: pythonApplicationVariantId('first-app', '0.26.0', 'linux-x64'),
        },
      ],
    });

    const index = await readPythonApplicationBundleIndex(bundleDir);
    expect(index?.applications).toEqual([
      expect.objectContaining({
        application: { name: 'first-app', version: '0.26.0' },
        selectionId,
      }),
    ]);
    expect(index?.artifacts.map((artifact) => artifact.sha256)).toEqual([newSha]);
  });

  it('replaces stale references on a full replan and can synchronize an empty target set', async () => {
    const oldContent = wheelBuffer('1.0.0');
    const oldSha = createHash('sha256').update(oldContent).digest('hex');
    const oldSource = path.join(tempDir, 'shared-1.0.0-py3-none-any.whl');
    await fs.writeFile(oldSource, oldContent);
    const bundleDir = path.join(tempDir, 'bundle');
    const original = activePlan(
      createPlan({
        application: 'first-app',
        filename: path.basename(oldSource),
        sha256: oldSha,
        size: oldContent.byteLength,
        sourceUrl: pathToFileURL(oldSource).toString(),
      })
    );
    await downloadPythonApplicationPlans({
      bundleDir,
      targets: [{ activePlan: original, targetId: original.manifest.targetId }],
    });

    const newContent = wheelBuffer('2.0.0');
    const newSha = createHash('sha256').update(newContent).digest('hex');
    const newSource = path.join(tempDir, 'shared-2.0.0-py3-none-any.whl');
    await fs.writeFile(newSource, newContent);
    const updated = activePlan(
      createPlan({
        application: 'first-app',
        filename: path.basename(newSource),
        sha256: newSha,
        size: newContent.byteLength,
        sourceUrl: pathToFileURL(newSource).toString(),
        version: '2.0.0',
        wheelVersion: '2.0.0',
      })
    );
    await downloadPythonApplicationPlans({
      bundleDir,
      targets: [{ activePlan: updated, targetId: updated.manifest.targetId }],
    });

    const replannedIndex = await readPythonApplicationBundleIndex(bundleDir);
    expect(replannedIndex?.applications).toHaveLength(1);
    expect(replannedIndex?.applications[0]).toMatchObject({
      application: { name: 'first-app', version: '2.0.0' },
      targetId: original.manifest.targetId,
    });
    expect(replannedIndex?.artifacts.map((artifact) => artifact.sha256)).toEqual([newSha]);
    await expect(
      fs.pathExists(
        path.join(bundleDir, `python/artifacts/wheels/${oldSha}/${path.basename(oldSource)}`)
      )
    ).resolves.toBe(true);

    const emptied = await downloadPythonApplicationPlans({
      bundleDir,
      targets: [],
    });

    expect(emptied).toMatchObject({
      applications: [],
      errors: [],
      totalBytes: 0,
    });
    expect(await readPythonApplicationBundleIndex(bundleDir)).toMatchObject({
      applications: [],
      artifacts: [],
      summary: {
        applications: 0,
        artifacts: 0,
        totalBytes: 0,
      },
    });
    expect(
      (await fs.readJson<PythonSeedManifest>(path.join(bundleDir, 'python-seed-manifest.json')))
        .packages
    ).toEqual([]);
  });
});
