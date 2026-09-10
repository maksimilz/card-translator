/**
 * Main Application Controller
 * Orchestrates Card Loading, PNG Parsing/Embedding, Side-by-side Editor,
 * Batch Translation, Model Settings, and Two-copy Export.
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
  serializeV2Card,
  calculateCardStats,
  countStats,
  TRANSLATABLE_FIELDS
} from './card-parser.js';

import {
  loadSettings,
  saveSettings,
  translateText,
  fetchAvailableModels,
  PROVIDER_PRESETS,
  DEFAULT_PROMPT_RU
} from './translator.js';

// Application State
const state = {
  originalCard: null,
  translatedCard: null,
  originalImageBytes: null,
  currentImageBytes: null,
  avatarUrl: null,
  originalFileName: 'character',
  settings: loadSettings(),
  abortController: null,
  isTranslating: false
};

// Built-in Demo Card for quick testing
const DEMO_CARD = {
  spec: 'chara_card_v2',
  spec_version: '2.0',
  data: {
    name: 'Seraphina Vale',
    description: 'Seraphina is a 27-year-old enigmatic arcane librarian and archivist of forgotten astral lore. She has silver-streaked dark hair, luminous amethyst eyes, and wears an antique velvet coat embroidered with celestial constellations. Despite her quiet demeanor, she possesses a razor-sharp intellect and a subtle, dry sense of humor.',
    personality: 'Curious, scholarly, guarded yet compassionate, dry wit, highly perceptive.',
    scenario: '{{user}} enters the forbidden underground section of the Grand Astral Library during a stormy night, seeking a forbidden manuscript. Seraphina discovers {{user}} inspecting a restricted tome.',
    first_mes: '*Rain lashes relentlessly against the stained-glass arches of the Grand Library. The scent of aged parchment, dried lavender, and ozone fills the chilled air.* \n\n*A soft, rhythmic clicking of heels echoes from behind a row of towering mahogany bookshelves. Seraphina emerges from the shadows, a glowing crystal lantern casting dancing violet hues across her pale face.*\n\n"You are treading on dangerous ground, {{user}}," *she murmurs, tilting her head with a faintly arched eyebrow.* "Those texts were sealed three centuries ago for a reason. Are you lost, or simply reckless?"',
    mes_example: '<START>\n{{user}}: "I only wanted to learn the truth about the Eclipse."\n{{char}}: *Seraphina\'s expression softens slightly, though her guarded posture remains.* "The truth is rarely as romantic as wanderers imagine. But if your resolve is genuine... sit. Let us see if your mind can endure what the stars whisper."',
    creator_notes: 'Designed for immersive fantasy roleplay. Prefers detailed narrative style and atmospheric prose.',
    system_prompt: 'Roleplay as Seraphina Vale. Maintain an enigmatic, intellectual, and atmospheric tone. Never break character.',
    post_history_instructions: 'Keep responses focused on dialogue, atmospheric details, and character reactions.',
    alternate_greetings: [
      '*Seraphina is sitting at a large oak desk surrounded by floating runic scrolls, barely looking up as {{user}} enters.* \n\n"I heard your footsteps from the vestibule. State your purpose quickly, before the library wards take notice."',
      '*The library is in complete silence until a sudden rumble of thunder rattles the crystal chandeliers. Seraphina suddenly appears beside {{user}} with uncanny silence.* \n\n"Seeking forbidden knowledge in the dark? How dreadfully clichéd."'
    ],
    tags: ['fantasy', 'magic', 'librarian', 'scholar', 'mystery'],
    creator: 'TavernMaster',
    character_version: '1.2',
    extensions: {}
  }
};

// DOM Elements
const elements = {
  welcomeView: document.getElementById('welcome-view'),
  workspaceView: document.getElementById('workspace-view'),
  fileInput: document.getElementById('file-input'),
  avatarInput: document.getElementById('avatar-input'),
  btnLoadFile: document.getElementById('btn-load-file'),
  btnBrowseCard: document.getElementById('btn-browse-card'),
  btnLoadDemo: document.getElementById('btn-load-demo'),
  avatarContainer: document.getElementById('avatar-container'),
  charAvatar: document.getElementById('char-avatar'),
  bannerCharName: document.getElementById('banner-char-name'),
  cardSpecBadge: document.getElementById('card-spec-badge'),
  statOrigTokens: document.getElementById('stat-orig-tokens'),
  statTransTokens: document.getElementById('stat-trans-tokens'),
  origFieldsContainer: document.getElementById('orig-fields-container'),
  transFieldsContainer: document.getElementById('trans-fields-container'),
  origFieldsCount: document.getElementById('orig-fields-count'),
  btnTranslateAll: document.getElementById('btn-translate-all'),
  btnCancelTranslation: document.getElementById('btn-cancel-translation'),
  btnCopyAllOrig: document.getElementById('btn-copy-all-orig'),
  btnDownloadTransPng: document.getElementById('btn-download-trans-png'),
  btnDownloadTransJson: document.getElementById('btn-download-trans-json'),
  btnDownloadOrigPng: document.getElementById('btn-download-orig-png'),
  btnDownloadOrigJson: document.getElementById('btn-download-orig-json'),
  batchProgressContainer: document.getElementById('batch-progress-container'),
  batchProgressBar: document.getElementById('batch-progress-bar'),
  // Header status
  headerProviderName: document.getElementById('header-provider-name'),
  headerModelName: document.getElementById('header-model-name'),
  // Settings Modal
  settingsModal: document.getElementById('settings-modal'),
  btnOpenSettings: document.getElementById('btn-open-settings'),
  btnCloseSettings: document.getElementById('btn-close-settings'),
  btnCancelSettings: document.getElementById('btn-cancel-settings'),
  btnSaveSettings: document.getElementById('btn-save-settings'),
  settingProvider: document.getElementById('setting-provider'),
  providerHint: document.getElementById('provider-hint'),
  groupApiKey: document.getElementById('group-api-key'),
  settingApiKey: document.getElementById('setting-api-key'),
  btnToggleKeyVisibility: document.getElementById('btn-toggle-key-visibility'),
  settingBaseUrl: document.getElementById('setting-base-url'),
  settingModelSelect: document.getElementById('setting-model-select'),
  settingModelCustom: document.getElementById('setting-model-custom'),
  btnRefreshModels: document.getElementById('btn-refresh-models'),
  localCorsHelp: document.getElementById('local-cors-help'),
  corsHelpText: document.getElementById('cors-help-text'),
  settingSystemPrompt: document.getElementById('setting-system-prompt'),
  btnResetPrompt: document.getElementById('btn-reset-prompt'),
  settingTemperature: document.getElementById('setting-temperature'),
  settingMaxTokens: document.getElementById('setting-max-tokens'),
  // Overlay & Toasts
  dragOverlay: document.getElementById('drag-overlay'),
  toastContainer: document.getElementById('toast-container')
};

/**
 * Toast Notifications
 */
