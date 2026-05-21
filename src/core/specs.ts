import npa from 'npm-package-arg';
import type {
  GitRequirement,
  ParseRootSpecsResult,
  RootPackageRequirement,
  SupportedSpecType,
  UnsupportedRootPackageRequirement,
} from '../types.js';

type NpaResult = npa.Result;
type RegistrySpecType = Exclude<SupportedSpecType, 'alias'>;

interface HostedGitInfo {
  domain?: string;
  project?: string;
  type?: string;
  user?: string;
}

type NpaGitResult = NpaResult & {
  gitCommittish?: string | undefined;
  gitRange?: string | undefined;
  gitSubdir?: string | undefined;
  hosted?: HostedGitInfo | undefined;
  rawSpec: string;
  type: 'git';
};

interface NpaAliasResult extends NpaResult {
  name: string;
  subSpec: NpaResult;
  type: 'alias';
}

const supportedRegistryTypes = new Set<NpaResult['type']>(['version', 'range', 'tag']);

function isAliasResult(parsed: NpaResult): parsed is NpaAliasResult {
  return parsed.type === 'alias' && typeof parsed.name === 'string' && 'subSpec' in parsed;
}

function isGitResult(parsed: NpaResult): parsed is NpaGitResult {
  return parsed.type === 'git';
}

function hasExplicitSpecifier(raw: string, name: string): boolean {
  if (name.startsWith('@')) {
    return raw.length > name.length && raw.startsWith(`${name}@`);
  }

  return raw.includes('@');
}

function toRegistryRequirement(
  parsed: NpaResult,
  raw: string,
  requiredBy: string,
  forcedSpecifier?: string,
  forcedType?: RegistrySpecType
): RootPackageRequirement | UnsupportedRootPackageRequirement {
  if (!parsed.name) {
    return {
      raw,
      reason: 'Package name could not be inferred from spec',
      requiredBy,
      type: parsed.type,
    };
  }

  if (!supportedRegistryTypes.has(parsed.type)) {
    return {
      raw,
      reason: `Unsupported package spec type: ${parsed.type}`,
      requiredBy,
      type: parsed.type,
    };
  }

  const specifier = forcedSpecifier ?? parsed.fetchSpec ?? parsed.rawSpec;
  const type = forcedType ?? (parsed.type as RegistrySpecType);

  return {
    name: parsed.name,
    raw,
    requiredBy,
    specifier,
    type,
  };
}

function normalizeBarePackage(parsed: NpaResult): { specifier?: string; type?: RegistrySpecType } {
  if (!parsed.name || hasExplicitSpecifier(parsed.raw, parsed.name)) {
    return {};
  }

  return {
    specifier: 'latest',
    type: 'tag',
  };
}

function normalizeVersionSpecifier(specifier: string, type: RegistrySpecType): string {
  return type === 'version' && specifier.startsWith('=') ? specifier.slice(1) : specifier;
}

function toGitRequirement(parsed: NpaGitResult, raw: string, requiredBy: string): GitRequirement {
  return {
    raw,
    rawSpec: parsed.rawSpec,
    requiredBy,
    ...(parsed.name ? { name: parsed.name } : {}),
    ...(parsed.fetchSpec ? { fetchSpec: parsed.fetchSpec } : {}),
    ...(parsed.gitCommittish ? { committish: parsed.gitCommittish } : {}),
    ...(parsed.gitRange ? { gitRange: parsed.gitRange } : {}),
    ...(parsed.gitSubdir ? { gitSubdir: parsed.gitSubdir } : {}),
    ...(parsed.hosted
      ? {
          hosted: {
            ...(parsed.hosted.domain ? { domain: parsed.hosted.domain } : {}),
            ...(parsed.hosted.project ? { project: parsed.hosted.project } : {}),
            ...(parsed.hosted.type ? { type: parsed.hosted.type } : {}),
            ...(parsed.hosted.user ? { user: parsed.hosted.user } : {}),
          },
        }
      : {}),
  };
}

function parseParsedSpec(
  parsed: NpaResult,
  raw: string,
  requiredBy: string,
  normalizeBare: boolean
): RootPackageRequirement | UnsupportedRootPackageRequirement {
  if (isAliasResult(parsed)) {
    const alias = parsed.name;
    const target = toRegistryRequirement(parsed.subSpec, raw, requiredBy);

    if ('reason' in target) {
      return {
        raw,
        reason: `Unsupported alias target: ${target.reason}`,
        requiredBy,
        type: parsed.subSpec.type,
      };
    }

    return {
      ...target,
      alias,
      aliasTargetType: target.type as RegistrySpecType,
      type: 'alias',
    };
  }

  const bare = normalizeBare ? normalizeBarePackage(parsed) : {};
  const requirement = toRegistryRequirement(parsed, raw, requiredBy, bare.specifier, bare.type);

  if ('reason' in requirement) {
    return requirement;
  }

  const specifierType =
    requirement.type === 'alias' ? requirement.aliasTargetType : requirement.type;

  return {
    ...requirement,
    specifier: normalizeVersionSpecifier(requirement.specifier, specifierType ?? 'tag'),
  };
}

export function parseRootSpecs(specs: string[]): ParseRootSpecsResult {
  const gitRequirements: GitRequirement[] = [];
  const requirements: RootPackageRequirement[] = [];
  const unsupported: UnsupportedRootPackageRequirement[] = [];

  for (const rawSpec of specs) {
    const raw = rawSpec.trim();
    if (!raw) continue;

    let parsedNpa: NpaResult;
    try {
      parsedNpa = npa(raw);
    } catch (error) {
      unsupported.push({
        raw,
        reason: (error as Error).message,
        requiredBy: 'root',
        type: 'invalid',
      });
      continue;
    }

    if (isGitResult(parsedNpa)) {
      gitRequirements.push(toGitRequirement(parsedNpa, raw, 'root'));
    }

    const parsedRequirement = parseParsedSpec(parsedNpa, raw, 'root', true);

    if ('reason' in parsedRequirement) {
      unsupported.push(parsedRequirement);
    } else {
      requirements.push(parsedRequirement);
    }
  }

  return { gitRequirements, requirements, unsupported };
}

export function parseDependencySpec(
  name: string,
  specifier: string,
  requiredBy: string
): RootPackageRequirement | UnsupportedRootPackageRequirement {
  const raw = `${name}@${specifier}`;

  try {
    return parseParsedSpec(npa.resolve(name, specifier), raw, requiredBy, false);
  } catch (error) {
    return {
      raw,
      reason: (error as Error).message,
      requiredBy,
      type: 'invalid',
    };
  }
}

export function parseGitDependencySpec(
  name: string,
  specifier: string,
  requiredBy: string
): GitRequirement | undefined {
  const raw = `${name}@${specifier}`;

  try {
    const parsed = npa.resolve(name, specifier);
    return isGitResult(parsed) ? toGitRequirement(parsed, raw, requiredBy) : undefined;
  } catch {
    return undefined;
  }
}
