// Клиент экспертного API расписания. Использует обычный fetch и cookie-сессию.
// Соответствует contract/main.tsp: getAvailability, previewAvailability, updateAvailability.

export type Weekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;

export type WeeklyInterval = {
  weekday: Weekday;
  startLocal: string;
  endLocal: string;
};

export type MyAvailability = {
  timezone: string;
  weeklyIntervals: WeeklyInterval[];
  excludedDates: string[];
  version: string;
};

export type AffectedBooking = {
  id: string;
  status: 'pending' | 'confirmed';
};

export type AvailabilityPreview = {
  version: string;
  affectedBookings: AffectedBooking[];
};

export type AvailabilityInput = {
  weeklyIntervals: WeeklyInterval[];
  excludedDates: string[];
};

export type AvailabilityUpdate = AvailabilityInput & {
  version: string;
  confirmAffected: boolean;
};

export type ApiError = {
  code: string;
  message: string;
};

export type GetAvailabilityResult =
  | { kind: 'success'; data: MyAvailability }
  | { kind: 'unauthenticated'; message: string }
  | { kind: 'profile_incomplete'; message: string }
  | { kind: 'error'; message: string };

export type PreviewAvailabilityResult =
  | { kind: 'success'; data: AvailabilityPreview }
  | { kind: 'unauthenticated'; message: string }
  | { kind: 'invalid'; message: string }
  | { kind: 'error'; message: string };

export type UpdateAvailabilityResult =
  | { kind: 'success'; data: MyAvailability }
  | { kind: 'unauthenticated'; message: string }
  | { kind: 'invalid'; message: string }
  | { kind: 'stale'; message: string }
  | { kind: 'error'; message: string };

async function readApiError(response: Response): Promise<ApiError | null> {
  try {
    const body = (await response.json()) as Partial<ApiError>;
    if (
      body &&
      typeof body.code === 'string' &&
      typeof body.message === 'string' &&
      body.message.length > 0
    ) {
      return { code: body.code, message: body.message };
    }
  } catch {
    // Тело пустое или не JSON.
  }
  return null;
}

export async function getMyAvailability(): Promise<GetAvailabilityResult> {
  let response: Response;
  try {
    response = await fetch('/api/v1/me/availability', {
      method: 'GET',
      credentials: 'include',
      headers: { Accept: 'application/json' },
    });
  } catch {
    return { kind: 'error', message: 'Не удалось загрузить расписание. Попробуйте позже.' };
  }

  if (response.ok) {
    try {
      const data = (await response.json()) as MyAvailability;
      return { kind: 'success', data };
    } catch {
      return { kind: 'error', message: 'Не удалось разобрать ответ сервера.' };
    }
  }

  const apiError = await readApiError(response);
  if (response.status === 401) {
    return {
      kind: 'unauthenticated',
      message: apiError?.message ?? 'Требуется вход.',
    };
  }
  if (response.status === 403) {
    return {
      kind: 'profile_incomplete',
      message: apiError?.message ?? 'Завершите профиль, чтобы изменить расписание.',
    };
  }
  return {
    kind: 'error',
    message: apiError?.message ?? 'Не удалось загрузить расписание.',
  };
}

export async function previewAvailability(
  input: AvailabilityInput,
  csrfToken: string,
): Promise<PreviewAvailabilityResult> {
  let response: Response;
  try {
    response = await fetch('/api/v1/me/availability/preview', {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-CSRF-Token': csrfToken,
      },
      body: JSON.stringify(input),
    });
  } catch {
    return {
      kind: 'error',
      message: 'Не удалось получить предварительный список. Попробуйте позже.',
    };
  }

  if (response.ok) {
    try {
      const data = (await response.json()) as AvailabilityPreview;
      return { kind: 'success', data };
    } catch {
      return { kind: 'error', message: 'Не удалось разобрать ответ сервера.' };
    }
  }

  const apiError = await readApiError(response);
  if (response.status === 400) {
    return { kind: 'invalid', message: apiError?.message ?? 'Проверьте поля расписания.' };
  }
  if (response.status === 401) {
    return {
      kind: 'unauthenticated',
      message: apiError?.message ?? 'Сессия истекла. Войдите снова.',
    };
  }
  if (response.status === 403) {
    return {
      kind: 'error',
      message: apiError?.message ?? 'Не удалось подтвердить действие. Обновите страницу.',
    };
  }
  return {
    kind: 'error',
    message: apiError?.message ?? 'Не удалось получить предварительный список.',
  };
}

export async function updateAvailability(
  input: AvailabilityUpdate,
  csrfToken: string,
  idempotencyKey: string,
): Promise<UpdateAvailabilityResult> {
  let response: Response;
  try {
    response = await fetch('/api/v1/me/availability', {
      method: 'PUT',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-CSRF-Token': csrfToken,
        'Idempotency-Key': idempotencyKey,
      },
      body: JSON.stringify(input),
    });
  } catch {
    return { kind: 'error', message: 'Не удалось сохранить расписание. Попробуйте позже.' };
  }

  if (response.ok) {
    try {
      const data = (await response.json()) as MyAvailability;
      return { kind: 'success', data };
    } catch {
      return { kind: 'error', message: 'Не удалось разобрать ответ сервера.' };
    }
  }

  const apiError = await readApiError(response);
  if (response.status === 400) {
    return { kind: 'invalid', message: apiError?.message ?? 'Проверьте поля расписания.' };
  }
  if (response.status === 401) {
    return {
      kind: 'unauthenticated',
      message: apiError?.message ?? 'Сессия истекла. Войдите снова.',
    };
  }
  if (response.status === 403) {
    return {
      kind: 'error',
      message: apiError?.message ?? 'Не удалось подтвердить действие. Обновите страницу.',
    };
  }
  if (response.status === 409) {
    return {
      kind: 'stale',
      message: apiError?.message ?? 'Список изменился, откройте просмотр заново.',
    };
  }
  return {
    kind: 'error',
    message: apiError?.message ?? 'Не удалось сохранить расписание.',
  };
}

export function newIdempotencyKey(): string {
  // Простой уникальный ключ на основе времени и Math.random. Сервер ожидает непустую строку.
  const random = Math.random().toString(36).slice(2, 10);
  return `sched-${Date.now().toString(36)}-${random}`;
}
