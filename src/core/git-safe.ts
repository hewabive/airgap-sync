export function safeDirectoryGitArgs(directory: string, args: string[]): string[] {
  return ['-c', `safe.directory=${directory}`, ...args];
}
