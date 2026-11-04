// 角色外观库：<人物> / <外貌变化> 块 → 按楼重放的角色档案。
// 纯函数，不碰 DOM、不发请求；构建时由 tools/apply-char-lib.mjs 去掉 export 后内联进 runtime.js。
// 设计（与 README「角色外观库」一节一致）：
// - 全局库 = piaoce_data.json 的 characters，AI 只读；本聊天库 = chatMetadata[CHAT_META_KEY]。
// - 回复里的块不直接写库，而是写成该消息的 ops（msg.extra[CHAR_OPS_KEY]），按楼层重放。
// - 状态(N) = 本聊天基线 + 第 0..N 楼（含本楼）的 ops；swipe 不匹配的 ops 忽略。

export const CHAT_META_KEY = 'zhiku_chat_chars';
export const CHAR_OPS_KEY = 'zhikuCharOps';
export const CHAR_BLOCK_TYPES = ['人物', '外貌变化'];

/** 用于正则里匹配两种块（不含 $ 与反斜杠问题）。 */
export const CHAR_BLOCK_PATTERN_SOURCE = '<(?:人物|外貌变化)>[\\s\\S]*?<\\/(?:人物|外貌变化)>';

/** 全角标点与全角尖括号 → 半角，便于解析。 */
export function normalizeBlockText(text) {
    return String(text ?? '')
        .replace(/＜/g, '<')
        .replace(/＞/g, '>')
        .replace(/／/g, '/')
        .replace(/：/g, ':')
        .replace(/，/g, ',')
        .replace(/；/g, ';');
}

function splitAliasList(value) {
    const raw = Array.isArray(value) ? value : String(value ?? '').split(/[|,，、;；\n]+/);
    const out = [];
    for (const item of raw) {
        const name = String(item ?? '').trim();
        if (name && !out.includes(name)) out.push(name);
    }
    return out;
}

/** "tag, tag（中文）, tag" → [{en, zh}]；没写中文的 zh 为空。全角逗号/分号也认。 */
export function pairsFromTags(text) {
    return String(text ?? '')
        .replace(/，/g, ',')
        .replace(/；/g, ';')
        .split(/[,、;]+/)
        .map(item => item.trim())
        .filter(Boolean)
        .map(item => {
            const match = /^(.+?)[（(]([^（）()]*)[)）]$/.exec(item);
            return match ? { en: match[1].trim(), zh: match[2].trim() } : { en: item, zh: '' };
        })
        .filter(pair => pair.en);
}

export function tagsText(list) {
    return (Array.isArray(list) ? list : [])
        .map(item => String(item?.en ?? item ?? '').trim())
        .filter(Boolean)
        .join(', ');
}

function clonePairs(list) {
    return (Array.isArray(list) ? list : []).map(item => ({ en: String(item?.en ?? '').trim(), zh: String(item?.zh ?? '').trim() })).filter(item => item.en);
}

function parseBlockFields(body) {
    const fields = {};
    for (const rawLine of normalizeBlockText(body).split(/\r?\n/)) {
        const line = rawLine.trim().replace(/^[-*+]\s*/, '');
        const cut = line.indexOf(':');
        if (cut <= 0) continue;
        const key = line.slice(0, cut).trim();
        const value = line.slice(cut + 1).trim();
        if (!key || !value) continue;
        fields[key] = fields[key] === undefined ? value : `${fields[key]}, ${value}`;
    }
    return fields;
}

/** 从回复里解析出两种块，顺序与出现位置保留。 */
export function parseCharacterBlocks(text) {
    const source = normalizeBlockText(text);
    const out = [];
    const regex = /<(人物|外貌变化)>([\s\S]*?)<\/\1>/g;
    let match;
    while ((match = regex.exec(source)) !== null) {
        out.push({
            type: match[1] === '人物' ? 'person' : 'change',
            fields: parseBlockFields(match[2]),
            raw: match[0],
            index: match.index,
        });
    }
    return out;
}

