// 角色外观库补丁：把 src/char-expand.js / char-blocks.js / char-macro.js 内联进脚本，并接上
// ① 标记里的 $名字$ 展开（按楼层）；② 角色别名 aliases；③ 世界书宏 {{zhiku_characters}}；
// ④ <人物>/<外貌变化> 块 → 本楼 ops；⑤ 本聊天库 + 全局库两层；⑥ 设置开关；⑦ 角色页「本聊天角色」。
// 由 build-extension.mjs 在最后一步调用（此时前面的补丁都已应用）。
import fs from 'node:fs';
import assert from 'node:assert/strict';

function moduleSource(name) {
    return fs.readFileSync(new URL('../src/' + name, import.meta.url), 'utf8').replace(/\r\n/g, '\n').replace(/^export /gm, '');
}

const CHARS_HELPERS = `function allChars() {
    return Object.values(getData().characters).map(ensureAliases);
}

function chatMeta() {
    const c = ctx();
    if (!c) return null;
    if (!c.chatMetadata) { try { c.chatMetadata = {}; } catch (error) { return null; } }
    return c.chatMetadata || null;
}
function saveChatMeta() {
    const c = ctx();
    try { c?.saveMetadata?.(); } catch (error) { /* 宿主不支持就算了 */ }
    try { c?.saveMetadataDebounced?.(); } catch (error) { /* 同上 */ }
}
function chatBaseEntries() {
    return normalizeChatStore(chatMeta()?.[CHAT_META_KEY]);
}
function writeChatBase(entries) {
    const meta = chatMeta();
    if (!meta) return false;
    meta[CHAT_META_KEY] = chatStorePayload(entries);
    saveChatMeta();
    invalidateCharState();
    return true;
}
let charStateCache = null;
function chatTimeline() {
    const chat = ctx()?.chat || [];
    const base = chatBaseEntries();
    const locked = lockedCharNames(getData().characters || {}, base);
    const key = charCacheKey(chat, base) + '|L:' + [...locked].sort().join(',');
    if (charStateCache && charStateCache.key === key) return charStateCache.timeline;
    const timeline = deriveTimeline(base, chat, { locked });
    charStateCache = { key, timeline };
    return timeline;
}
function invalidateCharState() { charStateCache = null; }
function chatStateAt(floor, pos) { return chatTimeline().stateAt(floor, pos); }
function chatLatest() { return chatTimeline().latest(); }
function chatLockedNames() {
    return lockedCharNames(getData().characters || {}, chatBaseEntries());
}

/** 本聊天条目 + 同名全局角色做字段级合并，给 UI 与宏用。 */
function mergedChatEntries() {
    const globals = allChars();
    const byName = new Map(globals.map(character => [String(character.name || '').trim(), character]));
    return chatLatest().map(entry => {
        const merged = mergeCharacterLayers(entry, byName.get(entry.name));
        return { entry: merged?.entry || entry, sources: merged?.sources || {}, base: entry };
    });
}

/** 回复里的 <人物> / <外貌变化> → 本楼 ops（按楼层重放，不写基线）。 */
function applyCharacterBlocks(id) {
    if (getData().options.charAutoBlocks === false) return 0;
    const c = ctx();
    const msg = c?.chat?.[Number(id)];
    if (!msg || msg.is_system) return 0;
    const floor = Number(id);
    const base = chatBaseEntries();
    const locked = lockedCharNames(getData().characters || {}, base);
    const prior = chatTimeline().stateAt(floor - 1);
    const known = new Set(prior.map(entry => entry.name));
    const built = buildCharOpsIfEnabled(String(msg.mes || ''), { enabled: getData().options.charAutoBlocks !== false, locked, known });
    if (built.logs.length) console.info('[智库] 角色块：' + built.logs.join('；'));
    const swipe = Number.isInteger(msg.swipe_id) ? msg.swipe_id : 0;
    const existing = msg.extra?.[CHAR_OPS_KEY];
    if (existing && Number(existing.swipe) === swipe && sameCharOps(existing.ops, built.ops)) return built.ops.length;
    const payload = messageOpsPayload(built.ops, swipe);
    msg.extra ||= {};
    if (payload) msg.extra[CHAR_OPS_KEY] = payload;
    else delete msg.extra[CHAR_OPS_KEY];
    try { void c.saveChat?.(); } catch (error) { console.warn('[智库] 保存角色块失败', error); }
    invalidateCharState();
    if (built.ops.length && getData().options.charBlockToast !== false) {
        const text = built.ops.map(op => op.kind === 'new' ? \`新建角色 \${op.name}\` : \`\${op.name} 外貌变化\`).join(' / ');
        toastr.info('智库：' + text, '角色档案', { timeOut: 3000 });
    }
    return built.ops.length;
}

function stripOpsEverywhere(name) {
    const c = ctx();
    const removed = stripOpsForName(c?.chat || [], name);
    if (removed) { try { void c?.saveChat?.(); } catch (error) { /* ignore */ } invalidateCharState(); }
    return removed;
}
function saveChatEntry(entry, oldName, { reason = '手动' } = {}) {
    const name = String(entry?.name || '').trim();
    if (!name) return false;
    const old = String(oldName || name);
    const base = chatBaseEntries();
    const previous = base.find(item => item.name === old) || null;
    // 先把这个名字在各楼层的 ops 收成字段级历史，再清掉 ops；这样手动值不会被重放覆盖，历史也还在。
    const absorbed = historyFromOps(chatTimeline(), old, ctx()?.chat || []);
    const next = normalizeChatEntry({ ...entry, name, source: 'manual' });
    if (!next) return false;
    next.history = capHistory([...(previous?.history || []), ...absorbed, manualHistoryRecord(next, reason)]);
    const index = base.findIndex(item => item.name === old);
    const dup = base.findIndex(item => item.name === name);
    if (index >= 0) base[index] = next;
    else if (dup >= 0) base[dup] = next;
    else base.push(next);
    writeChatBase(base);
    stripOpsEverywhere(old);
    if (old !== name) stripOpsEverywhere(name);
    return true;
}
function deleteChatEntry(name) {
    const clean = String(name || '').trim();
    if (!clean) return false;
    const base = chatBaseEntries();
    const entry = base.find(item => item.name === clean);
    if (entry) {
        const absorbed = historyFromOps(chatTimeline(), clean, ctx()?.chat || []);
        entry.history = capHistory([...(entry.history || []), ...absorbed, manualHistoryRecord(entry, '手动删除')]);
    }
    writeChatBase(base.filter(item => item.name !== clean));
    stripOpsEverywhere(clean);
    return true;
}
function chatEntryRollback(name, index) {
    const entry = chatLatest().find(item => item.name === name) || chatBaseEntries().find(item => item.name === name);
    const record = entry?.history?.[Number(index)];
    if (!record) return false;
    if (record.field === 'new') return deleteChatEntry(entry.name);
    const patch = {
        name: entry.name,
        aliases: entry.aliases,
        appearance: entry.appearance,
        nl: entry.nl,
        outfitMode: entry.outfitMode,
        outfitModeExplicit: entry.outfitModeExplicit,
        outfits: entry.outfits,
        outfitId: entry.outfitId,
    };
    if (record.field === 'appearance' || record.field === 'manual') patch.appearance = pairsFromTags(record.from);
    else if (record.field === 'nl') patch.nl = record.from;
    else if (record.field === 'outfit') {
        if (record.from === '跟剧情') {
            patch.outfitMode = 'story';
            patch.outfitModeExplicit = true;
        } else {
            const id = 'o_rollback';
            patch.outfits = [{ id, name: '固定着装', tags: pairsFromTags(String(record.from || '').replace(/^固定：/, '')) }];
            patch.outfitId = id;
            patch.outfitMode = 'fixed';
            patch.outfitModeExplicit = true;
        }
    }
    return saveChatEntry(patch, entry.name, { reason: '手动回滚' });
}
function promoteChatEntry(name) {
    const entry = chatLatest().find(item => item.name === name);
    if (!entry) return false;
    const global = globalFromChatEntry(entry);
    if (!global) return false;
    const d = getData();
    d.characters ||= {};
    const key = 'free:' + M.uid('');
    d.characters[key] = { ...global, key, kind: 'free', name: uniqueName(global.name) };
    commit();
    deleteChatEntry(entry.name);
    return true;
}
function copyGlobalToChat(key) {
    const character = getData().characters?.[key];
    if (!character) return false;
    const entry = entryFromGlobal(ensureAliases(character));
    if (!entry) return false;
    const base = chatBaseEntries();
    const index = base.findIndex(item => item.name === entry.name);
    if (index >= 0) base[index] = entry; else base.push(entry);
    writeChatBase(base);
    stripOpsEverywhere(entry.name);
    return true;
}

/** 把一条 JSON 标记解析成计划（每个角色的最终 caption、nl、charRef、size）；不是 JSON 返回 null。 */
function markerPlanFor(text, meta = {}) {
    const payload = parseMarkerJson(text);
    if (!payload) return null;
    const floor = Number.isInteger(meta?.msgId) ? meta.msgId : ((ctx()?.chat?.length ?? 0) - 1);
    const pos = Number.isFinite(meta?.pos) ? meta.pos : undefined;
    const cast = currentCast();
    const globals = allChars();
    // 本聊天条目先与同名全局角色做字段级合并（外貌/描述/服装为空时回落全局，别名并集），$名字$ 展开与 JSON 查库都用合并结果。
    const chatEntries = mergeChatEntriesWithGlobals(chatStateAt(floor, pos), globals);
    const chatIndex = buildCharacterIndex([], [], chatEntries);
    const globalIndex = buildCharacterIndex(cast, globals, []);
    const lookup = name => {
        const key = String(name ?? '').trim().toLowerCase();
        const found = chatIndex.get(key) || globalIndex.get(key);
        if (!found) return null;
        return { tags: fixedTagsOf(found), nl: String(found.nl || '').trim(), charRef: String(found.charRef || '') };
    };
    const expand = value => expandCharacterRefs(value, {
        chatEntries,
        cast,
        characters: globals,
        enabled: true,
        log: message => console.info(message),
    });
    return buildMarkerPlan(payload, { lookup, expand });
}
function planMarker(text, meta) { return markerPlanFor(text, meta); }

/**
 * 标记里的 $名字$：本楼的本聊天档案优先，其次出场全局角色，最后其余全局角色。
 * meta.pos 是标记在消息里的起始位置，用来只应用它之前的 <外貌变化>。
 * JSON 标记原样交给 generate（generate 里再解析），记录里存可读的 base + captions。
 */
function expandMarkerPrompt(text, meta = {}) {
    const plan = markerPlanFor(text, meta);
    if (plan) return { text: String(text), record: plan.recordPrompt };
    const floor = Number.isInteger(meta?.msgId) ? meta.msgId : ((ctx()?.chat?.length ?? 0) - 1);
    const pos = Number.isFinite(meta?.pos) ? meta.pos : undefined;
    const globals = allChars();
    return expandCharacterRefs(text, {
        chatEntries: mergeChatEntriesWithGlobals(chatStateAt(floor, pos), globals),
        cast: currentCast(),
        characters: globals,
        enabled: getData().options.markerCharExpand !== false,
        log: message => console.info(message),
    });
}

/** 世界书宏 {{zhiku_characters}} 的内容：本聊天角色（与全局同名条目字段级合并）+ 出场全局角色（锁定的标出来）。 */
function characterMacroText() {
    const base = chatBaseEntries();
    return chatMacroText(chatLatest(), currentCast(), {
        locked: lockedCharNames(getData().characters || {}, base),
        globals: allChars(),
    });
}

`;

