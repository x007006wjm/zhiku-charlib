// 本聊天角色库的运行时辅助：按楼层重放、双层库合并、块解析、roster 注入、世界书宏。
// 这些函数会被内联进 runtime.js 的 chars 模块里（tools/apply-char-lib.mjs），
// 因此可以直接用模块内的 getData / commit / ctx / M / N / E / T 以及 char-blocks.js 的函数。

function allChars() {
    return Object.values(getData().characters || {}).map(ensureAliases);
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
function applyCharacterBlocks(id, { save = true } = {}) {
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
    if (built.logs?.length) console.info('[智库] 角色块：' + built.logs.join('；'));
    const swipe = Number.isInteger(msg.swipe_id) ? msg.swipe_id : 0;
    const existing = msg.extra?.[CHAR_OPS_KEY];
    if (existing && Number(existing.swipe) === swipe && sameCharOps(existing.ops, built.ops)) return built.ops.length;
    const payload = messageOpsPayload(built.ops, swipe);
    msg.extra ||= {};
    if (payload) msg.extra[CHAR_OPS_KEY] = payload;
    else delete msg.extra[CHAR_OPS_KEY];
    try { if (save) void c.saveChat?.(); } catch (error) { console.warn('[智库] 保存角色块失败', error); }
    invalidateCharState();
    if (built.ops.length && save && getData().options.charBlockToast !== false) {
        const text = built.ops.map(op => op.kind === 'new' ? `新建角色 ${op.name}` : `${op.name} 外貌变化`).join(' / ');
        toastr.info('智库：' + text, '角色档案', { timeOut: 3000 });
    }
    return built.ops.length;
}

/** 切聊天 / 载入历史时把整段聊天过一遍（只保存一次）。 */
function applyAllCharacterBlocks() {
    if (getData().options.charAutoBlocks === false) return 0;
    const c = ctx();
    const chat = c?.chat || [];
    let blocks = 0;
    const before = new Map();
    for (let i = 0; i < chat.length; i += 1) {
        before.set(i, JSON.stringify(chat[i]?.extra?.[CHAR_OPS_KEY] || null));
        blocks += applyCharacterBlocks(i, { save: false });
    }
    let changed = false;
    for (let i = 0; i < chat.length; i += 1) {
        if (before.get(i) !== JSON.stringify(chat[i]?.extra?.[CHAR_OPS_KEY] || null)) { changed = true; break; }
    }
    if (changed) { try { void c?.saveChat?.(); } catch (error) { console.warn('[智库] 保存角色块失败', error); } }
    invalidateCharState();
    return blocks;
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
    // 全局角色用 map 存衣服；这里换一批 id，并把 outfitId 指到对应的那件
    const index = Math.max(0, (global.outfits || []).findIndex(outfit => outfit.id === global.outfitId));
    const outfits = (global.outfits || []).map(outfit => ({ ...outfit, id: M.uid('o_') }));
    d.characters[key] = {
        key,
        kind: 'free',
        name: uniqueName(global.name),
        avatar: '',
        card: '',
        appearance: global.appearance,
        nsfwBody: [],
        outfitMode: global.outfitMode,
        outfits,
        outfitId: outfits[index]?.id || '',
        negative: '',
        charRef: '',
        aliases: (global.aliases || []).join('，'),
        nl: global.nl || '',
    };
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

// ── 流式阶段的临时档案 ──
// 回复还在流的时候消息还没进 chat，但 <人物> 块已经写完了：这里先按流式文本算一份，
// 让这一楼的第一张图就能带上新角色的外貌，而不是等落地后才发现。
let stagedText = '';
function stageStreamText(text) {
    stagedText = String(text || '');
}
function stagedStreamOps(floor, pos) {
    const c = ctx();
    const chat = c?.chat || [];
    const at = Number(floor);
    if (!Number.isFinite(at) || at !== chat.length) return null;
    if (!stagedText || getData().options.charAutoBlocks === false) return null;
    if (!/<(?:人物|外貌变化)>/.test(stagedText)) return null;
    const locked = lockedCharNames(getData().characters || {}, chatBaseEntries());
    const prior = chatTimeline().stateAt(chat.length - 1);
    const known = new Set(prior.map(entry => entry.name));
    const built = buildCharOpsIfEnabled(stagedText, { enabled: true, locked, known });
    if (!built.ops.length) return null;
    const ops = Number.isFinite(pos) ? built.ops.filter(op => op.kind === 'new' || !Number.isFinite(op.pos) || pos > op.pos) : built.ops;
    return applyCharOps(prior, ops, at, { locked, pos });
}

/**
 * 这一楼这一位置能用的角色名单：出场全局角色 + 到这一层为止的本聊天档案。
 * 同名时本聊天档案覆盖全局条目（否则上游按名字匹配会撞成「匹配到多人」）。
 * nl 接在该角色外貌 tag 之后，当作 NovelAI 分角色 caption 的自然语言补充。
 */
function rosterAt(floor, pos) {
    const rows = currentCast().map(row => ({ ...row, char: ensureAliases(row.char) }));
    const byName = new Map(allChars().map(character => [String(character.name || '').trim(), character]));
    const c = ctx();
    const last = Math.max(0, (c?.chat?.length ?? 0) - 1);
    const at = Number.isFinite(Number(floor)) ? Number(floor) : last;
    const filtered = Number.isFinite(Number(pos)) ? Number(pos) : undefined;
    const state = stagedStreamOps(at, filtered) || chatStateAt(at, filtered);
    for (const entry of state) {
        const merged = mergeCharacterLayers(entry, byName.get(entry.name));
        const value = merged?.entry || entry;
        const shared = byName.get(entry.name) || {};
        const appearance = Array.isArray(value.appearance) ? value.appearance.map(item => ({ ...item })) : [];
        if (value.nl) appearance.push({ en: String(value.nl), zh: '' });
        const packed = {
            key: 'chat:' + value.name,
            kind: 'free',
            name: value.name,
            avatar: '',
            card: '',
            appearance,
            nsfwBody: Array.isArray(shared.nsfwBody) ? shared.nsfwBody : [],
            outfitMode: value.outfitMode,
            outfits: Array.isArray(value.outfits) ? value.outfits : [],
            outfitId: value.outfitId || '',
            negative: String(shared.negative || ''),
            charRef: String(value.charRef || shared.charRef || ''),
            aliases: (value.aliases || []).join('，'),
            nl: value.nl || '',
        };
        const index = rows.findIndex(row => String(row.char?.name || '').trim() === value.name);
        if (index >= 0) rows[index] = { ...rows[index], char: { ...rows[index].char, ...packed, on: rows[index].on } };
        else rows.push({ key: packed.key, char: packed, on: true, group: 'char' });
    }
    return rows;
}

/** 世界书宏 {{zhiku_characters}} 的内容：本聊天角色（与全局同名条目字段级合并）+ 出场全局角色（锁定的标出来）。 */
function characterMacroText() {
    const base = chatBaseEntries();
    return chatMacroText(chatLatest(), currentCast(), {
        locked: lockedCharNames(getData().characters || {}, base),
        globals: allChars(),
    });
}