function nowOf(value) {
    return Number.isFinite(value) ? value : Date.now();
}

/**
 * 把回复文本转成 ops。
 * options.locked  只在全局库里的名字（AI 只读）
 * options.known   已经建过档的本聊天角色名（第 0..N-1 楼的状态）
 * options.at      时间戳（测试可固定）
 * 返回 { ops, logs }：logs 是需要写调试日志的忽略原因。
 */
export function buildCharOps(text, { locked = new Set(), known = new Set(), at = Date.now() } = {}) {
    const ops = [];
    const logs = [];
    const createdHere = new Set();
    const stamp = nowOf(at);
    for (const block of parseCharacterBlocks(text)) {
        const f = block.fields;
        const name = String(f['名字'] ?? '').trim();
        if (!name) {
            logs.push('有块没写「名字」，忽略');
            continue;
        }
        if (locked.has(name)) {
            logs.push(`${name} 在全局库里（固定），忽略 <${block.type === 'person' ? '人物' : '外貌变化'}>`);
            continue;
        }
        if (block.type === 'person') {
            if (known.has(name) || createdHere.has(name)) {
                logs.push(`${name} 已建档，忽略 <人物>`);
                continue;
            }
            createdHere.add(name);
            const outfit = pairsFromTags(f['衣服']);
            ops.push({
                kind: 'new',
                name,
                aliases: splitAliasList(f['别名']),
                appearance: pairsFromTags(f['外貌']),
                nl: String(f['描述'] ?? '').trim(),
                outfitMode: outfit.length ? 'fixed' : 'story',
                outfit,
                reason: String(f['原因'] ?? '').trim() || '首次出场',
                pos: block.index,
                at: stamp,
            });
            continue;
        }
        if (!known.has(name) && !createdHere.has(name)) {
            logs.push(`${name} 没有档案，忽略 <外貌变化>`);
            continue;
        }
        const add = pairsFromTags(f['加']);
        const remove = pairsFromTags(f['去']);
        const full = pairsFromTags(f['外貌']);
        const nl = f['描述'] === undefined ? undefined : String(f['描述']).trim();
        let outfit;
        if (f['衣服'] !== undefined) {
            outfit = /^(跟剧情|剧情|story)$/i.test(String(f['衣服']).trim()) ? 'story' : pairsFromTags(f['衣服']);
        }
        if (!add.length && !remove.length && !full.length && outfit === undefined && nl === undefined) {
            logs.push(`${name} 的变化块没有内容，忽略`);
            continue;
        }
        ops.push({
            kind: 'set',
            name,
            add,
            remove,
            appearance: full.length ? full : undefined,
            nl,
            outfit,
            reason: String(f['原因'] ?? '').trim(),
            pos: block.index,
            at: stamp,
        });
    }
    return { ops, logs };
}

/** 设置开关关掉时，不解析也不写 ops。 */
export function buildCharOpsIfEnabled(text, options = {}) {
    if (options.enabled === false) return { ops: [], logs: [] };
    return buildCharOps(text, options);
}

function outfitIdFor(floor, name) {
    return `o_${floor}_${String(name).replace(/[^\w\u4e00-\u9fa5]+/g, '_')}`;
}

const HISTORY_CAP = 50;

function entrySnapshot(entry) {
    const outfit = (entry.outfits || []).find(o => o.id === entry.outfitId) || (entry.outfits || [])[0] || null;
    return {
        appearance: tagsText(entry.appearance),
        outfitMode: entry.outfitMode === 'fixed' ? 'fixed' : 'story',
        outfit: tagsText(outfit?.tags),
        nl: String(entry.nl ?? '').trim(),
    };
}

function outfitText(snapshot) {
    return snapshot.outfitMode === 'fixed' ? `固定：${snapshot.outfit || ''}` : '跟剧情';
}

function pushHistory(entry, record) {
    entry.history.push(record);
    if (entry.history.length > HISTORY_CAP) entry.history.splice(0, entry.history.length - HISTORY_CAP);
}

