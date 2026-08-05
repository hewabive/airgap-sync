import path from 'node:path';
import * as fs from './fs.js';
import {
  readBundleManifest,
  readDistTagsManifest,
  writeApplyReport,
  writeGitApplyReport,
  writeGitConfigReport,
  writeGiteaRepositoryProvisionReport,
  writePublishReport,
} from './bundle.js';
import { applyGitSources, type GitApplyProgressEvent, type GitHttpAuth } from './git-apply.js';
import { configureGitRewrites } from './git-config.js';
import { type GitCommandRunner } from './git-fetch.js';
import {
  resolveGitPublishTargets,
  type GitOwnerStrategy,
  type GitPublishOwnerKind,
} from './git-publish-targets.js';
import {
  assumeGiteaRepositoriesExist,
  provisionGiteaRepositories,
  type GiteaClient,
} from './gitea.js';
import { publishBundle, type PublishBundleOptions } from './publisher.js';
import { readPythonSeedManifest, writePythonPublishReport } from './python/bundle.js';
import {
  publishPythonBundle,
  type PythonPublishAuth,
  type PythonPublishReport,
} from './python/publisher.js';
import {
  publishPythonGenericArtifacts,
  type PythonGenericPublishReport,
} from './python/generic-publisher.js';
import type {
  ApplyBundleReport,
  GiteaRepositoryProvisionReport,
  GitApplyReport,
  GitConfigReport,
  GitSourcesManifest,
  PublishReport,
} from '../types.js';
import { readPythonApplicationBundleIndex } from './python/application-bundle.js';
import {
  materializePythonPublication,
  type PythonPublicationManifest,
} from './python/publication-manifest.js';
import {
  defaultPythonPublicationProfile,
  resolvePythonPublicationProfile,
  type PythonPublicationProfile,
} from './python/publication-targets.js';

export interface ApplyBundleOptions {
  bundleDir: string;
  configureGitGlobal?: boolean;
  distTagConcurrency?: number;
  dryRun?: boolean;
  generatedAt?: string;
  gitAuth?: GitHttpAuth;
  gitAuthenticatedUser?: string;
  gitOwnerStrategy?: GitOwnerStrategy;
  gitPublishOwner?: string;
  gitPublishOwnerKind?: GitPublishOwnerKind;
  giteaBaseUrl: string;
  giteaClient: GiteaClient;
  mirrorsDir?: string;
  onProgress?: (event: ApplyProgressEvent) => void;
  onPublishProgress?: PublishBundleOptions['onProgress'];
  private?: boolean;
  pythonAuth?: PythonPublishAuth;
  pythonOwner?: string;
  pythonPublicationProfile?: PythonPublicationProfile;
  publishConcurrency?: number;
  registryUrl: string;
  runGitCommand?: GitCommandRunner;
  skipExisting?: boolean;
  skipGitProvision?: boolean;
}

export type ApplyProgressPhase =
  | 'publish'
  | 'python-publish'
  | 'python-application-publish'
  | 'gitea'
  | 'git-apply'
  | 'git-config'
  | 'report';

export type ApplyProgressStatus = 'start' | 'progress' | 'done' | 'error';

export interface ApplyProgressEvent {
  bytes?: number;
  current?: number;
  detail?: string;
  phase: ApplyProgressPhase;
  status: ApplyProgressStatus;
  total?: number;
  totalBytes?: number;
}

function emptyGitSourcesManifest(generatedAt: string): GitSourcesManifest {
  return {
    schemaVersion: 1,
    createdAt: generatedAt,
    sources: [],
    skipped: [],
  };
}

async function readOptionalGitSourcesManifest(
  bundleDir: string,
  generatedAt: string
): Promise<GitSourcesManifest> {
  const filePath = path.join(bundleDir, 'git-sources.json');
  if (!(await fs.pathExists(filePath))) {
    return emptyGitSourcesManifest(generatedAt);
  }

  return fs.readJson<GitSourcesManifest>(filePath);
}

