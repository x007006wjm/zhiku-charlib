// JSON 生图标记：image###{tag,nl,characters[],size}### 的解析与组装。
// 纯函数，不碰 DOM、不发请求；构建时由 tools/apply-char-lib.mjs 去掉 export 后内联进 runtime.js。
// 与 ST-BaiBai-Image 的协议相同，但实现是独立写的（不复制其代码）。
// 说明：JSON 解析失败或不是对象时返回 null，调用方继续走原来的纯文本标记路径。

const PUNCT_MAP = { '：': ':', '，': ',', '；': ';', '｛': '{', '｝': '}', '［': '[', '］': ']', '　': ' ' };
const SMART_QUOTE_RE = /[“”＂]/;

/** 剥离可选的 Markdown 代码围栏（如 ```json ... ```）。 */
function stripCodeFence(input) {
    const raw = String(input ?? '').trim();
    const m = /^```(?:json|JSON)?\s*\r?\n?([\s\S]*?)\r?\n?```$/.exec(raw);
    return m ? m[1].trim() : raw;
}

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

/** 轻量 JSON 修复：处理字符串外的全角引号与对象/数组末尾多余逗号。 */
export function repairJsonText(input) {
    const source = normalizeJsonText(stripCodeFence(input));
    let quoted = '';
    let closeQuote = '';
    let escaped = false;
    for (const ch of source) {
        if (closeQuote) {
            if (escaped) {
                quoted += ch;
                escaped = false;
            } else if (ch === '\\') {
                quoted += ch;
                escaped = true;
            } else if (ch === closeQuote || (closeQuote === '”' && ch === '"')) {
                quoted += '"';
                closeQuote = '';
            } else {
                quoted += ch;
            }
            continue;
        }
        if (ch === '"' || SMART_QUOTE_RE.test(ch)) {
            closeQuote = ch === '“' ? '”' : ch;
            quoted += '"';
            continue;
        }
        quoted += ch;
    }
    // 去除字符串外的尾逗号（如 ,} 或 ,]）
    let out = '';
    let inString = false;
    escaped = false;
    for (let i = 0; i < quoted.length; i += 1) {
        const ch = quoted[i];
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
        if (ch === ',') {
            let j = i + 1;
            while (j < quoted.length && /\s/.test(quoted[j])) j += 1;
            if (quoted[j] === '}' || quoted[j] === ']') continue;
        }
        out += ch;
    }
    return out.trim();
}

function textOf(value) {
    return typeof value === 'string' ? value.trim() : '';
}

const CENTER_PRESETS = {
    left: { x: 0.25, y: 0.5 },
    right: { x: 0.75, y: 0.5 },
    center: { x: 0.5, y: 0.5 },
    middle: { x: 0.5, y: 0.5 },
    'top-left': { x: 0.25, y: 0.25 },
    top: { x: 0.5, y: 0.25 },
    'top-right': { x: 0.75, y: 0.25 },
    'bottom-left': { x: 0.25, y: 0.75 },
    bottom: { x: 0.5, y: 0.75 },
    'bottom-right': { x: 0.75, y: 0.75 },
    '左': { x: 0.25, y: 0.5 },
    '右': { x: 0.75, y: 0.5 },
    '中': { x: 0.5, y: 0.5 },
};

/** 解析可选的角色站位坐标（pos / center）：预设名、{x,y} 或 [x,y]，无效返回 null。 */
export function parseCharacterCenter(raw) {
    if (raw == null) return null;
    if (typeof raw === 'string') {
        const key = raw.trim().toLowerCase().replace(/[\s_]+/g, '-');
        const hit = CENTER_PRESETS[key];
        return hit ? { ...hit } : null;
    }
    let x, y;
    if (Array.isArray(raw) && raw.length >= 2) {
        x = Number(raw[0]);
        y = Number(raw[1]);
    } else if (typeof raw === 'object') {
        x = Number(raw.x);
        y = Number(raw.y);
    } else {
        return null;
    }
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) return null;
    return { x, y };
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
            const entry = { name, tag: charTag, nl: charNl };
            const uc = textOf(item.uc ?? item.negative);
            if (uc) entry.uc = uc;
            const center = parseCharacterCenter(item.center ?? item.pos);
            if (center) entry.center = center;
            characters.push(entry);
        }
    }
    if (!tag && !nl && !characters.length) return null;
    return { tag, nl, characters, size };
}

