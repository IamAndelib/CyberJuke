import { useEffect, useRef, useState } from 'preact/hooks';
import { useModal } from '../useModal';
import { confirmRequest, type ConfirmRequest } from '../nav';

/** How long a closing sheet keeps its content while it slides away (the sheet's 0.2s). */
const CLOSE_MS = 220;

/**
 * M3: a confirm sheet (same look as the track menu) for actions that can't easily be
 * taken back: the confirming button names what happens ("Clear 12 plays").
 */
export function ConfirmSheet() {
  const req = confirmRequest.value;
  // Keep the last request on screen while the sheet slides away.
  const [shown, setShown] = useState<ConfirmRequest | null>(req);
  useEffect(() => {
    if (req) return setShown(req);
    const id = setTimeout(() => setShown(null), CLOSE_MS);
    return () => clearTimeout(id);
  }, [req]);
  const r = req ?? shown;
  const close = () => (confirmRequest.value = null);
  const sheet = useRef<HTMLDivElement>(null);
  useModal(req != null, sheet);
  return (
    <div class={'sheet-wrap' + (req ? ' open' : '')} aria-hidden={!req} inert={!req}>
      <div class="scrim" onClick={close} />
      <div class="sheet confirm-sheet" ref={sheet} role="alertdialog" aria-modal="true" aria-label={r?.title ?? 'Confirm'} data-testid="confirm-sheet">
        {r && (
          <>
            <div class="sheet-head confirm-head">
              <div class="row-text">
                <div class="row-title">{r.title}</div>
                {r.body && <div class="row-artist confirm-body">{r.body}</div>}
              </div>
            </div>
            <button
              class="sheet-item confirm-ok"
              onClick={() => {
                close();
                void r.run();
              }}
              data-testid="confirm-ok"
            >
              <span class="sheet-text">{r.confirm}</span>
            </button>
            <button class="sheet-item cancel" onClick={close} data-testid="confirm-cancel">
              [Cancel]
            </button>
          </>
        )}
      </div>
    </div>
  );
}
