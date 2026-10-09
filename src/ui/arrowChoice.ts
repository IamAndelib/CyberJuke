/**
 * Keys for a row of choices (role radio or tab): the arrows (and Home, End) choose the next
 * one and move focus to it, so the group is one stop for Tab. Each choice carries
 * `data-value` and `tabIndex` 0 when chosen, else -1.
 */
export function arrowChoice<T extends string | number>(options: readonly T[], value: T, choose: (v: T) => void) {
  return (e: KeyboardEvent): void => {
    const i = options.indexOf(value);
    const n = options.length;
    const j =
      e.key === 'ArrowRight' || e.key === 'ArrowDown'
        ? (i + 1) % n
        : e.key === 'ArrowLeft' || e.key === 'ArrowUp'
          ? (i - 1 + n) % n
          : e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? n - 1
              : -1;
    if (j < 0) return;
    e.preventDefault();
    choose(options[j]);
    (e.currentTarget as HTMLElement).querySelector<HTMLElement>(`[data-value="${String(options[j])}"]`)?.focus();
  };
}
