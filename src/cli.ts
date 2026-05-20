#!/usr/bin/env node

import { Command } from 'commander';
import { packageName, parseRootSpecs } from './index.js';

interface FetchOptions {
  dryRun?: boolean;
  includeDev?: boolean;
  includePeer?: boolean;
  manifest?: string;
  output: string;
  registry: string;
}

const program = new Command();

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
  .action((specs: string[], options: FetchOptions) => {
    if (specs.length === 0 && !options.manifest) {
      console.error('Error: provide at least one package spec or --manifest <path>');
      process.exitCode = 1;
      return;
    }

    if (options.manifest) {
      console.log('manifest input is not implemented yet');
    }

    const parsedSpecs = parseRootSpecs(specs);
    console.log('fetch resolver is not implemented yet');
    console.log(JSON.stringify({ options, ...parsedSpecs }, null, 2));
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
