import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { LoadingState, ErrorState } from '../App';
import { useAuth } from './AuthContext';
import {
  getMyAvailability,
  previewAvailability,
  updateAvailability,
  newIdempotencyKey,
  type AffectedBooking,
  type AvailabilityInput,
  type MyAvailability,
  type WeeklyInterval,
  type Weekday,
} from './schedule-api';
import {
  BOOKING_STATUS_LABELS,
  WEEKDAY_LABELS,
  isDateValid,
  isTimeValid,
  validateDraft,
  type ValidationIssue,
} from './schedule-validation';

type Phase =
  | { kind: 'loading' }
  | { kind: 'ready' }
  | { kind: 'previewing' }
  | { kind: 'confirming'; preview: { version: string; affected: AffectedBooking[] } }
  | { kind: 'saving' }
  | { kind: 'stale' };

type Draft = {
  weeklyIntervals: WeeklyInterval[];
  excludedDates: string[];
};

type Status =
  | { kind: 'idle' }
  | { kind: 'success'; message: string }
  | { kind: 'info'; message: string };

const WEEKDAYS: Weekday[] = [1, 2, 3, 4, 5, 6, 7];

function cloneDraft(value: MyAvailability): Draft {
  return {
    weeklyIntervals: value.weeklyIntervals.map((interval) => ({ ...interval })),
    excludedDates: [...value.excludedDates],
  };
}

function draftToInput(draft: Draft): AvailabilityInput {
  return {
    weeklyIntervals: draft.weeklyIntervals.map((interval) => ({
      weekday: interval.weekday,
      startLocal: interval.startLocal,
      endLocal: interval.endLocal,
    })),
    excludedDates: [...draft.excludedDates],
  };
}

function isDirty(loaded: MyAvailability | null, draft: Draft): boolean {
  if (!loaded) return false;
  const loadedIntervals = JSON.stringify(loaded.weeklyIntervals);
  const draftIntervals = JSON.stringify(draft.weeklyIntervals);
  if (loadedIntervals !== draftIntervals) return true;
  if (loaded.excludedDates.length !== draft.excludedDates.length) return true;
  return loaded.excludedDates.some((value, index) => draft.excludedDates[index] !== value);
}

