import { useId, useState, type ReactNode } from 'react';
import type { PrivacyDocument } from '../api/privacy';

export function DocumentDialog({
  document,
  triggerLabel = 'Открыть документ согласия',
}: {
  document: PrivacyDocument;
  triggerLabel?: string;
}): ReactNode {
  const titleId = useId();
  const [open, setOpen] = useState<boolean>(false);

  function show() {
    setOpen(true);
  }
  function close() {
    setOpen(false);
  }

  return (
    <>
      <button className="button button-secondary document-trigger" type="button" onClick={show}>
        {triggerLabel}
      </button>
      {open ? (
        <div className="document-backdrop" role="presentation" onClick={close}>
          <div
            className="document-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            onClick={(event) => event.stopPropagation()}
          >
            <h2 id={titleId} className="document-title">
              Документ о персональных данных
            </h2>
            <p className="document-version">Версия документа: {document.consentVersion}</p>
            <p className="document-body">{document.document}</p>
            <p className="document-contact">
              Контакт для удаления данных: <strong>{document.deletionContact}</strong>
            </p>
            <div className="document-actions">
              <button
                className="button"
                type="button"
                aria-label="Закрыть документ"
                onClick={close}
              >
                Закрыть
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