/** 是不是结构化标记；不是就返回 null（调用方走纯文本）。 */
export function parseMarkerJson(text) {
    const raw = stripCodeFence(text);
    if (!raw) return null;
    const normalized = normalizeJsonText(raw).trim();
    if (!normalized.startsWith('{') && !raw.startsWith('{')) return null;
    let data;
    try {
        data = JSON.parse(raw);
    } catch {
        try {
            data = JSON.parse(normalized);
        } catch {
            try {
                data = JSON.parse(repairJsonText(raw));
            } catch {
                return null;
            }
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

const CLOSE_FRAMING_RE = /^(?:close-up|upper body|portrait|face)$/i;
const WIDE_FRAMING_RE = /^(?:full body|wide shot|medium shot|cowboy shot|lower body)$/i;
const LOWER_OUTFIT_RE = /\b(?:shoes?|boots?|sneakers?|sandals?|heels?|high heels?|loafers?|slippers?|barefoot|footwear|socks?|knee highs?|thighhighs?|stockings?|pantyhose|tights|leggings|garter(?: straps?)?|skirts?|miniskirts?|pants|jeans|shorts|trousers|panties|underwear|anklets?|legwear)\b/i;
const NSFW_PROMPT_RE = /(?:^|[\s,;|(])(?:nsfw|explicit|r18|r-18|rating:explicit|nude|completely nude|naked|topless|bottomless|nipples|pussy|penis|uncensored|sex|vaginal|anal|fellatio|paizuri|cum|creampie|pubic hair|areolae|genitals)(?=$|[\s,;|)])/i;
const NUDE_PROMPT_RE = /(?:^|[\s,;|(])(?:nude|completely nude|naked|topless|bottomless|no clothes|undressed|unclothed)(?=$|[\s,;|)])/i;

/** 判断提示词或描述是否属于 NSFW 画面（独立词匹配，不误伤 sfw）。 */
export function isNsfwPrompt(text) {
    return NSFW_PROMPT_RE.test(String(text ?? ''));
}

/** 判断提示词或描述是否要求裸体 / 无衣（用于跳过角色库固定衣服）。 */
export function isNudePrompt(text) {
    return NUDE_PROMPT_RE.test(String(text ?? ''));
}

/** 景别是否为特写 / 半身（不含全身/中景/远景）：用于过滤框外下半身/鞋袜固定服装。 */
export function isCloseFraming(baseTag) {
    const tokens = splitTagList(baseTag);
    if (!tokens.length) return false;
    if (tokens.some(t => WIDE_FRAMING_RE.test(t))) return false;
    return tokens.some(t => CLOSE_FRAMING_RE.test(t));
}

/** 景别冲突例外：特写/半身时从库里的固定服装中移除鞋、袜、裤袜、裙、裤等框外部位。 */
export function filterOutfitForFraming(outfitTags, baseTag) {
    if (!outfitTags || !isCloseFraming(baseTag)) return String(outfitTags ?? '').trim();
    return splitTagList(outfitTags)
        .filter(token => !LOWER_OUTFIT_RE.test(token))
        .join(', ');
}

function mergeUniqueTags(...parts) {
    const seen = new Set();
    const out = [];
    for (const part of parts) {
        for (const token of splitTagList(part)) {
            const key = tagKey(token);
            if (!key || seen.has(key)) continue;
            seen.add(key);
            out.push(token);
        }
    }
    return out.join(', ');
}

/**
 * 组装一条结构化标记：base + 每个角色（可查询库）的最终 caption、uc、center。
 * options.lookup(name) → { tags, appearanceTags?, outfitTags?, nl, uc?, charRef } | null
 * options.expand(text) → 展开 $名字$
 */
export function buildMarkerPlan(payload, { lookup = () => null, expand = value => value } = {}) {
    const base = expand(buildMarkerBase(payload));
    const baseTag = textOf(payload?.tag);
    const characters = [];
    const charRefs = [];
    const baseIsNsfw = isNsfwPrompt(base);
    const baseIsNude = isNudePrompt(base);
    for (const entry of payload?.characters || []) {
        const info = lookup(entry.name);
        let tag = expand(entry.tag || '');
        const charContext = [tag, expand(entry.nl || '')].filter(Boolean).join(', ');
        const charIsNsfw = baseIsNsfw || isNsfwPrompt(charContext);
        const charIsNude = baseIsNude || isNudePrompt(charContext);
        let libraryTags = '';
        if (info) {
            const nsfwBody = charIsNsfw && info.nsfwBody ? expand(info.nsfwBody) : '';
            if (info.appearanceTags !== undefined || info.outfitTags !== undefined) {
                const app = info.appearanceTags ? expand(info.appearanceTags) : '';
                const outfit = !charIsNude && info.outfitTags ? filterOutfitForFraming(expand(info.outfitTags), baseTag) : '';
                libraryTags = [app, nsfwBody, outfit].filter(Boolean).join(', ');
            } else if (info.tags) {
                libraryTags = [expand(info.tags), nsfwBody].filter(Boolean).join(', ');
            } else if (nsfwBody) {
                libraryTags = nsfwBody;
            }
        }
        if (libraryTags) tag = injectLibraryTags(tag, libraryTags);
        const caption = buildCharacterCaption(tag, info?.nl || '', expand(entry.nl || ''));
        const uc = mergeUniqueTags(info?.uc ? expand(info.uc) : '', entry.uc ? expand(entry.uc) : '');
        const charObj = { name: entry.name, tag, caption, uc, charRef: info?.charRef || '' };
        if (entry.center) charObj.center = entry.center;
        characters.push(charObj);
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
