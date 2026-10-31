/**
 * Main Application Controller
 * Card loading, row-aligned original/translation editor, 2-step translation,
 * passport editing, assistant, draft autosave and export.
 */

import {
  extractCardFromPNG,
  embedCardInPNG,
  isPNG,
  convertImageFileToPNGBytes
} from './png-chunks.js';

import {
  normalizeCard,
  cloneCard,
  toExportJson,
  calculateCardStats,
  countStats,
  TEXT_FIELDS,
  hasSubObjMacros
} from './card-parser.js';

import {
  loadSettings,
  saveSettings,
  analyzeCardContext,
  buildTranslationUnits,
  translateUnits,
  applyTranslations,
  checkFormatting,
  askCharacterAI,
  transformCharacterAI,
  fetchAvailableModels,
  PROVIDER_PRESETS,
  DEFAULT_SETTINGS
} from './translator.js';

import { saveDraft, loadDraft, clearDraft } from './draft-store.js';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const state = {
  originalCard: null,
  translatedCard: null,
  // Exactly what the user opened, for "download original" (kind: png | json | demo)
  source: null,
  currentImageBytes: null,
  avatarUrl: null,
  passport: null,
  failed: {},
  busyIds: new Set(),
  busy: false,
  abortController: null,
  assistantAbort: null,
  pendingTransform: null,
  rows: [],
  settings: loadSettings()
};

// Built-in demo card for quick testing
const DEMO_CARD = {
  spec: 'chara_card_v2',
  spec_version: '2.0',
  data: {
    name: 'Seraphina Vale',
    description: 'Seraphina is a 27-year-old enigmatic arcane librarian and archivist of forgotten astral lore. She has silver-streaked dark hair, luminous amethyst eyes, and wears an antique velvet coat embroidered with celestial constellations. Despite her quiet demeanor, she possesses a razor-sharp intellect and a subtle, dry sense of humor.',
    personality: 'Curious, scholarly, guarded yet compassionate, dry wit, highly perceptive.',
    scenario: '{{user}} enters the forbidden underground section of the Grand Astral Library during a stormy night, seeking a forbidden manuscript. Seraphina discovers {{user}} inspecting a restricted tome.',
    first_mes: '*Rain lashes relentlessly against the stained-glass arches of the Grand Library. The scent of aged parchment, dried lavender, and ozone fills the chilled air.*\n\n*A soft, rhythmic clicking of heels echoes from behind a row of towering mahogany bookshelves. Seraphina emerges from the shadows, a glowing crystal lantern casting dancing violet hues across her pale face.*\n\n"You are treading on dangerous ground, {{user}}," *she murmurs, tilting her head with a faintly arched eyebrow.* "Those texts were sealed three centuries ago for a reason. Are you lost, or simply reckless?"',
    mes_example: '<START>\n{{user}}: "I only wanted to learn the truth about the Eclipse."\n{{char}}: *Seraphina\'s expression softens slightly, though her guarded posture remains.* "The truth is rarely as romantic as wanderers imagine. But if your resolve is genuine... sit. Let us see if your mind can endure what the stars whisper."',
    creator_notes: 'Designed for immersive fantasy roleplay. Prefers detailed narrative style and atmospheric prose.',
    system_prompt: 'Roleplay as Seraphina Vale. Maintain an enigmatic, intellectual, and atmospheric tone. Never break character.',
    post_history_instructions: 'Keep responses focused on dialogue, atmospheric details, and character reactions.',
    alternate_greetings: [
      '*Seraphina is sitting at a large oak desk surrounded by floating runic scrolls, barely looking up as {{user}} enters.*\n\n"I heard your footsteps from the vestibule. State your purpose quickly, before the library wards take notice."',
      '*The library is in complete silence until a sudden rumble of thunder rattles the crystal chandeliers. Seraphina suddenly appears beside {{user}} with uncanny silence.*\n\n"Seeking forbidden knowledge in the dark? How dreadfully clichéd."'
    ],
    tags: ['fantasy', 'magic', 'librarian', 'scholar', 'mystery'],
    creator: 'TavernMaster',
    character_version: '1.2',
    character_book: {
      name: 'Grand Astral Library',
      entries: [
        { keys: ['Eclipse', 'the Eclipse'], content: 'The Eclipse is a forbidden ritual that once tore the veil between the stars and the mortal realm. All records of it were sealed in the library vaults.', comment: 'The Eclipse', enabled: true, insertion_order: 100 },
        { keys: ['wards', 'library wards'], content: 'Ancient protective wards guard the restricted sections. They react to fear and deceit, sealing doors and dimming lanterns.', comment: 'Library wards', enabled: true, insertion_order: 100 }
      ]
    },
    extensions: {}
  }
};

const SECTION_TITLES = {
  main: 'Основное',
  greetings: 'Приветствия',
  service: 'Служебные поля',
  tags: 'Теги',
  lore: 'Лорбук'
};

const STATUS_LABELS = {
  done: 'переведено',
  warning: 'проверить',
  todo: 'не переведено',
  failed: 'ошибка',
  busy: 'в работе',
  empty: 'пусто'
};

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------

const $ = (id) => document.getElementById(id);

const el = {
  welcomeView: $('welcome-view'),
  workspaceView: $('workspace-view'),
  fileInput: $('file-input'),
  avatarInput: $('avatar-input'),
  btnLoadFile: $('btn-load-file'),
  btnBrowseCard: $('btn-browse-card'),
  btnLoadDemo: $('btn-load-demo'),
  draftRestore: $('draft-restore'),
  draftRestoreInfo: $('draft-restore-info'),
  btnRestoreDraft: $('btn-restore-draft'),
  btnDiscardDraft: $('btn-discard-draft'),
  avatarContainer: $('avatar-container'),
  charAvatar: $('char-avatar'),
  bannerCharName: $('banner-char-name'),
  cardSpecBadge: $('card-spec-badge'),
  statTokens: $('stat-tokens'),
  statProgress: $('stat-progress'),
  draftStatus: $('draft-status'),
  btnTranslateAll: $('btn-translate-all'),
  btnRetryFailed: $('btn-retry-failed'),
  btnCancelTranslation: $('btn-cancel-translation'),
  btnDownloadTransPng: $('btn-download-trans-png'),
  exportMenu: $('export-menu'),
  progressPanel: $('batch-progress-container'),
  progressBar: $('batch-progress-bar'),
  progressText: $('batch-progress-text'),
  progressDetail: $('batch-progress-detail'),
  stepPill1: $('step-pill-1'),
  stepPill2: $('step-pill-2'),
  passportContainer: $('passport-container'),
  passportContent: $('passport-content'),
  passportBadge: $('passport-badge'),
  btnTogglePassport: $('btn-toggle-passport'),
  btnReanalyzePassport: $('btn-reanalyze-passport'),
  fieldNav: $('field-nav'),
  editor: document.querySelector('.editor'),
  editorRows: $('editor-rows'),
  toggleHideEmpty: $('toggle-hide-empty'),
  headerProviderName: $('header-provider-name'),
  headerModelName: $('header-model-name'),
  btnModelPill: $('btn-model-pill'),
  // Settings
  settingsModal: $('settings-modal'),
  btnOpenSettings: $('btn-open-settings'),
  btnCloseSettings: $('btn-close-settings'),
  btnCancelSettings: $('btn-cancel-settings'),
  btnSaveSettings: $('btn-save-settings'),
  settingProvider: $('setting-provider'),
  providerHint: $('provider-hint'),
  settingApiKey: $('setting-api-key'),
  btnToggleKeyVisibility: $('btn-toggle-key-visibility'),
  settingBaseUrl: $('setting-base-url'),
  settingModelSelect: $('setting-model-select'),
  settingModelCustom: $('setting-model-custom'),
  btnRefreshModels: $('btn-refresh-models'),
  localCorsHelp: $('local-cors-help'),
  corsHelpText: $('cors-help-text'),
  settingTemperature: $('setting-temperature'),
  settingMaxTokens: $('setting-max-tokens'),
  settingStream: $('setting-stream'),
  settingTranslateTags: $('setting-translate-tags'),
  settingExtraInstructions: $('setting-extra-instructions'),
  // Assistant
  btnOpenAssistant: $('btn-open-assistant'),
  assistantModal: $('assistant-modal'),
  btnCloseAssistant: $('btn-close-assistant'),
  btnDismissAssistant: $('btn-dismiss-assistant'),
  tabBtnAsk: $('tab-btn-ask'),
  tabBtnTransform: $('tab-btn-transform'),
  paneAsk: $('pane-ask'),
  paneTransform: $('pane-transform'),
  assistantQuestionInput: $('assistant-question-input'),
  btnSendQuestion: $('btn-send-question'),
  assistantAskResultBox: $('assistant-ask-result-box'),
  assistantAskResultText: $('assistant-ask-result-text'),
  btnCopyAskResult: $('btn-copy-ask-result'),
  assistantTransformInput: $('assistant-transform-input'),
  assistantSourceSelect: $('assistant-source-select'),
  btnExecuteTransform: $('btn-execute-transform'),
  assistantTransformResultBox: $('assistant-transform-result-box'),
  transformSummaryText: $('transform-summary-text'),
  transformDiffList: $('transform-diff-list'),
  btnApplyTransform: $('btn-apply-transform'),
  assistantStatusText: $('assistant-status-text'),
  // Choice dialog
  choiceModal: $('choice-modal'),
  choiceTitle: $('choice-title'),
  choiceText: $('choice-text'),
  choiceActions: $('choice-actions'),
  // Logs
  btnToggleConsole: $('btn-toggle-console'),
  logCountBadge: $('log-count-badge'),
  logDrawer: $('log-console-drawer'),
  logBody: $('log-console-body'),
  btnCopyLogs: $('btn-copy-logs'),
  btnClearLogs: $('btn-clear-logs'),
  btnCloseLogConsole: $('btn-close-log-console'),
  dragOverlay: $('drag-overlay'),
  toastContainer: $('toast-container')
};

