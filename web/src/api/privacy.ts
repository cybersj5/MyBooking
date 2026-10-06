export type PrivacyDocument = {
  consentVersion: string;
  summary: string;
  document: string;
  deletionContact: string;
  cookieNotice: string;
};

export type PrivacyError = {
  message: string;
};

export type PrivacyResult =
  { ok: true; document: PrivacyDocument } | { ok: false; error: PrivacyError };

export async function fetchPrivacyDocument(
  baseUrl: string = '',
  fetcher: typeof fetch = fetch,
): Promise<PrivacyResult> {
  try {
    const response = await fetcher(`${baseUrl}/api/v1/privacy`, {
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) {
      return { ok: false, error: { message: 'Не удалось получить документ согласия.' } };
    }
    const payload = (await response.json()) as PrivacyDocument;
    if (
      typeof payload.consentVersion !== 'string' ||
      typeof payload.summary !== 'string' ||
      typeof payload.document !== 'string' ||
      typeof payload.deletionContact !== 'string' ||
      typeof payload.cookieNotice !== 'string'
    ) {
      return { ok: false, error: { message: 'Документ согласия повреждён.' } };
    }
    return { ok: true, document: payload };
  } catch (error) {
    return {
      ok: false,
      error: { message: error instanceof Error ? error.message : 'Сеть недоступна.' },
    };
  }
}
