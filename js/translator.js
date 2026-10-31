/**
 * Translator Module
 * Talks to Nano-GPT, OpenRouter, Ollama, LM Studio and any OpenAI-compatible endpoint.
 *
 * Translation pipeline:
 *   1. analyzeCardContext — "passport" of the character (gender, address form, tone, glossary).
 *   2. buildTranslationUnits — every translatable piece of the card becomes a unit with a stable id.
 *   3. translateUnits — units are packed into batches sized by token budget, each batch is sent
 *      as <field id="..."> blocks; truncated or missing units are retried one by one.
 *   4. applyTranslations — results are written back into card data (lorebook keys are additive).
 */

import { TEXT_FIELDS, countStats } from './card-parser.js';

export const PROVIDER_PRESETS = {
  nanogpt: {
    id: 'nanogpt',
    name: 'Nano-GPT',
    baseUrl: 'https://nano-gpt.com/api/v1',
    defaultModel: 'deepseek/deepseek-v4.1-flash',
    popularModels: [
      { id: 'deepseek/deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash' },
      { id: 'deepseek/deepseek-chat', name: 'DeepSeek V3' },
      { id: 'deepseek/deepseek-r1', name: 'DeepSeek R1 (рассуждающий)' },
      { id: 'gpt-4o-mini', name: 'GPT-4o Mini' }
    ],
    needsKey: true,
    hint: 'API-ключ Nano-GPT (sk-...). Запросы идут через локальный прокси run.py. Полный список моделей — кнопка «Обновить список».'
  },
  openrouter: {
    id: 'openrouter',
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'deepseek/deepseek-chat',
    popularModels: [
      { id: 'deepseek/deepseek-chat', name: 'DeepSeek V3 (быстрый и дешёвый)' },
      { id: 'deepseek/deepseek-r1', name: 'DeepSeek R1 (рассуждающий)' },
      { id: 'anthropic/claude-sonnet-4.5', name: 'Claude Sonnet 4.5' },
      { id: 'google/gemini-2.5-flash', name: 'Gemini 2.5 Flash' },
      { id: 'google/gemini-2.5-pro', name: 'Gemini 2.5 Pro' },
      { id: 'qwen/qwen3-235b-a22b', name: 'Qwen3 235B' }
    ],
    needsKey: true,
    hint: 'Требуется API-ключ OpenRouter. Полный список моделей — кнопка «Обновить список».'
  },
  ollama: {
    id: 'ollama',
    name: 'Ollama (локально)',
    baseUrl: 'http://localhost:11434/v1',
    defaultModel: 'qwen2.5:latest',
    popularModels: [
      { id: 'qwen2.5:latest', name: 'Qwen 2.5' },
      { id: 'llama3.1:latest', name: 'Llama 3.1' },
      { id: 'mistral:latest', name: 'Mistral' }
    ],
    needsKey: false,
    hint: 'Для работы из браузера запустите Ollama с CORS: set OLLAMA_ORIGINS=* && ollama serve'
  },
  lmstudio: {
    id: 'lmstudio',
    name: 'LM Studio (локально)',
    baseUrl: 'http://localhost:1234/v1',
    defaultModel: '',
    popularModels: [],
    needsKey: false,
    hint: 'В LM Studio включите Local Server и переключатель Enable CORS.'
  },
  custom: {
    id: 'custom',
    name: 'OpenAI-совместимый',
    baseUrl: 'http://localhost:5001/v1',
    defaultModel: '',
    popularModels: [],
    needsKey: false,
    hint: 'KoboldCpp, vLLM, TabbyAPI, llama.cpp server и любые OpenAI-совместимые API.'
  }
};

const SETTINGS_KEY = 'chara_translator_settings';

export const DEFAULT_SETTINGS = {
  provider: 'nanogpt',
  baseUrl: PROVIDER_PRESETS.nanogpt.baseUrl,
  apiKey: '',
  model: PROVIDER_PRESETS.nanogpt.defaultModel,
  temperature: 0.3,
  maxTokens: 8192,
  stream: true,
  translateTags: true,
  extraInstructions: ''
};

/**
 * Loads saved translator settings from localStorage
 */
export function loadSettings() {
  try {
    const saved = localStorage.getItem(SETTINGS_KEY);
    if (saved) {
      const parsed = JSON.parse(saved);
      // The old free-form "systemPrompt" setting is superseded by built-in prompts + extraInstructions
      delete parsed.systemPrompt;
      delete parsed.targetLang;
      return { ...DEFAULT_SETTINGS, ...parsed };
    }
  } catch (e) {
    console.warn('Failed to read settings from localStorage', e);
  }
  return { ...DEFAULT_SETTINGS };
}

/**
 * Saves translator settings to localStorage
 */
export function saveSettings(settings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch (e) {
    console.error('Failed to save settings to localStorage', e);
  }
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

export class LlmError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.name = 'LlmError';
    this.status = status;
  }
}

