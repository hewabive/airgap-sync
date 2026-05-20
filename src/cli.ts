#!/usr/bin/env node

import { Command } from 'commander';
import {
  createBundleDocuments,
  createFetchReport,
  downloadResolvedPackage,
  HttpRegistryClient,
  packageName,
  parseRootSpecs,
  resolveRootRequirements,
  writeBundleDocuments,
  writeFetchReport,
} from './index.js';

interface FetchOptions {
  dryRun?: boolean;
  includeDev?: boolean;
  includePeer?: boolean;
  manifest?: string;
  output: string;
  registry: string;
}

const program = new Command();

function toFetchPreview(result: Awaited<ReturnType<typeof resolveRootRequirements>>) {
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

program
  .name(packageName)
  .description('Build and publish npm registry seed bundles')
  .version('0.0.0');

program
  .command('fetch')
  .description('Resolve dependencies and build a seed bundle')
  .argument('[specs...]', 'Package specs to seed, e.g. react@latest')
  .option('-o, --output <dir>', 'Bundle output directory', './seed')
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

    if (options.manifest) {
      console.log('manifest input is not implemented yet');
    }

    const parsedSpecs = parseRootSpecs(specs);

    if (parsedSpecs.requirements.length === 0) {
      console.error('Error: no supported package specs to resolve');
      console.error(JSON.stringify({ unsupported: parsedSpecs.unsupported }, null, 2));
      process.exitCode = 1;
      return;
    }

    const registry = new HttpRegistryClient(options.registry);
    const resolution = await resolveRootRequirements(parsedSpecs.requirements, registry);
    const success = resolution.errors.length === 0;

    if (options.dryRun) {
      console.log(
        JSON.stringify(
          { options, unsupported: parsedSpecs.unsupported, ...toFetchPreview(resolution) },
          null,
          2
        )
      );
    } else if (success) {
      let downloaded = 0;
      let skipped = 0;

      for (const pkg of resolution.resolved) {
        const result = await downloadResolvedPackage(pkg, options.output);
        if (result.skipped) {
          skipped++;
        } else {
          downloaded++;
        }
      }

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
          downloaded,
          errors: resolution.errors,
          resolved: resolution.resolved.length,
          skipped,
          unsupported: parsedSpecs.unsupported,
        })
      );

      console.log(
        JSON.stringify(
          {
            output: options.output,
            downloaded,
            skipped,
            resolved: resolution.resolved.length,
            tagRequirements: resolution.tagRequirements.length,
          },
          null,
          2
        )
      );
    } else {
      console.log(
        JSON.stringify(
          { options, unsupported: parsedSpecs.unsupported, ...toFetchPreview(resolution) },
          null,
          2
        )
      );
    }

    if (!success) {
      process.exitCode = 1;
    }
  });

program
  .command('publish')
  .description('Publish a seed bundle into an npm-compatible registry')
  .argument('<bundle>', 'Path to seed bundle directory')
  .requiredOption('-r, --registry <url>', 'Target registry URL')
  .option('--no-skip-existing', 'Attempt to publish versions that already exist')
  .option('--dry-run', 'Print planned operations without publishing')
  .action((bundle: string, options: Record<string, unknown>) => {
    console.log('publish is not implemented yet');
    console.log(JSON.stringify({ bundle, options }, null, 2));
  });

program
  .command('info')
  .description('Show information about a seed bundle')
  .argument('<bundle>', 'Path to seed bundle directory')
  .action((bundle: string) => {
    console.log('info is not implemented yet');
    console.log(JSON.stringify({ bundle }, null, 2));
  });

program.parse();
