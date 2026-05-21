#!/usr/bin/env node

import path from 'node:path';
import { Command } from 'commander';
import {
  addWorkspaceTarget,
  applyGitSources,
  CachedRegistryClient,
  collectBundle,
  configureGitRewrites,
  createGitSourcesManifest,
  createBundleDocuments,
  createFetchReport,
  defaultWorkspaceSourceRegistry,
  fetchGitSources,
  fetchSeedBundle,
  HttpGiteaClient,
  HttpRegistryClient,
  initWorkspace,
  materializeWorkspaceGitTargets,
  packageName,
  parseRootSpecs,
  publishBundle,
  readBundleInfo,
  readFetchReport,
  readGitSourcesManifest,
  readManifestRequirements,
  readBundleManifest,
  readDistTagsManifest,
  readWorkspaceConfig,
  removeWorkspaceTarget,
  updateRepositories,
  writeBundleDocuments,
  writeFetchReport,
  writeGiteaRepositoryProvisionReport,
  writeGitApplyReport,
  writeGitConfigReport,
  writeGitFetchReport,
  writeGitSourcesManifest,
  writePublishReport,
  provisionGiteaRepositories,
} from './index.js';
import type { GiteaClient } from './index.js';
import type {
  FetchSeedBundleResult,
  PublishProgressEvent,
  PublishProgressPhase,
  ResolveRootRequirementsResult,
} from './index.js';

interface FetchOptions {
  concurrency: number;
  dryRun?: boolean;
  includeDev?: boolean;
  includePeer?: boolean;
  manifest?: string;
  output: string;
  registry: string;
}

interface PublishOptions {
  dryRun?: boolean;
  registry: string;
  skipExisting?: boolean;
}

interface CollectOptions {
  concurrency: number;
  dryRun?: boolean;
  includeDev?: boolean;
  includePeer?: boolean;
  output?: string;
  registry?: string;
}

interface InitOptions {
  force?: boolean;
}

interface TargetGitOptions {
  branch?: string;
}

interface GitSourcesOptions {
  write?: boolean;
}

function parsePositiveInteger(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`Expected a positive integer, got: ${value}`);
  }
  return parsed;
}

function collectShouldFail(report: {
  fetch: { errors: unknown[] };
  gitFetch: { errors: unknown[] };
  gitManifestScanErrors: unknown[];
  gitSources: { skipped: unknown[] };
  maxIterationsReached: boolean;
  repositoryUpdate: { errors: unknown[] };
}): boolean {
  return (
    report.repositoryUpdate.errors.length > 0 ||
    report.fetch.errors.length > 0 ||
    report.gitSources.skipped.length > 0 ||
    report.gitFetch.errors.length > 0 ||
    report.gitManifestScanErrors.length > 0 ||
    report.maxIterationsReached
  );
}

function targetToDisplay(target: { branch?: string; spec?: string; type: string; url?: string }) {
  return target.type === 'git'
    ? {
        branch: target.branch,
        type: target.type,
        url: target.url,
      }
    : {
        spec: target.spec,
        type: target.type,
      };
}

interface GitFetchOptions {
  dryRun?: boolean;
  mirrorsDir?: string;
}

interface GitApplyOptions {
  dryRun?: boolean;
  gitea: string;
  mirrorsDir?: string;
}

interface GitConfigOptions {
  dryRun?: boolean;
  gitea: string;
  global?: boolean;
}

const publishPhaseLabels: Record<PublishProgressPhase, string> = {
  cleanup: 'cleanup temp tags',
  'dist-tags': 'restore dist-tags',
  'dry-run': 'plan publish',
  'lookup-metadata': 'lookup registry metadata',
  publish: 'publish packages',
  validate: 'validate bundle',
};

