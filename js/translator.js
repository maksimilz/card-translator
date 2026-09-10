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
    (window.location.hostname === '127.0.0.1' || window.location.hostname === 'localhost');

  if (!isLocalServer) return targetUrl;

  const cleanTarget = targetUrl.trim();

  // Nano-GPT and non-OpenRouter external endpoints need CORS proxy
  if (
    provider === 'nanogpt' ||
    cleanTarget.includes('nano-gpt.com') ||
    (!cleanTarget.includes('openrouter.ai') &&
     !cleanTarget.includes('localhost') &&
     !cleanTarget.includes('127.0.0.1'))
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
    if (!fetchUrl.startsWith('/api-proxy') && (err.message.includes('Failed to fetch') || err.message.includes('NetworkError'))) {
      try {
        const proxyUrl = `/api-proxy?target=${encodeURIComponent(rawUrl)}`;
        const retryRes = await fetch(proxyUrl, { method: 'GET', headers, signal });
        if (retryRes.ok) {
          const d = await retryRes.json();
          if (Array.isArray(d.data)) return d.data.map(m => ({ id: m.id, name: m.name || m.id }));
          if (Array.isArray(d)) return d.map(m => ({ id: m.id || m.name, name: m.name || m.id }));
        }
      } catch {}
    }

    let msg = err.message;
    if (msg.includes('Failed to fetch') || msg.includes('NetworkError')) {
      msg = 'Не удалось подключиться к эндпоинту. Проверьте запущен ли start.bat / run.py или выберите модель из списка вручную.';
    }
    throw new Error(msg);
  }
}

/**
 * Translates ENTIRE character card as a single structured JSON block in ONE request.
 * Guarantees that the LLM has complete context (name, appearance, gender, personality, scenario)
 * and maintains consistent tone and pronoun agreement across all fields.
 */
export async function translateFullCard({
  cardData,
  settings,
  signal = null
}) {
  if ((settings.provider === 'nanogpt' || settings.provider === 'openrouter') && (!settings.apiKey || !settings.apiKey.trim())) {
    throw new Error('API-ключ не задан! Откройте «⚙️ Настройки API» и вставьте ваш ключ от ' + (settings.provider === 'nanogpt' ? 'Nano-GPT' : 'OpenRouter') + '.');
  }

  const cleanBaseUrl = settings.baseUrl.replace(/\/+$/, '');
  const rawEndpoint = `${cleanBaseUrl}/chat/completions`;
  const endpoint = resolveUrl(rawEndpoint, settings.provider);

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

  // Extract non-empty fields to translate
  const payloadToTranslate = {};
  const standardKeys = [
    'name', 'first_mes', 'description', 'personality', 'scenario',
    'mes_example', 'creator_notes', 'system_prompt', 'post_history_instructions'
  ];
  for (const k of standardKeys) {
    if (cardData[k] && String(cardData[k]).trim()) {
      payloadToTranslate[k] = cardData[k];
    }
  }
  if (Array.isArray(cardData.alternate_greetings) && cardData.alternate_greetings.length > 0) {
    payloadToTranslate.alternate_greetings = cardData.alternate_greetings;
  }
  if (Array.isArray(cardData.tags) && cardData.tags.length > 0) {
    payloadToTranslate.tags = cardData.tags;
  }

  const fullCardSystemPrompt = `Ты — профессиональный литературный переводчик и эксперт по карточкам персонажей для SillyTavern / Chub.
Твоя задача — перевести ВСЮ карточку персонажа целиком на русский язык, учитывая взаимосвязь всех полей в едином контексте.

ГЛАВНЫЕ ПРАВИЛА:
1. ЦЕЛОСТНОСТЬ КОНТЕКСТА: Используй описание персонажа, его пол, возраст, внешность и личность, чтобы правильно передать пол, тон, манеру речи и окончания глаголов (мужской/женский род) во всех репликах, первом сообщении и примерах диалогов!
2. МАКРОСЫ: СТРОГО сохраняй без изменений все макросы: {{char}}, {{user}}, {{original}}, <START>, XML-теги. НЕ заменяй {{char}} на имя персонажа!
3. ФОРМАТИРОВАНИЕ: Сохраняй действия в звездочках *действие*, прямую речь в кавычках, квадратные скобки [Scenario: ...], формат W++ или списки атрибутов.
4. ФОРМАТ ОТВЕТА:
   Верни ответ СТРОГО в виде валидного JSON-объекта, содержащего точно такие же ключи, со значениями, переведенными на русский язык.
   Пример формата:
   {
     "name": "...",
     "first_mes": "...",
     "description": "...",
     "personality": "...",
     "scenario": "...",
     "mes_example": "...",
     "creator_notes": "...",
     "system_prompt": "...",
     "post_history_instructions": "...",
     "alternate_greetings": ["..."],
     "tags": ["..."]
   }
   НЕ пиши ничего до или после JSON. Ответ должен содержать ТОЛЬКО валидный JSON объект.`;

  const userContent = `Переведи эту карточку персонажа на русский язык с сохранением контекста и формата JSON:\n\n` + JSON.stringify(payloadToTranslate, null, 2);

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
    let response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(requestBody),
      signal
    });

    if (!response.ok && !endpoint.startsWith('/api-proxy') && response.status === 0) {
      const proxyUrl = `/api-proxy?target=${encodeURIComponent(rawEndpoint)}`;
      response = await fetch(proxyUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody),
        signal
      });
    }

    const resText = await response.text();
    let resJson;
    try {
      resJson = JSON.parse(resText);
    } catch (e) {
      throw new Error(`Ошибка разбора ответа от нейросети (${response.status}): ${resText.slice(0, 150) || e.message}`);
    }

    if (!response.ok) {
      const errorDetail = resJson.error?.message || JSON.stringify(resJson);
      throw new Error(`Ошибка API (${response.status}): ${errorDetail}`);
    }

    const choice = resJson.choices?.[0];
    const msg = choice?.message;
    let content = msg?.content || msg?.reasoning_content || choice?.text || '';

    // Extract JSON from model response
    let jsonStr = cleanModelPreamble(content);
    const matchJson = jsonStr.match(/\{[\s\S]*\}/);
    if (matchJson) {
      jsonStr = matchJson[0];
    }

    const parsedResult = JSON.parse(jsonStr);
    return parsedResult;
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error('Перевод был отменен пользователем.');
    }
    let msg = err.message;
    if (msg.includes('Failed to fetch') || msg.includes('NetworkError')) {
      msg = 'Сетевая ошибка при запросе к LLM. Убедитесь, что сервер запущен через start.bat или run.py.';
    }
    throw new Error(msg);
  }
}

