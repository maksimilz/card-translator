// Tests for the real browser modules. Run: node --test tests/
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { extractCardFromPNG, embedCardInPNG } from '../js/png-chunks.js';
import { normalizeCard, toExportJson, replaceSubObj, hasSubObjMacros } from '../js/card-parser.js';
import {
  extractTaggedFields,
  repairMacrosAndTags,
  checkFormatting,
  cleanModelPreamble,
  buildTranslationUnits,
  packBatches,
  translateUnits,
  applyTranslations,
  chatCompletion
} from '../js/translator.js';

const demoPng = new Uint8Array(readFileSync(new URL('../demo/sample_character_card.png', import.meta.url)));

const settings = {
  provider: 'custom',
  baseUrl: 'http://llm.test/v1',
  apiKey: 'k',
  model: 'm',
  temperature: 0.3,
  maxTokens: 8192,
  stream: true,
  extraInstructions: ''
};

// ---------------------------------------------------------------------------
// PNG
// ---------------------------------------------------------------------------

describe('png-chunks', () => {
  test('demo card round-trips through embed/extract', () => {
    const card = extractCardFromPNG(demoPng);
    const out = embedCardInPNG(demoPng, toExportJson(normalizeCard(card)));
    assert.equal(extractCardFromPNG(out).data.name, card.data.name);
  });

  test('V3 cards keep both chara and ccv3 chunks; extract prefers ccv3', () => {
    const v3 = normalizeCard({ spec: 'chara_card_v3', spec_version: '3.0', data: { name: 'X', nickname: 'Nick' } });
    const out = embedCardInPNG(demoPng, {
      chara: toExportJson(v3, 'chara_card_v2'),
      ccv3: toExportJson(v3, 'chara_card_v3')
    });
    const read = extractCardFromPNG(out);
    assert.equal(read.spec, 'chara_card_v3');
    assert.equal(read.data.nickname, 'Nick');
  });

  test('Cyrillic and emoji survive base64 encoding', () => {
    const out = embedCardInPNG(demoPng, { spec: 'chara_card_v2', data: { name: 'Серафина 🌙' } });
    assert.equal(extractCardFromPNG(out).data.name, 'Серафина 🌙');
  });
});

// ---------------------------------------------------------------------------
// Card parser
// ---------------------------------------------------------------------------

describe('card-parser', () => {
  test('V3-only and unknown fields are preserved', () => {
    const card = normalizeCard({
      spec: 'chara_card_v3',
      spec_version: '3.0',
      data: { name: 'X', nickname: 'N', group_only_greetings: ['g'], assets: [{ type: 'icon' }], creation_date: 1, custom_app_field: true }
    });
    assert.equal(card.spec, 'chara_card_v3');
    for (const key of ['nickname', 'group_only_greetings', 'assets', 'creation_date', 'custom_app_field']) {
      assert.ok(key in card.data, key);
    }
  });

  test('V1 flat cards are wrapped', () => {
    const card = normalizeCard({ name: 'Flat', description: 'd', first_mes: 'hi' });
    assert.equal(card.spec, 'chara_card_v2');
    assert.equal(card.data.name, 'Flat');
    assert.equal(card.data.first_mes, 'hi');
  });

  test('JanitorAI {{sub}}/{{obj}} macros become {{user}} everywhere', () => {
    assert.equal(replaceSubObj('{{sub}} meets {{obj}}, {sub}, {{{ OBJ }}}'), '{{user}} meets {{user}}, {{user}}, {{user}}');
    assert.equal(replaceSubObj('A subject of objective talk'), 'A subject of objective talk');
    assert.equal(hasSubObjMacros({ a: 'x {{obj}}' }), true);
    const card = normalizeCard({
      data: {
        name: 'J', description: '{{sub}} here',
        alternate_greetings: ['hi {{obj}}'],
        character_book: { entries: [{ keys: ['{{sub}}'], content: 'about {{obj}}' }] }
      }
    });
    assert.equal(card.data.description, '{{user}} here');
    assert.equal(card.data.alternate_greetings[0], 'hi {{user}}');
    assert.deepEqual(card.data.character_book.entries[0].keys, ['{{user}}']);
  });

  test('lorebook entries stored as an object are converted to an array', () => {
    const card = normalizeCard({ data: { name: 'L', character_book: { entries: { 0: { keys: 'a, b', content: 'c' } } } } });
    assert.deepEqual(card.data.character_book.entries[0].keys, ['a', 'b']);
  });
});

// ---------------------------------------------------------------------------
// Text processing
// ---------------------------------------------------------------------------

