# Версии инструментов MyBooking на 5 октября 2026 года

Проверено 5 октября 2026 года по датам публикации и метаданным npm registry, официальному архиву Node.js и документации инструментов. Срез исключает публикации после 5 октября 2026 года. Принятые для каркаса версии закреплены в PDR, ADR-002, `package.json` и lockfile. Будущие пакеты из таблицы пока не добавлены в workspace; их совместимость проверена по опубликованным диапазонам, но установка и предметные тесты ещё не выполнялись.

## Среда выполнения и ограничение совместимости

- Последний стабильный релиз Node.js без ограничения на ветку LTS — [26.10.0 Current](https://nodejs.org/en/download). Владелец выбрал последнюю LTS ветки 24 для проекта.
- Последний доступный релиз ветки **Node.js 24 LTS** — [24.21.0](https://nodejs.org/en/download/archive/v24.21.0), с комплектным npm **11.19.0**. Проект закрепляет Node.js 24.21.0.
- Последний опубликованный npm — [12.2.0](https://registry.npmjs.org/npm/12.2.0). Его `engines.node` — `^22.22.2 || ^24.15.0 || >=26.0.0`: он допускает выбранный Node 24.21.0. Проект закрепляет npm 12.2.0 отдельно от комплектного npm 11.19.0; установка каркаса с ним проверена.
- Последний TypeScript — [7.0.2](https://registry.npmjs.org/typescript/7.0.2), однако [typescript-eslint 8.71.0](https://registry.npmjs.org/typescript-eslint/8.71.0) заявляет `peerDependencies.typescript: >=4.8.4 <6.1.0`. Его [документация совместимости](https://typescript-eslint.io/users/dependency-versions/) также ограничивает поддерживаемый диапазон. Поэтому для **согласованного** набора следует оставить последний поддерживаемый TypeScript **[6.0.3](https://registry.npmjs.org/typescript/6.0.3)**. TypeScript 7 нельзя объявить совместимым только потому, что npm позволяет установить его с предупреждением или отключённой проверкой peer-зависимостей.
- Последний `@types/node` вообще — [26.6.4](https://registry.npmjs.org/%40types%2Fnode/26.6.4), но для среды Node.js 24 следует использовать последнюю ветку типов 24 — **[24.19.1](https://registry.npmjs.org/%40types%2Fnode/24.19.1)**. Типы ветки 26 могут позволить использовать API, которых нет в Node 24.

## Точный набор для выбранной архитектуры

В таблице «последняя» означает опубликованную стабильную версию к дате проверки; «выбор» — версию, согласованную по заявленным `engines` и `peerDependencies` с Node 24.21.0 и соседними пакетами. Наличие в таблице не означает, что пакет уже установлен.

| Пакет | Последняя | Выбор | Состояние и основание |
| --- | --- | --- | --- |
| [TypeScript](https://registry.npmjs.org/typescript/7.0.2) | 7.0.2 | [6.0.3](https://registry.npmjs.org/typescript/6.0.3) | Уже в задаче 001; предел `typescript-eslint` указан выше. |
| [ESLint](https://registry.npmjs.org/eslint/10.12.0) | 10.12.0 | 10.12.0 | Уже в 001; `engines.node` допускает Node 24. |
| [@eslint/js](https://registry.npmjs.org/%40eslint%2Fjs/10.0.1) | 10.0.1 | 10.0.1 | Уже в 001; peer `eslint: ^10.0.0` принимает 10.12.0. |
| [typescript-eslint](https://registry.npmjs.org/typescript-eslint/8.71.0) | 8.71.0 | 8.71.0 | Уже в 001; peer ESLint `^8.57.0 || ^9.0.0 || ^10.0.0`, TypeScript `<6.1.0`. |
| [Prettier](https://registry.npmjs.org/prettier/3.9.9) | 3.9.9 | 3.9.9 | Уже в 001. |
| [@types/node](https://registry.npmjs.org/%40types%2Fnode/26.6.4) | 26.6.4 | [24.19.1](https://registry.npmjs.org/%40types%2Fnode/24.19.1) | Уже в 001; версия типов должна соответствовать major Node 24. |
| [React](https://registry.npmjs.org/react/19.3.0), [react-dom](https://registry.npmjs.org/react-dom/19.3.0) | 19.3.0 | 19.3.0 | Уже в 001; peer `react-dom` требует `react: ^19.3.0`. |
| [@types/react](https://registry.npmjs.org/%40types%2Freact/19.3.0), [@types/react-dom](https://registry.npmjs.org/%40types%2Freact-dom/19.3.0) | 19.3.0 | 19.3.0 | Уже в 001; типы DOM требуют `@types/react: ^19.3.0`. |
| [Vite](https://registry.npmjs.org/vite/8.3.2) | 8.3.2 | 8.3.2 | Уже в 001; `engines.node: ^20.19.0 || >=22.12.0`. |
| [@typespec/compiler](https://registry.npmjs.org/%40typespec%2Fcompiler/1.16.0), [@typespec/openapi3](https://registry.npmjs.org/%40typespec%2Fopenapi3/1.16.0) | 1.16.0 | 1.16.0 | Будущая реализация контракта. Emitter требует compiler `^1.16.0`, а также TypeSpec HTTP и OpenAPI `^1.16.0`; точный набор прямых пакетов проверить при создании `contract/main.tsp`. `engines.node: >=22`. |
| [Fastify](https://registry.npmjs.org/fastify/5.12.5) | 5.12.5 | 5.12.5 | Будущая серверная задача; метаданные версии не объявляют конфликтующих peer-зависимостей. |
| [Zod](https://registry.npmjs.org/zod/4.6.5) | 4.6.5 | 4.6.5 | Будущая серверная задача; отдельную интеграцию с Fastify проверить тестами. |
| [better-sqlite3](https://registry.npmjs.org/better-sqlite3/13.0.3) | 13.0.3 | 13.0.3 | Будущая задача БД; `engines.node: >=22`. Нативную установку на Windows и в контейнере проверить фактически. |
| [@js-temporal/polyfill](https://registry.npmjs.org/%40js-temporal%2Fpolyfill/0.5.1) | 0.5.1 | 0.5.1 | Будущая задача времени. |
| [Nodemailer](https://registry.npmjs.org/nodemailer/10.0.15) | 10.0.15 | 10.0.15 | Будущая задача почты; Node `>=20`, пакет содержит собственные декларации типов. Отдельный `@types/nodemailer` не нужен. |
| [Vitest](https://registry.npmjs.org/vitest/5.0.3) | 5.0.3 | 5.0.3 | Будущие тесты; peer Vite `^6.4.0 || ^7.0.0 || ^8.0.0` принимает 8.3.2, Node `^22.12.0 || ^24.0.0 || >=26.0.0`. |
| [@playwright/test](https://registry.npmjs.org/%40playwright%2Ftest/1.63.0) | 1.63.0 | 1.63.0 | Будущие E2E-тесты; `engines.node: >=20`. Установка браузеров и тесты ещё не проверены. |

`@types/nodemailer` [8.0.2](https://registry.npmjs.org/%40types%2Fnodemailer/8.0.2) опубликован, но относится к отдельным типам старой ветки; у Nodemailer 10.0.15 уже есть поле `types`. Добавлять его к новой установке без потребности не следует.

## Инструменты вне npm

- Последний [Docker Engine 29.8.2](https://docs.docker.com/engine/release-notes/29/) опубликован 30.09.2026; последний [Docker Compose v5.6.0](https://github.com/docker/compose/releases/tag/v5.6.0) — 02.10.2026. На текущем Windows-хосте обнаружены Docker Engine 29.5.3 и Compose 5.1.4. Проект пока не содержит Dockerfile и compose-конфигурации; обновление системного Docker и контейнерная проверка не выполнялись. Для задачи 023 версии контейнерных инструментов нужно повторно сверить перед сборкой.
- Workflow GitHub Actions ещё не создан. Его конкретные actions и версии определяются в задаче 024, поэтому фиксировать их как уже используемые неверно. На 05.10.2026 опубликованы [actions/setup-node v7.0.0](https://github.com/actions/setup-node/releases/tag/v7.0.0) и [docker/build-push-action v7.4.0](https://github.com/docker/build-push-action/releases/tag/v7.4.0); их совместимость с будущим workflow не проверялась.

## Фактическая проверка и границы вывода

Официальный архив Node.js 24.21.0 для Windows x64 скачан во временную папку; его SHA256 совпал с [официальным списком](https://nodejs.org/dist/v24.21.0/SHASUMS256.txt). Под этой версией Node.js и npm 12.2.0 в ветке `feature/001-workspace-scaffold` прошли `npm install`, `npm ls --workspaces --depth=0`, `npm run typecheck`, `npm run lint`, `npm run format:check` и `npm run build`. При повторной проверке вложенные workspace-скрипты также запускались через npm 12.2.0. npm видит четыре workspace, аудит установки сообщил 0 уязвимостей. Первый запуск сборки в песочнице не мог записать `dist`; после разрешённой записи та же команда завершилась успешно.

Для будущих модулей выполнено разрешение зависимостей через `npm install --package-lock-only --ignore-scripts` во временной папке с точными версиями TypeSpec compiler, HTTP, OpenAPI и emitter, Fastify, Zod, better-sqlite3, Temporal polyfill, Nodemailer, Vitest, Playwright, Vite, TypeScript, typescript-eslint и ESLint из таблицы. Команда завершилась с кодом 0 без конфликта `peerDependencies`; пакеты и нативный модуль при этом не устанавливались, скрипты установки не запускались.

Метаданные `engines` и `peerDependencies` не доказывают отсутствие ошибок поведения. Не проверены чистый клон, установка `better-sqlite3` на Windows и в контейнере, генерация OpenAPI 3.1, браузеры Playwright, SMTP и сборка будущих модулей. Их версии следует повторно проверить непосредственно перед включением в workspace, поскольку список быстро устаревает.
