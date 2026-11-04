// 角色外观库：<人物>/<外貌变化> 解析、按楼层重放、两层库、宏、正则与缓存键。
// 全部是模块级测试（没有真实酒馆），运行时接线部分见 README「角色外观库」。
import assert from 'node:assert/strict';
import {
    CHAT_META_KEY, CHAR_OPS_KEY, CHAR_BLOCK_PATTERN_SOURCE,
    parseCharacterBlocks, pairsFromTags, buildCharOps, buildCharOpsIfEnabled, applyCharOps,
    messageOps, messageOpsPayload, sameCharOps, deriveTimeline, stripOpsForName, lockedCharNames,
    normalizeChatStore, normalizeChatEntry, chatStorePayload, entryFromGlobal, globalFromChatEntry,
    charCacheKey, chatMacroText, tagsText,
} from '../src/char-blocks.js';
import { expandCharacterRefs } from '../src/char-expand.js';
import { createMarkerController, CHAR_BLOCK_DISPLAY_ID, MARKER_REGEX_ID } from '../src/marker-generation.js';

assert.equal(CHAT_META_KEY, 'zhiku_chat_chars');
assert.equal(CHAR_OPS_KEY, 'zhikuCharOps');
assert(CHAR_BLOCK_PATTERN_SOURCE.includes('人物'));

// ───────── 1. 解析：全角标点 / 全角尖括号 ─────────
const sample = `前文
＜人物＞
名字：爱丽丝
别名：Alice|小爱
外貌：1girl，long blonde hair，blue eyes，slim
衣服：white blouse，pleated skirt
＜／人物＞
<外貌变化>
名字: 爱丽丝
加: short hair, black hair
去: long blonde hair
原因: 剪短染黑
</外貌变化>`;
const blocks = parseCharacterBlocks(sample);
assert.equal(blocks.length, 2);
assert.equal(blocks[0].type, 'person');
assert.equal(blocks[0].fields['名字'], '爱丽丝');
assert.equal(blocks[0].fields['别名'], 'Alice|小爱');
assert.deepEqual(pairsFromTags(blocks[0].fields['外貌']).map(p => p.en), ['1girl', 'long blonde hair', 'blue eyes', 'slim']);
assert.deepEqual(pairsFromTags('tag（中文）, other').map(p => p.zh), ['中文', '']);
assert.equal(blocks[1].type, 'change');
assert.equal(blocks[1].fields['原因'], '剪短染黑');
assert.deepEqual(parseCharacterBlocks('没有块'), []);

// ───────── 2. ops 写进消息 extra（带 swipe） ─────────
const built = buildCharOps(sample, { at: 123 });
assert.deepEqual(built.ops.map(op => op.kind), ['new', 'set']);
assert.equal(built.ops[0].name, '爱丽丝');
assert.deepEqual(built.ops[0].aliases, ['Alice', '小爱']);
assert.equal(built.ops[0].outfitMode, 'fixed');
assert.deepEqual(built.ops[0].outfit.map(t => t.en), ['white blouse', 'pleated skirt']);
assert.deepEqual(built.ops[1].add.map(t => t.en), ['short hair', 'black hair']);
assert.deepEqual(built.ops[1].remove.map(t => t.en), ['long blonde hair']);
const msg = { mes: sample, swipe_id: 2, extra: {} };
msg.extra[CHAR_OPS_KEY] = messageOpsPayload(built.ops, msg.swipe_id);
const read = messageOps(msg);
assert.equal(read.swipe, 2);
assert.equal(read.ops.length, 2);
assert.equal(messageOpsPayload([], 0), undefined);
assert.equal(messageOps({ extra: {} }), null);
assert.equal(messageOps({ extra: { [CHAR_OPS_KEY]: { v: 2, ops: [] } } }), null);
// 重复渲染不重写：at 不同但内容相同
assert(sameCharOps([{ kind: 'new', name: '甲', at: 1 }], [{ kind: 'new', name: '甲', at: 2 }]));
assert(!sameCharOps([{ kind: 'new', name: '甲' }], [{ kind: 'new', name: '乙' }]));

