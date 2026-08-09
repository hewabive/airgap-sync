export function validatePythonIndexUrl(value: string): string {
  const parsed = new URL(value);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Python source index must use HTTP or HTTPS');
  }

  return parsed.toString();
}
