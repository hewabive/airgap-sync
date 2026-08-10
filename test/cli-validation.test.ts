import { describe, expect, it } from 'vitest';
import { validateDownloadInvocation } from '../src/cli-validation.js';

describe('CLI validation', () => {
  it('rejects workspace target selection together with a package scan root', () => {
    expect(() => {
      validateDownloadInvocation('.', [3]);
    }).toThrow('--target cannot be used with [root]; omit [root] to select workspace targets');
  });

  it('allows either workspace target selection or a package scan root', () => {
    expect(() => {
      validateDownloadInvocation(undefined, [3]);
    }).not.toThrow();
    expect(() => {
      validateDownloadInvocation('.', []);
    }).not.toThrow();
    expect(() => {
      validateDownloadInvocation('.', undefined);
    }).not.toThrow();
  });
});
