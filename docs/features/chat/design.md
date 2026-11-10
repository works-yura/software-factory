# Чат сесії

Рішення: [ADR-0006](../../adr/0006-questions-through-cards.md), [ADR-0010](../../adr/0010-chat-references-registry.md), [ADR-0011](../../adr/0011-chat-markdown-no-html.md), [ADR-0014](../../adr/0014-ui-from-design-system.md).

## Повідомлення

- Текст агента рендерить `MarkdownRenderer` (`packages/playground-ui/src/ds/components/MarkdownRenderer/`, react-markdown + remark-gfm). HTML не виконується і показується текстом — скіли пишуть лише Markdown.

## Картки питань

- Одне питання — `AskUser` з дизайн-системи; кілька — одна картка `AskUser.Questions` (`packages/playground-ui/src/ds/components/ai/ask-user/ask-user-questions.tsx`): у кожного питання свої варіанти й «власна відповідь» як один із варіантів, одна кнопка надсилає всі відповіді.
- Адаптер у застосунку: `apps/ui/src/ui/domains/chat/components/AskUserQuestionsCard.tsx`; картка, на яку сесія не чекає, вимкнена; відповідь не повертається активною після перемикання чатів.

## Посилання на сесії й картки

- Рядок сесії в бічній панелі можна перетягнути в поле введення або вибрати «Додати в чат» у його меню.
- Види посилань — реєстр `apps/ui/src/ui/domains/chat/services/refKinds.ts` (`defineRefKind`); зараз `session` і `card`. У тексті повідомлення — блок `factory-refs`, по рядку JSON на посилання (`factoryRefs.ts`).
- Показ — частини вкладень дизайн-системи: у полі введення як вкладений файл (іконка, назва, «Картка · <дошка>» / «Сесія», прибрати); у стрічці — `AttachmentCard`, клік відкриває сесію. Невідомий вид — назвою, без кліку.
- Сесії «Продукту» читають посилання інструментом `factory_read_session` (картка, документи зміни, останні повідомлення; лише своя організація й Factory, чужу приватну сесію не віддає).

## Вкладення

- Будь-який файл у чаті й коментарях; деталі — [attachments](../attachments/design.md).

## Бічна панель сесій

- Сесії картки групуються під назвою картки, кожна підписана контекстом (Розбір, Робота, Перевірка, Продукт) — лише коли в картки кілька сесій. Картка з однією сесією — один рядок; контекст лишається в доступній назві рядка (`nestCardSessions`, `apps/ui/src/ui/domains/workspaces/services/sessionGroups.ts`).
- «Показати ще N» — пачками по 20.