const LOCAL_HOSTNAMES = ['127.0.0.1', 'localhost', '::1', '[::1]'];

function isServedByLocalProxy() {
  return typeof window !== 'undefined' &&
    window.location.protocol.startsWith('http') &&
    LOCAL_HOSTNAMES.includes(window.location.hostname);
}

function proxyUrl(targetUrl) {
  return `/api-proxy?target=${encodeURIComponent(targetUrl)}`;
}

/**
 * Local servers and OpenRouter (which sends CORS headers) are called directly,
 * everything else goes through the run.py proxy when it is available.
 */
function shouldUseProxy(targetUrl) {
  if (!isServedByLocalProxy()) return false;
  let host;
  try {
    host = new URL(targetUrl).hostname;
  } catch {
    return false;
  }
  if (LOCAL_HOSTNAMES.includes(host)) return false;
  return !host.endsWith('openrouter.ai');
}

function isNetworkError(err) {
  return err?.name === 'TypeError' || /Failed to fetch|NetworkError|network error|Load failed/i.test(err?.message || '');
}

async function fetchWithProxyFallback(targetUrl, init) {
  const useProxy = shouldUseProxy(targetUrl);
  try {
    return await fetch(useProxy ? proxyUrl(targetUrl) : targetUrl, init);
  } catch (err) {
    if (init.signal?.aborted) throw err;
    if (!useProxy && isServedByLocalProxy() && isNetworkError(err)) {
      console.warn(`Direct request to ${targetUrl} failed (${err.message}). Retrying via /api-proxy...`);
      return fetch(proxyUrl(targetUrl), init);
    }
    if (isNetworkError(err)) {
      throw new LlmError(isServedByLocalProxy()
        ? `Не удалось подключиться к ${targetUrl}. Проверьте адрес эндпоинта и что сервер запущен.`
        : 'Сетевая ошибка или блокировка CORS. Запустите приложение через start.bat / run.py — он включает прокси для API.');
    }
    throw err;
  }
}

function buildHeaders(settings) {
  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream'
  };
  const key = (settings.apiKey || '').trim();
  if (key) {
    headers['Authorization'] = `Bearer ${key}`;
    headers['x-api-key'] = key;
  }
  if (settings.provider === 'openrouter') {
    headers['HTTP-Referer'] = (typeof window !== 'undefined' && window.location.origin) || 'http://localhost';
    headers['X-Title'] = 'AI Character Card Translator';
  }
  return headers;
}

function ensureApiKey(settings) {
  const preset = PROVIDER_PRESETS[settings.provider];
  if (preset?.needsKey && !(settings.apiKey || '').trim()) {
    throw new LlmError(`API-ключ не задан. Откройте «Настройки API» и вставьте ключ ${preset.name}.`);
  }
}

function extractErrorMessage(text) {
  try {
    const json = JSON.parse(text);
    const err = json.error;
    if (typeof err === 'string') return err;
    return err?.message || json.message || json.detail || text;
  } catch {
    return text;
  }
}

