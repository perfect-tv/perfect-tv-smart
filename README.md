# Perfect TV — IPTV-плеер для LG webOS

Плеер для телевизоров LG (webOS 3.0 и новее): эфир, архив (catchup, в том числе Flussonic), ТВ-гид сеткой и списком, «Программа и архив», избранное, скрытие, блокировка по PIN, напоминания, поиск, русский и английский интерфейс. Пакет `top.rootu.perfecttv`.

- Плейлист (M3U/M3U8) загружается потоком; программа (XMLTV, `.gz`, `.zip`) загружается и разбирается в Node-сервисе, а все данные хранятся в SQLite3 через WebSocket (без записи EPG в браузерную IndexedDB).
- Видео: по умолчанию встроенный HLS-плеер для эфира и hls.js (MSE) для архива; режим можно изменить в настройках.
- В пакете — JS-сервис с локальным прокси; если webOS запрещает слушающий HTTP-порт,
  плейлисты M3U можно загрузить через Node-сервис по шине Luna бинарными порциями.
  Для загрузки EPG с версии 1.0.8 нужен активный WebSocket SQLite на порту 47380;
  для видеопотоков с особыми заголовками всё ещё нужен HTTP-прокси.

Документы: [docs/TZ.md](docs/TZ.md) — ТЗ и решения по платформе, [docs/controls.md](docs/controls.md) — управление, [docs/design.md](docs/design.md) — оформление, [docs/PLAN.md](docs/PLAN.md) — план и что проверено.

## Сборка

Нужен Node.js 18+.

```bash
npm install
```

```bash
npm run build
```

```bash
npm test
npm run test:service
```

`dist/` — приложение, `npm run package` — `.ipk` в `out/` (`dist/` + `service/`).

## Проверка в браузере

Прокси на ПК и статический сервер для `dist/`:

```bash
npm run proxy
```

```bash
python3 -m http.server 8731 --bind 127.0.0.1 --directory dist
```

Открыть `http://127.0.0.1:8731/index.html` в окне 1920×1080. Пульт — клавиатура: стрелки, Enter (OK), Esc (Назад), PageUp/PageDown (CH±), M — меню, G — гид, I — инфо, H — недавние, F — поиск, пробел — пауза, «,» / «.» — перемотка.

## Симулятор webOS TV

webOS TV Simulator (с сайта LG, для Linux — AppImage) JS-сервисы не запускает: держать `npm run proxy` на ПК — приложение найдёт прокси на `127.0.0.1:47380`.

```bash
./webOS_TV_6.0_Simulator_1.4.1.appimage /путь/к/perfecttv_webos/dist
```

Чтобы не набирать адрес плейлиста экранной клавиатурой, положите его в `dist/dev-playlist.txt` (первая строка) — без плейлистов приложение добавит его само. Файл в сборку не входит (`npm run build` его не создаёт).

Архив Flussonic без настоящего сервера — `tools/flussonic_mock.py` (нужен ffmpeg; в кадре — время сегмента, на шкале должно быть то же):

```bash
python3 tools/flussonic_mock.py 8471 Europe/Moscow
```

Плейлист — `http://127.0.0.1:8471/list.m3u`.

## Телевизор

Включить режим разработчика (приложение Developer Mode из LG Content Store), затем:

```bash
npx ares-setup-device
```

```bash
npx ares-install -d tv out/top.rootu.perfecttv_1.0.9_all.ipk
```

```bash
npx ares-launch -d tv top.rootu.perfecttv
```

## Устройство кода

```
src/main.ts            запуск: стили, масштаб, клавиши, колесо и курсор Magic Remote
src/core/              Clock, Net (fetch-поток, Range, сессии прокси), Platform (Luna, сервис, выход),
                       Prefs, Storage2 (localStorage), lang (строки), polyfills (Chromium 38)
src/data/              m3u, xmltv (shared), compact, catchup, matcher, sqlite client,
                       epgservice (WebSocket progress), repo, catalog, userdata
src/service/           epg-entry.ts (shared parser + matcher for Node bundle)
src/player/playback.ts hls.js и встроенный плеер: окно, PROGRAM-DATE-TIME, дорожки
src/ui/                tv (оркестратор), keys, layer, info (инфопанель), guide (Canvas), schedule,
                       menu, pin, popups (окна, списки, карточка, напоминания, формы), search,
                       settings, widgets (тост, набор номера, карусель), logos, cells, u, style, fmt
service/               proxy.js (локальный прокси + WebSocket), sqlitekv.js + sqlite-settings.js (две SQLite3),
                       epgservice.js (stream XMLTV -> SQLite), epg-parser.js (ES5 bundle),
                       service.js (JS-сервис webOS); код ES5/Node.js 0.12+
strings/               en.json, ru.json
```

