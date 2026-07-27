import { createHash } from 'node:crypto';

export type CanonicalJsonPrimitive = boolean | null | number | string;
export type CanonicalJsonValue =
  | CanonicalJsonPrimitive
  | CanonicalJsonValue[]
  | { [key: string]: CanonicalJsonValue };

function normalizeCanonicalJson(
  value: unknown,
  ancestors: Set<object>,
  inArray: boolean
): CanonicalJsonValue | undefined {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError('Canonical JSON does not support non-finite numbers');
    }
    return Object.is(value, -0) ? 0 : value;
  }
  if (value === undefined) {
    return inArray ? null : undefined;
  }
  if (typeof value !== 'object') {
    throw new TypeError(`Canonical JSON does not support ${typeof value} values`);
  }
  if (ancestors.has(value)) {
    throw new TypeError('Canonical JSON does not support cyclic values');
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => normalizeCanonicalJson(item, ancestors, true) ?? null);
    }

    const normalized: Record<string, CanonicalJsonValue> = {};
    for (const key of Object.keys(value).sort()) {
      const item = normalizeCanonicalJson(
        (value as Record<string, unknown>)[key],
        ancestors,
        false
      );
      if (item !== undefined) {
        normalized[key] = item;
      }
    }
    return normalized;
  } finally {
    ancestors.delete(value);
  }
}

export function canonicalizeJson(value: unknown): CanonicalJsonValue {
  const normalized = normalizeCanonicalJson(value, new Set(), false);
  if (normalized === undefined) {
    throw new TypeError('Canonical JSON root cannot be undefined');
  }
  return normalized;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalizeJson(value));
}

export function semanticDigest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}