describe('text processing', () => {
  test('extractTaggedFields: a block missing its closing tag does not swallow later fields', () => {
    const { fields, unclosed } = extractTaggedFields(
      '<field id="field:name">Имя</field>\n<field id="field:description">Без закрытия\n<field id="field:personality">Характер</field>'
    );
    assert.equal(fields['field:name'], 'Имя');
    assert.equal(fields['field:description'], 'Без закрытия');
    assert.equal(fields['field:personality'], 'Характер');
    assert.deepEqual(unclosed, ['field:description']);
  });

  test('extractTaggedFields: card-internal XML tags are kept as content', () => {
    const { fields } = extractTaggedFields('<field id="field:description"><personality>застенчивая</personality>\nтекст</field>');
    assert.equal(fields['field:description'], '<personality>застенчивая</personality>\nтекст');
  });

  test('repairMacrosAndTags fixes translated macros but leaves {{persona}} alone', () => {
    assert.equal(
      repairMacrosAndTags('{{персонаж}} и {{пользователя}}, {char}, [START], {{персона}}, {{sub}}'),
      '{{char}} и {{user}}, {{char}}, <START>, {{persona}}, {{user}}'
    );
  });

  test('checkFormatting reports lost macros and unpaired asterisks, accepts valid markdown', () => {
    assert.deepEqual(checkFormatting('*smiles* at {{user}}', '*улыбается*'), ['{{user}}: было 1, стало 0']);
    assert.deepEqual(checkFormatting('*smiles* softly', '*улыбается мягко'), ['Непарная звёздочка *']);
    assert.deepEqual(checkFormatting('**Bold** text', '**Жирный** текст'), []);
  });

  test('cleanModelPreamble strips reasoning and code fences', () => {
    assert.equal(cleanModelPreamble('<think>hmm</think>\n```xml\n<field id="a">x</field>\n```'), '<field id="a">x</field>');
  });
});

// ---------------------------------------------------------------------------
// Units, batches, apply
// ---------------------------------------------------------------------------

const sampleData = () => normalizeCard({
  spec: 'chara_card_v2',
  data: {
    name: 'Seraphina',
    description: 'A librarian.',
    first_mes: '*She looks at {{user}}.*',
    alternate_greetings: ['Hello there.'],
    tags: ['fantasy', 'magic'],
    character_book: { name: 'Lore', entries: [{ keys: ['Eclipse'], secondary_keys: ['ritual'], content: 'A ritual.', comment: 'Eclipse' }] }
  }
}).data;

describe('units', () => {
  test('buildTranslationUnits covers fields, greetings, tags and lorebook', () => {
    const ids = buildTranslationUnits(sampleData()).map(u => u.id);
    for (const id of ['field:name', 'field:description', 'field:first_mes', 'greeting:0', 'tags', 'lore_name',
      'entry:0:comment', 'entry:0:keys', 'entry:0:secondary_keys', 'entry:0:content']) {
      assert.ok(ids.includes(id), id);
    }
    assert.ok(!buildTranslationUnits(sampleData(), { translateTags: false }).some(u => u.id === 'tags'));
  });

  test('packBatches respects the token budget', () => {
    const big = 'word '.repeat(4000);
    const units = [{ id: 'a', text: big }, { id: 'b', text: 'small' }, { id: 'c', text: 'small' }];
    const batches = packBatches(units, 8192);
    assert.equal(batches.length, 2);
    assert.deepEqual(batches[0].map(u => u.id), ['a']);
  });

  test('applyTranslations keeps original lorebook keys and adds translated ones', () => {
    const src = sampleData();
    const out = applyTranslations(src, {
      'entry:0:keys': 'Затмение\nзатмения',
      'entry:0:secondary_keys': 'ритуал',
      'tags': 'фэнтези\nмагия',
      'greeting:0': 'Привет.'
    }, src, { lorebook_keys: { Eclipse: 'Затмение, затмению' } });
    assert.deepEqual(out.character_book.entries[0].keys, ['Eclipse', 'Затмение', 'затмения', 'затмению']);
    assert.deepEqual(out.character_book.entries[0].secondary_keys, ['ritual', 'ритуал']);
    assert.deepEqual(out.tags, ['фэнтези', 'магия']);
    assert.equal(out.alternate_greetings[0], 'Привет.');
    assert.equal(src.alternate_greetings[0], 'Hello there.', 'source is not mutated');
  });
});

// ---------------------------------------------------------------------------
// Pipeline with a mocked LLM endpoint
// ---------------------------------------------------------------------------

