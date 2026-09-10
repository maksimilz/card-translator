/**
 * Translator Module
 * Connects to Nano-GPT, OpenRouter, Ollama, LM Studio, and generic OpenAI-compatible endpoints.
 * Tailored specifically for AI Character Cards (preserves {{char}}, {{user}}, <START>, markdown, slang).
 * Includes auto-proxy routing to bypass CORS for Nano-GPT and third-party APIs.
 * Supports both full-card context-aware translation in 1 request and single field translation.
 */

export const DEFAULT_PROMPT_RU = `Ты — профессиональный литературный переводчик и эксперт по карточкам персонажей для текстовых ролевых игр (SillyTavern, Chub, TavernAI).
Твоя задача — качественно, выразительно и стилистически точно перевести текст карточки персонажа на русский язык с сохранением контекста роли.

КРИТИЧЕСКИ ВАЖНЫЕ ПРАВИЛА:
1. СОХРАНЯЙ ВСЕ МАКРОСЫ И ПЕРЕМЕННЫЕ БЕЗ ИЗМЕНЕНИЙ:
   - {{char}}, {{user}}, {{original}}, <START>, <USER>, <BOT>, XML-теги вроде <guidelines>, <personality> НЕЛЬЗЯ переводить или менять регистр!
   - Не заменяй {{char}} на имя персонажа! Оставляй именно {{char}} и {{user}}!
2. СОХРАНЯЙ СТРУКТУРУ И ФОРМАТИРОВАНИЕ:
   - Действия в звездочках *действие* должны оставаться в звездочках *действие*.
   - Прямая речь в кавычках должна оставаться в кавычках.
   - Разделители реплик <START> должны оставаться строго на своих строках.
   - Сохраняй абзацы, переносы строк, списки, квадратные скобки [Scenario: ...], W++ атрибуты если есть.
3. ПЕРЕДАЧА СТИЛЯ И ХАРАКТЕРА:
   - Учитывай пол персонажа, возраст, манеру речи и характер. Используй правильные окончания глаголов (мужской/женский род).
   - Живой литературный русский язык без англицизмов-калек, естественные диалоги.
4. ФОРМАТ ОТВЕТА:
   - Выводи ТОЛЬКО готовый переведенный текст.
   - НИКАКИХ предисловий, пояснений, кавычек вокруг всего ответа или фраз вроде "Вот перевод:".`;

export const PROVIDER_PRESETS = {
  nanogpt: {
    id: 'nanogpt',
    name: 'Nano-GPT (nano-gpt.com)',
    baseUrl: 'https://nano-gpt.com/api/v1',
    defaultModel: 'deepseek/deepseek-v4.1-flash',
    popularModels: [
      { id: 'deepseek/deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash (Сверхбыстрый)' },
      { id: 'deepseek/deepseek-chat', name: 'DeepSeek V3 (Рекомендуется)' },
      { id: 'deepseek/deepseek-r1', name: 'DeepSeek R1 (Рассуждающий)' },
      { id: 'gpt-4o-mini', name: 'GPT-4o Mini' },
      { id: 'chatgpt-4o-latest', name: 'GPT-4o' },
      { id: 'claude-3-5-sonnet-20241022', name: 'Claude 3.5 Sonnet' },
      { id: 'meta-llama/llama-3.3-70b-instruct', name: 'Llama 3.3 70B' },
      { id: 'qwen/qwen-2.5-72b-instruct', name: 'Qwen 2.5 72B' }
    ],
    needsKey: true,
    hint: 'API-ключ Nano-GPT (начинается на sk-...). Запросы автоматически идут через локальный прокси без блокировки CORS.'
  },
  openrouter: {
    id: 'openrouter',
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'deepseek/deepseek-chat',
    popularModels: [
      { id: 'deepseek/deepseek-chat', name: 'DeepSeek V3 (Быстрый & Дешевый)' },
      { id: 'deepseek/deepseek-r1', name: 'DeepSeek R1 (Рассуждающий)' },
      { id: 'anthropic/claude-3.5-sonnet', name: 'Claude 3.5 Sonnet (Высшее качество)' },
      { id: 'google/gemini-2.5-flash', name: 'Gemini 2.5 Flash (Сверхбыстрый)' },
      { id: 'meta-llama/llama-3.3-70b-instruct', name: 'Llama 3.3 70B Instruct' },
      { id: 'qwen/qwen-2.5-72b-instruct', name: 'Qwen 2.5 72B Instruct' },
      { id: 'openai/gpt-4o-mini', name: 'GPT-4o Mini' }
    ],
    needsKey: true,
    hint: 'Требуется API-ключ OpenRouter (сохраняется только в вашем браузере).'
  },
  ollama: {
    id: 'ollama',
    name: 'Ollama (Локально)',
    baseUrl: 'http://localhost:11434/v1',
    defaultModel: 'qwen2.5:latest',
    popularModels: [
      { id: 'qwen2.5:latest', name: 'Qwen 2.5 (Отличный русский язык)' },
      { id: 'llama3.1:latest', name: 'Llama 3.1' },
      { id: 'mistral:latest', name: 'Mistral' }
    ],
    needsKey: false,
    hint: 'Для работы в браузере запустите Ollama с CORS: set OLLAMA_ORIGINS=* && ollama serve'
  },
  lmstudio: {
    id: 'lmstudio',
    name: 'LM Studio (Локально)',
    baseUrl: 'http://localhost:1234/v1',
    defaultModel: '',
    popularModels: [],
    needsKey: false,
    hint: 'В LM Studio включите локальный сервер (Local Server) и переключатель Enable CORS в настройках.'
  },
  custom: {
    id: 'custom',
    name: 'Пользовательский (OpenAI-совместимый)',
    baseUrl: 'http://localhost:5001/v1',
    defaultModel: '',
    popularModels: [],
    needsKey: false,
    hint: 'Подходит для Nano-GPT, KoboldCpp, vLLM, TabbyAPI, llama.cpp server.'
  }
};

