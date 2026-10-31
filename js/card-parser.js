/**
 * Card Parser & Normalizer
 * Supports Character Card V2 Spec (SillyTavern, Chub, TavernAI), V3, and legacy V1.
 * Unknown fields (V3 extras like nickname/assets, app-specific keys) are preserved as-is.
 */

export const TEXT_FIELDS = [
  { key: 'name', label: 'Имя персонажа', section: 'main', type: 'text', hint: 'Можно оставить на английском или перевести' },
  { key: 'first_mes', label: 'Первое сообщение', section: 'main', hint: 'Приветственная реплика и начальная сцена' },
  { key: 'description', label: 'Описание', section: 'main', hint: 'Внешность, биография, черты характера, W++ или свободный текст' },
  { key: 'personality', label: 'Личность', section: 'main', hint: 'Краткое резюме характера и манеры поведения' },
  { key: 'scenario', label: 'Сценарий', section: 'main', hint: 'Обстоятельства встречи персонажа с {{user}}' },
  { key: 'mes_example', label: 'Примеры диалогов', section: 'main', hint: 'Формат <START> {{user}}: ... {{char}}: ...' },
  { key: 'creator_notes', label: 'Заметки автора', section: 'service', hint: 'Советы создателя карточки' },
  { key: 'system_prompt', label: 'Системный промпт', section: 'service', hint: 'Инструкции для LLM по роли' },
  { key: 'post_history_instructions', label: 'Post-History инструкции', section: 'service', hint: 'Директивы в конце контекста' },
];

export const LIST_FIELDS = [
  { key: 'alternate_greetings', label: 'Альтернативное приветствие', section: 'greetings' },
  { key: 'group_only_greetings', label: 'Приветствие для группового чата', section: 'greetings' },
];

const MACRO_SUB_OBJ = /\{{1,3}\s*(?:sub|obj)\s*\}{1,3}/gi;

/**
 * Normalizes JanitorAI {{sub}} and {{obj}} macros into {{user}}.
 * Supports variations: {{sub}}, {sub}, {{{sub}}}, {{obj}}, {obj}, {{{obj}}}, with arbitrary spacing and case-insensitivity.
 */
export function replaceSubObj(text) {
  if (!text || typeof text !== 'string') return text || '';
  return text.replace(MACRO_SUB_OBJ, '{{user}}');
}

/**
 * Checks if a card or text contains {{sub}} or {{obj}} macros
 */
export function hasSubObjMacros(obj) {
  if (!obj) return false;
  const str = typeof obj === 'string' ? obj : JSON.stringify(obj);
  return /\{{1,3}\s*(?:sub|obj)\s*\}{1,3}/i.test(str);
}

function toStringList(value) {
  if (Array.isArray(value)) return value.map(v => replaceSubObj(String(v ?? '')));
  if (typeof value === 'string' && value.trim()) return value.split(',').map(t => replaceSubObj(t.trim())).filter(Boolean);
  return [];
}

function normalizeKeys(keys) {
  if (Array.isArray(keys)) return keys.map(k => replaceSubObj(String(k)));
  if (typeof keys === 'string') return keys.split(/[\n,;]+/).map(k => replaceSubObj(k.trim())).filter(Boolean);
  return [];
}

function normalizeBook(book) {
  const cloned = JSON.parse(JSON.stringify(book));
  if (typeof cloned.name === 'string') cloned.name = replaceSubObj(cloned.name);
  if (typeof cloned.description === 'string') cloned.description = replaceSubObj(cloned.description);
  if (!Array.isArray(cloned.entries)) {
    // Some exporters store entries as an object keyed by uid
    cloned.entries = cloned.entries && typeof cloned.entries === 'object' ? Object.values(cloned.entries) : [];
  }
  cloned.entries = cloned.entries.filter(e => e && typeof e === 'object');
  cloned.entries.forEach(entry => {
    if (typeof entry.content === 'string') entry.content = replaceSubObj(entry.content);
    if (typeof entry.comment === 'string') entry.comment = replaceSubObj(entry.comment);
    entry.keys = normalizeKeys(entry.keys);
    if (entry.secondary_keys !== undefined) entry.secondary_keys = normalizeKeys(entry.secondary_keys);
  });
  return cloned;
}

