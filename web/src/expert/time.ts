// Помощники отображения времени в выбранном часовом поясе гостя.
// Используем встроенные API браузера: ISO-8601 с offset парсится через Date,
// а форматирование в конкретном IANA-поясе — через Intl.DateTimeFormat.
// @js-temporal/polyfill в web не добавляется согласно инварианту 027-spec.

export interface FormattedTime {
  // Время в формате HH:mm (24-часовой) в указанном поясе.
  time: string;
  // Дата в формате "7 октября 2026 г." в указанном поясе.
  date: string;
  // IANA-идентификатор пояса, в котором выполнено форматирование.
  timezone: string;
}

export interface StartAtInfo {
  // Момент начала в миллисекундах эпохи.
  epochMs: number;
  // Смещение пояса эксперта относительно UTC в минутах на момент startAt.
  expertOffsetMinutes: number;
}

export function detectBrowserTimezone(): string {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (tz) return tz;
  } catch {
    // Браузер без поддержки Intl или без IANA-пояса: используем UTC как безопасное значение.
  }
  return 'UTC';
}

// Парсит ISO-строку вида "2026-10-07T09:00:00+07:00" в epoch-миллисекунды
// и текущее смещение offset от UTC в минутах (например, +07:00 → 420).
export function parseStartAt(iso: string): StartAtInfo {
  // Браузеры корректно разбирают ISO-8601 со смещением через Date.
  const epochMs = new Date(iso).getTime();
  const offsetMinutes = computeOffsetMinutes(iso, epochMs);
  return { epochMs, expertOffsetMinutes: offsetMinutes };
}

// Возвращает смещение ISO-строки относительно UTC в минутах.
// Использует парсинг «как если бы локально», что для ISO с явным offset
// даёт корректное смещение источника.
function computeOffsetMinutes(iso: string, epochMs: number): number {
  // Если строка содержит явный offset (Z или ±HH:mm) — извлекаем напрямую.
  const match = /([zZ])$|([+-])(\d{2}):?(\d{2})$/.exec(iso);
  if (match) {
    if (match[1]) return 0;
    const sign = match[2] === '-' ? -1 : 1;
    const hours = Number(match[3]);
    const minutes = Number(match[4]);
    return sign * (hours * 60 + minutes);
  }
  // Без явного offset: относительно локального пояса браузера. В нашем
  // сценарии API всегда возвращает offset, поэтому ветка резервная.
  const local = new Date(epochMs);
  return -local.getTimezoneOffset();
}

export function formatInTimezone(epochMs: number, timezone: string): FormattedTime {
  const time = new Intl.DateTimeFormat('ru-RU', {
    timeZone: timezone,
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(epochMs));

  const date = new Intl.DateTimeFormat('ru-RU', {
    timeZone: timezone,
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }).format(new Date(epochMs));

  return { time, date, timezone };
}

// Текущая локальная дата в поясе браузера в формате YYYY-MM-DD.
export function todayLocalDate(timezone: string): string {
  // Intl обеспечивает дату именно в нужном поясе; форматируем en-CA,
  // чтобы получить канонический порядок YYYY-MM-DD.
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const year = parts.find((p) => p.type === 'year')?.value ?? '1970';
  const month = parts.find((p) => p.type === 'month')?.value ?? '01';
  const day = parts.find((p) => p.type === 'day')?.value ?? '01';
  return `${year}-${month}-${day}`;
}

// Добавляет указанное число дней к локальной дате и возвращает YYYY-MM-DD.
export function addDaysLocalDate(date: string, days: number): string {
  const [year, month, day] = date.split('-').map((part) => Number(part));
  if (
    year === undefined ||
    month === undefined ||
    day === undefined ||
    Number.isNaN(year) ||
    Number.isNaN(month) ||
    Number.isNaN(day)
  ) {
    return date;
  }
  // Полночь UTC по нужной календарной дате, без сдвигов DST в браузерном TZ.
  const utc = Date.UTC(year, month - 1, day) + days * 24 * 60 * 60 * 1000;
  const next = new Date(utc);
  const y = next.getUTCFullYear();
  const m = String(next.getUTCMonth() + 1).padStart(2, '0');
  const d = String(next.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