/**
 * Resolves whether a URL should go through local CORS proxy
 */
function resolveUrl(targetUrl, provider = '') {
  const isLocalServer = window.location.protocol.startsWith('http') && 
    (window.location.hostname === '127.0.0.1' ||
     window.location.hostname === 'localhost' ||
     window.location.hostname === '::1' ||
     window.location.hostname === '[::1]');

  if (!isLocalServer) return targetUrl;

  const cleanTarget = targetUrl.trim();

  // Nano-GPT and non-OpenRouter external endpoints need CORS proxy
  if (
    provider === 'nanogpt' ||
    cleanTarget.includes('nano-gpt.com') ||
    (!cleanTarget.includes('openrouter.ai') &&
     !cleanTarget.includes('localhost') &&
     !cleanTarget.includes('127.0.0.1') &&
     !cleanTarget.includes('[::1]'))
  ) {
    return `/api-proxy?target=${encodeURIComponent(cleanTarget)}`;
  }

  return cleanTarget;
}

/**
 * Loads saved translator settings from localStorage
 */
export function loadSettings() {
  const defaults = {
    provider: 'nanogpt',
    baseUrl: PROVIDER_PRESETS.nanogpt.baseUrl,
    apiKey: '',
    model: PROVIDER_PRESETS.nanogpt.defaultModel,
    targetLang: 'ru',
    systemPrompt: DEFAULT_PROMPT_RU,
    temperature: 0.3,
    maxTokens: 4096
  };

  try {
    const saved = localStorage.getItem('chara_translator_settings');
    if (saved) {
      return { ...defaults, ...JSON.parse(saved) };
    }
  } catch (e) {
    console.warn('Failed to read settings from localStorage', e);
  }
  return defaults;
}

/**
 * Saves translator settings to localStorage
 */
export function saveSettings(settings) {
  try {
    localStorage.setItem('chara_translator_settings', JSON.stringify(settings));
  } catch (e) {
    console.error('Failed to save settings to localStorage', e);
  }
}

/**
 * Fetches models list from the configured endpoint
 */
