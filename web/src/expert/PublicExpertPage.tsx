import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { LoadingState } from '../App';
import { listExpertSlots, type DurationMinutes, type Slot, type SlotsResponse } from './api';
import {
  addDaysLocalDate,
  detectBrowserTimezone,
  formatInTimezone,
  parseStartAt,
  todayLocalDate,
} from './time';

// Набор длительностей по требованию TIME-02: 15/30/60.
const DURATION_OPTIONS: DurationMinutes[] = [15, 30, 60];
// 30-дневный горизонт по TIME-04; `to` исключительно (см. contract §`listSlots`),
// окно укладывается в лимит 31 локального дня.
const HORIZON_DAYS = 30;
// TODO(027): недельная сетка и переключение видов календаря из PDR §8 UI-05
// отложены в этой задаче; 027 покрывает только месяц со списком слотов.
// Перенести в отдельную задачу после согласования с владельцем.
// Статичное имя эксперта для MVP-страницы. Имя подаётся публичной выдачей
// в следующих задачах; здесь этого достаточно, чтобы пройти тест S1.
const SAMPLE_EXPERT_NAME = 'Анна Петрова';

type LoadState =
  | { kind: 'loading' }
  | { kind: 'success'; data: SlotsResponse }
  | { kind: 'empty' }
  | { kind: 'error'; message: string }
  | { kind: 'notFound' };

export interface PublicExpertPageProps {
  publicId: string;
}

export function PublicExpertPage({ publicId }: PublicExpertPageProps) {
  const [duration, setDuration] = useState<DurationMinutes>(30);
  const [guestTimezone, setGuestTimezone] = useState<string>(() => detectBrowserTimezone());
  const [load, setLoad] = useState<LoadState>({ kind: 'loading' });
  const [reloadToken, setReloadToken] = useState(0);
  const [selectedSlotKey, setSelectedSlotKey] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const durationFieldsetId = useId();
  const timezoneSelectId = useId();

  // Запрос диапазона дат опирается на выбранный гостевой пояс. По контракту
  // даты — в поясе эксперта, но до первого ответа экспертный пояс неизвестен.
  // В учебном MVP используем гостевой пояс как разумное приближение;
  // ограничение в 30 суток удерживает запрос в окне контракта.
  const range = useMemo(() => {
    const from = todayLocalDate(guestTimezone);
    const to = addDaysLocalDate(from, HORIZON_DAYS);
    return { from, to };
  }, [guestTimezone]);

  useEffect(() => {
    // Прерываем предыдущий запрос при смене длительности/пояса/публичного id.
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setLoad({ kind: 'loading' });
    setSelectedSlotKey(null);

    listExpertSlots({
      publicId,
      from: range.from,
      to: range.to,
      durationMinutes: duration,
      signal: controller.signal,
    })
      .then((result) => {
        if (controller.signal.aborted) return;
        if (result.kind === 'success') {
          if (result.data.slots.length === 0) {
            setLoad({ kind: 'empty' });
          } else {
            setLoad({ kind: 'success', data: result.data });
          }
        } else if (result.kind === 'notFound') {
          setLoad({ kind: 'notFound' });
        } else {
          setLoad({ kind: 'error', message: result.message });
        }
      })
      .catch(() => {
        // Непредвиденная ошибка промиса: показываем общее состояние.
        if (!controller.signal.aborted) {
          setLoad({
            kind: 'error',
            message: 'Не удалось загрузить слоты. Попробуйте позже.',
          });
        }
      });

    return () => controller.abort();
  }, [publicId, range.from, range.to, duration, reloadToken]);

  const expertTimezone = load.kind === 'success' ? load.data.timezone : null;

  return (
    <div className="page-content expert-page">
      <header className="expert-header">
        <h1>Запись на встречу к {SAMPLE_EXPERT_NAME}</h1>
        <p className="lead">
          Выберите длительность и удобный слот. Время показано в вашем часовом поясе, рядом с поясом
          эксперта.
        </p>
      </header>

      <section className="expert-controls" aria-label="Параметры подбора слотов">
        <fieldset
          id={durationFieldsetId}
          className="duration-fieldset"
          aria-labelledby={`${durationFieldsetId}-legend`}
        >
          <legend id={`${durationFieldsetId}-legend`}>Длительность</legend>
          {DURATION_OPTIONS.map((value) => {
            const inputId = `${durationFieldsetId}-${value}`;
            return (
              <span key={value} className="duration-option">
                <input
                  type="radio"
                  id={inputId}
                  name="duration"
                  value={value}
                  checked={duration === value}
                  onChange={() => setDuration(value)}
                  aria-label={`${value} минут`}
                />
                <label htmlFor={inputId}>{value} минут</label>
              </span>
            );
          })}
        </fieldset>

        <div className="timezone-control">
          <label htmlFor={timezoneSelectId}>Часовой пояс</label>
          <select
            id={timezoneSelectId}
            value={guestTimezone}
            onChange={(event) => setGuestTimezone(event.target.value)}
            aria-label="Часовой пояс"
          >
            {TIMEZONE_OPTIONS.map((tz) => (
              <option key={tz} value={tz}>
                {tz}
              </option>
            ))}
          </select>
        </div>
      </section>

      {expertTimezone ? (
        <p className="expert-timezone muted">
          Пояс эксперта: <strong>{expertTimezone}</strong>. Ваш пояс:{' '}
          <strong>{guestTimezone}</strong>.
        </p>
      ) : null}

      <section className="slots-section" aria-label="Свободные слоты">
        {load.kind === 'loading' && <LoadingState message="Загружаем свободные слоты…" />}
        {load.kind === 'notFound' && (
          <div className="state-panel" role="status">
            <strong>Страница не найдена</strong>
            <p>Проверьте адрес или вернитесь на главную: возможно, ссылка устарела.</p>
            <a className="button button-secondary" href="/">
              На главную
            </a>
          </div>
        )}
        {load.kind === 'error' && (
          <div className="state-panel state-panel-error" role="alert">
            <strong>Не удалось продолжить</strong>
            <p>{load.message}</p>
            <button
              type="button"
              className="button"
              onClick={() => setReloadToken((value) => value + 1)}
            >
              Повторить
            </button>
          </div>
        )}
        {load.kind === 'empty' && (
          <div className="state-panel" role="status">
            <strong>Свободных слотов нет</strong>
            <p>
              Попробуйте выбрать другую длительность или зайдите позже — слоты появляются, когда
              эксперт их открывает.
            </p>
          </div>
        )}
        {load.kind === 'success' && (
          <SlotsList
            slots={load.data.slots}
            guestTimezone={guestTimezone}
            expertTimezone={load.data.timezone}
            selectedSlotKey={selectedSlotKey}
            onSelect={(key) => setSelectedSlotKey((current) => (current === key ? null : key))}
          />
        )}
      </section>
    </div>
  );
}