## Добавление плейлиста по QR (v1.0.3)

1. На телевизоре: **Настройки → Плейлисты → Добавить плейлист по QR-коду**.
2. Отсканируйте QR на телефоне, подключённом к той же локальной сети, что и телевизор.
3. Вставьте URL M3U/M3U8, при желании укажите название, нажмите **«Отправить на телевизор»**.
4. Приложение добавит плейлист и загрузит каналы; ссылка на телефон действует **5 минут**.

Для QR-ввода сервис открывает отдельный временный HTTP-порт **47381**, доступный в локальной сети.
Обычный IPTV-прокси **47380** остаётся доступен только с телевизора (`127.0.0.1`).
QR генерируется на ТВ локально; сторонние сайты и QR-сервисы не используются.
Порт 47381 закрывается при отмене или по истечении срока действия QR-кода.
Если телефон не может открыть страницу, проверьте, что устройства в одной сети и на Wi-Fi
нет изоляции клиентов; доступность входящих соединений зависит от настроек и прошивки ТВ.

**Ограничение:** на некоторых телевизорах webOS запрещено открывать входящие HTTP-порты.
В таком случае QR-ввод недоступен. При этом загрузка M3U/XMLTV по адресу на самом ТВ
должна работать через транспорт Luna, если JS-сервис запускается.

**Сервис webOS:** подписка `start` + ActivityManager `keepAlive` удерживают сервис во время
работы приложения; пакет теперь не маскирует ошибку `EADDRINUSE` на порту 47380.
При запуске на настоящем ТВ проверьте в **Настройки → Сеть → Состояние прокси**: «Работает».
Исправлены ожидание фактического запуска сокета и повторный вызов сервиса при неудаче.
UA по умолчанию для запросов через прокси: `PerfecktTV` (заголовки конкретного канала имеют приоритет).

## Проверка Node-сервиса в версии 1.0.4

Откройте **Настройки → Сеть → Служба приложения (прокси)** и нажмите OK.

- **«Работает»** — локальный HTTP-прокси доступен, как в предыдущих версиях.
- **«Luna: плейлисты и EPG»** — JS-сервис поднялся, но HTTP-порт недоступен;
  загрузка M3U и XMLTV идёт через Luna без CORS. Видео с обязательными заголовками
  через такой режим не гарантируется, QR-ввод требует открытого HTTP-порта.
- **«Не запущена»** — телевизор не запускает сам JS-сервис. Смотрите
  **Настройки → Данные → Журнал**: ошибки `service: failed` / `Luna service unavailable`.

Обновляйте `.ipk` поверх установленного Perfect TV, не удаляя приложение, чтобы
не очищать локальную базу плейлистов и настроек. Реальный запуск на LG TV ещё нужно проверить.

## Обновление 1.0.5 — ошибка QuotaExceededError на webOS

- Проверено по журналу реального LG webOS 05.20.15: Luna и HTTP-прокси запустились, плейлист
  получен (HTTP 200) и разобран (4975 каналов), но IndexedDB не смог сохранить большую запись.
- Каналы теперь пишутся в IndexedDB в gzip-формате (UTF-8 JSON), старые записи читаются без
  переноса/удаления. Пачки XMLTV тоже хранятся сжатыми; старые записи программы совместимы.
- Если запись каналов упирается в квоту, приложение однократно очищает только скачанный кэш
  EPG (программы/каналы/метаданные источников) и повторяет сохранение. Настройки, плейлисты,
  избранное и пользовательские данные остаются на месте. Программа автоматически загрузится
  заново, если EPG задан.
- Переполнение хранилища теперь отображается как «Хранилище приложения недоступно», а не
  «Нет соединения с сервером». Ошибка записи состояния не создаёт `unhandled promise`.
