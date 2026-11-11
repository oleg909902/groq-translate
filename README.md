# groq-translate

Плагин Claude Code: пишешь на любом языке, Claude получает **только перевод** (по умолчанию на английский). Переводит модель на Groq (бесплатный тариф). Основан на [prompt-translate](https://github.com/BruceXcluding/prompt-translate) (MIT), оставлен только Groq.

## Что делает

- Перед отправкой переводит набранный текст; в чате остаётся оригинал, Claude читает только перевод.
- Код, пути, `@файлы`, URL и идентификаторы (`parseConfig()`, `snake_case`, `camelCase`) прячутся за `⟦n⟧` и возвращаются после перевода. Если перевод потерял хоть один — Groq спрашивают ещё раз, потом отправляется оригинал.
- Служебные блоки (`<system-reminder>`, `<ide_opened_file>`, `<ide_selection>`…) не переводятся.
- Английский текст, слеш-команды (`/…`), shell-строки (`!…`) и чистый код — без запроса к Groq.
- Groq не ответил / нет ключа → уходит оригинал с предупреждением. **Claude сам не переводит**, подписка не тратится.
- Плашка над полем ввода: что набрано (`Typed`) и что ушло (`Sent`), выбор модели, выключатель.

## Установка

С GitHub:

```bash
claude plugin install groq-translate --marketplace oleg909902/groq-translate
```

Из локальной папки:

```bash
git clone https://github.com/oleg909902/groq-translate
claude plugin marketplace add ./groq-translate
claude plugin install groq-translate@groq-translate
```

Ключ Groq берётся бесплатно на [console.groq.com/keys](https://console.groq.com/keys).

Ключ — внутри сессии `claude` в терминале: `/plugin configure groq-translate@groq-translate` → `groqApiKey`. Хранится в защищённом хранилище.

## Команды

| Команда | Что делает |
|---|---|
| `/translate` | статус |
| `/translate on` / `off` | включить / выключить на сессию |
| `/translate <язык>` | сменить язык (`en`, `de`, `Russian`…) |
| `/translate model <id>` | сменить модель Groq; `default` — `openai/gpt-oss-120b` |

## Настройки

| Ключ | По умолчанию |
|---|---|
| `language` | `English` |
| `enabled` | `true` |
| `groqApiKey` | — |
| `groqModel` | `openai/gpt-oss-120b` (ещё: `openai/gpt-oss-20b`, `qwen/qwen3.8-27b`) |

## Проверка

```bash
claude plugin validate . && claude plugin test .
```

## Куда уходят данные

Только набранный текст (без кода и путей) — на `api.groq.com`, ключ в заголовке `Authorization`. Больше никаких сетевых запросов, файлы не читаются.
