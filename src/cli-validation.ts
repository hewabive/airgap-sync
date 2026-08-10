export function validateDownloadInvocation(
  root: string | undefined,
  targetIndexes: number[] | undefined
): void {
  if (root !== undefined && targetIndexes !== undefined && targetIndexes.length > 0) {
    throw new Error('--target cannot be used with [root]; omit [root] to select workspace targets');
  }
}