export async function fetchAvailableModels(baseUrl, apiKey, provider, signal = null) {
  const rawUrl = `${baseUrl.replace(/\/+$/, '')}/models`;
  const fetchUrl = resolveUrl(rawUrl, provider);

  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json'
  };

  if (apiKey) {
    const trimmedKey = apiKey.trim();
    headers['Authorization'] = `Bearer ${trimmedKey}`;
    headers['x-api-key'] = trimmedKey;
  }
  if (provider === 'openrouter') {
    headers['HTTP-Referer'] = window.location.origin || 'http://localhost';
    headers['X-Title'] = 'AI Character Card Translator';
  }

  try {
    const response = await fetch(fetchUrl, {
      method: 'GET',
      headers,
      signal
    });

    if (!response.ok) {
      let errText = '';
      try {
        const errJson = await response.json();
        errText = errJson.error?.message || JSON.stringify(errJson);
      } catch {
        errText = await response.text();
      }
      throw new Error(`Ошибка API (${response.status}): ${errText.slice(0, 150)}`);
    }

    const data = await response.json();
    if (Array.isArray(data.data)) {
      return data.data.map(m => ({ id: m.id, name: m.name || m.id }));
    } else if (Array.isArray(data)) {
      return data.map(m => ({ id: m.id || m.name, name: m.name || m.id }));
    }
    return [];
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error('Таймаут запроса моделей (10 сек). Выберите готовую модель из списка ниже.');
    }
    // If direct fetch failed with CORS / NetworkError, retry via proxy
    const isNetworkOrCors = err.name === 'TypeError' ||
      err.message.includes('Failed to fetch') ||
      err.message.includes('NetworkError');

    if (!fetchUrl.startsWith('/api-proxy') && isNetworkOrCors) {
      try {
        const proxyUrl = `/api-proxy?target=${encodeURIComponent(rawUrl)}`;
        const retryRes = await fetch(proxyUrl, { method: 'GET', headers, signal });
        if (retryRes.ok) {
          const d = await retryRes.json();
          if (Array.isArray(d.data)) return d.data.map(m => ({ id: m.id, name: m.name || m.id }));
          if (Array.isArray(d)) return d.map(m => ({ id: m.id || m.name, name: m.name || m.id }));
        } else {
          let errText = '';
          try {
            const errJson = await retryRes.json();
            errText = errJson.error?.message || JSON.stringify(errJson);
          } catch {
            errText = await retryRes.text();
          }
          throw new Error(`Ошибка API (${retryRes.status}): ${errText.slice(0, 150)}`);
        }
      } catch (retryErr) {
        if (retryErr.message?.startsWith('Ошибка API')) throw retryErr;
      }
    }

    let msg = err.message;
    if (msg.includes('Failed to fetch') || msg.includes('NetworkError') || err.name === 'TypeError') {
      msg = 'Не удалось подключиться к эндпоинту. Проверьте запущен ли start.bat / run.py или выберите модель из списка вручную.';
    }
    throw new Error(msg);
  }
}

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

  // Remove common introductory phrases if still present inside block
  res = res.replace(chatOpener, '').trim();

  return res;
}

/**
 * Validates and repairs corrupted macros ({{char}}, {{user}}, {{original}}) and <START> tags
 */
export function repairMacrosAndTags(text) {
  if (!text || typeof text !== 'string') return '';
  let res = text;

  // Normalize char macros: {{char}}, {char}, {{{char}}}, {{персонаж}}, {{персонажа}}, {{бот}}, {{перс}}, etc.
  res = res.replace(/\{{1,3}\s*(?:char|персонаж[а-яё]*|бот[а-яё]*|перс[а-яё]*)\s*\}{1,3}/gi, '{{char}}');
  // Normalize user macros: {{user}}, {user}, {{{user}}}, {{пользователь}}, {{пользователя}}, {{юзер}}, {{игрок}}, etc.
  res = res.replace(/\{{1,3}\s*(?:user|пользовател[а-яё]*|юзер[а-яё]*|игрок[а-яё]*)\s*\}{1,3}/gi, '{{user}}');
  // Normalize original macro: {{original}}
  res = res.replace(/\{{1,3}\s*original\s*\}{1,3}/gi, '{{original}}');

  // Normalize <START> dialogue separators: <start>, [START], <старт>, < START >, etc.
  res = res.replace(/(?:\[\s*START\s*\]|<\s*start\s*>|\[\s*старт\s*\]|<\s*старт\s*>)/gi, '<START>');

  return res;
}

/**
 * Balances action asterisks (*) so italics never leak into subsequent text.
 * Safely ignores markdown horizontal rules (***) and list bullet points (* item).
 */
export function balanceAsterisks(text) {
  if (!text || typeof text !== 'string') return '';
  
  // Exclude standalone horizontal rules (*** or * * *) and markdown list bullet points (* item)
  const cleanedForCount = text
    .replace(/^\s*(?:\*\s*){3,}\s*$/gm, '') // scene breaks / horizontal rules
    .replace(/^\s*\*\s+/gm, '');          // list bullets

  const count = (cleanedForCount.match(/\*/g) || []).length;
  if (count % 2 !== 0) {
    return text.trimEnd() + '*';
  }
  return text;
}

/**
 * Parses XML tag format (e.g. <description>...</description>)
 * Immune to unescaped quotes, apostrophes, attributes, and dialogue formatting.
 */
