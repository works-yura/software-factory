# Команда, ролі й акаунт

Рішення: [ADR-0045](../../adr/0045-organization-roles-and-join-links.md). Вхід і організації загалом — [design.md](design.md).

Зразок — налаштування Mastra Platform (Account, Organization › General, Team). Листів Factory не надсилає: запрошення й вступ — посиланням.

## Карта пакетів

| Пакет | Що | Інтерфейси |
| --- | --- | --- |
| `@factory/access` | каталог дозволів, матриця ролей, `can()`, правила посилань і аватарок | `MembershipDirectory`, `InvitationService`, `JoinLinkStore`, `AvatarStore` |
| `@factory/http` | `route({ access })`, `withAccess`, `declareAccess`, `enforceRouteAccess`, `undeclaredWrites`; `RouteAuth.can()` | — |
| `@factory/auth` | роль людини на запит (`resolveOrganizationRole`), `canInOrganization`, `/auth/me` з `permissions`, група `/api/*` → `run.start` | читає `MembershipDirectory.role` |
| `@factory/auth-better-auth` | адаптер: роль `viewer`, зміна ролей без `owner`, події для аудиту | реалізує `MembershipDirectory`, `InvitationService` |
| `@factory/store` | `JoinLinksStorage` (`join_links`), `AvatarsStorage` (`factory_avatars` + сховище вкладень) | реалізує `JoinLinkStore`, `AvatarStore` |
| `@factory/api` | `buildTeamRoutes`: посилання для вступу, вступ, аватарки | використовує всі чотири |
| `@factory/server` | збирає все, ставить `enforceRouteAccess` перед усіма маршрутами, події → журнал аудиту | — |
| `apps/ui` | `useCan(permission)`; Організація, Команда, Мій акаунт, `/join/:token` | — |

## Ролі й дозволи

| Дозвіл | Глядач | Учасник | Адмін / власник |
| --- | :-: | :-: | :-: |
| `board.read` — дошки, картки, чати, налаштування | ✓ | ✓ | ✓ |
| `self.write` — свої позначки уваги, профіль, вихід, вступ за посиланням | ✓ | ✓ | ✓ |
| `card.write`, `comment.write`, `run.start`, `session.write` | | ✓ | ✓ |
| `factory.configure` — середовище, моделі за замовчуванням, підключення своїх акаунтів | | ✓ | ✓ |
| `factory.manage` — дошки, маршрути надходження, навички, змінні пісочниці, адмінські поля проєкту | | | ✓ |
| `connections.manage`, `org.manage`, `members.manage`, `join-links.manage`, `content.moderate` | | | ✓ |

- Кожен модуль маршрутів оголошує таблицю `ROUTE_ACCESS` (`"METHOD /path" → дозвіл`); запис без оголошення сервер відмовляє (403 `permission_undeclared`), а тест `factory.test.ts › route access` падає.
- Власник — творець організації: показується як «Адмін» з позначкою «власник»; його роль ніхто не змінює, вийти він не може.

## Посилання для вступу

- `@factory/store` › `JoinLinksStorage`: токен 32 байти, домени (точний збіг домену email; порожньо — будь-яка підтверджена адреса), термін (ніколи, 1, 7, 30 днів або своя дата), ліміт, використання під блокуванням рядка.
- Маршрути: `GET/POST /web/org/join-links`, `POST /web/org/join-links/:id/revoke` (адмін), `GET /web/join/:token` (організація, роль, чи вже учасник, чому не можна), `POST /web/join/:token/accept`. Після вступу UI робить організацію активною (`set-active`) і відкриває застосунок у ній.

## Аватарки

- `POST /web/avatars` (тіло — data URL png/jpg/webp, до 256 КБ; браузер зменшує до 256 px), `GET /web/avatars/:id`. Байти — у сховищі вкладень.
- Організація: `organization/update { data: { logo } }` (better-auth, адмін). Людина: `update-user { image }`.

## Акаунт

- Ім'я редагується (better-auth `update-user`), email лише для читання.
- Сесії: пристрій з User-Agent, IP з `X-Forwarded-For`, «Поточна сесія», «Вийти» з іншої, «Вийти всюди, крім цього».