function showToast(message, type = 'info', duration = 4000) {
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  const icons = { success: '✅', error: '❌', info: 'ℹ️', warning: '⚠️' };
  toast.innerHTML = `<span>${icons[type] || 'ℹ️'}</span><div>${message}</div>`;
  elements.toastContainer.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(-10px)';
    toast.style.transition = 'all 0.3s ease';
    setTimeout(() => toast.remove(), 300);
  }, duration);
}

/**
 * Creates a placeholder PNG avatar canvas when JSON or no image is supplied
 */
function createPlaceholderAvatar(name = 'AI') {
  const canvas = document.createElement('canvas');
  canvas.width = 400;
  canvas.height = 400;
  const ctx = canvas.getContext('2d');

  // Stylish dark gradient
  const grad = ctx.createLinearGradient(0, 0, 400, 400);
  grad.addColorStop(0, '#1e1b4b');
  grad.addColorStop(0.5, '#312e81');
  grad.addColorStop(1, '#4338ca');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 400, 400);

  // Border ring
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
  ctx.lineWidth = 12;
  ctx.strokeRect(10, 10, 380, 380);

  // Initial letter or icon
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 120px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const initial = (name || 'AI').trim().charAt(0).toUpperCase() || '🎭';
  ctx.fillText(initial, 200, 190);

  // Subtitle
  ctx.font = '22px sans-serif';
  ctx.fillStyle = '#c7d2fe';
  ctx.fillText(name.slice(0, 20) || 'Character Card', 200, 290);

  return new Promise(resolve => {
    canvas.toBlob(async blob => {
      const buf = await blob.arrayBuffer();
      resolve(new Uint8Array(buf));
    }, 'image/png');
  });
}

/**
 * Loads and initializes a character card in the application
 */
async function loadCardIntoApp(cardJson, imageBytes = null, fileName = 'character') {
  try {
    const normalized = normalizeCard(cardJson);
    state.originalCard = cloneCard(normalized);
    state.translatedCard = cloneCard(normalized);
    state.originalFileName = fileName.replace(/\.[^/.]+$/, '');

    if (imageBytes && isPNG(imageBytes)) {
      state.originalImageBytes = imageBytes;
      state.currentImageBytes = new Uint8Array(imageBytes);
      const blob = new Blob([imageBytes], { type: 'image/png' });
      state.avatarUrl = URL.createObjectURL(blob);
    } else {
      // Create fallback avatar
      const placeholder = await createPlaceholderAvatar(normalized.data.name);
      state.originalImageBytes = placeholder;
      state.currentImageBytes = new Uint8Array(placeholder);
      const blob = new Blob([placeholder], { type: 'image/png' });
      state.avatarUrl = URL.createObjectURL(blob);
    }

    // Update UI
    elements.welcomeView.style.display = 'none';
    elements.workspaceView.style.display = 'flex';
    elements.charAvatar.src = state.avatarUrl;
    elements.bannerCharName.textContent = state.originalCard.data.name || 'Безымянный персонаж';
    elements.cardSpecBadge.textContent = `${state.originalCard.spec} (v${state.originalCard.spec_version})`;

    renderFields();
    updateCardStats();
    showToast(`Карточка «${state.originalCard.data.name || 'Персонаж'}» успешно загружена!`, 'success');
  } catch (err) {
    showToast('Ошибка при загрузке карточки: ' + err.message, 'error');
  }
}

/**
 * Updates original and translated statistics
 */
function updateCardStats() {
  if (!state.originalCard || !state.translatedCard) return;

  const origStats = calculateCardStats(state.originalCard);
  const transStats = calculateCardStats(state.translatedCard);

  elements.statOrigTokens.textContent = `Оригинал: ~${origStats.estimatedTokens} токенов (${origStats.chars} симв.)`;
  elements.statTransTokens.textContent = `Перевод: ~${transStats.estimatedTokens} токенов (${transStats.chars} симв.)`;
}

/**
 * Renders both original and editable translated columns
 */
