// Поток проверки email гостя на публичной странице эксперта. Шаги PDR «Публичная страница
// эксперта» 3–5: после выбора слота собираем имя/email, согласие и одноразовый код;
// секрет guestProof не показываем открытым текстом и не логируем (identity инвариант 9).

import { useId, useState, type ReactNode } from 'react';
import { ConsentBlock, type ConsentSubmission } from '../consent/ConsentBlock';
import { PrivacyGate, usePrivacyDocument } from '../usePrivacyDocument';
import type { PrivacyDocument } from '../api/privacy';
import { requestGuestCode, verifyGuestCode } from './api';

// Состояние UI гостевого потока. Не хранит код и email между экранами; они передаются
// через компонент и не разделяются между разными выборами слотов.
type Phase =
  | { kind: 'collecting' }
  | { kind: 'codeSent'; challengeId: string }
  | { kind: 'verified'; guestProof: string };

type RequestError =
  | { kind: 'rate_limited'; message: string }
  | { kind: 'mail_unavailable'; message: string }
  | { kind: 'generic'; message: string };

// Сообщение API о неверном коде разделяется на «обычный отказ» и «истёкший код»,
// чтобы UI предложил либо повторить ввод, либо запросить новый код.
type VerifyError = { kind: 'invalid'; message: string } | { kind: 'expired'; message: string };

export interface GuestEmailFlowProps {
  publicId: string;
  // Привязка к выбранному слоту нужна только для сводки и сброса состояния при смене.
  slotKey: string;
  slotLabel: string;
}

export function GuestEmailFlow({ publicId, slotKey, slotLabel }: GuestEmailFlowProps): ReactNode {
  const privacy = usePrivacyDocument();
  return (
    <PrivacyGate result={privacy}>
      {(document) => (
        <GuestEmailFlowBody
          key={slotKey}
          publicId={publicId}
          slotLabel={slotLabel}
          privacyDocument={document}
        />
      )}
    </PrivacyGate>
  );
}

interface GuestEmailFlowBodyProps {
  publicId: string;
  slotLabel: string;
  privacyDocument: PrivacyDocument;
}

function GuestEmailFlowBody({
  publicId,
  slotLabel,
  privacyDocument,
}: GuestEmailFlowBodyProps): ReactNode {
  const [name, setName] = useState<string>('');
  const [email, setEmail] = useState<string>('');
  const [code, setCode] = useState<string>('');
  const [nameError, setNameError] = useState<string | null>(null);
  const [emailError, setEmailError] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: 'collecting' });
  const [requestError, setRequestError] = useState<RequestError | null>(null);
  const [verifyError, setVerifyError] = useState<VerifyError | null>(null);
  const [requestInFlight, setRequestInFlight] = useState<boolean>(false);
  const [verifyInFlight, setVerifyInFlight] = useState<boolean>(false);

  const nameFieldId = useId();
  const emailFieldId = useId();
  const codeFieldId = useId();

  // Свободная обработка ввода имени: при изменении сбрасываем ошибку обязательности.
  function handleNameChange(value: string): void {
    setName(value);
    if (nameError) setNameError(null);
  }

  function handleEmailChange(value: string): void {
    setEmail(value);
    if (emailError) setEmailError(null);
  }

  function handleCodeChange(value: string): void {
    setCode(value);
  }

  function validateCollectingForm(): boolean {
    let valid = true;
    if (name.trim().length === 0) {
      setNameError('Укажите имя');
      valid = false;
    }
    if (email.trim().length === 0) {
      setEmailError('Укажите email');
      valid = false;
    }
    return valid;
  }

  async function handleConsentSubmit(consent: ConsentSubmission): Promise<void> {
    if (requestInFlight) return;
    if (!validateCollectingForm()) return;
    setRequestError(null);
    setRequestInFlight(true);
    const result = await requestGuestCode(publicId, {
      email,
      consentVersion: consent.consentVersion,
      consentAccepted: true,
    });
    setRequestInFlight(false);
    if (result.kind === 'success') {
      setPhase({ kind: 'codeSent', challengeId: result.data.challengeId });
      return;
    }
    if (result.kind === 'rate_limited') {
      setRequestError({ kind: 'rate_limited', message: result.message });
      return;
    }
    if (result.kind === 'mail_unavailable') {
      setRequestError({ kind: 'mail_unavailable', message: result.message });
      return;
    }
    setRequestError({ kind: 'generic', message: result.message });
  }

  async function handleVerify(): Promise<void> {
    if (phase.kind !== 'codeSent') return;
    if (verifyInFlight) return;
    if (code.trim().length === 0) return;
    const challengeId = phase.challengeId;
    setVerifyError(null);
    setVerifyInFlight(true);
    const result = await verifyGuestCode(publicId, challengeId, { code });
    setVerifyInFlight(false);
    if (result.kind === 'success') {
      setPhase({ kind: 'verified', guestProof: result.data.guestProof });
      return;
    }
    if (result.kind === 'invalid_challenge') {
      const expired = /ист[её]к/i.test(result.message);
      setVerifyError(
        expired
          ? { kind: 'expired', message: result.message }
          : { kind: 'invalid', message: result.message },
      );
      return;
    }
    setVerifyError({ kind: 'invalid', message: result.message });
  }

  function handleRequestNewCode(): void {
    // Полный сброс к сбору имени/email: повторный запрос кода возможен после согласия.
    setPhase({ kind: 'collecting' });
    setCode('');
    setVerifyError(null);
  }

  // Согласие и отправка кода на время загрузки считаются занятыми.
  const submitBlocked = requestInFlight || requestError !== null;

  return (
    <section className="guest-section" aria-label="Шаг гостя">
      <h2 className="guest-section-title">Подтверждение адреса</h2>
      <p className="guest-section-slot muted">
        Выбранный слот: <strong>{slotLabel}</strong>
      </p>

      {phase.kind === 'verified' ? (
        <GuestVerifiedState guestProof={phase.guestProof} email={email} />
      ) : phase.kind === 'codeSent' ? (
        <GuestCodeForm
          codeFieldId={codeFieldId}
          email={email}
          code={code}
          onCodeChange={handleCodeChange}
          verifyError={verifyError}
          verifyInFlight={verifyInFlight}
          onVerify={() => {
            void handleVerify();
          }}
          onRequestNewCode={handleRequestNewCode}
        />
      ) : (
        <>
          <p className="guest-section-lead">
            Введите имя и email, затем подтвердите согласие. На email придёт одноразовый код для
            проверки.
          </p>
          <div className="guest-field">
            <label htmlFor={nameFieldId}>Имя</label>
            <input
              id={nameFieldId}
              type="text"
              autoComplete="name"
              value={name}
              onChange={(event) => handleNameChange(event.target.value)}
              aria-invalid={nameError !== null}
              aria-describedby={nameError !== null ? `${nameFieldId}-error` : undefined}
              disabled={requestInFlight}
            />
            {nameError !== null ? (
              <p id={`${nameFieldId}-error`} className="guest-field-error">
                {nameError}
              </p>
            ) : null}
          </div>
          <div className="guest-field">
            <label htmlFor={emailFieldId}>Email</label>
            <input
              id={emailFieldId}
              type="email"
              autoComplete="email"
              value={email}
              onChange={(event) => handleEmailChange(event.target.value)}
              aria-invalid={emailError !== null}
              aria-describedby={emailError !== null ? `${emailFieldId}-error` : undefined}
              disabled={requestInFlight}
            />
            {emailError !== null ? (
              <p id={`${emailFieldId}-error`} className="guest-field-error">
                {emailError}
              </p>
            ) : null}
          </div>
          {requestError !== null ? (
            <div role="alert" className="guest-alert guest-alert-error">
              <p>{requestError.message}</p>
            </div>
          ) : null}
          <ConsentBlock
            document={privacyDocument}
            onSubmit={(submission) => {
              void handleConsentSubmit(submission);
            }}
            submitDisabled={submitBlocked}
          />
        </>
      )}
    </section>
  );
}