- Лимит сохранённых неработающих URL логотипов — 150, чтобы они не разрастались в localStorage.
- Новая версия совместима с установленной 1.0.4; устанавливать поверх, без удаления приложения.

Проверено локально (типизация, тесты, сборка ES5 и упаковка). На реальном телевизоре
надо повторить загрузку 4975 каналов и проверить, что ошибка не возвращается.

## Обновление 1.0.6 — файловое хранилище при переполнении IndexedDB

На LG webOS 05.20.15 сжатый M3U (1521 канал, 599 КБ → 52 КБ) всё равно
вызывал `QuotaExceededError`. Это подтверждает, что сжатия недостаточно:
браузерное хранилище может быть уже заполнено даже для маленьких записей.

- При первом отказе IndexedDB по квоте `Db` переключает запись на **файлы JS-сервиса**
  в `/media/internal/perfecttv-data`. Это отдельное хранилище, разрешённое LG
  для JS-сервисов. HTTP-порт `127.0.0.1:47380` уже подтверждён на тестовом ТВ.
- Старые данные из IndexedDB доступны для чтения. Новые данные из файлового
  хранилища имеют приоритет, без удаления прежней базы, избранного и настроек.
- Плейлисты, каналы, EPG, сопоставления и источники используют общую обёртку.
  Сжатые бинарные записи передаются через локальный HTTP в Base64 и сохраняются
  атомарно (временный файл + переименование). Не используются сторонние сайты.
- EPG-воркер оповещает приложение о смене режима, чтобы гид сразу читал файлы.
  Удаление EPG затрагивает только EPG; общий сброс удаляет обе базы по запросу пользователя.
- Для `localStorage` добавлено безопасное освобождение только кэша ошибок логотипов,
  если новая запись настроек не помещается.

**Проверка:** в «Настройки → Данные → Журнал» после первого переполнения должна
появиться строка `IndexedDB quota: switching to Node file storage`, затем
`storage: Node filesystem write ok`. Повторная загрузка плейлиста должна
завершиться без `playlist failed storage`. Если файловая запись запрещена на
конкретной прошивке, журнал покажет `file storage put: ...` и первоначальная
ошибка сохранения останется — не удаляйте приложение и пришлите журнал.

Файловый доступ на реальном телевизоре LG ещё не подтверждён: локально
проверены Node HTTP API, сохранение/чтение после перезапуска, частичная очистка,
сборка для ES5/Node 0.12, тесты. Устанавливать поверх 1.0.5.

## Обновление 1.0.7 — SQLite3 и WebSocket (требуется проверка на LG)

При сохранении 1521–4975 каналов на webOS 05.20.15 браузерная IndexedDB
продолжала выдавать `QuotaExceededError` даже после сжатия M3U.
Новая архитектура **не использует IndexedDB или localStorage для записи данных**.

- **`ws://127.0.0.1:47380/db`** — WebSocket (RFC6455) в том же Node-сервисе,
  который уже обслуживает IPTV-прокси; не открывает дополнительный TCP-порт.
- **`/media/internal/perfecttv-data/perfecttv.sqlite3`** — настоящий SQLite3-файл с
  таблицей `kv(s TEXT NOT NULL, k TEXT NOT NULL, v TEXT NOT NULL)`. Весь доступ
  только через `get/put/list/delete/deleteRange/reset/status`, произвольный SQL
  из интерфейса не принимается.
- SQLite формируется и читается ES5 JavaScript-модулем `service/sqlitekv.js`:
  прямой разбор B-дерева SQLite3, UTF-8 и overflow-страниц, атомарная
  перезапись временного файла через `rename`. **Это не нативный модуль sqlite3
  и не полноценный движок SQL**: он реализует только необходимый KV-протокол.
  Причина: старый Node 0.12.2 на телевизоре не поддерживает привычные свежие
  двоичные модули и WASM. Файл проверяется внешним стандартным SQLite3.
- `src/data/socketdb.ts` работает из WebView и EPG Worker. Каналы, плейлисты,
  источники и данные EPG, сопоставления и все настройки/избранное/напоминания
  идут в SQLite по WebSocket. Сжатые записи передаются в base64.