// ───────── 3. swipe 不匹配的 ops 不生效 ─────────
const swipeMsg = { mes: '', swipe_id: 1, extra: { [CHAR_OPS_KEY]: messageOpsPayload(built.ops, 0) } };
assert.equal(deriveTimeline([], [swipeMsg]).stateAt(0).length, 0);

// ───────── 4. 按楼层重放 ─────────
const newBlock = '<人物>\n名字: 爱丽丝\n外貌: 1girl, long blonde hair\n</人物>';
const changeBlock = '<外貌变化>\n名字: 爱丽丝\n加: blue eyes\n</外貌变化>';
const b0 = buildCharOps(newBlock, { at: 1000 });
const b1 = buildCharOps(changeBlock, { at: 2000, known: new Set(['爱丽丝']) });
const m0 = { mes: newBlock, swipe_id: 0, extra: { [CHAR_OPS_KEY]: messageOpsPayload(b0.ops, 0) } };
const m1 = { mes: changeBlock, swipe_id: 0, extra: { [CHAR_OPS_KEY]: messageOpsPayload(b1.ops, 0) } };
const timeline = deriveTimeline([], [m0, m1]);
assert.deepEqual(timeline.stateAt(0)[0].appearance.map(t => t.en), ['1girl', 'long blonde hair']);
assert.deepEqual(timeline.stateAt(1)[0].appearance.map(t => t.en), ['1girl', 'long blonde hair', 'blue eyes']);
// 同一楼里「先建档再改档」当楼就生效
const bothText = '<人物>\n名字: 甲\n外貌: 1girl\n</人物>\n<外貌变化>\n名字: 甲\n加: red eyes\n</外貌变化>';
const bothOps = buildCharOps(bothText, { at: 3000 });
assert.deepEqual(bothOps.ops.map(op => op.kind), ['new', 'set']);
const bothMsg = { mes: bothText, swipe_id: 0, extra: { [CHAR_OPS_KEY]: messageOpsPayload(bothOps.ops, 0) } };
assert.deepEqual(deriveTimeline([], [bothMsg]).stateAt(0)[0].appearance.map(t => t.en), ['1girl', 'red eyes']);
// 衣服：固定 / 跟剧情 / 替换
const outfitMsg = {
    mes: '', swipe_id: 0, extra: {
        [CHAR_OPS_KEY]: messageOpsPayload([{
            kind: 'set', name: '甲', appearance: [{ en: '1girl' }],
            outfit: [{ en: 'white dress' }], reason: '换衣',
        }], 0),
    },
};
const withOutfit = deriveTimeline([{ name: '甲', appearance: [{ en: '1girl' }], aliases: [], outfits: [], outfitId: '', outfitMode: 'story', source: 'manual', history: [] }], [outfitMsg]).stateAt(0)[0];
assert.equal(withOutfit.outfitMode, 'fixed');
assert.deepEqual(withOutfit.outfits[0].tags.map(t => t.en), ['white dress']);
const storyMsg = { mes: '', swipe_id: 0, extra: { [CHAR_OPS_KEY]: messageOpsPayload([{ kind: 'set', name: '甲', outfit: 'story' }], 0) } };
assert.equal(deriveTimeline([withOutfit], [storyMsg]).stateAt(0)[0].outfitMode, 'story');
// 历史记录跟着 ops（字段级：field/from/to/reason/floor/at）
assert.equal(timeline.stateAt(1)[0].history.length, 2);
assert.equal(timeline.stateAt(1)[0].history[0].field, 'new');
assert.equal(timeline.stateAt(1)[0].history[1].field, 'appearance');
assert.equal(timeline.stateAt(1)[0].history[1].from, '1girl, long blonde hair');
assert.equal(timeline.stateAt(1)[0].history[1].to, '1girl, long blonde hair, blue eyes');
assert.equal(timeline.stateAt(1)[0].history[1].floor, 1);