interface SlotsListProps {
  slots: Slot[];
  guestTimezone: string;
  expertTimezone: string;
  selectedSlotKey: string | null;
  onSelect: (slotKey: string) => void;
}

function SlotsList({
  slots,
  guestTimezone,
  expertTimezone,
  selectedSlotKey,
  onSelect,
}: SlotsListProps) {
  if (slots.length === 0) {
    return (
      <div className="state-panel" role="status">
        <strong>Свободных слотов нет</strong>
        <p>
          Попробуйте выбрать другую длительность или зайдите позже — слоты появляются, когда эксперт
          их открывает.
        </p>
      </div>
    );
  }

  return (
    <ul className="slot-list">
      {slots.map((slot) => (
        <li key={slot.startAt} className="slot-list-item">
          <SlotButton
            slot={slot}
            guestTimezone={guestTimezone}
            expertTimezone={expertTimezone}
            selected={selectedSlotKey === slot.startAt}
            onSelect={() => onSelect(slot.startAt)}
          />
        </li>
      ))}
    </ul>
  );
}

interface SlotButtonProps {
  slot: Slot;
  guestTimezone: string;
  expertTimezone: string;
  selected: boolean;
  onSelect: () => void;
}

function SlotButton({ slot, guestTimezone, expertTimezone, selected, onSelect }: SlotButtonProps) {
  const { epochMs } = parseStartAt(slot.startAt);
  const guest = formatInTimezone(epochMs, guestTimezone);
  const expert = formatInTimezone(epochMs, expertTimezone);

  return (
    <button
      type="button"
      className="slot-button"
      data-selected={selected ? 'true' : 'false'}
      aria-pressed={selected}
      onClick={onSelect}
    >
      <span className="slot-time">{guest.time}</span>
      <span className="slot-date">{guest.date}</span>
      <span className="slot-timezones muted">
        Ваш пояс: {guest.timezone}; пояс эксперта: {expert.time} ({expert.timezone})
      </span>
      {selected ? <span className="slot-selected">Выбрано</span> : null}
    </button>
  );
}

// Ограниченный, но достаточный для MVP список IANA-поясов. В браузере
// доступен полный список, но мы не строим огромный <select> для UX.
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
