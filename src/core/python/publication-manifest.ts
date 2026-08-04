import { createHash } from 'node:crypto';
import path from 'node:path';
import { semanticDigest } from '../canonical-json.js';
import * as fs from '../fs.js';
import { normalizeBaseUrl } from '../git-targets.js';
import type {
  PythonApplicationBundleArtifact,
  PythonApplicationBundleIndex,
} from './application-bundle.js';
import { createPythonConsumerBundleDocuments } from './consumer-contract.js';
import type { PythonEnvironmentPlan } from './environment-plan.js';
import type { ResolvedPythonPublicationProfile } from './publication-targets.js';

export interface PythonGenericPackageCoordinates {
  owner: string;
  package: string;
  version: string;
}

export interface PythonPublicationDocument {
  digest: string;
  file: string;
}

export interface PythonPublicationApplication {
  documents: PythonPublicationDocument[];
  genericPackage: PythonGenericPackageCoordinates;
  planId: string;
  pypiIndexUrl: string;
  sourceDocuments: PythonPublicationDocument[];
  targetId: string;
}

export interface PythonPublicationArtifact {
  artifactId: string;
  file: string;
  genericPackage: PythonGenericPackageCoordinates;
}

export interface PythonPublicationManifest {
  applications: PythonPublicationApplication[];
  artifacts: PythonPublicationArtifact[];
  giteaBaseUrl: string;
  owners: {
    generic: ResolvedPythonPublicationProfile['genericOwner'];
    pypi: ResolvedPythonPublicationProfile['pypiOwner'];
  };
  publicationId: string;
  schemaVersion: 2;
}

export interface MaterializePythonPublicationOptions {
  bundleDir: string;
  index: PythonApplicationBundleIndex;
  profile: ResolvedPythonPublicationProfile;
  write?: boolean;
}

const publicationsDirectory = 'python/publications';

