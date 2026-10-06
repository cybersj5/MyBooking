import { useId, useState, type ReactNode } from 'react';
import { ConsentBlock, type ConsentSubmission } from '../consent/ConsentBlock';
import { usePrivacyDocument, PrivacyGate } from '../usePrivacyDocument';
import { LoadingState, ErrorState } from '../App';
import {
  isEmailValid,
  requestExpertCode,
  verifyExpertCode,
  type ChallengeAccepted,
  type ExpertVerified,
} from './api';
import { useAuth } from './AuthContext';

type RequestState =
  | { kind: 'idle' }
  | { kind: 'requesting' }
  | { kind: 'sent'; challenge: ChallengeAccepted; email: string }
  | { kind: 'error'; message: string };

type VerifyState = { kind: 'idle' } | { kind: 'verifying' } | { kind: 'error'; message: string };

type Stage = 'request' | 'verify' | 'submitted';

export function LoginPage(): ReactNode {
  const [email, setEmail] = useState('');
  const [request, setRequest] = useState<RequestState>({ kind: 'idle' });
  const [verify, setVerify] = useState<VerifyState>({ kind: 'idle' });
  const [code, setCode] = useState('');
  const [stage, setStage] = useState<Stage>('request');
  const privacy = usePrivacyDocument();
  const auth = useAuth();
  const emailId = useId();
  const codeId = useId();
  const statusId = useId();

  async function handleConsent(consent: ConsentSubmission): Promise<void> {
    const trimmed = email.trim();
    if (!isEmailValid(trimmed)) {
      setRequest({ kind: 'error', message: 'Введите корректный email.' });
      return;
    }
    setRequest({ kind: 'requesting' });
    const result = await requestExpertCode({ email: trimmed, consent });
    if (result.kind === 'success') {
      setRequest({ kind: 'sent', challenge: result.data, email: trimmed });
      setVerify({ kind: 'idle' });
      setCode('');
      setStage('verify');
      return;
    }
    setRequest({ kind: 'error', message: mapRequestError(result) });
  }

  async function handleVerify(): Promise<void> {
    if (request.kind !== 'sent') return;
    const trimmed = code.trim();
    if (!/^\d{6}$/.test(trimmed)) {
      setVerify({ kind: 'error', message: 'Код состоит из 6 цифр.' });
      return;
    }
    setVerify({ kind: 'verifying' });
    const result = await verifyExpertCode({
      challengeId: request.challenge.challengeId,
      code: trimmed,
    });
    if (result.kind === 'success') {
      const verified: ExpertVerified = result.data;
      await completeWithVerified(verified);
      return;
    }
    setVerify({ kind: 'error', message: mapVerifyError(result) });
  }

  async function completeWithVerified(verified: ExpertVerified): Promise<void> {
    setStage('submitted');
    setVerify({ kind: 'idle' });
    setRequest({ kind: 'idle' });
    auth.setError(null);
    await auth.refresh();
    if (verified.profileComplete) {
      window.location.assign('/cabinet');
    } else {
      window.location.assign('/cabinet/profile');
    }
  }

  function handleResetRequest(): void {
    setRequest({ kind: 'idle' });
    setVerify({ kind: 'idle' });
    setCode('');
    setStage('request');
  }

  return (
    <div className="page-content login-page">
      <h1>Вход эксперта</h1>
      <p className="lead">Войдите по одноразовому коду на email. Без пароля и регистрации.</p>

      <PrivacyGate result={privacy}>
        {(document) => (
          <section className="auth-form">
            <h2 className="auth-section-title">Запрос кода</h2>
            <label className="auth-field" htmlFor={emailId}>
              <span className="auth-field-label">Email</span>
              <input
                id={emailId}
                type="email"
                inputMode="email"
                autoComplete="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                disabled={request.kind === 'requesting' || stage !== 'request'}
                aria-label="Email"
                required
              />
              <span id={`${emailId}-help`} className="auth-field-help muted">
                На этот адрес придёт код. Хранилище не обещает доставку немедленно.
              </span>
            </label>

            {request.kind === 'error' ? (
              <div className="auth-alert" role="alert">
                {request.message}
              </div>
            ) : null}

            {stage === 'request' ? (
              <ConsentBlock
                document={document}
                actionLabel={request.kind === 'requesting' ? 'Отправляем…' : 'Запросить код'}
                onSubmit={(consent) => {
                  void handleConsent(consent);
                }}
              />
            ) : null}
          </section>
        )}
      </PrivacyGate>

      {stage === 'verify' && request.kind === 'sent' ? (
        <section className="auth-form">
          <h2 className="auth-section-title">Подтверждение кода</h2>
          <p className="auth-status" id={statusId} aria-live="polite">
            Код отправлен на адрес {request.email}. Действует 10 минут.
          </p>

          <label className="auth-field" htmlFor={codeId}>
            <span className="auth-field-label">Код</span>
            <input
              id={codeId}
              type="text"
              inputMode="numeric"
              pattern="\d{6}"
              maxLength={6}
              autoComplete="one-time-code"
              value={code}
              onChange={(event) => setCode(event.target.value.replace(/[^\d]/g, '').slice(0, 6))}
              aria-label="Код"
              required
            />
            <span id={`${codeId}-help`} className="auth-field-help muted">
              Шесть цифр из письма.
            </span>
          </label>

          {verify.kind === 'error' ? (
            <div className="auth-alert" role="alert">
              {verify.message}
            </div>
          ) : null}

          <div className="auth-actions">
            <button
              type="button"
              className="button"
              aria-label="Подтвердить код"
              onClick={() => {
                void handleVerify();
              }}
              disabled={verify.kind === 'verifying'}
            >
              {verify.kind === 'verifying' ? 'Проверяем…' : 'Подтвердить код'}
            </button>
            <button
              type="button"
              className="button button-secondary"
              aria-label="Запросить новый код"
              onClick={handleResetRequest}
              disabled={verify.kind === 'verifying'}
            >
              Запросить новый код
            </button>
          </div>
        </section>
      ) : null}

      {stage === 'submitted' ? <LoadingState message="Завершаем вход…" /> : null}

      {auth.lastError ? <ErrorState message={auth.lastError} /> : null}
    </div>
  );
}

function mapRequestError(
  result:
    | { kind: 'invalid'; message: string }
    | { kind: 'forbidden'; message: string }
    | { kind: 'rate_limited'; message: string }
    | { kind: 'mail_unavailable'; message: string }
    | { kind: 'error'; message: string },
): string {
  return result.message;
}

function mapVerifyError(
  result:
    | { kind: 'invalid'; message: string }
    | { kind: 'forbidden'; message: string }
    | { kind: 'error'; message: string },
): string {
  return result.message;
}
