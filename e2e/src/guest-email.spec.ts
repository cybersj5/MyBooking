import { expect, test, type Page, type Route } from '@playwright/test';

// Маршруты публичного API для guest email-челленджа на странице sample-expert.
const PRIVACY_URL = '**/api/v1/privacy';
const SLOTS_URL = '**/api/v1/experts/sample-expert/slots*';
const REQUEST_GUEST_CODE_URL = '**/api/v1/experts/sample-expert/guest-challenges';
const VERIFY_GUEST_CODE_URL = '**/api/v1/experts/sample-expert/guest-challenges/*/verify';

// Документ согласия: соответствует privacy.spec.ts и web/src/api/privacy.ts.
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

// Минимум: два слота, чтобы был запас на селекты.
const successFixture = {
  timezone: 'Asia/Krasnoyarsk',
  slots: [{ startAt: '2026-10-07T09:00:00+07:00' }, { startAt: '2026-10-07T09:30:00+07:00' }],
};

const guestName = 'Иван Гость';
const guestEmail = 'guest@example.test';

async function fulfillJson(route: Route, status: number, body: string): Promise<void> {
  await route.fulfill({
    status,
    contentType: 'application/json; charset=utf-8',
    body,
  });
}

async function mockCommonApis(page: Page): Promise<void> {
  await page.route(PRIVACY_URL, async (route) => {
    await fulfillJson(route, 200, JSON.stringify(privacyDocument));
  });
  await page.route(SLOTS_URL, async (route) => {
    await fulfillJson(route, 200, JSON.stringify(successFixture));
  });
}

// Открывает страницу эксперта и кликает по первому слоту, чтобы появилась форма гостя.
async function openExpertPageAndSelectSlot(page: Page): Promise<void> {
  await page.goto('/experts/sample-expert');
  const firstSlot = page
    .getByRole('button')
    .filter({ hasText: /09:00.*?(?:Asia|Красноярск)/ })
    .first();
  await expect(firstSlot).toBeVisible();
  await firstSlot.click();
}

test.beforeEach(async ({ page }) => {
  await mockCommonApis(page);
});

// S1 — успешный запрос кода: имя + email + галочка → POST /guest-challenges (202)
// → видим «Код отправлен на адрес …» и поле ввода кода.
// PDR AUTH-07, AC-01, AC-20, PRIV-01; DESIGN «Публичная страница эксперта» шаги 3–5;
// identity ID-07; contract main.tsp `requestGuestCode` (EmailConsentInput → ChallengeAccepted).
test('S1 — успешный запрос кода после выбора слота и согласия', async ({ page }) => {
  let requestPayload: unknown = null;
  await page.route(REQUEST_GUEST_CODE_URL, async (route) => {
    requestPayload = JSON.parse(route.request().postData() ?? '{}');
    await fulfillJson(
      route,
      202,
      JSON.stringify({
        challengeId: 'challenge-1',
        expiresAt: '2026-10-07T10:00:00+07:00',
      }),
    );
  });

  await openExpertPageAndSelectSlot(page);

  const nameField = page.getByLabel('Имя');
  await expect(nameField).toBeVisible();
  await nameField.fill(guestName);

  const emailField = page.getByLabel('Email');
  await expect(emailField).toBeVisible();
  await emailField.fill(guestEmail);

  const consent = page.getByRole('checkbox', { name: /соглас/ });
  await expect(consent).toBeVisible();
  await consent.check();

  const requestButton = page.getByRole('button', { name: 'Запросить код' });
  await expect(requestButton).toBeEnabled();
  await Promise.all([
    page.waitForResponse(
      (response) =>
        response.url().includes('/api/v1/experts/sample-expert/guest-challenges') &&
        response.request().method() === 'POST' &&
        !/\/verify$/.test(response.url()),
    ),
    requestButton.click(),
  ]);

  expect(requestPayload).toEqual({
    email: guestEmail,
    consentVersion: 'v1',
    consentAccepted: true,
  });

  const sentStatus = page.getByRole('status').filter({ hasText: /Код отправлен на адрес/ });
  await expect(sentStatus).toBeVisible();
  await expect(sentStatus).toContainText(guestEmail);

  const codeField = page.getByLabel('Код');
  await expect(codeField).toBeVisible();
});

