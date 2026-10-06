import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

export type PrivacyOptions = {
  consentVersion: string;
  deletionContact: string;
};

const privacyOptionsSchema = z.object({
  consentVersion: z.string().trim().min(1),
  deletionContact: z.email(),
});

export function registerPrivacyRoutes(app: FastifyInstance, options: PrivacyOptions): void {
  const { consentVersion, deletionContact } = privacyOptionsSchema.parse(options);

  app.get('/api/v1/privacy', async () => ({
    consentVersion,
    summary:
      'Для входа и бронирования мы используем ваши данные и отправляем письма. Перед запросом кода подтвердите согласие с этим документом.',
    document:
      'MyBooking хранит имя, адрес электронной почты, часовой пояс, расписание эксперта, сведения о заявках и встречах, включая тему и описание. Эти данные нужны для входа по коду, подбора времени, обработки заявок и отправки уведомлений участникам встречи. Письма с кодами и уведомлениями отправляются на указанные адреса через Gmail SMTP. Данные остаются в локальной базе приложения без автоматического срока удаления. Чтобы запросить удаление данных, напишите владельцу на ' +
      deletionContact +
      '. В учебном MVP владелец рассматривает такой запрос и удаляет данные вручную.',
    deletionContact,
    cookieNotice:
      'Для сессии эксперта необходим cookie mybooking_session. Он хранится до 30 дней с момента входа, доступен только серверу (HttpOnly), действует для сайта (Path=/, SameSite=Lax) и нужен для защиты действий в аккаунте. Cookie можно удалить в настройках браузера или при выходе из аккаунта. Токен защиты действий передаётся отдельно и не хранится в cookie. Необязательных, аналитических и рекламных cookie нет. Это уведомление можно закрыть; оно не ограничивает просмотр слотов и бронирование.',
  }));
}