function createPublishProgressLogger(): (event: PublishProgressEvent) => void {
  const lastLogged = new Map<PublishProgressPhase, number>();

  return (event) => {
    const label = publishPhaseLabels[event.phase];

    if (event.status === 'start') {
      const total = event.total === undefined ? '' : ` (${String(event.total)})`;
      console.error(`[publish] ${label}: started${total}`);
      return;
    }

    if (event.status === 'done') {
      const total =
        event.total === undefined
          ? ''
          : ` (${String(event.current ?? event.total)}/${String(event.total)})`;
      console.error(`[publish] ${label}: done${total}`);
      return;
    }

    if (event.status === 'planned') {
      console.error(`[publish] ${label}: ${String(event.current ?? 0)} actions`);
      return;
    }

    if (event.current === undefined || event.total === undefined) {
      return;
    }

    const last = lastLogged.get(event.phase) ?? 0;
    const shouldLog =
      event.status === 'error' ||
      event.current === event.total ||
      event.current === 1 ||
      event.current - last >= Math.max(1, Math.ceil(event.total / 20));

    if (!shouldLog) {
      return;
    }

    lastLogged.set(event.phase, event.current);
    const subject = event.package ? ` ${event.package}${event.tag ? `#${event.tag}` : ''}` : '';
    console.error(
      `[publish] ${label}: ${String(event.current)}/${String(event.total)} ${event.status}${subject}`
    );
  };
}

interface GitCreateReposOptions {
  dryRun?: boolean;
  gitea: string;
  public?: boolean;
  token?: string;
}

interface ReposUpdateOptions {
  dryRun?: boolean;
}

const noopGiteaClient: GiteaClient = {
  createOrganization: () => Promise.resolve(),
  createRepository: () => Promise.resolve(),
  organizationExists: () => Promise.resolve(false),
  repositoryExists: () => Promise.resolve(false),
};

const program = new Command();

function toFetchPreview(result: ResolveRootRequirementsResult) {
  return {
    resolved: result.resolved.map((pkg) => ({
      name: pkg.name,
      version: pkg.version,
      raw: pkg.raw,
      specifier: pkg.specifier,
      type: pkg.type,
      resolvedVia: pkg.resolvedVia,
      alias: pkg.alias,
      tarball: pkg.dist.tarball,
    })),
    errors: result.errors,
    tagRequirements: result.tagRequirements,
  };
}

function toFetchDryRun(result: FetchSeedBundleResult) {
  return {
    downloaded: result.downloaded,
    gitRequirements: result.gitRequirements,
    skipped: result.skipped,
    wouldDownload: result.wouldDownload,
    ...toFetchPreview(result),
    unsupported: result.unsupported,
  };
}

program
  .name(packageName)
  .description('Sync Git and npm dependencies for airgapped environments')
  .version('0.0.0');

program
  .command('init')
  .description('Create an airgap-sync workspace on portable media')
  .argument('[workspace]', 'Workspace directory', '.')
  .option('--force', 'Overwrite an existing airgap-sync.json')
  .action(async (workspace: string, options: InitOptions) => {
    try {
      const config = await initWorkspace({
        force: options.force === true,
        workspaceDir: workspace,
      });
      console.log(
        JSON.stringify(
          {
            config,
            workspace: path.resolve(workspace),
          },
          null,
          2
        )
      );
    } catch (error) {
      console.error(`Error: ${(error as Error).message}`);
      process.exitCode = 1;
    }
  });

const targetCommand = program.command('target').description('Manage workspace sync targets');

targetCommand
  .command('list')
  .description('List targets from airgap-sync.json')
  .argument('[workspace]', 'Workspace directory', '.')
  .action(async (workspace: string) => {
    try {
      const config = await readWorkspaceConfig(workspace);
      console.log(
        JSON.stringify(
          {
            targets: config.targets.map((target, index) => ({
              index: index + 1,
              ...targetToDisplay(target),
            })),
            workspace: path.resolve(workspace),
          },
          null,
          2
        )
      );
    } catch (error) {
      console.error(`Error: ${(error as Error).message}`);
      process.exitCode = 1;
    }
  });

const targetAddCommand = targetCommand.command('add').description('Add a workspace target');

