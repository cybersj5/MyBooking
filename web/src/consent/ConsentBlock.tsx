import { useId, useState, type ReactNode } from 'react';
import type { PrivacyDocument } from '../api/privacy';
import { DocumentDialog } from '../document/DocumentDialog';

export type ConsentSubmission = {
  consentVersion: string;
  consentAccepted: true;
};

export function ConsentBlock({
  document,
  actionLabel = 'Запросить код',
  onSubmit,
}: {
  document: PrivacyDocument;
  actionLabel?: string;
  onSubmit?: (consent: ConsentSubmission) => void;
}): ReactNode {
  const checkboxId = useId();
  const helpId = useId();
  const [accepted, setAccepted] = useState<boolean>(false);

  function handleSubmit() {
    if (!accepted) return;
    onSubmit?.({
      consentVersion: document.consentVersion,
      consentAccepted: true,
    });
  }

  return (
    <section className="consent-block" aria-label="Согласие на обработку данных">
      <h2 className="consent-title">Согласие на обработку данных</h2>
      <p className="consent-summary" id={helpId}>
        {document.summary}
      </p>
      <div className="consent-actions">
        <DocumentDialog document={document} />
      </div>
      <label className="consent-checkbox" htmlFor={checkboxId}>
        <input
          id={checkboxId}
          type="checkbox"
          checked={accepted}
          aria-describedby={helpId}
          onChange={(event) => setAccepted(event.target.checked)}
        />
        <span>
          Я согласен(на) с обработкой персональных данных согласно документу выше (версия{' '}
          {document.consentVersion}).
        </span>
      </label>
      <div className="consent-submit">
        <button
          className="button"
          type="button"
          disabled={!accepted}
          aria-label={actionLabel}
          onClick={handleSubmit}
        >
          {actionLabel}
        </button>
      </div>
    </section>
  );
}
