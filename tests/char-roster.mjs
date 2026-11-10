// 运行时接线：<人物>/<外貌变化> 收进本楼 extra、按楼层与位置重放、进 roster、宏、双层库。
// 用真实 runtime.js 的 chars 模块在沙箱里跑（和 pose-input / sharing-wardrobe 一样的做法）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// 沙箱里造出来的数组和外面不同 realm，deepEqual 会因原型不同失败，统一按 JSON 比
const eq = (actual, expected, message) => assert.equal(JSON.stringify(actual), JSON.stringify(expected), message);
const source = fs.readFileSync(new URL('../runtime.js', import.meta.url), 'utf8');
const part = (a, b) => { const i = source.indexOf(a), j = source.indexOf(b, i); assert(i >= 0 && j > i, a); return source.slice(i, j); };
const M = vm.runInNewContext(part('const __mod_model =', '// ───── store.js') + '\n__mod_model', { structuredClone });

const data = M.emptyData();
// 全局角色：小雪（长发、固定白裙、有描述有别名）——对本聊天的 AI 只读
data.characters.xue = {
    key: 'xue', kind: 'free', name: '小雪', aliases: 'Shirley', avatar: '', card: '',
    appearance: [{ en: '1girl' }, { en: 'long black hair' }], nsfwBody: [], outfitMode: 'fixed',
    outfits: [{ id: 'g1', name: '白裙', tags: [{ en: 'white dress' }] }], outfitId: 'g1',
    negative: '', charRef: 'ref-g', nl: 'a calm girl',
};
const chat = {
    chat: [
        { mes: '开头', swipe_id: 0, extra: {} },
        {
            mes: '正文\n<人物>\n名字: 小雨\n别名: 小雨点|Ame\n外貌: 1girl, short black hair\n'
                + '衣服: blue raincoat\n描述: a quiet girl\n</人物>\n'
                + '中间\n<外貌变化>\n名字: 小雨\n加: red eyes\n原因: 觉醒\n</外貌变化>\n结尾 image###标记###',
            swipe_id: 0,
            extra: {},
        },
    ],
    chatMetadata: {}, chatId: 'c1', characters: [], characterId: 0,
    saveMetadata() {}, saveMetadataDebounced() {}, saveChat() {}, saveSettingsDebounced() {},
};
const config = { naiMode: 'site', novelaimode: 'nai-diffusion-4-5-full' };
// markerPrompt 依赖上游的逐图角色协议（resolveImageCharacters 等），这些函数与 chars 模块在 runtime.js 的
// 同一个外层作用域里；一起切出来放进沙箱，才测得到真实的 $名字-sfw-upperbody$ 解析。
const protocol = part('function illustrationPrompt(options = {}) {', 'const P = (() => {');
const C = vm.runInNewContext(protocol + '\n' + part('const __mod_chars =', '// Marker-triggered generation') + '\n__mod_chars', {
    __mod_model: M,
    __mod_store: { getData: () => data, commit() {}, uploadImage: async () => ({ url: '' }) },
    __mod_nai: { settings: () => config, chatBackend: () => 'nai' },
    __mod_engine: { composeStudio: ({ pos = '', neg = '' } = {}) => ({ positive: pos, negative: neg }) },
    __mod_translate: { hasChinese: () => false },
    SillyTavern: { getContext: () => chat },
    toastr: { info() {}, error() {}, success() {}, warning() {} },
    console, structuredClone,
});

// 1) 建档：块写进本楼 extra，按楼层重放
assert.equal(C.applyCharacterBlocks(1), 2, '本楼要收到建档与变化两条');
const ops = chat.chat[1].extra.zhikuCharOps;
assert.equal(ops.v, 1);
assert.equal(ops.swipe, 0);
eq(ops.ops.map(op => op.kind), ['new', 'set']);
assert.equal(C.chatStateAt(0).length, 0, '第 0 楼还没有这个角色');
eq(C.chatStateAt(1)[0].appearance.map(t => t.en), ['1girl', 'short black hair', 'red eyes']);
assert.equal(C.chatStateAt(1)[0].nl, 'a quiet girl');
assert.equal(C.chatStateAt(1)[0].outfitMode, 'fixed', '写了衣服就是固定服装');
// 重复调用不重写（渲染 / 编辑会重复触发）
const before = JSON.stringify(chat.chat[1].extra.zhikuCharOps);
C.applyCharacterBlocks(1);
assert.equal(JSON.stringify(chat.chat[1].extra.zhikuCharOps), before);

