import { compareVersions, isValidVersion, versionSatisfies } from './pep440.js';
import { normalizePackageName } from './names.js';

export interface MarkerEnvironment {
  dependency_groups?: string[];
  extra?: string | string[];
  extras?: string[];
  implementation_name: string;
  implementation_version: string;
  os_name: string;
  platform_machine: string;
  platform_python_implementation: string;
  platform_release?: string;
  platform_system: string;
  platform_version?: string;
  python_full_version: string;
  python_version: string;
  sys_platform: string;
}

const MARKER_VARIABLES = new Set<string>([
  'dependency_groups',
  'extra',
  'extras',
  'implementation_name',
  'implementation_version',
  'os_name',
  'platform_machine',
  'platform_python_implementation',
  'platform_release',
  'platform_system',
  'platform_version',
  'python_full_version',
  'python_version',
  'sys_platform',
]);

const DEPRECATED_MARKER_ALIASES: Record<string, string> = {
  'os.name': 'os_name',
  'platform.machine': 'platform_machine',
  'platform.python_implementation': 'platform_python_implementation',
  'platform.version': 'platform_version',
  'sys.platform': 'sys_platform',
};

const COMPARISON_OPERATORS = new Set(['<', '<=', '>', '>=', '==', '!=', '~=', '===']);

type MarkerFieldType = 'string' | 'string-set' | 'version' | 'version-or-string';

const MARKER_FIELD_TYPES: Record<string, MarkerFieldType> = {
  dependency_groups: 'string-set',
  extra: 'string-set',
  extras: 'string-set',
  implementation_name: 'string',
  implementation_version: 'version',
  os_name: 'string',
  platform_machine: 'string',
  platform_python_implementation: 'string',
  platform_release: 'version-or-string',
  platform_system: 'string',
  platform_version: 'version-or-string',
  python_full_version: 'version',
  python_version: 'version',
  sys_platform: 'string',
};

type MarkerOperand = { kind: 'variable'; name: string } | { kind: 'literal'; value: string };

type MarkerNode =
  | { type: 'or'; nodes: MarkerNode[] }
  | { type: 'and'; nodes: MarkerNode[] }
  | { left: MarkerOperand; op: string; right: MarkerOperand; type: 'comparison' };

interface MarkerToken {
  position: number;
  type: 'identifier' | 'operator' | 'string' | 'lparen' | 'rparen';
  value: string;
}

function markerError(marker: string, message: string): Error {
  return new Error(`Invalid environment marker "${marker}": ${message}`);
}

function tokenizeMarker(marker: string): MarkerToken[] {
  const tokens: MarkerToken[] = [];
  let index = 0;

  while (index < marker.length) {
    const char = marker[index]!;

    if (/\s/.test(char)) {
      index += 1;
      continue;
    }

    if (char === '(') {
      tokens.push({ position: index, type: 'lparen', value: '(' });
      index += 1;
      continue;
    }

    if (char === ')') {
      tokens.push({ position: index, type: 'rparen', value: ')' });
      index += 1;
      continue;
    }

    if (char === '"' || char === "'") {
      const end = marker.indexOf(char, index + 1);
      if (end === -1) {
        throw markerError(marker, `unterminated string starting at position ${String(index)}`);
      }
      tokens.push({ position: index, type: 'string', value: marker.slice(index + 1, end) });
      index = end + 1;
      continue;
    }

    const operatorMatch = /^(===|==|!=|<=|>=|~=|<|>)/.exec(marker.slice(index));
    if (operatorMatch) {
      tokens.push({ position: index, type: 'operator', value: operatorMatch[0] });
      index += operatorMatch[0].length;
      continue;
    }

    const identifierMatch = /^[A-Za-z_][A-Za-z0-9_.]*/.exec(marker.slice(index));
    if (identifierMatch) {
      tokens.push({ position: index, type: 'identifier', value: identifierMatch[0] });
      index += identifierMatch[0].length;
      continue;
    }

    throw markerError(marker, `unexpected character "${char}" at position ${String(index)}`);
  }

  return tokens;
}

class MarkerParser {
  private index = 0;

  constructor(
    private readonly marker: string,
    private readonly tokens: MarkerToken[]
  ) {}

