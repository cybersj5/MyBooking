import { expect, test, type Page, type Route } from '@playwright/test';

const PRIVACY_URL = '**/api/v1/privacy';
const REQUEST_URL = '**/api/v1/auth/expert/challenges';
const VERIFY_URL = '**/api/v1/auth/expert/challenges/*/verify';
const ME_URL = '**/api/v1/me';
const PROFILE_URL = '**/api/v1/me/profile';
const LOGOUT_URL = '**/api/v1/auth/logout';

const privacyDocument = {
  consentVersion: 'v1',
  summary:
    'Для входа и бронирования мы используем ваши данные и отправляем письма. Перед запросом кода подтвердите согласие с этим документом.',
  document:
    'MyBooking хранит имя, адрес электронной почты, часовой пояс, расписание эксперта, сведения о заявках и встречах. Письма отправляются через Gmail SMTP. Данные остаются в локальной базе приложения без автоматического срока удаления. Чтобы запросить удаление данных, напишите владельцу на owner@example.test. В учебном MVP владелец обрабатывает такой запрос вручную.',
  deletionContact: 'owner@example.test',
  cookieNotice:
    'Для сессии эксперта необходим cookie mybooking_session. Он хранится до 30 дней с момента входа, доступен только серверу (HttpOnly), действует для сайта (Path=/, SameSite=Lax) и нужен для защиты действий в аккаунте. Cookie можно удалить в настройках браузера или при выходе из аккаунта. Токен защиты действий передаётся отдельно и не хранится в cookie. Необязательных, аналитических и рекламных cookie нет. Это уведомление можно закрыть; оно не ограничивает просмотр слотов и бронирование.',
};

