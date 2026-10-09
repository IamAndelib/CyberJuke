import { useRef } from 'preact/hooks';
import { useModal, useSheetContent } from '../useModal';
import { confirmRequest } from '../nav';

/**
 * M3: a confirm sheet (same look as the track menu) for actions that can't easily be
 * taken back: the confirming button names what happens ("Clear 12 plays").
 */
export function ConfirmSheet() {
  const req = confirmRequest.value;
  const sheet = useRef<HTMLDivElement>(null);
  const r = useSheetContent(req, sheet);
  const close = () => (confirmRequest.value = null);
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
