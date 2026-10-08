import { describe, expect, it } from 'vitest';
import { describeError, errorMessage, isOffline, toLoadError } from './errors';

describe('error model', () => {
  it('errorMessage: an Error says its message; anything else is text or the fallback', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom');
    expect(errorMessage('plain')).toBe('plain');
    expect(errorMessage({ message: 'not an Error' })).toBe('[object Object]');
    expect(errorMessage(42, 'Network unavailable')).toBe('Network unavailable');
  });

  it('isOffline reads the offline flag of anything', () => {
    expect(isOffline(Object.assign(new Error('x'), { offline: true }))).toBe(true);
    expect(isOffline(new Error('x'))).toBe(false);
    expect(isOffline(null)).toBe(false);
    expect(isOffline(undefined)).toBe(false);
  });

  it('toLoadError keeps a string code and counts no network as offline', () => {
    const e = Object.assign(new Error('BOT_CHECK: slow down'), { code: 'BOT_CHECK' });
    expect(toLoadError(e)).toEqual({ message: 'BOT_CHECK: slow down', offline: false, code: 'BOT_CHECK' });
    expect(toLoadError(Object.assign(new Error('x'), { code: 7 }), true)).toEqual({ message: 'x', offline: true });
  });

  it('describeError names the error and its message only', () => {
    expect(describeError(new TypeError('bad'))).toBe('TypeError: bad');
    expect(describeError({ message: 'plugin said no' })).toBe('plugin said no');
    expect(describeError(3)).toBe('3');
  });
});
