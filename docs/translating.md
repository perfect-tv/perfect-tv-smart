# Перевод Perfect TV / Translating Perfect TV

## По-русски

Все строки интерфейса — в `strings/<код>.json`, по файлу на язык. Английский (`strings/en.json`) — основа: если в переводе нет строки, показывается английская. Код программы трогать не нужно.

**Новый язык**

```bash
npm install
npm run i18n -- add de Deutsch        # код ISO 639-1 и название языка на нём самом
```

Появится `strings/de.json` — копия английского, и язык сразу будет в списке («Настройки → Внешний вид → Язык» и кнопка языка в первом окне). Переводите значения прямо в файле.

**Правила**

- Ключи (слева) не менять. Переводить только текст справа.
- `%1$s`, `%2$s` — подстановки (название, время…), `%1$d` — число. Оставить их, можно переставить местами.
- `"_name"` — название языка на нём самом (`"Deutsch"`), `"_plural"` — правило множественных чисел:

  | правило | формы | языки |
  |---|---|---|
  | `en` | one (1), other | английский, немецкий, испанский, итальянский, шведский, турецкий… |
  | `fr` | one (0, 1), other | французский, португальский (Бразилия) |
  | `ru` | one, few, many | русский, украинский, белорусский |
  | `pl` | one, few, many | польский |
  | `cs` | one, few, other | чешский, словацкий |
  | `lt` | one, few, other | литовский |
  | `lv` | zero, one, other | латышский |
  | `ro` | one, few, other | румынский |
  | `other` | other | китайский, японский, корейский, вьетнамский, тайский, индонезийский |

  Счётные строки — объекты: `{"one": "%1$d канал", "few": "%1$d канала", "many": "%1$d каналов"}`. Нужны формы своего правила (или хотя бы `other`).
- Экран телевизора узкий для длинных фраз: держите перевод примерно той же длины, что английский.

**Проверка**

```bash
npm run i18n            # сколько переведено; -v — список непереведённого
npm run i18n -- sync de # подтянуть новые строки из английского (после обновления программы)
npm test                # подстановки, формы чисел, лишние ключи
npm run build           # сборка в dist/ — открыть dist/index.html в браузере (README, «Проверка в браузере»)
```

Готовый перевод — pull request с `strings/<код>.json` и строкой в `src/core/langs.ts` (её добавляет `npm run i18n -- add`).

Язык по умолчанию — язык телевизора, если для него есть перевод; украинский, белорусский, казахский и другие языки СНГ без своего перевода показываются по-русски (`NEAR` в `src/core/lang.ts`), остальные — по-английски.

## In English

All UI strings live in `strings/<code>.json`, one file per language. English (`strings/en.json`) is the base: anything missing from a translation falls back to English. No code changes are needed.

1. `npm install`, then `npm run i18n -- add <code> <Name>` — e.g. `npm run i18n -- add de Deutsch` (ISO 639-1 code, language name in the language itself). This creates `strings/de.json` as a copy of English and registers it in `src/core/langs.ts`; the language appears in Settings → Appearance → Language and on the first-run screen.
2. Translate the values in place. Do not change the keys. Keep the placeholders `%1$s`, `%2$s` (text) and `%1$d` (number) — you may reorder them.
3. Set `"_name"` (language name, e.g. `"Deutsch"`) and `"_plural"` — the plural rule from the table above (`en` for most Western European languages, `other` for Chinese/Japanese/Korean…). Plural strings are objects with the forms of that rule, e.g. `{"one": "%1$d channel", "other": "%1$d channels"}`.
4. Check: `npm run i18n` (progress; `-v` lists untranslated keys), `npm test`, `npm run build`. After app updates, `npm run i18n -- sync <code>` adds new English strings to your file.
5. Open a pull request with `strings/<code>.json` and the line in `src/core/langs.ts`.

TV screens are narrow for long phrases — try to keep translations about as long as the English text.
