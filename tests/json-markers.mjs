// JSON 生图标记：image###{tag,nl,characters[],size}### 的解析、库注入、size 交换、v3 回落与记录。
import assert from 'node:assert/strict';
import {
    normalizeJsonText, parseMarkerJson, normalizeMarkerPayload, splitTagList,
    injectLibraryTags, convertCountTags, buildCharacterCaption, buildMarkerBase,
    buildMarkerPlan, swapSizeForOrientation, appendCaptionsToBase,
} from '../src/char-marker-json.js';
import { buildCharacterIndex, fixedTagsOf, expandCharacterRefs, charactersMacroText } from '../src/char-expand.js';
import { deriveTimeline, normalizeChatEntry } from '../src/char-blocks.js';
import { createMarkerController } from '../src/marker-generation.js';

// ───────── 1. 解析：正常 JSON / 坏 JSON / 全角标点 ─────────
const jsonText = '{"tag":"2girls, medium shot, rooftop, sunset","nl":"Two girls on a rooftop at sunset.","characters":[{"name":"小雪","tag":"girl, $希拉$, smiling","nl":"the left girl standing over the other"},{"name":"三年级队长","tag":"girl, short brown hair, amber eyes, surprised","nl":"the other girl on the ground"}],"size":"landscape"}';
const payload = parseMarkerJson(jsonText);
assert(payload);
assert.equal(payload.size, 'landscape');
assert.equal(payload.characters.length, 2);
assert.equal(parseMarkerJson('not a json marker'), null);
assert.equal(parseMarkerJson('{oops'), null);
assert.equal(parseMarkerJson('image###{"tag":"x"}###'), null, '只认以 { 开头的纯标记内容');
// 全角标点只替换字符串外：字符串里的全角逗号要保留
assert.equal(normalizeJsonText('｛"tag"："1girl，solo"，"nl"："a girl，sleeping"｝'), '{"tag":"1girl，solo","nl":"a girl，sleeping"}');
const fw = parseMarkerJson('｛"tag"："1girl，solo"，"nl"："a girl，sleeping"，"size"："portrait"｝');
assert(fw); assert.equal(fw.size, 'portrait'); assert.equal(fw.tag, '1girl，solo');
assert.equal(normalizeMarkerPayload({}), null);
assert.equal(normalizeMarkerPayload({ tag: 'x', size: 'square' }).size, '');

// ───────── 2. base 与注入顺序 ─────────
assert.equal(buildMarkerBase({ tag: '1girl, solo', nl: 'a girl stands' }), '1girl, solo, a girl stands');
assert.equal(buildMarkerBase({ tag: '1girl', nl: '' }), '1girl');
assert.equal(buildMarkerBase({ tag: '', nl: 'only nl' }), 'only nl');
assert.deepEqual(splitTagList('a, b , ,c'), ['a', 'b', 'c']);
assert.equal(
    injectLibraryTags('kasumi (blue archive), girl, smiling', '1girl, long black hair, blue eyes, white dress'),
    'kasumi (blue archive), girl, 1girl, long black hair, blue eyes, white dress, smiling',
);
// 去重（大小写不敏感），保留先出现的
assert.equal(
    injectLibraryTags('girl, Smiling, smiling, white dress', '1girl, white dress'),
    'girl, 1girl, white dress, Smiling',
);
// 没有身份/性别开头时，库标签直接在前
assert.equal(injectLibraryTags('smiling, standing', '1girl, red hair'), '1girl, red hair, smiling, standing');

// ───────── 3. 计数 tag 降级 ─────────
assert.equal(convertCountTags('1girl, long hair, 2girls, multiple girls, girl'), 'girl, long hair');
assert.equal(convertCountTags('1boy, 2boys, androgynous'), 'boy, androgynous');
assert.equal(buildCharacterCaption('1girl, red hair', 'a girl'), 'girl, red hair, a girl');
assert.equal(buildCharacterCaption('1girl', ''), 'girl');

// ───────── 4. 固定衣服 vs 跟剧情 + 聊天库覆盖 + 未知角色 + charRef ─────────
const globalXue = {
    name: '小雪', aliases: ['Shirley', '希拉'],
    appearance: [{ en: '1girl' }, { en: 'long black hair' }, { en: 'blue eyes' }],
    outfitMode: 'fixed', outfits: [{ id: 'o1', tags: [{ en: 'white dress' }] }], outfitId: 'o1', charRef: 'g-xue',
};
const chatXue = normalizeChatEntry({
    name: '小雪', aliases: ['希拉'], appearance: [{ en: '1girl' }, { en: 'short black hair' }],
    outfitMode: 'story', outfits: [], source: 'ai',
});
const emptyOps = [];
const timeline = deriveTimeline([], [
    { mes: '', swipe_id: 0, extra: { zhikuCharOps: { v: 1, swipe: 0, ops: [] } } },
]);
const lookupFor = entries => {
    const chatIndex = buildCharacterIndex([], [], entries);
    const globalIndex = buildCharacterIndex([{ on: true, char: globalXue }], [globalXue], []);
    return name => {
        const key = String(name ?? '').trim().toLowerCase();
        const chatChar = chatIndex.get(key);
        const globalChar = globalIndex.get(key);
        const found = chatChar || globalChar;
        if (!found) return null;
        return { tags: fixedTagsOf(found), charRef: String(chatChar?.charRef || globalChar?.charRef || '') };
    };
};
const expand = (text, entries) => expandCharacterRefs(text, { chatEntries: entries, cast: [{ on: true, char: globalXue }], characters: [globalXue] });
const planAt = (entries, data) => buildMarkerPlan(data, { lookup: lookupFor(entries), expand: value => expand(value, entries) });

