export type PythonPublishProgressStatus = 'start' | 'progress' | 'done' | 'error';

export interface PythonPublishProgressEvent {
  bytes?: number;
  current?: number;
  detail?: string;
  status: PythonPublishProgressStatus;
  total?: number;
  totalBytes?: number;
}

export type PythonFilePublishProgress = (
  operation: string,
  bytes: number,
  totalBytes?: number
) => void;

export function createPythonFilePublishProgress(options: {
  current: () => number;
  filename: string;
  onProgress?: (event: PythonPublishProgressEvent) => void;
  total: number;
}): PythonFilePublishProgress {
  let lastOperation: string | undefined;
  let lastProgressAt = 0;
  return (operation, bytes, totalBytes) => {
    if (!options.onProgress) {
      return;
    }
    const now = Date.now();
    const operationChanged = operation !== lastOperation;
    const reachedEnd = totalBytes !== undefined && bytes === totalBytes;
    if (!operationChanged && !reachedEnd && now - lastProgressAt < 1_000) {
      return;
    }
    lastOperation = operation;
    lastProgressAt = now;
    options.onProgress({
      bytes,
      current: options.current(),
      detail: `${operation} ${options.filename}`,
      status: 'progress',
      total: options.total,
      ...(totalBytes === undefined ? {} : { totalBytes }),
    });
  };
}
