// 位置生效 / 字段级合并 / 手动编辑保留历史 / 描述 nl（路线 B：不再自己展开 $名字$，由上游 resolveImageCharacters 查 roster）。
import assert from 'node:assert/strict';
import {
    CHAR_OPS_KEY, buildCharOps, applyCharOps, messageOpsPayload, deriveTimeline, mergeCharacterLayers,
    historyFromOps, manualHistoryRecord, capHistory, normalizeChatEntry, entryFromGlobal, globalFromChatEntry,
    chatMacroText, charCacheKey, parseCharacterBlocks, mergeChatEntriesWithGlobals, ensureAliases,
} from '../src/char-blocks.js';
import { createMarkerController } from '../src/marker-generation.js';

const en = list => list.map(t => t.en);

// ───────── 1. 块里记下位置 pos，描述 nl 一起解析 ─────────
const text = '前言\n<人物>\n名字: 甲\n外貌: 1girl, black hair\n描述: a quiet girl\n</人物>\n中间\n<外貌变化>\n名字: 甲\n加: red eyes\n描述: a quiet girl with red eyes\n原因: 觉醒\n</外貌变化>\n结尾';
const built = buildCharOps(text, { at: 1 });
assert.deepEqual(built.ops.map(op => op.kind), ['new', 'set']);
assert.equal(built.ops[0].pos, text.indexOf('<人物>'));
assert.equal(built.ops[1].pos, text.indexOf('<外貌变化>'));
assert.equal(built.ops[0].nl, 'a quiet girl');
assert.equal(built.ops[1].nl, 'a quiet girl with red eyes');
assert.equal(parseCharacterBlocks('＜人物＞\n名字：乙\n描述：x\n＜／人物＞')[0].fields['描述'], 'x');

// ───────── 2. 同一楼内：<外貌变化> 只对它之后的标记生效 ─────────
const msg = { mes: text, swipe_id: 0, extra: { [CHAR_OPS_KEY]: messageOpsPayload(built.ops, 0) } };
const later = { mes: '', swipe_id: 0, extra: {} };
const timeline = deriveTimeline([], [msg, later]);
const setPos = built.ops[1].pos;
// 标记在 <人物> 之前：建档整楼生效，所以能看到角色；但 <外貌变化> 还没发生
const beforeAll = timeline.stateAt(0, 0)[0];
assert.deepEqual(en(beforeAll.appearance), ['1girl', 'black hair']);
assert.equal(beforeAll.nl, 'a quiet girl');
// 标记在 <外貌变化> 之前
assert.deepEqual(en(timeline.stateAt(0, setPos - 1)[0].appearance), ['1girl', 'black hair']);
// 标记在 <外貌变化> 之后
const afterSet = timeline.stateAt(0, setPos + 1)[0];
assert.deepEqual(en(afterSet.appearance), ['1girl', 'black hair', 'red eyes']);
assert.equal(afterSet.nl, 'a quiet girl with red eyes');
// 不给 pos = 整楼；下一楼看到全部
assert.deepEqual(en(timeline.stateAt(0)[0].appearance), ['1girl', 'black hair', 'red eyes']);
assert.deepEqual(en(timeline.stateAt(1)[0].appearance), ['1girl', 'black hair', 'red eyes']);
// 前一楼没有这个角色（<人物> 在本楼）
assert.equal(timeline.stateAt(-1).length, 0);
// 缓存：同 (floor,pos) 返回同一个对象，不重放整段聊天
assert.equal(timeline.stateAt(0, setPos - 1), timeline.stateAt(0, setPos - 1));
assert.notEqual(timeline.stateAt(0, setPos - 1), timeline.stateAt(0, setPos + 1));
// 没有 pos 的旧 ops 保持原行为：整楼生效，不管标记在哪
const legacyOps = [{ kind: 'new', name: '丙', appearance: [{ en: '1boy' }], at: 1 }, { kind: 'set', name: '丙', add: [{ en: 'glasses' }], at: 1 }];
const legacyTl = deriveTimeline([], [{ mes: '', swipe_id: 0, extra: { [CHAR_OPS_KEY]: messageOpsPayload(legacyOps, 0) } }]);
assert.deepEqual(en(legacyTl.stateAt(0, 0)[0].appearance), ['1boy', 'glasses']);
// applyCharOps 的 pos 选项与 deriveTimeline 一致
assert.deepEqual(en(applyCharOps([], built.ops, 0, { pos: setPos - 1 })[0].appearance), ['1girl', 'black hair']);

