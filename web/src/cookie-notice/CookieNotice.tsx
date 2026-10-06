import { useEffect, useId, useState, type ReactNode } from 'react';
import type { PrivacyDocument } from '../api/privacy';

const STORAGE_KEY = 'mybooking-cookie-notice-dismissed';

function readDismissed(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function writeDismissed(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, '1');
  } catch {
    // Хранилище недоступно: уведомление просто закроется в текущей сессии.
  }
}

export function CookieNotice({
  document,
  onClose,
}: {
  document: PrivacyDocument;
  onClose?: () => void;
}): ReactNode {
  const regionId = useId();
  const closeLabelId = useId();
  const [visible, setVisible] = useState<boolean>(() => !readDismissed());

  useEffect(() => {
    if (!visible) return;
    if (readDismissed()) setVisible(false);
  }, [visible]);

  function handleClose() {
    writeDismissed();
    setVisible(false);
    onClose?.();
  }

  if (!visible) return null;

  return (
    <aside
      className="cookie-notice"
      role="region"
      aria-labelledby={regionId}
      aria-describedby={closeLabelId}
    >
      <div className="cookie-notice-body">
        <h2 id={regionId} className="cookie-notice-title">
          Уведомление о cookie
        </h2>
        <p className="cookie-notice-text">{document.cookieNotice}</p>
      </div>
      <div className="cookie-notice-actions">
        <button
          className="button button-secondary"
          type="button"
          aria-label="Закрыть уведомление о cookie"
          onClick={handleClose}
        >
          <span id={closeLabelId}>Закрыть</span>
        </button>
      </div>
    </aside>
  );
}
