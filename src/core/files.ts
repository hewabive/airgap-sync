export function packageFileName(name: string, version: string): string {
  const safeName = name.startsWith('@') ? name.slice(1).replace('/', '__') : name;
  return `${safeName}-${version}.tgz`;
}