const CHAT_VIEWS = `function viewChatLib() {
    const d = getData();
    const merged = C.mergedChatEntries();
    const locked = C.chatLockedNames();
    const srcTag = (sources, key) => sources[key] === 'global' ? '（来自全局）' : sources[key] === 'union' ? '（合并）' : '';
    const rows = merged.map(({ entry, sources }) => \`<div class="pc-who">
      <div class="pc-grow"><b>\${esc(entry.name)}</b><small>\${entry.source === 'ai' ? 'AI 建档' : '手动'} · \${esc(C.tagText(entry.appearance)) || '（没有外貌）'}\${entry.outfitMode === 'fixed' ? \` · 固定衣服\${srcTag(sources, 'outfit')}\` : ''}\${entry.nl ? \` · 描述\${srcTag(sources, 'nl')}\` : ''}\${sources.aliases === 'union' ? ' · 别名（合并）' : ''}</small></div>
      <div class="pc-chips wrap">
        <button class="pc-pill dashed tiny" data-act="chatlibedit" data-name="\${esc(entry.name)}">编辑</button>
        <button class="pc-pill dashed tiny" data-act="chatlibhist" data-name="\${esc(entry.name)}">历史</button>
        <button class="pc-pill dashed tiny" data-act="chatlibpromote" data-name="\${esc(entry.name)}">提升为全局</button>
        <button class="pc-pill dashed tiny danger" data-act="chatlibdel" data-name="\${esc(entry.name)}">删除</button>
      </div></div>\`).join('');
    const lockedRows = Object.values(d.characters || {}).filter(c => locked.has(c.name)).map(c => \`<div class="pc-who">
      <div class="pc-grow"><b>\${esc(c.name)}</b><small>全局库 · 固定，不可改\${c.nl ? ' · 有描述' : ''}</small></div>
      <button class="pc-pill dashed tiny" data-act="chatlibcopy" data-key="\${esc(c.key || '')}">复制到本聊天</button></div>\`).join('');
    return \`<div class="pc-dhead"><button class="pc-round" data-act="nav" data-view="cast" aria-label="返回">‹</button><div class="pc-grow"><h2 class="pc-dtitle">本聊天角色</h2><div class="pc-tip" style="margin:0">按楼层重放：改档只影响它之后的楼层；空字段回落到同名全局角色。</div></div></div>
    <section class="pc-card pc-pad pc-mt"><div class="pc-row-between"><b>本聊天档案</b><button class="pc-pill dashed tiny" data-act="chatlibnew">＋ 新建</button></div>
    \${rows || '<div class="pc-dim small">还没有本聊天角色。AI 回复里写 &lt;人物&gt; 就会自动建档。</div>'}</section>
    <section class="pc-card pc-pad pc-mt"><b>全局角色（固定）</b><div class="pc-dim small">AI 不会改全局角色；想要它在本聊天可改，就复制一份到本聊天。</div>\${lockedRows || '<div class="pc-dim small">没有全局角色</div>'}</section>
    <div style="height:24px"></div>\`;
}

function viewChatHist() {
    const entry = C.chatLatest().find(e => e.name === ui.chatHistName) || C.chatBaseEntries().find(e => e.name === ui.chatHistName);
    const history = entry?.history || [];
    const FIELD = { new: '建档', appearance: '外貌', outfit: '服装', nl: '描述', manual: '手动' };
    const rows = history.map((h, i) => \`<div class="pc-who">
      <div class="pc-grow"><b>\${h.floor >= 0 ? \`第 \${h.floor + 1} 楼\` : '手动'} · \${esc(h.reason || '变化')} · \${FIELD[h.field] || esc(h.field)}</b><small>\${esc(h.from || '（无）')} → \${esc(h.to || '（无）')}</small></div>
      <button class="pc-pill dashed tiny" data-act="chatlibrollback" data-name="\${esc(entry.name)}" data-index="\${i}">回到这里</button></div>\`).join('');
    return \`<div class="pc-dhead"><button class="pc-round" data-act="nav" data-view="chatlib" aria-label="返回">‹</button><div class="pc-grow"><h2 class="pc-dtitle">\${esc(ui.chatHistName || '')} · 档案历史</h2></div></div>
    <section class="pc-card pc-pad pc-mt">\${rows || '<div class="pc-dim small">还没有记录。</div>'}</section>
    <div class="pc-hint">「回到这里」会把当时的字段写成手动值（手动值优先，AI 之后的改动仍会记在历史里）。</div>\`;
}

`;

