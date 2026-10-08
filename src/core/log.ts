/**
 * One place for unexpected errors. Messages name where it happened and the error's
 * name and message only: never search queries, track ids or tokens.
 */
export function describeError(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  if (e && typeof e === 'object' && typeof (e as { message?: unknown }).message === 'string') return (e as { message: string }).message;
  return String(e);
}

export function logError(where: string, e: unknown): void {
  console.warn(`[cyberjuke] ${where}: ${describeError(e)}`);
}
