import { describe, expect, it } from 'vitest';
import { validatePythonIndexUrl } from '../src/menu/python-settings.js';

describe('Python menu settings', () => {
  it('accepts only HTTP Python indexes and normalizes the URL', () => {
    expect(validatePythonIndexUrl('https://pypi.org/simple')).toBe('https://pypi.org/simple');
    expect(() => validatePythonIndexUrl('file:///tmp/simple')).toThrow(/HTTP or HTTPS/);
  });
});
