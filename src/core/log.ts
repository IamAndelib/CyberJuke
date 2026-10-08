/**
 * One place for unexpected errors. Messages name where it happened and the error's
 * name and message only: never search queries, track ids or tokens.
 */
import { describeError } from './errors';

export function logError(where: string, e: unknown): void {
  console.warn(`[cyberjuke] ${where}: ${describeError(e)}`);
}
