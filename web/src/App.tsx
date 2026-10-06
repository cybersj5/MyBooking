import { Component, useEffect, useId, useState, type ReactNode } from 'react';

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

function getRoute(pathname: string): 'home' | 'cabinet' | 'notFound' {
  const path = pathname.replace(/\/+$/, '') || '/';
  if (path === '/') return 'home';
  if (path === '/cabinet') return 'cabinet';
  return 'notFound';
}

export function LoadingState({ message = 'Загрузка данных…' }: { message?: string }) {
  return (
    <div className="state-panel" role="status" aria-live="polite">
      <span className="loading-line" aria-hidden="true" />
      <span className="loading-line loading-line-short" aria-hidden="true" />
      <span>{message}</span>
    </div>
  );
}

export function ErrorState({ message, action }: { message: string; action?: ReactNode }) {
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
  return (
    <div className="page-content">
      <h1>MyBooking</h1>
      <p className="lead">Встречи по удобному расписанию.</p>
      <p>Эксперт делится личной ссылкой. Гость выбирает время и отправляет заявку.</p>
      <p className="muted">Публичная запись и вход эксперта появятся в следующих задачах.</p>
    </div>
  );
}

function CabinetPage() {
  return (
    <div className="page-content">
      <h1>Кабинет эксперта</h1>
      <p>Здесь будут расписание, заявки и встречи.</p>
      <p className="muted">Вход и рабочие разделы ещё не подключены.</p>
    </div>
  );
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
                <a href="/cabinet" aria-current={route === 'cabinet' ? 'page' : undefined}>
                  Кабинет
                </a>
              </nav>
              <ThemeControl />
            </div>
          </div>
        </header>
        <main id="main" className="content" tabIndex={-1}>
          {route === 'home' && <HomePage />}
          {route === 'cabinet' && <CabinetPage />}
          {route === 'notFound' && <NotFoundPage />}
        </main>
      </div>
    </AppErrorBoundary>
  );
}
