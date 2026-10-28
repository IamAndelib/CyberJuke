import { Icon } from '../icons';
import { popPage } from '../nav';

/** A page's Back arrow: leaves the page (`onBack`, by default the page on top). */
export function BackButton({ testid, onBack = popPage, label = 'Back' }: { testid: string; onBack?: () => void; label?: string }) {
  return (
    <button class="icon-btn" aria-label={label} onClick={() => void onBack()} data-testid={testid}>
      <Icon name="back" />
    </button>
  );
}
