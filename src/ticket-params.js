// 画师串 / 单个画师独立出图参数（模型、采样器、噪声计划、步数、CFG、Rescale）
// 空项沿用全局设置；用这串出图时临时套用，不改全局设置。

export const TICKET_PARAM_KEYS = ['steps', 'cfg', 'rescale', 'sampler', 'schedule'];

export function hasTicketParams(it) {
    if (!it || typeof it !== 'object') return false;
    return String(it.model ?? '').trim() !== '' || TICKET_PARAM_KEYS.some(k => String(it[k] ?? '').trim() !== '');
}

export function applyItemParams(baseSettings, it) {
    if (!hasTicketParams(it)) return baseSettings;
    const out = { ...baseSettings };
    const num = (v, lo, hi) => {
        if (String(v ?? '').trim() === '') return null;
        const n = Number(v);
        return Number.isFinite(n) && n >= lo && n <= hi ? n : null;
    };
    const model = String(it.model ?? '').trim();
    if (model && /^nai-diffusion-/.test(model)) out.novelaimode = model;
    const steps = num(it.steps, 1, 50);
    const cfg = num(it.cfg, 0, 30);
    const rescale = num(it.rescale, 0, 1);
    if (steps != null) out.novelai_steps = Math.round(steps);
    if (cfg != null) out.nai3Scale = cfg;
    if (rescale != null) out.cfg_rescale = rescale;
    if (typeof it.sampler === 'string' && /^(?:k_\w+|ddim_v3)$/.test(it.sampler)) out.novelai_sampler = it.sampler;
    if (typeof it.schedule === 'string' && /^\w+$/.test(it.schedule)) out.Schedule = it.schedule;
    return out;
}

/**
 * 根据当前发送的正面提示词，匹配命中的画师串 / 单个画师（设了独立出图参数的）：
 * - 正面里必须包含该串的全部标签；命中多串时取标签数最多的那串（画师组优先于单个画师）。
 * - 单个画师仅在它自己就是 d.active，或者正面里只有它 1 位画师时生效（避免组内单个画师覆盖整组参数）。
 */
export function findTicketParamsFor(d, positive, M) {
    if (!d || !M) return null;
    const norm = t => String(t).trim().toLowerCase().replace(/\s+/g, ' ').replace(/\s+::/g, '::');
    const tagsOf = str => String(str || '').split(/[,\n]/).map(norm).filter(Boolean);
    const pos = tagsOf(positive);
    const have = new Set(pos);
    const artistsInPos = pos.filter(t => /^(?:-?\d+(?:\.\d+)?::)?\W*artist:/.test(t)).length;
    const cands = [];
    if (d.active) {
        const t = M.resolveTicket(d, d.active);
        if (hasTicketParams(t?.item)) cands.push([d.active, t.item]);
    }
    for (const g of Object.values(d.groups || {})) {
        if (hasTicketParams(g)) cands.push([{ type: 'group', id: g.id }, g]);
    }
    for (const a of Object.values(d.artists || {})) {
        if (hasTicketParams(a)) cands.push([{ type: 'artist', id: a.id }, a]);
    }
    let best = null, bestN = 0;
    for (const [ref, it] of cands) {
        if (ref.type === 'artist' && !(d.active?.type === 'artist' && d.active.id === ref.id) && artistsInPos > 1) continue;
        const tags = tagsOf(M.ticketString(d, ref));
        if (tags.length > bestN && tags.every(t => have.has(t))) {
            best = it;
            bestN = tags.length;
        }
    }
    return best;
}