/** 一条 op 引起的字段级历史（new / appearance / outfit / nl）。 */
function historyRecordsForOp(floor, op, before, after) {
    const at = nowOf(op.at);
    const reason = String(op.reason || '');
    if (!before) return [{ field: 'new', from: '', to: after.appearance || '', reason, floor, at }];
    const out = [];
    if (before.appearance !== after.appearance) out.push({ field: 'appearance', from: before.appearance, to: after.appearance, reason, floor, at });
    if (before.outfit !== after.outfit || before.outfitMode !== after.outfitMode) out.push({ field: 'outfit', from: outfitText(before), to: outfitText(after), reason, floor, at });
    if (before.nl !== after.nl) out.push({ field: 'nl', from: before.nl, to: after.nl, reason, floor, at });
    return out;
}

function cloneEntry(entry) {
    return {
        ...entry,
        aliases: Array.isArray(entry.aliases) ? [...entry.aliases] : [],
        nl: String(entry.nl ?? ''),
        appearance: clonePairs(entry.appearance),
        outfits: (Array.isArray(entry.outfits) ? entry.outfits : []).map(o => ({ id: o.id, name: o.name || '', tags: clonePairs(o.tags) })),
        history: Array.isArray(entry.history) ? entry.history.slice(-HISTORY_CAP).map(h => ({ ...h })) : [],
    };
}

/** 把 ops 应用到一份档案数组，返回新数组（不修改入参）。pos 给定时，只应用位置在它之前的 <外貌变化>。 */
export function applyCharOps(entries, ops, floor, { locked, pos } = {}) {
    let out = (Array.isArray(entries) ? entries : []).map(cloneEntry);
    for (const op of Array.isArray(ops) ? ops : []) {
        if (!op || !op.name) continue;
        if (locked && locked.has(op.name)) continue;
        if (op.kind === 'set' && Number.isFinite(op.pos) && pos !== undefined && pos !== null && !(pos > op.pos)) continue;
        if (op.kind === 'new') {
            if (out.some(entry => entry.name === op.name)) continue;
            const outfitTags = clonePairs(op.outfit);
            const id = outfitIdFor(floor, op.name);
            const entry = {
                name: op.name,
                aliases: splitAliasList(op.aliases),
                appearance: clonePairs(op.appearance),
                nl: String(op.nl ?? '').trim(),
                outfitMode: op.outfitMode === 'fixed' && outfitTags.length ? 'fixed' : 'story',
                outfitModeExplicit: op.outfitMode === 'fixed' && !!outfitTags.length,
                outfits: outfitTags.length ? [{ id, name: '固定着装', tags: outfitTags }] : [],
                outfitId: outfitTags.length ? id : '',
                source: 'ai',
                history: [],
            };
            for (const record of historyRecordsForOp(floor, op, null, entrySnapshot(entry))) pushHistory(entry, record);
            out.push(entry);
            continue;
        }
        const entry = out.find(item => item.name === op.name);
        if (!entry) continue;
        const before = entrySnapshot(entry);
        if (Array.isArray(op.appearance) && op.appearance.length) entry.appearance = clonePairs(op.appearance);
        if (Array.isArray(op.remove) && op.remove.length) {
            const drop = new Set(op.remove.map(tag => String(tag.en || '').trim().toLowerCase()).filter(Boolean));
            entry.appearance = entry.appearance.filter(tag => !drop.has(tag.en.toLowerCase()));
        }
        if (Array.isArray(op.add) && op.add.length) {
            for (const tag of op.add) {
                const key = String(tag.en || '').trim().toLowerCase();
                if (key && !entry.appearance.some(item => item.en.toLowerCase() === key)) entry.appearance.push({ ...tag });
            }
        }
        if (op.nl !== undefined) entry.nl = String(op.nl).trim();
        if (op.outfit !== undefined) {
            if (op.outfit === 'story') {
                entry.outfitMode = 'story';
            } else {
                const id = outfitIdFor(floor, entry.name);
                entry.outfits = [{ id, name: '固定着装', tags: clonePairs(op.outfit) }];
                entry.outfitId = id;
                entry.outfitMode = 'fixed';
            }
            entry.outfitModeExplicit = true;
        }
        entry.source = 'ai';
        for (const record of historyRecordsForOp(floor, op, before, entrySnapshot(entry))) pushHistory(entry, record);
    }
    return out;
}

