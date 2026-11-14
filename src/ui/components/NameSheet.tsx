import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import { useModal, useSheetContent } from '../useModal';
import { nameRequest } from '../nav';
import { PLAYLIST_NAME_MAX, cleanName } from '../../stores/playlists';
import { SheetCancel } from './ConfirmSheet';

/** Asks for a name (New playlist, Rename): the field takes focus; the button works once it isn't empty. */
export function NameSheet() {
  const req = nameRequest.value;
  const sheet = useRef<HTMLDivElement>(null);
  const r = useSheetContent(req, sheet);
  const [name, setName] = useState('');
  // Before the sheet paints: the field never shows the last name asked for, and what's typed at once stays.
  useLayoutEffect(() => {
    if (req) setName(req.initial ?? '');
  }, [req]);
  const close = () => (nameRequest.value = null);
  useModal(req != null, sheet);
  const clean = cleanName(name);
  const done = () => {
    if (!r || !clean) return;
    close();
    r.run(clean);
  };
  return (
    <div class={'sheet-wrap' + (req ? ' open' : '')} aria-hidden={!req} inert={!req}>
      <div class="scrim" onClick={close} />
      <div class="sheet" ref={sheet} role="dialog" aria-modal="true" aria-label={r?.title ?? 'Name'} data-testid="name-sheet">
        {r && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              done();
            }}
          >
            <div class="sheet-head confirm-head">
              <div class="row-text">
                <div class="row-title">{r.title}</div>
                {r.note && <div class="row-artist confirm-body">{r.note}</div>}
              </div>
            </div>
            <label class="field name-field">
              <span class="field-label">Name</span>
              <input
                class="field-input"
                value={name}
                maxLength={PLAYLIST_NAME_MAX}
                onInput={(e) => setName(e.currentTarget.value)}
                autocomplete="off"
                enterKeyHint="done"
                data-testid="name-input"
                data-autofocus
              />
            </label>
            <button type="submit" class="sheet-item confirm-ok" disabled={!clean} data-testid="name-ok">
              <span class="sheet-text">{r.confirm}</span>
            </button>
            <SheetCancel onClose={close} testid="name-cancel" />
          </form>
        )}
      </div>
    </div>
  );
}