// S2 — успешная проверка кода: ввод 6-значного кода → POST .../verify (200)
// → «Email подтверждён», guestProof хранится в DOM, но не виден гостю.
// PDR AUTH-07, AC-01/02; identity ID-07; contract `verifyGuestCode` (CodeInput → GuestVerified).
test('S2 — успешная проверка кода возвращает guestProof, секрет не отображается', async ({
  page,
}) => {
  const challengeId = 'challenge-2';
  const guestProof = 'opaque-guest-proof-secret-not-for-display';

  await page.route(REQUEST_GUEST_CODE_URL, async (route) => {
    await fulfillJson(
      route,
      202,
      JSON.stringify({ challengeId, expiresAt: '2026-10-07T10:00:00+07:00' }),
    );
  });

  let verifyPayload: unknown = null;
  await page.route(VERIFY_GUEST_CODE_URL, async (route) => {
    verifyPayload = JSON.parse(route.request().postData() ?? '{}');
    await fulfillJson(
      route,
      200,
      JSON.stringify({ guestProof, expiresAt: '2026-10-07T10:00:00+07:00' }),
    );
  });

  await openExpertPageAndSelectSlot(page);

  await page.getByLabel('Имя').fill(guestName);
  await page.getByLabel('Email').fill(guestEmail);
  await page.getByRole('checkbox', { name: /соглас/ }).check();
  await page.getByRole('button', { name: 'Запросить код' }).click();

  const codeField = page.getByLabel('Код');
  await expect(codeField).toBeVisible();
  await codeField.fill('123456');

  const confirmButton = page.getByRole('button', { name: 'Подтвердить' });
  await expect(confirmButton).toBeEnabled();
  await Promise.all([
    page.waitForResponse((response) =>
      response.url().includes(`/guest-challenges/${challengeId}/verify`),
    ),
    confirmButton.click(),
  ]);

  expect(verifyPayload).toEqual({ code: '123456' });

  const confirmed = page.getByRole('status').filter({ hasText: /Email подтвержд[её]н/ });
  await expect(confirmed).toBeVisible();

  // Секрет должен присутствовать в DOM, но не отображаться гостю открытым текстом.
  const visibleText = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
  expect(visibleText.includes(guestProof)).toBe(false);

  const proofHolder = page.locator(`[data-guest-proof], [name="guestProof"], input[type="hidden"]`);
  const proofCount = await proofHolder.count();
  let proofInDom = false;
  for (let i = 0; i < proofCount; i += 1) {
    const handle = proofHolder.nth(i);
    const value = await handle.evaluate((el) => {
      if (el instanceof HTMLInputElement) return el.value;
      return el.getAttribute('data-guest-proof') ?? '';
    });
    if (value === guestProof) {
      proofInDom = true;
      break;
    }
  }
  expect(proofInDom).toBe(true);
});

// S3 — неверный код: 400 invalid_challenge → понятное сообщение под полем кода,
// «Подтвердить» снова доступна.
// PDR AC-01; identity «Неверный, использованный, заменённый или просроченный код» → 400 invalid_challenge.
test('S3 — неверный код показывает понятную ошибку и оставляет кнопку «Подтвердить» доступной', async ({
  page,
}) => {
  const challengeId = 'challenge-3';

  await page.route(REQUEST_GUEST_CODE_URL, async (route) => {
    await fulfillJson(
      route,
      202,
      JSON.stringify({ challengeId, expiresAt: '2026-10-07T10:00:00+07:00' }),
    );
  });
  await page.route(VERIFY_GUEST_CODE_URL, async (route) => {
    await fulfillJson(
      route,
      400,
      JSON.stringify({
        code: 'invalid_challenge',
        message: 'Код не подходит. Попробуйте ещё раз.',
      }),
    );
  });

  await openExpertPageAndSelectSlot(page);
  await page.getByLabel('Имя').fill(guestName);
  await page.getByLabel('Email').fill(guestEmail);
  await page.getByRole('checkbox', { name: /соглас/ }).check();
  await page.getByRole('button', { name: 'Запросить код' }).click();

  const codeField = page.getByLabel('Код');
  await expect(codeField).toBeVisible();
  await codeField.fill('000000');

  const confirmButton = page.getByRole('button', { name: 'Подтвердить' });
  await expect(confirmButton).toBeEnabled();
  await Promise.all([
    page.waitForResponse((response) =>
      response.url().includes(`/guest-challenges/${challengeId}/verify`),
    ),
    confirmButton.click(),
  ]);

  const errorAlert = page.getByRole('alert').filter({ hasText: /Код не подходит/ });
  await expect(errorAlert).toBeVisible();
  await expect(errorAlert).toContainText(/Попробуйте/);

  await expect(confirmButton).toBeEnabled();
});