export function messageOps(message) {
    const raw = message?.extra?.[CHAR_OPS_KEY];
    if (!raw || raw.v !== 1 || !Array.isArray(raw.ops)) return null;
    return { v: 1, swipe: Number.isInteger(raw.swipe) ? raw.swipe : 0, ops: raw.ops };
}

export function messageOpsPayload(ops, swipe) {
    const list = Array.isArray(ops) ? ops : [];
    return list.length ? { v: 1, swipe: Number.isInteger(swipe) ? swipe : 0, ops: list } : undefined;
}

/** 忽略 at 的比较，避免每次渲染都重写消息。 */
export function sameCharOps(a, b) {
    const strip = list => JSON.stringify((Array.isArray(list) ? list : []).map(op => {
        const { at, ...rest } = op || {};
        return rest;
    }));
    return strip(a) === strip(b);
}

function activeSwipe(message) {
    return Number.isInteger(message?.swipe_id) ? message.swipe_id : 0;
}

/**
 * 按楼层重放：stateAt(floor) = 基线 + 第 0..floor 楼（含）里 swipe 匹配的 ops。
 * 返回的对象里 stateAt 返回的是内部数组，调用方只读，不要原地改。
 */
export function deriveTimeline(baseEntries, chat, { locked } = {}) {
    const base = (Array.isArray(baseEntries) ? baseEntries : []).map(cloneEntry);
    const states = [];
    const partial = new Map();
    let current = base;
    for (let floor = 0; floor < (Array.isArray(chat) ? chat.length : 0); floor += 1) {
        const message = chat[floor];
        const delta = messageOps(message);
        if (!delta || delta.swipe !== activeSwipe(message)) {
            states.push(current);
            continue;
        }
        current = applyCharOps(current, delta.ops, floor, { locked });
        states.push(current);
    }
    return {
        base: base.map(cloneEntry),
        /** pos 给定时 = 该楼里「开始位置在 pos 之前」的状态（只应用 pos 之前的 <外貌变化>）。 */
        stateAt(floor, pos) {
            const n = Number(floor);
            if (!Number.isFinite(n) || n < 0) return base.map(cloneEntry);
            const previous = n === 0 ? base : (states[n - 1] || base);
            const delta = chat[n] ? messageOps(chat[n]) : null;
            const whole = states[n] || (states.length ? states[states.length - 1] : base);
            if (!delta || delta.swipe !== activeSwipe(chat[n]) || pos === undefined || pos === null) return whole;
            const key = `${n}:${pos}`;
            if (partial.has(key)) return partial.get(key);
            const filtered = delta.ops.filter(op => op.kind === 'new' || !Number.isFinite(op.pos) || pos > op.pos);
            const out = applyCharOps(previous, filtered, n, { locked });
            partial.set(key, out);
            return out;
        },
        latest() {
            return states.length ? states[states.length - 1] : base.map(cloneEntry);
        },
    };
}

/** 把某名字在历史楼层里的 ops 清掉（手动改档后不让重放覆盖）。返回改动处数。 */
export function stripOpsForName(chat, name) {
    const target = String(name ?? '').trim();
    if (!target) return 0;
    let changed = 0;
    for (const message of Array.isArray(chat) ? chat : []) {
        const holders = [message, ...(Array.isArray(message?.swipe_info) ? message.swipe_info : [])];
        for (const holder of holders) {
            const raw = holder?.extra?.[CHAR_OPS_KEY];
            if (!raw || !Array.isArray(raw.ops)) continue;
            const next = raw.ops.filter(op => op?.name !== target);
            if (next.length === raw.ops.length) continue;
            if (next.length) holder.extra[CHAR_OPS_KEY] = { v: 1, swipe: Number.isInteger(raw.swipe) ? raw.swipe : 0, ops: next };
            else delete holder.extra[CHAR_OPS_KEY];
            changed += 1;
        }
    }
    return changed;
}