function renderFields() {
  elements.origFieldsContainer.innerHTML = '';
  elements.transFieldsContainer.innerHTML = '';

  const origData = state.originalCard.data;
  const transData = state.translatedCard.data;

  // Render Standard Translatable Fields
  TRANSLATABLE_FIELDS.forEach(fieldDef => {
    const origVal = origData[fieldDef.key] || '';
    const transVal = transData[fieldDef.key] || '';

    // Left Column: Original (Read-only)
    const origBox = document.createElement('div');
    origBox.className = 'field-box';
    const origStats = countStats(origVal);
    origBox.innerHTML = `
      <div class="field-header">
        <span class="field-label">${fieldDef.label}</span>
        <button class="btn btn-secondary btn-sm" data-action="copy-orig" data-key="${fieldDef.key}" title="Скопировать исходный текст">
          📋 Копировать
        </button>
      </div>
      <div class="field-readonly" id="orig-val-${fieldDef.key}">${escapeHtml(origVal) || '<em style="color: var(--text-dim)">(пусто)</em>'}</div>
      <div class="field-footer">
        <span>Символов: ${origStats.chars}</span>
        <span>~${origStats.estimatedTokens} токенов</span>
      </div>
    `;
    elements.origFieldsContainer.appendChild(origBox);

    // Right Column: Translated (Editable)
    const transBox = document.createElement('div');
    transBox.className = 'field-box';
    const transStats = countStats(transVal);

    const inputHtml = fieldDef.type === 'textarea'
      ? `<textarea class="field-textarea" id="trans-input-${fieldDef.key}" rows="${fieldDef.rows}">${escapeHtml(transVal)}</textarea>`
      : `<input type="text" class="field-input" id="trans-input-${fieldDef.key}" value="${escapeHtml(transVal)}">`;

    transBox.innerHTML = `
      <div class="field-header">
        <span class="field-label">${fieldDef.label}</span>
        <div class="field-actions">
          <button class="btn btn-accent btn-sm" data-action="translate-field" data-key="${fieldDef.key}" title="Перевести это поле с помощью нейросети">
            🌐 Перевести
          </button>
          <button class="btn btn-secondary btn-sm" data-action="copy-from-orig" data-key="${fieldDef.key}" title="Скопировать из оригинала">
            Копировать оригинал
          </button>
          <button class="btn btn-icon" data-action="clear-field" data-key="${fieldDef.key}" title="Очистить поле">
            🧹
          </button>
        </div>
      </div>
      ${inputHtml}
      <div class="field-footer">
        <span id="trans-stat-${fieldDef.key}">Символов: ${transStats.chars} (~${transStats.estimatedTokens} токенов)</span>
        <span style="color: var(--text-dim);">${fieldDef.description}</span>
      </div>
    `;
    elements.transFieldsContainer.appendChild(transBox);

    // Event listener on right input for real-time state update
    const inputElem = transBox.querySelector(`#trans-input-${fieldDef.key}`);
    inputElem.addEventListener('input', (e) => {
      state.translatedCard.data[fieldDef.key] = e.target.value;
      if (fieldDef.key === 'name') {
        elements.bannerCharName.textContent = e.target.value || state.originalCard.data.name;
      }
      const newStats = countStats(e.target.value);
      const statSpan = transBox.querySelector(`#trans-stat-${fieldDef.key}`);
      if (statSpan) {
        statSpan.textContent = `Символов: ${newStats.chars} (~${newStats.estimatedTokens} токенов)`;
      }
      updateCardStats();
    });
  });

  // Render Alternate Greetings
  renderAlternateGreetings(origData.alternate_greetings || [], transData.alternate_greetings || []);

  // Render Tags
  renderTagsField(origData.tags || [], transData.tags || []);
}

/**
 * Renders Alternate Greetings list
 */
function renderAlternateGreetings(origGreetings, transGreetings) {
  // Left side: original alternate greetings
  const origBox = document.createElement('div');
  origBox.className = 'field-box';
  let origGreetingsHtml = '';
  if (origGreetings.length === 0) {
    origGreetingsHtml = '<div class="field-readonly"><em style="color: var(--text-dim)">Нет альтернативных приветствий</em></div>';
  } else {
    origGreetings.forEach((g, idx) => {
      origGreetingsHtml += `
        <div class="greeting-item">
          <div style="font-size: 0.75rem; color: var(--text-dim); font-weight: 600;">Приветствие #${idx + 1}</div>
          <div class="field-readonly">${escapeHtml(g)}</div>
        </div>
      `;
    });
  }

  origBox.innerHTML = `
    <div class="field-header">
      <span class="field-label">Альтернативные приветствия (${origGreetings.length})</span>
    </div>
    <div class="greetings-list">${origGreetingsHtml}</div>
  `;
  elements.origFieldsContainer.appendChild(origBox);

  // Right side: translated alternate greetings
  const transBox = document.createElement('div');
  transBox.className = 'field-box';
  
  transBox.innerHTML = `
    <div class="field-header">
      <span class="field-label">Альтернативные приветствия (${transGreetings.length})</span>
      <div class="field-actions">
        <button class="btn btn-secondary btn-sm" id="btn-add-alt-greeting">+ Добавить приветствие</button>
      </div>
    </div>
    <div class="greetings-list" id="trans-alt-greetings-list"></div>
  `;
  elements.transFieldsContainer.appendChild(transBox);

  const listContainer = transBox.querySelector('#trans-alt-greetings-list');
  renderTransGreetingsItems(listContainer);

  transBox.querySelector('#btn-add-alt-greeting').addEventListener('click', () => {
    state.translatedCard.data.alternate_greetings.push('');
    renderTransGreetingsItems(listContainer);
    updateCardStats();
  });
}