targetAddCommand
  .command('git')
  .description('Add a Git repository target')
  .argument('<url>', 'Git repository URL')
  .argument('[workspace]', 'Workspace directory', '.')
  .option('--branch <name>', 'Branch to clone on first materialization')
  .action(async (url: string, workspace: string, options: TargetGitOptions) => {
    try {
      const result = await addWorkspaceTarget(workspace, {
        ...(options.branch ? { branch: options.branch } : {}),
        type: 'git',
        url,
      });
      console.log(
        JSON.stringify(
          {
            added: result.added,
            target: targetToDisplay({
              ...(options.branch ? { branch: options.branch } : {}),
              type: 'git',
              url,
            }),
            totalTargets: result.config.targets.length,
            workspace: path.resolve(workspace),
          },
          null,
          2
        )
      );
    } catch (error) {
      console.error(`Error: ${(error as Error).message}`);
      process.exitCode = 1;
    }
  });

targetAddCommand
  .command('npm')
  .description('Add an npm package spec target')
  .argument('<spec>', 'Package spec, e.g. eslint@latest')
  .argument('[workspace]', 'Workspace directory', '.')
  .action(async (spec: string, workspace: string) => {
    try {
      const result = await addWorkspaceTarget(workspace, {
        spec,
        type: 'npm',
      });
      console.log(
        JSON.stringify(
          {
            added: result.added,
            target: targetToDisplay({ spec, type: 'npm' }),
            totalTargets: result.config.targets.length,
            workspace: path.resolve(workspace),
          },
          null,
          2
        )
      );
    } catch (error) {
      console.error(`Error: ${(error as Error).message}`);
      process.exitCode = 1;
    }
  });

targetCommand
  .command('remove')
  .description('Remove a target by its one-based list index')
  .argument('<index>', 'Target index from target list')
  .argument('[workspace]', 'Workspace directory', '.')
  .action(async (index: string, workspace: string) => {
    try {
      const result = await removeWorkspaceTarget(workspace, parsePositiveInteger(index));
      console.log(
        JSON.stringify(
          {
            removed: targetToDisplay(result.removed),
            totalTargets: result.config.targets.length,
            workspace: path.resolve(workspace),
          },
          null,
          2
        )
      );
    } catch (error) {
      console.error(`Error: ${(error as Error).message}`);
      process.exitCode = 1;
    }
  });

program
  .command('collect')
  .description('Update repositories and build an online airgap bundle')
  .argument('[root]', 'Directory containing project Git repositories or package manifests')
  .option('-o, --output <dir>', 'Bundle output directory')
  .option('-r, --registry <url>', 'Source registry URL')
  .option('--include-dev', 'Include root devDependencies')
  .option('--include-peer', 'Traverse peerDependencies')
  .option(
    '--concurrency <count>',
    'Parallel npm resolve/download workers',
    parsePositiveInteger,
    16
  )
  .option('--dry-run', 'Resolve and report without pulling, downloading, or cloning')
  .action(async (root: string | undefined, options: CollectOptions) => {
    try {
      if (!root) {
        const workspaceDir = process.cwd();
        const config = await readWorkspaceConfig(workspaceDir);
        const targetSync = await materializeWorkspaceGitTargets({
          config,
          dryRun: options.dryRun === true,
          workspaceDir,
        });
        const parsedTargets = parseRootSpecs(
          config.targets.filter((target) => target.type === 'npm').map((target) => target.spec)
        );
        const registryUrl = options.registry ?? config.sourceRegistry;
        const outputDir = path.resolve(workspaceDir, options.output ?? config.output);
        const registry = new CachedRegistryClient(new HttpRegistryClient(registryUrl));
        const report = await collectBundle({
          dryRun: options.dryRun === true,
          concurrency: options.concurrency,
          includeDev: options.includeDev === true,
          includePeer: options.includePeer === true,
          initialGitRequirements: parsedTargets.gitRequirements,
          initialRequirements: parsedTargets.requirements,
          initialUnsupported: parsedTargets.unsupported,
          outputDir,
          registry,
          registryUrl,
          root: path.resolve(workspaceDir, config.reposDir),
        });

        console.log(
          JSON.stringify(
            {
              targetSync,
              ...report,
            },
            null,
            2
          )
        );

        if (targetSync.errors.length > 0 || collectShouldFail(report)) {
          process.exitCode = 1;
        }
        return;
      }

      const registryUrl = options.registry ?? defaultWorkspaceSourceRegistry;
      const outputDir = options.output ?? './airgap-bundle';
      const registry = new CachedRegistryClient(new HttpRegistryClient(registryUrl));
      const report = await collectBundle({
        dryRun: options.dryRun === true,
        concurrency: options.concurrency,
        includeDev: options.includeDev === true,
        includePeer: options.includePeer === true,
        outputDir,
        registry,
        registryUrl,
        root,
      });

      console.log(JSON.stringify(report, null, 2));

      if (collectShouldFail(report)) {
        process.exitCode = 1;
      }
    } catch (error) {
      console.error(`Error: ${(error as Error).message}`);
      process.exitCode = 1;
    }
  });

