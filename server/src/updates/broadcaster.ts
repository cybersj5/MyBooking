// Серверная часть обновлений интерфейса (задача 020, docs/specs/updates.md).
// Хранит активных подписчиков SSE, отправляет события «перечитай данные»
// и закрывает потоки при отзыве сессии/токена или истечении срока.

import type { AuthDatabase } from '../repository.js';
import { isGuestAccessActive, isSessionActive } from '../repository.js';

// Один такт «сверки состояния»: heartbeat :ping\n\n отправляется раз в 15 с
// (PDR §7 UI-06, ADR-001 §5), проверка отзыва/истечения — раз в 250 мс.
// Этого достаточно, чтобы тестовая отмена сессии привела к закрытию стрима
// в пределах 1.5 с (UP-03, UP-07) и не перегружать SQLite в проде.
const HEARTBEAT_INTERVAL_MS = 15_000;
const STATE_CHECK_INTERVAL_MS = 250;

// Обратный вызов записи в HTTP-ответ. Возврат false или бросок исключения
// означают, что клиент отвалился, и подписчика нужно удалить.
type SendFn = (event: string, data: string) => boolean | void;

type ExpertSubscriber = {
  kind: 'expert';
  sessionId: string;
  expertId: string;
  send: SendFn;
  close: () => void;
};

type GuestSubscriber = {
  kind: 'guest';
  tokenHash: string;
  bookingId: string;
  send: SendFn;
  close: () => void;
};

type Subscriber = ExpertSubscriber | GuestSubscriber;

export type Broadcaster = {
  subscribeExpert: (opts: {
    sessionId: string;
    expertId: string;
    send: SendFn;
    close: () => void;
  }) => () => void;
  subscribeGuest: (opts: {
    tokenHash: string;
    bookingId: string;
    send: SendFn;
    close: () => void;
  }) => () => void;
  notifyExpertBookingsChanged: (expertId: string) => void;
  notifyExpertAvailabilityChanged: (expertId: string) => void;
  notifyBookingChanged: (bookingId: string) => void;
  revokeSession: (sessionId: string) => void;
  revokeGuestAccess: (tokenHash: string) => void;
  count: () => number;
  // Останавливает общий тикер; вызывается при остановке приложения.
  shutdown: () => void;
};

function writeEvent(subscriber: Subscriber, event: string, data: string, onDead: () => void): void {
  try {
    const result = subscriber.send(event, data);
    if (result === false) onDead();
  } catch {
    onDead();
  }
}

// Heartbeat отправляется SSE-комментарием ": ping\n\n" согласно спеке
// (docs/specs/updates.md, инвариант 8). Это не именованное событие, поэтому
// реализация в stream.ts выводит только строку комментария.
function writeHeartbeat(subscriber: Subscriber, onDead: () => void): void {
  try {
    const result = subscriber.send('heartbeat', ': ping\n\n');
    if (result === false) onDead();
  } catch {
    onDead();
  }
}