function renderTransGreetingsItems(container) {
  container.innerHTML = '';
  const greetings = state.translatedCard.data.alternate_greetings || [];

  if (greetings.length === 0) {
    container.innerHTML = '<div style="color: var(--text-dim); font-size: 0.85rem;">Список пуст. Нажмите «Добавить приветствие» или скопируйте из оригинала.</div>';
    return;
  }

  greetings.forEach((g, idx) => {
    const item = document.createElement('div');
    item.className = 'greeting-item';
    const origG = (state.originalCard.data.alternate_greetings || [])[idx] || '';

    item.innerHTML = `
      <div style="display: flex; justify-content: space-between; align-items: center;">
        <span style="font-size: 0.8rem; font-weight: 600; color: #a5b4fc;">Приветствие #${idx + 1}</span>
        <div class="field-actions">
          <button class="btn btn-accent btn-sm" data-action="translate-alt-greeting" data-idx="${idx}" title="Перевести нейросетью">
            🌐 Перевести
          </button>
          <button class="btn btn-secondary btn-sm" data-action="copy-orig-greeting" data-idx="${idx}" title="Вставить из оригинала">
            Копировать оригинал
          </button>
          <button class="btn btn-danger btn-sm" data-action="remove-alt-greeting" data-idx="${idx}" title="Удалить">
            Удалить
          </button>
        </div>
      </div>
      <textarea class="field-textarea" data-idx="${idx}" rows="5">${escapeHtml(g)}</textarea>
    `;

    // Event listener for greeting text edit
    const textarea = item.querySelector('textarea');
    textarea.addEventListener('input', (e) => {
      state.translatedCard.data.alternate_greetings[idx] = e.target.value;
      updateCardStats();
    });

    container.appendChild(item);
  });
}

/**
 * Renders Tags Field
 */
function renderTagsField(origTags, transTags) {
  // Left: Original Tags
  const origBox = document.createElement('div');
  origBox.className = 'field-box';
  const origTagsStr = Array.isArray(origTags) ? origTags.join(', ') : String(origTags);
  origBox.innerHTML = `
    <div class="field-header">
      <span class="field-label">Теги (Tags)</span>
      <button class="btn btn-secondary btn-sm" data-action="copy-orig" data-key="tags">📋 Копировать</button>
    </div>
    <div class="field-readonly">${escapeHtml(origTagsStr) || '<em style="color: var(--text-dim)">(нет тегов)</em>'}</div>
  `;
  elements.origFieldsContainer.appendChild(origBox);

  // Right: Translated Tags
  const transBox = document.createElement('div');
  transBox.className = 'field-box';
  const transTagsStr = Array.isArray(transTags) ? transTags.join(', ') : String(transTags);
  transBox.innerHTML = `
    <div class="field-header">
      <span class="field-label">Теги (Tags, через запятую)</span>
      <div class="field-actions">
        <button class="btn btn-accent btn-sm" data-action="translate-tags">🌐 Перевести</button>
        <button class="btn btn-secondary btn-sm" data-action="copy-orig-tags">Копировать оригинал</button>
      </div>
    </div>
    <input type="text" class="field-input" id="trans-tags-input" value="${escapeHtml(transTagsStr)}">
  `;
  elements.transFieldsContainer.appendChild(transBox);

  transBox.querySelector('#trans-tags-input').addEventListener('input', (e) => {
    const raw = e.target.value;
    state.translatedCard.data.tags = raw.split(',').map(t => t.trim()).filter(Boolean);
  });
}

/**
 * Helper to escape HTML characters
 */
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Translates a single field
 */
async function handleTranslateField(fieldKey) {
  if (state.isTranslating) {
    showToast('Перевод уже выполняется, подождите или отмените его.', 'warning');
    return;
  }

  const origText = state.originalCard.data[fieldKey];
  if (!origText || !origText.trim()) {
    showToast(`Поле «${fieldKey}» в оригинале пустое.`, 'warning');
    return;
  }

  const fieldDef = TRANSLATABLE_FIELDS.find(f => f.key === fieldKey);
  const fieldLabel = fieldDef ? fieldDef.label : fieldKey;

  const btn = document.querySelector(`[data-action="translate-field"][data-key="${fieldKey}"]`);
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '⏳ Переводим...';
  }

  state.isTranslating = true;
  state.abortController = new AbortController();

  try {
    const translated = await translateText({
      text: origText,
      fieldLabel,
      charName: state.translatedCard.data.name || state.originalCard.data.name,
      settings: state.settings,
      signal: state.abortController.signal
    });

    state.translatedCard.data[fieldKey] = translated;
    const inputElem = document.getElementById(`trans-input-${fieldKey}`);
    if (inputElem) {
      inputElem.value = translated;
      if (fieldKey === 'name') {
        elements.bannerCharName.textContent = translated;
      }
    }
    const newStats = countStats(translated);
    const statSpan = document.getElementById(`trans-stat-${fieldKey}`);
    if (statSpan) {
      statSpan.textContent = `Символов: ${newStats.chars} (~${newStats.estimatedTokens} токенов)`;
    }
    updateCardStats();
    showToast(`Поле «${fieldLabel}» успешно переведено!`, 'success');
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    state.isTranslating = false;
    state.abortController = null;
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '🌐 Перевести';
    }
  }
}

/**
 * Translates single alternate greeting
 */
