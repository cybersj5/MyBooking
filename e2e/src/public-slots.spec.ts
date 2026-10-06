import { expect, test, type Route } from '@playwright/test';

// Маршрут публичного API слотов для sample-expert. Глоб поддерживает query-параметры.
const SLOTS_URL = '**/api/v1/experts/sample-expert/slots*';

const successFixture = {
  timezone: 'Asia/Krasnoyarsk',
  slots: [
    { startAt: '2026-10-07T09:00:00+07:00' },
    { startAt: '2026-10-07T09:15:00+07:00' },
    { startAt: '2026-10-07T09:30:00+07:00' },
    { startAt: '2026-10-08T09:00:00+07:00' },
  ],
};

const hourOnlyFixture = {
  timezone: 'Asia/Krasnoyarsk',
  slots: [{ startAt: '2026-10-07T09:00:00+07:00' }, { startAt: '2026-10-08T09:00:00+07:00' }],
};

const emptyFixture = {
  timezone: 'Asia/Krasnoyarsk',
  slots: [],
};

const internalErrorBody = '{"code":"internal","message":"Сбой сервера."}';
const notFoundBody = '{"code":"not_found","message":"Не найдено."}';

// Текст ячейки слота содержит время HH:mm и IANA-идентификатор (или русское имя) пояса гостя.
const slotTextRegex = /(09:00|09:15|09:30).*?(?:Asia|Красноярск)/;
const slotMoscowTextRegex = /(05:00|09:00).*?(?:Europe\/Moscow|Москв)/;

async function fulfillJson(route: Route, status: number, body: string): Promise<void> {
  await route.fulfill({
    status,
    contentType: 'application/json; charset=utf-8',
    body,
  });
}

test.describe('S1 — успешная выдача слотов', () => {
  test.use({ timezoneId: 'Asia/Krasnoyarsk' });

  test('S1 main — имя эксперта, длительности, пояс и 4 слота с явным IANA', async ({ page }) => {
    await page.route(SLOTS_URL, async (route) => {
      await fulfillJson(route, 200, JSON.stringify(successFixture));
    });

    await page.goto('/experts/sample-expert');

    await expect(
      page.getByRole('heading', {
        name: /Анна Петрова|Свободные слоты|Запись на встречу/,
      }),
    ).toBeVisible();

    await expect(page.getByRole('radio', { name: /15 минут/ })).toBeVisible();
    await expect(page.getByRole('radio', { name: /30 минут/ })).toBeVisible();
    await expect(page.getByRole('radio', { name: /60 минут/ })).toBeVisible();
    await expect(page.getByRole('radio', { name: /30 минут/ })).toBeChecked();

    const timezone = page.getByLabel('Часовой пояс');
    await expect(timezone).toBeVisible();
    await expect(timezone).toHaveValue('Asia/Krasnoyarsk');

    const slots = page.getByRole('button').filter({ hasText: slotTextRegex });
    await expect(slots).toHaveCount(4);
    await expect(slots.first()).toBeVisible();
    await expect(slots.first()).toContainText(/(?:Asia|Красноярск)/);
  });

  test('S1.1 — смена длительности 60 минут перезапрашивает слоты', async ({ page }) => {
    await page.route(SLOTS_URL, async (route) => {
      const url = new URL(route.request().url());
      const duration = url.searchParams.get('durationMinutes');
      if (duration === '60') {
        await fulfillJson(route, 200, JSON.stringify(hourOnlyFixture));
      } else {
        await fulfillJson(route, 200, JSON.stringify(successFixture));
      }
    });

    await page.goto('/experts/sample-expert');

    const request60 = page.waitForRequest((req) => {
      if (!req.url().includes('/api/v1/experts/sample-expert/slots')) {
        return false;
      }
      return new URL(req.url()).searchParams.get('durationMinutes') === '60';
    });

    await page.getByRole('radio', { name: /60 минут/ }).click();

    const request = await request60;
    expect(new URL(request.url()).searchParams.get('durationMinutes')).toBe('60');

    const slots60 = page.getByRole('button').filter({ hasText: /09:00.*?(?:Asia|Красноярск)/ });
    await expect(slots60).toHaveCount(2);
  });

  test('S1.2 — смена часового пояса гостя перерисовывает слоты без нового запроса', async ({
    page,
  }) => {
    const requests: string[] = [];
    await page.route(SLOTS_URL, async (route) => {
      requests.push(route.request().url());
      await fulfillJson(route, 200, JSON.stringify(successFixture));
    });

    await page.goto('/experts/sample-expert');

    const timezone = page.getByLabel('Часовой пояс');
    await expect(timezone).toHaveValue('Asia/Krasnoyarsk');
    const initialRequests = requests.length;

    const slotBefore = page.getByRole('button').filter({ hasText: /09:00.*?(?:Asia|Красноярск)/ });
    await expect(slotBefore.first()).toBeVisible();

    await timezone.selectOption('Europe/Moscow');

    const slotAfter = page.getByRole('button').filter({ hasText: slotMoscowTextRegex });
    await expect(slotAfter.first()).toBeVisible();

    expect(requests.length).toBe(initialRequests);
  });

  test('S1.3 — клик по слоту ставит aria-pressed/Выбрано, повторный снимает, высота ≥ 44px', async ({
    page,
  }) => {
    await page.route(SLOTS_URL, async (route) => {
      await fulfillJson(route, 200, JSON.stringify(successFixture));
    });

    await page.goto('/experts/sample-expert');

    const firstSlot = page
      .getByRole('button')
      .filter({ hasText: /09:00.*?(?:Asia|Красноярск)/ })
      .first();
    await expect(firstSlot).toBeVisible();

    await firstSlot.click();
    const afterClick = await firstSlot.evaluate((el) => ({
      pressed: el.getAttribute('aria-pressed'),
      text: (el.textContent ?? '').trim(),
    }));
    expect(afterClick.pressed === 'true' || /Выбрано/.test(afterClick.text)).toBe(true);

    await firstSlot.click();
    const afterToggle = await firstSlot.evaluate((el) => ({
      pressed: el.getAttribute('aria-pressed'),
      text: (el.textContent ?? '').trim(),
    }));
    expect(afterToggle.pressed === 'false' || !/Выбрано/.test(afterToggle.text)).toBe(true);

    const box = await firstSlot.boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
  });
});

