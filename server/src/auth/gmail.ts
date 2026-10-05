import nodemailer from 'nodemailer';

export type GmailSettings = {
  user: string;
  appPassword: string;
  from: string;
};

export function gmailSettingsFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): GmailSettings {
  const user = environment.GMAIL_USER;
  const appPassword = environment.GMAIL_APP_PASSWORD;
  const from = environment.MAIL_FROM;
  if (!user || !appPassword || !from) {
    throw new Error('Gmail SMTP settings are missing');
  }
  return { user, appPassword, from };
}

export function createGmailCodeSender(settings: GmailSettings) {
  const transport = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 587,
    secure: false,
    requireTLS: true,
    auth: { user: settings.user, pass: settings.appPassword },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 10_000,
  });
  return async ({ to, code }: { to: string; code: string }) => {
    await transport.sendMail({
      from: settings.from,
      to,
      subject: 'Код входа в MyBooking',
      text: `Ваш код входа: ${code}. Он действует 10 минут.`,
    });
  };
}