// S4 — истёкший/заменённый код: 400 invalid_challenge «Код истёк. Запросите новый»
// → пользователь видит текст и доступную кнопку «Запросить новый код».
// PDR AC-01; identity «Код истёк» и «замена делает старый код недействительным».
test('S4 — истёкший код предлагает кнопку «Запросить новый код»', async ({ page }) => {
  const challengeId = 'challenge-4';

  await page.route(REQUEST_GUEST_CODE_URL, async (route) => {
    await fulfillJson(
      route,
      202,
      JSON.stringify({ challengeId, expiresAt: '2026-10-07T10:00:00+07:00' }),
    );
  });
  await page.route(VERIFY_GUEST_CODE_URL, async (route) => {
    await fulfillJson(
      route,
      400,
      JSON.stringify({
        code: 'invalid_challenge',
        message: 'Код истёк. Запросите новый',
      }),
    );
  });

  await openExpertPageAndSelectSlot(page);
  await page.getByLabel('Имя').fill(guestName);
  await page.getByLabel('Email').fill(guestEmail);
  await page.getByRole('checkbox', { name: /соглас/ }).check();
  await page.getByRole('button', { name: 'Запросить код' }).click();

  const codeField = page.getByLabel('Код');
  await expect(codeField).toBeVisible();
  await codeField.fill('654321');

  await Promise.all([
    page.waitForResponse((response) =>
      response.url().includes(`/guest-challenges/${challengeId}/verify`),
    ),
    page.getByRole('button', { name: 'Подтвердить' }).click(),
  ]);

  const errorAlert = page.getByRole('alert').filter({ hasText: /Код истёк/ });
  await expect(errorAlert).toBeVisible();
  await expect(errorAlert).toContainText(/Запросите новый/);

  const renewButton = page.getByRole('button', { name: 'Запросить новый код' });
  await expect(renewButton).toBeEnabled();
});

// S5 — без галочки согласия кнопка «Запросить код» недоступна.
// PDR PRIV-01, AC-20; DESIGN «пустая по умолчанию галочка обязательна для действия».
test('S5 — кнопка «Запросить код» недоступна без согласия и переключается галочкой', async ({
  page,
}) => {
  await openExpertPageAndSelectSlot(page);

  await page.getByLabel('Имя').fill(guestName);
  await page.getByLabel('Email').fill(guestEmail);

  const consent = page.getByRole('checkbox', { name: /соглас/ });
  await expect(consent).toBeVisible();
  await expect(consent).not.toBeChecked();

  const requestButton = page.getByRole('button', { name: 'Запросить код' });
  await expect(requestButton).toBeVisible();
  await expect(requestButton).toBeDisabled();

  await consent.check();
  await expect(consent).toBeChecked();
  await expect(requestButton).toBeEnabled();

  await consent.uncheck();
  await expect(consent).not.toBeChecked();
  await expect(requestButton).toBeDisabled();
});

// S6 — пустые имя/email не отправляют запрос и показывают понятное сообщение.
// PDR PRIV-01, AC-20; DESIGN «поле — метка сверху, пояснение/ошибка под полем».
test('S6 — пустые имя или email не отправляют запрос и показывают ошибку обязательности', async ({
  page,
}) => {
  let requestCount = 0;
  await page.route(REQUEST_GUEST_CODE_URL, async (route) => {
    requestCount += 1;
    await fulfillJson(
      route,
      202,
      JSON.stringify({ challengeId: 'noop', expiresAt: '2026-10-07T10:00:00+07:00' }),
    );
  });

  await openExpertPageAndSelectSlot(page);

  const consent = page.getByRole('checkbox', { name: /соглас/ });
  await consent.check();

  const requestButton = page.getByRole('button', { name: 'Запросить код' });
  await expect(requestButton).toBeEnabled();

  // Оба поля пусты — попытка отправки обязана быть заблокирована.
  await requestButton.click();
  await expect(consent).toBeChecked();

  // Поля подсвечиваются как обязательные, понятные сообщения об ошибке.
  const nameError = page.getByText(/Укажите имя|имя обязательно/i);
  const emailError = page.getByText(/Укажите email|email обязателен/i);
  await expect(nameError).toBeVisible();
  await expect(emailError).toBeVisible();

  expect(requestCount).toBe(0);
});

// S7 — 429 rate_limited → «Слишком много попыток. Повторите через N секунд»,
// кнопка «Запросить код» недоступна на указанное время.
// PDR identity инвариант 3 «Запросы кода ограничены» → 429 rate_limited с Retry-After.
test('S7 — превышение лимита выдачи кода показывает сообщение и блокирует кнопку', async ({
  page,
}) => {
  await page.route(REQUEST_GUEST_CODE_URL, async (route) => {
    await route.fulfill({
      status: 429,
      headers: { 'Retry-After': '60' },
      contentType: 'application/json; charset=utf-8',
      body: JSON.stringify({
        code: 'rate_limited',
        message: 'Слишком много попыток. Повторите через 60 секунд.',
      }),
    });
  });

  await openExpertPageAndSelectSlot(page);
  await page.getByLabel('Имя').fill(guestName);
  await page.getByLabel('Email').fill(guestEmail);
  await page.getByRole('checkbox', { name: /соглас/ }).check();

  const requestButton = page.getByRole('button', { name: 'Запросить код' });
  await expect(requestButton).toBeEnabled();
  await Promise.all([
    page.waitForResponse(
      (response) =>
        response.url().includes('/api/v1/experts/sample-expert/guest-challenges') &&
        response.request().method() === 'POST',
    ),
    requestButton.click(),
  ]);

  const rateLimitAlert = page.getByRole('alert').filter({ hasText: /Слишком много попыток/ });
  await expect(rateLimitAlert).toBeVisible();
  await expect(rateLimitAlert).toContainText(/60/);

  await expect(requestButton).toBeDisabled();
});