export function parseXmlFields(responseText) {
  const result = {};
  if (!responseText || typeof responseText !== 'string') return result;

  // Match closed tags: <tag_name [attributes]>content</tag_name>
  // Case-insensitive, supports tags with hyphens or underscores
  const tagRegex = /<([a-zA-Z0-9_-]+)(?:\s+[^>]*)?>([\s\S]*?)<\/\1>/gi;
  let match;
  let lastClosedEnd = 0;
  while ((match = tagRegex.exec(responseText)) !== null) {
    const rawTag = match[1];
    const normTag = rawTag.toLowerCase().replace('-', '_');
    let content = match[2].trim();
    // Strip CDATA wrapper if present
    const cdataMatch = content.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/i);
    if (cdataMatch) {
      content = cdataMatch[1].trim();
    }
    result[normTag] = content;
    if (result[rawTag] === undefined) {
      result[rawTag] = content;
    }
    lastClosedEnd = tagRegex.lastIndex;
  }

  // Fallback for truncated tail tag (unclosed tag at end of response)
  const remainingText = responseText.slice(lastClosedEnd).trim();
  if (remainingText) {
    const unclosedRegex = /<([a-zA-Z0-9_-]+)(?:\s+[^>]*)?>([\s\S]+)$/i;
    const unclosedMatch = remainingText.match(unclosedRegex);
    if (unclosedMatch) {
      const rawTag = unclosedMatch[1];
      const normTag = rawTag.toLowerCase().replace('-', '_');
      if (result[normTag] === undefined && !responseText.includes(`</${rawTag}>`)) {
        let content = unclosedMatch[2].trim();
        const cdataMatch = content.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/i);
        if (cdataMatch) content = cdataMatch[1].trim();
        result[normTag] = content;
        result[rawTag] = content;
      }
    }
  }

  return result;
}

/**
 * Common helper to execute chat completions with automatic CORS proxy fallback
 */
async function postChatCompletion({
  rawEndpoint,
  requestBody,
  headers,
  provider,
  signal
}) {
  const initialUrl = resolveUrl(rawEndpoint, provider);
  const isProxy = initialUrl.startsWith('/api-proxy');

  let response;
  try {
    response = await fetch(initialUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(requestBody),
      signal
    });
  } catch (err) {
    if (signal?.aborted) throw err;
    const isNetworkOrCors = err.name === 'TypeError' ||
      err.message.includes('Failed to fetch') ||
      err.message.includes('NetworkError') ||
      err.message.includes('network error');

    const isLocalServer = window.location.protocol.startsWith('http') &&
      (window.location.hostname === '127.0.0.1' ||
       window.location.hostname === 'localhost' ||
       window.location.hostname === '::1' ||
       window.location.hostname === '[::1]');

    if (!isProxy && isNetworkOrCors && isLocalServer) {
      console.warn(`Direct request to ${rawEndpoint} failed due to CORS/network (${err.message}). Retrying via /api-proxy...`);
      const proxyUrl = `/api-proxy?target=${encodeURIComponent(rawEndpoint)}`;
      response = await fetch(proxyUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody),
        signal
      });
    } else {
      throw err;
    }
  }

  const resText = await response.text();
  let resJson;
  try {
    resJson = JSON.parse(resText);
  } catch (e) {
    throw new Error(`Ошибка разбора ответа (${response.status}): ${resText.slice(0, 150) || e.message}`);
  }

  if (!response.ok) {
    const errorDetail = resJson.error?.message || JSON.stringify(resJson);
    throw new Error(`Ошибка API (${response.status}): ${errorDetail}`);
  }

  const choice = resJson.choices?.[0];
  const msg = choice?.message;
  let content = msg?.content || msg?.reasoning_content || choice?.text || '';
  return cleanModelPreamble(content);
}

/**
 * Step 1: Context & Glossary Pass
 * Analyzes the card to create a context passport (gender, pronoun, verb gender, speech tone, glossary, lorebook keys).
 */