export function applyCharLibrary(source) {
    let s = source;
    function patch(a, b, label) {
        const count = s.split(a).length - 1;
        assert.equal(count, 1, 'char-lib patch matched ' + count + ' times (' + label + '): ' + a.slice(0, 90));
        s = s.replace(a, () => b);
    }

    // ① 内联纯逻辑模块（放在 chars 模块之前，函数声明会提升）
    patch('// ───── chars.js ─────',
        moduleSource('char-expand.js') + '\n' + moduleSource('char-marker-json.js') + '\n' + moduleSource('char-blocks.js') + '\n' + moduleSource('char-macro.js') + '\n// ───── chars.js ─────',
        'inline modules');

    // ② 角色的 aliases 字段：新建的角色带上空数组，旧数据没有也照常工作
    patch("const blank = src => ({\n    key: src.key, kind: src.kind, name: src.name, avatar: src.avatar || '', card: src.card || '',\n    appearance: [], outfitMode: 'story', outfits: [], outfitId: '', negative: '', charRef: '',\n});",
        "const blank = src => ({\n    key: src.key, kind: src.kind, name: src.name, avatar: src.avatar || '', card: src.card || '',\n    appearance: [], aliases: [], nl: '', outfitMode: 'story', outfits: [], outfitId: '', negative: '', charRef: '',\n});",
        'blank aliases');

    // 读角色时把 aliases 归一化（字符串/数组/旧数据都认）
    patch('if (d.characters[key]) return d.characters[key];',
        'if (d.characters[key]) return ensureAliases(d.characters[key]);',
        'getChar normalize aliases');
    // 载入数据时也归一化一次：旧存档里 aliases 可能是字符串，写回时就统一成数组
    patch("    for (const a of Object.values(d.artists)) { a.images ||= []; a.note ||= ''; a.collections ||= []; a.tag = normalizeArtistTag(a.tag); }\n",
        "    for (const a of Object.values(d.artists)) { a.images ||= []; a.note ||= ''; a.collections ||= []; a.tag = normalizeArtistTag(a.tag); }\n"
        + "    for (const character of Object.values(d.characters || {})) ensureAliases(character);\n",
        'normalizeData aliases');

    // ③ 设置默认值
    patch('            lobbyShowNsfw: false,\n',
        '            lobbyShowNsfw: false,\n'
        + '            markerCharExpand: true,   // 标记里展开 $角色名$（角色固定外貌）\n'
        + '            charAutoBlocks: true,     // 从回复的 <人物>/<外貌变化> 自动建档\n'
        + '            charBlockToast: true,     // 建档/改档时每楼一条小提示\n'
        + '            markerResultExpand: true, // 生成完自动展开结果图\n'
        + '            markerStream: true,       // 流式预生成：标记一成型就先出图\n',
        'options default');

    // ④ chars 模块：本聊天库 + 按楼层重放 + 块解析 + 展开 + 宏
    patch('\nreturn { avatarUrl, stCards, stPersonas,',
        '\n' + CHARS_HELPERS + 'return { avatarUrl, stCards, allChars, mergedChatEntries, expandMarkerPrompt, planMarker, characterMacroText, chatBaseEntries, writeChatBase, chatStateAt, chatLatest, chatLockedNames, applyCharacterBlocks, invalidateCharState, saveChatEntry, deleteChatEntry, chatEntryRollback, promoteChatEntry, copyGlobalToChat, stPersonas,',
        'chars exports');

    // 「把一个角色的外貌套到另一个角色上」也带上描述 nl
    patch('    b.negative = a.negative;\n',
        '    b.negative = a.negative;\n    b.nl = String(a.nl || \'\');\n',
        'copyLook nl');

    // ⑤ 分享/导入时带上别名与描述 nl
    patch('return { character: { name: c.name, appearance: c.appearance,',
        'return { character: { name: c.name, aliases: splitAliases(c.aliases), nl: String(c.nl || \'\').trim(), appearance: c.appearance,',
        'characterPayload aliases');
    patch("? { name: src.name, appearance: src.appearance, outfitMode: src.outfitMode || 'story',",
        "? { name: src.name, aliases: splitAliases(src.aliases), nl: String(src.nl || '').trim(), appearance: src.appearance, outfitMode: src.outfitMode || 'story',",
        'saveCharacterPost aliases');
    patch("        name: ch.nameCN || ch.nameEN || '角色',\n        appearance: parsePairs(",
        "        name: ch.nameCN || ch.nameEN || '角色',\n        aliases: splitAliases(ch.nameEN),\n        appearance: parsePairs(",
        'zhihuiji import aliases');

    // ⑥ 启动：开关默认值 + 注册世界书宏（stop 时注销）
    patch('    if (getData().options.markerAuto === undefined) getData().options.markerAuto = true;\n',
        '    if (getData().options.markerAuto === undefined) getData().options.markerAuto = true;\n'
        + '    if (getData().options.markerCharExpand === undefined) getData().options.markerCharExpand = true;\n'
        + '    if (getData().options.charAutoBlocks === undefined) getData().options.charAutoBlocks = true;\n'
        + '    if (getData().options.charBlockToast === undefined) getData().options.charBlockToast = true;\n'
        + '    if (getData().options.markerResultExpand === undefined) getData().options.markerResultExpand = true;\n'
        + '    if (getData().options.markerStream === undefined) getData().options.markerStream = true;\n'
        + '    __mod_chars.invalidateCharState();\n'
        + '    const charMacro = installCharMacro(SillyTavern.getContext(), {\n'
        + '        text: () => __mod_chars.characterMacroText(),\n'
        + '        log: message => console.warn(message),\n'
        + '    });\n'
        + '    cleanups.push(() => charMacro.uninstall());\n',
        'start macro');

    // ⑦ 标记生图：把 $名字$ 在 composeStudio/mergeTags 之前展开（带楼层）
    // 流式预生成要读"正在流出来的那段文字"：宿主没有公开缓冲，就从最后一条消息的 DOM 里取
    patch('getData:__mod_store.getData,document:DOC,',
        'getData:__mod_store.getData,expandPrompt:(prompt,meta)=>__mod_chars.expandMarkerPrompt(prompt,meta),'
        + 'getStreamingText:()=>{const c=SillyTavern.getContext();'
        + 'const live=c.streamingProcessor?.messageText;if(typeof live==="string"&&live)return live;'
        + 'const node=[...DOC.querySelectorAll("#chat .mes[mesid]")].pop();const body=node?.querySelector(".mes_text");'
        + 'if(!body)return "";const clone=body.cloneNode(true);'
        + 'clone.querySelectorAll(".pc-marker-slot,.pc-image-actions").forEach(el=>el.remove());'
        + 'return clone.textContent||"";},document:DOC,',
        'marker expand wiring');

    // ⑦b JSON 标记：base + 每个角色的 caption 走 NovelAI 分角色（v3 / 酒馆代理回落到 base）；按 size 交换宽高；带上命中角色的 charRef
    patch(
        `generate:async prompt=>{const d=__mod_store.getData();const {positive,negative}=__mod_engine.composeStudio({pos:__mod_model.mergeTags(d.active?__mod_model.ticketString(d,d.active):'',prompt),neg:[d.active?__mod_model.ticketNeg(d,d.active):'',d.options.chatNegative||''].filter(Boolean).join(', ')});const bound=[...new Set(__mod_chars.currentCast().filter(x=>x.on).map(x=>x.char.charRef).filter(id=>id&&d.charRefGroups?.[id]))];const image=await __mod_engine.generateFull({positive,negative,director:bound.length?await __mod_engine.charRefs(bound):undefined});__mod_engine.afterChatImage();return image;},`,
        `generate:async (prompt,meta)=>{
            const d=__mod_store.getData();
            const plan=__mod_chars.planMarker(prompt,meta);
            const base=plan?plan.base:prompt;
            const {positive,negative}=__mod_engine.composeStudio({pos:__mod_model.mergeTags(d.active?__mod_model.ticketString(d,d.active):'',base),neg:[d.active?__mod_model.ticketNeg(d,d.active):'',d.options.chatNegative||''].filter(Boolean).join(', ')});
            let finalPositive=positive;
            let chars=plan?plan.characters.map(entry=>({prompt:entry.caption,uc:''})):[];
            let width;
            let height;
            if(plan){
                const nai=__mod_nai.settings();
                if(String(nai.novelaimode)==='nai-diffusion-3'||nai.naiMode==='tavern'){
                    finalPositive=__mod_model.mergeTags(positive,...chars.map(entry=>entry.prompt));
                    chars=[];
                }
                const swapped=swapSizeForOrientation(plan.size,Number(nai.novelai_width),Number(nai.novelai_height));
                if(swapped.width){ width=swapped.width; height=swapped.height; }
            }
            const bound=[...new Set([...__mod_chars.currentCast().filter(x=>x.on).map(x=>x.char.charRef),...(plan?plan.charRefs:[])].filter(id=>id&&d.charRefGroups?.[id]))];
            const image=await __mod_engine.generateFull({positive:finalPositive,negative,chars,width,height,director:bound.length?await __mod_engine.charRefs(bound):undefined});
            __mod_engine.afterChatImage();
            return image;
        },`,
        'json marker generate');

    // ⑧ 设置页：新增开关
    patch("${sw('markerAuto', '开启标记自动生图', '默认开启 · 回复出现完整生图标记时自动生成，提示词默认折叠')}</div>",
        "${sw('markerAuto', '开启标记自动生图', '默认开启 · 回复出现完整生图标记时自动生成，提示词默认折叠')}"
        + "${sw('markerCharExpand', '标记里展开 $角色名$', '把 $名字$ 换成该角色的固定外貌（外貌 tag + 固定衣服）')}</div>",
        'settings toggle expand');
    patch("${sw('markerCharExpand', '标记里展开 $角色名$', '把 $名字$ 换成该角色的固定外貌（外貌 tag + 固定衣服）')}</div>",
        "${sw('markerCharExpand', '标记里展开 $角色名$', '把 $名字$ 换成该角色的固定外貌（外貌 tag + 固定衣服）')}"
        + "${sw('charAutoBlocks', '从回复自动建档 / 记录外貌变化', '解析回复里的 &lt;人物&gt; / &lt;外貌变化&gt;，按楼层生效')}"
        + "${sw('charBlockToast', '建档时提示', '每楼最多一条小提示')}"
        + "${sw('markerResultExpand', '生成后自动展开图片', '默认开启 · 新生成的图片直接展开；历史图片仍然收起，点标题即可展开 / 收起')}"
        + "${sw('markerStream', '流式预生成', '默认开启 · 回复还在流、标记一写完整就先发生图请求，正文写完时图片往往已经好了')}</div>",
        'settings toggles');

    // ⑨ 角色页：别名输入 + 「会发送的内容」说明
    patch('    <details class="pc-fold"><summary><b>不想出现的</b>',
        '    <section class="pc-card pc-pad pc-mt">\n'
        + '      <label class="pc-field"><span>别名（| 或逗号分隔）</span><input class="pc-input" data-charaliases value="${esc(charAliasText(c))}" placeholder="小雪|Shirley"></label>\n'
        + '      <div class="pc-hint">生图标记里写 $名字$ 或别名，会展开成上面「固定外貌」那一串。</div>\n'
        + '      <label class="pc-field"><span>描述 nl（英文自然语言，可空）</span><textarea class="pc-textarea small" data-charnl rows="2" placeholder="a girl with long black hair and blue eyes">${esc(c.nl || \'\')}</textarea></label>\n'
        + '      <div class="pc-hint">只用于 JSON 标记：接在该角色 caption 的 tag 之后、AI 写的 nl 之前；纯文本 $名字$ 只展开 tag，不带描述。</div>\n'
        + '    </section>\n'
        + '    <details class="pc-fold"><summary><b>不想出现的</b>',
        'aliases input');
    patch('if (el.dataset.charneg !== undefined)',
        'if (el.dataset.charaliases !== undefined) { const c = C.getChar(ui.charKey); if (c) { c.aliases = splitAliases(el.value); C.saveChar(c); } return; }\n'
        + '    if (el.dataset.charnl !== undefined) { const c = C.getChar(ui.charKey); if (c) { c.nl = el.value.trim(); C.saveChar(c); } return; }\n'
        + '    if (el.dataset.charneg !== undefined)',
        'aliases input handler');
    patch('聊天生图时，再加上 AI 写的动作表情',
        '标记里写 $名字$ 或别名会展开成这一串；聊天生图时，再加上 AI 写的动作表情',
        'char preview hint');
    patch('<div class="pc-hint">再加上：当前画师串、AI 按剧情写的场景和动作、质量词。</div>',
        '<div class="pc-hint">标记里写 $名字$，会展开成对应角色的固定外貌（本聊天档案按楼层生效）。再加上：当前画师串、AI 按剧情写的场景和动作、质量词。</div>',
        'cast preview hint');

    // ⑩ 角色页入口 + 本聊天角色页
    patch('    <div class="pc-seg three pc-mt">',
        '    <section class="pc-card pc-pad pc-mt">\n'
        + '      <div class="pc-row-between"><b>本聊天角色</b><button class="pc-pill dashed tiny" data-act="openchatlib">管理</button></div>\n'
        + '      <div class="pc-dim small">AI 用 &lt;人物&gt; 建档、&lt;外貌变化&gt; 改档，按楼层生效；这里是最新状态。</div>\n'
        + '    </section>\n'
        + '    <div class="pc-seg three pc-mt">',
        'cast chatlib entry');
    patch('const VIEWS = { cast: viewCast,',
        CHAT_VIEWS + 'const VIEWS = { cast: viewCast, chatlib: viewChatLib, charhist: viewChatHist,',
        'views');
    patch("const mainView = ['artist', 'group', 'batch'].includes(ui.view) ? 'book' : ['charedit', 'outfit'].includes(ui.view) ? 'cast' : ui.view;",
        "const mainView = ['artist', 'group', 'batch'].includes(ui.view) ? 'book' : ['charedit', 'outfit', 'chatlib', 'charhist'].includes(ui.view) ? 'cast' : ui.view;",
        'mainView');
    patch('async function charAction(act, el) {\n    const c = C.getChar(ui.charKey);\n    const d = getData();\n    switch (act) {',
        `async function charAction(act, el) {
    const c = C.getChar(ui.charKey);
    const d = getData();
    switch (act) {
        case 'openchatlib': ui.view = 'chatlib'; render(); root.querySelector('.pc-body')?.scrollTo(0, 0); return true;
        case 'chatlibhist': ui.chatHistName = el.dataset.name; ui.view = 'charhist'; render(); return true;
        case 'chatlibnew': {
            const name = await promptText('新角色名？', '');
            if (!name) return true;
            const appearance = await promptText('外貌标签（英文逗号分隔；同名全局角色存在时可留空=沿用全局）', '', true);
            const nl = await promptText('描述 nl（英文自然语言，可留空）', '', true);
            const outfit = await promptText('固定衣服（留空=跟剧情/沿用全局）', '', true);
            saveManualChatEntry({ name, appearance, nl, outfit }, name, null);
            return true;
        }
        case 'chatlibedit': {
            const entry = C.chatLatest().find(e => e.name === el.dataset.name) || C.chatBaseEntries().find(e => e.name === el.dataset.name);
            if (!entry) return true;
            const name = await promptText('名字', entry.name);
            if (!name) return true;
            const aliases = await promptText('别名（| 或逗号分隔）', (entry.aliases || []).join('|'));
            const appearance = await promptText('外貌标签（英文逗号分隔；留空=沿用同名全局角色）', C.tagText(entry.appearance), true);
            const nl = await promptText('描述 nl（英文自然语言；留空=沿用同名全局角色）', entry.nl || '', true);
            const outfit = await promptText('固定衣服（留空=跟剧情/沿用全局）', entry.outfitMode === 'fixed' ? C.tagText(C.currentOutfit(entry)?.tags) : '', true);
            saveManualChatEntry({ name, aliases, appearance, nl, outfit }, el.dataset.name, entry);
            return true;
        }
        case 'chatlibrollback': {
            if (C.chatEntryRollback(el.dataset.name, Number(el.dataset.index))) { toastr.success('已回到所选档案', '角色档案'); ui.view = 'chatlib'; render(); }
            return true;
        }
        case 'chatlibdel': {
            if (await confirmBox(\`删除本聊天角色「\${el.dataset.name}」？这个名字早先楼层的自动变更记录也会清掉。\`)) {
                C.deleteChatEntry(el.dataset.name); render(); toastr.success('已删除', '角色档案');
            }
            return true;
        }
        case 'chatlibpromote': {
            if (!(await confirmBox(\`把「\${el.dataset.name}」提升为全局角色？之后所有聊天都能用，AI 不再修改它。\`))) return true;
            if (C.promoteChatEntry(el.dataset.name)) { render(); toastr.success('已提升为全局角色', '角色档案'); }
            return true;
        }
        case 'chatlibcopy': {
            if (C.copyGlobalToChat(el.dataset.key)) { render(); toastr.success('已复制到本聊天，AI 可以改它了', '角色档案'); }
            return true;
        }`,
        'charAction cases');

    // 手动编辑的公共写入口（放在 charAction 之前）
    patch('async function charAction(act, el) {',
        `function saveManualChatEntry(input, oldName, previous) {
    const name = String(input.name || '').trim();
    if (!name) return false;
    const tags = pairsFromTags(input.appearance || '');
    const outfitTags = pairsFromTags(input.outfit || '');
    const id = 'o_manual_' + Date.now();
    // 衣服没改就保持原来的「是否显式」状态（继续沿用全局）；改了（含清空）才算显式覆盖。
    const previousOutfit = previous && previous.outfitMode === 'fixed' ? tagsText(C.currentOutfit(previous)?.tags) : '';
    const outfitChanged = tagsText(outfitTags) !== previousOutfit;
    const ok = C.saveChatEntry({
        name,
        aliases: splitAliases(input.aliases !== undefined ? input.aliases : (previous ? previous.aliases : '')),
        appearance: tags,
        nl: String(input.nl || '').trim(),
        outfitMode: outfitTags.length ? 'fixed' : 'story',
        outfitModeExplicit: outfitChanged ? true : previous?.outfitModeExplicit === true,
        outfits: outfitTags.length ? [{ id, name: '固定着装', tags: outfitTags }] : [],
        outfitId: outfitTags.length ? id : '',
    }, oldName || name);
    if (ok) { toastr.success('已保存 ' + name, '角色档案'); render(); }
    else toastr.warning('保存失败：名字不能为空', '角色档案');
    return ok;
}

async function charAction(act, el) {`,
        'manual save helper');

    // ⑪ 事件：渲染/编辑/滑动/删楼时解析块；切聊天/改档时让缓存失效
    patch('    const onChat = () => setTimeout(() => { UI.renderChip(); UI.renderStub(); E.applyBindingOnChatChange(); addMesButtons(); }, 300);',
        '    const onChat = () => setTimeout(() => { __mod_chars.invalidateCharState(); UI.renderChip(); UI.renderStub(); E.applyBindingOnChatChange(); addMesButtons(); }, 300);',
        'chat changed invalidate');
    patch('    const onEdited = id => { onRendered(id); };',
        '    const onEdited = id => { onRendered(id); __mod_chars.invalidateCharState(); void __mod_chars.applyCharacterBlocks(Number(id)); };\n'
        + '    const onSwiped = id => { __mod_chars.invalidateCharState(); void __mod_chars.applyCharacterBlocks(Number(id)); };\n'
        + '    const onDeleted = () => { __mod_chars.invalidateCharState(); };',
        'edit/swipe/delete handlers');
    patch('    const onCharMsg = id => {\n        setTimeout(addMesButtons, 50);\n        setTimeout(() => { void __mod_marker.process(Number(id)); }, 0);\n    };',
        '    const onCharMsg = id => {\n        setTimeout(addMesButtons, 50);\n        setTimeout(() => { void __mod_chars.applyCharacterBlocks(Number(id)); }, 0);\n        setTimeout(() => { void __mod_marker.process(Number(id)); }, 0);\n    };',
        'char message parse blocks');
    patch('[event_types.MESSAGE_UPDATED, onEdited]]) {',
        '[event_types.MESSAGE_UPDATED, onEdited], [event_types.MESSAGE_SWIPED, onSwiped], [event_types.MESSAGE_DELETED, onDeleted]]) {',
        'register swipe/delete');

    // ⑫ 流式预生成：文字还在流的时候就看有没有已经闭合的标记，有就先发生图请求；
    //    新一次生成开始时把上一次没落地的预生成结果丢掉（换 swipe / 重新生成时不能串图）。
    patch('    eventSource.on(event_types.CHAT_CHANGED, onChat);',
        `    if (event_types.STREAM_TOKEN_RECEIVED) {
        let streamTimer = null, streamBusy = false;
        const onStreamToken = () => {
            if (streamTimer !== null) return;
            streamTimer = setTimeout(() => {
                streamTimer = null;
                if (streamBusy) return;
                streamBusy = true;
                Promise.resolve(__mod_marker.pregenSweep?.()).catch(e => console.warn('[智库] 流式预生成', e)).finally(() => { streamBusy = false; });
            }, 250);
        };
        eventSource.on(event_types.STREAM_TOKEN_RECEIVED, onStreamToken);
        cleanups.push(() => { if (streamTimer !== null) clearTimeout(streamTimer); eventSource.removeListener?.(event_types.STREAM_TOKEN_RECEIVED, onStreamToken); });
    } else {
        // 宿主没有流式事件（旧版 / 换了实现）：退化成轮询，一样的 250ms 节流
        const poll = setInterval(() => {
            try {
                const c = SillyTavern.getContext();
                if (c.is_send_press || c.generating || c.streamingProcessor?.isStreaming) void __mod_marker.pregenSweep?.();
            } catch (e) { /* 宿主没这个字段就算了 */ }
        }, 400);
        cleanups.push(() => clearInterval(poll));
    }
    if (event_types.GENERATION_STARTED) {
        const onGenerationStarted = () => __mod_marker.pregenReset?.();
        eventSource.on(event_types.GENERATION_STARTED, onGenerationStarted);
        cleanups.push(() => eventSource.removeListener?.(event_types.GENERATION_STARTED, onGenerationStarted));
    }
    eventSource.on(event_types.CHAT_CHANGED, onChat);`,
        'stream pregen events');

    return s;
}