// S8 — 503 mail_unavailable → «Не удалось отправить письмо. Попробуйте позже»,
// без кнопки повтора.
// PDR identity «Gmail недоступен при обычной выдаче кода эксперта или гостя» → 503 mail_unavailable.
test('S8 — недоступность почты показывает сообщение без кнопки повтора', async ({ page }) => {
  await page.route(REQUEST_GUEST_CODE_URL, async (route) => {
    await fulfillJson(
      route,
      503,
      JSON.stringify({
        code: 'mail_unavailable',
        message: 'Не удалось отправить письмо. Попробуйте позже.',
      }),
    );
  });

  await openExpertPageAndSelectSlot(page);
  await page.getByLabel('Имя').fill(guestName);
  await page.getByLabel('Email').fill(guestEmail);
  await page.getByRole('checkbox', { name: /соглас/ }).check();

  const requestButton = page.getByRole('button', { name: 'Запросить код' });
  await expect(requestButton).toBeEnabled();
  await Promise.all([
    page.waitForResponse(
      (response) =>
        response.url().includes('/api/v1/experts/sample-expert/guest-challenges') &&
        response.request().method() === 'POST',
    ),
    requestButton.click(),
  ]);

  const mailAlert = page.getByRole('alert').filter({ hasText: /Не удалось отправить письмо/ });
  await expect(mailAlert).toBeVisible();

  // Повтор кода не предлагается, кнопка «Запросить код» в обычном виде недоступна.
  await expect(
    page.getByRole('button', { name: /Запросить новый код|Повторить запрос кода/ }),
  ).toHaveCount(0);
});

// S9 — успешная проверка кода не создаёт аккаунт: в гостевом потоке не должно появиться
// элементов входа, регистрации или личного кабинета.
// PDR AUTH-07 «это не создаёт аккаунт», AC-01 «аккаунт ему не создаётся».
test('S9 — успешная проверка кода не показывает вход, регистрацию и личный кабинет', async ({
  page,
}) => {
  const challengeId = 'challenge-9';
  await page.route(REQUEST_GUEST_CODE_URL, async (route) => {
    await fulfillJson(
      route,
      202,
      JSON.stringify({ challengeId, expiresAt: '2026-10-07T10:00:00+07:00' }),
    );
  });
  await page.route(VERIFY_GUEST_CODE_URL, async (route) => {
    await fulfillJson(
      route,
      200,
      JSON.stringify({
        guestProof: 'opaque-proof-9',
        expiresAt: '2026-10-07T10:00:00+07:00',
      }),
    );
  });

  await openExpertPageAndSelectSlot(page);
  await page.getByLabel('Имя').fill(guestName);
  await page.getByLabel('Email').fill(guestEmail);
  await page.getByRole('checkbox', { name: /соглас/ }).check();
  await page.getByRole('button', { name: 'Запросить код' }).click();

  const codeField = page.getByLabel('Код');
  await expect(codeField).toBeVisible();
  await codeField.fill('111111');
  await page.getByRole('button', { name: 'Подтвердить' }).click();

  // Ожидаем, что UI перешёл в verified-фазу: видимый статус заменяет ожидание ответа и
  // устраняет гонку с обработчиком fetch. PDR AC-01, AC-02.
  await expect
    .poll(() =>
      page
        .getByRole('status')
        .filter({ hasText: /Email подтвержд[её]н/ })
        .isVisible(),
    )
    .toBe(true);

  await expect(page.getByRole('status').filter({ hasText: /Email подтвержд[её]н/ })).toBeVisible();

  const guestSurfaceText = (await page.locator('main').innerText()).replace(/\s+/g, ' ');
  expect(/Войти/.test(guestSurfaceText)).toBe(false);
  expect(/Создать аккаунт/.test(guestSurfaceText)).toBe(false);
  expect(/Личный кабинет/.test(guestSurfaceText)).toBe(false);
  expect(/Регистрация/.test(guestSurfaceText)).toBe(false);
});