export async function analyzeCardContext({
  cardData,
  settings,
  signal = null
}) {
  if ((settings.provider === 'nanogpt' || settings.provider === 'openrouter') && (!settings.apiKey || !settings.apiKey.trim())) {
    throw new Error('API-ключ не задан! Откройте «⚙️ Настройки API» и вставьте ваш ключ от ' + (settings.provider === 'nanogpt' ? 'Nano-GPT' : 'OpenRouter') + '.');
  }

  const cleanBaseUrl = settings.baseUrl.replace(/\/+$/, '');
  const rawEndpoint = `${cleanBaseUrl}/chat/completions`;

  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json'
  };

  if (settings.apiKey) {
    const trimmedKey = settings.apiKey.trim();
    headers['Authorization'] = `Bearer ${trimmedKey}`;
    headers['x-api-key'] = trimmedKey;
  }

  if (settings.provider === 'openrouter') {
    headers['HTTP-Referer'] = window.location.origin || 'http://localhost';
    headers['X-Title'] = 'AI Character Card Translator';
  }

  // Sample relevant context fields
  const sampleParts = [];
  if (cardData.name) sampleParts.push(`Character Name: ${cardData.name}`);
  if (cardData.description) sampleParts.push(`Description:\n${cardData.description.slice(0, 1500)}`);
  if (cardData.personality) sampleParts.push(`Personality:\n${cardData.personality.slice(0, 800)}`);
  if (cardData.scenario) sampleParts.push(`Scenario:\n${cardData.scenario.slice(0, 800)}`);
  if (cardData.first_mes) sampleParts.push(`First Message:\n${cardData.first_mes.slice(0, 1200)}`);

  let lorebookPrompt = '';
  if (cardData.character_book) {
    if (cardData.character_book.name) sampleParts.push(`Lorebook Name: ${cardData.character_book.name}`);
    if (Array.isArray(cardData.character_book.entries)) {
      const allKeys = [];
      cardData.character_book.entries.forEach(e => {
        if (Array.isArray(e.keys)) allKeys.push(...e.keys);
        else if (typeof e.keys === 'string') allKeys.push(...e.keys.split(/[\n,;]+/));
      });
      const uniqueKeys = [...new Set(allKeys.map(k => String(k).trim()).filter(Boolean))].slice(0, 30);
      if (uniqueKeys.length > 0) {
        lorebookPrompt = `\nLorebook Trigger Keys: ${JSON.stringify(uniqueKeys)}`;
      }
    }
  }

  const systemPrompt = `Ты — эксперт-аналитик карточек персонажей для ролевых игр (SillyTavern, Chub, TavernAI).
Твоя задача — проанализировать предоставленный текст карточки персонажа на английском языке и сформировать компактный паспорт контекста для переводчика.

Верни ответ ИСКЛЮЧИТЕЛЬНО в формате валидного JSON со следующими ключами:
{
  "character_name_ru": "Русское имя или транслитерация (например: Серафина Вейл)",
  "gender": "Пол персонажа (женский / мужской / иной)",
  "verb_gender": "он сделал" | "она сделала" | "оно сделало",
  "user_pronoun": "ты" | "вы" (выбери подходящее обращение персонажа к {{user}} исходя из дистанции, статуса и характера)",
  "speech_tone": "Краткое описание тона и манеры речи (например: саркастичный, холодный, вежливый, архаичный)",
  "glossary": {
    "English Term": "Русский перевод"
  },
  "lorebook_keys": {
    "english key": "русский ключ"
  }
}

ПРАВИЛА:
1. В "glossary" включи ключевые имена собственные, локации, титулы, фракции, артефакты и уникальные понятия из карточки.
2. В "lorebook_keys" переведи триггерные ключи лорбука, если они предоставлены. Если лорбука нет, верни {}.
3. Ответ должен содержать ТОЛЬКО валидный JSON-объект без лишних слов, без предисловий и без markdown-тегов вне JSON.`;

  const userContent = `Проанализируй карточку персонажа и верни JSON-паспорт контекста:\n\n${sampleParts.join('\n\n')}${lorebookPrompt}`;

  const requestBody = {
    model: settings.model || 'deepseek/deepseek-chat',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent }
    ],
    temperature: 0.1,
    max_tokens: 1500,
    stream: false
  };

  try {
    const rawContent = await postChatCompletion({
      rawEndpoint,
      requestBody,
      headers,
      provider: settings.provider,
      signal
    });

    let jsonStr = rawContent;
    const matchJson = jsonStr.match(/\{[\s\S]*\}/);
    if (matchJson) {
      jsonStr = matchJson[0];
    }

    let parsed = {};
    try {
      parsed = JSON.parse(jsonStr);
    } catch (e) {
      console.warn('Failed to parse passport JSON, using defaults', e);
    }

    return {
      character_name_ru: parsed.character_name_ru || cardData.name || '',
      gender: parsed.gender || 'не определен',
      verb_gender: parsed.verb_gender || 'он сделал',
      user_pronoun: parsed.user_pronoun === 'вы' ? 'вы' : 'ты',
      speech_tone: parsed.speech_tone || 'литературный',
      glossary: (parsed.glossary && typeof parsed.glossary === 'object') ? parsed.glossary : {},
      lorebook_keys: (parsed.lorebook_keys && typeof parsed.lorebook_keys === 'object') ? parsed.lorebook_keys : {}
    };
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    console.warn('Step 1 passport analysis failed, proceeding with fallback passport:', err);
    return {
      character_name_ru: cardData.name || '',
      gender: 'не определен',
      verb_gender: 'он сделал',
      user_pronoun: 'ты',
      speech_tone: 'литературный',
      glossary: {},
      lorebook_keys: {}
    };
  }
}

