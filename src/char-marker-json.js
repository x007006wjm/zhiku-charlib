// JSON 生图标记：image###{tag,nl,characters[],size}### 的解析与组装。
// 纯函数，不碰 DOM、不发请求；构建时由 tools/apply-char-lib.mjs 去掉 export 后内联进 runtime.js。
// 与 ST-BaiBai-Image 的协议相同，但实现是独立写的（不复制其代码）。
// 说明：JSON 解析失败或不是对象时返回 null，调用方继续走原来的纯文本标记路径。

const PUNCT_MAP = { '：': ':', '，': ',', '；': ';', '｛': '{', '｝': '}', '［': '[', '］': ']', '　': ' ' };

/** 只替换字符串外的全角标点，避免破坏 JSON 字符串内容。 */
export function normalizeJsonText(input) {
    const source = String(input ?? '');
    let out = '';
    let inString = false;
    let escaped = false;
    for (const ch of source) {
        if (inString) {
            out += ch;
            if (escaped) escaped = false;
            else if (ch === '\\') escaped = true;
            else if (ch === '"') inString = false;
            continue;
        }
        if (ch === '"') {
            inString = true;
            out += ch;
            continue;
        }
        out += PUNCT_MAP[ch] ?? ch;
    }
    return out;
}

function textOf(value) {
    return typeof value === 'string' ? value.trim() : '';
}

/** 把 JSON 对象整理成内部形状；没有可用内容时返回 null。 */
export function normalizeMarkerPayload(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const tag = textOf(raw.tag);
    const nl = textOf(raw.nl);
    const sizeRaw = String(raw.size ?? '').trim().toLowerCase();
    const size = sizeRaw === 'portrait' || sizeRaw === 'landscape' ? sizeRaw : '';
    const characters = [];
    if (Array.isArray(raw.characters)) {
        for (const item of raw.characters) {
            if (!item || typeof item !== 'object') continue;
            const name = textOf(item.name);
            const charTag = textOf(item.tag);
            const charNl = textOf(item.nl);
            if (!name || (!charTag && !charNl)) continue;
            characters.push({ name, tag: charTag, nl: charNl });
        }
    }
    if (!tag && !nl && !characters.length) return null;
    return { tag, nl, characters, size };
}

/** 是不是结构化标记；不是就返回 null（调用方走纯文本）。 */
export function parseMarkerJson(text) {
    const raw = String(text ?? '').trim();
    if (!raw) return null;
    const normalized = normalizeJsonText(raw).trim();
    if (!normalized.startsWith('{')) return null;
    let data;
    try {
        data = JSON.parse(raw);
    } catch (error) {
        try {
            data = JSON.parse(normalized);
        } catch (error2) {
            return null;
        }
    }
    return normalizeMarkerPayload(data);
}

export function splitTagList(text) {
    return String(text ?? '')
        .split(',')
        .map(item => item.trim())
        .filter(Boolean);
}

function tagKey(token) {
    return String(token ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function isIdentityTag(token) {
    return /\(.+\)/.test(token);
}

function isGenderTag(token) {
    return /^(girl|boy|1girl|1boy)$/i.test(String(token ?? '').trim());
}

/**
 * 把库里的固定标签插进角色 tag：保留 AI 写的开头身份 tag（含括号）与性别 tag，
 * 后面紧接库标签，再接其余 tag；大小写不敏感去重，保留先出现的。
 */
export function injectLibraryTags(aiTag, libraryTags) {
    const ai = splitTagList(aiTag);
    const lib = splitTagList(libraryTags);
    let head = 0;
    while (head < ai.length && (isIdentityTag(ai[head]) || isGenderTag(ai[head]))) head += 1;
    const merged = [...ai.slice(0, head), ...lib, ...ai.slice(head)];
    const seen = new Set();
    const out = [];
    for (const token of merged) {
        const key = tagKey(token);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        out.push(token);
    }
    return out.join(', ');
}

/** 角色 caption 里的计数 tag 降级：1girl→girl、1boy→boy，多人计数直接删掉。 */
export function convertCountTags(tag) {
    const out = [];
    const seen = new Set();
    for (const token of splitTagList(tag)) {
        const value = token.trim();
        const count = /^(\d+)\s*(girl|boy)s?$/i.exec(value);
        let next = value;
        if (count) {
            if (Number(count[1]) !== 1) continue;
            next = count[2].toLowerCase();
        } else if (/^(multiple|several|many)\s+(girls?|boys?|people|others|crowd)$/i.test(value)) {
            continue;
        }
        const key = next.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(next);
    }
    return out.join(', ');
}

/** 角色 caption：最终 tag + 库里的 nl + AI 写的 nl（空段跳过）。 */
export function buildCharacterCaption(tag, ...nls) {
    const parts = [convertCountTags(tag), ...nls.map(value => String(value ?? '').trim()).filter(Boolean)].filter(Boolean);
    return parts.join(', ');
}

export function buildMarkerBase(payload) {
    return [textOf(payload?.tag), textOf(payload?.nl)].filter(Boolean).join(', ');
}

/**
 * 组装一条结构化标记：base + 每个角色（可查询库）的最终 caption。
 * options.lookup(name) → { tags, nl, charRef } | null
 * options.expand(text) → 展开 $名字$
 */
export function buildMarkerPlan(payload, { lookup = () => null, expand = value => value } = {}) {
    const base = expand(buildMarkerBase(payload));
    const characters = [];
    const charRefs = [];
    for (const entry of payload?.characters || []) {
        const info = lookup(entry.name);
        let tag = expand(entry.tag || '');
        const libraryTags = info?.tags ? expand(info.tags) : '';
        if (libraryTags) tag = injectLibraryTags(tag, libraryTags);
        const caption = buildCharacterCaption(tag, info?.nl || '', expand(entry.nl || ''));
        characters.push({ name: entry.name, tag, caption, charRef: info?.charRef || '' });
        if (info?.charRef) charRefs.push(info.charRef);
    }
    const captions = characters.map(item => item.caption).filter(Boolean);
    return {
        base,
        characters,
        charRefs: [...new Set(charRefs)],
        size: payload?.size || '',
        recordPrompt: [base, ...captions].filter(Boolean).join('\n'),
    };
}

/** 按 size 决定是否交换宽高；不需要交换时返回 {}。 */
export function swapSizeForOrientation(size, width, height) {
    const w = Number(width);
    const h = Number(height);
    if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return {};
    if (size === 'portrait' && w > h) return { width: h, height: w };
    if (size === 'landscape' && h > w) return { width: h, height: w };
    return {};
}

/** v3 不支持分角色：把 caption 直接接回 base。 */
export function appendCaptionsToBase(base, captions) {
    return [base, ...(Array.isArray(captions) ? captions : [])].filter(Boolean).join(', ');
}