- До создания интерфейса однократно переносятся записи старых IndexedDB,
  файлового хранилища 1.0.6 и localStorage. Старые данные **не удаляются**;
  маркеры миграции предотвращают повторный импорт удалённых значений.
- Если SQLite/WebSocket недоступен, предыдущие данные можно прочитать, но
  новые записи **не делаются в заполненное браузерное хранилище**.
- В «Настройки → Сеть» показан статус `База SQLite3 (WebSocket)`.

**Местные проверки:** 53 теста веб-интерфейса, тесты сервиса/файлового
хранилища, SQLite3 `PRAGMA integrity_check = ok`, взаимодействие по WebSocket,
проверка ES5 синтаксиса, упаковка IPK. На настоящем LG ещё не проверено.
Сервис при каждой записи перестраивает таблицу целиком, поэтому очень
большой XMLTV может работать медленнее обычного нативного SQLite3.

**Проверка:** установить поверх 1.0.6; в журнале должны появиться
`sqlite websocket ready SQLite3`, `SQLite settings ready`,
`sqlite migration ...`; в «Сеть» — `База SQLite3: Подключена`.
Затем обновить M3U, проверить EPG, перезапустить приложение и убедиться, что
плейлист и избранное остались. Не удалять приложение до проверки миграции.

## 1.0.8 - EPG parsing in the Node service

- The web application no longer downloads, decompresses or parses XMLTV in a Web Worker.
- `epgStart` / `epgStatus` over `ws://127.0.0.1:47380/db` return a job ID, progress and completion state. The service itself fetches XMLTV, streams gzip / ZIP deflate, matches channels and writes programme packs into SQLite.
- Matching and XMLTV parsing use the same TypeScript sources as the previous UI version, compiled as an ES5 CommonJS module for Node 0.12.
- EPG source metadata (ETag / 304), compressed programme packs, matching maps and older stored EPG are preserved. The old IndexedDB/localStorage data are not erased.
- The service must be running and its localhost WebSocket must be accessible. Without that connection EPG cannot be updated; the UI logs a service error instead of trying to write EPG into the browser's full storage.
- Tests: `npm run test:service` (integration with HTTP XMLTV gzip and ZIP, WebSocket, SQLite) and `npm run test:epg-large` (96,000 programmes). Hardware verification on LG TV is still required.

## Обновление 1.0.9 — ускорение переключения каналов

- В версии 1.0.8 запись последнего канала или истории запускала сериализацию всей
  SQLite с большим EPG. Теперь настройки/избранное/история пишутся в отдельную SQLite3:
  `/media/internal/perfecttv-data/perfecttv-settings.sqlite3`. Плейлисты и EPG остаются
  в `/media/internal/perfecttv-data/perfecttv.sqlite3`. Обе базы обслуживает тот же
  Node-сервис через WebSocket. При первом запуске существующие настройки копируются
  из старого SQLite-файла в новый. Старый файл при переносе не удаляется.
- SQLite-движок больше не блокирует цикл обработки запросов Node на всё время
  обновления EPG: запись формируется небольшими порциями с уступкой event loop.
  Индекс EPG по паре `(источник, канал)` ускоряет запросы гида при переключении.
  Пакетные записи EPG укрупнены, чтобы уменьшить число полных обновлений БД.
- В настройках «Плеер HLS» появился режим «Авто» (по умолчанию на LG):
  встроенный плеер для прямого эфира, hls.js для архива и один откат на hls.js
  при ошибке нативного HLS. Ранее явно выбранные режимы не перезаписываются.
- Журнал содержит время от начала подключения до готовности плеера
  (`play ready … ms native/hls`).
- Проверки: unit tests, сервисные тесты, перенос настроек, сохранение после
  перезапуска, проверка `PRAGMA integrity_check` обеих баз, responsiveness при записи EPG.

Обновлять **поверх 1.0.8 без удаления приложения**. CPU и скорость на реальном LG
нужно подтвердить на обычных каналах и при фоновой загрузке программы.

## Эмуляторы webOS TV 3 и 4

Образы LG (webOS 3.x — Chrome 38, webOS 4.x — Chrome 53; в JS-сервисе у обоих Node 0.12.2) — проверить приложение и сервис целиком на старых версиях.

