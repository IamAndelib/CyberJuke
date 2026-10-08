/**
 * Run a command whose failure the user should hear about, but which must never
 * become an unhandled rejection: the error is logged and `notify` gets a short,
 * friendly message. Resolves with the command's result, or undefined on failure.
 */
import { logError } from './log';

export type Notify = (text: string) => void;

export async function safe<T>(where: string, run: () => Promise<T> | T, notify: Notify, message: string): Promise<T | undefined> {
  try {
    return await run();
  } catch (e) {
    logError(where, e);
    try {
      notify(message);
    } catch {
      /* a failing notifier must not throw from here */
    }
    return undefined;
  }
}
