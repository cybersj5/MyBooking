// Клиент публичного API проверки email гостя. Не тянет сетевые библиотеки — обычный fetch.
// Соответствует contract/main.tsp: requestGuestCode, verifyGuestCode и связанным моделям
// EmailConsentInput, ChallengeAccepted, GuestVerified.

export interface EmailConsentInput {
  email: string;
  consentVersion: string;
  consentAccepted: true;
}

export interface ChallengeAccepted {
  challengeId: string;
  expiresAt: string;
}

export interface CodeInput {
  code: string;
}

export interface GuestVerified {
  guestProof: string;
  expiresAt: string;
}

export interface ApiErrorBody {
  code: string;
  message: string;
}

// Результат POST /guest-challenges. Маппит коды ошибок contract/main.tsp
// (BadRequest, NotFound, RateLimited, MailUnavailable) на понятные варианты.
export type RequestGuestCodeResult =
  | { kind: 'success'; data: ChallengeAccepted }
  | { kind: 'rate_limited'; message: string; retryAfterSeconds: number }
  | { kind: 'mail_unavailable'; message: string }
  | { kind: 'invalid'; message: string }
  | { kind: 'not_found'; message: string }
  | { kind: 'error'; message: string };

// Результат POST /guest-challenges/{challengeId}/verify. Маппит BadRequest и NotFound.
export type VerifyGuestCodeResult =
  | { kind: 'success'; data: GuestVerified }
  | { kind: 'invalid_challenge'; message: string }
  | { kind: 'not_found'; message: string }
  | { kind: 'error'; message: string };

interface RequestGuestOptions {
  signal?: AbortSignal;
}

interface VerifyGuestOptions {
  signal?: AbortSignal;
}

export async function requestGuestCode(
  publicId: string,
  input: EmailConsentInput,
  options: RequestGuestOptions = {},
): Promise<RequestGuestCodeResult> {
  const url = new URL(
    `/api/v1/experts/${encodeURIComponent(publicId)}/guest-challenges`,
    window.location.origin,
  );

  let response: Response;
  try {
    const init: RequestInit = {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(input),
    };
    if (options.signal) init.signal = options.signal;
    response = await fetch(url, init);
  } catch (networkError) {
    const aborted = networkError instanceof Error && networkError.name === 'AbortError';
    return {
      kind: 'error',
      message: aborted ? 'Запрос прерван.' : 'Не удалось отправить запрос. Попробуйте позже.',
    };
  }

  if (response.ok) {
    try {
      const data = (await response.json()) as ChallengeAccepted;
      return { kind: 'success', data };
    } catch {
      return { kind: 'error', message: 'Не удалось разобрать ответ сервера.' };
    }
  }

  if (response.status === 429) {
    const retryAfterSeconds = parseRetryAfter(response.headers.get('Retry-After'));
    const parsed = await tryReadErrorBody(response);
    return {
      kind: 'rate_limited',
      message: parsed?.message ?? 'Слишком много попыток. Повторите позже.',
      retryAfterSeconds,
    };
  }

  if (response.status === 503) {
    const parsed = await tryReadErrorBody(response);
    return {
      kind: 'mail_unavailable',
      message: parsed?.message ?? 'Не удалось отправить письмо. Попробуйте позже.',
    };
  }

  if (response.status === 400) {
    const parsed = await tryReadErrorBody(response);
    return { kind: 'invalid', message: parsed?.message ?? 'Запрос отклонён.' };
  }

  if (response.status === 404) {
    const parsed = await tryReadErrorBody(response);
    return { kind: 'not_found', message: parsed?.message ?? 'Страница не найдена.' };
  }

  return { kind: 'error', message: 'Не удалось отправить запрос. Попробуйте позже.' };
}

export async function verifyGuestCode(
  publicId: string,
  challengeId: string,
  input: CodeInput,
  options: VerifyGuestOptions = {},
): Promise<VerifyGuestCodeResult> {
  const url = new URL(
    `/api/v1/experts/${encodeURIComponent(publicId)}/guest-challenges/${encodeURIComponent(challengeId)}/verify`,
    window.location.origin,
  );

  let response: Response;
  try {
    const init: RequestInit = {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(input),
    };
    if (options.signal) init.signal = options.signal;
    response = await fetch(url, init);
  } catch (networkError) {
    const aborted = networkError instanceof Error && networkError.name === 'AbortError';
    return {
      kind: 'error',
      message: aborted ? 'Запрос прерван.' : 'Не удалось проверить код. Попробуйте позже.',
    };
  }

  if (response.ok) {
    try {
      const data = (await response.json()) as GuestVerified;
      return { kind: 'success', data };
    } catch {
      return { kind: 'error', message: 'Не удалось разобрать ответ сервера.' };
    }
  }

  if (response.status === 400) {
    const parsed = await tryReadErrorBody(response);
    return {
      kind: 'invalid_challenge',
      message: parsed?.message ?? 'Код не подходит. Попробуйте ещё раз.',
    };
  }

  if (response.status === 404) {
    const parsed = await tryReadErrorBody(response);
    return { kind: 'not_found', message: parsed?.message ?? 'Страница не найдена.' };
  }

  return { kind: 'error', message: 'Не удалось проверить код. Попробуйте позже.' };
}

async function tryReadErrorBody(response: Response): Promise<ApiErrorBody | null> {
  try {
    const body = (await response.json()) as Partial<ApiErrorBody>;
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

function parseRetryAfter(header: string | null): number {
  if (!header) return 60;
  const value = Number(header);
  if (Number.isFinite(value) && value > 0) return value;
  const asDate = Date.parse(header);
  if (!Number.isNaN(asDate)) {
    const diff = Math.round((asDate - Date.now()) / 1000);
    return diff > 0 ? diff : 60;
  }
  return 60;
}
