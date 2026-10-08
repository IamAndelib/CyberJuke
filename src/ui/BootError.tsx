/** Shown instead of a blank screen when the app couldn't start. */
export function BootError({ detail, onRetry }: { detail: string; onRetry: () => void }) {
  return (
    <div class="state boot-error" role="alert" data-testid="boot-error">
      <div class="state-glyph" aria-hidden="true">
        [ ERROR ]
      </div>
      <div class="state-title">CyberJuke couldn't start</div>
      <div class="state-body">Something went wrong while starting. Try again; if it keeps happening, reinstall or update the app.</div>
      <div class="state-body dim small" data-testid="boot-error-detail">
        {detail}
      </div>
      <button class="btn" onClick={onRetry} data-testid="boot-retry">
        Retry
      </button>
    </div>
  );
}