function sseResponse(content, finishReason = 'stop', { reasoning = '' } = {}) {
  const events = [];
  if (reasoning) events.push({ choices: [{ delta: { reasoning_content: reasoning } }] });
  // Split content into a few chunks, the way real streams arrive
  for (let i = 0; i < content.length; i += 7) {
    events.push({ choices: [{ delta: { content: content.slice(i, i + 7) }, finish_reason: null }] });
  }
  events.push({ choices: [{ delta: {}, finish_reason: finishReason }] });
  const text = events.map(e => `data: ${JSON.stringify(e)}\n\n`).join('') + 'data: [DONE]\n\n';
  return new Response(text, { headers: { 'content-type': 'text/event-stream' } });
}

function requestedIds(init) {
  const body = JSON.parse(init.body);
  return [...body.messages[1].content.matchAll(/<field id="([^"]+)"/g)].map(m => m[1]);
}

describe('translateUnits pipeline', () => {
  let realFetch;
  let calls;
  beforeEach(() => {
    realFetch = globalThis.fetch;
    calls = [];
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test('translates all units and retries the ones the model skipped', async () => {
    globalThis.fetch = async (url, init) => {
      const ids = requestedIds(init);
      calls.push(ids);
      // First (multi-unit) call "forgets" the description
      const answer = ids
        .filter(id => !(ids.length > 1 && id === 'field:description'))
        .map(id => `<field id="${id}">RU ${id}</field>`).join('\n');
      return sseResponse(answer);
    };
    const units = buildTranslationUnits(sampleData());
    const done = [];
    const { results, failed } = await translateUnits({ units, settings, onUnitDone: id => done.push(id) });
    assert.equal(failed.length, 0);
    assert.equal(Object.keys(results).length, units.length);
    assert.equal(results['field:description'], 'RU field:description');
    assert.deepEqual(calls.at(-1), ['field:description'], 'retried alone');
    assert.equal(done.length, units.length);
  });

  test('truncated answers are not accepted as translations', async () => {
    globalThis.fetch = async (url, init) => {
      const ids = requestedIds(init);
      if (ids.length > 1) {
        return sseResponse(`<field id="${ids[0]}">полный</field>\n<field id="${ids[1]}">обрез`, 'length');
      }
      return sseResponse(`<field id="${ids[0]}">обре`, 'length');
    };
    const units = buildTranslationUnits(sampleData()).slice(0, 3);
    const { results, failed } = await translateUnits({ units, settings });
    assert.equal(results[units[0].id], 'полный');
    assert.ok(failed.some(f => f.id === units[1].id && /Max Tokens/.test(f.reason)));
  });

  test('a failing batch does not throw away finished work', async () => {
    let n = 0;
    globalThis.fetch = async (url, init) => {
      n++;
      const ids = requestedIds(init);
      if (n === 2) return new Response('{"error":{"message":"overloaded"}}', { status: 503 });
      return sseResponse(ids.map(id => `<field id="${id}">ok</field>`).join(''));
    };
    // Three large units → three separate batches; the second one fails
    const units = ['a', 'b', 'c'].map(id => ({ id: `field:${id}`, type: 'text', label: id, text: 'word '.repeat(2000) }));
    const { results, failed } = await translateUnits({ units, settings });
    assert.deepEqual(Object.keys(results).sort(), ['field:a', 'field:c']);
    assert.equal(failed.length, 1);
    assert.equal(failed[0].id, 'field:b');
    assert.match(failed[0].reason, /503/);
  });

  test('configuration errors on the first request are thrown', async () => {
    globalThis.fetch = async () => new Response('{"error":{"message":"bad key"}}', { status: 401 });
    await assert.rejects(
      translateUnits({ units: buildTranslationUnits(sampleData()), settings }),
      /401.*bad key/
    );
  });

  test('reasoning-only answers raise an error instead of returning the reasoning', async () => {
    globalThis.fetch = async () => sseResponse('', 'length', { reasoning: 'Let me think...' });
    await assert.rejects(chatCompletion({ settings, messages: [] }), /рассуждения/);
  });

  test('temperature 0 is sent as 0', async () => {
    let sent;
    globalThis.fetch = async (url, init) => {
      sent = JSON.parse(init.body);
      return sseResponse('ok');
    };
    await chatCompletion({ settings: { ...settings, temperature: 0 }, messages: [] });
    assert.equal(sent.temperature, 0);
  });

  test('non-streaming JSON responses work too', async () => {
    globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: 'привет' }, finish_reason: 'stop' }] }), {
      headers: { 'content-type': 'application/json' }
    });
    const res = await chatCompletion({ settings: { ...settings, stream: false }, messages: [] });
    assert.equal(res.content, 'привет');
    assert.equal(res.truncated, false);
  });
});