/** 全局库里、且本聊天基线没有同名的角色 = 锁定（AI 只读）。 */
export function lockedCharNames(characters, baseEntries) {
    const base = new Set((Array.isArray(baseEntries) ? baseEntries : []).map(entry => entry.name));
    const locked = new Set();
    for (const character of Object.values(characters || {})) {
        const name = String(character?.name ?? '').trim();
        if (name && !base.has(name)) locked.add(name);
    }
    return locked;
}

function normalizeOutfits(list) {
    return (Array.isArray(list) ? list : []).map(outfit => ({
        id: String(outfit?.id ?? ''),
        name: String(outfit?.name ?? ''),
        tags: clonePairs(outfit?.tags),
    })).filter(outfit => outfit.id);
}

function normalizeHistory(raw) {
    if (!Array.isArray(raw)) return [];
    const out = [];
    for (const item of raw.slice(-HISTORY_CAP)) {
        if (!item || typeof item !== 'object') continue;
        if (item.before || item.after) {
            // 旧格式：{ floor, reason, at, before:{appearance,outfit,...}, after:{...} }
            const before = item.before?.appearance || '';
            const after = item.after?.appearance || '';
            out.push({ field: item.before ? 'appearance' : 'new', from: before, to: after, reason: String(item.reason || ''), floor: Number.isInteger(item.floor) ? item.floor : -1, at: Number.isFinite(item.at) ? item.at : 0 });
            continue;
        }
        out.push({
            field: String(item.field || 'appearance'),
            from: String(item.from ?? ''),
            to: String(item.to ?? ''),
            reason: String(item.reason || ''),
            floor: Number.isInteger(item.floor) ? item.floor : -1,
            at: Number.isFinite(item.at) ? item.at : 0,
        });
    }
    return out.slice(-HISTORY_CAP);
}

export function normalizeChatEntry(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const name = String(raw.name ?? '').trim();
    if (!name) return null;
    const outfits = normalizeOutfits(raw.outfits);
    const outfitId = outfits.some(o => o.id === raw.outfitId) ? raw.outfitId : (outfits[0]?.id || '');
    const outfitMode = raw.outfitMode === 'fixed' && outfits.length ? 'fixed' : 'story';
    return {
        name,
        aliases: splitAliasList(raw.aliases).filter(alias => alias !== name),
        appearance: clonePairs(raw.appearance),
        nl: typeof raw.nl === 'string' ? raw.nl.trim() : '',
        outfitMode,
        outfitModeExplicit: raw.outfitModeExplicit === true || outfitMode === 'fixed',
        outfits,
        outfitId,
        source: raw.source === 'ai' ? 'ai' : 'manual',
        history: normalizeHistory(raw.history),
    };
}

export function normalizeChatStore(raw) {
    const entries = Array.isArray(raw?.entries) ? raw.entries : [];
    const out = [];
    for (const item of entries) {
        const entry = normalizeChatEntry(item);
        if (entry && !out.some(e => e.name === entry.name)) out.push(entry);
    }
    return out;
}

export function chatStorePayload(entries) {
    return { v: 1, entries: (Array.isArray(entries) ? entries : []).map(cloneEntry) };
}

/** 从全局角色复制一份聊天库条目（「复制到本聊天」）。 */
export function entryFromGlobal(character) {
    return normalizeChatEntry({
        name: character?.name,
        aliases: character?.aliases,
        appearance: character?.appearance,
        nl: character?.nl,
        outfitMode: character?.outfitMode,
        outfits: character?.outfits,
        outfitId: character?.outfitId,
        source: 'manual',
        history: [],
    });
}

