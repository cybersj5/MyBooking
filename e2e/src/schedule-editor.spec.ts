import { expect, test, type Page, type Route } from '@playwright/test';

const PRIVACY_URL = '**/api/v1/privacy';
const ME_URL = '**/api/v1/me';
const AVAILABILITY_URL = '**/api/v1/me/availability';
const PREVIEW_URL = '**/api/v1/me/availability/preview';

const privacyDocument = {
  consentVersion: 'v1',
  summary:
    'Для входа и бронирования мы используем ваши данные и отправляем письма. Перед запросом кода подтвердите согласие с этим документом.',
  document:
    'MyBooking хранит имя, адрес электронной почты, часовой пояс, расписание эксперта, сведения о заявках и встречах. Письма отправляются через Gmail SMTP. Данные остаются в локальной базе приложения без автоматического срока удаления. Чтобы запросить удаление данных, напишите владельцу на owner@example.test. В учебном MVP владелец обрабатывает такой запрос вручную.',
  deletionContact: 'owner@example.test',
  cookieNotice:
    'Для сессии эксперта необходим cookie mybooking_session. Он хранится до 30 дней с момента входа, доступен только серверу (HttpOnly), действует для сайта (Path=/, SameSite=Lax) и нужен для защиты действий в аккаунте.',
};

const completedExpertMe = {
  id: 'expert-1',
  email: 'anna@example.test',
  name: 'Анна Петрова',
  timezone: 'Asia/Krasnoyarsk',
  publicId: 'anna-pet',
  profileComplete: true,
  csrfToken: 'csrf-existing',
};

const initialSchedule = {
  timezone: 'Asia/Krasnoyarsk',
  weeklyIntervals: [
    { weekday: 1, startLocal: '09:00', endLocal: '12:00' },
    { weekday: 1, startLocal: '14:00', endLocal: '18:00' },
  ],
  excludedDates: ['2026-12-31'],
  version: 'version-1',
};

type AvailabilityPayload = {
  weeklyIntervals: Array<{ weekday: number; startLocal: string; endLocal: string }>;
  excludedDates: string[];
};

async function fulfillJson(route: Route, status: number, body: string): Promise<void> {
  await route.fulfill({
    status,
    contentType: 'application/json; charset=utf-8',
    body,
  });
}

async function mockPrivacyApi(page: Page): Promise<void> {
  await page.route(PRIVACY_URL, async (route) => {
    await fulfillJson(route, 200, JSON.stringify(privacyDocument));
  });
}

async function mockMe(page: Page, status: 200 | 401, body?: unknown): Promise<void> {
  await page.route(ME_URL, async (route) => {
    if (status === 200) {
      await fulfillJson(route, 200, JSON.stringify(body));
      return;
    }
    await fulfillJson(
      route,
      401,
      JSON.stringify({ code: 'unauthenticated', message: 'Сессия истекла.' }),
    );
  });
}

async function mockGetAvailability(
  page: Page,
  options: { status?: 200 | 401 | 500; body?: unknown } = {},
): Promise<void> {
  await page.route(AVAILABILITY_URL, async (route) => {
    if (route.request().method() !== 'GET') {
      await route.fallback();
      return;
    }
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/preview')) {
      await route.fallback();
      return;
    }
    if ((options.status ?? 200) === 200) {
      await fulfillJson(route, 200, JSON.stringify(options.body ?? initialSchedule));
      return;
    }
    if ((options.status ?? 200) === 401) {
      await fulfillJson(
        route,
        401,
        JSON.stringify({ code: 'unauthenticated', message: 'Требуется вход.' }),
      );
      return;
    }
    await fulfillJson(
      route,
      500,
      JSON.stringify({ code: 'internal_error', message: 'Внутренняя ошибка.' }),
    );
  });
}