function applySucceeded(reports: {
  gitApply: GitApplyReport;
  gitConfig?: GitConfigReport;
  gitea: GiteaRepositoryProvisionReport;
  publish: PublishReport;
  python?: PythonPublishReport;
  pythonApplications?: PythonGenericPublishReport;
}): boolean {
  return (
    reports.publish.errors.length === 0 &&
    (reports.python?.errors.length ?? 0) === 0 &&
    (reports.pythonApplications?.errors.length ?? 0) === 0 &&
    reports.gitea.errors.length === 0 &&
    reports.gitea.organizationErrors.length === 0 &&
    reports.gitApply.errors.length === 0 &&
    (reports.gitConfig?.errors.length ?? 0) === 0
  );
}

function blockedPythonPublishReport(
  manifest: Awaited<ReturnType<typeof readPythonSeedManifest>>,
  options: {
    dryRun: boolean;
    generatedAt: string;
    giteaBaseUrl: string;
    owner: string;
    reason: string;
  }
): PythonPublishReport {
  const baseUrl = options.giteaBaseUrl.replace(/\/+$/u, '');
  const actions = manifest.packages.flatMap((pkg) =>
    pkg.files.map((file) => ({
      error: options.reason,
      file: file.file,
      package: `${pkg.name}==${pkg.version}`,
      status: 'error' as const,
    }))
  );
  return {
    actions,
    dryRun: options.dryRun,
    enabled: true,
    errors: actions,
    generatedAt: options.generatedAt,
    indexUrl: `${baseUrl}/api/packages/${encodeURIComponent(options.owner)}/pypi/simple`,
    owner: options.owner,
    pipConfig: [
      '[global]',
      `index-url = ${baseUrl}/api/packages/${encodeURIComponent(options.owner)}/pypi/simple`,
      '',
    ].join('\n'),
    planned: 0,
    published: 0,
    skipped: 0,
    uploadUrl: `${baseUrl}/api/packages/${encodeURIComponent(options.owner)}/pypi`,
  };
}

function blockedPythonGenericPublishReport(options: {
  dryRun: boolean;
  generatedAt: string;
  owner: string;
  reason: string;
}): PythonGenericPublishReport {
  const action = {
    error: options.reason,
    file: 'python/application-index.json',
    owner: options.owner,
    package: '(application)',
    status: 'error' as const,
    version: '(publication)',
  };
  return {
    actions: [action],
    dryRun: options.dryRun,
    enabled: true,
    errors: [action],
    generatedAt: options.generatedAt,
    planned: 0,
    published: 0,
    skipped: 0,
  };
}

function mergeAssumedGitWithPackageOwners(
  assumed: GiteaRepositoryProvisionReport,
  packageOwners: GiteaRepositoryProvisionReport
): GiteaRepositoryProvisionReport {
  const organizations = new Map(
    assumed.organizations.map((organization) => [organization.owner, organization])
  );
  for (const organization of packageOwners.organizations) {
    organizations.set(organization.owner, organization);
  }
  const mergedOrganizations = [...organizations.values()].sort((left, right) =>
    left.owner.localeCompare(right.owner)
  );
  return {
    ...assumed,
    organizationCreated: mergedOrganizations.filter((item) => item.status === 'created').length,
    organizationErrors: mergedOrganizations.filter((item) => item.status === 'error'),
    organizationExists: mergedOrganizations.filter((item) => item.status === 'exists').length,
    organizationPlanned: mergedOrganizations.filter((item) => item.status === 'planned').length,
    organizations: mergedOrganizations,
    totalOrganizations: mergedOrganizations.length,
  };
}

function gitApplyProgressDetail(event: GitApplyProgressEvent): string | undefined {
  if (event.action) {
    return `${event.action.status} ${event.action.repository}`;
  }
  return event.repository ? `pushing ${event.repository}` : undefined;
}

