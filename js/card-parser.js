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
    name: String(data.name || '').trim(),
    description: String(data.description || ''),
    personality: String(data.personality || ''),
    scenario: String(data.scenario || ''),
    first_mes: String(data.first_mes || ''),
    mes_example: String(data.mes_example || ''),
    creator_notes: String(data.creator_notes || ''),
    system_prompt: String(data.system_prompt || ''),
    post_history_instructions: String(data.post_history_instructions || ''),
    alternate_greetings: Array.isArray(data.alternate_greetings)
      ? data.alternate_greetings.map(g => String(g))
      : [],
    tags: Array.isArray(data.tags)
      ? data.tags.map(t => String(t))
      : (typeof data.tags === 'string' && data.tags ? data.tags.split(',').map(t => t.trim()) : []),
    creator: String(data.creator || ''),
    character_version: String(data.character_version || '1.0'),
    extensions: (data.extensions && typeof data.extensions === 'object') ? data.extensions : {}
  };

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

  return {
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
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
    }
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
  let fullText = [
    d.name,
    d.description,
    d.personality,
    d.scenario,
    d.first_mes,
    d.mes_example,
    d.system_prompt,
    d.post_history_instructions,
    ...(d.alternate_greetings || [])
  ].filter(Boolean).join('\n\n');

  return countStats(fullText);
}
