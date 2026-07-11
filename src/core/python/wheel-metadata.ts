import yauzl from 'yauzl';

const defaultMaxMetadataSize = 16 * 1024 * 1024;
const metadataPathPattern = /^[^/]+\.dist-info\/METADATA$/;

function openZip(filePath: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(filePath, { autoClose: false, lazyEntries: true }, (error, zipFile) => {
      if (error) {
        reject(error);
      } else {
        resolve(zipFile);
      }
    });
  });
}

function readEntry(
  zipFile: yauzl.ZipFile,
  entry: yauzl.Entry,
  maxMetadataSize: number
): Promise<string> {
  if ((entry.generalPurposeBitFlag & 0x1) !== 0) {
    throw new Error('Wheel METADATA entry is encrypted');
  }
  if (entry.uncompressedSize > maxMetadataSize) {
    throw new Error(
      `Wheel METADATA exceeds ${String(maxMetadataSize)} bytes: ${String(entry.uncompressedSize)}`
    );
  }

  return new Promise((resolve, reject) => {
    zipFile.openReadStream(entry, (error, stream) => {
      if (error) {
        reject(error);
        return;
      }

      const chunks: Buffer[] = [];
      let size = 0;
      stream.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxMetadataSize) {
          stream.destroy(new Error(`Wheel METADATA exceeds ${String(maxMetadataSize)} bytes`));
          return;
        }
        chunks.push(chunk);
      });
      stream.once('error', reject);
      stream.once('end', () => {
        try {
          resolve(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
        } catch (decodeError) {
          reject(new Error(`Wheel METADATA is not valid UTF-8: ${(decodeError as Error).message}`));
        }
      });
    });
  });
}

export async function readWheelMetadata(
  filePath: string,
  options: { maxMetadataSize?: number } = {}
): Promise<string> {
  const maxMetadataSize = options.maxMetadataSize ?? defaultMaxMetadataSize;
  const zipFile = await openZip(filePath);

  try {
    return await new Promise((resolve, reject) => {
      let found = false;

      zipFile.once('error', reject);
      zipFile.on('entry', (entry: yauzl.Entry) => {
        if (!metadataPathPattern.test(entry.fileName)) {
          zipFile.readEntry();
          return;
        }
        if (found) {
          reject(new Error('Wheel contains more than one top-level .dist-info/METADATA entry'));
          return;
        }
        found = true;
        void readEntry(zipFile, entry, maxMetadataSize).then(resolve, reject);
      });
      zipFile.once('end', () => {
        if (!found) {
          reject(new Error('Wheel does not contain a top-level .dist-info/METADATA entry'));
        }
      });
      zipFile.readEntry();
    });
  } finally {
    zipFile.close();
  }
}
