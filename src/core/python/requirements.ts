import { parseMarker } from './markers.js';
import { isValidPackageName, normalizePackageName } from './names.js';
import { isValidSpecifierSet } from './pep440.js';

export interface ParsedRequirement {
  extras: string[];
  marker?: string;
  name: string;
  normalizedName: string;
  raw: string;
  specifier: string;
  url?: string;
}

export type RequirementParseResult =
  | { ok: true; requirement: ParsedRequirement }
  | { ok: false; raw: string; reason: string };

function failure(raw: string, reason: string): RequirementParseResult {
  return { ok: false, raw, reason };
}

function splitOffMarker(input: string): { head: string; marker?: string } {
  let quote: string | undefined;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index]!;

    if (quote) {
      if (char === quote) {
        quote = undefined;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (char === ';') {
      const marker = input.slice(index + 1).trim();
      return marker ? { head: input.slice(0, index), marker } : { head: input.slice(0, index) };
    }
  }

  return { head: input };
}

function parseExtras(segment: string): string[] | undefined {
  const inner = segment.trim();
  if (!inner) {
    return [];
  }

  const extras: string[] = [];
  for (const part of inner.split(',')) {
    const extra = part.trim();
    if (!isValidPackageName(extra)) {
      return undefined;
    }
    extras.push(normalizePackageName(extra));
  }
  return extras;
}

function stripOuterParentheses(specifier: string): string {
  const trimmed = specifier.trim();
  if (trimmed.startsWith('(') && trimmed.endsWith(')')) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

export function parseRequirement(input: string): RequirementParseResult {
  const raw = input.trim();
  if (!raw) {
    return failure(input, 'Requirement is empty');
  }

  const { head, marker } = splitOffMarker(raw);

  if (marker !== undefined) {
    try {
      parseMarker(marker);
    } catch (error) {
      return failure(raw, (error as Error).message);
    }
  }

  const nameMatch = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?/.exec(head.trim());
  if (!nameMatch) {
    return failure(raw, 'Requirement does not start with a valid package name');
  }

  const name = nameMatch[0];
  let rest = head.trim().slice(name.length);

  let extras: string[] = [];
  const afterName = rest.trimStart();
  if (afterName.startsWith('[')) {
    const closing = afterName.indexOf(']');
    if (closing === -1) {
      return failure(raw, 'Extras list is missing a closing bracket');
    }
    const parsedExtras = parseExtras(afterName.slice(1, closing));
    if (!parsedExtras) {
      return failure(raw, 'Extras list contains an invalid extra name');
    }
    extras = parsedExtras;
    rest = afterName.slice(closing + 1);
  }

  const specifierSegment = rest.trim();

  const base = {
    extras,
    name,
    normalizedName: normalizePackageName(name),
    raw,
    ...(marker !== undefined ? { marker } : {}),
  };

  if (specifierSegment.startsWith('@')) {
    const url = specifierSegment.slice(1).trim();
    if (!url) {
      return failure(raw, 'URL requirement is missing the URL');
    }
    return { ok: true, requirement: { ...base, specifier: '', url } };
  }

  const specifier = stripOuterParentheses(specifierSegment);
  if (specifier && !isValidSpecifierSet(specifier)) {
    return failure(raw, `Invalid version specifier: ${specifier}`);
  }

  return { ok: true, requirement: { ...base, specifier } };
}