async function mockPreview(
  page: Page,
  options: { status?: 200 | 400; body?: unknown } = {},
): Promise<{ calls: Array<AvailabilityPayload> }> {
  const calls: Array<AvailabilityPayload> = [];
  await page.route(PREVIEW_URL, async (route) => {
    if (route.request().method() !== 'POST') {
      await route.fallback();
      return;
    }
    try {
      const body = route.request().postDataJSON() as AvailabilityPayload;
      calls.push(body);
    } catch {
      calls.push({ weeklyIntervals: [], excludedDates: [] });
    }
    const status = options.status ?? 200;
    if (status === 200) {
      await fulfillJson(
        route,
        200,
        JSON.stringify(options.body ?? { version: 'version-2', affectedBookings: [] }),
      );
      return;
    }
    await fulfillJson(
      route,
      400,
      JSON.stringify({ code: 'invalid_input', message: 'Запрос отклонён.' }),
    );
  });
  return { calls };
}

async function mockPutAvailability(
  page: Page,
  options: {
    status?: 200 | 400 | 401 | 409;
    body?: unknown;
  } = {},
): Promise<{ calls: Array<{ body: unknown; idempotencyKey: string | null }> }> {
  const calls: Array<{ body: unknown; idempotencyKey: string | null }> = [];
  await page.route(AVAILABILITY_URL, async (route) => {
    if (route.request().method() !== 'PUT') {
      await route.fallback();
      return;
    }
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/preview')) {
      await route.fallback();
      return;
    }
    try {
      const body = route.request().postDataJSON();
      const idempotencyKey = route.request().headers()['idempotency-key'] ?? null;
      calls.push({ body, idempotencyKey });
    } catch {
      calls.push({ body: null, idempotencyKey: null });
    }
    const status = options.status ?? 200;
    if (status === 200) {
      await fulfillJson(
        route,
        200,
        JSON.stringify(
          options.body ?? {
            timezone: 'Asia/Krasnoyarsk',
            weeklyIntervals: [
              { weekday: 1, startLocal: '09:00', endLocal: '12:00' },
              { weekday: 1, startLocal: '14:00', endLocal: '18:00' },
            ],
            excludedDates: ['2026-12-31'],
            version: 'version-2',
          },
        ),
      );
      return;
    }
    const map: Record<number, { code: string; message: string }> = {
      400: { code: 'invalid_input', message: 'Запрос отклонён.' },
      401: { code: 'unauthenticated', message: 'Требуется вход.' },
      409: { code: 'stale_version', message: 'Список изменился, откройте просмотр заново.' },
    };
    const err = map[status] ?? { code: 'error', message: 'Ошибка.' };
    await fulfillJson(route, status, JSON.stringify(err));
  });
  return { calls };
}

async function setupExpertWithSchedule(page: Page): Promise<void> {
  await mockPrivacyApi(page);
  await mockMe(page, 200, completedExpertMe);
  await mockGetAvailability(page);
}

