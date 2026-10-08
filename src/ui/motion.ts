/** Shared motion helpers. */

/** The user asked for less motion: animations jump to their end. */
export function reducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}