program
  .command('fetch')
  .description('Resolve dependencies and build an airgap bundle')
  .argument('[specs...]', 'Package specs to seed, e.g. react@latest')
  .option('-o, --output <dir>', 'Bundle output directory', './airgap-bundle')
  .option('-r, --registry <url>', 'Source registry URL', 'https://registry.npmjs.org')
  .option('--manifest <path>', 'Read root dependencies from a package.json')
  .option('--include-dev', 'Include root devDependencies')
  .option('--include-peer', 'Traverse peerDependencies')
  .option(
    '--concurrency <count>',
    'Parallel npm resolve/download workers',
    parsePositiveInteger,
    16
  )
  .option('--dry-run', 'Resolve and report without downloading')
  .action(async (specs: string[], options: FetchOptions) => {
    if (specs.length === 0 && !options.manifest) {
      console.error('Error: provide at least one package spec or --manifest <path>');
      process.exitCode = 1;
      return;
    }

    const parsedSpecs = parseRootSpecs(specs);
    const parsedManifest = options.manifest
      ? await readManifestRequirements(options.manifest, {
          includeDev: options.includeDev === true,
          includePeer: options.includePeer === true,
        })
      : { gitRequirements: [], requirements: [], unsupported: [] };
    const requirements = [...parsedSpecs.requirements, ...parsedManifest.requirements];
    const unsupported = [...parsedSpecs.unsupported, ...parsedManifest.unsupported];
    const gitRequirements = [...parsedSpecs.gitRequirements, ...parsedManifest.gitRequirements];

    if (requirements.length === 0) {
      console.error('Error: no supported package specs to resolve');
      console.error(JSON.stringify({ unsupported }, null, 2));
      process.exitCode = 1;
      return;
    }

    const registry = new CachedRegistryClient(new HttpRegistryClient(options.registry));

    if (options.dryRun) {
      const resolution = await fetchSeedBundle({
        concurrency: options.concurrency,
        download: false,
        includePeer: options.includePeer === true,
        outputDir: options.output,
        registry,
        gitRequirements,
        requirements,
        unsupported,
      });
      console.log(JSON.stringify({ options, ...toFetchDryRun(resolution) }, null, 2));
      if (resolution.errors.length > 0) {
        process.exitCode = 1;
      }
      return;
    }

    const resolution = await fetchSeedBundle({
      concurrency: options.concurrency,
      includePeer: options.includePeer === true,
      outputDir: options.output,
      registry,
      gitRequirements,
      requirements,
      unsupported,
    });
    const success = resolution.errors.length === 0;

    if (success) {
      const documents = createBundleDocuments({
        outputDir: options.output,
        resolved: resolution.resolved,
        sourceRegistry: options.registry,
        tagRequirements: resolution.tagRequirements,
      });
      await writeBundleDocuments(options.output, documents);
      await writeFetchReport(
        options.output,
        createFetchReport({
          downloaded: resolution.downloaded,
          errors: resolution.errors,
          gitRequirements: resolution.gitRequirements,
          resolved: resolution.resolved.length,
          skipped: resolution.skipped,
          timings: resolution.timings,
          unsupported: resolution.unsupported,
        })
      );

      console.log(
        JSON.stringify(
          {
            output: options.output,
            downloaded: resolution.downloaded,
            skipped: resolution.skipped,
            resolved: resolution.resolved.length,
            timings: resolution.timings,
            tagRequirements: resolution.tagRequirements.length,
          },
          null,
          2
        )
      );
    } else {
      console.log(JSON.stringify({ options, unsupported, ...toFetchPreview(resolution) }, null, 2));
    }

    if (!success) {
      process.exitCode = 1;
    }
  });

