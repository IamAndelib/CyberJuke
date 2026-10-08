/**
 * Test hooks (`window.__cyberjuke*`) exist only in dev (`vite`) and test builds
 * (`vite build --mode test`, what the e2e suite runs). In a production build
 * TEST_HOOKS is the constant false, so every hook is dropped by the minifier.
 */
export const TEST_HOOKS: boolean = import.meta.env.DEV || import.meta.env.MODE === 'test';

/** Expose a value as `window[name]` in dev/test builds only. */
export function exposeForTests(name: `__cyberjuke${string}`, value: unknown): void {
  if (TEST_HOOKS && typeof window !== 'undefined') (window as unknown as Record<string, unknown>)[name] = value;
}
