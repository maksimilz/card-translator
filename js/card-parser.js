/**
 * Card Parser & Normalizer
 * Supports Character Card V2 Spec (SillyTavern, Chub, TavernAI), V3, and legacy V1.
 */

export const TRANSLATABLE_FIELDS = [
  { key: 'name', label: 'Имя персонажа', type: 'text', rows: 1, translatable: true, description: 'Имя персонажа (можно оставить на английском или перевести)' },
  { key: 'first_mes', label: 'Первое сообщение (First Message / Greeting)', type: 'textarea', rows: 8, translatable: true, description: 'Приветственная реплика и начальная сцена персонажа' },
  { key: 'description', label: 'Описание персонажа (Description / Definition)', type: 'textarea', rows: 10, translatable: true, description: 'Внешность, биография, черты характера, W++ или свободный текст' },
  { key: 'personality', label: 'Личность (Personality)', type: 'textarea', rows: 6, translatable: true, description: 'Краткое резюме характера, манера поведения' },
  { key: 'scenario', label: 'Сценарий / Обстановка (Scenario)', type: 'textarea', rows: 6, translatable: true, description: 'Контекст и обстоятельства встречи персонажа с пользователем' },
  { key: 'mes_example', label: 'Примеры сообщений (Dialogue Examples)', type: 'textarea', rows: 8, translatable: true, description: 'Примеры реплик в формате <START> {{user}}: ... {{char}}: ...' },
  { key: 'creator_notes', label: 'Заметки автора (Creator Notes)', type: 'textarea', rows: 4, translatable: true, description: 'Советы создателя по настройке контекста, токенов и стилю' },
  { key: 'system_prompt', label: 'Системный промпт (System Prompt)', type: 'textarea', rows: 5, translatable: true, description: 'Специфические инструкции для LLM по роли' },
  { key: 'post_history_instructions', label: 'Инструкции после контекста (Post-History)', type: 'textarea', rows: 4, translatable: true, description: 'Директивы, внедряемые в конец контекста диалога' },
];

export const METADATA_FIELDS = [
  { key: 'creator', label: 'Автор карточки', type: 'text' },
  { key: 'character_version', label: 'Версия карточки', type: 'text' },
];

/**
 * Normalizes JanitorAI {{sub}} and {{obj}} macros into {{user}}.
 * Supports variations: {{sub}}, {sub}, {{{sub}}}, {{obj}}, {obj}, {{{obj}}}, with arbitrary spacing and case-insensitivity.
 */
export function replaceSubObj(text) {
  if (!text || typeof text !== 'string') return text || '';
  return text.replace(/\{{1,3}\s*(?:sub|obj)\s*\}{1,3}/gi, '{{user}}');
}

/**
 * Checks if a card or text contains {{sub}} or {{obj}} macros
 */
export function hasSubObjMacros(obj) {
  if (!obj) return false;
  const str = typeof obj === 'string' ? obj : JSON.stringify(obj);
  return /\{{1,3}\s*(?:sub|obj)\s*\}{1,3}/i.test(str);
}

/**
 * Normalizes input JSON into standard Character Card V2 structure
 */
export function normalizeCard(json) {
  if (!json || typeof json !== 'object') {
    throw new Error('Некорректный формат карточки: ожидается JSON объект');
  }

  // If already V2 structure with data wrapper
  let data = {};
  let spec = 'chara_card_v2';
  let spec_version = '2.0';

  if (json.spec === 'chara_card_v2' && json.data) {
    data = { ...json.data };
    spec = json.spec;
    spec_version = json.spec_version || '2.0';
  } else if (json.data && (json.data.name || json.data.description)) {
    // Some formats wrap in data without explicit spec
    data = { ...json.data };
  } else {
    // V1 legacy format or flat structure
    data = { ...json };
  }

  const normalizedData = {
    name: replaceSubObj(String(data.name || '')).trim(),
    description: replaceSubObj(String(data.description || '')),
    personality: replaceSubObj(String(data.personality || '')),
    scenario: replaceSubObj(String(data.scenario || '')),
    first_mes: replaceSubObj(String(data.first_mes || data.greeting || '')),
    mes_example: replaceSubObj(String(data.mes_example || '')),
    creator_notes: replaceSubObj(String(data.creator_notes || '')),
    system_prompt: replaceSubObj(String(data.system_prompt || '')),
    post_history_instructions: replaceSubObj(String(data.post_history_instructions || '')),
    alternate_greetings: Array.isArray(data.alternate_greetings)
      ? data.alternate_greetings.map(g => replaceSubObj(String(g)))
      : [],
    tags: Array.isArray(data.tags)
      ? data.tags.map(t => replaceSubObj(String(t)))
      : (typeof data.tags === 'string' && data.tags ? data.tags.split(',').map(t => replaceSubObj(t.trim())) : []),
    creator: String(data.creator || ''),
    character_version: String(data.character_version || '1.0'),
    extensions: (data.extensions && typeof data.extensions === 'object') ? data.extensions : {}
  };

  const charBook = data.character_book || json.character_book || (data.extensions && data.extensions.character_book);
  if (charBook && typeof charBook === 'object') {
    const clonedBook = JSON.parse(JSON.stringify(charBook));
    if (typeof clonedBook.name === 'string') clonedBook.name = replaceSubObj(clonedBook.name);
    if (typeof clonedBook.description === 'string') clonedBook.description = replaceSubObj(clonedBook.description);
    if (Array.isArray(clonedBook.entries)) {
      clonedBook.entries.forEach(entry => {
        if (!entry || typeof entry !== 'object') return;
        if (typeof entry.content === 'string') entry.content = replaceSubObj(entry.content);
        if (typeof entry.comment === 'string') entry.comment = replaceSubObj(entry.comment);
        if (Array.isArray(entry.keys)) entry.keys = entry.keys.map(k => replaceSubObj(String(k)));
        else if (typeof entry.keys === 'string') entry.keys = replaceSubObj(entry.keys);
        if (Array.isArray(entry.secondary_keys)) entry.secondary_keys = entry.secondary_keys.map(k => replaceSubObj(String(k)));
        else if (typeof entry.secondary_keys === 'string') entry.secondary_keys = replaceSubObj(entry.secondary_keys);
      });
    }
    normalizedData.character_book = clonedBook;
  }

  return {
    spec,
    spec_version,
    data: normalizedData
  };
}

