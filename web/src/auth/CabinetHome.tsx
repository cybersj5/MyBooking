import { useEffect, useId, useState, type ReactNode } from 'react';
import { LoadingState, ErrorState } from '../App';
import { logoutExpert, type ExpertProfile } from './api';
import { useAuth } from './AuthContext';

type LogoutState =
  | { kind: 'idle' }
  | { kind: 'logging_out' }
  | { kind: 'confirmed' }
  | { kind: 'error'; message: string };

export function CabinetHome(): ReactNode {
  const auth = useAuth();
  const [logoutState, setLogoutState] = useState<LogoutState>({ kind: 'idle' });
  const [copyMessage, setCopyMessage] = useState<string | null>(null);
  const [copyError, setCopyError] = useState<string | null>(null);
  const linkId = useId();
  const liveId = useId();

  useEffect(() => {
    setLogoutState({ kind: 'idle' });
    setCopyMessage(null);
    setCopyError(null);
  }, [auth.status]);

  if (auth.status.kind === 'unknown') {
    return <LoadingState message="Загружаем профиль…" />;
  }

  if (auth.status.kind === 'anonymous') {
    return (
      <ErrorState
        message="Сессия истекла. Войдите снова."
        action={
          <a className="button" href="/login">
            Войти
          </a>
        }
      />
    );
  }

  const profile: ExpertProfile = auth.status.profile;
  const publicLink = `${window.location.origin}/experts/${encodeURIComponent(profile.publicId)}`;

  async function handleLogout(): Promise<void> {
    setLogoutState({ kind: 'logging_out' });
    const result = await logoutExpert(profile.csrfToken);
    if (result.kind === 'success') {
      setLogoutState({ kind: 'confirmed' });
      auth.clear();
      window.location.assign('/?signed_out=1');
      return;
    }
    if (result.kind === 'unauthenticated') {
      setLogoutState({ kind: 'confirmed' });
      auth.clear();
      window.location.assign('/?signed_out=1');
      return;
    }
    setLogoutState({ kind: 'error', message: result.message });
  }

  async function handleCopy(): Promise<void> {
    setCopyError(null);
    setCopyMessage(null);
    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        await navigator.clipboard.writeText(publicLink);
        setCopyMessage('Ссылка скопирована.');
        return;
      }
      throw new Error('clipboard-unavailable');
    } catch {
      setCopyError('Не удалось скопировать автоматически. Выделите ссылку и нажмите Ctrl+C.');
    }
  }

  return (
    <div className="page-content cabinet-home">
      <p className="lead">Личные данные, сессия и личная ссылка.</p>

      <section className="cabinet-card" aria-label="Профиль">
        <h2>Профиль</h2>
        <dl className="cabinet-list">
          <div>
            <dt>Имя</dt>
            <dd>{profile.name ?? 'Не задано'}</dd>
          </div>
          <div>
            <dt>Email</dt>
            <dd>{profile.email}</dd>
          </div>
          <div>
            <dt>Часовой пояс</dt>
            <dd>{profile.timezone ?? 'Не задан'}</dd>
          </div>
          <div>
            <dt>Личный идентификатор</dt>
            <dd>{profile.publicId}</dd>
          </div>
        </dl>
        <a className="button button-secondary" href="/cabinet/profile">
          Редактировать профиль
        </a>
      </section>

      <section className="cabinet-card" aria-label="Личная ссылка">
        <h2>Личная ссылка</h2>
        <p className="muted">
          Поделитесь этим адресом с гостями. По нему открывается публичная страница и запись на
          встречу.
        </p>
        <div className="cabinet-link-row">
          <input
            id={linkId}
            type="text"
            readOnly
            value={publicLink}
            aria-label="Личная ссылка"
            onFocus={(event) => event.currentTarget.select()}
          />
          <button
            type="button"
            className="button"
            aria-label="Скопировать ссылку"
            onClick={() => {
              void handleCopy();
            }}
          >
            Скопировать
          </button>
        </div>
        {copyMessage ? (
          <p className="auth-status" id={liveId} role="status" aria-live="polite">
            {copyMessage}
          </p>
        ) : null}
        {copyError ? (
          <div className="auth-alert" role="alert">
            {copyError}
          </div>
        ) : null}
      </section>

      <section className="cabinet-card" aria-label="Действия">
        <h2>Сессия</h2>
        <p className="muted">
          Выход отзывает сессию и cookie. Другие открытые вкладки попросят войти снова.
        </p>
        <button
          type="button"
          className="button button-secondary"
          aria-label="Выйти"
          onClick={() => {
            void handleLogout();
          }}
          disabled={logoutState.kind === 'logging_out'}
        >
          {logoutState.kind === 'logging_out' ? 'Выходим…' : 'Выйти'}
        </button>
        {logoutState.kind === 'error' ? (
          <div className="auth-alert" role="alert">
            {logoutState.message}
          </div>
        ) : null}
      </section>

      <p className="muted">
        Рабочие разделы кабинета (расписание, заявки, встречи) появятся в следующих задачах.
      </p>
    </div>
  );
}