const newExpertMe = {
  id: 'expert-1',
  email: 'anna@example.test',
  name: null,
  timezone: null,
  publicId: 'anna-pet',
  profileComplete: false,
  csrfToken: 'csrf-new',
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

async function mockRequestExpertCode(
  page: Page,
  options: { status?: number; body?: unknown } = {},
): Promise<void> {
  await page.route(REQUEST_URL, async (route) => {
    const status = options.status ?? 202;
    const body =
      options.body !== undefined
        ? JSON.stringify(options.body)
        : JSON.stringify({
            challengeId: 'challenge-1',
            expiresAt: '2026-10-06T20:00:00+07:00',
          });
    await fulfillJson(route, status, body);
  });
}

async function mockVerifyExpertCode(
  page: Page,
  options: { status?: number; body?: unknown; profileComplete?: boolean; setCookie?: string } = {},
): Promise<void> {
  await page.route(VERIFY_URL, async (route) => {
    const status = options.status ?? 200;
    const headers: Record<string, string> = {};
    if (status === 200) {
      headers['Set-Cookie'] =
        options.setCookie ??
        'mybooking_session=sess-1; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000';
    }
    const body =
      options.body !== undefined
        ? JSON.stringify(options.body)
        : JSON.stringify({
            profileComplete: options.profileComplete ?? false,
            csrfToken: 'csrf-after-verify',
          });
    await route.fulfill({
      status,
      headers,
      contentType: 'application/json; charset=utf-8',
      body,
    });
  });
}

async function mockMe(page: Page, status: number, body: unknown): Promise<void> {
  await page.route(ME_URL, async (route) => {
    if (status === 200) {
      await fulfillJson(route, 200, JSON.stringify(body));
    } else {
      await fulfillJson(
        route,
        401,
        JSON.stringify({ code: 'unauthenticated', message: 'Сессия истекла.' }),
      );
    }
  });
}

async function mockMeProgressive(
  page: Page,
  stages: Array<{ status: number; body: unknown }>,
): Promise<void> {
  let index = 0;
  await page.route(ME_URL, async (route) => {
    const stage = stages[Math.min(index, stages.length - 1)];
    index += 1;
    if (!stage) {
      await fulfillJson(
        route,
        401,
        JSON.stringify({ code: 'unauthenticated', message: 'Сессия истекла.' }),
      );
      return;
    }
    if (stage.status === 200) {
      await fulfillJson(route, 200, JSON.stringify(stage.body));
    } else {
      await fulfillJson(
        route,
        401,
        JSON.stringify({ code: 'unauthenticated', message: 'Сессия истекла.' }),
      );
    }
  });
}

async function mockUpdateProfile(
  page: Page,
  options: { status?: number; body?: unknown } = {},
): Promise<void> {
  await page.route(PROFILE_URL, async (route) => {
    const status = options.status ?? 200;
    const body =
      options.body !== undefined
        ? JSON.stringify(options.body)
        : JSON.stringify({
            ...completedExpertMe,
            profileComplete: true,
          });
    await fulfillJson(route, status, body);
  });
}

async function mockLogout(page: Page): Promise<void> {
  await page.route(LOGOUT_URL, async (route) => {
    await route.fulfill({
      status: 204,
      headers: {
        'Set-Cookie': 'mybooking_session=; Path=/; Max-Age=0',
      },
    });
  });
}

async function setupHappyMocks(page: Page): Promise<void> {
  await mockPrivacyApi(page);
  await mockRequestExpertCode(page);
  await mockVerifyExpertCode(page, { profileComplete: false });
  await mockMe(page, 200, newExpertMe);
  await mockUpdateProfile(page);
  await mockLogout(page);
}

test.describe('S1 — успешный вход и заполнение профиля', () => {
  test.use({ timezoneId: 'Asia/Krasnoyarsk' });

  test('запрос кода, проверка, незавершённый профиль → форма имени и пояса → кабинет', async ({
    page,
  }) => {
    await mockPrivacyApi(page);
    await mockRequestExpertCode(page);
    await mockVerifyExpertCode(page, { profileComplete: false });
    await mockMeProgressive(page, [
      { status: 200, body: newExpertMe },
      { status: 200, body: { ...completedExpertMe, profileComplete: true } },
    ]);
    await mockUpdateProfile(page);
    await mockLogout(page);

    await page.goto('/login');

    await expect(page.getByRole('heading', { name: /Вход эксперта/ })).toBeVisible();

    const email = page.getByRole('textbox', { name: /^Email$/ });
    await expect(email).toBeVisible();
    await email.fill('anna@example.test');

    const consent = page.getByRole('checkbox', { name: /соглас/ });
    await consent.check();

    await page.getByRole('button', { name: 'Запросить код' }).click();

    await expect(page.getByText(/Код отправлен на адрес anna@example\.test/)).toBeVisible();
    const code = page.getByRole('textbox', { name: /^Код$/ });
    await expect(code).toBeVisible();
    await code.fill('123456');
    await page.getByRole('button', { name: 'Подтвердить код' }).click();

    await expect(page).toHaveURL(/\/cabinet\/profile/);
    await expect(page.getByRole('heading', { name: /Завершите профиль/ })).toBeVisible();

    const name = page.getByRole('textbox', { name: /^Имя$/ });
    const tz = page.getByRole('combobox', { name: /^Часовой пояс$/ });
    await name.fill('Анна Петрова');
    await tz.selectOption('Asia/Krasnoyarsk');
    await page.getByRole('button', { name: 'Сохранить профиль' }).click();

    await expect(page).toHaveURL(/\/cabinet$/);
    await expect(page.getByRole('heading', { name: /Кабинет эксперта/ })).toBeVisible();
    await expect(page.getByText('Анна Петрова')).toBeVisible();
    await expect(page.getByText('Asia/Krasnoyarsk')).toBeVisible();

    const link = page.getByRole('textbox', { name: /Личная ссылка/ });
    await expect(link).toHaveValue(/\/experts\/anna-pet$/);
  });
});

test.describe('S2 — неверный код и кнопка повтора', () => {
  test('сервер 400 invalid_challenge показывает безопасный текст и кнопку повтора', async ({
    page,
  }) => {
    await mockPrivacyApi(page);
    await mockRequestExpertCode(page);
    await mockVerifyExpertCode(page, {
      status: 400,
      body: { code: 'invalid_challenge', message: 'Код не подходит.' },
    });

    await page.goto('/login');
    await page.getByRole('textbox', { name: /^Email$/ }).fill('anna@example.test');
    await page.getByRole('checkbox', { name: /соглас/ }).check();
    await page.getByRole('button', { name: 'Запросить код' }).click();
    await page.getByRole('textbox', { name: /^Код$/ }).fill('000000');
    await page.getByRole('button', { name: 'Подтвердить код' }).click();

    const alert = page.getByRole('alert').filter({ hasText: /Код не подходит/ });
    await expect(alert).toBeVisible();

    const requestAgain = page.getByRole('button', { name: /Запросить новый код/ });
    await expect(requestAgain).toBeVisible();
    await requestAgain.click();
    await expect(page.getByRole('textbox', { name: /^Email$/ })).toBeVisible();
  });
});

test.describe('S3 — лимиты и недоступная почта', () => {
  test('429 показывает безопасное сообщение', async ({ page }) => {
    await mockPrivacyApi(page);
    await mockRequestExpertCode(page, {
      status: 429,
      body: { code: 'rate_limited', message: 'Слишком много попыток.' },
    });

    await page.goto('/login');
    await page.getByRole('textbox', { name: /^Email$/ }).fill('anna@example.test');
    await page.getByRole('checkbox', { name: /соглас/ }).check();
    await page.getByRole('button', { name: 'Запросить код' }).click();

    const alert = page.getByRole('alert').filter({ hasText: /Слишком много попыток/ });
    await expect(alert).toBeVisible();
    await expect(alert).not.toContainText(/аккаунт/);
  });

  test('503 mail_unavailable показывает сообщение о недоступности', async ({ page }) => {
    await mockPrivacyApi(page);
    await mockRequestExpertCode(page, {
      status: 503,
      body: { code: 'mail_unavailable', message: 'Сервер отправки писем недоступен.' },
    });

    await page.goto('/login');
    await page.getByRole('textbox', { name: /^Email$/ }).fill('anna@example.test');
    await page.getByRole('checkbox', { name: /соглас/ }).check();
    await page.getByRole('button', { name: 'Запросить код' }).click();

    const alert = page.getByRole('alert').filter({ hasText: /Сервер отправки писем/ });
    await expect(alert).toBeVisible();
  });
});

test.describe('S4 — сессия и выход', () => {
  test('истёкшая сессия возвращает на /login с сообщением', async ({ page }) => {
    await mockPrivacyApi(page);
    await page.route(ME_URL, async (route) => {
      await fulfillJson(
        route,
        401,
        JSON.stringify({ code: 'unauthenticated', message: 'Сессия истекла.' }),
      );
    });

    await page.goto('/cabinet');

    const alert = page.getByRole('alert').filter({ hasText: /Сессия истекла/ });
    await expect(alert).toBeVisible();
    await expect(page.getByRole('link', { name: /войдите снова|Войти/ })).toBeVisible();
  });

  test('выход очищает состояние и возвращает на главную с подтверждением', async ({ page }) => {
    await mockPrivacyApi(page);
    await mockRequestExpertCode(page);
    await mockVerifyExpertCode(page, { profileComplete: true });
    await mockMe(page, 200, completedExpertMe);
    await mockLogout(page);

    await page.goto('/login');
    await page.getByRole('textbox', { name: /^Email$/ }).fill('anna@example.test');
    await page.getByRole('checkbox', { name: /соглас/ }).check();
    await page.getByRole('button', { name: 'Запросить код' }).click();
    await page.getByRole('textbox', { name: /^Код$/ }).fill('123456');
    await page.getByRole('button', { name: 'Подтвердить код' }).click();

    await expect(page).toHaveURL(/\/cabinet$/);
    await expect(page.getByRole('heading', { name: /Кабинет эксперта/ })).toBeVisible();

    const logoutButton = page.getByRole('button', { name: 'Выйти' });
    await expect(logoutButton).toBeVisible();
    await logoutButton.click();

    await expect(page).toHaveURL(/\/\?signed_out=1$/);
    await expect(page.getByText(/Вы вышли из аккаунта/)).toBeVisible();
  });
});

test.describe('S5 — копирование личной ссылки', () => {
  test('кнопка копирует ссылку и объявляет успех через aria-live', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await mockPrivacyApi(page);
    await mockRequestExpertCode(page);
    await mockVerifyExpertCode(page, { profileComplete: true });
    await mockMe(page, 200, completedExpertMe);

    await page.goto('/login');
    await page.getByRole('textbox', { name: /^Email$/ }).fill('anna@example.test');
    await page.getByRole('checkbox', { name: /соглас/ }).check();
    await page.getByRole('button', { name: 'Запросить код' }).click();
    await page.getByRole('textbox', { name: /^Код$/ }).fill('123456');
    await page.getByRole('button', { name: 'Подтвердить код' }).click();

    await expect(page).toHaveURL(/\/cabinet$/);

    const copyButton = page.getByRole('button', { name: 'Скопировать ссылку' });
    await copyButton.click();

    const live = page.getByRole('status').filter({ hasText: /Ссылка скопирована/ });
    await expect(live).toBeVisible();

    const clipboard = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipboard).toMatch(/\/experts\/anna-pet$/);
  });
});

