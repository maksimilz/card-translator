/**
 * Translator Module
 * Connects to OpenRouter, Ollama, LM Studio, and generic OpenAI-compatible endpoints.
 * Tailored specifically for AI Character Cards (preserves {{char}}, {{user}}, <START>, markdown, slang).
 */

export const DEFAULT_PROMPT_RU = `Ты — профессиональный литературный переводчик и эксперт по карточкам персонажей для текстовых ролевых игр (SillyTavern, Chub, TavernAI).
Твоя задача — качественно, выразительно и стилистически точно перевести текст карточки персонажа на русский язык.

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
   - Передавай индивидуальный тон, акцент, сленг, грубость, манеру речи персонажа без цензурного смягчения.
   - Живой литературный русский язык без англицизмов-калек, естественные диалоги.
4. ФОРМАТ ОТВЕТА:
   - Выводи ТОЛЬКО готовый переведенный текст.
   - НИКАКИХ предисловий, пояснений, кавычек вокруг всего ответа или фраз вроде "Вот перевод:".`;

export const PROVIDER_PRESETS = {
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
    hint: 'Подходит для KoboldCpp, vLLM, TabbyAPI, llama.cpp server.'
  }
};

/**
 * Loads saved translator settings from localStorage
 */
export function loadSettings() {
  const defaults = {
    provider: 'openrouter',
    baseUrl: PROVIDER_PRESETS.openrouter.baseUrl,
    apiKey: '',
    model: PROVIDER_PRESETS.openrouter.defaultModel,
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
export async function fetchAvailableModels(baseUrl, apiKey, provider) {
  const url = `${baseUrl.replace(/\/+$/, '')}/models`;
  const headers = {
    'Content-Type': 'application/json'
  };

  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey.trim()}`;
  }
  if (provider === 'openrouter') {
    headers['HTTP-Referer'] = window.location.origin || 'http://localhost';
    headers['X-Title'] = 'AI Character Card Translator';
  }

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Ошибка HTTP ${response.status}: ${errText.slice(0, 150)}`);
    }

    const data = await response.json();
    if (Array.isArray(data.data)) {
      return data.data.map(m => ({ id: m.id, name: m.name || m.id }));
    } else if (Array.isArray(data)) {
      return data.map(m => ({ id: m.id || m.name, name: m.name || m.id }));
    }
    return [];
  } catch (err) {
    let msg = err.message;
    if (msg.includes('Failed to fetch') || msg.includes('NetworkError')) {
      msg = 'Не удалось подключиться к эндпоинту. Проверьте адрес и убедитесь, что включен CORS (для Ollama: OLLAMA_ORIGINS="*", для LM Studio: Enable CORS).';
    }
    throw new Error(msg);
  }
}

/**
 * Translates a given text using the selected LLM
 */
export async function translateText({
  text,
  fieldLabel = '',
  charName = '',
  settings,
  signal = null
}) {
  if (!text || !text.trim()) {
    return '';
  }

  const cleanBaseUrl = settings.baseUrl.replace(/\/+$/, '');
  const endpoint = `${cleanBaseUrl}/chat/completions`;

  const headers = {
    'Content-Type': 'application/json'
  };

  if (settings.apiKey) {
    headers['Authorization'] = `Bearer ${settings.apiKey.trim()}`;
  }

  if (settings.provider === 'openrouter') {
    headers['HTTP-Referer'] = window.location.origin || 'http://localhost';
    headers['X-Title'] = 'AI Character Card Translator';
  }

  const userPromptParts = [];
  if (charName) {
    userPromptParts.push(`Имя персонажа: ${charName}`);
  }
  if (fieldLabel) {
    userPromptParts.push(`Поле карточки: ${fieldLabel}`);
  }
  userPromptParts.push(`Текст для перевода:\n\n${text}`);

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
    const response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(requestBody),
      signal
    });

    if (!response.ok) {
      let errorDetail = '';
      try {
        const errorJson = await response.json();
        errorDetail = errorJson.error?.message || JSON.stringify(errorJson);
      } catch (e) {
        errorDetail = await response.text();
      }
      throw new Error(`Ошибка API (${response.status}): ${errorDetail}`);
    }

    const resJson = await response.json();
    let translated = resJson.choices?.[0]?.message?.content || '';

    // Strip accidental code block markers if model wrapped entire text
    translated = cleanModelPreamble(translated);

    return translated;
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error('Перевод был отменен пользователем.');
    }
    let msg = err.message;
    if (msg.includes('Failed to fetch') || msg.includes('NetworkError')) {
      msg = 'Сетевая ошибка при запросе к LLM. Проверьте запущен ли локальный сервер и включен ли CORS.';
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
