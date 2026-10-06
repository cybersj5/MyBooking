import { Component, useEffect, useId, useState, type ReactNode } from 'react';
import { PublicExpertPage } from './expert/PublicExpertPage';
import { CookieNotice } from './cookie-notice/CookieNotice';
import { ConsentBlock } from './consent/ConsentBlock';
import { PrivacyGate, usePrivacyDocument } from './usePrivacyDocument';
import type { PrivacyDocument } from './api/privacy';
import { LoginPage } from './auth/LoginPage';
import { ProfileForm } from './auth/ProfileForm';
import { CabinetHome } from './auth/CabinetHome';
import { SchedulePage } from './auth/SchedulePage';
import { useAuth } from './auth/AuthContext';

type Theme = 'light' | 'dark';

function getInitialTheme(): Theme {
  try {
    const saved = localStorage.getItem('mybooking-theme');
    if (saved === 'light' || saved === 'dark') return saved;
  } catch {
    // Хранилище может быть недоступно; тема остаётся управляемой в текущей сессии.
  }
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

type Route =
  | { name: 'home' }
  | { name: 'login' }
  | { name: 'cabinet' }
  | { name: 'profile' }
  | { name: 'schedule' }
  | { name: 'signedOut' }
  | { name: 'expert'; publicId: string }
  | { name: 'notFound' };

function getRoute(pathname: string): Route {
  const path = pathname.replace(/\/+$/, '') || '/';
  if (path === '/') return { name: 'home' };
  if (path === '/login') return { name: 'login' };
  if (path === '/cabinet') return { name: 'cabinet' };
  if (path === '/cabinet/profile') return { name: 'profile' };
  if (path === '/cabinet/schedule') return { name: 'schedule' };
  const expertMatch = /^\/experts\/([^/]+)$/.exec(path);
  if (expertMatch && expertMatch[1]) {
    return { name: 'expert', publicId: expertMatch[1] };
  }
  return { name: 'notFound' };
}

function getSignedOutFlag(): boolean {
  try {
    const url = new URL(window.location.href);
    return url.searchParams.get('signed_out') === '1';
  } catch {
    return false;
  }
}

export function LoadingState({ message = 'Загрузка данных…' }: { message?: string }): ReactNode {
  return (
    <div className="state-panel" role="status" aria-live="polite">
      <span className="loading-line" aria-hidden="true" />
      <span className="loading-line loading-line-short" aria-hidden="true" />
      <span>{message}</span>
    </div>
  );
}

export function ErrorState({
  message,
  action,
}: {
  message: string;
  action?: ReactNode;
}): ReactNode {
  return (
    <div className="state-panel state-panel-error" role="alert">
      <strong>Не удалось продолжить</strong>
      <p>{message}</p>
      {action}
    </div>
  );
}

class AppErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (this.state.failed) {
      return (
        <main className="content">
          <ErrorState
            message="Произошла ошибка при отображении страницы. Обновите её и попробуйте снова."
            action={
              <a className="button button-secondary" href="/">
                На главную
              </a>
            }
          />
        </main>
      );
    }
    return this.props.children;
  }
}

function ThemeControl() {
  const [theme, setTheme] = useState<Theme>(getInitialTheme);
  const themeDescriptionId = useId();

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    try {
      localStorage.setItem('mybooking-theme', theme);
    } catch {
      // Блокировка хранилища не мешает переключению темы.
    }
  }, [theme]);

  const isDark = theme === 'dark';
  return (
    <button
      className="button button-secondary theme-control"
      type="button"
      aria-label="Переключить тему"
      aria-describedby={themeDescriptionId}
      aria-pressed={isDark}
      onClick={() => setTheme(isDark ? 'light' : 'dark')}
    >
      <span id={themeDescriptionId}>{isDark ? 'Тёмная тема' : 'Светлая тема'}</span>
    </button>
  );
}