test.describe('S6 — смена имени и пояса', () => {
  test('редактирование профиля из кабинета отправляет PUT и обновляет данные', async ({ page }) => {
    await mockPrivacyApi(page);
    await mockRequestExpertCode(page);
    await mockVerifyExpertCode(page, { profileComplete: true });
    await mockMeProgressive(page, [
      { status: 200, body: completedExpertMe },
      { status: 200, body: { ...completedExpertMe, profileComplete: true } },
      { status: 200, body: { ...completedExpertMe, profileComplete: true } },
      { status: 200, body: { ...completedExpertMe, profileComplete: true } },
      {
        status: 200,
        body: {
          ...completedExpertMe,
          name: 'Анна П.',
          timezone: 'Europe/Moscow',
          profileComplete: true,
        },
      },
    ]);
    await mockUpdateProfile(page, {
      body: {
        ...completedExpertMe,
        name: 'Анна П.',
        timezone: 'Europe/Moscow',
        profileComplete: true,
      },
    });

    await page.goto('/login');
    await page.getByRole('textbox', { name: /^Email$/ }).fill('anna@example.test');
    await page.getByRole('checkbox', { name: /соглас/ }).check();
    await page.getByRole('button', { name: 'Запросить код' }).click();
    await page.getByRole('textbox', { name: /^Код$/ }).fill('123456');
    await page.getByRole('button', { name: 'Подтвердить код' }).click();

    await expect(page).toHaveURL(/\/cabinet$/);

    const edit = page.getByRole('link', { name: /Редактировать профиль/ });
    await edit.click();

    await expect(page).toHaveURL(/\/cabinet\/profile/);

    const name = page.getByRole('textbox', { name: /^Имя$/ });
    const tz = page.getByRole('combobox', { name: /^Часовой пояс$/ });
    await expect(name).toHaveValue('Анна Петрова');
    await name.fill('Анна П.');
    await tz.selectOption('Europe/Moscow');
    await page.getByRole('button', { name: 'Сохранить профиль' }).click();

    await expect(page).toHaveURL(/\/cabinet$/);
    await expect(page.getByText('Анна П.')).toBeVisible();
    await expect(page.getByText('Europe/Moscow')).toBeVisible();
  });
});

test.describe('S7 — адаптивность и клавиатура', () => {
  test('phone: нет горизонтального скролла, чекбокс и кнопка запроса ≥ 44px, доступны с клавиатуры', async ({
    page,
  }) => {
    await setupHappyMocks(page);

    await page.goto('/login');

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth + 1,
    );
    expect(overflow).toBe(false);

    const email = page.getByRole('textbox', { name: /^Email$/ });
    await email.fill('anna@example.test');

    const consent = page.getByRole('checkbox', { name: /соглас/ });
    const requestButton = page.getByRole('button', { name: 'Запросить код' });

    await consent.focus();
    await expect(consent).toBeFocused();
    await page.keyboard.press('Space');
    await expect(consent).toBeChecked();

    const consentBox = await consent.boundingBox();
    expect(consentBox?.height ?? 0).toBeGreaterThanOrEqual(44);

    await requestButton.focus();
    await expect(requestButton).toBeFocused();
    const requestBox = await requestButton.boundingBox();
    expect(requestBox?.height ?? 0).toBeGreaterThanOrEqual(44);

    await page.keyboard.press('Enter');
    await expect(page.getByText(/Код отправлен на адрес/)).toBeVisible();
  });
});