function numberOr(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Fetches models list from the configured endpoint
 */
export async function fetchAvailableModels(baseUrl, apiKey, provider, signal = null) {
  const url = `${baseUrl.replace(/\/+$/, '')}/models`;
  let response;
  try {
    response = await fetchWithProxyFallback(url, {
      method: 'GET',
      headers: buildHeaders({ apiKey, provider }),
      signal
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error('Таймаут запроса моделей (10 сек). Выберите модель из списка или введите вручную.');
    }
    throw err;
  }

  const text = await response.text();
  if (!response.ok) {
    throw new LlmError(`Ошибка API (${response.status}): ${extractErrorMessage(text).slice(0, 200)}`, response.status);
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new LlmError('Эндпоинт вернул не JSON на запрос /models');
  }
  const list = Array.isArray(data.data) ? data.data : (Array.isArray(data) ? data : (Array.isArray(data.models) ? data.models : []));
  return list
    .map(m => (typeof m === 'string' ? { id: m, name: m } : { id: m.id || m.name, name: m.name || m.id }))
    .filter(m => m.id)
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

/**
 * Reads an OpenAI-style SSE stream, accumulating content/reasoning deltas.
 */
async function readEventStream(response, onDelta) {
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  let content = '';
  let reasoning = '';
  let finishReason = null;

  const handleLine = (rawLine) => {
    const line = rawLine.trim();
    if (!line.startsWith('data:')) return;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') return;
    let json;
    try {
      json = JSON.parse(payload);
    } catch {
      return;
    }
    if (json.error) {
      throw new LlmError(`Ошибка API: ${json.error.message || JSON.stringify(json.error)}`);
    }
    const choice = json.choices?.[0];
    if (!choice) return;
    const delta = choice.delta || choice.message || {};
    if (delta.content) {
      content += delta.content;
      onDelta?.(content);
    }
    const r = delta.reasoning_content || delta.reasoning;
    if (typeof r === 'string') reasoning += r;
    if (choice.finish_reason) finishReason = choice.finish_reason;
  };

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      handleLine(buffer.slice(0, nl));
      buffer = buffer.slice(nl + 1);
    }
  }
  if (buffer) handleLine(buffer);
  return { content, reasoning, finishReason };
}

/**
 * Single chat completion request. Streams when enabled (keeps long requests alive and gives progress).
 * Returns { content, finishReason, truncated }.
 */
export async function chatCompletion({ settings, messages, temperature, maxTokens, signal = null, onDelta = null }) {
  ensureApiKey(settings);
  const endpoint = `${settings.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const stream = settings.stream !== false;
  const requestBody = {
    model: settings.model || PROVIDER_PRESETS[settings.provider]?.defaultModel || 'deepseek/deepseek-chat',
    messages,
    temperature: numberOr(temperature, numberOr(settings.temperature, 0.3)),
    max_tokens: Math.max(256, Math.round(numberOr(maxTokens, numberOr(settings.maxTokens, 8192)))),
    stream
  };

  const response = await fetchWithProxyFallback(endpoint, {
    method: 'POST',
    headers: buildHeaders(settings),
    body: JSON.stringify(requestBody),
    signal
  });

  if (!response.ok) {
    const text = await response.text();
    throw new LlmError(`Ошибка API (${response.status}): ${extractErrorMessage(text).slice(0, 400) || response.statusText}`, response.status);
  }

  let content = '';
  let reasoning = '';
  let finishReason = null;
  const contentType = response.headers.get('content-type') || '';

  if (contentType.includes('text/event-stream') && response.body) {
    ({ content, reasoning, finishReason } = await readEventStream(response, onDelta));
  } else {
    const text = await response.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new LlmError(`Ошибка разбора ответа (${response.status}): ${text.slice(0, 200)}`);
    }
    if (json.error) {
      throw new LlmError(`Ошибка API: ${json.error.message || JSON.stringify(json.error)}`);
    }
    const choice = json.choices?.[0];
    content = choice?.message?.content ?? choice?.text ?? '';
    reasoning = choice?.message?.reasoning_content || choice?.message?.reasoning || '';
    finishReason = choice?.finish_reason || null;
    onDelta?.(content);
  }

  const cleaned = cleanModelPreamble(content);
  if (!cleaned && reasoning) {
    throw new LlmError('Модель вернула только рассуждения без ответа — скорее всего, не хватило Max Tokens. Увеличьте лимит в настройках или выберите модель без reasoning.');
  }
  return { content: cleaned, finishReason, truncated: finishReason === 'length' };
}

// ---------------------------------------------------------------------------
// Text post-processing
// ---------------------------------------------------------------------------

/**
 * Strips reasoning (<think>...</think>), code block fences, and introductory boilerplate
 */
export function cleanModelPreamble(text) {
  if (!text || typeof text !== 'string') return '';
  let res = text.trim();

  // Strip reasoning blocks from reasoning models (e.g. DeepSeek R1) including truncated blocks
  res = res.replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, '').trim();

  // Remove common conversational chat openers before code fence
  const chatOpener = /^(?:(?:Конечно|Разумеется)[!,.]?\s*)?(?:Вот\s+(?:готовый\s+)?перевод(?:\s+(?:текста|поля|карточки|сообщения))?|Перевод(?:\s+(?:текста|поля|карточки|сообщения))?|Here\s+(?:is|are)\s+(?:the\s+)?(?:translation|translated\s+(?:text|card|fields))|Here\x27s\s+the\s+translation)(?::|;|\.|\!)?\s*\n+/i;
  res = res.replace(chatOpener, '').trim();

  // Strip wrapping markdown code blocks (```xml ... ``` or ```json ... ``` or plain ``` ... ```)
  const codeBlockMatch = res.match(/^```(?:[a-zA-Z0-9_-]+)?\s*\n?([\s\S]*?)\n?```$/);
  if (codeBlockMatch) {
    res = codeBlockMatch[1].trim();
  } else {
    // Also remove unclosed opening or trailing code fence if truncated
    res = res.replace(/^```(?:[a-zA-Z0-9_-]+)?\s*\n?/i, '').trim();
    res = res.replace(/\n?```\s*$/, '').trim();
  }

  return res.replace(chatOpener, '').trim();
}

/**
 * Repairs macros that models tend to translate or mangle: {{персонаж}} → {{char}}, {user} → {{user}}, [START] → <START>
 */
export function repairMacrosAndTags(text) {
  if (!text || typeof text !== 'string') return '';
  let res = text;

  res = res.replace(/\{{1,3}\s*(?:char|персонаж(?:а|у|ем|е)?|бот(?:а|у|ом|е)?)\s*\}{1,3}/gi, '{{char}}');
  res = res.replace(/\{{1,3}\s*(?:user|sub|obj|пользовател(?:ь|я|ю|ем|е)|юзер(?:а|у|ом|е)?|игрок(?:а|у|ом|е)?)\s*\}{1,3}/gi, '{{user}}');
  res = res.replace(/\{{1,3}\s*(?:persona|персона)\s*\}{1,3}/gi, '{{persona}}');
  res = res.replace(/\{{1,3}\s*(?:original|оригинал)\s*\}{1,3}/gi, '{{original}}');
  res = res.replace(/(?:\[\s*START\s*\]|<\s*start\s*>|\[\s*старт\s*\]|<\s*старт\s*>)/gi, '<START>');

  return res;
}

function countAsterisks(text) {
  // Ignore scene breaks (*** / * * *) and list bullets (* item)
  const cleaned = String(text || '')
    .replace(/^\s*(?:\*\s*){3,}\s*$/gm, '')
    .replace(/^\s*\*\s+/gm, '');
  return (cleaned.match(/\*/g) || []).length;
}

function countMacros(text) {
  const counts = new Map();
  for (const m of String(text || '').matchAll(/\{\{\s*([^{}]+?)\s*\}\}|<START>/gi)) {
    const key = m[1] ? `{{${m[1].toLowerCase()}}}` : '<START>';
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

/**
 * Compares a translation with its source and returns human-readable warnings
 * (lost macros, unpaired asterisks, suspiciously short output). Never modifies the text.
 */
export function checkFormatting(original, translated) {
  const warnings = [];
  const src = String(original || '');
  const dst = String(translated || '');
  if (!src.trim()) return warnings;
  if (!dst.trim()) return ['Перевод пустой'];

  const srcMacros = countMacros(src);
  const dstMacros = countMacros(dst);
  for (const [macro, n] of srcMacros) {
    const m = dstMacros.get(macro) || 0;
    if (m < n) warnings.push(`${macro}: было ${n}, стало ${m}`);
  }

  if (countAsterisks(src) % 2 === 0 && countAsterisks(dst) % 2 === 1) {
    warnings.push('Непарная звёздочка *');
  }

  if (src.length > 200 && dst.length < src.length * 0.45) {
    warnings.push('Перевод подозрительно короткий — возможно, обрезан');
  }
  return warnings;
}

/**
 * Backward-compatible no-op balance check: returns the text unchanged.
 * Appending asterisks blindly corrupted valid markdown (**bold**), so this is now reported by checkFormatting instead.
 */
export function balanceAsterisks(text) {
  return typeof text === 'string' ? text : '';
}

/**
 * Extracts <field id="...">...</field> blocks from a model response.
 * A block without a closing tag runs until the next <field or the end; it is reported in `unclosed`.
 */
export function extractTaggedFields(text) {
  const fields = {};
  const unclosed = [];
  if (!text || typeof text !== 'string') return { fields, unclosed };

  const openRe = /<field\s+[^>]*?id\s*=\s*["']([^"']+)["'][^>]*>/gi;
  const opens = [];
  let m;
  while ((m = openRe.exec(text)) !== null) {
    opens.push({ id: m[1].trim(), start: m.index, contentStart: openRe.lastIndex });
  }

  for (let i = 0; i < opens.length; i++) {
    const { id, contentStart } = opens[i];
    const nextOpen = i + 1 < opens.length ? opens[i + 1].start : text.length;
    const segment = text.slice(contentStart, nextOpen);
    const closeIdx = segment.search(/<\/field\s*>/i);
    let content;
    if (closeIdx >= 0) {
      content = segment.slice(0, closeIdx);
    } else {
      content = segment;
      unclosed.push(id);
    }
    content = content.replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/i, '$1');
    // Trim only the newlines added around the block, keep inner formatting
    content = content.replace(/^\s*\n/, '').replace(/\n\s*$/, '').trim();
    if (fields[id] === undefined) fields[id] = content;
  }
  return { fields, unclosed };
}

/**
 * Legacy helper: parses <tag>...</tag> pairs (used by older tests / tools)
 */
export function parseXmlFields(responseText) {
  const result = {};
  if (!responseText || typeof responseText !== 'string') return result;
  const tagRegex = /<([a-zA-Z0-9_-]+)(?:\s+[^>]*)?>([\s\S]*?)<\/\1>/gi;
  let match;
  while ((match = tagRegex.exec(responseText)) !== null) {
    const normTag = match[1].toLowerCase().replace(/-/g, '_');
    if (result[normTag] === undefined) result[normTag] = match[2].trim();
  }
  return result;
}

// ---------------------------------------------------------------------------
// Translation units
// ---------------------------------------------------------------------------

function keysToText(keys) {
  if (Array.isArray(keys)) return keys.map(k => String(k).trim()).filter(Boolean).join('\n');
  if (typeof keys === 'string') return keys.split(/[\n,;]+/).map(k => k.trim()).filter(Boolean).join('\n');
  return '';
}

function splitList(text) {
  return String(text || '').split(/[\n,;]+/).map(k => k.trim()).filter(Boolean);
}

/**
 * Turns card data into a flat list of translatable units with stable ids.
 */
export function buildTranslationUnits(data, { translateTags = true } = {}) {
  const units = [];
  const push = (id, type, label, text) => {
    if (text && String(text).trim()) units.push({ id, type, label, text: String(text) });
  };

  for (const f of TEXT_FIELDS) {
    push(`field:${f.key}`, f.key === 'name' ? 'name' : 'text', f.label, data[f.key]);
  }
  (data.alternate_greetings || []).forEach((g, i) => push(`greeting:${i}`, 'text', `Альтернативное приветствие #${i + 1}`, g));
  (data.group_only_greetings || []).forEach((g, i) => push(`group_greeting:${i}`, 'text', `Групповое приветствие #${i + 1}`, g));
  if (translateTags && Array.isArray(data.tags) && data.tags.length) {
    push('tags', 'list', 'Теги', data.tags.join('\n'));
  }

  const book = data.character_book;
  if (book) {
    push('lore_name', 'text', 'Название лорбука', book.name);
    push('lore_desc', 'text', 'Описание лорбука', book.description);
    (book.entries || []).forEach((e, i) => {
      if (!e) return;
      push(`entry:${i}:comment`, 'text', `Лорбук #${i + 1}: название`, e.comment);
      push(`entry:${i}:keys`, 'keys', `Лорбук #${i + 1}: ключи`, keysToText(e.keys));
      push(`entry:${i}:secondary_keys`, 'keys', `Лорбук #${i + 1}: доп. ключи`, keysToText(e.secondary_keys));
      push(`entry:${i}:content`, 'text', `Лорбук #${i + 1}: содержание`, e.content);
    });
  }
  return units;
}

/**
 * Returns the source text a unit id points to (used for QA checks in the UI).
 */
export function getUnitSource(data, id) {
  return buildTranslationUnits(data, { translateTags: true }).find(u => u.id === id)?.text || '';
}

function estimateTokens(text) {
  return countStats(text).estimatedTokens;
}

/**
 * Packs units into batches so that the expected output fits into maxTokens.
 * Russian output is ~1.5–2x the English token count, so input per batch is capped at ~35% of maxTokens.
 */
export function packBatches(units, maxTokens = 8192) {
  const budget = Math.max(400, Math.min(6000, Math.floor(maxTokens * 0.35)));
  const MAX_UNITS = 16;
  const batches = [];
  let current = [];
  let used = 0;
  for (const unit of units) {
    const cost = estimateTokens(unit.text) + 12;
    if (current.length && (used + cost > budget || current.length >= MAX_UNITS)) {
      batches.push(current);
      current = [];
      used = 0;
    }
    current.push(unit);
    used += cost;
  }
  if (current.length) batches.push(current);
  return batches;
}

function formatGlossary(map) {
  const entries = Object.entries(map || {}).filter(([k, v]) => k && v);
  return entries.length ? entries.map(([en, ru]) => `  - ${en} → ${ru}`).join('\n') : '  (нет)';
}

export function buildTranslatorSystemPrompt(passport, settings = {}) {
  const p = passport || {};
  const extra = (settings.extraInstructions || '').trim();
  return `Ты — профессиональный литературный переводчик карточек персонажей для ролевых чатов (SillyTavern, Chub, JanitorAI).
Переведи на русский язык содержимое каждого блока <field id="...">.

=== ПАСПОРТ ПЕРСОНАЖА (соблюдай строго) ===
- Имя на русском: ${p.character_name_ru || 'транслитерируй исходное имя'}
- Пол: ${p.gender || 'определи по тексту'}
- Род глаголов персонажа: ${p.verb_gender || 'определи по тексту'}
- Обращение персонажа к {{user}}: «${p.user_pronoun || 'ты'}»
- Тон и манера речи: ${p.speech_tone || 'как в оригинале'}
- Глоссарий (используй именно эти переводы):
${formatGlossary(p.glossary)}

=== ПРАВИЛА ===
1. Макросы копируй без изменений: {{char}}, {{user}}, {{original}}, {{persona}} и любые другие {{...}}, а также <START>. Не заменяй {{char}} и {{user}} именами. {{sub}} и {{obj}} замени на {{user}}.
2. HTML/XML-теги, их имена и атрибуты не переводи — переводи только текст внутри. Сохраняй синтаксис W++, JSON-подобных списков, [квадратных скобок], markdown.
3. Действия в *звёздочках* остаются в звёздочках, прямая речь — в кавычках. Сохраняй абзацы, пустые строки и переносы.
4. Пиши живым литературным русским языком без калек, передавай характер и стиль речи.
5. Блоки type="keys" — ключевые слова лорбука: по одному ключу на строку, короткие формы, которые реально встретятся в чате (можно несколько словоформ). Без пояснений.
6. Блок type="list" — теги: по одному на строку, коротко.
7. Блок type="name" — только имя, без пояснений.
${extra ? `\n=== ДОПОЛНИТЕЛЬНЫЕ ПОЖЕЛАНИЯ ПОЛЬЗОВАТЕЛЯ ===\n${extra}\n` : ''}
=== ФОРМАТ ОТВЕТА ===
Верни ровно те же блоки с теми же id: <field id="...">перевод</field>, по одному на каждый входной блок, в том же порядке.
Никакого текста вне блоков, никакого markdown-оформления ответа.`;
}

function buildBatchUserMessage(batch) {
  return batch
    .map(u => `<field id="${u.id}" type="${u.type}">\n${u.text}\n</field>`)
    .join('\n\n');
}

/**
 * Translates units in token-sized batches. Missing/truncated units are retried individually once.
 * Never throws for partial failures — they are returned in `failed`.
 * onProgress({ done, total, message, streamedChars, batchIndex, batchCount }) is called as work proceeds.
 */
export async function translateUnits({ units, passport = null, settings, signal = null, onProgress = null, onUnitDone = null }) {
  const results = {};
  const failed = {};
  const total = units.length;
  if (!total) return { results, failed: [] };

  const systemPrompt = buildTranslatorSystemPrompt(passport, settings);
  const maxTokens = numberOr(settings.maxTokens, 8192);
  const queue = packBatches(units, maxTokens);
  const retried = new Set();
  let batchIndex = 0;
  let consecutiveErrors = 0;

  const report = (message, streamedChars = 0) => onProgress?.({
    done: Object.keys(results).length,
    total,
    message,
    streamedChars,
    batchIndex,
    batchCount: queue.length
  });

  while (queue.length > batchIndex) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const batch = queue[batchIndex];
    batchIndex++;
    const label = batch.length === 1 ? batch[0].label : `${batch.length} полей`;
    report(`Запрос ${batchIndex}/${queue.length}: ${label}`);

    let response;
    try {
      response = await chatCompletion({
        settings,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: buildBatchUserMessage(batch) }
        ],
        maxTokens,
        signal,
        onDelta: (text) => report(`Запрос ${batchIndex}/${queue.length}: ${label}`, text.length)
      });
      consecutiveErrors = 0;
    } catch (err) {
      if (err.name === 'AbortError' || signal?.aborted) throw err;
      const nothingDoneYet = Object.keys(results).length === 0;
      // Configuration problems (bad key, wrong model, wrong URL) will fail every request — stop right away
      if (nothingDoneYet && [400, 401, 402, 403, 404].includes(err.status)) throw err;
      consecutiveErrors++;
      for (const u of batch) failed[u.id] = err.message;
      if (consecutiveErrors >= 3) {
        for (const rest of queue.slice(batchIndex).flat()) failed[rest.id] = 'Пропущено после трёх ошибок подряд';
        break;
      }
      continue;
    }

    const { fields, unclosed } = extractTaggedFields(response.content);
    const missing = [];
    for (const u of batch) {
      const value = fields[u.id];
      const isPartial = unclosed.includes(u.id) && response.truncated;
      if (value === undefined || !value.trim() || isPartial) {
        missing.push(u);
        continue;
      }
      results[u.id] = postProcess(u, value);
      delete failed[u.id];
      onUnitDone?.(u.id, results[u.id]);
    }

    // A single-field batch with an answer but no tags: accept the whole answer
    if (batch.length === 1 && missing.length === 1 && !Object.keys(fields).length && response.content.trim() && !response.truncated) {
      const u = batch[0];
      results[u.id] = postProcess(u, response.content);
      onUnitDone?.(u.id, results[u.id]);
      missing.length = 0;
    }

    for (const u of missing) {
      if (!retried.has(u.id) && batch.length > 1) {
        retried.add(u.id);
        queue.push([u]);
      } else {
        failed[u.id] = response.truncated
          ? `Ответ обрезан лимитом Max Tokens (${maxTokens}). Увеличьте лимит в настройках.`
          : 'Модель не вернула перевод этого поля';
      }
    }
  }

  report('Готово');
  return {
    results,
    failed: Object.entries(failed).map(([id, reason]) => ({ id, reason, label: units.find(u => u.id === id)?.label || id }))
  };
}

