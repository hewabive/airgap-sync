import path from 'node:path';
import fs from 'fs-extra';
import type {
  FetchReport,
  GitApplyReport,
  GitConfigReport,
  GitFetchReport,
  GitMirrorPlan,
  GitMirrorRepositoryPlan,
  GitRequirement,
  SkippedGitRequirement,
} from '../types.js';

export interface GitMirrorPlanOptions {
  createdAt?: string;
  giteaBaseUrl: string;
  owner: string;
}

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

function trimGitSuffix(value: string): string {
  return value.endsWith('.git') ? value.slice(0, -4) : value;
}

function sanitizeRepositoryName(value: string): string {
  const sanitized = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');

  return sanitized || 'git-dependency';
}

function hostedSourceUrl(requirement: GitRequirement): string | undefined {
  const hosted = requirement.hosted;
  if (!hosted?.domain || !hosted.user || !hosted.project) {
    return undefined;
  }

  return `https://${hosted.domain}/${hosted.user}/${hosted.project}.git`;
}

function sourceUrl(requirement: GitRequirement): string | undefined {
  if (requirement.fetchSpec) {
    return requirement.fetchSpec.replace(/^git\+/, '');
  }

  return hostedSourceUrl(requirement);
}

function sourceId(requirement: GitRequirement, url: string): string {
  const hosted = requirement.hosted;
  if (hosted?.domain && hosted.user && hosted.project) {
    return `${hosted.domain}/${hosted.user}/${hosted.project}`;
  }

  return trimGitSuffix(url.replace(/^git\+/, ''));
}

function insteadOfCandidates(requirement: GitRequirement, url: string): string[] {
  const candidates = new Set<string>();
  const urlWithoutSuffix = trimGitSuffix(url);

  candidates.add(url);
  candidates.add(urlWithoutSuffix);

  if (url.startsWith('https://')) {
    candidates.add(`git+${url}`);
    candidates.add(`git+${urlWithoutSuffix}`);
  }

  const hosted = requirement.hosted;
  if (hosted?.domain && hosted.user && hosted.project) {
    const httpsUrl = `https://${hosted.domain}/${hosted.user}/${hosted.project}`;
    candidates.add(`${httpsUrl}.git`);
    candidates.add(httpsUrl);
    candidates.add(`git+${httpsUrl}.git`);
    candidates.add(`git+${httpsUrl}`);
    candidates.add(`git@${hosted.domain}:${hosted.user}/${hosted.project}.git`);
    candidates.add(`ssh://git@${hosted.domain}/${hosted.user}/${hosted.project}.git`);
  }

  return [...candidates].sort();
}

function requirementKey(requirement: GitRequirement): string {
  return [requirement.requiredBy, requirement.raw, requirement.rawSpec].join('\0');
}

function sortRequirements(requirements: GitRequirement[]): GitRequirement[] {
  return [...requirements].sort((left, right) => {
    const byRequiredBy = left.requiredBy.localeCompare(right.requiredBy);
    return byRequiredBy === 0 ? left.raw.localeCompare(right.raw) : byRequiredBy;
  });
}

export function createGitMirrorPlan(
  requirements: GitRequirement[],
  options: GitMirrorPlanOptions
): GitMirrorPlan {
  const giteaBaseUrl = normalizeBaseUrl(options.giteaBaseUrl);
  const owner = options.owner.replace(/^\/+|\/+$/g, '');
  const repositories = new Map<string, GitMirrorRepositoryPlan>();
  const skipped: SkippedGitRequirement[] = [];

  for (const requirement of requirements) {
    const url = sourceUrl(requirement);
    if (!url) {
      skipped.push({
        reason: 'Unable to infer a cloneable source URL',
        requirement,
      });
      continue;
    }

    const id = sourceId(requirement, url);
    const existing = repositories.get(id);

    if (existing) {
      if (
        !existing.requirements.some((item) => requirementKey(item) === requirementKey(requirement))
      ) {
        existing.requirements.push(requirement);
      }
      continue;
    }

    const repository = sanitizeRepositoryName(id);
    repositories.set(id, {
      id,
      insteadOf: insteadOfCandidates(requirement, url),
      repository,
      requirements: [requirement],
      sourceUrl: url,
      targetUrl: `${giteaBaseUrl}/${owner}/${repository}.git`,
    });
  }

  return {
    schemaVersion: 1,
    createdAt: options.createdAt ?? new Date().toISOString(),
    giteaBaseUrl,
    owner,
    repositories: [...repositories.values()]
      .map((repository) => ({
        ...repository,
        requirements: sortRequirements(repository.requirements),
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    skipped: skipped.sort((left, right) =>
      requirementKey(left.requirement).localeCompare(requirementKey(right.requirement))
    ),
  };
}

export async function readFetchReport(bundleDir: string): Promise<FetchReport> {
  return (await fs.readJson(path.join(bundleDir, 'fetch-report.json'))) as FetchReport;
}

export async function writeGitMirrorPlan(bundleDir: string, plan: GitMirrorPlan): Promise<void> {
  await fs.ensureDir(bundleDir);
  await fs.writeJson(path.join(bundleDir, 'git-plan.json'), plan, { spaces: 2 });
}

export async function readGitMirrorPlan(bundleDir: string): Promise<GitMirrorPlan> {
  return (await fs.readJson(path.join(bundleDir, 'git-plan.json'))) as GitMirrorPlan;
}

export async function writeGitFetchReport(
  bundleDir: string,
  report: GitFetchReport
): Promise<void> {
  await fs.ensureDir(bundleDir);
  await fs.writeJson(path.join(bundleDir, 'git-fetch-report.json'), report, { spaces: 2 });
}

export async function writeGitApplyReport(
  bundleDir: string,
  report: GitApplyReport
): Promise<void> {
  await fs.ensureDir(bundleDir);
  await fs.writeJson(path.join(bundleDir, 'git-apply-report.json'), report, { spaces: 2 });
}

export async function writeGitConfigReport(
  bundleDir: string,
  report: GitConfigReport
): Promise<void> {
  await fs.ensureDir(bundleDir);
  await fs.writeJson(path.join(bundleDir, 'git-config-report.json'), report, { spaces: 2 });
}
