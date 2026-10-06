// Клиент экспертного API входа, профиля и выхода. Не тянет сетевые библиотеки — обычный fetch.
// Соответствует contract/main.tsp: requestExpertCode, verifyExpertCode, getMe, updateProfile, logout.

export type ConsentSubmission = {
  consentVersion: string;
  consentAccepted: true;
};

export type ExpertProfile = {
  id: string;
  email: string;
  name: string | null;
  timezone: string | null;
  publicId: string;
  profileComplete: boolean;
  csrfToken: string;
};

export type ExpertVerified = {
  profileComplete: boolean;
  csrfToken: string;
};

export type ChallengeAccepted = {
  challengeId: string;
  expiresAt: string;
};

export type ApiError = {
  code: string;
  message: string;
};

export type ExpertRequestCodeInput = {
  email: string;
  consent: ConsentSubmission;
};

export type RequestExpertCodeResult =
  | { kind: 'success'; data: ChallengeAccepted }
  | { kind: 'invalid'; message: string }
  | { kind: 'rate_limited'; message: string }
  | { kind: 'mail_unavailable'; message: string }
  | { kind: 'forbidden'; message: string }
  | { kind: 'error'; message: string };

export type VerifyExpertCodeInput = {
  challengeId: string;
  code: string;
};

export type VerifyExpertCodeResult =
  | { kind: 'success'; data: ExpertVerified }
  | { kind: 'invalid'; message: string }
  | { kind: 'forbidden'; message: string }
  | { kind: 'error'; message: string };

export type MeResult =
  | { kind: 'authenticated'; data: ExpertProfile }
  | { kind: 'unauthenticated'; message: string }
  | { kind: 'error'; message: string };

export type UpdateProfileInput = {
  name: string;
  timezone: string;
  csrfToken: string;
};

export type UpdateProfileResult =
  | { kind: 'success'; data: ExpertProfile }
  | { kind: 'invalid'; message: string }
  | { kind: 'forbidden'; message: string }
  | { kind: 'unauthenticated'; message: string }
  | { kind: 'error'; message: string };

export type LogoutResult =
  | { kind: 'success' }
  | { kind: 'unauthenticated'; message: string }
  | { kind: 'forbidden'; message: string }
  | { kind: 'error'; message: string };

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isEmailValid(value: string): boolean {
  return EMAIL_REGEX.test(value.trim());
}

export async function requestExpertCode(
  input: ExpertRequestCodeInput,
): Promise<RequestExpertCodeResult> {
  let response: Response;
  try {
    response = await fetch('/api/v1/auth/expert/challenges', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        email: input.email.trim(),
        consentVersion: input.consent.consentVersion,
        consentAccepted: true,
      }),
    });
  } catch {
    return {
      kind: 'error',
      message: 'Не удалось отправить запрос. Проверьте соединение и попробуйте снова.',
    };
  }
  return parseRequestExpertCodeResponse(response);
}

export async function parseRequestExpertCodeResponse(
  response: Response,
): Promise<RequestExpertCodeResult> {
  if (response.status === 202) {
    try {
      const data = (await response.json()) as ChallengeAccepted;
      return { kind: 'success', data };
    } catch {
      return { kind: 'error', message: 'Не удалось разобрать ответ сервера.' };
    }
  }
  const apiError = await readApiError(response);
  if (response.status === 400) {
    return { kind: 'invalid', message: apiError?.message ?? 'Запрос отклонён.' };
  }
  if (response.status === 403) {
    return {
      kind: 'forbidden',
      message: apiError?.message ?? 'Запрос отклонён проверкой источника.',
    };
  }
  if (response.status === 429) {
    return {
      kind: 'rate_limited',
      message: apiError?.message ?? 'Слишком много попыток. Подождите минуту и попробуйте снова.',
    };
  }
  if (response.status === 503) {
    return {
      kind: 'mail_unavailable',
      message: apiError?.message ?? 'Сервер отправки писем недоступен. Попробуйте позже.',
    };
  }
  return {
    kind: 'error',
    message: apiError?.message ?? 'Не удалось отправить запрос.',
  };
}