function contentDigest(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function safeBundleFile(bundleDir: string, relativeFile: string): string {
  if (
    path.posix.isAbsolute(relativeFile) ||
    relativeFile.includes('\\') ||
    relativeFile.split('/').includes('..')
  ) {
    throw new Error(`Unsafe Python publication path: ${relativeFile}`);
  }
  const absolute = path.resolve(bundleDir, relativeFile);
  const relative = path.relative(bundleDir, absolute);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Python publication path escapes the bundle: ${relativeFile}`);
  }
  return absolute;
}

function cpythonRelease(artifact: PythonApplicationBundleArtifact): string {
  const marker = '/releases/download/';
  const url = new URL(artifact.sourceUrl);
  const markerIndex = url.pathname.indexOf(marker);
  const suffix = markerIndex < 0 ? [] : url.pathname.slice(markerIndex + marker.length).split('/');
  if (suffix.length !== 2) {
    throw new Error(
      `CPython artifact source does not have a python-build-standalone release path: ${artifact.id}`
    );
  }
  const release = decodeURIComponent(suffix[0]!);
  const filename = decodeURIComponent(suffix[1]!);
  if (!release || !/^[A-Za-z0-9._+-]+$/u.test(release) || filename !== artifact.filename) {
    throw new Error(
      `CPython artifact source is not compatible with a uv Python mirror: ${artifact.id}`
    );
  }
  return release;
}

function artifactPackage(artifact: PythonApplicationBundleArtifact): string {
  if (artifact.kind === 'cpython') {
    return 'python-build-standalone';
  }
  if (artifact.kind === 'uv') {
    const platform = artifact.references.flatMap((reference) => reference.platforms)[0];
    if (!platform) {
      throw new Error(`uv artifact has no platform identity: ${artifact.id}`);
    }
    return `uv-${platform}`;
  }
  if (artifact.kind === 'license') {
    return 'uv-license';
  }
  throw new Error(`Wheel artifact does not use Generic Packages: ${artifact.id}`);
}

function artifactVersion(artifact: PythonApplicationBundleArtifact): string {
  return artifact.kind === 'cpython' ? cpythonRelease(artifact) : artifact.version;
}

function publicationSemanticContent(
  index: PythonApplicationBundleIndex,
  giteaBaseUrl: string,
  profile: ResolvedPythonPublicationProfile,
  applications: {
    documents: PythonPublicationDocument[];
    planId: string;
    targetId: string;
  }[]
): unknown {
  return {
    applications,
    artifacts: index.artifacts
      .filter((artifact) => artifact.kind !== 'wheel')
      .map((artifact) => ({
        artifactId: artifact.id,
        kind: artifact.kind,
        package: artifactPackage(artifact),
        version: artifactVersion(artifact),
      }))
      .sort((left, right) => left.artifactId.localeCompare(right.artifactId)),
    giteaBaseUrl,
    owners: {
      generic: profile.genericOwner,
      pypi: profile.pypiOwner,
    },
    schemaVersion: 2,
  };
}

async function publicationSourceDocuments(
  bundleDir: string,
  index: PythonApplicationBundleIndex
): Promise<
  {
    documents: PythonPublicationDocument[];
    planId: string;
    targetId: string;
  }[]
> {
  return Promise.all(
    [...index.applications]
      .sort((left, right) => left.targetId.localeCompare(right.targetId))
      .map(async (application) => {
        const files = [
          ...new Set([
            application.planPath,
            application.planDiffPath,
            application.prerequisiteReportPath,
            ...application.locks.map((lock) => lock.file),
          ]),
        ].sort();
        const documents = await Promise.all(
          files.map(async (file) => ({
            digest: contentDigest(await fs.readFile(safeBundleFile(bundleDir, file), 'utf8')),
            file,
          }))
        );
        return {
          documents,
          planId: application.planId,
          targetId: application.targetId,
        };
      })
  );
}

export function pythonPublicationManifestPath(publicationId: string): string {
  return path.posix.join(publicationsDirectory, publicationId, 'publication-manifest.json');
}

export async function materializePythonPublication(
  giteaBaseUrl: string,
  options: MaterializePythonPublicationOptions
): Promise<PythonPublicationManifest> {
  const baseUrl = normalizeBaseUrl(giteaBaseUrl);
  const sourceApplications = await publicationSourceDocuments(options.bundleDir, options.index);
  const publicationId = semanticDigest(
    publicationSemanticContent(options.index, baseUrl, options.profile, sourceApplications)
  );
  const publicationDirectory = path.posix.join(publicationsDirectory, publicationId);
  const pypiIndexUrl = `${baseUrl}/api/packages/${encodeURIComponent(options.profile.pypiOwner.name)}/pypi/simple`;
  const applications: PythonPublicationApplication[] = [];
  for (const application of options.index.applications) {
    const plan = await fs.readJson<PythonEnvironmentPlan>(
      safeBundleFile(options.bundleDir, application.planPath)
    );
    if (
      (plan as { schemaVersion?: unknown }).schemaVersion !== 2 ||
      plan.planId !== application.planId
    ) {
      throw new Error(
        `Python application plan does not match bundle index: ${application.targetId}`
      );
    }
    const sourceApplication = sourceApplications.find(
      (candidate) => candidate.targetId === application.targetId
    );
    if (!sourceApplication) {
      throw new Error(`Python application source documents are missing: ${application.targetId}`);
    }
    const consumer = createPythonConsumerBundleDocuments(plan, {
      genericOwner: options.profile.genericOwner.name,
      giteaBaseUrl: baseUrl,
      publicationId,
      pypiOwner: options.profile.pypiOwner.name,
    });
    const directory = path.posix.join(publicationDirectory, 'applications', application.targetId);
    const documents = consumer.documents
      .map((document) => ({
        content: document.content,
        digest: contentDigest(document.content),
        file: path.posix.join(directory, document.path),
      }))
      .sort((left, right) => left.file.localeCompare(right.file));
    if (options.write !== false) {
      await Promise.all(
        documents.map((document) =>
          fs.writeFileAtomic(safeBundleFile(options.bundleDir, document.file), document.content)
        )
      );
    }
    applications.push({
      documents: documents.map(({ digest, file }) => ({ digest, file })),
      genericPackage: consumer.contract.publication!,
      planId: application.planId,
      pypiIndexUrl,
      sourceDocuments: sourceApplication.documents,
      targetId: application.targetId,
    });
  }
  const artifacts = options.index.artifacts
    .filter((artifact) => artifact.kind !== 'wheel')
    .map((artifact) => ({
      artifactId: artifact.id,
      file: artifact.file,
      genericPackage: {
        owner: options.profile.genericOwner.name,
        package: artifactPackage(artifact),
        version: artifactVersion(artifact),
      },
    }))
    .sort((left, right) => left.artifactId.localeCompare(right.artifactId));
  const manifest: PythonPublicationManifest = {
    applications: applications.sort((left, right) => left.targetId.localeCompare(right.targetId)),
    artifacts,
    giteaBaseUrl: baseUrl,
    owners: {
      generic: options.profile.genericOwner,
      pypi: options.profile.pypiOwner,
    },
    publicationId,
    schemaVersion: 2,
  };
  if (options.write !== false) {
    await fs.writeJsonAtomic(
      safeBundleFile(options.bundleDir, pythonPublicationManifestPath(publicationId)),
      manifest,
      { spaces: 2 }
    );
  }
  return manifest;
}