function postProcess(unit, value) {
  if (unit.type === 'keys' || unit.type === 'list') return splitList(value).join('\n');
  if (unit.type === 'name') return value.split('\n')[0].trim();
  return repairMacrosAndTags(value);
}

/**
 * Writes translated unit values into a copy of `targetData` (or into targetData itself with inPlace).
 * `sourceData` is the original card data (needed for additive lorebook keys).
 */
export function applyTranslations(targetData, results, sourceData, passport = null, { inPlace = false } = {}) {
  const data = inPlace ? targetData : JSON.parse(JSON.stringify(targetData));
  const lorebookKeyMap = passport?.lorebook_keys || {};

  for (const [id, value] of Object.entries(results)) {
    const parts = id.split(':');
    if (parts[0] === 'field') {
      data[parts[1]] = value;
    } else if (parts[0] === 'greeting' || parts[0] === 'group_greeting') {
      const listKey = parts[0] === 'greeting' ? 'alternate_greetings' : 'group_only_greetings';
      const idx = Number(parts[1]);
      if (!Array.isArray(data[listKey])) data[listKey] = [...(sourceData[listKey] || [])];
      data[listKey][idx] = value;
    } else if (id === 'tags') {
      data.tags = splitList(value);
    } else if (id === 'lore_name' || id === 'lore_desc') {
      if (!data.character_book) data.character_book = JSON.parse(JSON.stringify(sourceData.character_book || { entries: [] }));
      data.character_book[id === 'lore_name' ? 'name' : 'description'] = value;
    } else if (parts[0] === 'entry') {
      const idx = Number(parts[1]);
      const prop = parts[2];
      if (!data.character_book) data.character_book = JSON.parse(JSON.stringify(sourceData.character_book || { entries: [] }));
      const entry = data.character_book.entries?.[idx];
      if (!entry) continue;
      if (prop === 'keys' || prop === 'secondary_keys') {
        // Additive: keep original keys so the lorebook still triggers on English text
        const srcEntry = sourceData.character_book?.entries?.[idx] || {};
        const original = splitList(keysToText(srcEntry[prop]));
        const fromPassport = prop === 'keys'
          ? original.flatMap(k => splitList(lorebookKeyMap[k] || lorebookKeyMap[k.toLowerCase()] || ''))
          : [];
        entry[prop] = [...new Set([...original, ...splitList(value), ...fromPassport])];
      } else {
        entry[prop] = value;
      }
    }
  }
  return data;
}

