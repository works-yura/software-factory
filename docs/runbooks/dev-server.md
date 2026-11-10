# Дев-сервер

## Запуск

```sh
cd apps/server
corepack pnpm dev:local
```

- Порт `5874` (API — `http://127.0.0.1:5874/api`). Перевірка: `curl -s -o /dev/null -w '%{http_code}' http://localhost:5874/` → `200`.
- Під час старту `sync:skills` копіює `packages/harness-mastra/factory-skills` у `apps/server/src/mastra/public/factory-skills`.
- Сервер стежить за файлами й сам перезапускається після зміни коду пакетів (`Restarting server...` у лозі).

## Що після якої зміни

| Змінено | Потрібно |
| --- | --- |
| UI (`apps/ui`, `packages/playground-ui`) | `cd apps/ui && corepack pnpm -s build`, потім оновити сторінку: сервер віддає `apps/ui/dist` |
| Скіли (`factory-skills`) | повний перезапуск сервера: скіли копіюються лише під час старту |
| Код пакетів сервера | нічого: перезапуститься сам; нова колонка БД додається під час старту |

## Повний перезапуск

1. Знайти процес: повідомлення «Another development server instance is already running in this directory» називає PID (`kill <pid>`), або `lsof -nP -iTCP:5874 -sTCP:LISTEN`.
2. Зупинити **за PID**: `kill <pid>`; дочекатися, поки процес зникне (`kill -0 <pid>`).
3. Запустити знову (`corepack pnpm dev:local`) і перевірити `200`.

Процес може тримати блокування, навіть коли порт уже не відповідає — тоді теж зупинити за PID. Сервер часто перезапускають інші сесії: перед зупинкою подивитись, чий він і чи не йде e2e.

## e2e

- Під час e2e файли не редагуються (сервер перезапуститься й усі тести впадуть).
- Для e2e дозволено зупинити дев-сервер; після — запустити знову.