export async function applyBundle(options: ApplyBundleOptions): Promise<ApplyBundleReport> {
  const bundleDir = path.resolve(options.bundleDir);
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const dryRun = options.dryRun === true;
  const manifest = await readBundleManifest(bundleDir);
  const distTags = await readDistTagsManifest(bundleDir);
  const sourceGitSources = await readOptionalGitSourcesManifest(bundleDir, generatedAt);
  const gitSources = resolveGitPublishTargets({
    ...(options.gitAuthenticatedUser ? { authenticatedUser: options.gitAuthenticatedUser } : {}),
    ...(options.gitPublishOwner ? { fixedOwner: options.gitPublishOwner } : {}),
    ...(options.gitPublishOwnerKind ? { fixedOwnerKind: options.gitPublishOwnerKind } : {}),
    manifest: sourceGitSources,
    ...(options.gitOwnerStrategy ? { strategy: options.gitOwnerStrategy } : {}),
  });
  const pythonManifest = (await fs.pathExists(path.join(bundleDir, 'python-seed-manifest.json')))
    ? await readPythonSeedManifest(bundleDir)
    : undefined;
  const pythonApplicationIndex = await readPythonApplicationBundleIndex(bundleDir);
  const hasPythonPublication = Boolean(pythonManifest ?? pythonApplicationIndex);
  const configuredPythonProfile =
    options.pythonPublicationProfile ?? defaultPythonPublicationProfile();
  const pythonProfile = hasPythonPublication
    ? resolvePythonPublicationProfile(
        options.pythonOwner
          ? {
              ...configuredPythonProfile,
              pypiOwner: {
                kind: 'organization',
                name: options.pythonOwner,
                strategy: 'fixed-owner',
              },
            }
          : configuredPythonProfile,
        options.gitAuthenticatedUser
      )
    : undefined;
  const ownerRequirements =
    pythonProfile?.ownerRequirements.filter(
      (requirement) =>
        (pythonManifest !== undefined && requirement.purposes.includes('pypi')) ||
        (pythonApplicationIndex !== undefined && requirement.purposes.includes('generic'))
    ) ?? [];

  options.onProgress?.({ phase: 'gitea', status: 'start' });
  let gitea: GiteaRepositoryProvisionReport;
  if (options.skipGitProvision === true && !dryRun) {
    const assumed = assumeGiteaRepositoriesExist({
      generatedAt,
      giteaBaseUrl: options.giteaBaseUrl,
      manifest: gitSources,
      private: options.private ?? true,
    });
    if (ownerRequirements.length === 0) {
      gitea = assumed;
    } else {
      const packageOwners = await provisionGiteaRepositories({
        client: options.giteaClient,
        generatedAt,
        giteaBaseUrl: options.giteaBaseUrl,
        manifest: emptyGitSourcesManifest(generatedAt),
        ownerRequirements,
        private: options.private ?? true,
      });
      gitea = mergeAssumedGitWithPackageOwners(assumed, packageOwners);
    }
  } else {
    gitea = await provisionGiteaRepositories({
      client: options.giteaClient,
      dryRun,
      generatedAt,
      giteaBaseUrl: options.giteaBaseUrl,
      manifest: gitSources,
      ownerRequirements,
      private: options.private ?? true,
    });
  }
  await writeGiteaRepositoryProvisionReport(bundleDir, gitea);
  options.onProgress?.({ phase: 'gitea', status: 'done' });
  const packageOwnerErrors = new Set(
    gitea.organizationErrors
      .filter((error) => ownerRequirements.some((requirement) => requirement.name === error.owner))
      .map((error) => error.owner)
  );

  options.onProgress?.({ phase: 'publish', status: 'start' });
  const publish = await publishBundle(manifest, distTags, {
    bundleDir,
    ...(options.distTagConcurrency === undefined
      ? {}
      : { distTagConcurrency: options.distTagConcurrency }),
    dryRun,
    ...(options.publishConcurrency === undefined
      ? {}
      : { publishConcurrency: options.publishConcurrency }),
    registryUrl: options.registryUrl,
    ...(options.onPublishProgress ? { onProgress: options.onPublishProgress } : {}),
    ...(options.skipExisting === undefined ? {} : { skipExisting: options.skipExisting }),
  });
  await writePublishReport(bundleDir, publish);
  options.onProgress?.({ phase: 'publish', status: 'done' });

  let python: PythonPublishReport | undefined;
  if (pythonManifest) {
    const owner = pythonProfile!.pypiOwner.name;
    python = packageOwnerErrors.has(owner)
      ? blockedPythonPublishReport(pythonManifest, {
          dryRun,
          generatedAt,
          giteaBaseUrl: options.giteaBaseUrl,
          owner,
          reason: `Gitea owner ${owner} could not be provisioned`,
        })
      : await publishPythonBundle(pythonManifest, {
          ...(options.pythonAuth ? { auth: options.pythonAuth } : {}),
          bundleDir,
          dryRun,
          generatedAt,
          giteaBaseUrl: options.giteaBaseUrl,
          ...(options.onProgress
            ? {
                onProgress: (event) => {
                  options.onProgress?.({ ...event, phase: 'python-publish' });
                },
              }
            : {}),
          owner,
          ...(options.publishConcurrency === undefined
            ? {}
            : { concurrency: options.publishConcurrency }),
        });
    await writePythonPublishReport(bundleDir, python);
  }

  let publicationManifest: PythonPublicationManifest | undefined;
  let pythonApplications: PythonGenericPublishReport;
  if (pythonApplicationIndex && pythonProfile?.publishEvidence) {
    const owner = pythonProfile.genericOwner.name;
    if (packageOwnerErrors.has(owner)) {
      pythonApplications = blockedPythonGenericPublishReport({
        dryRun,
        generatedAt,
        owner,
        reason: `Gitea owner ${owner} could not be provisioned`,
      });
      await fs.writeJsonAtomic(
        path.join(
          bundleDir,
          dryRun
            ? 'python-application-publish-dry-run-report.json'
            : 'python-application-publish-report.json'
        ),
        pythonApplications,
        { spaces: 2 }
      );
    } else {
      publicationManifest = await materializePythonPublication(options.giteaBaseUrl, {
        bundleDir,
        index: pythonApplicationIndex,
        profile: pythonProfile,
        write: !dryRun,
      });
      pythonApplications = await publishPythonGenericArtifacts({
        ...(options.pythonAuth ? { auth: options.pythonAuth } : {}),
        bundleDir,
        dryRun,
        generatedAt,
        giteaBaseUrl: options.giteaBaseUrl,
        ...(options.onProgress
          ? {
              onProgress: (event) => {
                options.onProgress?.({ ...event, phase: 'python-application-publish' });
              },
            }
          : {}),
        ...(options.publishConcurrency === undefined
          ? {}
          : { concurrency: options.publishConcurrency }),
        publicationManifest,
      });
    }
  } else {
    pythonApplications = {
      actions: [],
      dryRun,
      enabled: false,
      errors: [],
      generatedAt,
      planned: 0,
      published: 0,
      skipped: 0,
    };
  }

  const gitApply = await applyGitSources({
    bundleDir,
    dryRun,
    generatedAt,
    ...(options.gitAuth ? { gitAuth: options.gitAuth } : {}),
    giteaBaseUrl: options.giteaBaseUrl,
    manifest: gitSources,
    ...(options.mirrorsDir ? { mirrorsDir: options.mirrorsDir } : {}),
    ...(options.onProgress
      ? {
          onProgress: (event: GitApplyProgressEvent) => {
            const detail = gitApplyProgressDetail(event);
            options.onProgress?.({
              current: event.current,
              ...(detail ? { detail } : {}),
              phase: 'git-apply',
              status: event.status,
              total: event.total,
            });
          },
        }
      : {}),
    ...(options.runGitCommand ? { runner: options.runGitCommand } : {}),
  });
  await writeGitApplyReport(bundleDir, gitApply);

  const gitConfig = options.configureGitGlobal
    ? await (async () => {
        options.onProgress?.({ phase: 'git-config', status: 'start' });
        const report = await configureGitRewrites({
          dryRun,
          generatedAt,
          giteaBaseUrl: options.giteaBaseUrl,
          manifest: gitSources,
          ...(options.runGitCommand ? { runner: options.runGitCommand } : {}),
        });
        options.onProgress?.({ phase: 'git-config', status: 'done' });
        return report;
      })()
    : undefined;
  if (gitConfig) {
    await writeGitConfigReport(bundleDir, gitConfig);
  }

  const report: ApplyBundleReport = {
    dryRun,
    generatedAt,
    gitApply,
    ...(gitConfig ? { gitConfig } : {}),
    gitea,
    publish,
    ...(python ? { python } : {}),
    ...(pythonApplications.enabled ? { pythonApplications } : {}),
    registryUrl: options.registryUrl,
    succeeded: applySucceeded({
      gitApply,
      ...(gitConfig ? { gitConfig } : {}),
      gitea,
      publish,
      ...(python ? { python } : {}),
      ...(pythonApplications.enabled ? { pythonApplications } : {}),
    }),
  };
  options.onProgress?.({ phase: 'report', status: 'start' });
  await writeApplyReport(bundleDir, report);
  options.onProgress?.({ phase: 'report', status: 'done' });

  return report;
}
