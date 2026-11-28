// 角色库 & 衣柜深化纯逻辑函数（同人角色外貌合成、角色生图景别过滤、正文 40 楼提取、内容拦截识别与分段合并）

const GENDER_TOKEN_RE = /^(?:1girl|1boy|girl|boy|male focus|female focus|solo|adult|mature female|mature male)$/i;
const PORTRAIT_CUT_RE = /\b(?:full body|standing|sitting|kneeling|lying|on back|on stomach|walking|running|legs|thighs|feet|barefoot|shoes?|boots?|sneakers?|sandals?|heels?|socks?|thighhighs?|stockings?|pantyhose|skirt|pants|shorts|jeans|trousers|underwear|panties)\b/i;
const UPPER_CUT_RE = /\b(?:full body|feet|barefoot|shoes?|boots?|sneakers?|sandals?|heels?|socks?|thighhighs?|stockings?|pantyhose|anklets?|legwear)\b/i;
const BLOCKED_ERR_RE = /PROHIBITED_CONTENT|SAFETY|HARM_CATEGORY|content[_\s-]?filter|policy[_\s-]?violation|blocked|refus|unsafe|inappropriate|敏感|违规|内容限制|审核拦截/i;

/**
 * 同人角色外貌合成：
 * - canonOn 为真且填了 canonTag 时：
 *   - 未勾 canonKeepLook：只发性别词 + canonTag（让 NAI 照原作画）
 *   - 勾选 canonKeepLook：canonTag + 固定外貌去重合并（冷门同人更稳）
 * - 否则原样返回 appearanceText
 */
export function canonLookTags(character, appearanceText) {
    const app = String(appearanceText ?? '').trim();
    const canonTag = String(character?.canonTag ?? '').trim();
    if (!character?.canonOn || !canonTag) return app;
    const split = s => String(s || '').split(',').map(x => x.trim()).filter(Boolean);
    const appTokens = split(app);
    const genderTokens = appTokens.filter(t => GENDER_TOKEN_RE.test(t));
    const canonTokens = split(canonTag);
    const combined = character.canonKeepLook
        ? [...genderTokens, ...canonTokens, ...appTokens]
        : [...genderTokens, ...canonTokens];
    const seen = new Set();
    const out = [];
    for (const tok of combined) {
        const k = tok.toLowerCase().replace(/\s+/g, ' ');
        if (!k || seen.has(k)) continue;
        seen.add(k);
        out.push(tok);
    }
    return out.join(', ');
}

/** 角色生图：按头像 / 半身 / 全身过滤冲突词并返回推荐尺寸与景别标签 */
export function charTestFraming(shot = 'upper') {
    const mode = ['portrait', 'upper', 'full'].includes(shot) ? shot : 'upper';
    if (mode === 'portrait') return { mode, width: 832, height: 832, shotTags: 'portrait, close-up, head shot, looking at viewer', cutRe: PORTRAIT_CUT_RE };
    if (mode === 'full') return { mode, width: 768, height: 1344, shotTags: 'full body, standing, looking at viewer', cutRe: null };
    return { mode: 'upper', width: 832, height: 1024, shotTags: 'upper body, cowboy shot, looking at viewer', cutRe: UPPER_CUT_RE };
}

export function filterCharTestTags(tagString, shot = 'upper') {
    const { cutRe } = charTestFraming(shot);
    const tokens = String(tagString || '').split(',').map(x => x.trim()).filter(Boolean);
    if (!cutRe) return tokens.join(', ');
    return tokens.filter(t => /^artist\s*:/i.test(t) || !cutRe.test(t)).join(', ');
}

/** 从最近 N 楼聊天记录提取干净正文，供「从聊天正文读出人物」使用 */
export function buildChatCastExcerpt(chatMessages, limit = 40, maxChars = 48000) {
    const list = (Array.isArray(chatMessages) ? chatMessages : [])
        .filter(m => m && !m.is_system && String(m.mes || '').trim())
        .slice(-limit);
    const cleaned = list.map((m, idx) => {
        let text = String(m.mes || '');
        text = text.replace(/<\s*(think[\w-]*|thoughts?|reasoning|plann?ing|plans?|思考|推理)(?:\s[^>]*)?>[\s\S]*?(?:<\/\s*\1\s*>|$)/gi, '');
        text = text.replace(/```[\s\S]*?```/g, '');
        text = text.replace(/image###[\s\S]*?###/g, '');
        text = text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        if (!text) return '';
        return `【${m.name || (m.is_user ? 'User' : 'Char')} · #${idx + 1}】\n${text}`;
    }).filter(Boolean);
    const joined = cleaned.join('\n\n');
    return joined.length > maxChars ? joined.slice(-maxChars) : joined;
}

export function isContentBlockError(err) {
    const msg = String(err?.providerMessage || err?.message || err || '');
    return BLOCKED_ERR_RE.test(msg);
}

/** 分段读取人物结果按名字/别名去重合并 */
export function mergeExtractedPeople(peopleList) {
    const merged = [];
    const pairKey = x => (typeof x === 'string' ? x : x?.en || '').trim().toLowerCase();
    for (const p of Array.isArray(peopleList) ? peopleList : []) {
        if (!p || typeof p !== 'object') continue;
        const name = String(p.name || '').trim();
        if (!name) continue;
        const aliases = (Array.isArray(p.aliases) ? p.aliases : []).map(x => String(x || '').trim()).filter(Boolean);
        const hit = merged.find(m => m.name === name || m.aliases.includes(name) || aliases.includes(m.name));
        if (!hit) {
            merged.push({
                name,
                aliases: [...new Set(aliases.filter(a => a !== name))],
                appearance: Array.isArray(p.appearance) ? [...p.appearance] : [],
                outfit: Array.isArray(p.outfit) ? [...p.outfit] : [],
                nsfw: Array.isArray(p.nsfw) ? [...p.nsfw] : [],
                canon: String(p.canon || '').trim(),
            });
            continue;
        }
        for (const a of [name, ...aliases]) {
            if (a && a !== hit.name && !hit.aliases.includes(a)) hit.aliases.push(a);
        }
        for (const k of ['appearance', 'outfit', 'nsfw']) {
            const seen = new Set(hit[k].map(pairKey));
            for (const x of Array.isArray(p[k]) ? p[k] : []) {
                const pk = pairKey(x);
                if (pk && !seen.has(pk)) { hit[k].push(x); seen.add(pk); }
            }
        }
        if (!hit.canon && p.canon) hit.canon = String(p.canon).trim();
    }
    return merged;
}