const globalPlan = planAt([], payload);
const chatPlan = planAt([chatXue], payload);
assert.equal(globalPlan.characters[0].tag, 'girl, 1girl, long black hair, blue eyes, white dress, smiling');
assert.equal(globalPlan.characters[0].caption, 'girl, long black hair, blue eyes, white dress, smiling, the left girl standing over the other');
assert.deepEqual(globalPlan.charRefs, ['g-xue']);
// 本聊天库覆盖：短黑发、跟剧情（不带白裙），charRef 仍来自全局
assert.equal(chatPlan.characters[0].tag, 'girl, 1girl, short black hair, smiling');
assert.equal(chatPlan.characters[0].caption, 'girl, short black hair, smiling, the left girl standing over the other');
assert.deepEqual(chatPlan.charRefs, ['g-xue']);
// 未知角色原样通过
assert.equal(chatPlan.characters[1].tag, 'girl, short brown hair, amber eyes, surprised');
assert.equal(chatPlan.characters[1].caption, 'girl, short brown hair, amber eyes, surprised, the other girl on the ground');
assert.equal(chatPlan.characters[1].charRef, '');
// base 与可读记录
assert.equal(chatPlan.base, '2girls, medium shot, rooftop, sunset, Two girls on a rooftop at sunset.');
assert.equal(
    chatPlan.recordPrompt,
    '2girls, medium shot, rooftop, sunset, Two girls on a rooftop at sunset.\n'
    + 'girl, short black hair, smiling, the left girl standing over the other\n'
    + 'girl, short brown hair, amber eyes, surprised, the other girl on the ground',
);
assert.equal(chatPlan.size, 'landscape');

// ───────── 5. 早楼层用旧外貌（按楼层取本聊天状态） ─────────
const ops = [{
    kind: 'new', name: '小雪', aliases: ['希拉'],
    appearance: [{ en: '1girl' }, { en: 'short black hair' }], outfitMode: 'story', outfit: [], at: 1,
}];
const tl = deriveTimeline([], [{ mes: '', swipe_id: 0, extra: { zhikuCharOps: { v: 1, swipe: 0, ops } } }]);
const beforePlan = planAt(tl.stateAt(-1), payload);
const afterPlan = planAt(tl.stateAt(0), payload);
assert(beforePlan.characters[0].caption.includes('long black hair'));
assert(afterPlan.characters[0].caption.includes('short black hair'));
assert(!afterPlan.characters[0].caption.includes('white dress'));

// ───────── 6. v3 回落与 size 交换 ─────────
assert.equal(appendCaptionsToBase('2girls, rooftop', ['girl, red hair, a girl', 'boy, tall']), '2girls, rooftop, girl, red hair, a girl, boy, tall');
assert.deepEqual(swapSizeForOrientation('portrait', 1216, 832), { width: 832, height: 1216 });
assert.deepEqual(swapSizeForOrientation('landscape', 832, 1216), { width: 1216, height: 832 });
assert.deepEqual(swapSizeForOrientation('portrait', 832, 1216), {});
assert.deepEqual(swapSizeForOrientation('landscape', 1216, 832), {});
assert.deepEqual(swapSizeForOrientation('', 1216, 832), {});
assert.deepEqual(swapSizeForOrientation('portrait', 0, 0), {});

// ───────── 7. 宏格式（新的后缀标记） ─────────
const macro = charactersMacroText(
    [{ on: true, char: { name: '小雪', aliases: ['Shirley'], outfitMode: 'fixed' } }, { on: true, char: { name: '鲍勃', aliases: [], outfitMode: 'story' } }],
    { locked: new Set(['鲍勃']) },
);
assert.equal(macro, '- 小雪（别名：Shirley）[固定服装]\n- 鲍勃[固定，不可改]');

// ───────── 8. 控制器：JSON 标记传给 generate，记录里存可读提示词 ─────────
const raw = `image###${jsonText}###`;
const msg = { mes: raw, swipe_id: 0, swipes: [raw] };
const ctx = { chat: [msg], chatId: 'x', extensionSettings: { regex: [] }, saveSettingsDebounced() {}, async saveChat() {}, updateMessageBlock() {} };
let sent = null;
const ctrl = createMarkerController({
    context: () => ctx,
    getData: () => ({ options: {} }),
    generate: async prompt => { sent = prompt; return 'data:image/png;base64,test'; },
    upload: async () => ({ url: '/user/images/json.png' }),
    notify() {},
    expandPrompt: prompt => ({ text: prompt, record: 'READABLE PLAN' }),
});
await ctrl.process(0, { manual: true });
assert.equal(sent, jsonText.trim());
const record = Object.values(msg.extra.zhikuImages)[0];
assert.equal(record.prompt, 'READABLE PLAN');
assert.equal(msg.mes, raw, '消息原文不变');
ctrl.stop();

console.log('PASS: JSON marker parse/fallback (full-width), base composition, library injection order + dedupe, count-tag conversion, fixed vs story outfit, chat layer by floor, unknown passthrough, v3 fallback, size swap, charRef, stored readable prompt, macro suffixes, controller record.');