async function handleTranslateAltGreeting(idx) {
  const origText = (state.originalCard.data.alternate_greetings || [])[idx];
  if (!origText || !origText.trim()) {
    showToast('Исходное приветствие пустое', 'warning');
    return;
  }

  const btn = document.querySelector(`[data-action="translate-alt-greeting"][data-idx="${idx}"]`);
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '⏳...';
  }

  state.abortController = new AbortController();
  state.isTranslating = true;

  try {
    const translated = await translateText({
      text: origText,
      fieldLabel: `Альтернативное приветствие #${idx + 1}`,
      charName: state.translatedCard.data.name || state.originalCard.data.name,
      settings: state.settings,
      signal: state.abortController.signal
    });

    state.translatedCard.data.alternate_greetings[idx] = translated;
    const textarea = document.querySelector(`.greeting-item textarea[data-idx="${idx}"]`);
    if (textarea) textarea.value = translated;
    updateCardStats();
    showToast(`Приветствие #${idx + 1} переведено!`, 'success');
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    state.isTranslating = false;
    state.abortController = null;
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '🌐 Перевести';
    }
  }
}

/**
 * Translates Tags
 */
async function handleTranslateTags() {
  const origTags = state.originalCard.data.tags || [];
  const origText = Array.isArray(origTags) ? origTags.join(', ') : String(origTags);
  if (!origText.trim()) {
    showToast('Оригинальные теги пусты', 'warning');
    return;
  }

  const btn = document.querySelector('[data-action="translate-tags"]');
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '⏳...';
  }

  try {
    const translated = await translateText({
      text: origText,
      fieldLabel: 'Список тегов через запятую',
      charName: state.translatedCard.data.name || state.originalCard.data.name,
      settings: state.settings
    });

    const parsedTags = translated.split(',').map(t => t.trim()).filter(Boolean);
    state.translatedCard.data.tags = parsedTags;
    const input = document.getElementById('trans-tags-input');
    if (input) input.value = parsedTags.join(', ');
    showToast('Теги успешно переведены!', 'success');
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '🌐 Перевести';
    }
  }
}

/**
 * Batch translation of all card fields
 */
async function handleTranslateAll() {
  if (state.isTranslating) return;
  if (!state.originalCard) return;

  const fieldsToTranslate = [];
  // Standard fields
  for (const f of TRANSLATABLE_FIELDS) {
    const val = state.originalCard.data[f.key];
    if (val && val.trim()) {
      fieldsToTranslate.push({ type: 'standard', key: f.key, label: f.label });
    }
  }
  // Alternate greetings
  const altG = state.originalCard.data.alternate_greetings || [];
  for (let i = 0; i < altG.length; i++) {
    if (altG[i] && altG[i].trim()) {
      fieldsToTranslate.push({ type: 'alt_greeting', idx: i, label: `Приветствие #${i + 1}` });
    }
  }
  // Tags
  const tags = state.originalCard.data.tags || [];
  if (tags.length > 0) {
    fieldsToTranslate.push({ type: 'tags', label: 'Теги' });
  }

  if (fieldsToTranslate.length === 0) {
    showToast('Нет заполненных полей для перевода', 'warning');
    return;
  }

  state.isTranslating = true;
  state.abortController = new AbortController();

  elements.btnTranslateAll.style.display = 'none';
  elements.btnCancelTranslation.style.display = 'inline-flex';
  elements.batchProgressContainer.style.display = 'block';
  elements.batchProgressBar.style.width = '0%';

  let completed = 0;
  showToast(`Запущен перевод карточки (${fieldsToTranslate.length} полей)...`, 'info');

  try {
    for (const item of fieldsToTranslate) {
      if (state.abortController?.signal.aborted) break;

      if (item.type === 'standard') {
        const origText = state.originalCard.data[item.key];
        const res = await translateText({
          text: origText,
          fieldLabel: item.label,
          charName: state.translatedCard.data.name || state.originalCard.data.name,
          settings: state.settings,
          signal: state.abortController.signal
        });
        state.translatedCard.data[item.key] = res;
        const elem = document.getElementById(`trans-input-${item.key}`);
        if (elem) {
          elem.value = res;
          if (item.key === 'name') elements.bannerCharName.textContent = res;
        }
      } else if (item.type === 'alt_greeting') {
        const origText = state.originalCard.data.alternate_greetings[item.idx];
        const res = await translateText({
          text: origText,
          fieldLabel: item.label,
          charName: state.translatedCard.data.name || state.originalCard.data.name,
          settings: state.settings,
          signal: state.abortController.signal
        });
        state.translatedCard.data.alternate_greetings[item.idx] = res;
        const elem = document.querySelector(`.greeting-item textarea[data-idx="${item.idx}"]`);
        if (elem) elem.value = res;
      } else if (item.type === 'tags') {
        const origTags = state.originalCard.data.tags || [];
        const origText = Array.isArray(origTags) ? origTags.join(', ') : String(origTags);
        const res = await translateText({
          text: origText,
          fieldLabel: item.label,
          charName: state.translatedCard.data.name || state.originalCard.data.name,
          settings: state.settings,
          signal: state.abortController.signal
        });
        const parsed = res.split(',').map(t => t.trim()).filter(Boolean);
        state.translatedCard.data.tags = parsed;
        const elem = document.getElementById('trans-tags-input');
        if (elem) elem.value = parsed.join(', ');
      }

      completed++;
      const percent = Math.round((completed / fieldsToTranslate.length) * 100);
      elements.batchProgressBar.style.width = `${percent}%`;
      updateCardStats();
    }

    showToast('Перевод всей карточки успешно завершен!', 'success');
  } catch (err) {
    if (err.message.includes('отменен')) {
      showToast('Перевод был остановлен пользователем.', 'warning');
    } else {
      showToast('Ошибка пакетного перевода: ' + err.message, 'error');
    }
  } finally {
    state.isTranslating = false;
    state.abortController = null;
    elements.btnTranslateAll.style.display = 'inline-flex';
    elements.btnCancelTranslation.style.display = 'none';
    setTimeout(() => {
      elements.batchProgressContainer.style.display = 'none';
    }, 1500);
  }
}

