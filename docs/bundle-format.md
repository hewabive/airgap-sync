# Bundle Format

A seed bundle is a directory that can be transferred to the target environment.

```text
seed/
  packages/
    foo-1.0.0.tgz
    scope__bar-2.0.0.tgz
  seed-manifest.json
  dist-tags.json
  fetch-report.json
  publish-report.json
```

## seed-manifest.json

Describes every tarball in the bundle and why it was included.

```json
{
  "schemaVersion": 1,
  "createdAt": "2026-05-20T00:00:00.000Z",
  "sourceRegistry": "https://registry.npmjs.org",
  "packages": [
    {
      "name": "foo",
      "version": "1.0.0",
      "file": "packages/foo-1.0.0.tgz",
      "resolvedFrom": [
        {
          "type": "range",
          "specifier": "^1.0.0",
          "requiredBy": "root"
        }
      ]
    }
  ]
}
```

## dist-tags.json

Records tags required by dependency specs.

```json
{
  "schemaVersion": 1,
  "sourceRegistry": "https://registry.npmjs.org",
  "createdAt": "2026-05-20T00:00:00.000Z",
  "tags": {
    "foo": {
      "latest": "1.0.0"
    }
  },
  "requirements": [
    {
      "name": "foo",
      "tag": "latest",
      "version": "1.0.0",
      "requiredBy": "root"
    }
  ]
}
```

## Reports

Reports are operational logs. They are allowed to change between minor versions while
the project is pre-1.0. Stable machine-readable contracts belong in `seed-manifest.json`
and `dist-tags.json`.