export function SchedulePage(): ReactNode {
  const auth = useAuth();
  const [loaded, setLoaded] = useState<MyAvailability | null>(null);
  const [draft, setDraft] = useState<Draft>({ weeklyIntervals: [], excludedDates: [] });
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const [idempotencyKey, setIdempotencyKey] = useState<string>(() => newIdempotencyKey());
  const [dateInput, setDateInput] = useState<string>('');
  const [dateError, setDateError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const lastFocusedRef = useRef<HTMLElement | null>(null);
  const liveRegionId = useId();
  const formStatusId = useId();

  const csrfToken = useMemo<string | null>(() => {
    if (auth.status.kind !== 'authenticated') return null;
    return auth.status.profile.csrfToken;
  }, [auth.status]);

  const loadSchedule = useCallback(async (): Promise<void> => {
    setPhase({ kind: 'loading' });
    setError(null);
    const result = await getMyAvailability();
    if (result.kind === 'success') {
      setLoaded(result.data);
      setDraft(cloneDraft(result.data));
      setPhase({ kind: 'ready' });
      return;
    }
    if (result.kind === 'unauthenticated') {
      setError('Сессия истекла. Войдите снова, чтобы редактировать расписание.');
      setPhase({ kind: 'loading' });
      return;
    }
    if (result.kind === 'profile_incomplete') {
      setError(result.message);
      setPhase({ kind: 'loading' });
      return;
    }
    setError(result.message);
    setPhase({ kind: 'loading' });
  }, []);

  useEffect(() => {
    if (auth.status.kind !== 'authenticated') return;
    void loadSchedule();
  }, [auth.status, loadSchedule]);

  // Открытие диалога: переносим фокус и запоминаем, откуда пришли.
  useEffect(() => {
    if (phase.kind !== 'confirming') {
      if (lastFocusedRef.current && typeof lastFocusedRef.current.focus === 'function') {
        lastFocusedRef.current.focus();
        lastFocusedRef.current = null;
      }
      return;
    }
    lastFocusedRef.current = (document.activeElement as HTMLElement | null) ?? null;
    const dialog = dialogRef.current;
    if (dialog) {
      const firstButton = dialog.querySelector<HTMLButtonElement>('button');
      firstButton?.focus();
    }
  }, [phase.kind]);

  // Закрытие диалога по Esc.
  useEffect(() => {
    if (phase.kind !== 'confirming') return undefined;
    function onKey(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        event.preventDefault();
        setPhase({ kind: 'ready' });
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [phase.kind]);

  const dirty = isDirty(loaded, draft);
  const issues: ValidationIssue[] = useMemo(() => validateDraft(draftToInput(draft)), [draft]);

  const updateInterval = (index: number, patch: Partial<WeeklyInterval>): void => {
    setDraft((current) => {
      const next = current.weeklyIntervals.map((interval, i) =>
        i === index ? { ...interval, ...patch } : interval,
      );
      return { ...current, weeklyIntervals: next };
    });
  };

  const removeInterval = (index: number): void => {
    setDraft((current) => {
      const next = current.weeklyIntervals.filter((_, i) => i !== index);
      return { ...current, weeklyIntervals: next };
    });
  };

  const addInterval = (weekday: Weekday): void => {
    setDraft((current) => {
      const sameDay = current.weeklyIntervals.filter((interval) => interval.weekday === weekday);
      const used = new Set(
        sameDay.map((interval) => `${interval.startLocal}-${interval.endLocal}`),
      );
      const candidates: WeeklyInterval[] = [
        { weekday, startLocal: '09:00', endLocal: '10:00' },
        { weekday, startLocal: '10:00', endLocal: '11:00' },
        { weekday, startLocal: '11:00', endLocal: '12:00' },
        { weekday, startLocal: '12:00', endLocal: '13:00' },
        { weekday, startLocal: '14:00', endLocal: '15:00' },
        { weekday, startLocal: '15:00', endLocal: '16:00' },
        { weekday, startLocal: '16:00', endLocal: '17:00' },
        { weekday, startLocal: '17:00', endLocal: '18:00' },
      ];
      const free = candidates.find(
        (interval) => !used.has(`${interval.startLocal}-${interval.endLocal}`),
      );
      const newInterval: WeeklyInterval = free ?? { weekday, startLocal: '09:00', endLocal: '10:00' };
      return { ...current, weeklyIntervals: [...current.weeklyIntervals, newInterval] };
    });
  };

  const removeExcludedDate = (index: number): void => {
    setDraft((current) => ({
      ...current,
      excludedDates: current.excludedDates.filter((_, i) => i !== index),
    }));
  };

  const tryAddExcludedDate = (): void => {
    setDateError(null);
    const value = dateInput.trim();
    if (!value) {
      setDateError('Введите дату.');
      return;
    }
    if (!isDateValid(value)) {
      setDateError('Дата должна быть в формате ГГГГ-ММ-ДД.');
      return;
    }
    if (draft.excludedDates.includes(value)) {
      setDateError('Эта дата уже добавлена.');
      return;
    }
    setDraft((current) => ({ ...current, excludedDates: [...current.excludedDates, value] }));
    setDateInput('');
  };

  const resetDraft = (): void => {
    if (!loaded) return;
    setDraft(cloneDraft(loaded));
    setStatus({ kind: 'idle' });
    setError(null);
  };

  const applySuccess = (next: MyAvailability): void => {
    setLoaded(next);
    setDraft(cloneDraft(next));
    setPhase({ kind: 'ready' });
    setIdempotencyKey(newIdempotencyKey());
    setStatus({
      kind: 'success',
      message: 'Расписание сохранено.',
    });
  };

  const handleSave = async (confirmAffected: boolean, version: string): Promise<void> => {
    if (!csrfToken || !loaded) return;
    setPhase({ kind: 'saving' });
    setError(null);
    const result = await updateAvailability(
      { ...draftToInput(draft), version, confirmAffected },
      csrfToken,
      idempotencyKey,
    );
    if (result.kind === 'success') {
      applySuccess(result.data);
      return;
    }
    if (result.kind === 'stale') {
      setError(result.message);
      setPhase({ kind: 'stale' });
      setIdempotencyKey(newIdempotencyKey());
      if (loaded) {
        setDraft(cloneDraft(loaded));
      }
      return;
    }
    if (result.kind === 'unauthenticated') {
      setError(result.message);
      setPhase({ kind: 'ready' });
      return;
    }
    setError(result.message);
    setPhase({ kind: 'ready' });
  };

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!csrfToken || !loaded) return;
    if (issues.length > 0) {
      setError('Проверьте поля расписания.');
      return;
    }
    setStatus({ kind: 'idle' });
    setError(null);
    setPhase({ kind: 'previewing' });
    const result = await previewAvailability(draftToInput(draft), csrfToken);
    if (result.kind === 'success') {
      if (result.data.affectedBookings.length === 0) {
        await handleSave(false, result.data.version);
        return;
      }
      setPhase({
        kind: 'confirming',
        preview: { version: result.data.version, affected: result.data.affectedBookings },
      });
      return;
    }
    if (result.kind === 'invalid') {
      setError(result.message);
      setPhase({ kind: 'ready' });
      return;
    }
    if (result.kind === 'unauthenticated') {
      setError(result.message);
      setPhase({ kind: 'ready' });
      return;
    }
    setError(result.message);
    setPhase({ kind: 'ready' });
  };

  if (auth.status.kind === 'unknown') {
    return <LoadingState message="Проверяем сессию…" />;
  }
  if (auth.status.kind === 'anonymous') {
    return (
      <ErrorState
        message="Сессия истекла. Войдите снова, чтобы редактировать расписание."
        action={
          <a className="button" href="/login">
            Войти
          </a>
        }
      />
    );
  }
  if (!auth.status.profile.profileComplete) {
    return (
      <ErrorState
        message="Завершите профиль, чтобы редактировать расписание."
        action={
          <a className="button" href="/cabinet/profile">
            Заполнить профиль
          </a>
        }
      />
    );
  }

  if (error && !loaded) {
    return (
      <ErrorState
        message={error}
        action={
          <button
            type="button"
            className="button"
            onClick={() => {
              void loadSchedule();
            }}
          >
            Повторить
          </button>
        }
      />
    );
  }

  if (phase.kind === 'loading' || !loaded) {
    return <LoadingState message="Загружаем расписание…" />;
  }

  const saving = phase.kind === 'previewing' || phase.kind === 'saving';
  const intervalsByWeekday = new Map<number, Array<{ interval: WeeklyInterval; index: number }>>();
  draft.weeklyIntervals.forEach((interval, index) => {
    const list = intervalsByWeekday.get(interval.weekday);
    if (list) {
      list.push({ interval, index });
    } else {
      intervalsByWeekday.set(interval.weekday, [{ interval, index }]);
    }
  });

  return (
    <div className="page-content schedule-page">
      <p className="muted">
        <a href="/cabinet">← Вернуться в кабинет</a>
      </p>
      <h1>Расписание</h1>
      <p className="lead">
        Недельные интервалы и исключённые даты. Перед сохранением покажем затронутые заявки
        и встречи.
      </p>

      {status.kind === 'success' ? (
        <p
          className="auth-status auth-status-success"
          role="status"
          aria-live="polite"
          id={liveRegionId}
        >
          {status.message}
        </p>
      ) : null}

      {error ? (
        <div className="auth-alert" role="alert" id={formStatusId}>
          {error}
        </div>
      ) : null}

      <form onSubmit={(event) => void handleSubmit(event)} className="schedule-form" noValidate>
        <fieldset className="schedule-week" disabled={saving}>
          <legend>Недельные интервалы</legend>
          {WEEKDAYS.map((weekday) => {
            const items = intervalsByWeekday.get(weekday) ?? [];
            return (
              <section
                key={weekday}
                className="schedule-day"
                aria-label={WEEKDAY_LABELS[weekday]}
              >
                <h2>{WEEKDAY_LABELS[weekday]}</h2>
                {items.length === 0 ? (
                  <p className="muted">Нет интервалов.</p>
                ) : (
                  <ul className="schedule-day-list">
                    {items.map(({ interval, index }) => (
                      <li key={`${index}-${interval.startLocal}-${interval.endLocal}`}>
                        <label className="schedule-time">
                          <span>Начало</span>
                          <input
                            type="text"
                            inputMode="numeric"
                            value={interval.startLocal}
                            onChange={(event) => {
                              updateInterval(index, { startLocal: event.target.value });
                            }}
                            aria-invalid={!isTimeValid(interval.startLocal)}
                          />
                        </label>
                        <label className="schedule-time">
                          <span>Конец</span>
                          <input
                            type="text"
                            inputMode="numeric"
                            value={interval.endLocal}
                            onChange={(event) => {
                              updateInterval(index, { endLocal: event.target.value });
                            }}
                            aria-invalid={!isTimeValid(interval.endLocal)}
                          />
                        </label>
                        <button
                          type="button"
                          className="button button-secondary"
                          onClick={() => removeInterval(index)}
                          aria-label="Удалить интервал"
                        >
                          Удалить
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                <button
                  type="button"
                  className="button button-secondary"
                  onClick={() => addInterval(weekday)}
                >
                  Добавить интервал
                </button>
              </section>
            );
          })}
        </fieldset>

        <fieldset className="schedule-excluded" disabled={saving}>
          <legend>Исключённые даты</legend>
          {draft.excludedDates.length === 0 ? (
            <p className="muted">Нет исключений.</p>
          ) : (
            <ul className="schedule-excluded-list">
              {draft.excludedDates.map((date, index) => (
                <li key={`${date}-${index}`}>
                  <span className="schedule-excluded-value">{date}</span>
                  <button
                    type="button"
                    className="button button-secondary"
                    onClick={() => removeExcludedDate(index)}
                    aria-label={`Удалить дату ${date}`}
                  >
                    Удалить
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="schedule-excluded-add">
            <label className="schedule-date">
              <span>Новая дата</span>
              <input
                type="text"
                inputMode="numeric"
                placeholder="ГГГГ-ММ-ДД"
                value={dateInput}
                onChange={(event) => {
                  setDateInput(event.target.value);
                  setDateError(null);
                }}
                aria-invalid={dateError !== null}
                aria-describedby={dateError ? `${formStatusId}-date` : undefined}
              />
            </label>
            <button
              type="button"
              className="button button-secondary"
              onClick={tryAddExcludedDate}
            >
              Добавить дату
            </button>
            {dateError ? (
              <p id={`${formStatusId}-date`} className="auth-alert" role="alert">
                {dateError}
              </p>
            ) : null}
          </div>
        </fieldset>

        <div className="schedule-actions">
          <button
            type="submit"
            className="button"
            disabled={saving || !dirty || issues.length > 0}
            aria-busy={saving}
          >
            {phase.kind === 'previewing'
              ? 'Получаем список…'
              : phase.kind === 'saving'
                ? 'Сохраняем…'
                : 'Сохранить'}
          </button>
          <button
            type="button"
            className="button button-secondary"
            onClick={resetDraft}
            disabled={saving || !dirty}
          >
            Сбросить
          </button>
        </div>
      </form>

      {phase.kind === 'confirming' ? (
        <ConfirmDialog
          preview={phase.preview}
          onCancel={() => {
            setPhase({ kind: 'ready' });
            if (loaded) {
              setDraft(cloneDraft(loaded));
            }
          }}
          onConfirm={(version) => {
            void handleSave(true, version);
          }}
          dialogRef={dialogRef}
        />
      ) : null}
    </div>
  );
}

function ConfirmDialog({
  preview,
  onCancel,
  onConfirm,
  dialogRef,
}: {
  preview: { version: string; affected: AffectedBooking[] };
  onCancel: () => void;
  onConfirm: (version: string) => void;
  dialogRef: React.RefObject<HTMLDivElement | null>;
}): ReactNode {
  const affected = preview.affected;
  const headingId = useId();
  const descriptionId = useId();
  const pending = affected.filter((item) => item.status === 'pending').length;
  const confirmed = affected.filter((item) => item.status === 'confirmed').length;
  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        aria-describedby={descriptionId}
        className="modal-card"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 id={headingId}>Изменение расписания с последствиями</h2>
        <p id={descriptionId}>
          Новое расписание отменит {confirmed} подтверждённых встреч и закроет {pending}{' '}
          ожидающих заявок ({affected.length} записей всего). Участники получат уведомления
          об отмене.
        </p>
        <ul className="modal-list">
          {affected.map((item) => (
            <li key={item.id}>
              <span className="modal-list-id">{item.id}</span>
              <span className="modal-list-status">
                {BOOKING_STATUS_LABELS[item.status]}
              </span>
            </li>
          ))}
        </ul>
        <div className="modal-actions">
          <button type="button" className="button button-secondary" onClick={onCancel}>
            Отменить
          </button>
          <button
            type="button"
            className="button"
            onClick={() => onConfirm(preview.version)}
          >
            Подтвердить и сохранить
          </button>
        </div>
      </div>
    </div>
  );
}