program
  .command('publish')
  .description('Publish an airgap bundle into an npm-compatible registry')
  .argument('<bundle>', 'Path to airgap bundle directory')
  .requiredOption('-r, --registry <url>', 'Target registry URL')
  .option('--no-skip-existing', 'Attempt to publish versions that already exist')
  .option('--dry-run', 'Print planned operations without publishing')
  .action(async (bundle: string, options: PublishOptions) => {
    try {
      const manifest = await readBundleManifest(bundle);
      const distTags = await readDistTagsManifest(bundle);
      const report = await publishBundle(manifest, distTags, {
        bundleDir: bundle,
        dryRun: options.dryRun === true,
        onProgress: createPublishProgressLogger(),
        registryUrl: options.registry,
        skipExisting: options.skipExisting !== false,
      });

      await writePublishReport(bundle, report);
      console.log(JSON.stringify(report, null, 2));

      if (report.errors.length > 0) {
        process.exitCode = 1;
      }
    } catch (error) {
      console.error(`Error: ${(error as Error).message}`);
      process.exitCode = 1;
    }
  });

program
  .command('info')
  .description('Show information about an airgap bundle')
  .argument('<bundle>', 'Path to airgap bundle directory')
  .action(async (bundle: string) => {
    try {
      const info = await readBundleInfo(bundle);
      console.log(JSON.stringify(info, null, 2));
    } catch (error) {
      console.error(`Error: ${(error as Error).message}`);
      process.exitCode = 1;
    }
  });

const reposCommand = program.command('repos').description('Manage project Git repositories');

reposCommand
  .command('update')
  .description('Update Git repositories under a directory with safe fast-forward pulls')
  .argument('<root>', 'Directory containing Git repositories')
  .option('--dry-run', 'Check repositories without running git pull')
  .action(async (root: string, options: ReposUpdateOptions) => {
    try {
      const report = await updateRepositories({
        dryRun: options.dryRun === true,
        root,
      });

      console.log(JSON.stringify(report, null, 2));

      if (report.errors.length > 0) {
        process.exitCode = 1;
      }
    } catch (error) {
      console.error(`Error: ${(error as Error).message}`);
      process.exitCode = 1;
    }
  });

const gitCommand = program.command('git').description('Plan and operate Git mirrors');

gitCommand
  .command('sources')
  .description('Create portable Git source metadata from bundle Git requirements')
  .argument('<bundle>', 'Path to airgap bundle directory')
  .option('--write', 'Write git-sources.json into the bundle')
  .action(async (bundle: string, options: GitSourcesOptions) => {
    try {
      const fetchReport = await readFetchReport(bundle);
      const gitRequirements = Array.isArray(fetchReport.gitRequirements)
        ? fetchReport.gitRequirements
        : [];
      const manifest = createGitSourcesManifest(gitRequirements);

      if (options.write === true) {
        await writeGitSourcesManifest(bundle, manifest);
      }

      console.log(JSON.stringify(manifest, null, 2));

      if (manifest.skipped.length > 0) {
        process.exitCode = 1;
      }
    } catch (error) {
      console.error(`Error: ${(error as Error).message}`);
      process.exitCode = 1;
    }
  });

gitCommand
  .command('fetch')
  .description('Clone or update local bare mirrors from Git source metadata')
  .argument('<bundle>', 'Path to airgap bundle directory')
  .option('--mirrors-dir <dir>', 'Directory for bare Git mirrors')
  .option('--dry-run', 'Print planned mirror fetch operations without running Git')
  .action(async (bundle: string, options: GitFetchOptions) => {
    try {
      const manifest = await readGitSourcesManifest(bundle);
      const report = await fetchGitSources({
        bundleDir: bundle,
        dryRun: options.dryRun === true,
        manifest,
        ...(options.mirrorsDir ? { mirrorsDir: options.mirrorsDir } : {}),
      });

      await writeGitFetchReport(bundle, report);
      console.log(JSON.stringify(report, null, 2));

      if (report.errors.length > 0) {
        process.exitCode = 1;
      }
    } catch (error) {
      console.error(`Error: ${(error as Error).message}`);
      process.exitCode = 1;
    }
  });