/**
 * Step 2: Execution Translation Pass
 * Translates all card fields and lorebook using XML tag format.
 * Injects Step 1 passport into the system prompt.
 * Step 2.5: Client-side JS Guardian parses XML tags, repairs macros/asterisks, and performs additive lorebook key expansion.
 */
export async function translateFullCard({
  cardData,
  passport = null,
  settings,
  signal = null
}) {
  if ((settings.provider === 'nanogpt' || settings.provider === 'openrouter') && (!settings.apiKey || !settings.apiKey.trim())) {
    throw new Error('API-ключ не задан! Откройте «⚙️ Настройки API» и вставьте ваш ключ от ' + (settings.provider === 'nanogpt' ? 'Nano-GPT' : 'OpenRouter') + '.');
  }

  const cleanBaseUrl = settings.baseUrl.replace(/\/+$/, '');
  const rawEndpoint = `${cleanBaseUrl}/chat/completions`;

  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json'
  };

  if (settings.apiKey) {
    const trimmedKey = settings.apiKey.trim();
    headers['Authorization'] = `Bearer ${trimmedKey}`;
    headers['x-api-key'] = trimmedKey;
  }

  if (settings.provider === 'openrouter') {
    headers['HTTP-Referer'] = window.location.origin || 'http://localhost';
    headers['X-Title'] = 'AI Character Card Translator';
  }

  // Format fields to translate into XML tags
  const xmlPayloadParts = [];
  const standardKeys = [
    'name', 'first_mes', 'description', 'personality', 'scenario',
    'mes_example', 'creator_notes', 'system_prompt', 'post_history_instructions'
  ];

  for (const k of standardKeys) {
    if (cardData[k] && String(cardData[k]).trim()) {
      xmlPayloadParts.push(`<${k}>\n${cardData[k]}\n</${k}>`);
    }
  }

  if (Array.isArray(cardData.tags) && cardData.tags.length > 0) {
    xmlPayloadParts.push(`<tags>\n${cardData.tags.join(', ')}\n</tags>`);
  }

  if (Array.isArray(cardData.alternate_greetings)) {
    cardData.alternate_greetings.forEach((g, idx) => {
      if (g && String(g).trim()) {
        xmlPayloadParts.push(`<greeting_${idx}>\n${g}\n</greeting_${idx}>`);
      }
    });
  }

  // Include lorebook name, description, and entries if present
  if (cardData.character_book) {
    if (cardData.character_book.name) {
      xmlPayloadParts.push(`<lorebook_name>\n${cardData.character_book.name}\n</lorebook_name>`);
    }
    if (cardData.character_book.description) {
      xmlPayloadParts.push(`<lorebook_description>\n${cardData.character_book.description}\n</lorebook_description>`);
    }
    if (Array.isArray(cardData.character_book.entries)) {
      cardData.character_book.entries.forEach((entry, idx) => {
        if (!entry) return;
        if (entry.content) {
          xmlPayloadParts.push(`<entry_${idx}_content>\n${entry.content}\n</entry_${idx}_content>`);
        }
        const keysVal = Array.isArray(entry.keys) ? entry.keys.join(', ') : (entry.keys || '');
        if (keysVal.trim()) {
          xmlPayloadParts.push(`<entry_${idx}_keys>\n${keysVal}\n</entry_${idx}_keys>`);
        }
        if (entry.comment) {
          xmlPayloadParts.push(`<entry_${idx}_comment>\n${entry.comment}\n</entry_${idx}_comment>`);
        }
      });
    }
  }

  // Format glossary for system prompt
  let glossaryText = '';
  if (passport?.glossary && Object.keys(passport.glossary).length > 0) {
    glossaryText = Object.entries(passport.glossary)
      .map(([en, ru]) => `  - "${en}" -> "${ru}"`)
      .join('\n');
  } else {
    glossaryText = '  (нет специфических терминов)';
  }

  const fullCardSystemPrompt = `Ты — профессиональный литературный переводчик и эксперт по карточкам персонажей для SillyTavern / Chub / TavernAI.
Твоя задача — качественно и художественно перевести все поля карточки на русский язык в точном соответствии с утвержденным паспортом контекста персонажа.

=== ПАСПОРТ КОНТЕКСТА ПЕРСОНАЖА (СТРОГО ОБЯЗАТЕЛЕН) ===
- Русское имя: ${passport?.character_name_ru || cardData.name || 'не указано'}
- Пол персонажа: ${passport?.gender || 'не указан'}
- Род глаголов персонажа: ${passport?.verb_gender || 'он сделал'}
- Обращение персонажа к {{user}}: строго "${passport?.user_pronoun || 'ты'}"
- Тон и манера речи: ${passport?.speech_tone || 'литературный'}
- Обязательный глоссарий терминов и имен:
${glossaryText}

=== КРИТИЧЕСКИЕ ПРАВИЛА: ===
1. СОБЛЮДАЙ ПАСПОРТ КОНТЕКСТА:
   - Все глаголы персонажа в прошедшем времени согласуй строго по паспорту: "${passport?.verb_gender || 'он сделал'}".
   - Все реплики персонажа к {{user}} должны использовать форму обращения "${passport?.user_pronoun || 'ты'}".
   - Строго используй переводы терминов и имен из глоссария!
2. МАКРОСЫ И РАЗДЕЛИТЕЛИ:
   - СТРОГО сохраняй без изменений: {{char}}, {{user}}, {{original}}, <START>.
   - НЕ заменяй {{char}} на имя персонажа! Оставляй именно {{char}} и {{user}}!
3. ФОРМАТИРОВАНИЕ ДЕЙСТВИЙ И РЕПЛИК:
   - Действия персонажа в звездочках *действие* должны оставаться в парных звездочках *действие*.
   - Прямая речь персонажей — в кавычках («...» или "...").
   - Сохраняй разделители реплик <START> на отдельных строках.
4. ФОРМАТ ВЫВОДА (XML ТЕГИ):
   - Оберни перевод каждого поля в соответствующий XML-тег в точности как в запросе (например: <name>...</name>, <first_mes>...</first_mes>, <greeting_0>...</greeting_0>, <entry_0_content>...</entry_0_content>).
   - НЕ используй JSON! Выводи данные только внутри тегов.
   - НЕ добавляй никакого текста до первого тега или после последнего тега. Выводи ТОЛЬКО запрошенные XML-теги.`;

  const userContent = `Переведи поля карточки на русский язык с соблюдением паспорта контекста. Верни результат в соответствующих XML-тегах:\n\n${xmlPayloadParts.join('\n\n')}`;

  const requestBody = {
    model: settings.model || 'deepseek/deepseek-chat',
    messages: [
      { role: 'system', content: fullCardSystemPrompt },
      { role: 'user', content: userContent }
    ],
    temperature: parseFloat(settings.temperature) || 0.3,
    max_tokens: parseInt(settings.maxTokens, 10) || 4096,
    stream: false
  };

  try {
    const rawContent = await postChatCompletion({
      rawEndpoint,
      requestBody,
      headers,
      provider: settings.provider,
      signal
    });

    // Step 2.5: Client-side JS Guardian & Parser
    const xmlFields = parseXmlFields(rawContent);
    const result = {};

    // Process standard fields
    for (const k of standardKeys) {
      if (xmlFields[k] !== undefined) {
        if (k === 'name') {
          result.name = xmlFields.name.trim();
        } else {
          result[k] = repairMacrosAndTags(balanceAsterisks(xmlFields[k]));
        }
      }
    }

    // Fallback for character name if missing in XML response
    if (!result.name && passport?.character_name_ru) {
      result.name = passport.character_name_ru.trim();
    }

    // Process tags
    if (xmlFields.tags) {
      result.tags = xmlFields.tags.split(/[\n,;]+/).map(t => t.trim()).filter(Boolean);
    }

    // Process alternate greetings
    if (Array.isArray(cardData.alternate_greetings) && cardData.alternate_greetings.length > 0) {
      result.alternate_greetings = cardData.alternate_greetings.map((origG, idx) => {
        const transG = xmlFields[`greeting_${idx}`] || xmlFields[`greeting${idx}`];
        return transG ? repairMacrosAndTags(balanceAsterisks(transG)) : origG;
      });
    }

    // Process lorebook entries with additive key expansion
    if (cardData.character_book) {
      const newBook = JSON.parse(JSON.stringify(cardData.character_book));
      if (xmlFields.lorebook_name) {
        newBook.name = xmlFields.lorebook_name.trim();
      }
      if (xmlFields.lorebook_description) {
        newBook.description = xmlFields.lorebook_description.trim();
      }

      if (Array.isArray(newBook.entries)) {
        newBook.entries.forEach((entry, idx) => {
          const transContent = xmlFields[`entry_${idx}_content`];
          if (transContent) {
            entry.content = repairMacrosAndTags(balanceAsterisks(transContent));
          }

          const transComment = xmlFields[`entry_${idx}_comment`];
          if (transComment) {
            entry.comment = transComment.trim();
          }

          // Safe additive key expansion
          let origKeysArr = [];
          if (Array.isArray(entry.keys)) {
            origKeysArr = entry.keys;
          } else if (typeof entry.keys === 'string') {
            origKeysArr = entry.keys.split(/[\n,;]+/);
          }
          const keys_original = origKeysArr.map(k => String(k).trim()).filter(Boolean);

          const transKeysRaw = xmlFields[`entry_${idx}_keys`];
          const keys_from_xml = transKeysRaw
            ? transKeysRaw.split(/[\n,;]+/).map(k => k.trim()).filter(Boolean)
            : [];

          const keys_from_passport = keys_original.flatMap(k => {
            const lower = k.toLowerCase();
            const mapped = passport?.lorebook_keys?.[k] || passport?.lorebook_keys?.[lower];
            return mapped ? String(mapped).split(/[\n,;]+/) : [];
          }).map(k => k.trim()).filter(Boolean);

          entry.keys = [...new Set([...keys_original, ...keys_from_xml, ...keys_from_passport])];
        });
      }
      result.character_book = newBook;
    }

    return result;
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error('Перевод был отменен пользователем.');
    }
    let msg = err.message;
    if (msg.includes('Failed to fetch') || msg.includes('NetworkError') || err.name === 'TypeError') {
      msg = 'Сетевая ошибка при запросе к LLM. Убедитесь, что сервер запущен через start.bat или run.py.';
    }
    throw new Error(msg);
  }
}

