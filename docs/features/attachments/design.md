# Вкладення карток і сесій

Фаза 1 зроблена. Рішення: [ADR-0009](../../adr/0009-attachments-storage-adapter.md).

- **Що це.** Файли з чату, коментарів і розділу «Файли» картки — вкладення картки (`factory_attachments`: назва, тип, розмір, sha256, джерело `chat`/`comment`/`upload`/`clickup`/`github`/`gitlab`, `sourceUrl`, хто й коли). Сесія без картки тримає вкладення в себе (видно тому, хто бачить сесію).
- **Байти — через адаптер.** `AttachmentBlobStore` (`put`/`get`/`head`/`delete`, ключ — sha256, однаковий файл зберігається раз). Зараз `LocalFileBlobStore` у `FACTORY_ATTACHMENTS_DIR` (абсолютний шлях; типово `factory-attachments` поруч із локальною БД), ліміт `FACTORY_ATTACHMENTS_MAX_BYTES` (50 МіБ). Сховище, що не ініціалізувалось, зупиняє старт; без сховища маршрути відповідають 503, а агенти не мають інструмента.
- **Завантаження.** Тіло запиту — сам файл, потоком; тип визначається за байтами. Картинки й PDF відкриваються в браузері, решта (зокрема SVG і HTML) — лише завантаженням.
- **Агентові.** `factory_list_attachments` (Mastra і Claude Code) перелічує файли й кладе їх у `.factory/attachments/<id8>-<назва>` пісочниці; `.factory/` записано в `.git/info/exclude`. Файли кладуться, коли агент викликає інструмент, а не під час старту.
- **У чаті й коментарях** кожен надісланий файл додає рядок «Вкладення: назва (розмір) → шлях»; картинки й далі йдуть моделі (у Claude Code — як файли). Невдале завантаження нічого не надсилає.
- **Куди далі файл.** Матеріали клієнта → `blackbox/artifacts/` + рядок `MANIFEST.md`, текст PDF/docx → `blackbox/sources/`; ресурси застосунку → шлях у репозиторії коду, який називає задача; великі бінарні файли лишаються вкладеннями.

## Де в коді

- Сховище, записи, `AttachmentService`: `packages/store/src/attachments/`; контрактні тести адаптера — `blob-store-contract.ts`.
- Маршрути: `packages/api/src/attachments.ts`; конфігурація — `MastraFactory({ attachments })` у `apps/server/src/mastra/index.ts`.
- Розміщення в пісочниці: `packages/sandbox/src/attachments.ts`; інструмент: `packages/harness-mastra/src/tools/attachment-tools.ts`.
- UI: `apps/ui/src/ui/domains/factory/components/CardAttachments.tsx`, поле введення чату й коментарів.