gitCommand
  .command('apply')
  .description('Push local bare mirrors into Gitea and report Git rewrite rules')
  .argument('<bundle>', 'Path to airgap bundle directory')
  .requiredOption('--gitea <url>', 'Closed-network Gitea base URL')
  .option('--mirrors-dir <dir>', 'Directory containing bare Git mirrors')
  .option('--dry-run', 'Print planned mirror push operations without running Git')
  .action(async (bundle: string, options: GitApplyOptions) => {
    try {
      const manifest = await readGitSourcesManifest(bundle);
      const report = await applyGitSources({
        bundleDir: bundle,
        dryRun: options.dryRun === true,
        giteaBaseUrl: options.gitea,
        manifest,
        ...(options.mirrorsDir ? { mirrorsDir: options.mirrorsDir } : {}),
      });

      await writeGitApplyReport(bundle, report);
      console.log(JSON.stringify(report, null, 2));

      if (report.errors.length > 0) {
        process.exitCode = 1;
      }
    } catch (error) {
      console.error(`Error: ${(error as Error).message}`);
      process.exitCode = 1;
    }
  });

gitCommand
  .command('config')
  .description('Configure Git URL rewrites from git-sources.json')
  .argument('<bundle>', 'Path to airgap bundle directory')
  .requiredOption('--gitea <url>', 'Closed-network Gitea base URL')
  .requiredOption('--global', 'Write rewrite rules into the global Git config')
  .option('--dry-run', 'Print planned Git config operations without writing config')
  .action(async (bundle: string, options: GitConfigOptions) => {
    try {
      const manifest = await readGitSourcesManifest(bundle);
      const report = await configureGitRewrites({
        dryRun: options.dryRun === true,
        giteaBaseUrl: options.gitea,
        manifest,
      });

      await writeGitConfigReport(bundle, report);
      console.log(JSON.stringify(report, null, 2));

      if (report.errors.length > 0) {
        process.exitCode = 1;
      }
    } catch (error) {
      console.error(`Error: ${(error as Error).message}`);
      process.exitCode = 1;
    }
  });

gitCommand
  .command('create-repos')
  .description('Create missing Gitea repositories from git-sources.json')
  .argument('<bundle>', 'Path to airgap bundle directory')
  .requiredOption('--gitea <url>', 'Closed-network Gitea base URL')
  .option('--token <token>', 'Gitea API token, defaults to GITEA_TOKEN')
  .option('--public', 'Create public repositories instead of private repositories')
  .option('--dry-run', 'Print planned repository creation without calling Gitea')
  .action(async (bundle: string, options: GitCreateReposOptions) => {
    try {
      const manifest = await readGitSourcesManifest(bundle);
      const token = options.token ?? process.env.GITEA_TOKEN;
      if (!token && options.dryRun !== true) {
        console.error('Error: provide --token <token> or set GITEA_TOKEN');
        process.exitCode = 1;
        return;
      }

      const client =
        options.dryRun === true
          ? noopGiteaClient
          : new HttpGiteaClient(options.gitea, { authToken: token ?? '' });
      const report = await provisionGiteaRepositories({
        client,
        dryRun: options.dryRun === true,
        giteaBaseUrl: options.gitea,
        manifest,
        private: options.public !== true,
      });

      await writeGiteaRepositoryProvisionReport(bundle, report);
      console.log(JSON.stringify(report, null, 2));

      if (report.errors.length > 0) {
        process.exitCode = 1;
      }
    } catch (error) {
      console.error(`Error: ${(error as Error).message}`);
      process.exitCode = 1;
    }
  });

program.parse();
