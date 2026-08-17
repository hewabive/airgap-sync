function npmAuthTokenConfigKey(registryUrl: string): string {
  const url = new URL(registryUrl);
  const pathname = url.pathname.endsWith('/') ? url.pathname : `${url.pathname}/`;
  return `//${url.host}${pathname}:_authToken`;
}

export function npmUserConfigContent(registryUrl: string, token: string): string {
  if (/\r|\n/u.test(token)) {
    throw new Error('Registry auth token must not contain line breaks');
  }
  return `${npmAuthTokenConfigKey(registryUrl)}=${token}\n`;
}