test.describe('S1 — открытие страницы расписания', () => {
  test('без сессии страница показывает сообщение и ссылку на вход', async ({ page }) => {
    await mockPrivacyApi(page);
    await mockMe(page, 401);
    await mockGetAvailability(page, { status: 401 });

    await page.goto('/cabinet/schedule');

    const alert = page.getByRole('alert').filter({ hasText: /войдите|Войти/ });
    await expect(alert).toBeVisible();
    await expect(page.getByRole('link', { name: 'Войти' })).toBeVisible();
  });

  test('с сессией показывает форму и ссылку возврата в кабинет', async ({ page }) => {
    await setupExpertWithSchedule(page);

    await page.goto('/cabinet');

    await page.getByRole('link', { name: /Редактировать расписание/ }).click();
    await expect(page).toHaveURL(/\/cabinet\/schedule$/);

    await expect(page.getByRole('heading', { name: /Расписание/ })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Сохранить' })).toBeVisible();
    await expect(page.getByRole('button', { name: /Сбросить/ })).toBeVisible();
  });
});

test.describe('S2 — изменение без последствий', () => {
  test('GET → правка → preview пуст → PUT применяется и показывает уведомление', async ({
    page,
  }) => {
    await setupExpertWithSchedule(page);
    const { calls: previewCalls } = await mockPreview(page, {
      status: 200,
      body: { version: 'version-2', affectedBookings: [] },
    });
    const { calls: putCalls } = await mockPutAvailability(page, { status: 200 });

    await page.goto('/cabinet/schedule');

    const tuesday = page.getByRole('region', { name: 'Вторник' });
    await tuesday.getByRole('button', { name: /Добавить интервал/ }).click();
    const startInputs = tuesday.getByRole('textbox', { name: 'Начало' });
    const endInputs = tuesday.getByRole('textbox', { name: 'Конец' });
    await startInputs.last().fill('10:00');
    await endInputs.last().fill('12:00');

    await page.getByRole('button', { name: 'Сохранить' }).click();

    await expect(
      page.getByRole('status').filter({ hasText: /Расписание сохранено/ }),
    ).toBeVisible();

    expect(previewCalls).toHaveLength(1);
    expect(previewCalls[0]?.weeklyIntervals).toEqual([
      { weekday: 1, startLocal: '09:00', endLocal: '12:00' },
      { weekday: 1, startLocal: '14:00', endLocal: '18:00' },
      { weekday: 2, startLocal: '10:00', endLocal: '12:00' },
    ]);
    expect(previewCalls[0]?.excludedDates).toEqual(['2026-12-31']);

    expect(putCalls).toHaveLength(1);
    const putBody = putCalls[0]?.body as {
      weeklyIntervals: unknown[];
      excludedDates: unknown[];
      version: string;
      confirmAffected: boolean;
    };
    expect(putBody.version).toBe('version-2');
    expect(putBody.weeklyIntervals).toEqual([
      { weekday: 1, startLocal: '09:00', endLocal: '12:00' },
      { weekday: 1, startLocal: '14:00', endLocal: '18:00' },
      { weekday: 2, startLocal: '10:00', endLocal: '12:00' },
    ]);
    expect(putCalls[0]?.idempotencyKey).toBeTruthy();
  });
});

test.describe('S3 — изменение с подтверждением', () => {
  test('GET → правка → preview с записями → диалог → Подтвердить → PUT с confirmAffected: true', async ({
    page,
  }) => {
    await setupExpertWithSchedule(page);
    const { calls: previewCalls } = await mockPreview(page, {
      status: 200,
      body: {
        version: 'version-2',
        affectedBookings: [
          { id: 'booking-1', status: 'pending' },
          { id: 'booking-2', status: 'confirmed' },
        ],
      },
    });
    const { calls: putCalls } = await mockPutAvailability(page, { status: 200 });

    await page.goto('/cabinet/schedule');

    const monday = page.getByRole('region', { name: 'Понедельник' });
    // Изменим начало первого интервала понедельника, чтобы форма стала грязной.
    const startInputs = monday.getByRole('textbox', { name: 'Начало' });
    await startInputs.first().fill('10:00');

    await page.getByRole('button', { name: 'Сохранить' }).click();

    const dialog = page.getByRole('dialog', { name: /Изменение расписания/ });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('2');
    await expect(dialog).toContainText('booking-1');
    await expect(dialog).toContainText('booking-2');

    await dialog.getByRole('button', { name: 'Подтвердить и сохранить' }).click();

    await expect(
      page.getByRole('status').filter({ hasText: /Расписание сохранено/ }),
    ).toBeVisible();

    expect(previewCalls).toHaveLength(1);
    expect(putCalls).toHaveLength(1);
    const putBody = putCalls[0]?.body as {
      weeklyIntervals: Array<{ weekday: number; startLocal: string; endLocal: string }>;
      version: string;
      confirmAffected: boolean;
    };
    expect(putBody.confirmAffected).toBe(true);
    expect(putBody.version).toBe('version-2');
    expect(putBody.weeklyIntervals).toEqual([
      { weekday: 1, startLocal: '10:00', endLocal: '12:00' },
      { weekday: 1, startLocal: '14:00', endLocal: '18:00' },
    ]);
  });
});

test.describe('S4 — отказ в диалоге', () => {
  test('Отменить закрывает диалог, форма не меняется, PUT не отправляется', async ({
    page,
  }) => {
    await setupExpertWithSchedule(page);
    await mockPreview(page, {
      status: 200,
      body: {
        version: 'version-2',
        affectedBookings: [{ id: 'booking-1', status: 'pending' }],
      },
    });
    const { calls: putCalls } = await mockPutAvailability(page);

    await page.goto('/cabinet/schedule');

    const monday = page.getByRole('region', { name: 'Понедельник' });
    await monday
      .getByRole('button', { name: /Удалить интервал/ })
      .first()
      .click();

    await page.getByRole('button', { name: 'Сохранить' }).click();
    const dialog = page.getByRole('dialog', { name: /Изменение расписания/ });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Отменить' }).click();
    await expect(dialog).toBeHidden();

    expect(putCalls).toHaveLength(0);

    const startInputs = monday.getByRole('textbox', { name: 'Начало' });
    await expect(startInputs.first()).toHaveValue('09:00');
  });
});

test.describe('S5 — устаревшая версия', () => {
  test('PUT 409 возвращает форму к загруженному состоянию и показывает сообщение', async ({
    page,
  }) => {
    await setupExpertWithSchedule(page);
    await mockPreview(page, {
      status: 200,
      body: { version: 'version-2', affectedBookings: [] },
    });
    await mockPutAvailability(page, {
      status: 409,
      body: { code: 'stale_version', message: 'Список изменился.' },
    });

    await page.goto('/cabinet/schedule');

    const monday = page.getByRole('region', { name: 'Понедельник' });
    const startInputs = monday.getByRole('textbox', { name: 'Начало' });
    await startInputs.first().fill('10:00');

    await page.getByRole('button', { name: 'Сохранить' }).click();

    const alert = page.getByRole('alert').filter({ hasText: /Список изменился/ });
    await expect(alert).toBeVisible();

    await expect(startInputs.first()).toHaveValue('09:00');
  });
});

test.describe('S6 — сессия истекла', () => {
  test('401 на GET показывает понятное сообщение и кнопку повтора', async ({ page }) => {
    await mockPrivacyApi(page);
    await mockMe(page, 200, completedExpertMe);
    await mockGetAvailability(page, { status: 401 });

    await page.goto('/cabinet/schedule');
    await page.waitForLoadState('networkidle');

    const alert = page.locator('[role="alert"]');
    await alert.waitFor({ state: 'visible', timeout: 10000 });
    await expect(alert).toContainText('Сессия истекла');
    await expect(alert).toContainText('Войдите');
    await expect(page.getByRole('button', { name: 'Повторить' })).toBeVisible();
  });
});

test.describe('S7 — телефон и клавиатура', () => {
  test('phone: нет горизонтального скролла, поля и кнопки достижимы и ≥ 44px', async ({
    page,
  }) => {
    await setupExpertWithSchedule(page);

    const [, ] = await Promise.all([
      page.waitForResponse('**/api/v1/me/availability'),
      page.goto('/cabinet/schedule'),
    ]);
    await page.waitForLoadState('networkidle');

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth + 1,
    );
    expect(overflow).toBe(false);

    const start = page.getByRole('textbox', { name: 'Начало' }).first();
    await start.focus();
    await expect(start).toBeFocused();
    // Дождёмся, пока CSS правила из Vite HMR применятся (на desktop Vite
    // применяет HMR позже, чем на phone, без ожидания высота = 21px).
    await page
      .waitForFunction(
        () => {
          const input = document.querySelector('.schedule-time input');
          if (!input) return false;
          const min = window.getComputedStyle(input).minHeight;
          return min === '44px' || min === '44.0px';
        },
        undefined,
        { timeout: 10000 },
      )
      .catch(() => undefined);
    const startBox = await start.boundingBox();
    expect(startBox?.height ?? 0).toBeGreaterThanOrEqual(44);

    // Кнопка «Сохранить» в исходном состоянии disabled; изменим поле,
    // чтобы она стала доступна, и проверим её высоту.
    await start.fill('10:00');
    const save = page.getByRole('button', { name: 'Сохранить' });
    await save.focus();
    await expect(save).toBeFocused();
    const saveBox = await save.boundingBox();
    expect(saveBox?.height ?? 0).toBeGreaterThanOrEqual(44);
  });
});