// ---------------------------------------------------------------------------
// Step 1: passport
// ---------------------------------------------------------------------------

export const DEFAULT_PASSPORT = {
  character_name_ru: '',
  gender: '',
  verb_gender: '',
  user_pronoun: 'ты',
  speech_tone: '',
  glossary: {},
  lorebook_keys: {}
};

function sanitizeStringMap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (k && v !== null && v !== undefined && String(v).trim()) out[String(k).trim()] = String(v).trim();
  }
  return out;
}

/**
 * Step 1: Context & Glossary Pass
 * Analyzes the card to create a context passport (gender, pronoun, verb gender, speech tone, glossary, lorebook keys).
 */
export async function analyzeCardContext({ cardData, settings, signal = null, onDelta = null }) {
  const sampleParts = [];
  if (cardData.name) sampleParts.push(`Character Name: ${cardData.name}`);
  if (cardData.description) sampleParts.push(`Description:\n${cardData.description.slice(0, 3000)}`);
  if (cardData.personality) sampleParts.push(`Personality:\n${cardData.personality.slice(0, 1000)}`);
  if (cardData.scenario) sampleParts.push(`Scenario:\n${cardData.scenario.slice(0, 1000)}`);
  if (cardData.first_mes) sampleParts.push(`First Message:\n${cardData.first_mes.slice(0, 2000)}`);
  if (cardData.mes_example) sampleParts.push(`Dialogue examples:\n${cardData.mes_example.slice(0, 1000)}`);

  const book = cardData.character_book;
  if (book) {
    if (book.name) sampleParts.push(`Lorebook Name: ${book.name}`);
    const allKeys = (book.entries || []).flatMap(e => splitList(keysToText(e?.keys)));
    const uniqueKeys = [...new Set(allKeys)].slice(0, 60);
    if (uniqueKeys.length) sampleParts.push(`Lorebook Trigger Keys: ${JSON.stringify(uniqueKeys)}`);
  }

  const systemPrompt = `Ты — аналитик карточек персонажей для ролевых чатов. Проанализируй карточку и составь паспорт для переводчика на русский язык.

Верни ТОЛЬКО валидный JSON:
{
  "character_name_ru": "Русское имя или транслитерация (например: Серафина Вейл)",
  "gender": "женский | мужской | иной",
  "verb_gender": "она сделала | он сделал | оно сделало | они сделали",
  "user_pronoun": "ты | вы — как персонаж обращается к {{user}} (по дистанции, статусу и характеру)",
  "speech_tone": "Краткое описание манеры речи (например: саркастичная, холодная, архаичная)",
  "glossary": { "English term": "Русский перевод" },
  "lorebook_keys": { "english key": "русский ключ" }
}

Правила:
1. В glossary — имена собственные, локации, титулы, фракции, артефакты, уникальные понятия.
2. В lorebook_keys — переводы триггерных ключей лорбука, если они даны; иначе {}.
3. Никакого текста вне JSON.`;

  try {
    const { content } = await chatCompletion({
      settings,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: sampleParts.join('\n\n') }
      ],
      temperature: 0.1,
      maxTokens: Math.max(2000, Math.min(numberOr(settings.maxTokens, 8192), 4000)),
      signal,
      onDelta
    });

    const jsonMatch = content.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : content);
    return {
      character_name_ru: String(parsed.character_name_ru || cardData.name || ''),
      gender: String(parsed.gender || ''),
      verb_gender: String(parsed.verb_gender || ''),
      user_pronoun: String(parsed.user_pronoun).trim().toLowerCase() === 'вы' ? 'вы' : 'ты',
      speech_tone: String(parsed.speech_tone || ''),
      glossary: sanitizeStringMap(parsed.glossary),
      lorebook_keys: sanitizeStringMap(parsed.lorebook_keys)
    };
  } catch (err) {
    if (err.name === 'AbortError' || signal?.aborted) throw err;
    // Configuration problems surface immediately instead of being hidden behind a fallback passport
    if (err instanceof LlmError && err.status) throw err;
    console.warn('Step 1 passport analysis failed, proceeding with fallback passport:', err);
    return { ...DEFAULT_PASSPORT, character_name_ru: cardData.name || '', failed: true };
  }
}