/**
 * Downloads a Blob as a file to the user's computer
 */
function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 200);
}

/**
 * Export Translated PNG
 */
function downloadTranslatedPNG() {
  if (!state.translatedCard || !state.currentImageBytes) return;

  try {
    const cardData = serializeV2Card(state.translatedCard);
    const pngBytes = embedCardInPNG(state.currentImageBytes, cardData);
    const blob = new Blob([pngBytes], { type: 'image/png' });
    const name = (state.translatedCard.data.name || state.originalFileName || 'character')
      .replace(/[^a-zA-Z0-9а-яА-ЯёЁ_-]/g, '_');
    triggerDownload(blob, `${name}_RU.png`);
    showToast(`Переведенная карточка «${name}_RU.png» сохранена!`, 'success');
  } catch (err) {
    showToast('Ошибка при сборке PNG: ' + err.message, 'error');
  }
}

/**
 * Export Translated JSON
 */
function downloadTranslatedJSON() {
  if (!state.translatedCard) return;

  const cardData = serializeV2Card(state.translatedCard);
  const jsonStr = JSON.stringify(cardData, null, 2);
  const blob = new Blob([jsonStr], { type: 'application/json;charset=utf-8' });
  const name = (state.translatedCard.data.name || state.originalFileName || 'character')
    .replace(/[^a-zA-Z0-9а-яА-ЯёЁ_-]/g, '_');
  triggerDownload(blob, `${name}_RU.json`);
  showToast(`JSON перевода «${name}_RU.json» сохранен!`, 'success');
}

/**
 * Export Original PNG
 */
function downloadOriginalPNG() {
  if (!state.originalCard || !state.originalImageBytes) return;

  try {
    const cardData = serializeV2Card(state.originalCard);
    const pngBytes = embedCardInPNG(state.originalImageBytes, cardData);
    const blob = new Blob([pngBytes], { type: 'image/png' });
    const name = (state.originalCard.data.name || state.originalFileName || 'character')
      .replace(/[^a-zA-Z0-9а-яА-ЯёЁ_-]/g, '_');
    triggerDownload(blob, `${name}_ORIGINAL.png`);
    showToast(`Оригинальная карточка «${name}_ORIGINAL.png» сохранена!`, 'success');
  } catch (err) {
    showToast('Ошибка при экспорте оригинала: ' + err.message, 'error');
  }
}

/**
 * Export Original JSON
 */
function downloadOriginalJSON() {
  if (!state.originalCard) return;

  const cardData = serializeV2Card(state.originalCard);
  const jsonStr = JSON.stringify(cardData, null, 2);
  const blob = new Blob([jsonStr], { type: 'application/json;charset=utf-8' });
  const name = (state.originalCard.data.name || state.originalFileName || 'character')
    .replace(/[^a-zA-Z0-9а-яА-ЯёЁ_-]/g, '_');
  triggerDownload(blob, `${name}_ORIGINAL.json`);
  showToast(`Оригинальный JSON «${name}_ORIGINAL.json» сохранен!`, 'success');
}

/**
 * Handles File Upload (PNG or JSON)
 */
async function handleFileUpload(file) {
  if (!file) return;

  const fileName = file.name;
  const ext = fileName.split('.').pop().toLowerCase();

  if (ext === 'png') {
    try {
      const buffer = await file.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      const cardJson = extractCardFromPNG(bytes);
      await loadCardIntoApp(cardJson, bytes, fileName);
    } catch (err) {
      showToast('Ошибка при чтении PNG: ' + err.message, 'error');
    }
  } else if (ext === 'json') {
    try {
      const text = await file.text();
      const cardJson = JSON.parse(text);
      await loadCardIntoApp(cardJson, null, fileName);
    } catch (err) {
      showToast('Ошибка парсинга JSON файла: ' + err.message, 'error');
    }
  } else {
    showToast('Поддерживаются только форматы PNG и JSON', 'warning');
  }
}

/**
 * Handles Avatar Replacement
 */
async function handleAvatarUpload(file) {
  if (!file) return;

  try {
    const pngBytes = await convertImageFileToPNGBytes(file);
    state.currentImageBytes = pngBytes;
    if (state.avatarUrl) URL.revokeObjectURL(state.avatarUrl);
    const blob = new Blob([pngBytes], { type: 'image/png' });
    state.avatarUrl = URL.createObjectURL(blob);
    elements.charAvatar.src = state.avatarUrl;
    showToast('Аватар персонажа успешно обновлен!', 'success');
  } catch (err) {
    showToast('Ошибка при смене аватара: ' + err.message, 'error');
  }
}

/**
 * Settings Modal Logic
 */
function updateSettingsModalUI() {
  const s = state.settings;
  elements.settingProvider.value = s.provider;
  elements.settingApiKey.value = s.apiKey || '';
  elements.settingBaseUrl.value = s.baseUrl;
  elements.settingSystemPrompt.value = s.systemPrompt || DEFAULT_PROMPT_RU;
  elements.settingTemperature.value = s.temperature;
  elements.settingMaxTokens.value = s.maxTokens;

  // Header status indicator
  const pDef = PROVIDER_PRESETS[s.provider] || { name: s.provider };
  elements.headerProviderName.textContent = pDef.name;
  elements.headerModelName.textContent = s.model || 'не выбрана';

  // Provider specific details
  updateProviderView(s.provider);
}