  parse(): MarkerNode {
    const node = this.parseOr();
    const trailing = this.peek();
    if (trailing) {
      throw markerError(this.marker, `unexpected token "${trailing.value}"`);
    }
    return node;
  }

  private peek(): MarkerToken | undefined {
    return this.tokens[this.index];
  }

  private next(): MarkerToken | undefined {
    const token = this.tokens[this.index];
    this.index += 1;
    return token;
  }

  private parseOr(): MarkerNode {
    const nodes = [this.parseAnd()];
    while (this.peek()?.type === 'identifier' && this.peek()?.value === 'or') {
      this.next();
      nodes.push(this.parseAnd());
    }
    return nodes.length === 1 ? nodes[0]! : { nodes, type: 'or' };
  }

  private parseAnd(): MarkerNode {
    const nodes = [this.parseAtom()];
    while (this.peek()?.type === 'identifier' && this.peek()?.value === 'and') {
      this.next();
      nodes.push(this.parseAtom());
    }
    return nodes.length === 1 ? nodes[0]! : { nodes, type: 'and' };
  }

  private parseAtom(): MarkerNode {
    if (this.peek()?.type === 'lparen') {
      this.next();
      const node = this.parseOr();
      const closing = this.next();
      if (closing?.type !== 'rparen') {
        throw markerError(this.marker, 'missing closing parenthesis');
      }
      return node;
    }

    return this.parseComparison();
  }

  private parseComparison(): MarkerNode {
    const left = this.parseOperand();
    const op = this.parseOperator();
    const right = this.parseOperand();
    return { left, op, right, type: 'comparison' };
  }

  private parseOperand(): MarkerOperand {
    const token = this.next();
    if (!token) {
      throw markerError(this.marker, 'unexpected end of expression');
    }

    if (token.type === 'string') {
      return { kind: 'literal', value: token.value };
    }

    if (token.type === 'identifier') {
      const name = DEPRECATED_MARKER_ALIASES[token.value] ?? token.value;
      if (!MARKER_VARIABLES.has(name)) {
        throw markerError(this.marker, `unknown marker variable "${token.value}"`);
      }
      return { kind: 'variable', name };
    }

    throw markerError(this.marker, `expected a variable or string, found "${token.value}"`);
  }

  private parseOperator(): string {
    const token = this.next();
    if (!token) {
      throw markerError(this.marker, 'expected an operator, found end of expression');
    }

    if (token.type === 'operator') {
      return token.value;
    }

    if (token.type === 'identifier' && token.value === 'in') {
      return 'in';
    }

    if (token.type === 'identifier' && token.value === 'not') {
      const next = this.next();
      if (next?.type === 'identifier' && next.value === 'in') {
        return 'not in';
      }
      throw markerError(this.marker, '"not" must be followed by "in"');
    }

    throw markerError(this.marker, `expected an operator, found "${token.value}"`);
  }
}

export function parseMarker(marker: string): MarkerNode {
  const trimmed = marker.trim();
  if (!trimmed) {
    throw markerError(marker, 'marker is empty');
  }

  return new MarkerParser(marker, tokenizeMarker(trimmed)).parse();
}

function compareStrings(left: string, op: string, right: string): boolean {
  switch (op) {
    case '==':
      return left === right;
    case '!=':
      return left !== right;
    case '<=':
      return left === right;
    case '>=':
      return left === right;
    case '<':
    case '>':
      return false;
    case '~=':
    case '===':
      return left === right;
    default:
      return false;
  }
}

function reverseOperator(op: string): string {
  switch (op) {
    case '<':
      return '>';
    case '<=':
      return '>=';
    case '>':
      return '<';
    case '>=':
      return '<=';
    default:
      return op;
  }
}

function compareVersionsByOperator(left: string, op: string, right: string): boolean {
  if (op === '===') {
    return left === right;
  }

  if (op === '~=') {
    return isValidVersion(left) && versionSatisfies(left, `~=${right}`);
  }

  if (!isValidVersion(left) || !isValidVersion(right)) {
    return false;
  }

  const comparison = compareVersions(left, right);
  switch (op) {
    case '==':
      return comparison === 0;
    case '!=':
      return comparison !== 0;
    case '<':
      return comparison < 0;
    case '<=':
      return comparison <= 0;
    case '>':
      return comparison > 0;
    case '>=':
      return comparison >= 0;
    default:
      return false;
  }
}

