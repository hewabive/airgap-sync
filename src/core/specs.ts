import npa from 'npm-package-arg';
import type {
  ParseRootSpecsResult,
  RootPackageRequirement,
  SupportedSpecType,
  UnsupportedRootPackageRequirement,
} from '../types.js';

type NpaResult = npa.Result;
type RegistrySpecType = Exclude<SupportedSpecType, 'alias'>;

interface NpaAliasResult extends NpaResult {
  name: string;
  subSpec: NpaResult;
  type: 'alias';
}

const supportedRegistryTypes = new Set<NpaResult['type']>(['version', 'range', 'tag']);

function isAliasResult(parsed: NpaResult): parsed is NpaAliasResult {
  return parsed.type === 'alias' && typeof parsed.name === 'string' && 'subSpec' in parsed;
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

function parseOneRootSpec(raw: string): RootPackageRequirement | UnsupportedRootPackageRequirement {
  let parsed: NpaResult;

  try {
    parsed = npa(raw);
  } catch (error) {
    return {
      raw,
      reason: (error as Error).message,
      requiredBy: 'root',
      type: 'invalid',
    };
  }

  return parseParsedSpec(parsed, raw, 'root', true);
}

export function parseRootSpecs(specs: string[]): ParseRootSpecsResult {
  const requirements: RootPackageRequirement[] = [];
  const unsupported: UnsupportedRootPackageRequirement[] = [];

  for (const rawSpec of specs) {
    const raw = rawSpec.trim();
    if (!raw) continue;

    const parsed = parseOneRootSpec(raw);
    if ('reason' in parsed) {
      unsupported.push(parsed);
    } else {
      requirements.push(parsed);
    }
  }

  return { requirements, unsupported };
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
