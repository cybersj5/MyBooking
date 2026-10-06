import { useEffect, useId, useState, type ReactNode } from 'react';
import { LoadingState, ErrorState } from '../App';
import { updateProfile, type ExpertProfile } from './api';
import { useAuth } from './AuthContext';

const TIMEZONE_OPTIONS: string[] = [
  'Europe/Kaliningrad',
  'Europe/Moscow',
  'Europe/Samara',
  'Asia/Yekaterinburg',
  'Asia/Omsk',
  'Asia/Krasnoyarsk',
  'Asia/Irkutsk',
  'Asia/Yakutsk',
  'Asia/Vladivostok',
  'Asia/Magadan',
  'Asia/Kamchatka',
  'Europe/London',
  'Europe/Berlin',
  'Europe/Paris',
  'America/New_York',
  'America/Chicago',
  'America/Los_Angeles',
  'UTC',
];

export function ProfileForm(): ReactNode {
  const auth = useAuth();
  const [name, setName] = useState('');
  const [timezone, setTimezone] = useState<string>(TIMEZONE_OPTIONS[0]!);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedMessage, setSavedMessage] = useState<string | null>(null);
  const nameId = useId();
  const tzId = useId();

  useEffect(() => {
    if (auth.status.kind === 'authenticated') {
      setName(auth.status.profile.name ?? '');
      setTimezone(auth.status.profile.timezone ?? TIMEZONE_OPTIONS[0]!);
    }
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

  async function handleSubmit(): Promise<void> {
    setError(null);
    setSavedMessage(null);
    const trimmedName = name.trim();
    if (trimmedName.length === 0) {
      setError('Введите имя.');
      return;
    }
    if (trimmedName.length > 80) {
      setError('Имя не должно быть длиннее 80 символов.');
      return;
    }
    setSubmitting(true);
    const result = await updateProfile({
      name: trimmedName,
      timezone,
      csrfToken: profile.csrfToken,
    });
    setSubmitting(false);
    if (result.kind === 'success') {
      auth.setProfile(result.data);
      setSavedMessage('Профиль сохранён.');
      window.location.assign('/cabinet');
      return;
    }
    if (result.kind === 'unauthenticated') {
      auth.clear();
      setError('Сессия истекла. Войдите снова.');
      return;
    }
    setError(result.message);
  }

  return (
    <div className="page-content profile-form">
      <h1>Завершите профиль</h1>
      <p className="lead">
        Имя и часовой пояс по стандарту IANA нужны, чтобы гости видели корректное время.
      </p>

      {savedMessage ? (
        <p className="auth-status" role="status" aria-live="polite">
          {savedMessage}
        </p>
      ) : null}

      <label className="auth-field" htmlFor={nameId}>
        <span className="auth-field-label">Имя</span>
        <input
          id={nameId}
          type="text"
          autoComplete="name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          required
          maxLength={80}
          disabled={submitting}
          aria-label="Имя"
        />
      </label>

      <label className="auth-field" htmlFor={tzId}>
        <span className="auth-field-label">Часовой пояс</span>
        <select
          id={tzId}
          value={timezone}
          onChange={(event) => setTimezone(event.target.value)}
          disabled={submitting}
          aria-label="Часовой пояс"
        >
          {TIMEZONE_OPTIONS.map((tz) => (
            <option key={tz} value={tz}>
              {tz}
            </option>
          ))}
        </select>
      </label>

      {error ? (
        <div className="auth-alert" role="alert">
          {error}
        </div>
      ) : null}

      <div className="auth-actions">
        <button
          type="button"
          className="button"
          aria-label="Сохранить профиль"
          onClick={() => {
            void handleSubmit();
          }}
          disabled={submitting}
        >
          {submitting ? 'Сохраняем…' : 'Сохранить профиль'}
        </button>
        <a className="button button-secondary" href="/cabinet">
          Отмена
        </a>
        <a className="button button-secondary" href="/login">
          Выйти
        </a>
      </div>
    </div>
  );
}
