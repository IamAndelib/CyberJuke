import { Icon } from '../icons';
import { popPage } from '../nav';
import { afterPress } from '../press';

/** A page's Back arrow: shows its press, then leaves (`onBack`, by default the page on top). */
export function BackButton({ testid, onBack = popPage, label = 'Back' }: { testid: string; onBack?: () => void; label?: string }) {
  return (
    <button class="icon-btn" aria-label={label} onClick={(e) => afterPress(e.currentTarget, () => void onBack())} data-testid={testid}>
      <Icon name="back" />
    </button>
  );
}
