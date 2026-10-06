import "@typespec/http";
import "@typespec/openapi";
import "@typespec/openapi3";

using TypeSpec.Http;

@service(#{ title: "MyBooking API" })
namespace MyBooking;

alias BookingStatus = "pending" | "confirmed" | "rejected" | "withdrawn" | "expired" | "cancelled";
alias BookingClosedReason = "manual" | "conflict" | "schedule_changed" | "deadline";
alias DurationMinutes = 15 | 30 | 60;
alias Weekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;

@doc("Момент ISO 8601 с явным смещением; сервер определяет однозначный UTC-момент.")
@format("date-time")
scalar OffsetDateTime extends string;

@pattern("^\\d{4}-\\d{2}-\\d{2}$")
scalar LocalDate extends string;

@pattern("^(?:[01]\\d|2[0-3]):[0-5]\\d$")
scalar LocalStartTime extends string;

@pattern("^(?:(?:[01]\\d|2[0-3]):[0-5]\\d|24:00)$")
scalar LocalEndTime extends string;

model ConsentInput {
  consentVersion: string;
  consentAccepted: true;
}

model EmailConsentInput extends ConsentInput {
  @format("email")
  email: string;
}

model ChallengeAccepted {
  challengeId: string;
  expiresAt: OffsetDateTime;
}

model CodeInput {
  code: string;
}

model ExpertVerified {
  profileComplete: boolean;
  csrfToken: string;
}

model ExpertProfile {
  id: string;

  @format("email")
  email: string;

  name: string | null;
  timezone: string | null;
  publicId: string;
  profileComplete: boolean;
  csrfToken: string;
}

model ExpertProfileInput {
  name: string;
  timezone: string;
}

model CompletedExpertProfile {
  id: string;

  @format("email")
  email: string;

  name: string;
  timezone: string;
  publicId: string;
  profileComplete: true;
}

model GuestVerified {
  guestProof: string;
  expiresAt: OffsetDateTime;
}

model AccessRequestAccepted {
  requestId: string;
}

model AccessVerified {
  accessToken: string;
  expiresAt: OffsetDateTime;
}

model PrivacyDocument {
  consentVersion: string;
  summary: string;

  @doc("Краткий документ обычным текстом без HTML и Markdown.")
  document: string;

  @doc("Публичный рабочий email для удаления данных.")
  @format("email")
  deletionContact: string;

  cookieNotice: string;
}

model WeeklyInterval {
  weekday: Weekday;
  startLocal: LocalStartTime;
  endLocal: LocalEndTime;
}

model AvailabilityInput {
  weeklyIntervals: WeeklyInterval[];
  excludedDates: LocalDate[];
}

model Availability extends AvailabilityInput {
  timezone: string;
  version: string;
}

model AffectedBooking {
  id: string;
  status: "pending" | "confirmed";
}

model AvailabilityPreview {
  @doc("Версия связана с предложенным расписанием и списком последствий.")
  version: string;

  affectedBookings: AffectedBooking[];
}

model AvailabilityUpdate extends AvailabilityInput {
  version: string;
  confirmAffected: boolean;
}

model Slot {
  startAt: OffsetDateTime;
}

model SlotsResponse {
  timezone: string;
  slots: Slot[];
}

model BookingCreateInput extends ConsentInput {
  guestProof: string;
  guestName: string;
  guestTimezone: string;
  startAt: OffsetDateTime;
  durationMinutes: DurationMinutes;

  @minLength(1)
  @maxLength(120)
  topic: string;

  @maxLength(2000)
  description?: string;
}

model BookingDetail {
  id: string;
  status: BookingStatus;
  startAt: OffsetDateTime;
  endAt: OffsetDateTime;
  topic: string;
  description?: string;
  guestName: string;
  guestTimezone: string;
  expertName: string;
  expertPublicId: string;
  closedReason?: BookingClosedReason;
  completed: boolean;
}

model ExpertBookingDetail extends BookingDetail {
  @format("email")
  guestEmail: string;
}

model BookingCreated extends BookingDetail {
  status: "pending";
}

model BookingList {
  items: ExpertBookingDetail[];
  nextCursor: string | null;
}

model ReasonInput {
  reason?: string;
}

model ApiError {
  @doc("Публичный код без раскрытия чужих сведений.")
  code: string;

  @doc("Безопасное описание на русском языке.")
  message: string;
}

model Ok<T> {
  @statusCode statusCode: 200;
  @body body: T;
}

model Accepted<T> {
  @statusCode statusCode: 202;
  @body body: T;
}

model Created<T> {
  @statusCode statusCode: 201;
  @body body: T;
}

model ExpertVerifyResponse {
  @statusCode statusCode: 200;

  @doc("Устанавливает сессионный cookie mybooking_session с HttpOnly и SameSite=Lax.")
  @header("Set-Cookie")
  setCookie: string;

  @body body: ExpertVerified;
}

model LogoutResponse {
  @statusCode statusCode: 204;

  @doc("Удаляет сессионный cookie в браузере.")
  @header("Set-Cookie")
  setCookie: string;
}

@error
model BadRequest {
  @statusCode statusCode: 400;
  @body body: ApiError;
}

@error
model Unauthenticated {
  @statusCode statusCode: 401;
  @body body: ApiError;
}

@error
model Forbidden {
  @statusCode statusCode: 403;
  @body body: ApiError;
}

@error
model ProfileIncomplete {
  @statusCode statusCode: 403;
  @body body: ApiError;
}

@error
model NotFound {
  @statusCode statusCode: 404;
  @body body: ApiError;
}

@error
model Conflict {
  @statusCode statusCode: 409;
  @body body: ApiError;
}

@error
model RateLimited {
  @statusCode statusCode: 429;
  @header("Retry-After") retryAfter: int32;
  @body body: ApiError;
}

@error
model MailUnavailable {
  @statusCode statusCode: 503;
  @body body: ApiError;
}

@route("/api/v1/auth/expert/challenges")
@post
@doc("Проверяются Origin, актуальное согласие и лимиты. Ответ не раскрывает наличие аккаунта.")
op requestExpertCode(@body input: EmailConsentInput):
  | Accepted<ChallengeAccepted>
  | BadRequest
  | Forbidden
  | RateLimited
  | MailUnavailable;

@route("/api/v1/auth/expert/challenges/{challengeId}/verify")
@post
@doc("После успешного кода устанавливается HttpOnly SameSite=Lax cookie сессии. Неверный или истёкший код даёт 400 invalid_challenge.")
op verifyExpertCode(@path challengeId: string, @body input: CodeInput):
  | ExpertVerifyResponse
  | BadRequest
  | Forbidden;

@route("/api/v1/me")
@get
@useAuth(ApiKeyAuth<ApiKeyLocation.cookie, "mybooking_session">)
@doc("Требуется сессия эксперта; незавершённый профиль может читать себя.")
op getMe(): Ok<ExpertProfile> | Unauthenticated;

@route("/api/v1/me/profile")
@put
@useAuth(ApiKeyAuth<ApiKeyLocation.cookie, "mybooking_session">)
@doc("Требуются сессия, Origin и CSRF; доступно незавершённому профилю.")
op updateProfile(@header("X-CSRF-Token") csrfToken: string, @body input: ExpertProfileInput):
  | Ok<CompletedExpertProfile>
  | BadRequest
  | Forbidden
  | Unauthenticated;

@route("/api/v1/auth/logout")
@post
@useAuth(ApiKeyAuth<ApiKeyLocation.cookie, "mybooking_session">)
@doc("Требуются сессия, Origin и CSRF; cookie и сессия отзываются.")
op logout(@header("X-CSRF-Token") csrfToken: string):
  | LogoutResponse
  | Forbidden
  | Unauthenticated;

@route("/api/v1/experts/{publicId}/guest-challenges")
@post
op requestGuestCode(@path publicId: string, @body input: EmailConsentInput):
  | Accepted<ChallengeAccepted>
  | BadRequest
  | NotFound
  | RateLimited
  | MailUnavailable;

@route("/api/v1/experts/{publicId}/guest-challenges/{challengeId}/verify")
@post
@doc("Неверный или истёкший код даёт 400 invalid_challenge.")
op verifyGuestCode(@path publicId: string, @path challengeId: string, @body input: CodeInput):
  | Ok<GuestVerified>
  | BadRequest
  | NotFound;

@route("/api/v1/bookings/{bookingId}/access-challenges")
@post
@doc("Одинаковый ответ для существующей, чужой и отсутствующей заявки; принятие запроса не подтверждает доставку.")
op requestBookingAccess(@path bookingId: string, @body input: EmailConsentInput):
  | Accepted<AccessRequestAccepted>
  | BadRequest
  | RateLimited
  | MailUnavailable;

@route("/api/v1/bookings/{bookingId}/access-challenges/{requestId}/verify")
@post
@doc("Неверный или истёкший код даёт 400 invalid_challenge; прежний токен отзывается после успешной проверки.")
op verifyBookingAccess(@path bookingId: string, @path requestId: string, @body input: CodeInput):
  | Ok<AccessVerified>
  | BadRequest;

@route("/api/v1/privacy")
@get
op getPrivacy(): Ok<PrivacyDocument>;

@route("/api/v1/experts/{publicId}/slots")
@get
@doc("Даты заданы в поясе эксперта: from включительно, to исключительно, не более 31 дня. Pending не скрывают слоты.")
op listSlots(
  @path publicId: string,
  @query from: LocalDate,
  @query to: LocalDate,
  @query durationMinutes: DurationMinutes,
): Ok<SlotsResponse> | BadRequest | NotFound;

@route("/api/v1/me/availability")
@get
@useAuth(ApiKeyAuth<ApiKeyLocation.cookie, "mybooking_session">)
@doc("Только собственное расписание эксперта с завершённым профилем.")
op getAvailability(): Ok<Availability> | Unauthenticated | ProfileIncomplete;

@route("/api/v1/me/availability/preview")
@post
@useAuth(ApiKeyAuth<ApiKeyLocation.cookie, "mybooking_session">)
@doc("Требуются сессия, Origin и CSRF; список содержит только будущие собственные записи организатора.")
op previewAvailability(@header("X-CSRF-Token") csrfToken: string, @body input: AvailabilityInput):
  | Ok<AvailabilityPreview>
  | BadRequest
  | Unauthenticated
  | ProfileIncomplete;

@route("/api/v1/me/availability")
@put
@useAuth(ApiKeyAuth<ApiKeyLocation.cookie, "mybooking_session">)
@doc("Сверяются версия preview, предложенное расписание и последствия; требуются сессия, Origin и CSRF.")
op updateAvailability(
  @header("X-CSRF-Token") csrfToken: string,
  @header("Idempotency-Key") idempotencyKey: string,
  @body input: AvailabilityUpdate,
): Ok<Availability> | BadRequest | Unauthenticated | ProfileIncomplete | Conflict;

@route("/api/v1/experts/{publicId}/bookings")
@post
@doc("Гостевое доказательство погашается после успешного создания. Токен доступа отправляется только письмом.")
op createBooking(
  @path publicId: string,
  @header("Idempotency-Key") idempotencyKey: string,
  @body input: BookingCreateInput,
): Created<BookingCreated> | BadRequest | NotFound | Conflict;

@route("/api/v1/bookings/{bookingId}")
@get
@useAuth(BearerAuth | ApiKeyAuth<ApiKeyLocation.cookie, "mybooking_session">)
@doc("Сессия организатора либо bearer-токен именно этой заявки. Чужая и отсутствующая заявка дают одинаковый 404.")
op getBooking(@path bookingId: string):
  | Ok<BookingDetail | ExpertBookingDetail>
  | Unauthenticated
  | NotFound;

@route("/api/v1/me/bookings")
@get
@useAuth(ApiKeyAuth<ApiKeyLocation.cookie, "mybooking_session">)
@doc("Только заявки, где эксперт организатор. Сортировка по startAt по возрастанию; from включительно, to исключительно.")
op listMyBookings(
  @query from?: OffsetDateTime,
  @query to?: OffsetDateTime,
  @query status?: BookingStatus,
  @query cursor?: string,

  @minValue(1)
  @maxValue(50)
  @doc("По умолчанию 20.")
  @query
  limit?: int32 = 20,
): Ok<BookingList> | BadRequest | Unauthenticated | ProfileIncomplete;

@route("/api/v1/bookings/{bookingId}/confirm")
@post
@useAuth(ApiKeyAuth<ApiKeyLocation.cookie, "mybooking_session">)
@doc("Только организатор; Origin и CSRF. Проверяются срок, состояние и занятость обоих участников.")
op confirmBooking(
  @path bookingId: string,
  @header("X-CSRF-Token") csrfToken: string,
  @header("Idempotency-Key") idempotencyKey: string,
): Ok<ExpertBookingDetail> | Unauthenticated | ProfileIncomplete | NotFound | Conflict;

@route("/api/v1/bookings/{bookingId}/reject")
@post
@useAuth(ApiKeyAuth<ApiKeyLocation.cookie, "mybooking_session">)
@doc("Только организатор; Origin и CSRF.")
op rejectBooking(
  @path bookingId: string,
  @header("X-CSRF-Token") csrfToken: string,
  @header("Idempotency-Key") idempotencyKey: string,
  @body input: ReasonInput,
): Ok<ExpertBookingDetail> | Unauthenticated | ProfileIncomplete | NotFound | Conflict;

@route("/api/v1/bookings/{bookingId}/withdraw")
@post
@useAuth(BearerAuth)
@doc("Только bearer-токен гостя этой заявки.")
op withdrawBooking(
  @path bookingId: string,
  @header("Idempotency-Key") idempotencyKey: string,
  @body input: ReasonInput,
): Ok<BookingDetail> | Unauthenticated | NotFound | Conflict;

model SseAvailabilityChangedEvent {
  type: "availability_changed";
}

model SseBookingsChangedEvent {
  type: "bookings_changed";
  @doc("Для эксперта поле опускается; для гостя содержит идентификатор его заявки.")
  bookingId?: string;
}

@route("/api/v1/events")
@get
@useAuth(ApiKeyAuth<ApiKeyLocation.cookie, "mybooking_session">)
@doc("Серверный поток событий о доступности и заявках для авторизованной сессии эксперта. Содержит только тип события; данные перечитываются отдельными командами. Соединение закрывается при отзыве или истечении сессии. Подробности — docs/specs/updates.md.")
op expertEvents(): void | Unauthenticated;

@route("/api/v1/bookings/{bookingId}/events")
@get
@useAuth(BearerAuth)
@doc("Серверный поток событий для гостя одной заявки. Требуется bearer-токен именно этой заявки; событие содержит её bookingId. Соединение закрывается при отзыве или истечении токена. Подробности — docs/specs/updates.md.")
op guestEvents(
  @path bookingId: string,
): void | Unauthenticated | Forbidden;

@route("/api/v1/bookings/{bookingId}/cancel")
@post
@useAuth(BearerAuth | ApiKeyAuth<ApiKeyLocation.cookie, "mybooking_session">)
@doc("Один из участников в пределах срока своей роли. При cookie-сессии обязательны Origin и X-CSRF-Token; при гостевом bearer-токене CSRF-заголовок не требуется.")
op cancelBooking(
  @path bookingId: string,
  @header("X-CSRF-Token") csrfToken?: string,
  @header("Idempotency-Key") idempotencyKey: string,
  @body input: ReasonInput,
): Ok<BookingDetail | ExpertBookingDetail> | Unauthenticated | NotFound | Conflict;