interface GuestVerifiedStateProps {
  guestProof: string;
  email: string;
}

function GuestVerifiedState({ guestProof, email }: GuestVerifiedStateProps): ReactNode {
  return (
    <div className="guest-verified" data-testid="guest-verified">
      <p role="status" className="guest-section-status">
        Email подтверждён. Заявка почти готова — следующий шаг добавится позже.
      </p>
      <p className="guest-section-status muted">
        Подтверждение действует 10 минут для адреса {email}.
      </p>
      {/* Секрет guestProof хранится в DOM как скрытое поле и не виден гостю.
          identity инвариант 9 запрещает показывать его в API или логах. */}
      <input type="hidden" name="guestProof" value={guestProof} data-guest-proof={guestProof} />
    </div>
  );
}

interface GuestCodeFormProps {
  codeFieldId: string;
  email: string;
  code: string;
  onCodeChange: (value: string) => void;
  verifyError: VerifyError | null;
  verifyInFlight: boolean;
  onVerify: () => void;
  onRequestNewCode: () => void;
}

function GuestCodeForm({
  codeFieldId,
  email,
  code,
  onCodeChange,
  verifyError,
  verifyInFlight,
  onVerify,
  onRequestNewCode,
}: GuestCodeFormProps): ReactNode {
  const showConfirm = verifyError === null || verifyError.kind === 'invalid';
  return (
    <>
      <p role="status" className="guest-section-status">
        Код отправлен на адрес {email}. Введите его ниже.
      </p>
      <div className="guest-field">
        <label htmlFor={codeFieldId}>Код</label>
        <input
          id={codeFieldId}
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          value={code}
          onChange={(event) => onCodeChange(event.target.value)}
          disabled={verifyInFlight}
        />
      </div>
      {verifyError !== null ? (
        <div role="alert" className="guest-alert guest-alert-error">
          <p>{verifyError.message}</p>
          {verifyError.kind === 'expired' ? (
            <button
              type="button"
              className="button"
              aria-label="Запросить новый код"
              onClick={onRequestNewCode}
            >
              Запросить новый код
            </button>
          ) : null}
        </div>
      ) : null}
      {showConfirm ? (
        <button
          type="button"
          className="button"
          onClick={onVerify}
          disabled={verifyInFlight || code.trim().length === 0}
        >
          Подтвердить
        </button>
      ) : null}
    </>
  );
}
