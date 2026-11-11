# Вхід і організації

Рішення: [ADR-0030](../../adr/0030-google-sign-in-organizations-invite-links.md). Відхилення від Mastra — `MIGRATION.md`, «Вхід через Google».

## Які бувають входи

`apps/server/src/mastra/index.ts` вибирає один; без жодного сервер не стартує.

| Налаштування | Що | Для чого |
| --- | --- | --- |
| `FACTORY_LOCAL_DEV_AUTH=1` | одна людина `factory-local-developer` в `factory-local-org`, лише з loopback (`apps/server/src/mastra/local/local-dev-auth.ts`) | розробка на своїй машині |
| `FACTORY_AUTH=google` | better-auth, кнопка «Увійти через Google», організації й запрошення | сервер для кількох людей |
| `MASTRACODE_AUTH_DISABLED=1` | без входу, лише API | димові тести |

Ворота запитів, `/auth/me`, `/auth/login`, `/auth/logout` і `ALL /auth/api/*` — провайдер-нейтральні: `packages/auth/src/auth.ts`.

## Google (better-auth)

- Адаптер — `packages/auth-better-auth/src/index.ts` (`@factory/auth-better-auth`), копія `@mastra/auth-better-auth` 1.1.8. Інстанс better-auth будується в `init()` на базі сервера (`storage.authDatabase()`: libSQL або Postgres), таблиці створюють міграції better-auth при першому зверненні. Налаштування — `factoryBetterAuthOptions`: лише Google (`prompt: select_account`), email/пароль вимкнено, `basePath: /auth/api`.
- Env (`apps/server/.env.schema`, збирає `createGoogleAuth` у `apps/server/src/mastra/google/google-auth.ts`): `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `FACTORY_AUTH_SECRET` (≥ 32 символи), `MASTRACODE_PUBLIC_URL`. Бракує чогось — сервер не стартує й називає змінну. Redirect URI клієнта Google: `<MASTRACODE_PUBLIC_URL>/auth/api/callback/google`. Локально: `corepack pnpm --filter @factory/app-server dev:google`.
- Вхід: `/signin` показує одну кнопку (`apps/ui/src/ui/pages/SignInPage.tsx`); вона робить `POST /auth/api/sign-in/social { provider: 'google', callbackURL: <returnTo>, errorCallbackURL: '/signin?returnTo=…' }` і переходить на URL Google. Google повертає на callback better-auth, той ставить HttpOnly-cookie сесії й відправляє на `returnTo`; помилка повертає на `/signin?error=<код>`, сторінка показує код.
- Google-вхід з адресою, для якої вже є рядок користувача з підтвердженою адресою, входить як цей рядок (`accountLinking`, довірений провайдер `google`), профіль (ім'я, фото) оновлюється з Google.

## Організації

- Новий користувач без членства отримує свою організацію й роль `owner` (`ensureOrganization`, викликають ворота й `/auth/me`). Створювати інші організації через API не можна (`allowUserToCreateOrganization: false`).
- Активна організація — `activeOrganizationId` сесії better-auth; без неї — найстаріше членство. Ворота довіряють активній організації, лише поки людина в ній є (кеш членства 1 хв): видалений учасник за хвилину перестає бачити її Factory.
- Адмін-перевірки Factory (`isOrganizationAdmin`) — роль `owner` або `admin`. Тонших ролей поки немає.
- «Налаштування › Організація» (`apps/ui/src/ui/domains/settings/components/OrganizationSection.tsx`, запити — `apps/ui/src/ui/domains/auth/services/organization.ts`) ходить у власні ендпоінти better-auth `/auth/api/organization/*`, які самі перевіряють права:
  - назва, ваша роль, учасники (ім'я, email, роль; власник позначений, його не видалити);
  - owner/admin: «Запросити посиланням» — email → `invite-member` з роллю `member` → посилання `<origin>/invite/<id>` з кнопкою копіювання; «Запрошення, що чекають» — копіювати посилання, скасувати (`cancel-invitation`); «Видалити» учасника з підтвердженням (`remove-member`);
  - «Ваші організації», коли їх більше однієї: `organization/list`, перехід — `set-active` і повне перезавантаження застосунку в `/`.
- Інші входи (local dev) показують у розділі пояснення: організації — лише з Google.

## Запрошення посиланням

- Листів немає: посилання надсилає той, хто запрошує. Діє 7 днів (`INVITATION_EXPIRES_IN_SECONDS`), лише для адреси, на яку створене, і лише з підтвердженою адресою (`requireEmailVerificationOnInvitation`).
- `/invite/:invitationId` (`apps/ui/src/ui/pages/InvitePage.tsx`, маршрут у `apps/ui/src/ui/router.tsx` під `SignedInOnly`): без входу ворота сервера й SPA ведуть на `/signin?returnTo=/invite/<id>`; онбординг не вимагається (у запрошеного може ще не бути Factory).
- Сторінка показує організацію й того, хто запросив (`get-invitation`). «Прийняти й відкрити» — `accept-invitation`, `set-active`, перезавантаження в `/`; «Відхилити» — `reject-invitation`. Інша адреса — пояснення й «Вийти»; прострочене, скасоване чи використане — «попросіть нове посилання».

## Перенесення наявних людей

Під час старту, після `factory.prepare()` (`moveExistingUsers` у `apps/server/src/mastra/google/google-auth.ts`), ідемпотентно:

- є `factory-local-org` (створюється з цим id, назва «Factory», якщо її нема);
- `FACTORY_OWNER_EMAIL` — рядок користувача з id `factory-local-developer` (id local dev auth і колишнього Firebase-власника) і цією адресою, роль `owner`;
- `FACTORY_AUTH_IMPORT_FIREBASE_USERS` — шлях до `firebase auth:export <file> --format=json`: кожен з адресою (крім власника) — рядок з id = Firebase `uid` (`localId`), ім'я, фото, `emailVerified: true`, роль `admin` (як усі були до того).

Рядок користувача і його членство створюються разом в одній транзакції й лише коли рядка ще нема: наявне не перезаписується, видалений власником учасник не повертається наступного старту, особиста організація перенесеним не створюється (членство вже є). Адреса, з якою людина вже ввійшла через Google під новим id, пропускається з попередженням у лозі. Підсумок — рядок `[auth] Existing users: …`. Файл, який не читається, зупиняє старт.

## Обмеження

- Особисті входи Claude/Codex і приватні сесії ключовані id користувача; організаційні дані — id організації. Інтеграції з env (GitHub-токен, ClickUp, GitLab) і локальна пісочниця — одні на сервер, спільні для всіх організацій.
- Справжній вхід через Google тут не перевірено автоматично: тести підміняють перевірку ID-токена Google (`packages/auth-better-auth/src/google.test.ts`).

## Тести

- `packages/auth-better-auth/src/{index,deferred,google}.test.ts` — адаптер; `google.test.ts` — справжній better-auth на libSQL: вхід, прив'язка до наявного рядка, вимкнений email/пароль, заборона створювати організації, запрошення, чужа адреса, видалення учасника.
- `apps/server/src/mastra/google/google-auth.test.ts` — env і перенесення; `production-boot-guards.test.ts` — вибір `FACTORY_AUTH=google`.
- UI: `SignInPage.msw.test.tsx`, `InvitePage.msw.test.tsx`, `OrganizationSection.msw.test.tsx`.