test('S2 — пустой результат показывает role="status" с пояснением', async ({ page }) => {
  await page.route(SLOTS_URL, async (route) => {
    await fulfillJson(route, 200, JSON.stringify(emptyFixture));
  });

  await page.goto('/experts/sample-expert');

  const status = page.getByRole('status').filter({ hasText: /Свободных слотов нет/ });
  await expect(status).toBeVisible();
  await expect(status).toContainText(/длительность|позже/);
});

test('S3 — ошибка 500: role="alert" с причиной и кнопкой «Повторить»', async ({ page }) => {
  let shouldFail = true;
  await page.route(SLOTS_URL, async (route) => {
    if (shouldFail) {
      await fulfillJson(route, 500, internalErrorBody);
    } else {
      await fulfillJson(route, 200, JSON.stringify(successFixture));
    }
  });

  await page.goto('/experts/sample-expert');

  const alert = page.getByRole('alert').filter({ hasText: /Сбой сервера/ });
  await expect(alert).toBeVisible();

  const retry = page.getByRole('button', { name: /Повторить/ });
  await expect(retry).toBeVisible();

  shouldFail = false;
  await retry.click();

  const slots = page.getByRole('button').filter({ hasText: /09:00.*?(?:Asia|Красноярск)/ });
  await expect(slots.first()).toBeVisible();
});

test('S4 — 404 от API: «Страница не найдена» и ссылка «На главную»', async ({ page }) => {
  // Страница должна вызвать API слотов и обработать ответ 404.
  // В текущей реализации этого маршрута нет — таймаут форсирует RED.
  const slotsRequest = page.waitForRequest(
    (req) => req.url().includes('/api/v1/experts/sample-expert/slots'),
    { timeout: 5000 },
  );

  await page.route(SLOTS_URL, async (route) => {
    await fulfillJson(route, 404, notFoundBody);
  });

  await page.goto('/experts/sample-expert');

  await slotsRequest;

  await expect(page.getByText('Страница не найдена')).toBeVisible();
  await page.getByRole('link', { name: 'На главную' }).click();
  await expect(page).toHaveURL('/');
  await expect(page.getByRole('heading', { name: 'MyBooking' })).toBeVisible();
});

test.describe('S5 — адаптивность и клавиатура', () => {
  test.use({ timezoneId: 'Asia/Krasnoyarsk' });

  test('phone: нет горизонтального скролла, высота слотов ≥ 44px, клавиатура', async ({ page }) => {
    await page.route(SLOTS_URL, async (route) => {
      await fulfillJson(route, 200, JSON.stringify(successFixture));
    });

    await page.goto('/experts/sample-expert');

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth + 1,
    );
    expect(overflow).toBe(false);

    const firstSlot = page
      .getByRole('button')
      .filter({ hasText: /09:00.*?(?:Asia|Красноярск)/ })
      .first();
    await expect(firstSlot).toBeVisible();
    const box = await firstSlot.boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);

    let foundDurations = false;
    let foundTimezone = false;
    let foundSlot = false;

    for (let i = 0; i < 60; i += 1) {
      await page.keyboard.press('Tab');
      const info = await page.evaluate(() => {
        const el = document.activeElement;
        if (!el || el === document.body) return null;
        return {
          text: (el.textContent ?? '').trim(),
          label: el.getAttribute('aria-label') ?? '',
        };
      });
      if (!info) continue;
      const combined = `${info.text} ${info.label}`;

      if (!foundDurations && /\d+\s*минут/.test(combined)) {
        foundDurations = true;
      }
      if (!foundTimezone && /Часовой пояс/i.test(combined)) {
        foundTimezone = true;
      }
      if (!foundSlot && /\b09:00\b/.test(combined)) {
        foundSlot = true;
        await page.keyboard.press('Enter');
        const afterActive = await page.evaluate(() => {
          const el = document.activeElement;
          if (!el) return { pressed: null, text: '' };
          return {
            pressed: el.getAttribute('aria-pressed'),
            text: (el.textContent ?? '').trim(),
          };
        });
        expect(afterActive.pressed === 'true' || /Выбрано/.test(afterActive.text)).toBe(true);
        break;
      }
    }

    expect(foundDurations).toBe(true);
    expect(foundTimezone).toBe(true);
    expect(foundSlot).toBe(true);
  });
});