- Скачать: менеджер пакетов webOS Studio (VS Code) или напрямую — `Emulator_tv_linux_v3.0.0.zip` / `…v4.0.0.zip` из `https://developer.lge.com/resource/tv/RetrieveToolLastVersion.dev?resourceId=RS00007403` (лицензия LG SDK), распаковать в `~/webos-emulator/v3.0.0` / `v4.0.0`.
- Запуск без окна в QEMU/KVM: `tools/emu-webos.sh 3` или `4` (VirtualBox не стартует, пока KVM занят другим эмулятором). Остановить — `tools/emu-webos.sh stop`. Одновременно — один.
- Установка: `ares-install -d emulator out/….ipk`, запуск — `ares-launch -d emulator top.rootu.perfecttv`. SSH (для `ares-*` и `ssh`): старый ключ хоста — `-o HostKeyAlgorithms=+ssh-rsa -o PubkeyAcceptedAlgorithms=+ssh-rsa -i ~/.ssh/webos_emul -p 6622 developer@127.0.0.1`.
- Снимки: webOS 4 — веб-слой на экран машины под QEMU не выводится, снимать через DevTools (`node tools/emu-cdp.js shot s.png`); webOS 3 — наоборот, снимок DevTools зависает, а экран машины виден: `screendump` в мониторе QEMU (`/tmp/webos-emu-mon.sock`). Нажатия и JS — `tools/emu-cdp.js key 40 5 | eval '…'` на обоих.
- Машина ПК изнутри — `10.0.2.2` (тестовый плейлист и программа — с локального сервера на ПК). Плейлист без пульта: на webOS 4 — положить `playlists.json` в `/media/internal/perfecttv-data/` до запуска; на webOS 3 у `developer` нет прав на `/media/internal` — добавить через DevTools: `tv.repo.addPlaylist('Тест', 'http://10.0.2.2:…').then(function (p) { tv.switchPlaylist(p); })`.
- Замер сценария: `node tools/emu-cdp.js trace 8 14 40 150` (трасса, пока ↓ жмётся каждые 150 мс: JS-кадры `FireAnimationFrame`, `Layout`, `Paint`, растр `GPUTask`), `node tools/emu-cdp.js profile 8 40 150` + `python3 tools/emu-profile.py` (горячие функции JS), процессор по процессам — `tools/emu-cpu.sh`. Перед замером дождаться конца фоновой загрузки программы (процесс `epg-child.js` спит), видео — остановить: в эмуляторе оно декодируется программно.

## Установщик на телевизор (для пользователей)

`npm run installer` → `out/PerfectTV-Installer-<версия>.zip`: `PerfectTV-Installer.exe` (Windows, без установки), свежий `.ipk` и «Как установить.txt». Человек включает на ТВ приложение «Developer Mode» (Dev Mode Status и Key Server), запускает `.exe` и вводит IP и Passphrase — дальше программа сама (`tools/tv-installer/main.go`):

1. ключ SSH с телевизора — `http://IP:9991/webos_rsa` (зашифрован Passphrase);
2. SSH `prisoner@IP:9922`, пакет — в `/media/developer/temp` (через `cat`, без SFTP);
3. `luna-send-pub -i luna://com.webos.appInstallService/dev/install` — до `installed` / `FAILED`, пакет удаляется;
4. запуск — `com.webos.applicationManager/launch` (через `-i`: `-n 1` на части ТВ молчит);
5. продление режима разработчика: токен из `/var/luna/preferences/devmode_enabled` → `https://developer.lge.com/secure/ResetDevModeSession.dev?sessionToken=…` (как кнопка Extend в Developer Mode).

IP и код запоминаются в `tv-installer.json` рядом с программой; `.ipk` — перетащенный на программу или самый свежий рядом. Проверка на эмуляторе: ключ эмулятора, зашифрованный кодом, отдать на `127.0.0.1:9991/webos_rsa` (`openssl rsa -in ~/.ssh/webos_emul -aes128 -traditional -passout pass:КОД -out webos_rsa`), запуск — `PTV_SSH_PORT=6622 PTV_SSH_USER=developer`.

## Перевод на другие языки

Строки — `strings/<код>.json`, новый язык — `npm run i18n -- add <код> <Название>`, прогресс — `npm run i18n`. Подробно (по-русски и по-английски) — [docs/translating.md](docs/translating.md).