// ───────── 3. 字段级合并：本聊天空字段回落到同名全局 ─────────
const globalChar = {
    name: '小雪', aliases: ['Shirley'], appearance: [{ en: '1girl' }, { en: 'long black hair' }], nl: 'a girl with long black hair',
    outfitMode: 'fixed', outfits: [{ id: 'g1', tags: [{ en: 'white dress' }] }], outfitId: 'g1', charRef: 'g-ref',
};
const emptyChat = normalizeChatEntry({ name: '小雪', aliases: ['希拉'], source: 'ai' });
const m1 = mergeCharacterLayers(emptyChat, globalChar);
assert.deepEqual(en(m1.entry.appearance), ['1girl', 'long black hair']);
assert.equal(m1.entry.nl, 'a girl with long black hair');
assert.equal(m1.entry.outfitMode, 'fixed');
assert.deepEqual(en(m1.entry.outfits[0].tags), ['white dress']);
assert.deepEqual(m1.entry.aliases, ['希拉', 'Shirley']);
assert.equal(m1.entry.charRef, 'g-ref');
assert.deepEqual(m1.sources, { appearance: 'global', nl: 'global', outfit: 'global', aliases: 'union' });
// 本聊天有值就用本聊天的
const fullChat = normalizeChatEntry({ name: '小雪', appearance: [{ en: '1girl' }, { en: 'short hair' }], nl: 'short-haired', outfitMode: 'story', outfitModeExplicit: true });
const m2 = mergeCharacterLayers(fullChat, globalChar);
assert.deepEqual(en(m2.entry.appearance), ['1girl', 'short hair']);
assert.equal(m2.entry.nl, 'short-haired');
assert.equal(m2.entry.outfitMode, 'story', '显式 story 覆盖全局固定服装');
assert.deepEqual(m2.sources, { appearance: 'chat', nl: 'chat', outfit: 'chat', aliases: 'union' });
// 有自己的服装也算覆盖
const ownOutfit = normalizeChatEntry({ name: '小雪', outfitMode: 'fixed', outfits: [{ id: 'c1', tags: [{ en: 'red coat' }] }], outfitId: 'c1' });
assert.deepEqual(en(mergeCharacterLayers(ownOutfit, globalChar).entry.outfits[0].tags), ['red coat']);
// 没有同名全局时原样返回
assert.equal(mergeCharacterLayers(emptyChat, null).entry.name, '小雪');
// 宏里用合并结果：本聊天条目没写服装，但全局是固定服装 → 标 [固定服装]，别名并集
assert.equal(chatMacroText([emptyChat], [], { globals: [globalChar] }), '- 小雪（别名：希拉、Shirley）[固定服装]');