// ───────── 5. 锁定（只在全局库）的名字忽略 AI 块 ─────────
const locked = new Set(['爱丽丝']);
const lockedBuild = buildCharOps('<人物>\n名字: 爱丽丝\n外貌: 1girl\n</人物>', { locked, known: new Set() });
assert.equal(lockedBuild.ops.length, 0);
assert.equal(lockedBuild.logs.length, 1);
const existing = [{ name: '爱丽丝', aliases: [], appearance: [{ en: '1girl' }], outfitMode: 'story', outfits: [], outfitId: '', source: 'manual', history: [] }];
assert.deepEqual(applyCharOps(existing, b1.ops, 1, { locked })[0].appearance.map(t => t.en), ['1girl']);
assert.deepEqual([...lockedCharNames({ a: { name: '爱丽丝' }, b: { name: '鲍勃' } }, [{ name: '鲍勃' }])], ['爱丽丝']);

// ───────── 6. 本聊天库覆盖全局 ─────────
const chatEntry = normalizeChatEntry({ name: '爱丽丝', appearance: [{ en: '1girl' }, { en: 'short black hair' }] });
const globalChar = { name: '爱丽丝', aliases: [], appearance: [{ en: '1girl' }, { en: 'long blonde hair' }], outfitMode: 'fixed', outfits: [{ id: 'o1', tags: [{ en: 'white dress' }] }], outfitId: 'o1' };
assert.equal(
    expandCharacterRefs('$爱丽丝$', { chatEntries: [chatEntry], cast: [{ on: true, char: globalChar }], characters: [globalChar] }),
    '1girl, short black hair',
);
assert.equal(
    expandCharacterRefs('$爱丽丝$', { cast: [{ on: true, char: globalChar }], characters: [globalChar] }),
    '1girl, long blonde hair, white dress',
);

// ───────── 7. 手动改档清掉早先楼层的 ops ─────────
const chatForStrip = [
    { extra: { [CHAR_OPS_KEY]: { v: 1, swipe: 0, ops: [{ kind: 'set', name: '爱丽丝', at: 1 }, { kind: 'set', name: '鲍勃', at: 1 }] } } },
    { extra: { [CHAR_OPS_KEY]: { v: 1, swipe: 0, ops: [{ kind: 'set', name: '爱丽丝' }] } } },
];
assert.equal(stripOpsForName(chatForStrip, '爱丽丝'), 2);
assert.deepEqual(messageOps(chatForStrip[0]).ops.map(op => op.name), ['鲍勃']);
assert.equal(chatForStrip[1].extra[CHAR_OPS_KEY], undefined);
const swipeInfoMsg = { extra: { [CHAR_OPS_KEY]: { v: 1, swipe: 0, ops: [{ kind: 'set', name: '甲' }] } }, swipe_info: [{ extra: { [CHAR_OPS_KEY]: { v: 1, swipe: 0, ops: [{ kind: 'set', name: '甲' }] } } }] };
assert.equal(stripOpsForName([swipeInfoMsg], '甲'), 2);

// ───────── 8. 提升为全局 / 复制到本聊天 ─────────
const entry = normalizeChatEntry({ name: '爱丽丝', aliases: ['Alice'], appearance: [{ en: '1girl' }], outfitMode: 'fixed', outfits: [{ id: 'o1', name: '白裙', tags: [{ en: 'white dress' }] }], outfitId: 'o1', source: 'ai' });
const asGlobal = globalFromChatEntry(entry);
assert.equal(asGlobal.name, '爱丽丝');
assert.deepEqual(asGlobal.aliases, ['Alice']);
assert.equal(asGlobal.outfitMode, 'fixed');
assert.deepEqual(asGlobal.outfits[0].tags.map(t => t.en), ['white dress']);
const backToChat = entryFromGlobal(asGlobal);
assert.equal(backToChat.source, 'manual');
assert.deepEqual(backToChat.appearance.map(t => t.en), ['1girl']);
assert.deepEqual(backToChat.outfits[0].tags.map(t => t.en), ['white dress']);