export function createBroadcaster(database: AuthDatabase, now: () => number): Broadcaster {
  // Один sessionId может иметь несколько вкладок (инвариант 10).
  const expertBySession = new Map<string, Set<ExpertSubscriber>>();
  // tokenHash уникален по дизайну схемы guest_access, но в наборе оставляем Set
  // для единообразия и тестируемости.
  const guestByToken = new Map<string, Set<GuestSubscriber>>();

  function removeSubscriber(subscriber: Subscriber): void {
    if (subscriber.kind === 'expert') {
      const set = expertBySession.get(subscriber.sessionId);
      if (!set) return;
      set.delete(subscriber);
      if (set.size === 0) expertBySession.delete(subscriber.sessionId);
    } else {
      const set = guestByToken.get(subscriber.tokenHash);
      if (!set) return;
      set.delete(subscriber);
      if (set.size === 0) guestByToken.delete(subscriber.tokenHash);
    }
  }

  function closeSubscriber(subscriber: Subscriber): void {
    removeSubscriber(subscriber);
    try {
      subscriber.close();
    } catch {
      // Закрытие уже отвалившегося сокета не должно ронять бродкастер.
    }
  }

  // Общий тикер: гоняет heartbeat и сверяет состояние сессии/токена.
  let lastHeartbeat = now();
  const ticker = setInterval(() => {
    const at = now();
    const sendHeartbeat = at - lastHeartbeat >= HEARTBEAT_INTERVAL_MS;
    if (sendHeartbeat) lastHeartbeat = at;
    // Снимок подписчиков: замыкание нельзя менять во время итерации.
    const expired: Subscriber[] = [];
    for (const set of expertBySession.values()) {
      for (const sub of set) {
        if (!isSessionActive(database, sub.sessionId, at)) {
          expired.push(sub);
          continue;
        }
        if (sendHeartbeat) {
          writeHeartbeat(sub, () => expired.push(sub));
        }
      }
    }
    for (const set of guestByToken.values()) {
      for (const sub of set) {
        if (!isGuestAccessActive(database, sub.tokenHash, at)) {
          expired.push(sub);
          continue;
        }
        if (sendHeartbeat) {
          writeHeartbeat(sub, () => expired.push(sub));
        }
      }
    }
    for (const sub of expired) closeSubscriber(sub);
  }, STATE_CHECK_INTERVAL_MS);
  // Тикер удерживает процесс; при остановке приложения нужно снять.
  if (typeof ticker.unref === 'function') ticker.unref();

  function broadcastExpert(event: string, data: string): void {
    const dead: ExpertSubscriber[] = [];
    for (const set of expertBySession.values()) {
      for (const sub of set) {
        writeEvent(sub, event, data, () => dead.push(sub));
      }
    }
    for (const sub of dead) closeSubscriber(sub);
  }

  function broadcastGuest(event: string, data: string): void {
    const dead: GuestSubscriber[] = [];
    for (const set of guestByToken.values()) {
      for (const sub of set) {
        writeEvent(sub, event, data, () => dead.push(sub));
      }
    }
    for (const sub of dead) closeSubscriber(sub);
  }

  return {
    subscribeExpert(opts) {
      const subscriber: ExpertSubscriber = {
        kind: 'expert',
        sessionId: opts.sessionId,
        expertId: opts.expertId,
        send: opts.send,
        close: opts.close,
      };
      const set = expertBySession.get(opts.sessionId) ?? new Set<ExpertSubscriber>();
      set.add(subscriber);
      expertBySession.set(opts.sessionId, set);
      return () => removeSubscriber(subscriber);
    },
    subscribeGuest(opts) {
      const subscriber: GuestSubscriber = {
        kind: 'guest',
        tokenHash: opts.tokenHash,
        bookingId: opts.bookingId,
        send: opts.send,
        close: opts.close,
      };
      const set = guestByToken.get(opts.tokenHash) ?? new Set<GuestSubscriber>();
      set.add(subscriber);
      guestByToken.set(opts.tokenHash, set);
      return () => removeSubscriber(subscriber);
    },
    notifyExpertBookingsChanged(expertId) {
      // Сигнал рассылается по всем сессиям эксперта, у которых подписчик
      // числится за этим expertId. Иные эксперты ничего не получают (UP-02).
      const dead: ExpertSubscriber[] = [];
      for (const set of expertBySession.values()) {
        for (const sub of set) {
          if (sub.expertId !== expertId) continue;
          writeEvent(sub, 'bookings_changed', JSON.stringify({ type: 'bookings_changed' }), () =>
            dead.push(sub),
          );
        }
      }
      for (const sub of dead) closeSubscriber(sub);
    },
    notifyExpertAvailabilityChanged(expertId) {
      const dead: ExpertSubscriber[] = [];
      for (const set of expertBySession.values()) {
        for (const sub of set) {
          if (sub.expertId !== expertId) continue;
          writeEvent(
            sub,
            'availability_changed',
            JSON.stringify({ type: 'availability_changed' }),
            () => dead.push(sub),
          );
        }
      }
      for (const sub of dead) closeSubscriber(sub);
    },
    notifyBookingChanged(bookingId) {
      // Гостю: событие привязано к конкретной заявке (инвариант 3).
      const guestData = JSON.stringify({ type: 'bookings_changed', bookingId });
      const dead: Subscriber[] = [];
      for (const set of guestByToken.values()) {
        for (const sub of set) {
          if (sub.bookingId !== bookingId) continue;
          writeEvent(sub, 'bookings_changed', guestData, () => dead.push(sub));
        }
      }
      // Эксперту: ищем заявку, чтобы определить expertId; отсутствие заявки
      // означает, что уведомлять некого.
      const booking = database
        .prepare('SELECT expertId FROM bookings WHERE id = ?')
        .get(bookingId) as { expertId: string } | undefined;
      if (booking) {
        for (const set of expertBySession.values()) {
          for (const sub of set) {
            if (sub.expertId !== booking.expertId) continue;
            writeEvent(sub, 'bookings_changed', JSON.stringify({ type: 'bookings_changed' }), () =>
              dead.push(sub),
            );
          }
        }
      }
      for (const sub of dead) closeSubscriber(sub);
    },
    revokeSession(sessionId) {
      const set = expertBySession.get(sessionId);
      if (!set) return;
      const subs = [...set];
      for (const sub of subs) closeSubscriber(sub);
    },
    revokeGuestAccess(tokenHash) {
      const set = guestByToken.get(tokenHash);
      if (!set) return;
      const subs = [...set];
      for (const sub of subs) closeSubscriber(sub);
    },
    count() {
      let n = 0;
      for (const set of expertBySession.values()) n += set.size;
      for (const set of guestByToken.values()) n += set.size;
      return n;
    },
    shutdown() {
      clearInterval(ticker);
    },
  };
}
