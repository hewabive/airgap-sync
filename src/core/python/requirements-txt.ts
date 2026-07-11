import path from 'node:path';
import type {
  PythonRequirementHash,
  PythonRequirementsInput,
  UnsupportedPythonInput,
} from './input-types.js';
import { parseRequirement } from './requirements.js';

export interface ParseRequirementsTextOptions {
  readIncluded?: (filePath: string) => Promise<string>;
  sourcePath: string;
}

interface LogicalLine {
  line: number;
  text: string;
}

function logicalLines(content: string): LogicalLine[] {
  const result: LogicalLine[] = [];
  const physical = content.replace(/^\uFEFF/, '').split(/\r?\n/);
  let current = '';
  let startLine = 1;

  physical.forEach((line, index) => {
    if (!current) {
      startLine = index + 1;
    }
    const continued = /\\\s*$/.test(line);
    const part = continued ? line.replace(/\\\s*$/, '') : line;
    current += `${current ? ' ' : ''}${part.trim()}`;
    if (!continued) {
      result.push({ line: startLine, text: current });
      current = '';
    }
  });

  if (current) {
    result.push({ line: startLine, text: current });
  }
  return result;
}

function stripComment(line: string): string {
  let quote: string | undefined;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]!;
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
    if (char === '#' && (index === 0 || /\s/.test(line[index - 1]!))) {
      return line.slice(0, index).trim();
    }
  }
  return line.trim();
}

function includePath(currentPath: string, value: string): string {
  const unquoted = value.trim().replace(/^(['"])(.*)\1$/, '$2');
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(currentPath), unquoted));
  if (
    !unquoted ||
    path.posix.isAbsolute(unquoted) ||
    resolved === '..' ||
    resolved.startsWith('../')
  ) {
    throw new Error(`Requirement include escapes the repository root: ${value}`);
  }
  return resolved;
}

function extractHashes(line: string): { hashes: PythonRequirementHash[]; requirement: string } {
  const hashes: PythonRequirementHash[] = [];
  const requirement = line
    .replace(
      /(?:^|\s)--hash(?:=|\s+)([A-Za-z0-9_+-]+):([a-fA-F0-9]+)/g,
      (_match, algorithm: string, digest: string) => {
        hashes.push({ algorithm: algorithm.toLowerCase(), digest: digest.toLowerCase() });
        return '';
      }
    )
    .trim();
  return { hashes, requirement };
}

function unsupported(
  sourcePath: string,
  line: number,
  raw: string,
  reason: string,
  type: string
): UnsupportedPythonInput {
  return {
    line,
    raw,
    reason,
    requiredBy: `requirements:${sourcePath}`,
    sourcePath,
    type,
  };
}

export async function parseRequirementsText(
  content: string,
  options: ParseRequirementsTextOptions
): Promise<PythonRequirementsInput> {
  const files = new Set<string>();
  const requirements: PythonRequirementsInput['requirements'] = [];
  const unsupportedInputs: UnsupportedPythonInput[] = [];
  const visited = new Set<string>();

  async function parseFile(sourcePath: string, text: string, constraint: boolean): Promise<void> {
    const visitKey = `${constraint ? 'constraint' : 'requirement'}\0${sourcePath}`;
    if (visited.has(visitKey)) {
      return;
    }
    visited.add(visitKey);
    files.add(sourcePath);

    for (const logical of logicalLines(text)) {
      const raw = stripComment(logical.text);
      if (!raw) {
        continue;
      }

      const include = /^(?:-r|--requirement)(?:=|\s+)(.+)$/.exec(raw);
      const constraintInclude = /^(?:-c|--constraint)(?:=|\s+)(.+)$/.exec(raw);
      if (include || constraintInclude) {
        let target: string;
        try {
          target = includePath(sourcePath, (include ?? constraintInclude)![1]!);
        } catch (error) {
          unsupportedInputs.push(
            unsupported(sourcePath, logical.line, raw, (error as Error).message, 'include')
          );
          continue;
        }
        if (!options.readIncluded) {
          unsupportedInputs.push(
            unsupported(sourcePath, logical.line, raw, 'included file is unavailable', 'include')
          );
          continue;
        }
        try {
          await parseFile(target, await options.readIncluded(target), Boolean(constraintInclude));
        } catch (error) {
          unsupportedInputs.push(
            unsupported(
              sourcePath,
              logical.line,
              raw,
              `could not read ${target}: ${(error as Error).message}`,
              'include'
            )
          );
        }
        continue;
      }

      if (raw === '--require-hashes') {
        continue;
      }
      if (raw.startsWith('-')) {
        unsupportedInputs.push(
          unsupported(
            sourcePath,
            logical.line,
            raw,
            'pip option or editable requirement is not supported',
            'option'
          )
        );
        continue;
      }

      const extracted = extractHashes(raw);
      if (!extracted.requirement || extracted.requirement.includes(' --')) {
        unsupportedInputs.push(
          unsupported(sourcePath, logical.line, raw, 'unsupported per-requirement option', 'option')
        );
        continue;
      }
      const parsed = parseRequirement(extracted.requirement);
      if (!parsed.ok) {
        unsupportedInputs.push(
          unsupported(sourcePath, logical.line, raw, parsed.reason, 'requirement')
        );
        continue;
      }
      if (parsed.requirement.url) {
        unsupportedInputs.push(
          unsupported(
            sourcePath,
            logical.line,
            raw,
            'direct URL requirements are not supported in v1',
            'url'
          )
        );
        continue;
      }

      requirements.push({
        constraint,
        hashes: extracted.hashes,
        line: logical.line,
        requiredBy: `requirements:${sourcePath}`,
        requirement: parsed.requirement,
        sourcePath,
      });
    }
  }

  await parseFile(options.sourcePath, content, false);
  return {
    files: [...files].sort(),
    requirements,
    unsupported: unsupportedInputs,
  };
}