// ───────── 9. 宏：本聊天 + 出场全局，锁定标注，按名字去重 ─────────
const macro = chatMacroText(
    [entry],
    [{ on: true, char: { name: '鲍勃', aliases: [] } }, { on: true, char: { name: '爱丽丝', aliases: ['Alice'] } }, { on: false, char: { name: '卡罗尔' } }],
    { locked: new Set(['鲍勃']) },
);
assert.equal(macro, '- 爱丽丝（别名：Alice）[固定服装]\n- 鲍勃[固定，不可改]');
assert.equal(chatMacroText([], []), '');

// ───────── 10. 正则：不发送规则含角色块；单独折叠规则 ─────────
const ctx = { chat: [], chatId: 'x', extensionSettings: { regex: [] }, saveSettingsDebounced() {} };
const controller = createMarkerController({ context: () => ctx, getData: () => ({ options: {} }), generate: async () => 'x', upload: async () => ({ url: '' }), notify() {} });
controller.syncRegex();
const stripRule = ctx.extensionSettings.regex.find(r => r.id === MARKER_REGEX_ID);
assert(stripRule.findRegex.includes('<(?:人物|外貌变化)>'));
assert.equal('x <人物>\n名字: 甲\n</人物> y <外貌变化>\n名字: 甲\n</外貌变化> z'.replace(new RegExp(stripRule.findRegex.slice(1, -2), 'g'), ''), 'x  y  z');
const blockRule = ctx.extensionSettings.regex.find(r => r.id === CHAR_BLOCK_DISPLAY_ID);
assert(blockRule && blockRule.markdownOnly && !blockRule.promptOnly);
assert('<人物>\n名字: 甲\n</人物>'.replace(new RegExp(blockRule.findRegex.slice(1, -2), 'g'), blockRule.replaceString).includes('角色档案'));
controller.stop();

// ───────── 11. 缓存键随编辑变化 ─────────
const base = [normalizeChatEntry({ name: '爱丽丝', appearance: [{ en: '1girl' }] })];
const editMsg = { swipe_id: 0, extra: { [CHAR_OPS_KEY]: { v: 1, swipe: 0, ops: [{ kind: 'set', name: '爱丽丝', add: [{ en: 'blue eyes' }], at: 1 }] } } };
const key1 = charCacheKey([editMsg], base);
editMsg.extra[CHAR_OPS_KEY].ops[0].add = [{ en: 'red eyes' }];
const key2 = charCacheKey([editMsg], base);
assert.notEqual(key1, key2);
assert.equal(charCacheKey([editMsg], base), charCacheKey([editMsg], base));

// ───────── 12. 开关关掉就不解析 ─────────
assert.equal(buildCharOpsIfEnabled('<人物>\n名字: 甲\n外貌: 1girl\n</人物>', { enabled: false, locked: new Set(), known: new Set() }).ops.length, 0);
assert.equal(buildCharOpsIfEnabled('<人物>\n名字: 甲\n外貌: 1girl\n</人物>', { enabled: true, locked: new Set(), known: new Set() }).ops.length, 1);

// ───────── 13. 存档形状：旧数据没有 aliases / v 字段也能读 ─────────
const store = normalizeChatStore({ entries: [{ name: '甲', aliases: 'A|B', appearance: [{ en: '1girl' }], outfitMode: 'fixed', outfits: [{ id: 'o1', tags: [{ en: 'coat' }] }], outfitId: 'o1' }] });
assert.equal(store.length, 1);
assert.deepEqual(store[0].aliases, ['A', 'B']);
assert.equal(store[0].outfitMode, 'fixed');
assert.deepEqual(chatStorePayload(store).entries[0].appearance.map(t => t.en), ['1girl']);
assert.equal(normalizeChatStore(null).length, 0);
assert.equal(normalizeChatStore({ entries: [{ name: '' }] }).length, 0);
assert.equal(tagsText([{ en: 'a' }, { en: 'b' }]), 'a, b');

console.log('PASS: blocks parse (full-width), ops on extra with swipe, swipe mismatch ignored, per-floor replay (same floor included), outfit modes, locked globals, chat override, manual strip, promote/copy shapes, macro with lock marker, regex strip/fold, cache key, toggle, legacy store.');