/** 聊天库条目 → 全局角色（「提升为全局」）。 */
export function globalFromChatEntry(entry) {
    const normalized = normalizeChatEntry(entry);
    if (!normalized) return null;
    return {
        name: normalized.name,
        aliases: normalized.aliases,
        appearance: normalized.appearance,
        nl: normalized.nl,
        outfitMode: normalized.outfitMode,
        outfits: normalized.outfits,
        outfitId: normalized.outfitId,
        negative: '',
        charRef: '',
    };
}

/**
 * 本聊天条目 + 同名全局角色 → 字段级合并结果。
 * appearance / nl 空时用全局；outfit 在「没有衣服且没有显式 outfitMode」时用全局；
 * aliases 取并集；charRef 用本聊天的，没有再用全局的。
 * 返回 { entry, sources }：sources 标出每个字段来自 'chat' 还是 'global'。
 */
export function mergeCharacterLayers(chatEntry, globalChar) {
    const chat = normalizeChatEntry(chatEntry);
    if (!chat) return null;
    if (!globalChar) return { entry: chat, sources: { appearance: 'chat', nl: chat.nl ? 'chat' : 'chat', outfit: 'chat', aliases: 'chat' } };
    const globalName = String(globalChar.name ?? '').trim();
    const global = {
        name: globalName,
        aliases: splitAliasList(globalChar.aliases).filter(alias => alias && alias !== globalName),
        appearance: clonePairs(globalChar.appearance),
        nl: typeof globalChar.nl === 'string' ? globalChar.nl.trim() : '',
        outfitMode: globalChar.outfitMode === 'fixed' ? 'fixed' : 'story',
        outfits: normalizeOutfits(globalChar.outfits),
        outfitId: String(globalChar.outfitId ?? ''),
        charRef: String(globalChar.charRef ?? ''),
    };
    const useChatAppearance = chat.appearance.length > 0;
    const useChatNl = !!chat.nl;
    const useChatOutfit = chat.outfitModeExplicit === true || chat.outfits.length > 0 || chat.outfitMode === 'fixed';
    const aliases = [];
    for (const alias of [...chat.aliases, ...global.aliases]) if (!aliases.includes(alias)) aliases.push(alias);
    const entry = {
        ...chat,
        aliases,
        appearance: useChatAppearance ? chat.appearance : global.appearance,
        nl: useChatNl ? chat.nl : global.nl,
        outfitMode: useChatOutfit ? chat.outfitMode : global.outfitMode,
        outfits: useChatOutfit ? chat.outfits : global.outfits,
        outfitId: useChatOutfit ? chat.outfitId : (global.outfitId || global.outfits[0]?.id || ''),
        charRef: chat.charRef || global.charRef,
    };
    return {
        entry,
        sources: {
            appearance: useChatAppearance ? 'chat' : 'global',
            nl: useChatNl ? 'chat' : 'global',
            outfit: useChatOutfit ? 'chat' : 'global',
            aliases: 'union',
        },
    };
}

/**
 * 把一组本聊天条目逐个与「同名」全局角色做字段级合并，给 $名字$ 展开和 JSON 标记用：
 * 本聊天条目外貌/描述/服装为空时回落到全局，别名取并集。没有同名全局角色的条目原样保留。
 */
export function mergeChatEntriesWithGlobals(chatEntries, globals) {
    const byName = new Map();
    for (const character of Array.isArray(globals) ? globals : []) {
        const name = String(character?.name ?? '').trim();
        if (name && !byName.has(name)) byName.set(name, character);
    }
    return (Array.isArray(chatEntries) ? chatEntries : []).map(entry => {
        const merged = mergeCharacterLayers(entry, byName.get(String(entry?.name ?? '').trim()));
        return merged ? merged.entry : entry;
    });
}

/** 历史记录追加并封顶（各 50 条，最旧的丢掉）。 */
export function capHistory(records) {
    return (Array.isArray(records) ? records : []).slice(-HISTORY_CAP);
}