/**
 * Translates a single field using the selected LLM, with character context and auto-repair.
 */
export async function translateText({
  text,
  fieldLabel = '',
  charName = '',
  context = null,
  passport = null,
  settings,
  signal = null
}) {
  if (!text || !text.trim()) {
    return '';
  }

  if ((settings.provider === 'nanogpt' || settings.provider === 'openrouter') && (!settings.apiKey || !settings.apiKey.trim())) {
    throw new Error('API-ключ не задан! Откройте «⚙️ Настройки API» и вставьте ваш ключ от ' + (settings.provider === 'nanogpt' ? 'Nano-GPT' : 'OpenRouter') + '.');
  }

  const cleanBaseUrl = settings.baseUrl.replace(/\/+$/, '');
  const rawEndpoint = `${cleanBaseUrl}/chat/completions`;

  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json'
  };

  if (settings.apiKey) {
    const trimmedKey = settings.apiKey.trim();
    headers['Authorization'] = `Bearer ${trimmedKey}`;
    headers['x-api-key'] = trimmedKey;
  }

  if (settings.provider === 'openrouter') {
    headers['HTTP-Referer'] = window.location.origin || 'http://localhost';
    headers['X-Title'] = 'AI Character Card Translator';
  }

  const userPromptParts = [];
  if (charName) {
    userPromptParts.push(`Имя персонажа: ${charName}`);
  }
  if (passport?.verb_gender) {
    userPromptParts.push(`Род глаголов персонажа: ${passport.verb_gender}`);
  }
  if (passport?.user_pronoun) {
    userPromptParts.push(`Обращение к {{user}}: ${passport.user_pronoun}`);
  }
  if (context?.personality) {
    userPromptParts.push(`Контекст/Характер персонажа: ${context.personality.slice(0, 300)}`);
  }
  if (context?.scenario) {
    userPromptParts.push(`Сценарий/Обстановка: ${context.scenario.slice(0, 300)}`);
  }
  if (fieldLabel) {
    userPromptParts.push(`Поле карточки для перевода: ${fieldLabel}`);
  }
  userPromptParts.push(`Исходный текст:\n\n${text}`);

  const userContent = userPromptParts.join('\n\n');

  const requestBody = {
    model: settings.model || 'deepseek/deepseek-chat',
    messages: [
      { role: 'system', content: settings.systemPrompt || DEFAULT_PROMPT_RU },
      { role: 'user', content: userContent }
    ],
    temperature: parseFloat(settings.temperature) || 0.3,
    max_tokens: parseInt(settings.maxTokens, 10) || 4096,
    stream: false
  };

  try {
    let translated = await postChatCompletion({
      rawEndpoint,
      requestBody,
      headers,
      provider: settings.provider,
      signal
    });

    if (typeof translated === 'string') {
      if (fieldLabel !== 'Имя персонажа' && fieldLabel !== 'name') {
        translated = repairMacrosAndTags(balanceAsterisks(translated));
      }
    }

    return translated;
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error('Перевод был отменен пользователем.');
    }
    let msg = err.message;
    if (msg.includes('Failed to fetch') || msg.includes('NetworkError') || err.name === 'TypeError') {
      msg = 'Сетевая ошибка при запросе к LLM. Убедитесь, что сервер запущен через start.bat или run.py.';
    }
    throw new Error(msg);
  }
}