function HomePage() {
  const privacy = usePrivacyDocument();
  return (
    <div className="page-content">
      <h1>MyBooking</h1>
      <p className="lead">Встречи по удобному расписанию.</p>
      <p>Эксперт делится личной ссылкой. Гость выбирает время и отправляет заявку.</p>
      <p className="muted">
        Войти как эксперт:{' '}
        <a className="button button-secondary auth-inline-action" href="/login">
          Войти
        </a>
      </p>
      <PrivacyGate result={privacy}>
        {(document) => (
          <ConsentBlock
            document={document}
            actionLabel="Запросить код"
            onSubmit={(consent) => {
              window.location.assign(
                `/login?email_consent=${encodeURIComponent(consent.consentVersion)}`,
              );
            }}
          />
        )}
      </PrivacyGate>
    </div>
  );
}

function SignedOutNotice() {
  return (
    <div className="auth-status auth-status-success" role="status" aria-live="polite">
      Вы вышли из аккаунта.
    </div>
  );
}

function CabinetGuard({ children }: { children: ReactNode }): ReactNode {
  const auth = useAuth();
  if (auth.status.kind === 'unknown') {
    return <LoadingState message="Проверяем сессию…" />;
  }
  if (auth.status.kind === 'anonymous') {
    return (
      <ErrorState
        message="Сессия истекла. Войдите снова, чтобы открыть личный кабинет."
        action={
          <a className="button" href="/login">
            Войти
          </a>
        }
      />
    );
  }
  if (!auth.status.profile.profileComplete) {
    if (typeof window !== 'undefined' && window.location.pathname !== '/cabinet/profile') {
      window.location.assign('/cabinet/profile');
    }
    return <LoadingState message="Перенаправляем на заполнение профиля…" />;
  }
  return children;
}

function ProfileGuard({ children }: { children: ReactNode }): ReactNode {
  const auth = useAuth();
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
  return children;
}

function NotFoundPage() {
  return (
    <div className="page-content">
      <h1>Страница не найдена</h1>
      <ErrorState
        message="Проверьте адрес страницы или вернитесь на главную."
        action={
          <a className="button button-secondary" href="/">
            На главную
          </a>
        }
      />
    </div>
  );
}

function GlobalPrivacySurface() {
  const privacy = usePrivacyDocument();
  if (!privacy) return null;
  if (!privacy.ok) return null;
  return <CookieNotice document={privacy.document} />;
}

function CabinetPage() {
  return (
    <div className="page-content">
      <h1>Кабинет эксперта</h1>
      <CabinetGuard>
        <CabinetHome />
      </CabinetGuard>
    </div>
  );
}

function ProfilePage() {
  return (
    <div className="page-content">
      <ProfileGuard>
        <ProfileForm />
      </ProfileGuard>
    </div>
  );
}

function ScheduleRoute() {
  return (
    <div className="page-content">
      <CabinetGuard>
        <SchedulePage />
      </CabinetGuard>
    </div>
  );
}

export function App() {
  const route = getRoute(window.location.pathname);

  return (
    <AppErrorBoundary>
      <a className="skip-link" href="#main">
        Перейти к содержанию
      </a>
      <div className="app-shell">
        <header className="site-header">
          <div className="header-inner">
            <a className="brand" href="/" aria-label="MyBooking — главная">
              MyBooking
            </a>
            <div className="header-actions">
              <nav aria-label="Основная навигация">
                <a
                  href="/cabinet"
                  aria-current={
                    route.name === 'cabinet' ||
                    route.name === 'profile' ||
                    route.name === 'schedule'
                      ? 'page'
                      : undefined
                  }
                >
                  Кабинет
                </a>
              </nav>
              <ThemeControl />
            </div>
          </div>
        </header>
        <main id="main" className="content" tabIndex={-1}>
          {route.name === 'home' && getSignedOutFlag() ? <SignedOutNotice /> : null}
          {route.name === 'home' && <HomePage />}
          {route.name === 'login' && <LoginPage />}
          {route.name === 'cabinet' && <CabinetPage />}
          {route.name === 'expert' && <PublicExpertPage publicId={route.publicId} />}
          {route.name === 'profile' && <ProfilePage />}
          {route.name === 'schedule' && <ScheduleRoute />}
          {route.name === 'notFound' && <NotFoundPage />}
        </main>
        <GlobalPrivacySurface />
      </div>
    </AppErrorBoundary>
  );
}

export type { PrivacyDocument };