/**
 * Normalizes input JSON into { spec, spec_version, data }.
 * Known text fields are coerced to strings; every other field in data is kept untouched.
 */
export function normalizeCard(json) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    throw new Error('Некорректный формат карточки: ожидается JSON объект');
  }

  const isWrapped = json.data && typeof json.data === 'object' && !Array.isArray(json.data) &&
    (typeof json.spec === 'string' || 'name' in json.data || 'description' in json.data || 'first_mes' in json.data);
  const src = isWrapped ? json.data : json;

  const spec = json.spec === 'chara_card_v3' ? 'chara_card_v3' : 'chara_card_v2';
  const spec_version = spec === 'chara_card_v3' ? String(json.spec_version || '3.0') : '2.0';

  const data = JSON.parse(JSON.stringify(src));
  if (!isWrapped) {
    delete data.spec;
    delete data.spec_version;
  }

  for (const { key } of TEXT_FIELDS) {
    let value = src[key];
    if (key === 'first_mes' && (value === undefined || value === null)) value = src.greeting;
    data[key] = replaceSubObj(String(value ?? ''));
  }
  data.name = data.name.trim();

  data.alternate_greetings = toStringList(src.alternate_greetings);
  if (src.group_only_greetings !== undefined) data.group_only_greetings = toStringList(src.group_only_greetings);
  data.tags = Array.isArray(src.tags)
    ? src.tags.map(t => replaceSubObj(String(t)))
    : (typeof src.tags === 'string' && src.tags ? src.tags.split(',').map(t => replaceSubObj(t.trim())).filter(Boolean) : []);
  data.creator = String(src.creator ?? '');
  data.character_version = String(src.character_version ?? '');
  data.extensions = (src.extensions && typeof src.extensions === 'object') ? data.extensions : {};

  const charBook = src.character_book || json.character_book || src.extensions?.character_book;
  if (charBook && typeof charBook === 'object') {
    data.character_book = normalizeBook(charBook);
  } else {
    delete data.character_book;
  }

  return { spec, spec_version, data };
}

/**
 * Clones a normalized card structure cleanly
 */
export function cloneCard(card) {
  return JSON.parse(JSON.stringify(card));
}

/**
 * Builds the JSON object to embed/export. V2 output is always available (SillyTavern reads it);
 * V3 output is produced only for cards that were V3 originally.
 */
export function toExportJson(card, spec = card.spec) {
  const data = cloneCard(card.data);
  if (spec === 'chara_card_v3') {
    return { spec: 'chara_card_v3', spec_version: card.spec_version || '3.0', data };
  }
  return { spec: 'chara_card_v2', spec_version: '2.0', data };
}

/**
 * Backward-compatible helper used by older code and tests
 */
export function serializeV2Card(card) {
  return toExportJson(normalizeCard(card), 'chara_card_v2');
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
  const cyrillicMatch = str.match(/[Ѐ-ӿ]/g);
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
    ...TEXT_FIELDS.map(f => d[f.key]),
    ...(d.alternate_greetings || []),
    ...(d.group_only_greetings || [])
  ];

  const book = d.character_book;
  if (book && typeof book === 'object') {
    parts.push(book.name, book.description);
    for (const entry of book.entries || []) {
      if (!entry) continue;
      parts.push(entry.comment, entry.content);
      if (Array.isArray(entry.keys)) parts.push(entry.keys.join(' '));
      if (Array.isArray(entry.secondary_keys)) parts.push(entry.secondary_keys.join(' '));
    }
  }

  return countStats(parts.filter(Boolean).join('\n\n'));
}
