#!/usr/bin/env node

import { Command } from 'commander';
import {
  applyGitMirrors,
  CachedRegistryClient,
  configureGitRewrites,
  createGitMirrorPlan,
  createGitSourcesManifest,
  createBundleDocuments,
  createFetchReport,
  fetchGitMirrors,
  fetchSeedBundle,
  HttpGiteaClient,
  HttpRegistryClient,
  packageName,
  parseRootSpecs,
  publishBundle,
  readBundleInfo,
  readFetchReport,
  readGitMirrorPlan,
  readManifestRequirements,
  readBundleManifest,
  readDistTagsManifest,
  updateRepositories,
  writeBundleDocuments,
  writeFetchReport,
  writeGiteaRepositoryProvisionReport,
  writeGitApplyReport,
  writeGitConfigReport,
  writeGitFetchReport,
  writeGitMirrorPlan,
  writeGitSourcesManifest,
  writePublishReport,
  provisionGiteaRepositories,
} from './index.js';
import type { GiteaClient } from './index.js';
import type { FetchSeedBundleResult, ResolveRootRequirementsResult } from './index.js';

interface FetchOptions {
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

interface GitPlanOptions {
  gitea: string;
  owner: string;
  write?: boolean;
}

interface GitSourcesOptions {
  write?: boolean;
}

interface GitFetchOptions {
  dryRun?: boolean;
  mirrorsDir?: string;
}

interface GitApplyOptions {
  dryRun?: boolean;
  mirrorsDir?: string;
}

interface GitConfigOptions {
  dryRun?: boolean;
  global?: boolean;
}

interface GitCreateReposOptions {
  dryRun?: boolean;
  ownerType: string;
  public?: boolean;
  token?: string;
}

interface ReposUpdateOptions {
  dryRun?: boolean;
}

const noopGiteaClient: GiteaClient = {
  createRepository: () => Promise.resolve(),
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
  .command('fetch')
  .description('Resolve dependencies and build an airgap bundle')
  .argument('[specs...]', 'Package specs to seed, e.g. react@latest')
  .option('-o, --output <dir>', 'Bundle output directory', './airgap-bundle')
  .option('-r, --registry <url>', 'Source registry URL', 'https://registry.npmjs.org')
  .option('--manifest <path>', 'Read root dependencies from a package.json')
  .option('--include-dev', 'Include root devDependencies')
  .option('--include-peer', 'Traverse peerDependencies')
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
  .command('plan')
  .description('Create a Gitea mirror plan from bundle Git requirements')
  .argument('<bundle>', 'Path to airgap bundle directory')
  .requiredOption('--gitea <url>', 'Closed-network Gitea base URL')
  .requiredOption('--owner <owner>', 'Gitea user or organization that will own mirror repositories')
  .option('--write', 'Write git-plan.json into the bundle')
  .action(async (bundle: string, options: GitPlanOptions) => {
    try {
      const fetchReport = await readFetchReport(bundle);
      const gitRequirements = Array.isArray(fetchReport.gitRequirements)
        ? fetchReport.gitRequirements
        : [];
      const plan = createGitMirrorPlan(gitRequirements, {
        giteaBaseUrl: options.gitea,
        owner: options.owner,
      });

      if (options.write === true) {
        await writeGitMirrorPlan(bundle, plan);
      }

      console.log(JSON.stringify(plan, null, 2));

      if (plan.skipped.length > 0) {
        process.exitCode = 1;
      }
    } catch (error) {
      console.error(`Error: ${(error as Error).message}`);
      process.exitCode = 1;
    }
  });

gitCommand
  .command('fetch')
  .description('Clone or update local bare mirrors from git-plan.json')
  .argument('<bundle>', 'Path to airgap bundle directory')
  .option('--mirrors-dir <dir>', 'Directory for bare Git mirrors')
  .option('--dry-run', 'Print planned mirror fetch operations without running Git')
  .action(async (bundle: string, options: GitFetchOptions) => {
    try {
      const plan = await readGitMirrorPlan(bundle);
      const report = await fetchGitMirrors({
        bundleDir: bundle,
        dryRun: options.dryRun === true,
        plan,
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
  .option('--mirrors-dir <dir>', 'Directory containing bare Git mirrors')
  .option('--dry-run', 'Print planned mirror push operations without running Git')
  .action(async (bundle: string, options: GitApplyOptions) => {
    try {
      const plan = await readGitMirrorPlan(bundle);
      const report = await applyGitMirrors({
        bundleDir: bundle,
        dryRun: options.dryRun === true,
        plan,
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
  .description('Configure Git URL rewrites from git-plan.json')
  .argument('<bundle>', 'Path to airgap bundle directory')
  .requiredOption('--global', 'Write rewrite rules into the global Git config')
  .option('--dry-run', 'Print planned Git config operations without writing config')
  .action(async (bundle: string, options: GitConfigOptions) => {
    try {
      const plan = await readGitMirrorPlan(bundle);
      const report = await configureGitRewrites({
        dryRun: options.dryRun === true,
        plan,
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
  .description('Create missing Gitea repositories from git-plan.json')
  .argument('<bundle>', 'Path to airgap bundle directory')
  .option('--token <token>', 'Gitea API token, defaults to GITEA_TOKEN')
  .option('--owner-type <type>', 'Gitea owner type: user or org', 'user')
  .option('--public', 'Create public repositories instead of private repositories')
  .option('--dry-run', 'Print planned repository creation without calling Gitea')
  .action(async (bundle: string, options: GitCreateReposOptions) => {
    try {
      if (options.ownerType !== 'user' && options.ownerType !== 'org') {
        console.error('Error: --owner-type must be user or org');
        process.exitCode = 1;
        return;
      }

      const plan = await readGitMirrorPlan(bundle);
      const token = options.token ?? process.env.GITEA_TOKEN;
      if (!token && options.dryRun !== true) {
        console.error('Error: provide --token <token> or set GITEA_TOKEN');
        process.exitCode = 1;
        return;
      }

      const client =
        options.dryRun === true
          ? noopGiteaClient
          : new HttpGiteaClient(plan.giteaBaseUrl, { authToken: token ?? '' });
      const report = await provisionGiteaRepositories({
        client,
        dryRun: options.dryRun === true,
        ownerType: options.ownerType,
        plan,
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
