// Точка входа HTTP-сервера: конфигурация из env, БД, mail sender, Fastify,
// статическая раздача собранного web/dist и SPA-фолбэк для /api/v1.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import fastifyStatic from '@fastify/static';
import { createExpertAuthApp } from './auth/index.js';
import { createGmailCodeSender } from './auth/gmail.js';
import { loadConfig } from './config.js';
import { createDevMailLogger, type MailSender } from './mail/dev-logger.js';
import { openDatabase } from './repository.js';

const config = loadConfig(process.env);
const database = openDatabase(config.dbPath);

const mailSender: MailSender = config.mail.user
  ? {
      sendCode: createGmailCodeSender({
        user: config.mail.user,
        appPassword: config.mail.appPassword ?? '',
        from: config.mail.from ?? config.mail.user,
      }),
    }
  : createDevMailLogger();

const app = await createExpertAuthApp({
  database,
  sendCode: mailSender.sendCode,
  now: () => Date.now(),
  hmacSecret: config.hmacSecret,
  systemApiKey: config.systemKey,
  consentVersion: config.consentVersion,
  secureCookies: config.secureCookies,
  deletionContact: config.deletionContact,
  allowedOrigin: config.allowedOrigins[0] ?? '',
  allowedOrigins: config.allowedOrigins,
});

// Сервер запускается из server/ (cwd), web/dist собирается на уровень выше.
const webDist = resolve(process.cwd(), '..', 'web', 'dist');
const indexHtml = resolve(webDist, 'index.html');
if (existsSync(webDist) && statSync(webDist).isDirectory()) {
  await app.register(fastifyStatic, {
    root: webDist,
    prefix: '/',
    index: ['index.html'],
    decorateReply: false,
  });
} else {
  process.stderr.write('[static] web/dist not found, skipping static serving\n');
}

app.setNotFoundHandler((request, reply) => {
  if (request.method !== 'GET' || request.url.startsWith('/api/v1')) {
    return reply
      .code(404)
      .header('content-type', 'application/json; charset=utf-8')
      .send({ code: 'not_found', message: 'Не найдено.' });
  }
  if (!existsSync(indexHtml)) {
    return reply.code(404).send();
  }
  return reply.type('text/html; charset=utf-8').send(readFileSync(indexHtml));
});

try {
  await app.listen({ port: config.port, host: config.host });
  process.stderr.write(`listening on ${config.host}:${config.port}\n`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`server failed to start: ${message}\n`);
  process.exit(1);
}
