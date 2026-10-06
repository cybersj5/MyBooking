// Локальный логгер одноразовых кодов в stderr.
// Используется, когда GMAIL_USER не задан, а MYBOOKING_DEV_MAIL_LOG=1;
// не отправляет реальные письма и подходит только для разработки и
// автоматических тестов с подменённым транспортом.

export type MailSender = {
  sendCode: (message: { to: string; code: string }) => Promise<void>;
};

function formatLine(to: string, code: string): string {
  const ts = new Date().toISOString();
  return `[dev-mail] to=${to} code=${code} ts=${ts}`;
}

export function createDevMailLogger(): MailSender {
  return {
    sendCode: async ({ to, code }) => {
      process.stderr.write(`${formatLine(to, code)}\n`);
    },
  };
}
