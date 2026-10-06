// Клиент публичного API слотов. Не тянет сетевые библиотеки — обычный fetch.
// Соответствует contract/main.tsp: listSlots.

export type DurationMinutes = 15 | 30 | 60;

export interface Slot {
  startAt: string;
}

export interface SlotsResponse {
  timezone: string;
  slots: Slot[];
}

export interface ApiError {
  code: string;
  message: string;
}

export type ListSlotsResult =
  | { kind: 'success'; data: SlotsResponse }
  | { kind: 'notFound'; message: string }
  | { kind: 'error'; message: string };

export interface ListSlotsParams {
  publicId: string;
  from: string;
  to: string;
  durationMinutes: DurationMinutes;
  signal?: AbortSignal;
}

export async function listExpertSlots(params: ListSlotsParams): Promise<ListSlotsResult> {
  const url = new URL(
    `/api/v1/experts/${encodeURIComponent(params.publicId)}/slots`,
    window.location.origin,
  );
  url.searchParams.set('from', params.from);
  url.searchParams.set('to', params.to);
  url.searchParams.set('durationMinutes', String(params.durationMinutes));

  let response: Response;
  try {
    const init: RequestInit = {
      method: 'GET',
      headers: { Accept: 'application/json' },
    };
    if (params.signal) {
      init.signal = params.signal;
    }
    response = await fetch(url, init);
  } catch (networkError) {
    // Сетевая ошибка или прерывание. Для прерывания не показываем сообщение,
    // но оставшаяся ветка попадёт в error-состояние со стандартным текстом.
    const message =
      networkError instanceof Error && networkError.name === 'AbortError'
        ? 'Запрос прерван.'
        : 'Не удалось загрузить слоты. Попробуйте позже.';
    return { kind: 'error', message };
  }

  if (response.ok) {
    try {
      const data = (await response.json()) as SlotsResponse;
      return { kind: 'success', data };
    } catch {
      return { kind: 'error', message: 'Не удалось разобрать ответ сервера.' };
    }
  }

  if (response.status === 404) {
    return await readApiError(response, 'Страница не найдена');
  }

  return await readApiError(response, 'Не удалось загрузить слоты. Попробуйте позже.');
}

async function readApiError(response: Response, fallback: string): Promise<ListSlotsResult> {
  let parsed: ApiError | null = null;
  try {
    const body = (await response.json()) as Partial<ApiError>;
    if (
      body &&
      typeof body.code === 'string' &&
      typeof body.message === 'string' &&
      body.message.length > 0
    ) {
      parsed = { code: body.code, message: body.message };
    }
  } catch {
    // Тело пустое или не JSON — используем общий текст.
  }
  return {
    kind: response.status === 404 ? 'notFound' : 'error',
    message: parsed ? parsed.message : fallback,
  };
}