function markerFieldValue(
  name: string,
  environment: MarkerEnvironment,
  marker: string
): string | string[] {
  const value = environment[name as keyof MarkerEnvironment];
  if (value === undefined) {
    throw markerError(marker, `marker variable "${name}" has no value`);
  }
  return value;
}

function evaluateSetComparison(
  name: string,
  values: string[],
  literal: string,
  op: string,
  variableOnLeft: boolean
): boolean {
  const normalizedValues = values.map((value) => normalizePackageName(value));
  const normalizedLiteral = normalizePackageName(literal);

  if (name === 'extra') {
    if (op === '==') {
      return normalizedValues.includes(normalizedLiteral);
    }
    if (op === '!=') {
      return !normalizedValues.includes(normalizedLiteral);
    }
    return false;
  }

  if (variableOnLeft || (op !== 'in' && op !== 'not in')) {
    return false;
  }

  const included = normalizedValues.includes(normalizedLiteral);
  return op === 'in' ? included : !included;
}

function evaluateComparison(
  node: Extract<MarkerNode, { type: 'comparison' }>,
  environment: MarkerEnvironment,
  marker: string
): boolean {
  const variable = node.left.kind === 'variable' ? node.left : node.right;
  const literal = node.left.kind === 'literal' ? node.left : node.right;
  if (variable.kind !== 'variable' || literal.kind !== 'literal') {
    throw markerError(marker, 'comparisons must contain one marker variable and one string');
  }

  const fieldType = MARKER_FIELD_TYPES[variable.name];
  if (!fieldType) {
    throw markerError(marker, `unknown marker variable "${variable.name}"`);
  }

  const value = markerFieldValue(variable.name, environment, marker);
  const variableOnLeft = node.left.kind === 'variable';

  if (fieldType === 'string-set') {
    return evaluateSetComparison(
      variable.name,
      Array.isArray(value) ? value : [value],
      literal.value,
      node.op,
      variableOnLeft
    );
  }

  const stringValue = value as string;
  if (fieldType === 'version' && (node.op === 'in' || node.op === 'not in')) {
    return false;
  }

  if (node.op === 'in') {
    return variableOnLeft
      ? literal.value.includes(stringValue)
      : stringValue.includes(literal.value);
  }

  if (node.op === 'not in') {
    return variableOnLeft
      ? !literal.value.includes(stringValue)
      : !stringValue.includes(literal.value);
  }

  if (!COMPARISON_OPERATORS.has(node.op)) {
    throw markerError(marker, `unknown operator "${node.op}"`);
  }

  const normalizedOp = variableOnLeft ? node.op : reverseOperator(node.op);
  if (fieldType === 'version') {
    if (!isValidVersion(stringValue) || (!isValidVersion(literal.value) && node.op !== '===')) {
      return compareStrings(stringValue, normalizedOp, literal.value);
    }
    return compareVersionsByOperator(stringValue, normalizedOp, literal.value);
  }

  if (
    fieldType === 'version-or-string' &&
    isValidVersion(stringValue) &&
    isValidVersion(literal.value)
  ) {
    return compareVersionsByOperator(stringValue, normalizedOp, literal.value);
  }

  return compareStrings(stringValue, normalizedOp, literal.value);
}

function evaluateNode(node: MarkerNode, environment: MarkerEnvironment, marker: string): boolean {
  if (node.type === 'or') {
    return node.nodes.some((child) => evaluateNode(child, environment, marker));
  }

  if (node.type === 'and') {
    return node.nodes.every((child) => evaluateNode(child, environment, marker));
  }

  return evaluateComparison(node, environment, marker);
}

export function evaluateMarker(marker: string, environment: MarkerEnvironment): boolean {
  return evaluateNode(parseMarker(marker), environment, marker);
}

export type MarkerEvaluationResult = { ok: true; value: boolean } | { ok: false; reason: string };

export function tryEvaluateMarker(
  marker: string,
  environment: MarkerEnvironment
): MarkerEvaluationResult {
  try {
    return { ok: true, value: evaluateMarker(marker, environment) };
  } catch (error) {
    return { ok: false, reason: (error as Error).message };
  }
}