export async function verifyExpertCode(
  input: VerifyExpertCodeInput,
): Promise<VerifyExpertCodeResult> {
  let response: Response;
  try {
    response = await fetch(
      `/api/v1/auth/expert/challenges/${encodeURIComponent(input.challengeId)}/verify`,
      {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ code: input.code.trim() }),
      },
    );
  } catch {
    return {
      kind: 'error',
      message: 'Не удалось подтвердить код. Проверьте соединение и попробуйте снова.',
    };
  }

  if (response.status === 200) {
    try {
      const data = (await response.json()) as ExpertVerified;
      return { kind: 'success', data };
    } catch {
      return { kind: 'error', message: 'Не удалось разобрать ответ сервера.' };
    }
  }

  const apiError = await readApiError(response);
  if (response.status === 400) {
    return {
      kind: 'invalid',
      message:
        apiError?.message ?? 'Код не подходит. Проверьте последнюю цифру или запросите новый.',
    };
  }
  if (response.status === 403) {
    return {
      kind: 'forbidden',
      message: apiError?.message ?? 'Запрос отклонён проверкой источника.',
    };
  }
  return {
    kind: 'error',
    message: apiError?.message ?? 'Не удалось подтвердить код.',
  };
}

export async function fetchMe(): Promise<MeResult> {
  let response: Response;
  try {
    response = await fetch('/api/v1/me', {
      method: 'GET',
      credentials: 'include',
      headers: { Accept: 'application/json' },
    });
  } catch {
    return { kind: 'error', message: 'Не удалось получить профиль. Попробуйте позже.' };
  }

  if (response.status === 200) {
    try {
      const data = (await response.json()) as ExpertProfile;
      return { kind: 'authenticated', data };
    } catch {
      return { kind: 'error', message: 'Не удалось разобрать ответ сервера.' };
    }
  }

  const apiError = await readApiError(response);
  if (response.status === 401) {
    return {
      kind: 'unauthenticated',
      message: apiError?.message ?? 'Сессия истекла.',
    };
  }
  return {
    kind: 'error',
    message: apiError?.message ?? 'Не удалось получить профиль.',
  };
}

export async function updateProfile(input: UpdateProfileInput): Promise<UpdateProfileResult> {
  let response: Response;
  try {
    response = await fetch('/api/v1/me/profile', {
      method: 'PUT',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-CSRF-Token': input.csrfToken,
      },
      body: JSON.stringify({ name: input.name.trim(), timezone: input.timezone }),
    });
  } catch {
    return {
      kind: 'error',
      message: 'Не удалось сохранить профиль. Проверьте соединение и попробуйте снова.',
    };
  }

  if (response.status === 200) {
    try {
      const data = (await response.json()) as ExpertProfile;
      return { kind: 'success', data };
    } catch {
      return { kind: 'error', message: 'Не удалось разобрать ответ сервера.' };
    }
  }

  const apiError = await readApiError(response);
  if (response.status === 400) {
    return { kind: 'invalid', message: apiError?.message ?? 'Проверьте поля профиля.' };
  }
  if (response.status === 401) {
    return {
      kind: 'unauthenticated',
      message: apiError?.message ?? 'Сессия истекла. Войдите снова.',
    };
  }
  if (response.status === 403) {
    return {
      kind: 'forbidden',
      message: apiError?.message ?? 'Не удалось подтвердить действие. Обновите страницу.',
    };
  }
  return {
    kind: 'error',
    message: apiError?.message ?? 'Не удалось сохранить профиль.',
  };
}

export async function logoutExpert(csrfToken: string): Promise<LogoutResult> {
  let response: Response;
  try {
    response = await fetch('/api/v1/auth/logout', {
      method: 'POST',
      credentials: 'include',
      headers: {
        Accept: 'application/json',
        'X-CSRF-Token': csrfToken,
      },
    });
  } catch {
    return {
      kind: 'error',
      message: 'Не удалось выйти. Проверьте соединение и попробуйте снова.',
    };
  }

  if (response.status === 204) {
    return { kind: 'success' };
  }

  const apiError = await readApiError(response);
  if (response.status === 401) {
    return {
      kind: 'unauthenticated',
      message: apiError?.message ?? 'Сессия уже истекла.',
    };
  }
  if (response.status === 403) {
    return {
      kind: 'forbidden',
      message: apiError?.message ?? 'Не удалось подтвердить действие. Обновите страницу.',
    };
  }
  return {
    kind: 'error',
    message: apiError?.message ?? 'Не удалось выйти.',
  };
}

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