// 2) roster：这一楼能看到，前一楼看不到；描述接在外貌后面
const roster = C.rosterAt(1);
const ame = roster.filter(row => row.char.name === '小雨');
assert.equal(ame.length, 1);
eq(ame[0].char.appearance.map(t => t.en), ['1girl', 'short black hair', 'red eyes', 'a quiet girl']);
assert.equal(ame[0].char.aliases, '小雨点，Ame');
assert.equal(ame[0].char.outfitMode, 'fixed');
assert.equal(C.rosterAt(0).some(row => row.char.name === '小雨'), false);
// 位置：变化块之前还没有红眼
const setPos = chat.chat[1].mes.indexOf('<外貌变化>');
const beforeChange = C.rosterAt(1, setPos - 1).find(row => row.char.name === '小雨');
eq(beforeChange.char.appearance.map(t => t.en), ['1girl', 'short black hair', 'a quiet girl']);

// 3) markerPrompt 用这一楼的 roster：$小雨-sfw-upperbody$ 认得本聊天档案
const hit = C.markerPrompt('$小雨-sfw-upperbody$, cafe', { floor: 1, pos: 10 ** 6 });
assert.equal(hit.cast.length, 1);
assert.equal(hit.cast[0].name, '小雨');
const caption = (hit.chars[0]?.prompt || '') + ' ' + hit.positive;
assert(caption.includes('short black hair'), '用本聊天档案的短发：' + caption);
assert(caption.includes('red eyes'), '变化块之后能看到红眼：' + caption);
// 变化之前的位置：没有红眼
const early = C.markerPrompt('$小雨-sfw-upperbody$, cafe', { floor: 1, pos: setPos - 1 });
const earlyText = (early.chars[0]?.prompt || '') + ' ' + early.positive;
assert(!earlyText.includes('red eyes'), '变化之前不该有红眼：' + earlyText);
// 别名也能命中
assert.equal(C.markerPrompt('$小雨点$, cafe', { floor: 1 }).cast.length, 1);

// 4) 宏：本聊天角色带别名
const macro = C.characterMacroText();
assert(macro.includes('- 小雨'), macro);
assert(macro.includes('小雨点、Ame'), macro);

// 5) 双层库：同名全局角色 + 本聊天一条 → 空字段回落全局
assert.equal(C.saveChatEntry({ name: '小雪', appearance: [{ en: '1girl' }, { en: 'bob cut' }] }, '小雪'), true);
const merged = C.mergedChatEntries().find(item => item.entry.name === '小雪');
eq(merged.entry.appearance.map(t => t.en), ['1girl', 'bob cut']);
assert.equal(merged.entry.nl, 'a calm girl', '没写描述就回落全局');
eq(merged.entry.outfits[0].tags.map(t => t.en), ['white dress'], '没写服装就回落全局');
assert.equal(merged.entry.charRef, 'ref-g');
eq(merged.sources, { appearance: 'chat', nl: 'global', outfit: 'global', aliases: 'union' });
// 全局库仍然只读：AI 块改不动它
assert.equal(data.characters.xue.appearance.length, 2);

// 6) 手改档：早先楼层的 ops 收成历史，之后能回滚
assert.equal(C.saveChatEntry({ ...C.chatLatest().find(item => item.name === '小雨'), appearance: [{ en: '1girl' }, { en: 'bob cut' }] }, '小雨'), true);
assert.equal(chat.chat[1].extra.zhikuCharOps, undefined, '手动改档后这一楼的 ops 要清掉');
const after = C.chatBaseEntries().find(item => item.name === '小雨');
eq(after.appearance.map(t => t.en), ['1girl', 'bob cut']);
assert.equal(after.source, 'manual');
assert.equal(after.history.at(-1).field, 'manual');
assert(after.history.some(record => record.field === 'appearance'), '早先的 ops 要收成历史');
// 回滚到「变化之前」那条记录：short black hair，没有红眼
const backIndex = after.history.findIndex(record => record.field === 'appearance');
assert(backIndex >= 0, '要有外貌变化记录');
assert.equal(C.chatEntryRollback('小雨', backIndex), true);
eq(C.chatBaseEntries().find(item => item.name === '小雨').appearance.map(t => t.en), ['1girl', 'short black hair']);

// 7) 关掉自动建档：不再解析
data.options.charAutoBlocks = false;
const msg = { mes: '<人物>\n名字: 新人\n外貌: 1boy\n</人物>', swipe_id: 0, extra: {} };
chat.chat.push(msg);
assert.equal(C.applyCharacterBlocks(2), 0);
assert.equal(msg.extra.zhikuCharOps, undefined);
data.options.charAutoBlocks = true;

console.log('PASS: 运行时接线（块收进 extra、按楼层与位置重放、roster、markerPrompt 认本聊天档案、宏、双层库回落、手改保留历史与清 ops、回滚、开关）。');