function updateProviderView(providerId) {
  const preset = PROVIDER_PRESETS[providerId] || PROVIDER_PRESETS.openrouter;
  elements.providerHint.textContent = preset.hint;

  if (preset.needsKey) {
    elements.groupApiKey.style.display = 'flex';
  } else {
    elements.groupApiKey.style.display = 'flex'; // allow key for custom endpoints too
  }

  // Model list
  elements.settingModelSelect.innerHTML = '';
  if (preset.popularModels && preset.popularModels.length > 0) {
    preset.popularModels.forEach(m => {
      const opt = document.createElement('option');
      opt.value = m.id;
      opt.textContent = m.name;
      elements.settingModelSelect.appendChild(opt);
    });
    const customOpt = document.createElement('option');
    customOpt.value = '__custom__';
    customOpt.textContent = '— Указать другую модель вручную —';
    elements.settingModelSelect.appendChild(customOpt);
  }

  // Populate model custom field
  elements.settingModelCustom.value = state.settings.model || preset.defaultModel;
  if (preset.popularModels?.some(m => m.id === state.settings.model)) {
    elements.settingModelSelect.value = state.settings.model;
  } else {
    elements.settingModelSelect.value = '__custom__';
  }

  // Local CORS help banner
  if (providerId === 'ollama') {
    elements.localCorsHelp.style.display = 'block';
    elements.corsHelpText.innerHTML = `Для доступа из браузера запустите Ollama с CORS:<br><code class="code-pill">set OLLAMA_ORIGINS=* &amp;&amp; ollama serve</code>`;
  } else if (providerId === 'lmstudio') {
    elements.localCorsHelp.style.display = 'block';
    elements.corsHelpText.innerHTML = `В LM Studio перейдите во вкладку <strong>Developer / Local Server</strong>, нажмите <strong>Start Server</strong> и включите галочку <strong>Enable CORS</strong>.`;
  } else {
    elements.localCorsHelp.style.display = 'none';
  }
}

/**
 * Event Listeners Initialization
 */