// ---------------------------------------------------------------------------
// Assistant
// ---------------------------------------------------------------------------

/**
 * Asks AI a question about the character card or requests an explanation/analysis.
 */
export async function askCharacterAI({ cardData, question, settings, signal = null, onDelta = null }) {
  if (!question || !question.trim()) {
    throw new Error('Вопрос не может быть пустым.');
  }

  const parts = [];
  for (const f of TEXT_FIELDS) {
    if (cardData[f.key]) parts.push(`${f.label}:\n${cardData[f.key]}`);
  }
  if (cardData.alternate_greetings?.length) {
    parts.push(`Альтернативные приветствия (${cardData.alternate_greetings.length}):\n${cardData.alternate_greetings.join('\n---\n')}`);
  }
  const entries = cardData.character_book?.entries || [];
  if (entries.length) {
    const sample = entries.slice(0, 15)
      .map(e => `[${e.comment || 'Запись'}: ${keysToText(e.keys).replace(/\n/g, ', ')}] ${e.content || ''}`)
      .join('\n');
    parts.push(`Лорбук (${entries.length} записей):\n${sample}`);
  }

  const systemPrompt = `Ты — эксперт по карточкам персонажей для ролевых чатов (SillyTavern, Chub, TavernAI).
Внимательно проанализируй карточку и дай глубокий, структурированный ответ на вопрос пользователя.
Отвечай на русском, используй абзацы и списки. Сохраняй макросы {{char}} и {{user}} в объяснениях.`;

  const { content } = await chatCompletion({
    settings,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `ДАННЫЕ КАРТОЧКИ:\n\n${parts.join('\n\n====================\n\n')}\n\nВОПРОС:\n${question.trim()}` }
    ],
    temperature: 0.4,
    signal,
    onDelta
  });
  return content;
}