// ───────── 4. 历史：ops 转字段记录；手动编辑保留；封顶 50 ─────────
const o0 = buildCharOps('<人物>\n名字: 甲\n外貌: 1girl, black hair\n</人物>', { at: 10 });
const o1 = buildCharOps('<外貌变化>\n名字: 甲\n加: red eyes\n衣服: coat\n描述: sharp eyes\n原因: 觉醒\n</外貌变化>', { at: 20, known: new Set(['甲']) });
const hMsgs = [
    { mes: '', swipe_id: 0, extra: { [CHAR_OPS_KEY]: messageOpsPayload(o0.ops, 0) } },
    { mes: '', swipe_id: 0, extra: { [CHAR_OPS_KEY]: messageOpsPayload(o1.ops, 0) } },
];
const hTl = deriveTimeline([], hMsgs);
const records = historyFromOps(hTl, '甲', hMsgs);
assert.deepEqual(records.map(r => r.field), ['new', 'appearance', 'outfit', 'nl']);
assert.equal(records[1].from, '1girl, black hair');
assert.equal(records[1].to, '1girl, black hair, red eyes');
assert.equal(records[2].from, '跟剧情');
assert.equal(records[2].to, '固定：coat');
assert.equal(records[3].to, 'sharp eyes');
assert.equal(records[1].floor, 1);
assert.equal(records[1].reason, '觉醒');
const manual = manualHistoryRecord({ appearance: [{ en: 'a' }] }, '手动', 99);
assert.deepEqual(manual, { field: 'manual', from: '', to: 'a', reason: '手动', floor: -1, at: 99 });
const many = Array.from({ length: 70 }, (_, i) => ({ field: 'appearance', from: String(i), to: String(i + 1), reason: '', floor: i, at: i }));
assert.equal(capHistory(many).length, 50);
assert.equal(capHistory(many)[0].from, '20');
assert.equal(normalizeChatEntry({ name: '甲', history: many }).history.length, 50);
// 旧格式 before/after 记录自动转成字段记录
const legacy = normalizeChatEntry({ name: '甲', history: [{ floor: 2, reason: 'x', at: 1, before: { appearance: 'a' }, after: { appearance: 'a, b' } }] });
assert.deepEqual(legacy.history[0], { field: 'appearance', from: 'a', to: 'a, b', reason: 'x', floor: 2, at: 1 });
// 手动编辑后：基线历史 + 吸收的 ops 记录 + 手动记录，封顶
const merged = capHistory([...(legacy.history || []), ...records, manual]);
assert.equal(merged.at(-1).field, 'manual');
assert.equal(merged.length, 6);
// ───────── 5. 描述 nl：存档 / 复制 / 提升 / 缓存键都带着它 ─────────
// 没有库描述时只接 AI 的 nl
// 纯文本 $名字$ 只展开 tag，不带 nl
// 复制 / 提升 / 规范化保留 nl
assert.equal(entryFromGlobal(globalChar).nl, 'a girl with long black hair');
assert.equal(globalFromChatEntry(fullChat).nl, 'short-haired');
assert.equal(ensureAliases({ name: '甲', aliases: 'x|y', nl: '  hi  ' }).nl, 'hi');
assert.equal(ensureAliases({ name: '甲' }).nl, '');
assert.notEqual(
    charCacheKey([], [normalizeChatEntry({ name: '甲', nl: 'a' })]),
    charCacheKey([], [normalizeChatEntry({ name: '甲', nl: 'b' })]),
    'nl 变化要让缓存失效',
);
// ───────── 5b. 查库用「合并后」的本聊天条目（空字段回落全局） ─────────
const mergedList = mergeChatEntriesWithGlobals([emptyChat, fullChat], [globalChar]);
assert.deepEqual(en(mergedList[0].appearance), ['1girl', 'long black hair']);
assert.equal(mergedList[0].nl, 'a girl with long black hair');
assert.equal(mergedList[0].outfitMode, 'fixed');
assert.deepEqual(mergedList[0].aliases, ['希拉', 'Shirley']);
assert.equal(mergedList[1].nl, 'short-haired', '本聊天有值就不回落');
assert.equal(mergeChatEntriesWithGlobals([normalizeChatEntry({ name: '路人', appearance: [{ en: 'boy' }] })], [globalChar])[0].name, '路人');
// 纯文本：本聊天条目没写外貌，但同名全局有 → 展开用全局的外貌 + 固定服装；别名并集后 Shirley 也能命中

// JSON：本聊天条目空外貌/空 nl → caption 用全局的 tag 与 nl
// ───────── 6. 控制器把标记起始位置交给 expandPrompt / generate ─────────
const raw = 'x image###first### y image###second### z';
const cmsg = { mes: raw, swipe_id: 0, swipes: [raw] };
const ctx = { chat: [cmsg], chatId: 'p', extensionSettings: { regex: [] }, saveSettingsDebounced() {}, async saveChat() {}, updateMessageBlock() {} };
const seen = [];
const ctrl = createMarkerController({
    context: () => ctx,
    getData: () => ({ options: {} }),
    expandPrompt: (prompt, meta) => { seen.push(['expand', prompt, meta.pos, meta.msgId]); return prompt; },
    generate: async (prompt, meta) => { seen.push(['generate', prompt, meta.pos]); return 'data:image/png;base64,x'; },
    upload: async () => ({ url: '/u.png' }),
    notify() {},
});
await ctrl.process(0, { manual: true, tokenIndex: 0 });
await ctrl.process(0, { manual: true, tokenIndex: 1 });
assert.deepEqual(seen.filter(item => item[0] === 'expand').map(item => [item[1], item[2], item[3]]), [['first', raw.indexOf('image###first'), 0], ['second', raw.indexOf('image###second'), 0]]);
assert.deepEqual(seen.filter(item => item[0] === 'generate').map(item => item[2]), [raw.indexOf('image###first'), raw.indexOf('image###second')]);
ctrl.stop();
console.log('PASS: 块位置与描述解析、同楼按位置生效（建档整楼 / 变化只影响其后 / 旧 ops 整楼）、缓存、字段级合并、历史（ops+手动+封顶）、nl 存档与缓存键、标记位置传给 expandPrompt/generate。');