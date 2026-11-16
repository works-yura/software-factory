# Перегляд файлів сесії

Панель «Файли» показує файли робочої папки сесії. Коміти: `2fff034`, `16724c2`, `3cbb39e`, `243e099`, `8d6c760`.

- **Перегляд:** Markdown рендериться, довгі рядки переносяться; інший текст — з підсвіткою.
- **Повний екран:** кнопка відкриває документ у діалозі на весь екран.
- **Завантаження:** текстовий файл завантажується під своєю назвою (`apps/ui/src/lib/downloadText.ts`).
- **Нотатки на тексті:** у чаті сесії документ можна коментувати як повідомлення — виділити текст, написати нотатку в однорядковому полі (Enter — додати, Esc — скасувати); у повноекранному режимі — «Надіслати все (N)». Нотатки йдуть агенту з номерами, і він відповідає на кожну.

## Де в коді

- `apps/ui/src/ui/domains/workspace-viewer/components/WorkspaceFileViewer.tsx` і `file-viewer/{FileDocument,FileAnnotations,ExpandedFileDialog}.tsx`.
- Нотатки: `packages/playground-ui/src/ds/components/ai/annotations/` (`annotation-selection-toolbar.tsx`).

## Інший робочий простір: теки звернень «Помічника»

Та сама панель показує теку звернення помічника (ADR-0051). Звідки панель читає, задає `WorkspaceFilesEndpointsContext` (`context/WorkspaceFilesEndpoints.ts`): `treeUrl`, `fileUrl`, `downloadUrl`. Типово це маршрути сесії (`/web/workspace/tree|file|file/download`). Помічник підставляє `/web/assistant/requests/:id/workspace/tree|view|file`. Сервер помічника відповідає тими самими формами (`WorkspaceTreeListing`, `WorkspaceFile`), тож дерево, перегляд (Markdown з нотатками, медіа, повний екран), завантаження й посилання на файли в чаті (`WorkspaceFileLinks`) працюють без змін.

- `WorkspaceFilesPanelProvider` — стан і розміри панелі для будь-якого простору. `WorkspaceFilesProvider` — його обгортка для сесії з маршруту.
- `WorkspacePanelContext.content` — що показує картка чи поповер; без нього це `WorkspaceFilesContent` сесії.
- `WorkspaceViewerPanel filesOnly` — лише дерево й файл: без огляду, змін, стрічки й пристрою.
- `WorkspaceFileBrowser.onBack` тепер необов'язковий.