/**
 * Tiny element builder: h('div', { className: 'x', dataset: { a: 1 } }, 'text', child)
 * Text is always set via text nodes, so card content can never inject HTML.
 */
function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key in node && key !== 'list') node[key] = value;
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : String(child));
  }
  return node;
}

function formatTime(ts = Date.now()) {
  return new Date(ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

function safeFileName(name) {
  return String(name || '').replace(/[\\/:*?"<>|\x00-\x1f]+/g, '_').replace(/\s+/g, ' ').trim().slice(0, 80) || 'character';
}

// ---------------------------------------------------------------------------
// Logging & toasts
// ---------------------------------------------------------------------------

let logCounter = 0;
const logBuffer = [];

export function appLog(message, type = 'info') {
  const timeStr = new Date().toTimeString().split(' ')[0];
  logCounter++;
  const tag = `[CardTranslator ${timeStr}]`;
  const method = type === 'error' ? 'error' : type === 'warning' ? 'warn' : 'log';
  console[method](`${tag} ${message}`);

  el.logCountBadge.textContent = logCounter;
  logBuffer.push(`[${timeStr}] [${type.toUpperCase()}] ${message}`);
  el.logBody.append(h('div', { className: 'log-entry' },
    h('span', { className: 'log-time' }, timeStr),
    h('span', { className: `log-badge ${type}` }, type.toUpperCase()),
    h('span', { className: 'log-text' }, message)
  ));
  el.logBody.scrollTop = el.logBody.scrollHeight;
}

/**
 * Toast notification. `action` = { label, onClick } adds a button (e.g. "Отменить").
 */
function showToast(message, type = 'info', { duration, action } = {}) {
  const toast = h('div', { className: `toast toast-${type}`, role: type === 'error' ? 'alert' : 'status' });
  const close = () => {
    toast.classList.add('is-leaving');
    setTimeout(() => toast.remove(), 300);
  };
  toast.append(h('div', { className: 'toast-text' }, message));
  if (action) {
    toast.append(h('button', {
      className: 'btn btn-ghost btn-xs',
      type: 'button',
      onclick: () => { action.onClick(); close(); }
    }, action.label));
  }
  toast.append(h('button', { className: 'toast-close', type: 'button', title: 'Закрыть', onclick: close }, '✕'));
  el.toastContainer.append(toast);
  setTimeout(close, duration ?? (type === 'error' ? 12000 : action ? 8000 : 4000));
}

/**
 * Modal choice dialog. Resolves with the chosen option value, or null on cancel/Escape.
 */
let resolveChoice = null;

function askChoice(title, text, options) {
  if (resolveChoice) resolveChoice(null);
  return new Promise(resolve => {
    resolveChoice = (value) => {
      resolveChoice = null;
      el.choiceModal.classList.remove('active');
      resolve(value);
    };
    el.choiceTitle.textContent = title;
    el.choiceText.textContent = text;
    el.choiceActions.replaceChildren(...options.map(opt => h('button', {
      className: `btn ${opt.kind || 'btn-secondary'}`,
      type: 'button',
      onclick: () => resolveChoice(opt.value)
    }, opt.label)));
    el.choiceModal.classList.add('active');
    el.choiceActions.lastElementChild?.focus();
  });
}

// ---------------------------------------------------------------------------
// Data binding: paths shared with translation unit ids
//   field:<key> | greeting:<i> | group_greeting:<i> | tags | lore_name | lore_desc | entry:<i>:<prop>
// ---------------------------------------------------------------------------

function listToText(value) {
  return Array.isArray(value) ? value.join(', ') : (value ?? '');
}

function textToList(value) {
  return String(value || '').split(/[\n,;]+/).map(s => s.trim()).filter(Boolean);
}

function getBound(data, path) {
  const [kind, a, b] = path.split(':');
  switch (kind) {
    case 'field': return String(data[a] ?? '');
    case 'greeting': return String(data.alternate_greetings?.[Number(a)] ?? '');
    case 'group_greeting': return String(data.group_only_greetings?.[Number(a)] ?? '');
    case 'tags': return listToText(data.tags);
    case 'lore_name': return String(data.character_book?.name ?? '');
    case 'lore_desc': return String(data.character_book?.description ?? '');
    case 'entry': {
      const entry = data.character_book?.entries?.[Number(a)];
      return entry ? String(listToText(entry[b])) : '';
    }
    default: return '';
  }
}

function setBound(data, path, value) {
  const [kind, a, b] = path.split(':');
  switch (kind) {
    case 'field':
      data[a] = value;
      break;
    case 'greeting':
    case 'group_greeting': {
      const key = kind === 'greeting' ? 'alternate_greetings' : 'group_only_greetings';
      if (!Array.isArray(data[key])) data[key] = [];
      data[key][Number(a)] = value;
      break;
    }
    case 'tags':
      data.tags = textToList(value);
      break;
    case 'lore_name':
    case 'lore_desc':
      if (data.character_book) data.character_book[kind === 'lore_name' ? 'name' : 'description'] = value;
      break;
    case 'entry': {
      const entry = data.character_book?.entries?.[Number(a)];
      if (!entry) break;
      entry[b] = (b === 'keys' || b === 'secondary_keys') ? textToList(value) : value;
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

function buildRows(orig) {
  const rows = [];
  const fieldRow = (f) => ({
    id: `field:${f.key}`,
    section: f.section,
    title: f.label,
    hint: f.hint,
    binds: [{ path: `field:${f.key}`, kind: f.key === 'name' ? 'line' : 'text' }]
  });

  TEXT_FIELDS.filter(f => f.section === 'main').forEach(f => rows.push(fieldRow(f)));

  (orig.alternate_greetings || []).forEach((_, i) => rows.push({
    id: `greeting:${i}`, section: 'greetings', title: `Альтернативное приветствие #${i + 1}`,
    binds: [{ path: `greeting:${i}`, kind: 'text' }]
  }));
  (orig.group_only_greetings || []).forEach((_, i) => rows.push({
    id: `group_greeting:${i}`, section: 'greetings', title: `Групповое приветствие #${i + 1}`,
    binds: [{ path: `group_greeting:${i}`, kind: 'text' }]
  }));

  TEXT_FIELDS.filter(f => f.section === 'service').forEach(f => rows.push(fieldRow(f)));

  rows.push({
    id: 'tags', section: 'tags', title: 'Теги', hint: 'Через запятую',
    binds: [{ path: 'tags', kind: 'list' }]
  });

  const book = orig.character_book;
  if (book) {
    if ((book.name || '').trim() || (book.description || '').trim()) {
      rows.push({
        id: 'lore_meta', section: 'lore', title: 'Лорбук: название и описание',
        binds: [
          { path: 'lore_name', kind: 'line', label: 'Название' },
          { path: 'lore_desc', kind: 'text', label: 'Описание' }
        ]
      });
    }
    (book.entries || []).forEach((entry, i) => {
      const binds = [
        { path: `entry:${i}:comment`, kind: 'line', label: 'Название записи' },
        { path: `entry:${i}:keys`, kind: 'keys', label: 'Ключи активации' }
      ];
      if (Array.isArray(entry.secondary_keys) && entry.secondary_keys.length) {
        binds.push({ path: `entry:${i}:secondary_keys`, kind: 'keys', label: 'Доп. ключи' });
      }
      binds.push({ path: `entry:${i}:content`, kind: 'text', label: 'Содержание' });
      rows.push({
        id: `entry:${i}`,
        section: 'lore',
        title: `#${i + 1} ${entry.comment || (entry.keys || []).slice(0, 3).join(', ') || 'Запись'}`,
        hint: entry.enabled === false ? 'выключена' : '',
        binds
      });
    });
  }
  return rows;
}

function rowDomId(rowId) {
  return `row-${rowId.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
}

function rowWarnings(row) {
  const orig = state.originalCard.data;
  const trans = state.translatedCard.data;
  const warnings = [];
  for (const bind of row.binds) {
    if (bind.kind !== 'text') continue;
    const o = getBound(orig, bind.path);
    const t = getBound(trans, bind.path);
    if (t === o) continue;
    for (const w of checkFormatting(o, t)) {
      warnings.push(row.binds.length > 1 && bind.label ? `${bind.label}: ${w}` : w);
    }
  }
  return warnings;
}

function rowStatus(row) {
  const orig = state.originalCard.data;
  const trans = state.translatedCard.data;
  const paths = row.binds.map(b => b.path);
  if (paths.some(p => state.busyIds.has(p))) return 'busy';
  if (paths.some(p => state.failed[p])) return 'failed';
  if (paths.every(p => !getBound(orig, p).trim())) return 'empty';
  if (!paths.some(p => getBound(trans, p) !== getBound(orig, p))) return 'todo';
  return rowWarnings(row).length ? 'warning' : 'done';
}

function isRowBlank(row) {
  return row.binds.every(b => !getBound(state.originalCard.data, b.path).trim() && !getBound(state.translatedCard.data, b.path).trim());
}

function renderOrigValue(bind, value) {
  if (bind.kind === 'keys' || bind.kind === 'list') {
    const items = textToList(value);
    return items.length
      ? h('div', { className: 'key-chips' }, items.map(k => h('span', { className: 'key-chip' }, k)))
      : h('div', { className: 'orig-text is-empty' }, '(пусто)');
  }
  return value.trim()
    ? h('div', { className: 'orig-text' }, value)
    : h('div', { className: 'orig-text is-empty' }, '(пусто)');
}

function renderTransInput(bind, value) {
  if (bind.kind === 'text') {
    return h('textarea', { className: 'field-textarea', dataset: { bind: bind.path }, rows: 3, spellcheck: true, value });
  }
  return h('input', { className: 'field-input', type: 'text', dataset: { bind: bind.path }, value });
}

function renderRow(row) {
  const orig = state.originalCard.data;
  const trans = state.translatedCard.data;
  const multi = row.binds.length > 1;

  const origCell = h('div', { className: 'orig-cell' });
  const transCell = h('div', { className: 'trans-cell' });
  for (const bind of row.binds) {
    if (multi) {
      origCell.append(h('div', { className: 'sub-label' }, bind.label));
      transCell.append(h('div', { className: 'sub-label' }, bind.label));
    }
    origCell.append(renderOrigValue(bind, getBound(orig, bind.path)));
    transCell.append(renderTransInput(bind, getBound(trans, bind.path)));
  }

  return h('article', { className: 'row', id: rowDomId(row.id), dataset: { row: row.id } },
    h('header', { className: 'row-head' },
      h('div', { className: 'row-title' },
        h('h4', {}, row.title),
        row.hint ? h('span', { className: 'row-hint' }, row.hint) : null
      ),
      h('div', { className: 'row-tools' },
        h('span', { className: 'row-warnings' }),
        h('span', { className: 'row-stats' }),
        h('button', { className: 'btn btn-accent btn-xs', type: 'button', dataset: { act: 'translate' }, title: 'Перевести нейросетью' }, 'Перевести'),
        h('button', { className: 'btn btn-ghost btn-xs', type: 'button', dataset: { act: 'reset' }, title: 'Вернуть текст оригинала' }, '↺ Оригинал')
      )
    ),
    h('div', { className: 'row-body' }, origCell, transCell)
  );
}

function renderEditor() {
  const orig = state.originalCard.data;
  state.rows = buildRows(orig);

  const rowsFragment = document.createDocumentFragment();
  const nav = document.createDocumentFragment();
  let lastSection = null;

  for (const row of state.rows) {
    if (row.section !== lastSection) {
      lastSection = row.section;
      rowsFragment.append(h('div', { className: 'section-title', id: `section-${row.section}` }, SECTION_TITLES[row.section]));
      nav.append(h('div', { className: 'nav-section-title' }, SECTION_TITLES[row.section]));
    }
    rowsFragment.append(renderRow(row));
    nav.append(h('button', { className: 'nav-item', type: 'button', dataset: { goto: row.id } },
      h('span', { className: 'dot' }),
      h('span', {}, row.title)
    ));
  }

  nav.append(h('div', { className: 'nav-legend' },
    ['done', 'warning', 'todo', 'failed'].map(s => h('span', { dataset: { status: s } }, h('span', { className: 'dot' }), STATUS_LABELS[s]))
  ));

  el.editorRows.replaceChildren(rowsFragment);
  el.fieldNav.replaceChildren(nav);
  refreshAllRows();
  requestAnimationFrame(() => el.editorRows.querySelectorAll('textarea').forEach(autoSize));
}

function autoSize(textarea) {
  textarea.style.height = 'auto';
  textarea.style.height = `${Math.min(textarea.scrollHeight + 2, window.innerHeight * 0.7)}px`;
}

function updateRow(row) {
  const node = document.getElementById(rowDomId(row.id));
  if (!node) return;
  const status = rowStatus(row);
  const blank = isRowBlank(row);
  node.dataset.status = status;
  node.classList.toggle('is-empty', blank);

  const navItem = el.fieldNav.querySelector(`[data-goto="${CSS.escape(row.id)}"]`);
  if (navItem) {
    navItem.dataset.status = status;
    navItem.classList.toggle('is-empty', blank);
    navItem.title = STATUS_LABELS[status];
  }

  const chips = [];
  const failedReason = row.binds.map(b => state.failed[b.path]).find(Boolean);
  if (failedReason) chips.push(h('span', { className: 'warn-chip is-error' }, failedReason));
  if (status === 'warning') chips.push(...rowWarnings(row).map(w => h('span', { className: 'warn-chip' }, w)));
  node.querySelector('.row-warnings').replaceChildren(...chips);

  const textBinds = row.binds.filter(b => b.kind === 'text');
  if (textBinds.length) {
    const o = textBinds.reduce((sum, b) => sum + countStats(getBound(state.originalCard.data, b.path)).estimatedTokens, 0);
    const t = textBinds.reduce((sum, b) => sum + countStats(getBound(state.translatedCard.data, b.path)).estimatedTokens, 0);
    node.querySelector('.row-stats').textContent = o ? `~${o} → ~${t} ток.` : '';
  }

  const translateBtn = node.querySelector('[data-act="translate"]');
  translateBtn.disabled = state.busy || status === 'empty';
}

function refreshAllRows() {
  state.rows.forEach(updateRow);
  updateSummary();
}

function findRow(rowId) {
  return state.rows.find(r => r.id === rowId);
}

function rowForPath(path) {
  return state.rows.find(r => r.binds.some(b => b.path === path));
}

function syncInputFromState(path) {
  const input = el.editorRows.querySelector(`[data-bind="${CSS.escape(path)}"]`);
  if (!input) return;
  input.value = getBound(state.translatedCard.data, path);
  if (input.tagName === 'TEXTAREA') autoSize(input);
}

function updateSummary() {
  if (!state.originalCard) return;
  const origStats = calculateCardStats(state.originalCard);
  const transStats = calculateCardStats(state.translatedCard);
  el.statTokens.textContent = `~${origStats.estimatedTokens} → ~${transStats.estimatedTokens} токенов`;

  const counted = state.rows.map(rowStatus).filter(s => s !== 'empty');
  const done = counted.filter(s => s === 'done' || s === 'warning').length;
  const warn = counted.filter(s => s === 'warning').length;
  el.statProgress.textContent = `Переведено ${done} из ${counted.length}${warn ? ` · проверить: ${warn}` : ''}`;

  // Section headers whose rows are all blank disappear together with the rows
  for (const section of new Set(state.rows.map(r => r.section))) {
    const blank = state.rows.filter(r => r.section === section).every(isRowBlank);
    document.getElementById(`section-${section}`)?.classList.toggle('is-empty', blank);
  }

  const failedCount = Object.keys(state.failed).length;
  el.btnRetryFailed.hidden = state.busy || failedCount === 0;
  el.btnRetryFailed.textContent = `↻ Повторить неудавшиеся (${failedCount})`;

  el.bannerCharName.textContent = state.translatedCard.data.name || state.originalCard.data.name || 'Безымянный персонаж';
}

// ---------------------------------------------------------------------------
// Passport
// ---------------------------------------------------------------------------

function mapToText(map) {
  return Object.entries(map || {}).map(([k, v]) => `${k} = ${v}`).join('\n');
}

function textToMap(text) {
  const map = {};
  for (const line of String(text || '').split('\n')) {
    const m = line.match(/^\s*(.+?)\s*(?:=|→|->)\s*(.+?)\s*$/);
    if (m) map[m[1]] = m[2];
  }
  return map;
}

function renderPassport() {
  const p = state.passport;
  el.passportContainer.hidden = !p;
  if (!p) return;
  el.passportContainer.querySelectorAll('[data-passport]').forEach(input => {
    input.value = p[input.dataset.passport] ?? '';
  });
  el.passportContainer.querySelectorAll('[data-passport-map]').forEach(input => {
    input.value = mapToText(p[input.dataset.passportMap]);
  });
  el.passportBadge.textContent = p.edited ? 'изменён вручную' : p.failed ? 'анализ не удался — заполните вручную' : 'Шаг 1';
}

// ---------------------------------------------------------------------------
// Draft autosave
// ---------------------------------------------------------------------------

let saveTimer = null;

function scheduleSave() {
  if (!state.originalCard) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 800);
}

async function saveNow() {
  clearTimeout(saveTimer);
  if (!state.originalCard) return;
  const ok = await saveDraft({
    version: 2,
    originalCard: state.originalCard,
    translatedCard: state.translatedCard,
    passport: state.passport,
    failed: state.failed,
    source: state.source,
    currentImageBytes: state.currentImageBytes
  });
  el.draftStatus.textContent = ok ? `Черновик сохранён в ${formatTime()}` : 'Черновик не сохранён';
}

async function showDraftOffer() {
  const draft = await loadDraft();
  if (!draft?.originalCard || !draft?.translatedCard) {
    el.draftRestore.hidden = true;
    return;
  }
  const name = draft.translatedCard.data?.name || draft.originalCard.data?.name || 'Без имени';
  const date = new Date(draft.savedAt || Date.now());
  el.draftRestoreInfo.textContent = `${name} · сохранено ${date.toLocaleDateString('ru-RU')} в ${formatTime(date)}`;
  el.draftRestore.hidden = false;
}

async function restoreDraft() {
  const draft = await loadDraft();
  if (!draft) return;
  state.originalCard = draft.originalCard;
  state.translatedCard = draft.translatedCard;
  state.passport = draft.passport || null;
  state.failed = draft.failed || {};
  state.source = draft.source || null;
  state.currentImageBytes = draft.currentImageBytes || await createPlaceholderAvatar(state.originalCard.data.name);
  openWorkspace();
  appLog(`Восстановлен черновик «${state.originalCard.data.name}».`, 'success');
}

// ---------------------------------------------------------------------------
// Loading cards
// ---------------------------------------------------------------------------

function createPlaceholderAvatar(name = 'AI') {
  const canvas = document.createElement('canvas');
  canvas.width = 400;
  canvas.height = 600;
  const ctx = canvas.getContext('2d');
  const grad = ctx.createLinearGradient(0, 0, 400, 600);
  grad.addColorStop(0, '#1e1b4b');
  grad.addColorStop(0.5, '#312e81');
  grad.addColorStop(1, '#4338ca');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 400, 600);
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 150px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText((name || 'AI').trim().charAt(0).toUpperCase() || '?', 200, 270);
  ctx.font = '26px sans-serif';
  ctx.fillStyle = '#c7d2fe';
  ctx.fillText((name || 'Character').slice(0, 24), 200, 420);
  return new Promise(resolve => {
    canvas.toBlob(async blob => resolve(new Uint8Array(await blob.arrayBuffer())), 'image/png');
  });
}

function setAvatar(bytes) {
  if (state.avatarUrl) URL.revokeObjectURL(state.avatarUrl);
  state.avatarUrl = URL.createObjectURL(new Blob([bytes], { type: 'image/png' }));
  el.charAvatar.src = state.avatarUrl;
}

function hasTranslationWork() {
  if (!state.originalCard) return false;
  return JSON.stringify(state.originalCard.data) !== JSON.stringify(state.translatedCard.data);
}

async function confirmReplaceCurrent() {
  if (!hasTranslationWork()) return true;
  const choice = await askChoice(
    'Открыть другую карточку?',
    `Текущий перевод «${state.translatedCard.data.name}» будет закрыт, и черновик заменится новой карточкой. Скачайте перевод, если он нужен.`,
    [
      { label: 'Отмена', value: null },
      { label: 'Скачать и открыть', value: 'download', kind: 'btn-success' },
      { label: 'Открыть', value: 'open', kind: 'btn-primary' }
    ]
  );
  if (choice === 'download') downloadTranslatedPNG();
  return Boolean(choice);
}

async function loadCardIntoApp(cardJson, { imageBytes = null, fileName = 'character', kind = 'json', rawBytes = null } = {}) {
  const hadSubObj = hasSubObjMacros(cardJson);
  const normalized = normalizeCard(cardJson);

  state.originalCard = cloneCard(normalized);
  state.translatedCard = cloneCard(normalized);
  state.passport = null;
  state.failed = {};
  state.source = { kind, name: fileName, rawJson: cardJson, bytes: rawBytes };
  state.currentImageBytes = (imageBytes && isPNG(imageBytes))
    ? new Uint8Array(imageBytes)
    : await createPlaceholderAvatar(normalized.data.name);

  openWorkspace();
  saveNow();

  const stats = calculateCardStats(state.originalCard);
  const loreCount = state.originalCard.data.character_book?.entries?.length || 0;
  showToast(`Карточка «${state.originalCard.data.name || 'Персонаж'}» загружена`, 'success');
  appLog(`Карточка «${state.originalCard.data.name || 'Безымянный'}» загружена (${state.originalCard.spec}, ~${stats.estimatedTokens} токенов${loreCount ? `, лорбук: ${loreCount}` : ''}).`, 'success');
  if (hadSubObj) {
    showToast('Макросы JanitorAI {{sub}} / {{obj}} заменены на {{user}}', 'info');
    appLog('Макросы JanitorAI {{sub}} / {{obj}} заменены на {{user}}.');
  }
}

function openWorkspace() {
  el.welcomeView.hidden = true;
  el.workspaceView.hidden = false;
  setAvatar(state.currentImageBytes);
  const spec = state.originalCard.spec === 'chara_card_v3' ? 'V3' : 'V2';
  const loreCount = state.originalCard.data.character_book?.entries?.length || 0;
  el.cardSpecBadge.textContent = loreCount ? `${spec} · лорбук ${loreCount}` : spec;
  renderPassport();
  renderEditor();
  window.scrollTo({ top: 0 });
}

function closeWorkspace() {
  state.originalCard = null;
  state.translatedCard = null;
  state.passport = null;
  state.failed = {};
  state.source = null;
  state.rows = [];
  el.workspaceView.hidden = true;
  el.welcomeView.hidden = false;
  el.editorRows.replaceChildren();
  el.fieldNav.replaceChildren();
  showDraftOffer();
}

async function handleFileUpload(file) {
  if (!file) return;
  if (state.busy) {
    showToast('Дождитесь окончания перевода или остановите его.', 'warning');
    return;
  }
  if (!(await confirmReplaceCurrent())) return;

  const ext = file.name.split('.').pop().toLowerCase();
  appLog(`Загрузка файла: ${file.name} (${(file.size / 1024).toFixed(1)} КБ)...`);

  try {
    if (ext === 'png' || file.type === 'image/png') {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const cardJson = extractCardFromPNG(bytes);
      await loadCardIntoApp(cardJson, { imageBytes: bytes, fileName: file.name, kind: 'png', rawBytes: bytes });
    } else if (ext === 'json' || file.type === 'application/json') {
      const cardJson = JSON.parse(await file.text());
      await loadCardIntoApp(cardJson, { fileName: file.name, kind: 'json' });
    } else {
      showToast('Поддерживаются только PNG и JSON', 'warning');
      appLog(`Неподдерживаемый формат файла: ${ext}`, 'warning');
    }
  } catch (err) {
    showToast(`Не удалось открыть ${file.name}: ${err.message}`, 'error');
    appLog(`Ошибка при открытии ${file.name}: ${err.message}`, 'error');
  }
}

async function handleAvatarUpload(file) {
  if (!file) return;
  try {
    state.currentImageBytes = await convertImageFileToPNGBytes(file);
    setAvatar(state.currentImageBytes);
    scheduleSave();
    showToast('Аватар обновлён — он попадёт в скачанный PNG перевода', 'success');
    appLog(`Аватар персонажа обновлён (${(file.size / 1024).toFixed(1)} КБ).`);
  } catch (err) {
    showToast('Ошибка при смене аватара: ' + err.message, 'error');
    appLog('Ошибка при смене аватара: ' + err.message, 'error');
  }
}

// ---------------------------------------------------------------------------
// Translation
// ---------------------------------------------------------------------------

function setBusy(busy) {
  state.busy = busy;
  el.btnTranslateAll.hidden = busy;
  el.btnCancelTranslation.hidden = !busy;
  el.btnReanalyzePassport.disabled = busy;
  if (!busy) state.busyIds.clear();
  refreshAllRows();
}

function setStep(pill, status) {
  pill.className = `step-pill ${status || ''}`.trim();
}

function showProgress({ text, percent = null, detail = '' }) {
  el.progressPanel.hidden = false;
  if (text !== undefined) el.progressText.textContent = text;
  el.progressDetail.textContent = detail;
  el.progressBar.classList.toggle('indeterminate', percent === null);
  if (percent !== null) el.progressBar.style.width = `${Math.max(2, Math.min(100, percent))}%`;
}

function hideProgressLater() {
  setTimeout(() => {
    if (!state.busy) el.progressPanel.hidden = true;
  }, 4000);
}

async function ensurePassport(signal) {
  if (state.passport) {
    setStep(el.stepPill1, 'skipped');
    el.stepPill1.textContent = '1 · Паспорт (текущий)';
    return;
  }
  el.stepPill1.textContent = '1 · Паспорт';
  setStep(el.stepPill1, 'active');
  setStep(el.stepPill2, '');
  showProgress({ text: 'Анализ персонажа: пол, обращение, тон, глоссарий...' });

  const passport = await analyzeCardContext({
    cardData: state.originalCard.data,
    settings: state.settings,
    signal,
    onDelta: (text) => showProgress({ detail: `Получено ${text.length} символов` })
  });
  state.passport = passport;
  renderPassport();
  setStep(el.stepPill1, 'completed');
  if (passport.failed) {
    showToast('Не удалось составить паспорт персонажа — перевод продолжится без него. Можно заполнить паспорт вручную.', 'warning');
    appLog('Шаг 1: анализ не удался, используется пустой паспорт.', 'warning');
  } else {
    appLog(`Шаг 1: паспорт готов — ${passport.character_name_ru} (${passport.gender}, «${passport.verb_gender}», обращение «${passport.user_pronoun}»), терминов: ${Object.keys(passport.glossary).length}.`, 'success');
  }
}

/**
 * Runs step 1 (if needed) and step 2 for the given units, updating rows live.
 */
async function runTranslation(units, { title = 'Перевод' } = {}) {
  if (state.busy || !units.length) return;
  state.abortController = new AbortController();
  const { signal } = state.abortController;
  units.forEach(u => {
    state.busyIds.add(u.id);
    delete state.failed[u.id];
  });
  setBusy(true);
  appLog(`${title}: ${units.length} фрагм. (${PROVIDER_PRESETS[state.settings.provider]?.name || state.settings.provider}, ${state.settings.model}).`);

  try {
    await ensurePassport(signal);

    setStep(el.stepPill2, 'active');
    showProgress({ text: 'Перевод...', percent: 0 });

    const { results, failed } = await translateUnits({
      units,
      passport: state.passport,
      settings: state.settings,
      signal,
      onProgress: ({ done, total, message, streamedChars }) => {
        showProgress({
          text: `${message} · готово ${done} из ${total}`,
          percent: (done / total) * 100,
          detail: streamedChars ? `Получено ${streamedChars} символов ответа` : ''
        });
      },
      onUnitDone: (id, value) => {
        applyTranslations(state.translatedCard.data, { [id]: value }, state.originalCard.data, state.passport, { inPlace: true });
        state.busyIds.delete(id);
        syncInputFromState(id);
        const row = rowForPath(id);
        if (row) updateRow(row);
        updateSummary();
        scheduleSave();
      }
    });

    for (const f of failed) state.failed[f.id] = f.reason;
    const okCount = Object.keys(results).length;
    setStep(el.stepPill2, failed.length ? '' : 'completed');

    if (failed.length) {
      showProgress({ text: `Переведено ${okCount} из ${units.length}, ошибок: ${failed.length}`, percent: (okCount / units.length) * 100 });
      showToast(`Переведено ${okCount} из ${units.length}. Не удалось: ${failed.map(f => f.label).slice(0, 4).join(', ')}${failed.length > 4 ? '…' : ''}. Нажмите «Повторить неудавшиеся».`, 'warning', { duration: 10000 });
      failed.forEach(f => appLog(`Не переведено «${f.label}»: ${f.reason}`, 'warning'));
    } else {
      showProgress({ text: `Готово: переведено ${okCount}`, percent: 100 });
      showToast(units.length === 1 ? `«${units[0].label}» переведено` : `Перевод завершён: ${okCount} фрагм.`, 'success');
    }
    appLog(`${title}: готово ${okCount}/${units.length}.`, failed.length ? 'warning' : 'success');
  } catch (err) {
    if (err.name === 'AbortError' || signal.aborted) {
      showProgress({ text: 'Перевод остановлен. Уже переведённые поля сохранены.' });
      el.progressBar.classList.remove('indeterminate');
      showToast('Перевод остановлен', 'warning');
      appLog('Перевод остановлен пользователем.', 'warning');
    } else {
      showProgress({ text: `Ошибка: ${err.message}` });
      el.progressBar.classList.remove('indeterminate');
      showToast(err.message, 'error');
      appLog(`Ошибка перевода: ${err.message}`, 'error');
    }
  } finally {
    state.abortController = null;
    setBusy(false);
    scheduleSave();
    hideProgressLater();
  }
}

function allUnits() {
  return buildTranslationUnits(state.originalCard.data, { translateTags: state.settings.translateTags });
}

function isUnitTranslated(unit) {
  return getBound(state.translatedCard.data, unit.id) !== getBound(state.originalCard.data, unit.id);
}

async function handleTranslateAll() {
  if (state.busy || !state.originalCard) return;
  const units = allUnits();
  if (!units.length) {
    showToast('В карточке нечего переводить', 'warning');
    return;
  }
  const pending = units.filter(u => !isUnitTranslated(u));
  let selected = units;

  if (pending.length < units.length) {
    const choice = await askChoice(
      'Часть карточки уже переведена',
      pending.length
        ? `Не переведено фрагментов: ${pending.length} из ${units.length}. «Всё заново» перезапишет и ручные правки.`
        : 'Все фрагменты уже отличаются от оригинала. Перевести всё заново? Ручные правки будут перезаписаны.',
      [
        { label: 'Отмена', value: null },
        { label: 'Всё заново', value: 'all', kind: 'btn-secondary' },
        ...(pending.length ? [{ label: `Только непереведённые (${pending.length})`, value: 'pending', kind: 'btn-accent' }] : [])
      ]
    );
    if (!choice) return;
    selected = choice === 'pending' ? pending : units;
  }

  await runTranslation(selected, { title: 'Перевод карточки' });
}

async function handleTranslateRow(rowId) {
  const row = findRow(rowId);
  if (!row || state.busy) return;
  const paths = new Set(row.binds.map(b => b.path));
  const units = buildTranslationUnits(state.originalCard.data, { translateTags: true }).filter(u => paths.has(u.id));
  if (!units.length) {
    showToast('В оригинале это поле пустое', 'warning');
    return;
  }
  await runTranslation(units, { title: `Перевод «${row.title}»` });
}

async function handleRetryFailed() {
  if (state.busy) return;
  const ids = new Set(Object.keys(state.failed));
  const units = buildTranslationUnits(state.originalCard.data, { translateTags: true }).filter(u => ids.has(u.id));
  if (!units.length) {
    state.failed = {};
    refreshAllRows();
    return;
  }
  await runTranslation(units, { title: 'Повтор неудавшихся' });
}

function handleResetRow(rowId) {
  const row = findRow(rowId);
  if (!row) return;
  const previous = row.binds.map(b => [b.path, getBound(state.translatedCard.data, b.path)]);
  for (const b of row.binds) {
    setBound(state.translatedCard.data, b.path, getBound(state.originalCard.data, b.path));
    delete state.failed[b.path];
    syncInputFromState(b.path);
  }
  updateRow(row);
  updateSummary();
  scheduleSave();
  showToast(`«${row.title}» возвращено к оригиналу`, 'info', {
    action: {
      label: 'Отменить',
      onClick: () => {
        for (const [path, value] of previous) {
          setBound(state.translatedCard.data, path, value);
          syncInputFromState(path);
        }
        updateRow(row);
        updateSummary();
        scheduleSave();
      }
    }
  });
}

async function handleReanalyzePassport() {
  if (state.busy || !state.originalCard) return;
  const previous = state.passport;
  state.passport = null;
  state.abortController = new AbortController();
  setBusy(true);
  try {
    await ensurePassport(state.abortController.signal);
    showProgress({ text: 'Паспорт обновлён', percent: 100 });
    scheduleSave();
  } catch (err) {
    state.passport = previous;
    renderPassport();
    if (err.name !== 'AbortError') {
      showProgress({ text: `Ошибка: ${err.message}` });
      showToast(err.message, 'error');
      appLog(`Ошибка анализа: ${err.message}`, 'error');
    }
  } finally {
    el.progressBar.classList.remove('indeterminate');
    state.abortController = null;
    setBusy(false);
    hideProgressLater();
  }
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  setTimeout(() => {
    a.remove();
    URL.revokeObjectURL(url);
  }, 500);
}

function exportBaseName(card) {
  return safeFileName(card.data.name || state.source?.name?.replace(/\.[^.]+$/, ''));
}

function downloadTranslatedPNG() {
  if (!state.translatedCard) return;
  try {
    const isV3 = state.originalCard.spec === 'chara_card_v3';
    const pngBytes = embedCardInPNG(state.currentImageBytes, {
      chara: toExportJson(state.translatedCard, 'chara_card_v2'),
      ccv3: isV3 ? toExportJson(state.translatedCard, 'chara_card_v3') : null
    });
    const name = `${exportBaseName(state.translatedCard)}_RU.png`;
    triggerDownload(new Blob([pngBytes], { type: 'image/png' }), name);
    showToast(`Сохранено: ${name}`, 'success');
    appLog(`Экспорт: ${name} (${(pngBytes.length / 1024).toFixed(1)} КБ).`, 'success');
  } catch (err) {
    showToast('Ошибка при сборке PNG: ' + err.message, 'error');
    appLog('Ошибка при сборке PNG: ' + err.message, 'error');
  }
}

function downloadTranslatedJSON() {
  const json = JSON.stringify(toExportJson(state.translatedCard), null, 2);
  const name = `${exportBaseName(state.translatedCard)}_RU.json`;
  triggerDownload(new Blob([json], { type: 'application/json;charset=utf-8' }), name);
  showToast(`Сохранено: ${name}`, 'success');
  appLog(`Экспорт: ${name}.`, 'success');
}

async function downloadOriginalPNG() {
  const src = state.source;
  const base = exportBaseName(state.originalCard);
  try {
    let bytes;
    if (src?.kind === 'png' && src.bytes) {
      bytes = src.bytes; // the untouched file, byte for byte
    } else {
      const image = await createPlaceholderAvatar(state.originalCard.data.name);
      bytes = embedCardInPNG(image, { chara: src?.rawJson || toExportJson(state.originalCard) });
    }
    triggerDownload(new Blob([bytes], { type: 'image/png' }), `${base}_ORIGINAL.png`);
    appLog(`Экспорт оригинала: ${base}_ORIGINAL.png.`);
  } catch (err) {
    showToast('Ошибка при экспорте оригинала: ' + err.message, 'error');
  }
}

function downloadOriginalJSON() {
  const raw = state.source?.rawJson || toExportJson(state.originalCard);
  const base = exportBaseName(state.originalCard);
  triggerDownload(new Blob([JSON.stringify(raw, null, 2)], { type: 'application/json;charset=utf-8' }), `${base}_ORIGINAL.json`);
  appLog(`Экспорт оригинала: ${base}_ORIGINAL.json.`);
}

async function handleMenuAction(action) {
  el.exportMenu.open = false;
  if (!state.originalCard) return;
  if (action === 'trans-json') downloadTranslatedJSON();
  else if (action === 'orig-png') downloadOriginalPNG();
  else if (action === 'orig-json') downloadOriginalJSON();
  else if (action === 'copy-all-orig') {
    if (state.busy) return;
    const ok = await askChoice('Сбросить перевод?', 'Все поля перевода станут равны оригиналу. Это нельзя отменить.', [
      { label: 'Отмена', value: null },
      { label: 'Сбросить', value: true, kind: 'btn-danger' }
    ]);
    if (!ok) return;
    state.translatedCard = cloneCard(state.originalCard);
    state.failed = {};
    renderEditor();
    scheduleSave();
    showToast('Перевод сброшен к оригиналу', 'info');
  } else if (action === 'close-card') {
    if (state.busy) return;
    const choice = await askChoice('Закрыть карточку?', 'Черновик будет удалён. Скачайте перевод, если он нужен.', [
      { label: 'Отмена', value: null },
      { label: 'Скачать и закрыть', value: 'download', kind: 'btn-success' },
      { label: 'Закрыть', value: 'close', kind: 'btn-danger' }
    ]);
    if (!choice) return;
    if (choice === 'download') downloadTranslatedPNG();
    await clearDraft();
    closeWorkspace();
  }
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

function updateHeaderModel() {
  const preset = PROVIDER_PRESETS[state.settings.provider];
  el.headerProviderName.textContent = preset?.name || state.settings.provider;
  el.headerModelName.textContent = state.settings.model || 'модель не выбрана';
}

function fillModelSelect(models, selectedId) {
  const options = models.map(m => h('option', { value: m.id }, m.name || m.id));
  options.push(h('option', { value: '__custom__' }, '— другая модель (введите справа) —'));
  el.settingModelSelect.replaceChildren(...options);
  el.settingModelSelect.value = models.some(m => m.id === selectedId) ? selectedId : '__custom__';
}

function updateProviderView(providerId, model) {
  const preset = PROVIDER_PRESETS[providerId] || PROVIDER_PRESETS.custom;
  el.providerHint.textContent = preset.hint;
  fillModelSelect(preset.popularModels || [], model);
  el.settingModelCustom.value = model || preset.defaultModel || '';

  el.localCorsHelp.hidden = !['ollama', 'lmstudio'].includes(providerId);
  el.corsHelpText.textContent = providerId === 'ollama'
    ? 'Запустите Ollama с разрешённым CORS: set OLLAMA_ORIGINS=* && ollama serve'
    : 'В LM Studio: вкладка Developer → Start Server → включите Enable CORS.';
}

function openSettings() {
  const s = state.settings;
  el.settingProvider.value = s.provider;
  el.settingApiKey.value = s.apiKey || '';
  el.settingApiKey.type = 'password';
  el.settingBaseUrl.value = s.baseUrl;
  el.settingTemperature.value = s.temperature;
  el.settingMaxTokens.value = s.maxTokens;
  el.settingStream.checked = s.stream !== false;
  el.settingTranslateTags.checked = s.translateTags !== false;
  el.settingExtraInstructions.value = s.extraInstructions || '';
  updateProviderView(s.provider, s.model);
  el.settingsModal.classList.add('active');
}

function closeSettings() {
  el.settingsModal.classList.remove('active');
}

function saveSettingsFromForm() {
  const selected = el.settingModelSelect.value;
  const model = el.settingModelCustom.value.trim() || (selected !== '__custom__' ? selected : '');
  const temperature = parseFloat(el.settingTemperature.value);
  const maxTokens = parseInt(el.settingMaxTokens.value, 10);

  state.settings = {
    ...DEFAULT_SETTINGS,
    provider: el.settingProvider.value,
    baseUrl: el.settingBaseUrl.value.trim(),
    apiKey: el.settingApiKey.value.trim(),
    model,
    temperature: Number.isFinite(temperature) ? temperature : DEFAULT_SETTINGS.temperature,
    maxTokens: Number.isFinite(maxTokens) && maxTokens > 0 ? maxTokens : DEFAULT_SETTINGS.maxTokens,
    stream: el.settingStream.checked,
    translateTags: el.settingTranslateTags.checked,
    extraInstructions: el.settingExtraInstructions.value.trim()
  };
  saveSettings(state.settings);
  updateHeaderModel();
  closeSettings();
  showToast('Настройки сохранены', 'success');
}

async function refreshModels() {
  el.btnRefreshModels.disabled = true;
  el.btnRefreshModels.textContent = 'Загрузка...';
  const abortCtrl = new AbortController();
  const timer = setTimeout(() => abortCtrl.abort(), 10000);
  try {
    const models = await fetchAvailableModels(
      el.settingBaseUrl.value.trim(),
      el.settingApiKey.value.trim(),
      el.settingProvider.value,
      abortCtrl.signal
    );
    if (!models.length) {
      showToast('Эндпоинт вернул пустой список моделей', 'warning');
      return;
    }
    const current = el.settingModelCustom.value.trim();
    fillModelSelect(models, current);
    if (el.settingModelSelect.value === '__custom__' && !current) {
      el.settingModelSelect.value = models[0].id;
      el.settingModelCustom.value = models[0].id;
    }
    showToast(`Загружено моделей: ${models.length}`, 'success');
  } catch (err) {
    showToast(err.message, 'warning', { duration: 8000 });
  } finally {
    clearTimeout(timer);
    el.btnRefreshModels.disabled = false;
    el.btnRefreshModels.textContent = '↻ Обновить список';
  }
}

// ---------------------------------------------------------------------------
// Assistant
// ---------------------------------------------------------------------------

function openAssistant() {
  if (!state.originalCard) return;
  el.assistantStatusText.textContent = 'Готов к работе';
  el.assistantModal.classList.add('active');
}

function closeAssistant() {
  state.assistantAbort?.abort();
  el.assistantModal.classList.remove('active');
}

function switchAssistantTab(tab) {
  const ask = tab === 'ask';
  el.tabBtnAsk.classList.toggle('active', ask);
  el.tabBtnTransform.classList.toggle('active', !ask);
  el.paneAsk.hidden = !ask;
  el.paneTransform.hidden = ask;
}

/**
 * Wraps an assistant request: the button turns into "Остановить" while it runs.
 */
async function runAssistantTask(button, idleLabel, statusText, task) {
  if (state.assistantAbort) {
    state.assistantAbort.abort();
    return;
  }
  const ctrl = new AbortController();
  state.assistantAbort = ctrl;
  button.textContent = '■ Остановить';
  button.classList.add('btn-danger');
  el.assistantStatusText.textContent = statusText;
  try {
    await task(ctrl.signal);
  } catch (err) {
    if (err.name === 'AbortError' || ctrl.signal.aborted) {
      el.assistantStatusText.textContent = 'Остановлено';
    } else {
      el.assistantStatusText.textContent = 'Ошибка';
      showToast(err.message, 'error');
      appLog(`Ассистент: ${err.message}`, 'error');
    }
  } finally {
    state.assistantAbort = null;
    button.textContent = idleLabel;
    button.classList.remove('btn-danger');
  }
}

function handleAsk() {
  const question = el.assistantQuestionInput.value.trim();
  if (!question && !state.assistantAbort) {
    showToast('Введите вопрос', 'warning');
    return;
  }
  runAssistantTask(el.btnSendQuestion, 'Спросить', 'Модель анализирует карточку...', async (signal) => {
    el.assistantAskResultBox.hidden = false;
    el.assistantAskResultText.textContent = '';
    const answer = await askCharacterAI({
      cardData: state.translatedCard.data,
      question,
      settings: state.settings,
      signal,
      onDelta: (text) => { el.assistantAskResultText.textContent = text; }
    });
    el.assistantAskResultText.textContent = answer;
    el.assistantStatusText.textContent = 'Ответ готов';
    appLog(`Ассистент: ответ получен (${answer.length} симв.).`, 'success');
  });
}

const TRANSFORM_LABELS = Object.fromEntries(TEXT_FIELDS.map(f => [f.key, f.label]));

function handleTransform() {
  const instruction = el.assistantTransformInput.value.trim();
  if (!instruction && !state.assistantAbort) {
    showToast('Опишите, что изменить', 'warning');
    return;
  }
  const source = el.assistantSourceSelect.value === 'original' ? state.originalCard.data : state.translatedCard.data;
  runAssistantTask(el.btnExecuteTransform, 'Выполнить', 'Модель перерабатывает карточку...', async (signal) => {
    el.assistantTransformResultBox.hidden = true;
    const result = await transformCharacterAI({
      cardData: source,
      instruction,
      settings: state.settings,
      signal,
      onDelta: (text) => { el.assistantStatusText.textContent = `Получено ${text.length} символов...`; }
    });
    state.pendingTransform = result;
    el.transformSummaryText.textContent = result.changesSummary;
    el.transformDiffList.replaceChildren(...Object.entries(result.modifiedFields).map(([key, val]) =>
      h('div', { className: 'diff-card' },
        h('div', { className: 'diff-card-head' }, h('span', {}, TRANSFORM_LABELS[key] || key), h('span', {}, `${val.length} симв.`)),
        h('div', { className: 'diff-card-text' }, val)
      )
    ));
    el.assistantTransformResultBox.hidden = false;
    el.assistantStatusText.textContent = 'Готово — проверьте и примените';
    appLog(`Ассистент: трансформация готова (${Object.keys(result.modifiedFields).length} полей).`, 'success');
  });
}

function applyTransform() {
  const modified = state.pendingTransform?.modifiedFields;
  if (!modified) return;
  for (const [key, val] of Object.entries(modified)) {
    state.translatedCard.data[key] = val;
    syncInputFromState(`field:${key}`);
  }
  refreshAllRows();
  scheduleSave();
  closeAssistant();
  state.pendingTransform = null;
  el.assistantTransformResultBox.hidden = true;
  showToast(`Применено полей: ${Object.keys(modified).length}`, 'success');
  appLog(`Ассистент: изменения применены к ${Object.keys(modified).length} полям.`, 'success');
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

function initEvents() {
  const pickFile = () => {
    if (state.busy) {
      showToast('Дождитесь окончания перевода или остановите его.', 'warning');
      return;
    }
    el.fileInput.click();
  };
  el.btnLoadFile.addEventListener('click', pickFile);
  el.btnBrowseCard.addEventListener('click', pickFile);
  el.fileInput.addEventListener('change', (e) => {
    handleFileUpload(e.target.files?.[0]);
    e.target.value = '';
  });

  el.btnLoadDemo.addEventListener('click', async () => {
    if (!(await confirmReplaceCurrent())) return;
    loadCardIntoApp(DEMO_CARD, { fileName: 'Seraphina_Vale.json', kind: 'demo' });
  });
  el.btnRestoreDraft.addEventListener('click', restoreDraft);
  el.btnDiscardDraft.addEventListener('click', async () => {
    await clearDraft();
    el.draftRestore.hidden = true;
  });

  el.avatarContainer.addEventListener('click', () => el.avatarInput.click());
  el.avatarInput.addEventListener('change', (e) => {
    handleAvatarUpload(e.target.files?.[0]);
    e.target.value = '';
  });

  // Translation
  el.btnTranslateAll.addEventListener('click', handleTranslateAll);
  el.btnRetryFailed.addEventListener('click', handleRetryFailed);
  el.btnCancelTranslation.addEventListener('click', () => state.abortController?.abort());

  // Export
  el.btnDownloadTransPng.addEventListener('click', downloadTranslatedPNG);
  el.exportMenu.addEventListener('click', (e) => {
    const action = e.target.closest('[data-menu]')?.dataset.menu;
    if (action) handleMenuAction(action);
  });
  document.addEventListener('click', (e) => {
    if (el.exportMenu.open && !el.exportMenu.contains(e.target)) el.exportMenu.open = false;
  });

  // Editor: inputs
  el.editorRows.addEventListener('input', (e) => {
    const path = e.target.dataset?.bind;
    if (!path || !state.translatedCard) return;
    setBound(state.translatedCard.data, path, e.target.value);
    delete state.failed[path];
    if (e.target.tagName === 'TEXTAREA') autoSize(e.target);
    const row = rowForPath(path);
    if (row) updateRow(row);
    updateSummary();
    scheduleSave();
  });

  // Editor: row buttons
  el.editorRows.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const rowId = btn.closest('.row')?.dataset.row;
    if (!rowId) return;
    if (btn.dataset.act === 'translate') handleTranslateRow(rowId);
    else if (btn.dataset.act === 'reset') handleResetRow(rowId);
  });

  // Field navigation
  el.fieldNav.addEventListener('click', (e) => {
    const rowId = e.target.closest('[data-goto]')?.dataset.goto;
    if (!rowId) return;
    const node = document.getElementById(rowDomId(rowId));
    if (!node) return;
    if (node.classList.contains('is-empty') && el.toggleHideEmpty.checked) {
      el.toggleHideEmpty.checked = false;
      el.editor.classList.remove('hide-empty');
    }
    node.scrollIntoView({ behavior: 'smooth', block: 'start' });
    node.classList.remove('is-flash');
    void node.offsetWidth;
    node.classList.add('is-flash');
  });

  // Textarea heights depend on column width (window resize, page scrollbar appearing)
  let lastEditorWidth = 0;
  new ResizeObserver((entries) => {
    const width = entries[0].contentRect.width;
    if (Math.abs(width - lastEditorWidth) < 1) return;
    lastEditorWidth = width;
    el.editorRows.querySelectorAll('textarea').forEach(autoSize);
  }).observe(el.editorRows);

  el.toggleHideEmpty.addEventListener('change', () => {
    el.editor.classList.toggle('hide-empty', el.toggleHideEmpty.checked);
  });
  el.editor.classList.toggle('hide-empty', el.toggleHideEmpty.checked);

  // Passport
  el.passportContainer.addEventListener('input', (e) => {
    if (!state.passport) return;
    const key = e.target.dataset.passport;
    const mapKey = e.target.dataset.passportMap;
    if (key) state.passport[key] = e.target.value;
    else if (mapKey) state.passport[mapKey] = textToMap(e.target.value);
    else return;
    state.passport.edited = true;
    el.passportBadge.textContent = 'изменён вручную';
    scheduleSave();
  });
  el.btnTogglePassport.addEventListener('click', () => {
    el.passportContent.hidden = !el.passportContent.hidden;
    el.btnTogglePassport.textContent = el.passportContent.hidden ? 'Развернуть' : 'Свернуть';
  });
  el.btnReanalyzePassport.addEventListener('click', handleReanalyzePassport);

  // Drag & drop
  let dragDepth = 0;
  const hasFiles = (e) => Array.from(e.dataTransfer?.types || []).includes('Files');
  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth++;
    if (!state.busy) el.dragOverlay.classList.add('active');
  });
  window.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) el.dragOverlay.classList.remove('active');
  });
  window.addEventListener('dragover', (e) => {
    if (hasFiles(e)) e.preventDefault();
  });
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    el.dragOverlay.classList.remove('active');
    handleFileUpload(e.dataTransfer.files?.[0]);
  });

  // Settings
  el.btnOpenSettings.addEventListener('click', openSettings);
  el.btnModelPill.addEventListener('click', openSettings);
  el.btnCloseSettings.addEventListener('click', closeSettings);
  el.btnCancelSettings.addEventListener('click', closeSettings);
  el.btnSaveSettings.addEventListener('click', saveSettingsFromForm);
  el.btnToggleKeyVisibility.addEventListener('click', () => {
    el.settingApiKey.type = el.settingApiKey.type === 'password' ? 'text' : 'password';
  });
  el.settingProvider.addEventListener('change', (e) => {
    const preset = PROVIDER_PRESETS[e.target.value];
    if (!preset) return;
    el.settingBaseUrl.value = preset.baseUrl;
    updateProviderView(preset.id, preset.defaultModel);
  });
  el.settingModelSelect.addEventListener('change', (e) => {
    if (e.target.value === '__custom__') el.settingModelCustom.focus();
    else el.settingModelCustom.value = e.target.value;
  });
  el.btnRefreshModels.addEventListener('click', refreshModels);

  // Assistant
  el.btnOpenAssistant.addEventListener('click', openAssistant);
  el.btnCloseAssistant.addEventListener('click', closeAssistant);
  el.btnDismissAssistant.addEventListener('click', closeAssistant);
  el.tabBtnAsk.addEventListener('click', () => switchAssistantTab('ask'));
  el.tabBtnTransform.addEventListener('click', () => switchAssistantTab('transform'));
  $('ask-chips-container').addEventListener('click', (e) => {
    const q = e.target.closest('[data-ask]')?.dataset.ask;
    if (q) {
      el.assistantQuestionInput.value = q;
      el.assistantQuestionInput.focus();
    }
  });
  $('transform-chips-container').addEventListener('click', (e) => {
    const t = e.target.closest('[data-transform]')?.dataset.transform;
    if (t) {
      el.assistantTransformInput.value = t;
      el.assistantTransformInput.focus();
    }
  });
  el.btnSendQuestion.addEventListener('click', handleAsk);
  el.btnExecuteTransform.addEventListener('click', handleTransform);
  el.btnApplyTransform.addEventListener('click', applyTransform);
  el.btnCopyAskResult.addEventListener('click', async () => {
    await navigator.clipboard.writeText(el.assistantAskResultText.textContent || '');
    showToast('Ответ скопирован', 'info', { duration: 2000 });
  });

  // Close modals by clicking the backdrop
  for (const [modal, close] of [[el.settingsModal, closeSettings], [el.assistantModal, closeAssistant]]) {
    modal.addEventListener('mousedown', (e) => {
      if (e.target === modal) close();
    });
  }

  // Logs
  el.btnToggleConsole.addEventListener('click', () => { el.logDrawer.hidden = !el.logDrawer.hidden; });
  el.btnCloseLogConsole.addEventListener('click', () => { el.logDrawer.hidden = true; });
  el.btnClearLogs.addEventListener('click', () => {
    el.logBody.replaceChildren();
    logBuffer.length = 0;
    logCounter = 0;
    el.logCountBadge.textContent = '0';
  });
  el.btnCopyLogs.addEventListener('click', async () => {
    await navigator.clipboard.writeText(logBuffer.join('\n'));
    showToast(`Скопировано строк: ${logBuffer.length}`, 'info', { duration: 2000 });
  });

  // Keyboard
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (resolveChoice) resolveChoice(null);
      else if (el.settingsModal.classList.contains('active')) closeSettings();
      else if (el.assistantModal.classList.contains('active')) closeAssistant();
      else if (el.exportMenu.open) el.exportMenu.open = false;
      else if (!el.logDrawer.hidden) el.logDrawer.hidden = true;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's' && state.translatedCard) {
      e.preventDefault();
      downloadTranslatedPNG();
    }
  });

  // Flush the draft when the tab is hidden or closed
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && saveTimer) saveNow();
  });
  window.addEventListener('beforeunload', (e) => {
    if (state.busy) {
      e.preventDefault();
      e.returnValue = '';
    }
  });
}

// Bootstrapping
window.addEventListener('DOMContentLoaded', () => {
  initEvents();
  updateHeaderModel();
  showDraftOffer();
  appLog('Приложение запущено.');
});