export const TRANSFORM_FIELDS = ['name', 'description', 'personality', 'scenario', 'first_mes', 'mes_example', 'system_prompt'];

/**
 * Modifies/adapts a character card according to a creative user instruction.
 * Returns { modifiedFields, changesSummary }.
 */
export async function transformCharacterAI({ cardData, instruction, settings, signal = null, onDelta = null }) {
  if (!instruction || !instruction.trim()) {
    throw new Error('Инструкция по изменению не может быть пустой.');
  }

  const payload = TRANSFORM_FIELDS
    .filter(f => cardData[f] && String(cardData[f]).trim())
    .map(f => `<field id="${f}">\n${cardData[f]}\n</field>`)
    .join('\n\n');

  const systemPrompt = `Ты — писатель и геймдизайнер ролевых карточек для SillyTavern / Chub.
Творчески переработай карточку персонажа СТРОГО по задаче пользователя.

ПРАВИЛА:
1. Сохраняй макросы {{char}}, {{user}}, {{original}}, <START> — не заменяй их именами.
2. Действия в *звёздочках*, прямая речь в кавычках, <START> на отдельных строках.
3. Живой литературный язык, атмосферность, психологическая глубина.

ФОРМАТ ОТВЕТА:
- Верни только изменённые поля в виде <field id="...">новый текст</field> с теми же id, что во входных данных.
- Обязательно добавь <field id="changes_summary">2–4 пункта: что изменено</field>.
- Никакого текста вне блоков.`;

  const { content } = await chatCompletion({
    settings,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `ТЕКУЩИЕ ПОЛЯ КАРТОЧКИ:\n\n${payload}\n\nЗАДАЧА:\n${instruction.trim()}` }
    ],
    temperature: 0.6,
    signal,
    onDelta
  });

  const { fields } = extractTaggedFields(content);
  const modifiedFields = {};
  for (const f of TRANSFORM_FIELDS) {
    if (fields[f] && fields[f].trim()) {
      modifiedFields[f] = f === 'name' ? fields[f].split('\n')[0].trim() : repairMacrosAndTags(fields[f]);
    }
  }
  if (!Object.keys(modifiedFields).length) {
    throw new LlmError('Модель не вернула ни одного изменённого поля. Попробуйте переформулировать задачу или выбрать другую модель.');
  }

  return {
    modifiedFields,
    changesSummary: repairMacrosAndTags(fields.changes_summary || 'Изменения внесены в соответствии с задачей.')
  };
}