/**
 * Clones a normalized card structure cleanly
 */
export function cloneCard(card) {
  return JSON.parse(JSON.stringify(card));
}

/**
 * Prepares final JSON object for V2 export (with backward compatibility for V1)
 */
export function serializeV2Card(card) {
  const c = normalizeCard(card);
  const data = c.data;

  const resultData = {
    name: data.name,
    description: data.description,
    personality: data.personality,
    scenario: data.scenario,
    first_mes: data.first_mes,
    mes_example: data.mes_example,
    creator_notes: data.creator_notes,
    system_prompt: data.system_prompt,
    post_history_instructions: data.post_history_instructions,
    alternate_greetings: data.alternate_greetings || [],
    tags: data.tags || [],
    creator: data.creator || '',
    character_version: data.character_version || '1.0',
    extensions: data.extensions || {}
  };

  if (data.character_book && typeof data.character_book === 'object') {
    resultData.character_book = data.character_book;
  }

  return {
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: resultData
  };
}

/**
 * Calculates character and estimated token counts
 */
export function countStats(text) {
  if (!text) return { chars: 0, words: 0, estimatedTokens: 0 };
  const str = String(text);
  const chars = str.length;
  const words = str.trim().split(/\s+/).filter(Boolean).length;
  
  // Cyrillic uses ~1 token per 2-3 characters; English ~1 token per 4 chars
  const cyrillicMatch = str.match(/[\u0400-\u04FF]/g);
  const cyrillicRatio = cyrillicMatch ? (cyrillicMatch.length / chars) : 0;
  
  const tokenDivisor = 4 - (cyrillicRatio * 1.5); // ranges from ~4 to ~2.5
  const estimatedTokens = Math.ceil(chars / Math.max(2, tokenDivisor));

  return { chars, words, estimatedTokens };
}

/**
 * Calculates total stats for entire card
 */
export function calculateCardStats(card) {
  if (!card || !card.data) return { chars: 0, words: 0, estimatedTokens: 0 };
  const d = card.data;
  const parts = [
    d.name,
    d.description,
    d.personality,
    d.scenario,
    d.first_mes,
    d.mes_example,
    d.creator_notes,
    d.system_prompt,
    d.post_history_instructions,
    ...(d.alternate_greetings || [])
  ];

  if (d.character_book && typeof d.character_book === 'object') {
    if (d.character_book.name) parts.push(d.character_book.name);
    if (d.character_book.description) parts.push(d.character_book.description);
    if (Array.isArray(d.character_book.entries)) {
      for (const entry of d.character_book.entries) {
        if (!entry) continue;
        if (entry.comment) parts.push(entry.comment);
        if (entry.content) parts.push(entry.content);
        if (Array.isArray(entry.keys)) parts.push(entry.keys.join(' '));
        else if (typeof entry.keys === 'string') parts.push(entry.keys);
        if (Array.isArray(entry.secondary_keys)) parts.push(entry.secondary_keys.join(' '));
        else if (typeof entry.secondary_keys === 'string') parts.push(entry.secondary_keys);
      }
    }
  }

  const fullText = parts.filter(Boolean).join('\n\n');
  return countStats(fullText);
}