function initEvents() {
  // File inputs
  elements.btnLoadFile.addEventListener('click', () => elements.fileInput.click());
  elements.btnBrowseCard.addEventListener('click', () => elements.fileInput.click());
  elements.fileInput.addEventListener('change', (e) => {
    if (e.target.files?.[0]) handleFileUpload(e.target.files[0]);
    e.target.value = '';
  });

  // Demo card
  elements.btnLoadDemo.addEventListener('click', () => {
    loadCardIntoApp(DEMO_CARD, null, 'Seraphina_Vale');
  });

  // Avatar change
  elements.avatarContainer.addEventListener('click', () => elements.avatarInput.click());
  elements.avatarInput.addEventListener('change', (e) => {
    if (e.target.files?.[0]) handleAvatarUpload(e.target.files[0]);
    e.target.value = '';
  });

  // Batch Translation Actions
  elements.btnTranslateAll.addEventListener('click', handleTranslateAll);
  elements.btnCancelTranslation.addEventListener('click', () => {
    if (state.abortController) {
      state.abortController.abort();
    }
  });

  // Copy All Original to Translation
  elements.btnCopyAllOrig.addEventListener('click', () => {
    if (!state.originalCard) return;
    if (confirm('Скопировать все оригинальные поля в колонку перевода? Текущие правки будут перезаписаны.')) {
      state.translatedCard = cloneCard(state.originalCard);
      renderFields();
      updateCardStats();
      showToast('Все поля скопированы из оригинала.', 'info');
    }
  });

  // Export Buttons
  elements.btnDownloadTransPng.addEventListener('click', downloadTranslatedPNG);
  elements.btnDownloadTransJson.addEventListener('click', downloadTranslatedJSON);
  elements.btnDownloadOrigPng.addEventListener('click', downloadOriginalPNG);
  elements.btnDownloadOrigJson.addEventListener('click', downloadOriginalJSON);

  // Column Action Delegation (Copy orig, translate field, clear)
  document.addEventListener('click', (e) => {
    const target = e.target.closest('button');
    if (!target) return;

    const action = target.getAttribute('data-action');
    const key = target.getAttribute('data-key');
    const idx = target.getAttribute('data-idx');

    if (action === 'copy-orig' && key) {
      const val = state.originalCard.data[key];
      navigator.clipboard.writeText(val || '');
      showToast(`Поле «${key}» скопировано в буфер!`, 'info', 2000);
    } else if (action === 'copy-from-orig' && key) {
      const val = state.originalCard.data[key];
      state.translatedCard.data[key] = val;
      const input = document.getElementById(`trans-input-${key}`);
      if (input) input.value = val;
      if (key === 'name') elements.bannerCharName.textContent = val;
      updateCardStats();
      showToast(`Скопировано из оригинала`, 'info', 1500);
    } else if (action === 'clear-field' && key) {
      state.translatedCard.data[key] = '';
      const input = document.getElementById(`trans-input-${key}`);
      if (input) input.value = '';
      if (key === 'name') elements.bannerCharName.textContent = '';
      updateCardStats();
    } else if (action === 'translate-field' && key) {
      handleTranslateField(key);
    } else if (action === 'translate-alt-greeting' && idx !== null) {
      handleTranslateAltGreeting(parseInt(idx, 10));
    } else if (action === 'copy-orig-greeting' && idx !== null) {
      const origG = (state.originalCard.data.alternate_greetings || [])[parseInt(idx, 10)] || '';
      state.translatedCard.data.alternate_greetings[parseInt(idx, 10)] = origG;
      const textarea = document.querySelector(`.greeting-item textarea[data-idx="${idx}"]`);
      if (textarea) textarea.value = origG;
      updateCardStats();
      showToast('Приветствие скопировано из оригинала', 'info', 1500);
    } else if (action === 'remove-alt-greeting' && idx !== null) {
      state.translatedCard.data.alternate_greetings.splice(parseInt(idx, 10), 1);
      const container = document.getElementById('trans-alt-greetings-list');
      renderTransGreetingsItems(container);
      updateCardStats();
    } else if (action === 'translate-tags') {
      handleTranslateTags();
    } else if (action === 'copy-orig-tags') {
      const origTags = state.originalCard.data.tags || [];
      state.translatedCard.data.tags = [...origTags];
      const input = document.getElementById('trans-tags-input');
      if (input) input.value = origTags.join(', ');
      showToast('Теги скопированы из оригинала', 'info', 1500);
    }
  });

  // Drag and Drop (Global Window)
  window.addEventListener('dragenter', (e) => {
    e.preventDefault();
    elements.dragOverlay.classList.add('active');
  });

  elements.dragOverlay.addEventListener('dragleave', (e) => {
    e.preventDefault();
    if (e.relatedTarget === null) {
      elements.dragOverlay.classList.remove('active');
    }
  });

  window.addEventListener('dragover', (e) => e.preventDefault());

  window.addEventListener('drop', (e) => {
    e.preventDefault();
    elements.dragOverlay.classList.remove('active');
    if (e.dataTransfer.files?.[0]) {
      handleFileUpload(e.dataTransfer.files[0]);
    }
  });

  // Settings Modal Controls
  elements.btnOpenSettings.addEventListener('click', () => {
    updateSettingsModalUI();
    elements.settingsModal.classList.add('active');
  });

  const closeSettings = () => elements.settingsModal.classList.remove('active');
  elements.btnCloseSettings.addEventListener('click', closeSettings);
  elements.btnCancelSettings.addEventListener('click', closeSettings);

  // Toggle API key password visibility
  elements.btnToggleKeyVisibility.addEventListener('click', () => {
    const isPass = elements.settingApiKey.type === 'password';
    elements.settingApiKey.type = isPass ? 'text' : 'password';
  });

  // Provider changed in modal
  elements.settingProvider.addEventListener('change', (e) => {
    const pId = e.target.value;
    const preset = PROVIDER_PRESETS[pId];
    if (preset) {
      elements.settingBaseUrl.value = preset.baseUrl;
      updateProviderView(pId);
    }
  });

  // Model select changed in modal
  elements.settingModelSelect.addEventListener('change', (e) => {
    if (e.target.value === '__custom__') {
      elements.settingModelCustom.focus();
    } else {
      elements.settingModelCustom.value = e.target.value;
    }
  });

  // Reset prompt to default
  elements.btnResetPrompt.addEventListener('click', () => {
    elements.settingSystemPrompt.value = DEFAULT_PROMPT_RU;
  });

  // Refresh models list from API
  elements.btnRefreshModels.addEventListener('click', async () => {
    const baseUrl = elements.settingBaseUrl.value.trim();
    const apiKey = elements.settingApiKey.value.trim();
    const provider = elements.settingProvider.value;

    elements.btnRefreshModels.disabled = true;
    elements.btnRefreshModels.innerHTML = '⏳ Загрузка...';

    try {
      const models = await fetchAvailableModels(baseUrl, apiKey, provider);
      if (models.length === 0) {
        showToast('Список моделей пуст или не поддерживается эндпоинтом', 'warning');
      } else {
        elements.settingModelSelect.innerHTML = '';
        models.forEach(m => {
          const opt = document.createElement('option');
          opt.value = m.id;
          opt.textContent = m.name || m.id;
          elements.settingModelSelect.appendChild(opt);
        });
        const customOpt = document.createElement('option');
        customOpt.value = '__custom__';
        customOpt.textContent = '— Указать другую модель вручную —';
        elements.settingModelSelect.appendChild(customOpt);

        if (models[0]) {
          elements.settingModelSelect.value = models[0].id;
          elements.settingModelCustom.value = models[0].id;
        }
        showToast(`Успешно загружено ${models.length} моделей!`, 'success');
      }
    } catch (err) {
      showToast(err.message, 'error', 6000);
    } finally {
      elements.btnRefreshModels.disabled = false;
      elements.btnRefreshModels.innerHTML = '🔄 Обновить список моделей';
    }
  });

  // Save Settings
  elements.btnSaveSettings.addEventListener('click', () => {
    const chosenModel = elements.settingModelCustom.value.trim() ||
      (elements.settingModelSelect.value !== '__custom__' ? elements.settingModelSelect.value : '');

    state.settings = {
      provider: elements.settingProvider.value,
      baseUrl: elements.settingBaseUrl.value.trim(),
      apiKey: elements.settingApiKey.value.trim(),
      model: chosenModel,
      systemPrompt: elements.settingSystemPrompt.value.trim(),
      temperature: parseFloat(elements.settingTemperature.value) || 0.3,
      maxTokens: parseInt(elements.settingMaxTokens.value, 10) || 4096
    };

    saveSettings(state.settings);
    updateSettingsModalUI();
    closeSettings();
    showToast('Настройки успешно сохранены!', 'success');
  });
}

// Bootstrapping
window.addEventListener('DOMContentLoaded', () => {
  initEvents();
  updateSettingsModalUI();
});
