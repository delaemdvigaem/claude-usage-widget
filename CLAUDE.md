# claude-usage-widget — личный, публичный проект
Клиент: нет (свой продукт Рустама). Стек: GNOME Shell extension (GJS/ESM, St/Clutter), GNOME 50 Wayland. Деплой: релизы GitHub → extensions.gnome.org → пакет ALT Sisyphus.
Правила: секреты в access/ и .env (не коммитить); файлы для Рустама в out/; репозиторий Рустама (delaemdvigaem) — коммит и пуш автоматически.

## Что делаем
Виджет **на фоне рабочего стола** (не индикатор в панели): три полоски — сессия (5 ч), неделя, неделя по модели; проценты, время до сброса, цвет по severity. Настройки: позиция, размер, прозрачность, интервал.
Потом — публикация для всех: EN/RU, вход через Claude (OAuth PKCE как у Claude Code), токен в GNOME Keyring.

## Техника (итог ресёрча 20.09.2026, подробнее в памяти project-claude-usage-desktop-widget)
- Единственный рабочий способ в GNOME/Mutter Wayland: extension кладёт St-актор в `Main.layoutManager._backgroundGroup` (так делают azclock/Desktop Clock #5156, Desktop Widgets NiffirgkcaJ, Modern Clock, Background Logo — версии 45–51). Conky/Eww/layer-shell в GNOME не работают (gnome-shell#1141 WONTFIX).
- Расположение: `~/.local/share/gnome-shell/extensions/claude-usage@delaemdvigaem.github.io/` (metadata.json shell-version ["49","50"], ESM extension.js, prefs.js, schemas/). После enable — logout/login (Wayland).
- Данные: `GET https://api.anthropic.com/api/oauth/usage`, заголовки `Authorization: Bearer <accessToken>`, `anthropic-beta: oauth-2025-04-20`, **`User-Agent: claude-code/<версия>` обязателен** (иначе 429). Ответ: `five_hour`/`seven_day` {utilization, resets_at} и `limits[]` {kind: session|weekly_all|weekly_scoped, percent, severity, resets_at, scope.model.display_name}. Опрос не чаще 1 раза в 3 мин.
- Токен: из `~/.claude/.credentials.json` → `claudeAiOauth.accessToken` (живёт ~60 мин, обновляет Claude Code; refresh сами не делаем, при истечении показываем последнее значение и пометку). Для OAuth-входа: client_id Claude Code `9d1c250a-e61b-44d9-88ed-5944d1962f5e`, PKCE, callback на localhost, scopes `user:profile user:inference`.
- Риск: endpoint недокументирован — при ошибках показывать «сервис недоступен», не падать.

## Проверка
Ставить в ~/.local/share/gnome-shell/extensions, включать `gnome-extensions enable`, смотреть `journalctl --user -f -o cat /usr/bin/gnome-shell` на ошибки; для отладки без logout — nested shell: `dbus-run-session -- gnome-shell --nested --wayland`.