/**
 * Translates a single field using the selected LLM, with optional character context.
 */
export async function translateText({
  text,
  fieldLabel = '',
  charName = '',
  context = null,
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
  const endpoint = resolveUrl(rawEndpoint, settings.provider);

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
    let response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(requestBody),
      signal
    });

    // Auto-fallback to local proxy if direct fetch failed due to CORS
    if (!response.ok && !endpoint.startsWith('/api-proxy') && response.status === 0) {
      const proxyUrl = `/api-proxy?target=${encodeURIComponent(rawEndpoint)}`;
      response = await fetch(proxyUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody),
        signal
      });
    }

    const resText = await response.text();
    let resJson;
    try {
      resJson = JSON.parse(resText);
    } catch (e) {
      throw new Error(`Ошибка разбора ответа от нейросети (${response.status}): ${resText.slice(0, 150) || e.message}`);
    }

    if (!response.ok) {
      const errorDetail = resJson.error?.message || JSON.stringify(resJson);
      throw new Error(`Ошибка API (${response.status}): ${errorDetail}`);
    }

    const choice = resJson.choices?.[0];
    const msg = choice?.message;
    let translated = msg?.content || msg?.reasoning_content || choice?.text || '';

    // Strip accidental code block markers if model wrapped entire text
    if (typeof translated === 'string') {
      translated = cleanModelPreamble(translated);
    }

    return translated;
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error('Перевод был отменен пользователем.');
    }
    let msg = err.message;
    if (msg.includes('Failed to fetch') || msg.includes('NetworkError')) {
      msg = 'Сетевая ошибка при запросе к LLM. Убедитесь, что сервер запущен через start.bat или run.py.';
    }
    throw new Error(msg);
  }
}

/**
 * Strips accidental wrapping artifacts (e.g. ```markdown ... ```)
 */
function cleanModelPreamble(text) {
  let res = text.trim();

  // If the model wrapped everything in a markdown code block
  const codeBlockMatch = res.match(/^```(?:markdown|text)?\s*([\s\S]*?)\s*```$/);
  if (codeBlockMatch) {
    res = codeBlockMatch[1].trim();
  }

  // Remove common introductory tags if present
  res = res.replace(/^(?:Вот перевод(?:\s*текста)?|Перевод:)\s*\n+/i, '');

  return res;
}
