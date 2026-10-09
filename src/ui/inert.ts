/**
 * `inert` with owners: an element stays inert while anything still holds it. The app behind
 * Now Playing is made inert by the sheet and, while a menu shows over it, by the menu too;
 * whichever lets go first must not make it reachable under the other.
 */
const holders = new WeakMap<HTMLElement, Set<object>>();

export function holdInert(el: HTMLElement, by: object): void {
  let set = holders.get(el);
  if (!set) holders.set(el, (set = new Set()));
  set.add(by);
  el.inert = true;
}

export function releaseInert(el: HTMLElement, by: object): void {
  const set = holders.get(el);
  if (!set?.delete(by)) return;
  if (!set.size) el.inert = false;
}

/** Inert because of an owner (not markup, like a hidden tab's `inert` attribute). */
export function isHeldInert(el: HTMLElement): boolean {
  return (holders.get(el)?.size ?? 0) > 0;
}