/** 把某名字在各楼层的 ops 收成字段级历史记录（不修改消息）。 */
export function historyFromOps(timeline, name, chat) {
    const target = String(name ?? '').trim();
    if (!target || !timeline) return [];
    const floors = new Map();
    (Array.isArray(chat) ? chat : []).forEach((message, floor) => {
        const delta = messageOps(message);
        if (!delta || delta.swipe !== activeSwipe(message)) return;
        const ops = delta.ops.filter(op => op?.name === target);
        if (ops.length) floors.set(floor, ops);
    });
    const records = [];
    let running = null;
    for (const floor of [...floors.keys()].sort((a, b) => a - b)) {
        for (const op of floors.get(floor)) {
            const before = running ? entrySnapshot(running) : null;
            const next = applyCharOps(running ? [running] : [], [op], floor)[0] || null;
            if (!next) continue;
            records.push(...historyRecordsForOp(floor, op, before, entrySnapshot(next)));
            running = next;
        }
    }
    return capHistory(records);
}

/** 手动编辑/回滚/删除写进基础档案的历史记录。 */
export function manualHistoryRecord(entry, reason = '手动', at = Date.now()) {
    return {
        field: 'manual',
        from: '',
        to: tagsText(entry?.appearance),
        reason,
        floor: -1,
        at: Number.isFinite(at) ? at : Date.now(),
    };
}

/** 缓存键：聊天长度 + 基线 + 每楼 ops，编辑/滑动/删楼/改基线都会变。 */
export function charCacheKey(chat, baseEntries) {
    const parts = ['v1'];
    for (const entry of Array.isArray(baseEntries) ? baseEntries : []) {
        parts.push(`b|${entry.name}|${tagsText(entry.appearance)}|${entry.nl || ''}|${entry.outfitMode}|${entry.outfitModeExplicit ? 1 : 0}|${entry.outfitId}|${(entry.aliases || []).join('|')}`);
    }
    const list = Array.isArray(chat) ? chat : [];
    for (let i = 0; i < list.length; i += 1) {
        const delta = messageOps(list[i]);
        if (delta) parts.push(`o|${i}|${delta.swipe}|${JSON.stringify(delta.ops)}`);
    }
    return parts.join(';');
}

/**
 * 世界书宏内容：本聊天角色 + 出场角色（全局），按名字去重。
 * 本聊天条目与同名全局角色做字段级合并（别名并集、固定服装取合并结果），
 * 只给名字/别名与后缀标记（固定服装 / 全局锁定），不写「写 $名字$」——用法由世界书解释。
 */
export function chatMacroText(chatEntries, cast, { locked, globals } = {}) {
    const globalByName = new Map();
    for (const character of Array.isArray(globals) ? globals : []) {
        const name = String(character?.name ?? '').trim();
        if (name && !globalByName.has(name)) globalByName.set(name, character);
    }
    const rows = [];
    const seen = new Set();
    const push = (name, aliases, fixedOutfit, lockedRow) => {
        const clean = String(name ?? '').trim();
        if (!clean || seen.has(clean)) return;
        seen.add(clean);
        const extra = (aliases || []).filter(alias => alias && alias !== clean);
        rows.push(`- ${clean}${extra.length ? `（别名：${extra.join('、')}）` : ''}${fixedOutfit ? '[固定服装]' : ''}${lockedRow ? '[固定，不可改]' : ''}`);
    };
    for (const entry of Array.isArray(chatEntries) ? chatEntries : []) {
        const merged = mergeCharacterLayers(entry, globalByName.get(entry.name));
        const value = merged?.entry || entry;
        push(value.name, value.aliases, value.outfitMode === 'fixed', false);
    }
    for (const item of Array.isArray(cast) ? cast : []) {
        if (!item || !item.on || !item.char) continue;
        push(item.char.name, item.char.aliases, item.char.outfitMode === 'fixed', locked ? locked.has(item.char.name) : false);
    }
    return rows.join('\n');
}
