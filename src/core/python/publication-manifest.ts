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
  schemaVersion: 1;
}

export interface MaterializePythonPublicationOptions {
  bundleDir: string;
  index: PythonApplicationBundleIndex;
  profile: ResolvedPythonPublicationProfile;
  write?: boolean;
}

const publicationsDirectory = 'python/publications';

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

function artifactPackage(artifact: PythonApplicationBundleArtifact): string {
  if (artifact.kind === 'cpython') {
    const platform = artifact.references.flatMap((reference) => reference.platforms)[0];
    if (!platform) {
      throw new Error(`CPython artifact has no platform identity: ${artifact.id}`);
    }
    return `cpython-${platform}`;
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

function publicationSemanticContent(
  index: PythonApplicationBundleIndex,
  giteaBaseUrl: string,
  profile: ResolvedPythonPublicationProfile
): unknown {
  return {
    applications: index.applications
      .map((application) => ({
        planId: application.planId,
        targetId: application.targetId,
      }))
      .sort((left, right) => left.targetId.localeCompare(right.targetId)),
    artifacts: index.artifacts
      .filter((artifact) => artifact.kind !== 'wheel')
      .map((artifact) => ({
        artifactId: artifact.id,
        kind: artifact.kind,
        package: artifactPackage(artifact),
        version: artifact.version,
      }))
      .sort((left, right) => left.artifactId.localeCompare(right.artifactId)),
    giteaBaseUrl,
    owners: {
      generic: profile.genericOwner,
      pypi: profile.pypiOwner,
    },
    schemaVersion: 1,
  };
}

export function pythonPublicationManifestPath(publicationId: string): string {
  return path.posix.join(publicationsDirectory, publicationId, 'publication-manifest.json');
}

export async function materializePythonPublication(
  giteaBaseUrl: string,
  options: MaterializePythonPublicationOptions
): Promise<PythonPublicationManifest> {
  const baseUrl = normalizeBaseUrl(giteaBaseUrl);
  const publicationId = semanticDigest(
    publicationSemanticContent(options.index, baseUrl, options.profile)
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
        digest: semanticDigest(document.content),
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
        version: artifact.version,
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
    schemaVersion: 1,
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
