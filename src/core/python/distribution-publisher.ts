import path from 'node:path';
import { mapConcurrent } from '../concurrency.js';
import * as fs from '../fs.js';
import { readCpythonDistributionBundleIndex } from './distribution-bundle.js';
import {
  normalizeGiteaGenericBaseUrl,
  publishGiteaGenericPackageFile,
  validateGiteaGenericCoordinate,
  type PythonGenericPublishAuth,
} from './generic-publisher.js';
import {
  createPythonFilePublishProgress,
  type PythonPublishProgressEvent,
} from './publish-progress.js';

export const cpythonDistributionPublishReportPath = 'python/distributions/publish-report.json';
export const cpythonDistributionPublishDryRunReportPath =
  'python/distributions/publish-dry-run-report.json';

export interface CpythonDistributionPublishAction {
  error?: string;
  file: string;
  id: string;
  owner: string;
  package: string;
  status: 'error' | 'planned' | 'published' | 'skipped';
  version: string;
}

export interface CpythonDistributionPublishReport {
  actions: CpythonDistributionPublishAction[];
  dryRun: boolean;
  enabled: boolean;
  errors: CpythonDistributionPublishAction[];
  generatedAt: string;
  owner?: string;
  planned: number;
  published: number;
  skipped: number;
}

export interface PublishCpythonDistributionsOptions {
  auth?: PythonGenericPublishAuth;
  bundleDir: string;
  concurrency?: number;
  dryRun?: boolean;
  fetch?: typeof globalThis.fetch;
  generatedAt?: string;
  giteaBaseUrl: string;
  onProgress?: (event: PythonPublishProgressEvent) => void;
  owner: string;
  timeoutMs?: number;
}

export async function publishCpythonDistributions(
  options: PublishCpythonDistributionsOptions
): Promise<CpythonDistributionPublishReport> {
  const bundleDir = path.resolve(options.bundleDir);
  const dryRun = options.dryRun === true;
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const owner = validateGiteaGenericCoordinate(options.owner, 'owner');
  const packageName = validateGiteaGenericCoordinate('python-build-standalone', 'package name');
  const index = await readCpythonDistributionBundleIndex(bundleDir);
  options.onProgress?.({ current: 0, status: 'start' });
  if (!index) {
    const report: CpythonDistributionPublishReport = {
      actions: [],
      dryRun,
      enabled: false,
      errors: [],
      generatedAt,
      planned: 0,
      published: 0,
      skipped: 0,
    };
    options.onProgress?.({ current: 0, status: 'done', total: 0 });
    return report;
  }

  const artifacts = [...index.artifacts].sort(
    (left, right) =>
      left.providerBuild.localeCompare(right.providerBuild) ||
      left.filename.localeCompare(right.filename)
  );
  let completed = 0;
  const baseUrl = normalizeGiteaGenericBaseUrl(options.giteaBaseUrl);
  const actions = await mapConcurrent(
    artifacts,
    Math.max(1, options.concurrency ?? 4),
    async (artifact): Promise<CpythonDistributionPublishAction> => {
      const common = {
        file: artifact.file,
        id: artifact.id,
        owner,
        package: packageName,
        version: validateGiteaGenericCoordinate(artifact.providerBuild, 'version'),
      };
      let action: CpythonDistributionPublishAction;
      if (dryRun) {
        action = { ...common, status: 'planned' };
      } else if (!options.auth) {
        action = {
          ...common,
          error: 'CPython distribution publishing requires a Gitea username and token',
          status: 'error',
        };
      } else {
        const onFileProgress = options.onProgress
          ? createPythonFilePublishProgress({
              current: () => completed,
              filename: artifact.filename,
              onProgress: options.onProgress,
              total: artifacts.length,
            })
          : undefined;
        try {
          action = {
            ...common,
            status: await publishGiteaGenericPackageFile({
              auth: options.auth,
              baseUrl,
              bundleDir,
              fetch: options.fetch ?? globalThis.fetch,
              file: {
                expectedSha256: artifact.sha256,
                file: artifact.file,
                filename: validateGiteaGenericCoordinate(artifact.filename, 'filename'),
                owner,
                package: packageName,
                version: artifact.providerBuild,
              },
              ...(onFileProgress ? { onProgress: onFileProgress } : {}),
              timeoutMs: options.timeoutMs ?? 300_000,
            }),
          };
        } catch (error) {
          action = { ...common, error: (error as Error).message, status: 'error' };
        }
      }
      completed++;
      options.onProgress?.({
        current: completed,
        detail: `${action.status} ${artifact.filename}${action.error ? `: ${action.error}` : ''}`,
        status: 'progress',
        total: artifacts.length,
      });
      return action;
    }
  );
  const errors = actions.filter((action) => action.status === 'error');
  const report: CpythonDistributionPublishReport = {
    actions,
    dryRun,
    enabled: true,
    errors,
    generatedAt,
    owner,
    planned: actions.filter((action) => action.status === 'planned').length,
    published: actions.filter((action) => action.status === 'published').length,
    skipped: actions.filter((action) => action.status === 'skipped').length,
  };
  await fs.writeJsonAtomic(
    path.join(
      bundleDir,
      dryRun ? cpythonDistributionPublishDryRunReportPath : cpythonDistributionPublishReportPath
    ),
    report,
    { spaces: 2 }
  );
  options.onProgress?.({
    current: artifacts.length,
    ...(errors.length > 0 ? { detail: `${String(errors.length)} errors` } : {}),
    status: errors.length > 0 ? 'error' : 'done',
    total: artifacts.length,
  });
  return report;
}
