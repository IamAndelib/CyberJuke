import { toasts } from '../../store/toast';

export function Toasts() {
  return (
    <div class="toasts" aria-live="polite" data-testid="toasts">
      {toasts.value.map((t) => (
        <div class="toast" key={t.id} data-testid="toast">
          {t.text}
        </div>
      ))}
    </div>
  );
}
