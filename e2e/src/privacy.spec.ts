import { expect, test, type Route } from '@playwright/test';

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

async function mockPrivacyApi(page: import('@playwright/test').Page) {
  await page.route('**/api/v1/privacy', async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json; charset=utf-8',
      body: JSON.stringify(privacyDocument),
    });
  });
}

test.beforeEach(async ({ page }) => {
  await mockPrivacyApi(page);
});

test('cookie notice appears on first visit, describes mybooking_session, and has no optional choice', async ({
  page,
}) => {
  await page.goto('/');

  const notice = page.getByRole('region', { name: 'Уведомление о cookie' });
  await expect(notice).toBeVisible();
  await expect(notice).toContainText('mybooking_session');
  await expect(notice).toContainText('необходим');
  await expect(notice).toContainText('Необязательн');
  await expect(notice).not.toContainText('Включить');
  await expect(notice).not.toContainText('Отключить');
  await expect(notice).not.toContainText('Принять');
});

test('cookie notice does not block navigation, theme control, or consent interaction', async ({
  page,
}) => {
  await page.goto('/');

  await expect(page.getByRole('button', { name: 'Переключить тему' })).toBeEnabled();
  await expect(page.getByRole('link', { name: 'Кабинет' })).toBeEnabled();

  const checkbox = page.getByRole('checkbox', { name: /соглас/ });
  await checkbox.check();
  await expect(checkbox).toBeChecked();

  await page.getByRole('link', { name: 'Кабинет' }).click();
  await expect(page).toHaveURL('/cabinet');
  await expect(page.getByRole('region', { name: 'Уведомление о cookie' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Переключить тему' })).toBeEnabled();
  await page.getByRole('link', { name: 'MyBooking' }).click();
  await expect(page).toHaveURL('/');
});

test('cookie notice can be dismissed and stays dismissed after reload', async ({ page }) => {
  await page.goto('/');

  const notice = page.getByRole('region', { name: 'Уведомление о cookie' });
  await expect(notice).toBeVisible();

  await page.getByRole('button', { name: 'Закрыть уведомление о cookie' }).click();
  await expect(notice).toBeHidden();

  await page.reload();
  await expect(page.getByRole('region', { name: 'Уведомление о cookie' })).toBeHidden();
});

test('consent block shows the data explanation and forces check before the code-request action', async ({
  page,
}) => {
  await page.goto('/');

  const checkbox = page.getByRole('checkbox', { name: /соглас/ });
  await expect(checkbox).toBeVisible();
  await expect(checkbox).not.toBeChecked();

  const requestButton = page.getByRole('button', { name: 'Запросить код' });
  await expect(requestButton).toBeVisible();
  await expect(requestButton).toBeDisabled();

  await checkbox.check();
  await expect(checkbox).toBeChecked();
  await expect(requestButton).toBeEnabled();

  await checkbox.uncheck();
  await expect(requestButton).toBeDisabled();
});

test('full consent document with deletion contact is reachable from the form', async ({ page }) => {
  await page.goto('/');

  await page.getByRole('button', { name: /открыть документ согласия/i }).click();

  const dialog = page.getByRole('dialog', { name: 'Документ о персональных данных' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('MyBooking');
  await expect(dialog).toContainText('owner@example.test');

  await page.getByRole('button', { name: 'Закрыть документ' }).click();
  await expect(dialog).toBeHidden();
});

test('consent summary mirrors the data description from the privacy API', async ({ page }) => {
  await page.goto('/');

  const summary = page.getByText(/для входа и бронирования/i);
  await expect(summary).toBeVisible();
  await expect(summary).toContainText('Перед запросом кода подтвердите согласие');
});
