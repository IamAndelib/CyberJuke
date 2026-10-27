import { Icon } from '../icons';
import { popPage } from '../nav';
import { usePressThen } from '../usePress';

/** A page's Back arrow: shows its press, then leaves (`onBack`, by default the page on top). */
export function BackButton({ testid, onBack = popPage }: { testid: string; onBack?: () => void }) {
  const press = usePressThen<HTMLButtonElement>(() => void onBack());
  return (
    <button ref={press.ref} class="icon-btn" aria-label="Back" onClick={press.onClick} data-testid={testid}>
      <Icon name="back" />
    </button>
  );
}
