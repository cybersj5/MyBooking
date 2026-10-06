import { expect, test } from '@playwright/test';

test('theme control keeps one accessible name and announces state after Enter and Space', async ({
  page,
}) => {
  await page.goto('/');

  const theme = page.getByRole('button', { name: 'Переключить тему' });
  await expect(theme).toHaveAttribute('aria-pressed', 'false');
  await expect(theme).toContainText('Светлая тема');
  await expect(theme).toHaveAccessibleDescription('Светлая тема');

  await theme.focus();
  await page.keyboard.press('Enter');
  await expect(theme).toHaveAttribute('aria-pressed', 'true');
  await expect(theme).toContainText('Тёмная тема');
  await expect(theme).toHaveAccessibleName('Переключить тему');
  await expect(theme).toHaveAccessibleDescription('Тёмная тема');

  await page.keyboard.press('Space');
  await expect(theme).toHaveAttribute('aria-pressed', 'false');
  await expect(theme).toContainText('Светлая тема');
  await expect(theme).toHaveAccessibleName('Переключить тему');
  await expect(theme).toHaveAccessibleDescription('Светлая тема');
});

test('app shell offers a keyboard theme control without page overflow', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByRole('main')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'MyBooking' })).toBeVisible();

  const theme = page.getByRole('button', { name: /тему|тема$/ });
  await expect(theme).toBeVisible();
  const originalVisibleLabel = await theme.textContent();
  const originalBackground = await page.evaluate(
    () => getComputedStyle(document.body).backgroundColor,
  );

  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (await theme.evaluate((element) => element === document.activeElement)) break;
    await page.keyboard.press('Tab');
  }
  await expect(theme).toBeFocused();
  const focusIsVisible = await theme.evaluate((element) => {
    const style = getComputedStyle(element);
    return (
      (style.outlineStyle !== 'none' && style.outlineWidth !== '0px') || style.boxShadow !== 'none'
    );
  });
  expect(focusIsVisible).toBe(true);

  await page.keyboard.press('Enter');
  await expect.poll(async () => theme.textContent()).not.toBe(originalVisibleLabel);
  await expect
    .poll(async () => page.evaluate(() => getComputedStyle(document.body).backgroundColor))
    .not.toBe(originalBackground);

  const pageOverflows = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  expect(pageOverflows).toBe(false);
});

test('unknown route gives a persistent, accessible Russian error', async ({ page }) => {
  await page.goto('/nesushchestvuyushchiy-razdel');

  const error = page.getByRole('alert');
  await expect(error).toBeVisible();
  await expect(error).toContainText(/[А-Яа-яЁё]/);
  await page.keyboard.press('Tab');
  await expect(error).toBeVisible();
  await page.getByRole('link', { name: 'На главную' }).click();
  await expect(page).toHaveURL('/');
  await expect(page.getByRole('heading', { name: 'MyBooking' })).toBeVisible();
});

test('chosen theme survives navigation and reload', async ({ page }) => {
  await page.goto('/');

  const theme = page.getByRole('button', { name: /тему|тема$/ });
  await theme.click();
  await expect(theme).toHaveAttribute('aria-pressed', 'true');
  await expect(theme).toContainText('Тёмная тема');

  await page.getByRole('link', { name: 'Кабинет' }).click();
  await expect(page.getByRole('heading', { name: 'Кабинет эксперта' })).toBeVisible();
  await expect(page.getByRole('button', { name: /тему|тема$/ })).toHaveAttribute(
    'aria-pressed',
    'true',
  );

  await page.reload();
  await expect(page.getByRole('button', { name: /тему|тема$/ })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
});
