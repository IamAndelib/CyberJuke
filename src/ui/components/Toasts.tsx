import { runToastAction, toasts } from '../../stores/toast';

export function Toasts() {
  return (
    <div class="toasts" aria-live="polite" data-testid="toasts">
      {toasts.value.map((t) => (
        <div class={'toast' + (t.action ? ' has-action' : '')} key={t.id} data-testid="toast">
          <span class="toast-text">{t.text}</span>
          {t.action && (
            <button type="button" class="toast-action" onClick={() => runToastAction(t.id)} data-testid="toast-action">
              [{t.action.label}]
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
