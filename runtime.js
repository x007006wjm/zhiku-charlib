// Generated from the full script; edit build-extension.mjs and shared-upload.js.
export function createRuntime() {
let stopped = false;
const timers = new Set();
function setTimeout(fn, delay, ...args) {
    if (stopped) return null;
    const id = window.setTimeout(() => { timers.delete(id); if (!stopped) fn(...args); }, delay);
    timers.add(id); return id;
}
function clearTimeout(id) { window.clearTimeout(id); timers.delete(id); }
// 漫画模式：认出聊天回复里的 <image>@page …</image> 漫画页（「酒馆看漫画」预设的分段协议），
// 按页调用 NovelAI V5 Full 出整页漫画，存在这一楼的消息里；楼层下面按页显示，魔棒菜单「漫画」像漫画书一样翻。
// 协议与思路来自「漫画台」预设（作者允许署名后使用，见 README「来源与署名」）；代码为智库自写。

const COMIC_BLOCK = /<image\b[^>]*>([\s\S]*?)<\/image>/gi;
const PLAN_BLOCK = /<comic_plan\b[^>]*>([\s\S]*?)<\/comic_plan>/gi;

/** 给漫画默认用的负面：不含网点、分格、文字、留白这些漫画要用的东西 */
const COMIC_DEFAULT_NEGATIVE = 'lowres, artistic error, worst quality, bad quality, jpeg artifacts, very displeasing, watermark, signature, logo, bad anatomy, bad hands';

/** 负面里不能有的词（会把对白、分格、留白、网点压掉）；正面里不该有的是人数词和角色特征 */
const NEG_FORBIDDEN = [
    'text', 'chinese text', 'english text', 'japanese text', 'speech bubble', 'thought bubble', 'narration', 'sound effects',
    'comic', 'comic panel', 'panels', 'multiple views', 'multiple scenes', '4koma', '2koma', 'sequence', 'full page comic', 'cut-in',
    'border', 'white border', 'black border', 'ornate border', 'lace border', 'outside border', 'frame', 'outline', 'margins', 'negative space',
    'screentone', 'halftone', 'monochrome', 'greyscale', 'grayscale',
];
const bareTag = t => String(t || '').trim().replace(/^-?\d+(?:\.\d+)?::/, '').replace(/::$/, '').replace(/[{}\[\]]/g, '').replace(/_/g, ' ').trim().toLowerCase();
const splitTags = s => String(s || '').split(/[,\n]/).map(t => t.trim()).filter(Boolean);

/** 负面里会坏事的词 */
function comicNegativeConflicts(neg, { monochrome = true } = {}) {
    const bad = new Set(NEG_FORBIDDEN.filter(t => monochrome || !['screentone', 'halftone', 'monochrome', 'greyscale', 'grayscale'].includes(t)));
    return [...new Set(splitTags(neg).filter(t => bad.has(bareTag(t))))];
}
/** 去掉负面里会坏事的词 */
function stripComicNegative(neg, opts) {
    const bad = new Set(comicNegativeConflicts(neg, opts));
    return splitTags(neg).filter(t => !bad.has(t)).join(', ');
}
/** 正面（画风）里的人数词 */
function comicPositiveConflicts(pos) {
    return [...new Set(splitTags(pos).filter(t => /^(?:\d+\+?(?:boys?|girls?|others?)|solo|multiple (?:boys|girls))$/.test(bareTag(t))))];
}

function hashText(s) {
    let h = 2166136261;
    for (const ch of String(s).replace(/\s+/g, ' ').trim()) { h ^= ch.codePointAt(0); h = Math.imul(h, 16777619); }
    return (h >>> 0).toString(36);
}

/** 一条消息里的所有漫画页：按出现顺序，每页带上它前面的分镜规划 */
function comicBlocks(text) {
    const src = String(text || '');
    const blocks = [];
    let last = 0;
    for (const m of src.matchAll(COMIC_BLOCK)) {
        const inner = m[1].trim();
        if (!/^\s*@(?:page|position)\b/i.test(inner) && !/^\s*\{[\s\S]*"format"\s*:\s*"nai5-comic"/.test(inner)) { last = m.index + m[0].length; continue; }
        const between = src.slice(last, m.index);
        const plans = [...between.matchAll(PLAN_BLOCK)];
        const plan = plans.at(-1);
        blocks.push({
            inner, raw: m[0], start: m.index, end: m.index + m[0].length, key: hashText(inner),
            plan: plan ? plan[1].trim() : '', planStart: plan ? last + plan.index : -1, planEnd: plan ? last + plan.index + plan[0].length : -1,
        });
        last = m.index + m[0].length;
    }
    return blocks.map((b, i) => ({ ...b, page: i + 1, total: blocks.length }));
}
function roundPlan(text) {
    const m = /<thinking\b[^>]*>([\s\S]*?)<\/thinking>/i.exec(String(text || ''));
    return m ? m[1].trim() : '';
}

const clamp01 = n => Math.max(0, Math.min(1, n));
/** 一段 Text: 前面是画面描述，后面是要画进去的原文 */
function splitText(value) {
    const text = String(value || '').trim(), m = /(?:^|\n)[ \t]*Text[ \t]*[:：]/i.exec(text);
    return m ? { visual: text.slice(0, m.index).trim(), text: text.slice(m.index + m[0].length).trim() } : { visual: text, text: '' };
}

/** 分段协议 → 数据 */
function readSections(body) {
    const data = { page: { base: '', non_character: '' }, panels: [], manual: false };
    let panel = null, character = null, target = null, buf = [], hasPage = false;
    const flush = () => { if (target) target.o[target.k] = buf.join('\n').trim(); buf = []; };
    const lines = String(body || '').replace(/\r\n?/g, '\n').split('\n');
    for (let i = 0; i < lines.length; i++) {
        const m = /^\s*@(page|panel|character|negative|non_character|position|center)\b(?:[ \t]+(.*?))?[ \t]*$/i.exec(lines[i]);
        if (!m) { if (target) buf.push(lines[i]); else if (lines[i].trim()) return { ok: false, reason: `第 ${i + 1} 行不属于任何段落` }; continue; }
        flush(); target = null;
        const kind = m[1].toLowerCase(), value = String(m[2] || '').trim();
        if (kind === 'position') data.manual = value === 'manual';
        else if (kind === 'page') { if (hasPage) return { ok: false, reason: '一页只能有一个 @page' }; hasPage = true; target = { o: data.page, k: 'base' }; }
        else if (kind === 'panel') { if (!hasPage) return { ok: false, reason: '@panel 要写在 @page 后面' }; panel = { id: value || `P${data.panels.length + 1}`, description: '', non_character: '', characters: [] }; data.panels.push(panel); character = null; target = { o: panel, k: 'description' }; }
        else if (kind === 'character') { if (!panel) return { ok: false, reason: '@character 要写在某个 @panel 里' }; character = { id: value || `C${panel.characters.length + 1}`, positive: '', negative: '' }; panel.characters.push(character); target = { o: character, k: 'positive' }; }
        else if (kind === 'negative') { if (!character) return { ok: false, reason: '@negative 要跟在某个 @character 后面' }; target = { o: character, k: 'negative' }; }
        else if (kind === 'non_character') { character = null; target = { o: panel || data.page, k: 'non_character' }; }
        else if (kind === 'center') {
            const [x, y] = value.split(/[,，]/).map(Number);
            if (character && Number.isFinite(x) && Number.isFinite(y)) character.center = { x: clamp01(x), y: clamp01(y) };
        }
    }
    flush();
    if (!hasPage) return { ok: false, reason: '缺少 @page' };
    return { ok: true, data };
}

/** 一页漫画提示词 → 出图要用的东西 */
function parseComicPage(inner) {
    let data;
    const body = String(inner || '').trim();
    if (/^\s*\{/.test(body)) {
        try { const j = JSON.parse(body); data = { page: j.page || {}, panels: Array.isArray(j.panels) ? j.panels.map(p => ({ ...p, characters: (p.characters || []).map(c => ({ id: c.character_id || c.id, positive: c.positive, negative: c.negative, center: c.center })) })) : [], manual: j.position_mode === 'manual' }; }
        catch { return { ok: false, reason: '漫画页 JSON 不完整' }; }
    } else {
        const r = readSections(body);
        if (!r.ok) return r;
        data = r.data;
    }
    const pieces = [splitText(data.page.base), splitText(data.page.non_character)];
    const chars = [];
    for (const p of data.panels) {
        pieces.push(splitText(p.description), splitText(p.non_character));
        for (const c of p.characters || []) {
            const positive = String(c.positive || '').trim();
            if (!positive) continue;
            chars.push({ panel: p.id, id: c.id, positive, negative: String(c.negative || '').trim(), ...(data.manual && c.center ? { center: c.center } : {}) });
        }
    }
    const visual = pieces.map(p => p.visual.replace(/[,，]\s*$/, '')).filter(Boolean).join(', ');
    if (!visual) return { ok: false, reason: '这页没有画面描述' };
    const texts = pieces.map(p => p.text).filter(Boolean);
    const base = visual + (texts.length ? '\nText: ' + texts.join('\n\n') : '');
    const spread = /見開き|double-page spread|2-page spread|wide spread/i.test(base);
    // 对白按格分好，插件自己叠在图上用（NAI 画中文字常常是乱码）
    const pageTexts = [splitText(data.page.base).text, splitText(data.page.non_character).text].filter(Boolean);
    const panelTexts = data.panels.map(p => [splitText(p.description).text, splitText(p.non_character).text, ...(p.characters || []).map(c => splitText(c.positive).text)].filter(Boolean));
    return { ok: true, base, visual, chars, manual: !!data.manual, spread, panels: data.panels.length, pageTexts, panelTexts, boxes: panelBoxes(data) };
}

/** 按每格描述里的 top / bottom / left / right 估算每格在页面上的位置（0–1），对白叠在对应那一格 */
function panelBoxes(data) {
    const panels = data?.panels || [], n = panels.length;
    if (!n) return [];
    // 位置取开头的布局说明，避免对白或镜头描述里的 left/right 被当成分格。
    const words = p => String(p.description || '').toLowerCase().trim().match(/^(?:top|upper|bottom|lower|middle|center|centre|left|right)\b[^,\n]*/)?.[0] || '';
    const rowOf = t => /\b(top|upper)\b/.test(t) ? 0 : /\b(bottom|lower)\b/.test(t) ? 2 : /\b(middle|center|centre)\b/.test(t) ? 1 : null;
    const colOf = t => /\bleft\b/.test(t) ? 0 : /\bright\b/.test(t) ? 2 : null;
    const info = panels.map(p => { const t = words(p); return { row: rowOf(t), col: colOf(t) }; });
    let rows = [];
    if (info.every(x => x.row !== null)) {
        const keys = [...new Set(info.map(x => x.row))].sort((a, b) => a - b);
        rows = keys.map(k => info.map((x, i) => x.row === k ? i : -1).filter(i => i >= 0));
    } else if (info.every(x => x.col === null) && n === 4 && /2\s*[x×]\s*2|grid|four[- ]panel/i.test(String(data.page?.base || ''))) {
        rows = [[0, 1], [2, 3]];
    } else {
        for (let i = 0; i < n; i++) {
            const row = rows[rows.length - 1], last = row && info[row[row.length - 1]];
            if (!row || info[i].col === null || !last || last.col === null || info[i].col <= last.col) rows.push([i]); else row.push(i);
        }
    }
    const boxes = [];
    rows.forEach((row, r) => {
        row.sort((a, b) => (info[a].col ?? 1) - (info[b].col ?? 1) || a - b);
        row.forEach((i, c) => { boxes[i] = { x: c / row.length, y: r / rows.length, w: 1 / row.length, h: 1 / rows.length }; });
    });
    return boxes;
}
/** 去掉对白里多写的「Text:」前缀 */
const capLine = t => String(t || '').replace(/(^|\n)[ \t]*Text[ \t]*[:：][ \t]*/gi, '$1').trim();

/** 出图请求：画风（正文画师串）在最前面，漫画页描述在后；负面 = 画风负面 + 漫画负面 */
const COMIC_NO_TEXT_NEG = 'text, speech bubble, letters, chinese text, english text';
/** textMode：draw = 对白交给 NAI 画进图里；overlay = 不让 NAI 画字，插件叠在图上；none = 不要对白 */
function comicRequest(parsed, { stylePos = '', styleNeg = '', extraNeg = '', width = 832, height = 1216, textMode = 'draw' } = {}) {
    let w = Number(width) || 832, h = Number(height) || 1216;
    if (parsed.spread && w < h) [w, h] = [h, w];
    const draw = textMode === 'draw' || !parsed.visual;
    const positive = [String(stylePos || '').trim(), draw ? parsed.base : parsed.visual].filter(Boolean).join(', ');
    const negative = [styleNeg, extraNeg, draw ? '' : COMIC_NO_TEXT_NEG].map(s => String(s || '').trim()).filter(Boolean).join(', ');
    const chars = parsed.chars.map(c => ({ prompt: draw ? c.positive : splitText(c.positive).visual, uc: c.negative, ...(c.center ? { center: c.center } : {}) }));
    return { positive, negative, chars, width: w, height: h };
}
/** 叠在图上的对白：每格的字放在这一格（按竖着平分估算）底部，整页旁白放最上面 */
function captionsHtml(parsed, esc, size = 's') {
    if (!parsed?.ok || size === 'hide') return '';
    const n = Math.max(1, parsed.panelTexts.length);
    const boxes = parsed.boxes?.length === parsed.panelTexts.length ? parsed.boxes : null;
    // 字号写在行内并加 !important：聊天楼层里美化常给正文统一设字号，样式表压不住
    const fs = { xs: 'clamp(5px,1.9cqw,10px)', s: 'clamp(6px,2.5cqw,13px)', m: 'clamp(8px,3.2cqw,16px)', l: 'clamp(10px,4cqw,20px)' }[size] || 'clamp(6px,2.5cqw,13px)';
    const font = `font-size:${fs} !important;line-height:1.35 !important;font-family:'Noto Serif SC','Songti SC',serif !important;font-weight:${size === 'xs' ? 500 : 600} !important;padding:.15em .6em !important;margin:0 !important;letter-spacing:0 !important;text-indent:0 !important`;
    const box = (t, style, cls = '') => `<div class="pc-comic-cap ${cls}" style="${style};${font}">${t.map(capLine).filter(Boolean).map(x => esc(x).replace(/\n+/g, '<br>')).join('<br>')}</div>`;
    const out = [];
    if (parsed.pageTexts.length) out.push(box(parsed.pageTexts, 'top:8px', 'top'));
    parsed.panelTexts.forEach((t, i) => {
        if (!t.map(capLine).some(Boolean)) return;
        const b = boxes?.[i] || { x: 0, y: i / n, w: 1, h: 1 / n };
        const bottom = b.y + b.h > 0.99;
        // 字放在这一格底部、横向居中，宽度不超过这一格；底行让开左侧页码和右侧版本按钮
        out.push(box(t, `left:${((b.x + b.w / 2) * 100).toFixed(2)}%;top:calc(${((b.y + b.h) * 100).toFixed(2)}% - ${bottom ? 40 : 6}px);max-width:calc(${(b.w * 100).toFixed(2)}% - 10px)`));
    });
    return out.length ? `<div class="pc-comic-caps sz-${size}" style="position:absolute !important;inset:0 !important;container-type:inline-size !important;pointer-events:none;margin:0 !important;padding:0 !important">${out.join('')}</div>` : '';
}
/** 存下的对白没有分格位置（旧版本）时，从这一页的提示词里补上 */
function captionSource(v, inner) {
    if (v?.textMode !== 'overlay') return null;
    if (!v.captions) return parseComicPage(inner);
    if (v.captions.boxes) return v.captions;
    const p = parseComicPage(inner);
    return { ...v.captions, boxes: p.ok ? p.boxes : undefined };
}

/** 「让 AI 重写本页」的请求 */
function rewriteRequest(message, page, requirement) {
    const blocks = comicBlocks(message);
    const plan = roundPlan(message);
    const refs = blocks.map(b => `<page_reference page="${b.page}">\n${b.plan ? `<comic_plan>\n${b.plan}\n</comic_plan>\n` : ''}<image>\n${b.inner}\n</image>\n</page_reference>`).join('\n\n');
    const system = '你是漫画分镜导演，负责改写单页漫画的分镜规划和图片提示词。沿用参考里的角色外貌、衣着、画风、色彩、对白语言和连续状态。'
        + '只输出一组 <comic_plan>…</comic_plan> 和一组 <image>…</image>，不要输出其他页、整轮规划或任何解释。'
        + '<image> 用分段文本协议：@page（分级、实际人数词、页面形态、画格数量、布局、留白、光影、文字标签）→ 每格 @panel P1、P2…（位置大小构图环境）→ 格内每个可见人物 @character C1…（boy/girl/other、完整外貌衣着、动作表情），可选 @negative、@non_character；'
        + '需要画进图里的原句写在该段末尾的「Text: 」后面。人物段用不带数字的 boy、girl 或 other。';
    const user = `<comic_reference readonly="true">\n${plan ? `<thinking>\n${plan}\n</thinking>\n\n` : ''}${refs}\n</comic_reference>\n\n只重写第 ${page} 页。要求：${String(requirement || '').trim() || '保持人物、衣着、场景和剧情连续，优化这一页的分镜构图与提示词。'}`;
    return { system, user };
}
/** AI 的回复里取出新的一页 */
function parseRewrite(text) {
    const t = String(text || '');
    const image = [...t.matchAll(COMIC_BLOCK)].map(m => m[1].trim()).find(x => parseComicPage(x).ok);
    if (!image) throw new Error('AI 没有按格式写出这一页（缺少 <image>@page …</image>）');
    const plan = /<comic_plan\b[^>]*>([\s\S]*?)<\/comic_plan>/i.exec(t);
    return { image, plan: plan ? plan[1].trim() : '' };
}
/** 正文 → 给 AI 读的干净文字（去掉思考、标签、旧的生图标记） */
function storyText(mes) {
    return String(mes || '')
        .replace(/<(thinking|think|comic_plan|image|details|style|script)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
        .replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')
        .replace(/\n{3,}/g, '\n\n').trim();
}
/** 「把这一楼画成漫画」的请求：读这一楼的正文，改编成几页漫画分镜 */
function adaptRequest(story, { pages = 0, panels = '', cast = '', before = '', color = 'color', extra = '' } = {}) {
    const system = '你是漫画分镜导演，把小说 / 角色扮演的正文改编成日式漫画页，给 NovelAI V5 出图用。'
        + '每一页先写一组 <comic_plan>（这一页讲什么、几格、每格的构图和对白），紧跟着写一组 <image>…</image>。只输出这些块，不要任何解释。'
        + '<image> 用分段文本协议：第一行 @page，下面写这一页的整体：分级（rating:general 或 rating:sensitive）、实际人数词（如 1boy, 1girl, 2boys）、comic page、画格数量与布局、留白、光影、色调。'
        + '然后每一格写 @panel P1、@panel P2…，下面写这一格的位置大小、镜头、环境；格内每个看得见的人物写 @character C1、C2…，下面写 boy / girl / other（不带数字）、完整外貌衣着、动作表情；可选 @negative 写这个人物不要的东西。'
        + '要画进图里的对白、旁白、拟声，写在对应段落末尾单独一行「Text: 」后面，用正文的语言，一格不超过两句；一段只写一个「Text: 」，几句话都接在它后面换行写。'
        + '每个 @panel 第一行先写这格在页面上的位置（top left、top right、bottom half、middle 这类英文词），插件按它把对白叠到对应的格子里。'
        + '标签用英文 NovelAI / Danbooru 标签，逗号隔开；不要写画师名和画风（画风另外加）。人物外貌照下面给的角色资料写，前后页保持一致。'
        + '\n\n格式示例：\n<comic_plan>第 1 页：两格。P1 远景交代咖啡馆和雨；P2 近景他看向窗外。</comic_plan>\n<image>\n@page\nrating:general, 1boy, comic page, 2 panels, vertical layout, rainy night, warm indoor light\n@panel P1\ntop half, wide shot, cafe interior, rain on window\n@panel P2\nbottom half, close-up\n@character C1\nboy, black hair, grey eyes, white shirt, black vest, sitting, looking outside, melancholic\nText: 「又下雨了。」\n</image>';
    const user = (cast ? `<characters>\n${cast}\n</characters>\n\n` : '')
        + (before ? `<previous readonly="true">\n${before}\n</previous>\n\n` : '')
        + `<story>\n${story}\n</story>\n\n把 <story> 改编成${pages ? ` ${pages} 页` : '若干页（按剧情多少自己定：短的 1–2 页，长的可以 5–8 页，剧情每个转折都要有画面，不要压缩成几格）'}${color === 'mono' ? '黑白网点' : '彩色'}漫画，${panels ? `每页 ${panels} 格` : '每页 2–5 格'}。只画 <story> 里发生的事${pages ? `，${pages} 页要把整段剧情从头画到尾，平均分配` : ''}。`
        + (String(extra || '').trim() ? `\n额外要求：${String(extra).trim()}` : '');
    return { system, user };
}
/** AI 改编出来的几页：只留能用的 <comic_plan> + <image> */
function parseAdapt(text) {
    const t = String(text || '');
    const out = [];
    let last = 0;
    for (const m of t.matchAll(COMIC_BLOCK)) {
        const inner = m[1].trim();
        if (parseComicPage(inner).ok) {
            const plan = [...t.slice(last, m.index).matchAll(PLAN_BLOCK)].at(-1);
            out.push((plan ? `<comic_plan>\n${plan[1].trim()}\n</comic_plan>\n` : '') + `<image>\n${inner}\n</image>`);
        }
        last = m.index + m[0].length;
    }
    if (!out.length) throw new Error('AI 没有按格式写出漫画页（缺少 <image>@page …</image>）');
    return out.join('\n\n');
}

/** 把消息里的第 page 页换成新写的 */
function replacePage(message, page, { image, plan }) {
    const blocks = comicBlocks(message);
    const b = blocks[page - 1];
    if (!b) throw new Error('这一页已经不在这楼里了');
    let out = message.slice(0, b.start) + `<image>\n${image}\n</image>` + message.slice(b.end);
    if (plan && b.planStart >= 0) out = out.slice(0, b.planStart) + `<comic_plan>\n${plan}\n</comic_plan>` + out.slice(b.planEnd);
    return out;
}

// ───────────── 楼层里的显示与操作 ─────────────

const CSS = `
.pc-comic-redo{display:flex;gap:8px;justify-content:flex-end;margin-top:6px}
.pc-comic-redo button{border:1px dashed currentColor;background:transparent;color:inherit;opacity:.75;border-radius:999px;padding:3px 12px;font-size:12px;cursor:pointer}
.pc-comic{display:flex;flex-direction:column;gap:10px;margin:10px 0 4px}
.pc-comic-page{position:relative;margin:0;border-radius:14px;overflow:hidden;border:1.5px solid var(--pc-paper,#f4efe4);background:var(--pc-paper-2,#ebe4d2);-webkit-user-select:none;user-select:none;-webkit-touch-callout:none;touch-action:manipulation}
.pc-comic-page img{display:block;width:100%;height:auto;cursor:pointer;-webkit-user-drag:none}
.pc-comic-caps{position:absolute;inset:0;pointer-events:none;container-type:inline-size}
.pc-comic-cap{position:absolute;box-sizing:border-box;left:50%;transform:translate(-50%,-100%);width:max-content;max-width:80%;background:rgba(255,255,255,.84);color:#16120f;border:1px solid rgba(22,18,15,.7);border-radius:.8em;padding:.15em .6em;font:600 9px/1.35 "Noto Serif SC","Songti SC",serif;font-size:clamp(6px,2.5cqw,13px);text-align:center;word-break:break-word}
.pc-comic-caps.sz-xs .pc-comic-cap{font-size:7px;font-size:clamp(5px,1.9cqw,10px);font-weight:500}
.pc-comic-caps.sz-m .pc-comic-cap{font-size:11px;font-size:clamp(8px,3.2cqw,16px)}
.pc-comic-caps.sz-l .pc-comic-cap{font-size:13px;font-size:clamp(10px,4cqw,20px)}
.pc-comic-cap.top{transform:translate(-50%,0);background:#16120f;color:#f4efe4}
.pc-comic.nocap .pc-comic-caps{display:none}
.pc-comic-fold{display:flex;gap:8px;align-items:center;margin-top:6px}
.pc-comic-fold button{border:1px dashed currentColor;background:transparent;color:inherit;border-radius:999px;padding:4px 14px;font-size:13px;cursor:pointer}
.pc-comic-acts{position:absolute;left:0;right:0;top:0;display:none;gap:8px;justify-content:center;padding:10px;background:linear-gradient(rgba(20,18,16,.55),transparent)}
.pc-comic-page.acts .pc-comic-acts{display:flex}
.pc-comic-acts button{border:1.5px solid #f4efe4;background:rgba(20,18,16,.65);color:#f4efe4;border-radius:999px;padding:5px 14px;font-size:13px;cursor:pointer}
.pc-comic-tag,.pc-comic-ver{position:absolute;bottom:8px;font:11px ui-monospace,Menlo,monospace;letter-spacing:.1em;background:rgba(244,239,228,.94);color:#3a2a22;padding:2px 10px;border-radius:999px}
.pc-comic-tag{left:8px}.pc-comic-ver{right:8px;display:flex;gap:4px;align-items:center;padding:0 4px}
.pc-comic-ver button{border:0;background:transparent;color:#3a2a22;font-size:15px;line-height:1;padding:4px 6px;cursor:pointer}
.pc-comic-wait{min-height:96px;display:grid;place-items:center;text-align:center;border-radius:14px;border:1.5px dashed rgba(244,239,228,.45);background:rgba(244,239,228,.07);color:var(--SmartThemeBodyColor,#e9dfcf);font-size:13px;padding:14px}
.pc-comic-wait small{display:block;font-size:11px;opacity:.7;margin-top:2px;white-space:pre-wrap}
.pc-comic-wait button{margin-top:8px;min-height:34px;padding:0 16px;border-radius:999px;border:1.5px solid currentColor;background:transparent;color:inherit;font:inherit;cursor:pointer}
.pc-comic-busy{position:absolute;inset:0;display:grid;place-items:center;background:rgba(20,18,16,.5);z-index:2}
.pc-comic-busy span{padding:8px 18px;border-radius:999px;background:rgba(20,18,16,.8);color:#fff;font-size:14px;letter-spacing:.15em;animation:pc-comic-pulse 1.2s ease-in-out infinite}
@keyframes pc-comic-pulse{50%{opacity:.45}}
.pc-comic-book{position:fixed;inset:0;z-index:2147480300;background:#141210;color:#f4efe4;font-family:"Noto Serif SC","Songti SC",serif;overflow:hidden;-webkit-user-select:none;user-select:none}
.pc-comic-book header{position:absolute;top:0;left:0;right:0;z-index:10;display:flex;flex-wrap:wrap;align-items:center;gap:6px 8px;padding:max(10px,env(safe-area-inset-top)) 12px 6px}
.pc-comic-book header b{flex:1;min-width:0;font-size:15px;letter-spacing:.1em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pc-comic-book header small{font:11px ui-monospace,Menlo,monospace;letter-spacing:.1em;opacity:.75}
.pc-comic-book .bb{min-width:40px;height:40px;padding:0 12px;border-radius:999px;border:1.5px solid rgba(244,239,228,.6);background:transparent;color:inherit;font:14px inherit;cursor:pointer}
.pc-comic-book .seg{flex-basis:100%;display:flex;margin:0 auto;max-width:300px;padding:3px;border-radius:999px;background:rgba(244,239,228,.12)}
.pc-comic-book .seg button{flex:1;border:0;background:transparent;color:#f4efe4;font:13px inherit;padding:6px 10px;border-radius:999px;cursor:pointer}
.pc-comic-book .seg button.on{background:#f4efe4;color:#3a2a22}
.pc-comic-stage{position:absolute;inset:112px 0 92px;display:flex;align-items:center;justify-content:center;perspective:1600px}
.pc-comic-stage .empty{opacity:.7;font-size:14px;text-align:center;line-height:1.8;padding:0 24px}
.pc-comic-book .tip{position:absolute;left:0;right:0;bottom:74px;text-align:center;font-size:11px;opacity:.55;letter-spacing:.1em}
.pc-comic-book footer{position:absolute;left:0;right:0;bottom:0;display:flex;align-items:center;gap:10px;padding:8px 12px max(14px,env(safe-area-inset-bottom))}
.pc-comic-book footer input{flex:1;accent-color:#c98a3e}
.pc-cb-art{position:absolute;inset:0;overflow:hidden;background:#ece4d4}
.pc-cb-art img{width:100%;height:100%;object-fit:contain;display:block;-webkit-user-drag:none}
.pc-cb-art span{position:absolute;right:8px;bottom:6px;font:10px ui-monospace,Menlo,monospace;color:#3a2a22;background:rgba(244,239,228,.9);padding:1px 7px;border-radius:99px}
.pc-cb-spread{position:relative;width:min(96vw,calc((100vh - 220px) * 1.368));aspect-ratio:1664/1216;transform-style:preserve-3d}
.pc-cb-spread::before{content:"";position:absolute;inset:-6px -10px -10px -10px;border-radius:8px;background:#3a2a22;box-shadow:0 18px 40px rgba(0,0,0,.6);transform:translateZ(-3px)}
.pc-cb-lbase,.pc-cb-rbase{position:absolute;top:0;bottom:0;width:50%}
.pc-cb-lbase{left:0;border-radius:8px 0 0 8px;background:linear-gradient(90deg,#efe7d6,#e2d8c4)}
.pc-cb-rbase{right:0;border-radius:0 8px 8px 0;background:repeating-linear-gradient(90deg,#d9cfbd 0 2px,#efe7d6 2px 4px)}
.pc-cb-blank{position:absolute;inset:0;display:grid;place-items:center;color:#a39580;font-size:13px;letter-spacing:.3em}
.pc-cb-leaf{position:absolute;top:0;bottom:0;left:50%;width:50%;transform-origin:left center;transform-style:preserve-3d;transition:transform .5s cubic-bezier(.3,.7,.2,1)}
.pc-cb-leaf.drag{transition:none}
.pc-cb-leaf .f,.pc-cb-leaf .b{position:absolute;inset:0;overflow:hidden;backface-visibility:hidden;-webkit-backface-visibility:hidden}
.pc-cb-leaf .f{border-radius:0 8px 8px 0}
.pc-cb-leaf .b{transform:rotateY(180deg);border-radius:8px 0 0 8px;background:#f4efe4}
.pc-cb-leaf .shade{position:absolute;inset:0;pointer-events:none;background:linear-gradient(90deg,rgba(0,0,0,.35),transparent 40%);opacity:0}
.pc-cb-gutter{position:absolute;left:50%;top:0;bottom:0;width:36px;margin-left:-18px;pointer-events:none;background:linear-gradient(90deg,transparent,rgba(0,0,0,.28) 45%,rgba(0,0,0,.35) 50%,rgba(0,0,0,.28) 55%,transparent);transform:translateZ(1px);z-index:999}
.pc-cb-flow{position:relative;width:100%;height:100%}
.pc-cb-card{position:absolute;left:50%;top:50%;width:min(60vw,calc((100vh - 220px) * .55));aspect-ratio:832/1216;transition:transform .45s cubic-bezier(.3,.7,.2,1),filter .45s;cursor:pointer}
.pc-cb-card .pc-cb-art{border-radius:10px;box-shadow:0 14px 34px rgba(0,0,0,.55)}
.pc-cb-card.drag{transition:none}
.pc-cb-scroll{position:absolute;inset:0;overflow-y:auto;scroll-snap-type:y mandatory;scrollbar-width:none;-webkit-overflow-scrolling:touch}
.pc-cb-scroll::-webkit-scrollbar{display:none}
.pc-cb-vpage{height:100%;scroll-snap-align:center;display:flex;align-items:center;justify-content:center;padding:8px 0}
.pc-cb-vpage .holder{position:relative;height:100%;aspect-ratio:832/1216;max-width:94vw;border-radius:8px;overflow:hidden}
.pc-cb-vfloor{scroll-snap-align:start;padding:18px 0 6px;text-align:center;font-size:12px;letter-spacing:.3em;color:#c98a3e}
.pc-comic-toc{position:absolute;left:0;right:0;bottom:0;max-height:70%;overflow:auto;background:#f4efe4;color:#3a2a22;border-radius:22px 22px 0 0;padding:10px 16px 20px;scrollbar-width:none}
.pc-comic-toc::-webkit-scrollbar{display:none}
.pc-comic-toc h4{margin:4px 0 10px;font-size:16px;letter-spacing:.2em}
.pc-comic-toc button{display:flex;gap:10px;align-items:center;width:100%;margin:0 0 8px;padding:6px;border:1.5px solid #3a2a22;border-radius:14px;background:#f4efe4;color:#3a2a22;font:14px inherit;text-align:left;cursor:pointer}
.pc-comic-toc button img{width:44px;height:60px;object-fit:cover;object-position:top;border-radius:8px;background:#ddd}
.pc-comic-toc button small{display:block;font-size:11px;color:#6e5a4d}
.pc-comic-toc button span{flex:1;min-width:0}
.pc-comic-toc button.todo{border-style:dashed}
.pc-comic-toc button.todo i{flex:0 0 44px;height:60px;border-radius:8px;border:1.5px dashed #b9a896;display:grid;place-items:center;font-style:normal;font-size:20px;color:#9a8878}
.pc-comic-toc button.todo em{flex:0 0 auto;font-style:normal;font-size:12px;padding:4px 10px;border-radius:999px;background:#3a2a22;color:#f4efe4}
.pc-comic-set .pc-label{margin-top:14px}
.pc-comic-set>.pc-label:first-child,.pc-comic-set>.pc-banwarn:first-child+.pc-label{margin-top:0}
.pc-comic-set select.pc-input{margin-top:4px}
.pc-comic-toc-tip{font-size:12px;color:#6e5a4d;margin:-4px 0 10px;line-height:1.6}
.pc-comic-book .empty .bb.wide{width:auto;padding:0 18px;margin-top:14px;border-radius:999px}
.pc-comic-fail{border:1.5px dashed #9b4f45;border-radius:14px;padding:10px 12px;font-size:13px;line-height:1.6;color:inherit}
.pc-comic-fail b{color:#9b4f45}
.pc-comic-fail button{margin:8px 8px 0 0;border:1px solid currentColor;background:transparent;color:inherit;border-radius:999px;padding:3px 12px;font-size:12px;cursor:pointer}
.pc-comic-work textarea{min-height:200px}
.pc-comic-work .pc-seg{grid-template-columns:repeat(3,minmax(0,1fr))}
`;

function createComicController(deps) {
    const { document: doc, getContext, getData, commit, generatePage, storeImage, resolveUrl, recordImage, dropImage, askLLM, notify, modal, esc } = deps;
    const win = doc.defaultView;
    const style = doc.createElement('style');
    style.id = 'pc-comic-style';
    style.textContent = CSS;
    doc.head.appendChild(style);
    const running = new Map(); // `${id}:${key}` -> 'wait' | 'run'
    const errors = new Map();
    const panels = new Set();
    const readers = new Set();
    let stopped = false, chatSeq = 0;

    const opts = () => getData().options;
    const enabled = () => !!opts().comicOn;
    const chatKey = c => String(c.getCurrentChatId?.() ?? c.chatId ?? '') + '|' + String(c.characterId ?? '') + '|' + String(c.groupId ?? '');
    const store = msg => (msg.extra ||= {}, msg.extra.zhikuComic ||= {});
    // 漫画页的来源：回复里自己写了 <image>@page 就用正文；没写的话，用「画成漫画」让 AI 改编出来、存在这楼 extra 里的（按 swipe 分开）
    const swipeKey = msg => String(msg.swipe_id ?? 0);
    const srcOf = msg => !msg ? '' : comicBlocks(msg.mes).length ? msg.mes : (msg.extra?.zhikuComicSrc?.[swipeKey(msg)] || '');
    function setSrc(msg, text) {
        if (comicBlocks(msg.mes).length) {
            msg.mes = text;
            if (msg.swipes && Number.isInteger(msg.swipe_id)) msg.swipes[msg.swipe_id] = msg.mes;
            return 'mes';
        }
        ((msg.extra ||= {}).zhikuComicSrc ||= {})[swipeKey(msg)] = text;
        return 'extra';
    }
    const adapting = new Map(); // id -> 状态文字
    const failed = new Map(); // id -> 没改编成的原因（留在楼层里，能重试）
    const isAdapting = id => {
        const task = adapting.get(id);
        if (task && !task.current()) { adapting.delete(id); return false; }
        return !!task;
    };
    const failure = id => {
        const err = failed.get(id);
        if (err && !err.current()) { failed.delete(id); return ''; }
        return err?.why || '';
    };
    const rec = (msg, key) => msg?.extra?.zhikuComic?.[key] || null;
    const curVer = r => r?.versions?.[Math.min(r.cur ?? r.versions.length - 1, r.versions.length - 1)] || null;
    const size = () => String(opts().comicSize || '832x1216').split('x').map(Number);
    function style_() {
        const d = getData();
        const M = deps.model;
        const own = String(opts().comicStyle || '');
        const m = /^(group|artist):(.+)$/.exec(own);
        const ownRef = m && M.resolveTicket(d, { type: m[1], id: m[2] }) ? { type: m[1], id: m[2] } : null;
        const ref = ownRef || d.active;
        return { pos: ref ? M.ticketString(d, ref) : '', neg: ref ? M.ticketNeg(d, ref) : '', name: ref ? M.ticketName(d, ref) : '' };
    }
    function negativeFor() {
        const st = style_();
        const extra = opts().comicNeg ?? COMIC_DEFAULT_NEGATIVE;
        const neg = [st.neg, extra].filter(Boolean).join(', ');
        return opts().comicStripNeg === false ? neg : stripComicNegative(neg, { monochrome: opts().comicColor === 'mono' });
    }
    async function saveChat(c = getContext()) { await (c.saveChatConditional || c.saveChat)?.call(c); }
    function pageSnapshot(id, block) {
        const c = getContext(), msg = c.chat?.[id], seq = chatSeq;
        if (stopped || !msg || (block && !comicBlocks(srcOf(msg)).some(b => b.key === block.key))) return null;
        const source = srcOf(msg), body = msg.mes, native = !!comicBlocks(body).length, swipe = msg.swipe_id, chat = chatKey(c);
        return { c, msg, source, body, swipe, current: (next = source) => !stopped && seq === chatSeq && chatKey(getContext()) === chat && getContext().chat?.[id] === msg && msg.mes === (native ? next : body) && srcOf(msg) === next && msg.swipe_id === swipe };
    }
    function checkpoint(msg) {
        const body = msg.mes, swipe = msg.swipe_id, oldSwipe = msg.swipes?.[swipe], hadExtra = !!msg.extra;
        const fields = ['zhikuComic', 'zhikuComicSrc', 'zhikuComicFold'];
        const saved = fields.map(k => msg.extra?.[k] ? { ...msg.extra[k] } : undefined);
        return () => {
            msg.mes = body;
            if (msg.swipes && Number.isInteger(swipe)) msg.swipes[swipe] = oldSwipe;
            fields.forEach((k, i) => { if (saved[i]) (msg.extra ||= {})[k] = saved[i]; else if (msg.extra) delete msg.extra[k]; });
            if (!hadExtra && msg.extra && !Object.keys(msg.extra).length) delete msg.extra;
        };
    }
    const discard = url => { if (url) Promise.resolve().then(() => dropImage?.(url)).catch(() => {}); };

    async function generateOne(id, block, { inner } = {}) {
        const snap = pageSnapshot(id, block);
        if (!snap) return;
        const { c, msg } = snap;
        const job = `${id}:${block.key}`;
        if (running.has(job)) return;
        running.set(job, 'wait'); errors.delete(job); render(id);
        try {
            const parsed = parseComicPage(inner ?? block.inner);
            if (!parsed.ok) throw new Error(parsed.reason);
            const st = style_();
            const [w, h] = size();
            const textMode = ['draw', 'overlay', 'none'].includes(opts().comicText) ? opts().comicText : 'overlay';
            const mono = opts().comicColor === 'mono' ? 'monochrome, greyscale, screentone' : '';
            const req = comicRequest(parsed, { stylePos: [st.pos, mono].filter(Boolean).join(', '), extraNeg: negativeFor(), width: w, height: h, textMode });
            running.set(job, 'run'); render(id);
            const r = await generatePage(req);
            if (!snap.current()) return;
            const saved = await storeImage(r.image, `comic_${Date.now()}`);
            if (!saved?.url) throw new Error('漫画图片保存未返回地址');
            if (!snap.current()) { discard(saved.url); return; }
            const hadExtra = !!msg.extra, hadStore = !!msg.extra?.zhikuComic, old = rec(msg, block.key);
            const versions = [...(old?.versions || []), { url: saved.url, seed: r.sent?.seed, size: r.sent?.size, at: Date.now(), style: st.name, textMode, captions: textMode === 'overlay' ? { ok: true, pageTexts: parsed.pageTexts, panelTexts: parsed.panelTexts, boxes: parsed.boxes } : null, sent: { positive: req.positive, negative: req.negative, chars: req.chars } }];
            const removed = versions.length > 10 ? versions.shift() : null;
            const entry = { ...(old || {}), versions, cur: versions.length - 1 };
            store(msg)[block.key] = entry;
            try { await saveChat(c); }
            catch (e) {
                if (old) store(msg)[block.key] = old; else delete store(msg)[block.key];
                if (!hadStore && !Object.keys(msg.extra.zhikuComic).length) delete msg.extra.zhikuComic;
                if (!hadExtra && !Object.keys(msg.extra).length) delete msg.extra;
                discard(saved.url); throw e;
            }
            if (removed) discard(removed.url);
            Promise.resolve(recordImage?.({ dataUrl: r.image, url: saved.url, raw: inner ?? block.inner, sent: r.sent, from: 'comic' })).catch(e => console.warn('[智库] 漫画历史保存失败', e));
        } catch (e) {
            errors.set(job, e?.message || String(e));
            console.warn('[智库] 漫画页没出来', e);
        } finally {
            running.delete(job);
            render(id);
        }
    }

    /** 这楼里还没出图的页，一页一页排队出 */
    async function process(id, { manual = false } = {}) {
        if (stopped || (!manual && (!enabled() || opts().comicAuto === false))) return;
        const msg = getContext().chat?.[id];
        if (!msg || msg.is_user || msg.is_system) return;
        const blocks = comicBlocks(srcOf(msg));
        if (!blocks.length) return;
        render(id);
        const snap = pageSnapshot(id, blocks[0]);
        for (const b of blocks) {
            if (!snap?.current()) break;
            if (!rec(msg, b.key)?.versions?.length && !running.has(`${id}:${b.key}`)) await generateOne(id, b);
        }
    }

    function pageHtml(id, msg, b) {
        const r = rec(msg, b.key), v = curVer(r), job = `${id}:${b.key}`;
        const tag = `<span class="pc-comic-tag">第 ${b.page} / ${b.total} 页</span>`;
        if (v) {
            const ver = r.versions.length > 1 ? `<span class="pc-comic-ver"><button data-cv="-1" aria-label="上一版">‹</button>${(r.cur ?? 0) + 1}/${r.versions.length}<button data-cv="1" aria-label="下一版">›</button></span>` : '';
            const caps = v.textMode === 'overlay' ? captionsHtml(captionSource(v, b.inner), esc, opts().comicCapSize || 's') : '';
            const acts = `<div class="pc-comic-acts"><button data-cgen>重画这一页</button><button data-cwork>编辑本页</button></div>`;
            const st = running.get(job);
            const busy = st ? `<div class="pc-comic-busy"><span>${st === 'wait' ? '排队中…' : '重画中…'}</span></div>` : '';
            return `<figure class="pc-comic-page${st ? ' busy' : ''}" data-ckey="${b.key}" data-page="${b.page}"><img data-comic-src="${esc(v.url)}" alt="第 ${b.page} 页" draggable="false">${caps}${tag}${ver}${acts}${busy}</figure>`;
        }
        const st = running.get(job);
        const err = errors.get(job);
        const text = st === 'run' ? '生成中…' : st === 'wait' ? '排队中' : err ? '没出来' : enabled() ? (opts().comicAuto === false ? '还没生成' : '等待生成') : '漫画模式没开';
        return `<div class="pc-comic-wait" data-ckey="${b.key}" data-page="${b.page}"><div>第 ${b.page} / ${b.total} 页 · ${text}${err ? `<small>${esc(err)}</small>` : ''}${!st ? `<br><button data-cgen>${err ? '重试' : '生成这一页'}</button> <button data-cwork>编辑本页</button>` : ''}</div></div>`;
    }
    function render(id) {
        const el = doc.querySelector(`#chat .mes[mesid="${id}"]`);
        const msg = getContext().chat?.[id];
        el?.querySelector(':scope .pc-comic')?.remove();
        if (!el || !msg || msg.is_user) return;
        const blocks = comicBlocks(srcOf(msg));
        const own = comicBlocks(msg.mes).length > 0;
        if (failure(id) && !blocks.length && !isAdapting(id)) {
            const box = doc.createElement('div');
            box.className = 'pc-comic';
            box.dataset.mes = String(id);
            box.innerHTML = `<div class="pc-comic-fail"><b>没画成漫画</b><br>${esc(failure(id))}<br><button data-cadapt="${id}">再试一次</button><button data-cremove="${id}">不画了</button></div>`;
            const text = el.querySelector('.mes_text');
            (text ? text.after(box) : el.appendChild(box));
            return;
        }
        if (isAdapting(id) && !blocks.length) {
            const box = doc.createElement('div');
            box.className = 'pc-comic';
            box.dataset.mes = String(id);
            box.innerHTML = `<div class="pc-comic-wait"><div>${esc(adapting.get(id).text)}</div></div>`;
            const text = el.querySelector('.mes_text');
            (text ? text.after(box) : el.appendChild(box));
            return;
        }
        if (!blocks.length || (own && !enabled() && !blocks.some(b => rec(msg, b.key)?.versions?.length))) return;
        const box = doc.createElement('div');
        box.className = 'pc-comic' + (capsHidden ? ' nocap' : '');
        box.dataset.mes = String(id);
        if (msg.extra?.zhikuComicFold?.[swipeKey(msg)]) {
            box.innerHTML = `<div class="pc-comic-fold"><button data-cunfold="${id}">📖 漫画 · ${blocks.length} 页（点开）</button></div>`;
            const text = el.querySelector('.mes_text');
            (text ? text.after(box) : el.appendChild(box));
            return;
        }
        const fail = failure(id);
        box.innerHTML = (fail ? `<div class="pc-comic-fail"><b>重新改编失败</b><br>${esc(fail)}<br><button data-cadapt="${id}">再试一次</button><button data-cremove="${id}">不画了</button></div>` : '') + blocks.map(b => pageHtml(id, msg, b)).join('') + `<div class="pc-comic-redo">${own ? '' : `<button data-cadapt="${id}">${isAdapting(id) ? esc(adapting.get(id).text) : '重新改编这一楼'}</button>`}<button data-ccap>${capsHidden ? '显示对白' : '隐藏对白'}</button><button data-cfold="${id}">收起</button>${own ? '' : `<button data-cremove="${id}">删掉漫画</button>`}</div>`;
        const text = el.querySelector('.mes_text');
        (text ? text.after(box) : el.appendChild(box));
        hydrate(box);
    }
    function hydrate(root) {
        for (const img of root.querySelectorAll('img[data-comic-src]')) Promise.resolve(resolveUrl(img.dataset.comicSrc)).then(u => { if (u) img.src = u; else img.alt = '这台设备上没有这张图（存在别的浏览器里），点一下图可以重画'; });
    }
    /** chatChanged：换了聊天，在途的图不再往旧楼里存 */
    function renderAll({ chatChanged = false } = {}) {
        if (chatChanged) { chatSeq++; errors.clear(); failed.clear(); adapting.clear(); doc.querySelectorAll('.pc-comic').forEach(n => n.remove()); cancelPress({type:'cancel'}); for (const close of [...panels]) close(); }
        const chat = getContext().chat || [];
        for (let i = 0; i < chat.length; i++) if (chat[i]?.mes?.includes('<image') || chat[i]?.extra?.zhikuComicSrc || chat[i]?.extra?.zhikuComicFold || isAdapting(i) || failed.has(i)) render(i);
        for (const refresh of readers) refresh();
    }

    // ── 点击、双击、长按 ──
    const targetOf = ev => {
        const page = ev.target?.closest?.('.pc-comic [data-ckey]');
        if (!page) return null;
        const id = Number(page.closest('.pc-comic').dataset.mes);
        const msg = getContext().chat?.[id];
        const block = msg && comicBlocks(srcOf(msg)).find(b => b.key === page.dataset.ckey);
        return block ? { page, id, msg, block } : null;
    };
    let lastTap = null, press = null, suppressClick = false;
    function onClick(ev) {
        if (suppressClick) { suppressClick = false; ev.preventDefault(); ev.stopPropagation(); return; }
        const ad = ev.target?.closest?.('[data-cadapt],[data-cremove],[data-cfold],[data-cunfold],[data-ccap]');
        if (ad) {
            ev.stopPropagation();
            if (ad.dataset.cadapt) { if (!isAdapting(Number(ad.dataset.cadapt))) void adapt(Number(ad.dataset.cadapt), { redo: true }); }
            else if (ad.dataset.cremove) { if (win.confirm('删掉这一楼的漫画？画好的图也会一起删掉。只想先不看，点「收起」就行。')) void unadapt(Number(ad.dataset.cremove)); }
            else if (ad.dataset.cfold || ad.dataset.cunfold) void setFold(Number(ad.dataset.cfold || ad.dataset.cunfold), !!ad.dataset.cfold);
            else if (ad.hasAttribute('data-ccap')) { capsHidden = !capsHidden; renderAll(); }
            return;
        }
        const t = targetOf(ev);
        if (!t) return;
        const cv = ev.target.closest('[data-cv]');
        if (cv) {
            ev.stopPropagation();
            const r = rec(t.msg, t.block.key);
            const before = r.cur, next = ((r.cur ?? 0) + Number(cv.dataset.cv) + r.versions.length) % r.versions.length;
            r.cur = next;
            void saveChat().catch(e => {
                if (rec(t.msg, t.block.key) === r && r.cur === next) r.cur = before;
                notify('漫画版本保存失败：' + e.message); render(t.id);
            });
            render(t.id); return;
        }
        if (ev.target.closest('[data-cgen]')) { ev.stopPropagation(); doc.querySelectorAll('.pc-comic-page.acts').forEach(n => n.classList.remove('acts')); notify(`开始画第 ${t.block.page} 页，画好会自动换上`); void generateOne(t.id, t.block); return; }
        if (ev.target.closest('[data-cwork]')) { ev.stopPropagation(); doc.querySelectorAll('.pc-comic-page.acts').forEach(n => n.classList.remove('acts')); openWorkbench(t.id, t.block.key); return; }
        // 点一下图：只是显示 / 收起这一页的按钮，不会直接重画（以前双击就重画，滑动时很容易误触）
        if (ev.target.tagName !== 'IMG' && !ev.target.closest('.pc-comic-caps')) return;
        const fig = ev.target.closest('.pc-comic-page');
        if (!fig) return;
        const on = !fig.classList.contains('acts');
        doc.querySelectorAll('.pc-comic-page.acts').forEach(n => n.classList.remove('acts'));
        fig.classList.toggle('acts', on);
    }
    function onDown() { /* 不再用长按，留着给 stop() 解绑 */ }
    function cancelPress(ev) {
        if (!press) return;
        if (ev.type === 'pointermove' && Math.hypot(ev.clientX - press.x, ev.clientY - press.y) < 10) return;
        win.clearTimeout(press.timer); press = null;
    }
    const noMenu = ev => { if (ev.target?.closest?.('.pc-comic')) ev.preventDefault(); };
    doc.addEventListener('click', onClick, true);
    doc.addEventListener('pointerdown', onDown, true);
    for (const e of ['pointerup', 'pointercancel', 'pointermove']) doc.addEventListener(e, cancelPress, true);
    doc.addEventListener('contextmenu', noMenu, true);

    // ── 本页工作台 ──
    function openWorkbench(id, key) {
        const msg = getContext().chat?.[id];
        const block = msg && comicBlocks(srcOf(msg)).find(b => b.key === key);
        if (!block) return;
        const snap = pageSnapshot(id, block);
        if (!snap) return;
        const r = rec(msg, key), v = curVer(r);
        let tab = 'prompt';
        const box = modal(`<div class="pc-comic-work">
          <h3 class="pc-h3">第 ${block.page} / ${block.total} 页</h3>
          <div class="pc-hint" data-w-info>${v ? `第 ${(r.cur ?? 0) + 1} 版 · 种子 ${esc(v.seed ?? '随机')} · ${esc(v.size || '')}${v.style ? ` · 画风「${esc(v.style)}」` : ''}` : '这一页还没出图'}</div>
          <div class="pc-seg pc-mt-s"><button class="on" data-w-tab="prompt">本页提示词</button><button data-w-tab="plan">分镜规划</button><button data-w-tab="sent">实际发送</button></div>
          <textarea class="pc-textarea mono" data-w-text></textarea>
          <textarea class="pc-textarea small" data-w-req placeholder="给 AI 的重写要求（可不填）：比如「这页改成仰视，雨下大一点」"></textarea>
          <div class="pc-actions wrap">
            <button class="pc-btn dark" data-w="redraw">按改好的重画</button>
            <button class="pc-btn" data-w="ai">让 AI 重写本页</button>
            ${v ? '<button class="pc-btn" data-w="dl">下载</button><button class="pc-btn danger" data-w="del">删掉这一版</button>' : ''}
            <button class="pc-btn" data-w="close">关闭</button>
          </div>
          <div class="pc-hint" data-w-msg></div></div>`);
        const closeModal = box.closeModal.bind(box);
        box.closeModal = () => { panels.delete(box.closeModal); closeModal(); };
        panels.add(box.closeModal);
        const text = box.querySelector('[data-w-text]'), say = m => { box.querySelector('[data-w-msg]').textContent = m; };
        let draft = block.inner;
        const show = () => {
            text.readOnly = tab !== 'prompt';
            text.value = tab === 'prompt' ? draft : tab === 'plan' ? (block.plan || '（这一页前面没有 <comic_plan>）') : v ? `【正面】\n${v.sent?.positive || ''}\n\n【负面】\n${v.sent?.negative || ''}\n\n${(v.sent?.chars || []).map((c, i) => `【人物 ${i + 1}】\n${c.prompt}${c.uc ? `\n（不要：${c.uc}）` : ''}`).join('\n\n')}` : '（还没出过图）';
            box.querySelectorAll('[data-w-tab]').forEach(b => b.classList.toggle('on', b.dataset.wTab === tab));
        };
        show();
        text.addEventListener('input', () => { if (tab === 'prompt') draft = text.value; });
        box.addEventListener('click', async ev => {
            const t = ev.target.closest('[data-w-tab],[data-w]');
            if (!t) return;
            if (t.dataset.wTab) { tab = t.dataset.wTab; show(); return; }
            const act = t.dataset.w;
            if (act === 'close') { box.closeModal(); return; }
            if (!snap.current()) { say('聊天或原文已变化，请重新打开这一页'); return; }
            if (act === 'dl' && v) { const a = doc.createElement('a'); a.href = await resolveUrl(v.url); a.download = `漫画_第${block.page}页.png`; doc.body.appendChild(a); a.click(); a.remove(); return; }
            if (act === 'del' && v) {
                const versions = r.versions.filter((_, i) => i !== (r.cur ?? 0));
                if (!versions.length) delete store(msg)[key]; else store(msg)[key] = { ...r, versions, cur: Math.min(r.cur ?? 0, versions.length - 1) };
                try { await saveChat(snap.c); } catch (e) { store(msg)[key] = r; say('保存失败：' + e.message); return; }
                discard(v.url); render(id); box.closeModal(); return;
            }
            if (act === 'redraw') {
                const p = parseComicPage(draft);
                if (!p.ok) { say('格式不对：' + p.reason); return; }
                box.closeModal();
                if (draft.trim() !== block.inner.trim()) await applyNewPage(id, block, { image: draft.trim(), plan: '' }, snap);
                else void generateOne(id, block);
                return;
            }
            if (act === 'ai') {
                t.disabled = true; say('AI 正在重写这一页…');
                try {
                    const { system, user } = rewriteRequest(srcOf(msg), block.page, box.querySelector('[data-w-req]').value);
                    const out = parseRewrite(await askLLM(system, user, { maxTokens: 6000 }));
                    if (!snap.current()) throw new Error('聊天或原文已变化，本次改写未写入');
                    box.closeModal();
                    await applyNewPage(id, block, out, snap);
                } catch (e) { t.disabled = false; say('没改成：' + (e?.message || e)); }
            }
        });
    }
    /** 把新写的一页换进这楼的正文，旧版本跟着搬过去，然后出图 */
    async function applyNewPage(id, block, page, snap = pageSnapshot(id, block)) {
        if (!snap?.current()) return;
        const { c, msg, source } = snap, restore = checkpoint(msg), old = rec(msg, block.key);
        const next = replacePage(source, block.page, page), where = setSrc(msg, next);
        const nb = comicBlocks(next)[block.page - 1];
        if (old && nb && nb.key !== block.key) { store(msg)[nb.key] = old; delete store(msg)[block.key]; }
        try { await saveChat(c); }
        catch (e) { restore(); notify('漫画改写保存失败：' + e.message); return; }
        if (!snap.current(next)) return;
        if (where === 'mes') c.updateMessageBlock?.(id, msg);
        render(id);
        if (nb) await generateOne(id, nb);
    }

    // ── 漫画设置：专门一个面板（漫画书右上角「设置」、智库设置里的「漫画」都能打开） ──
    function openSettings(container) {
        if (stopped) return;
        const M = deps.model;
        let box = null, root;
        if (container) { container.innerHTML = '<div class="pc-comic-set"></div>'; root = container.firstChild; }
        else {
            box = modal('<div class="pc-comic-set"></div>');
            box.parentElement.style.zIndex = '2147480400'; // 盖在漫画书上面
            root = box.querySelector('.pc-comic-set');
            const closeModal = box.closeModal.bind(box);
            box.closeModal = () => { panels.delete(box.closeModal); closeModal(); };
            panels.add(box.closeModal);
        }
        const seg = (key, list, def) => { const cur = String(opts()[key] ?? def); return `<div class="pc-seg ${list.length === 3 ? 'three' : ''}" style="${list.length > 3 ? `grid-template-columns:repeat(${list.length},minmax(0,1fr))` : ''}">${list.map(([v, t]) => `<button class="${cur === String(v) ? 'on' : ''}" data-cs="${key}" data-v="${v}">${t}</button>`).join('')}</div>`; };
        const sw = (key, text, small, def = false) => `<label class="pc-switch"><input type="checkbox" data-cw="${key}" ${(opts()[key] ?? def) ? 'checked' : ''}><span></span>${text}${small ? `<small>${small}</small>` : ''}</label>`;
        const draw = () => {
            const d = getData(), o = opts();
            const groups = Object.values(d.groups || {}).filter(g => g.members?.length).sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh'));
            const st = style_();
            const neg = o.comicNeg ?? COMIC_DEFAULT_NEGATIVE;
            const posBad = comicPositiveConflicts(st.pos), negBad = comicNegativeConflicts([st.neg, neg].join(', '), { monochrome: o.comicColor === 'mono' });
            const tavern = deps.naiMode?.() === 'tavern';
            root.innerHTML = `${box ? '<div class="pc-row-between"><h3 class="pc-h3" style="margin:0">漫画设置</h3><button class="pc-btn small" data-cx>好了</button></div>' : ''}
              ${tavern ? '<div class="pc-banwarn">⚠ 现在用的是酒馆里的 key：画不了漫画（分人物），到 NovelAI 设置里改成自己填 key 或第三方站点。</div>' : ''}
              <div class="pc-label">开关</div>
              ${sw('comicOn', '漫画模式', '认出回复里的 &lt;image&gt;@page…&lt;/image&gt;（漫画台预设）自动画；「画成漫画」不开也能用')}
              ${sw('comicAuto', '回复写完自动出图', '关掉的话，在楼层里点「生成这一页」再画', true)}
              <div class="pc-label">画风</div>
              <select class="pc-input" data-cstyle><option value="">跟正文画师串一样${d.active ? `（现在是「${esc(M.ticketName(d, d.active))}」）` : '（还没选）'}</option>
                ${groups.map(g => `<option value="group:${esc(g.id)}" ${o.comicStyle === 'group:' + g.id ? 'selected' : ''}>${esc(g.name)}</option>`).join('')}</select>
              <div class="pc-hint">漫画单独用一个画师串，不影响聊天插图。${posBad.length ? `<br><b>⚠ 这串里有人数词：${posBad.map(esc).join('、')}</b>，人数应该由每页自己写，建议去掉。` : ''}</div>
              <div class="pc-label">颜色</div>
              ${seg('comicColor', [['color', '彩色'], ['mono', '黑白网点']], 'color')}
              <div class="pc-label">对白怎么出现</div>
              ${seg('comicText', [['overlay', '插件叠字'], ['draw', 'NAI 画进图'], ['none', '不要对白']], 'overlay')}
              <div class="pc-hint">NAI 画中文常常乱码，「插件叠字」让 NAI 只画画面，对白由浏览器显示，位置按每格开头的位置描述或 2x2 布局估算，未标位置时按顺序排列，字号跟着图片宽度缩放；下载的仍是未叠字原图。</div>
              <div class="pc-label">叠字大小</div>
              ${seg('comicCapSize', [['xs', '特小'], ['s', '小'], ['m', '中'], ['l', '大'], ['hide', '不显示']], 's')}
              <div class="pc-hint">挡图的话调小，或者在楼层里点「隐藏对白」临时收起。想少点对白，在下面「给 AI 的改编要求」里写「对白少一点」。</div>
              <div class="pc-label">页面尺寸（跨页自动横过来）</div>
              ${seg('comicSize', [['832x1216', '竖'], ['1216x832', '横'], ['1024x1024', '方']], '832x1216')}
              <div class="pc-label">「画成漫画」每楼画几页</div>
              ${seg('comicPages', [[0, '自动'], [2, '2'], [3, '3'], [4, '4'], [6, '6'], [8, '8']], 0)}
              <div class="pc-label">每页几格</div>
              ${seg('comicPanels', [['', '自动'], ['1–2', '1–2'], ['3–4', '3–4'], ['5–6', '5–6']], '')}
              <div class="pc-hint">「自动」时 AI 按剧情长短分：短的 1–2 页，长的 5–8 页。页数多、每页格数少，剧情切得越细。</div>
              <label class="pc-field pc-mt-s"><span>给 AI 的改编要求（可不填）</span><textarea class="pc-textarea small" data-cstr="comicExtra" placeholder="比如：多用特写和留白；对白少一点；每页最多 3 格；不要画 user 的脸">${esc(o.comicExtra || '')}</textarea></label>
              <label class="pc-field pc-mt-s"><span>漫画负面（加在画风负面后面）</span><textarea class="pc-textarea small mono" data-cstr="comicNeg">${esc(neg)}</textarea></label>
              <div class="pc-actions wrap" style="margin-top:6px"><button class="pc-pill dashed tiny" data-cnegreset>恢复默认负面</button></div>
              ${sw('comicStripNeg', '自动去掉负面里会压掉分格、留白、网点的词', negBad.length ? `现在负面里有：${negBad.map(esc).join('、')}` : '', true)}
              <div class="pc-hint">改了以后对新画的页生效；已经画好的页点一下图 →「重画这一页」。</div>`;
        };
        root.addEventListener('click', ev => {
            const b = ev.target.closest('[data-cs]');
            if (b) { const v = b.dataset.v; opts()[b.dataset.cs] = /^\d+$/.test(v) && b.dataset.cs === 'comicPages' ? Number(v) : v; commit(); draw(); if (b.dataset.cs === 'comicCapSize') renderAll(); return; }
            if (ev.target.closest('[data-cnegreset]')) { delete opts().comicNeg; commit(); draw(); return; }
            if (ev.target.closest('[data-cx]')) { box?.closeModal(); renderAll(); }
        });
        root.addEventListener('change', ev => {
            const t = ev.target;
            if (t.dataset.cw) { opts()[t.dataset.cw] = t.checked; commit(); draw(); renderAll(); }
            else if (t.matches('[data-cstyle]')) { opts().comicStyle = t.value; commit(); draw(); }
        });
        root.addEventListener('input', ev => { const t = ev.target; if (t.dataset.cstr) { opts()[t.dataset.cstr] = t.value; commit(); } });
        draw();
        return box;
    }

    // ── 把一楼画成漫画：AI 读正文写分镜，存进这楼，再一页页出图 ──
    async function adapt(id, { pages = 0, redo = false } = {}) {
        const snap = pageSnapshot(id);
        if (!snap) return;
        const { c, msg, source } = snap;
        if (msg.is_system) return;
        if (msg.is_user) { notify('只能把角色的回复画成漫画'); return; }
        if (comicBlocks(msg.mes).length || (source && !redo)) { await process(id, { manual: true }); return; }
        if (isAdapting(id)) return;
        const story = storyText(msg.mes);
        if (!story) { notify('这一楼没有正文'); return; }
        failed.delete(id);
        const task = { text: 'AI 正在把这一楼改编成漫画分镜…（用的是智库设置里的 AI）', current: snap.current };
        adapting.set(id, task); render(id);
        try {
            const prevMsg = (c.chat || []).slice(0, id).reverse().find(m => m && !m.is_system && m.extra?.zhikuComicSrc);
            const before = prevMsg ? comicBlocks(srcOf(prevMsg)).slice(-1).map(b => b.inner).join('') : '';
            const { system, user } = adaptRequest(story.slice(0, 12000), { pages: pages || Number(opts().comicPages) || 0, panels: opts().comicPanels || '', cast: deps.castText?.() || '', before, color: opts().comicColor === 'mono' ? 'mono' : 'color', extra: opts().comicExtra || '' });
            const want = pages || Number(opts().comicPages) || 6;
            const out = parseAdapt(await askLLM(system, user, { maxTokens: Math.min(16000, 3000 + 1800 * want) }));
            if (!snap.current()) return;
            const restore = checkpoint(msg), removed = [];
            setSrc(msg, out);
            const retained = new Set(Object.values(msg.extra.zhikuComicSrc).flatMap(text => comicBlocks(text).map(b => b.key)));
            for (const b of comicBlocks(source)) if (!retained.has(b.key)) {
                removed.push(...(rec(msg, b.key)?.versions || []));
                delete store(msg)[b.key];
            }
            try { await saveChat(c); } catch (e) { restore(); throw e; }
            removed.forEach(v => discard(v.url));
            if (!snap.current(out)) return;
        } catch (e) {
            const why = String(e?.message || e) + (e?.diag && !String(e.message).includes(e.diag) ? `（${e.diag}）` : '');
            if (!snap.current()) return;
            failed.set(id, { why, current: snap.current });
            (deps.notifyError || notify)('第 ' + id + ' 楼没画成漫画：' + why);
            return;
        } finally { if (adapting.get(id) === task) adapting.delete(id); render(id); }
        await process(id, { manual: true });
    }
    let capsHidden = false; // 这次打开酒馆里先不看对白
    async function setFold(id, on) {
        const snap = pageSnapshot(id);
        if (!snap) return;
        const { msg } = snap, key = swipeKey(msg);
        const previous = msg.extra?.zhikuComicFold?.[key];
        const folds = ((msg.extra ||= {}).zhikuComicFold ||= {});
        if (on) folds[key] = true; else delete folds[key];
        try { await saveChat(snap.c); }
        catch (e) {
            if (previous === undefined) delete folds[key]; else folds[key] = previous;
            (deps.notifyError || notify)('收起状态保存失败：' + (e?.message || e));
        }
        if (snap.current()) render(id);
    }
    async function unadapt(id) {
        if (failed.delete(id)) { render(id); return; }
        const snap = pageSnapshot(id);
        if (!snap || isAdapting(id)) return;
        const { c, msg, source } = snap;
        if (!msg.extra?.zhikuComicSrc?.[swipeKey(msg)]) return;
        const restore = checkpoint(msg), removed = [];
        delete msg.extra.zhikuComicSrc[swipeKey(msg)];
        if (msg.extra.zhikuComicFold) delete msg.extra.zhikuComicFold[swipeKey(msg)];
        const retained = new Set(Object.values(msg.extra.zhikuComicSrc).flatMap(text => comicBlocks(text).map(b => b.key)));
        for (const b of comicBlocks(source)) if (!retained.has(b.key)) {
            removed.push(...(rec(msg, b.key)?.versions || []));
            delete store(msg)[b.key];
        }
        try { await saveChat(c); }
        catch (e) { restore(); notify('漫画保存失败：' + e.message); render(id); return; }
        removed.forEach(v => discard(v.url)); render(id);
    }

    // ── 漫画书：翻书（摊开两页）/ 卡片堆 / 上下滑 ──
    async function openBook() {
        if (stopped) return;
        const chat = getContext().chat || [];
        const pages = [];
        chat.forEach((msg, id) => {
            if (!msg || msg.is_user) return;
            for (const b of comicBlocks(srcOf(msg))) { const v = curVer(rec(msg, b.key)); if (v) pages.push({ id, captionSource: captionSource(v, b.inner), page: b.page, total: b.total, url: v.url, name: msg.name || '', caps: v.textMode === 'overlay' ? captionsHtml(captionSource(v, b.inner), esc, opts().comicCapSize || 's') : '' }); }
        });
        const urls = new Map();
        const url = async p => { if (!urls.has(p.url)) urls.set(p.url, await resolveUrl(p.url)); return urls.get(p.url); };
        const art = p => `<div class="pc-cb-art"><img data-cb="${esc(p.url)}" alt="第 ${p.id} 楼第 ${p.page} 页" draggable="false">${p.caps || ''}<span>${p.id} 楼 · ${p.page}/${p.total}</span></div>`;
        const fill = root => { for (const img of root.querySelectorAll('img[data-cb]:not([src])')) { const p = pages.find(x => x.url === img.dataset.cb); if (p) url(p).then(u => { if (u) img.src = u; }); } };

        const book = doc.createElement('div');
        book.className = 'pc-comic-book';
        book.setAttribute('role', 'dialog');
        let mode = 'book', at = Math.max(0, pages.length - 1); // at = 第几页（从 0 数）
        try {
            const saved = JSON.parse(win.localStorage.getItem('zhiku_comic_pos') || 'null');
            if (['book', 'flow', 'scroll'].includes(saved?.mode)) mode = saved.mode;
            if (saved?.chat === chatKey(getContext()) && Number.isInteger(saved.at)) at = Math.min(pages.length - 1, Math.max(0, saved.at));
        } catch { /* 没存过 */ }
        book.innerHTML = `<header><b></b><small></small><button class="bb" data-b="set">设置</button><button class="bb" data-b="toc">目录</button><button class="bb" data-b="x" aria-label="关闭">✕</button>
            <div class="seg">${[['book', '翻书'], ['flow', '卡片堆'], ['scroll', '上下滑']].map(([m, t]) => `<button data-mode="${m}">${t}</button>`).join('')}</div></header>
          <div class="pc-comic-stage"></div><div class="tip"></div>
          <footer><button class="bb" data-b="-1" aria-label="上一页">‹</button><input type="range" min="1" value="1" aria-label="翻到"><button class="bb" data-b="1" aria-label="下一页">›</button></footer>`;
        const stage = book.querySelector('.pc-comic-stage'), bar = book.querySelector('footer input');
        const leafCount = () => Math.ceil(pages.length / 2);
        let turned = 0, leaves = [], cards = [];
        const save = () => { try { win.localStorage.setItem('zhiku_comic_pos', JSON.stringify({ chat: chatKey(getContext()), at, mode })); } catch { /* 存不了也能看 */ } };
        const info = () => {
            const p = pages[at];
            book.querySelector('header b').textContent = p ? `第 ${p.id} 楼 · ${p.name}` : '漫画';
            const spread = mode === 'book' && turned > 0 && turned * 2 < pages.length ? `${turned * 2}–${turned * 2 + 1}` : String(at + 1);
            book.querySelector('header small').textContent = p ? `本楼 ${p.page}/${p.total} · 全部 ${spread}/${pages.length}` : '';
            bar.max = mode === 'book' ? leafCount() + 1 : pages.length;
            bar.value = (mode === 'book' ? turned : at) + 1;
            save();
        };
        // 翻书：第 j 张纸正面是第 2j 页（在右边），背面是第 2j+1 页（翻过去在左边）
        function buildBook() {
            stage.innerHTML = '<div class="pc-cb-spread"><div class="pc-cb-lbase"><div class="pc-cb-blank">扉 页</div></div><div class="pc-cb-rbase"></div><div class="pc-cb-gutter"></div></div>';
            const sp = stage.firstChild;
            leaves = [];
            for (let j = 0; j < leafCount(); j++) {
                const f = pages[2 * j], b = pages[2 * j + 1];
                const l = doc.createElement('div');
                l.className = 'pc-cb-leaf';
                l.innerHTML = `<div class="f">${art(f)}<div class="shade"></div></div><div class="b">${b ? art(b) : '<div class="pc-cb-blank">完</div>'}</div>`;
                sp.appendChild(l); leaves.push(l);
            }
            turned = Math.ceil(at / 2);
            layoutBook(); fill(stage);
            book.querySelector('.tip').textContent = '往左拖翻下一页 · 往右拖翻回去 · 点左右两边也能翻';
        }
        function layoutBook(drag) {
            const n = leaves.length;
            leaves.forEach((l, k) => {
                const done = k < turned;
                let a = done ? -180 : 0;
                if (drag && k === drag.k) a = drag.a;
                l.style.transform = `rotateY(${a}deg)`;
                l.style.zIndex = drag && k === drag.k ? 500 : done ? k + 1 : n - k + 1;
                l.style.visibility = (done && k < turned - 1 || !done && k > turned + 1) && !(drag && k === drag.k) ? 'hidden' : 'visible';
                l.querySelector('.shade').style.opacity = String(Math.min(1, Math.abs(a) / 90) * 0.8);
            });
            at = turned === 0 ? 0 : Math.min(pages.length - 1, turned * 2 - 1);
            info();
        }
        // 卡片堆：一排斜着排，中间那张正对着
        function buildFlow() {
            stage.innerHTML = '<div class="pc-cb-flow"></div>';
            cards = pages.map((p, k) => { const c = doc.createElement('div'); c.className = 'pc-cb-card'; c.dataset.k = k; c.innerHTML = art(p); stage.firstChild.appendChild(c); return c; });
            layoutFlow(); fill(stage);
            book.querySelector('.tip').textContent = '左右滑动挑一页 · 点中间那张打开看';
        }
        function layoutFlow(off = 0) {
            cards.forEach((c, k) => {
                const d = k - at + off, ad = Math.abs(d);
                const x = d === 0 ? 0 : Math.sign(d) * (30 + (ad - 1) * 9), ry = d === 0 ? 0 : -Math.sign(d) * Math.min(55, 30 + ad * 8);
                c.style.transform = `translate(-50%,-50%) translateX(${x}vw) translateZ(${-ad * 90}px) rotateY(${ry}deg) scale(${d === 0 ? 1 : 0.82})`;
                c.style.zIndex = String(100 - Math.round(ad * 10));
                c.style.filter = `brightness(${1 - Math.min(0.55, ad * 0.18)})`;
                c.style.visibility = ad > 6 ? 'hidden' : 'visible';
            });
            info();
        }
        // 上下滑：一页一页竖着刷，楼层之间有分隔
        function buildScroll() {
            let last = null;
            stage.innerHTML = '<div class="pc-cb-scroll">' + pages.map((p, k) => { const head = p.id !== last ? `<div class="pc-cb-vfloor">第 ${p.id} 楼</div>` : ''; last = p.id; return head + `<div class="pc-cb-vpage" data-k="${k}"><div class="holder">${art(p)}</div></div>`; }).join('') + '</div>';
            const scr = stage.firstChild;
            scr.querySelector(`[data-k="${at}"]`)?.scrollIntoView({ block: 'center' });
            scr.addEventListener('scroll', () => {
                const mid = scr.getBoundingClientRect().top + scr.clientHeight / 2;
                let best = at, bd = 1e9;
                scr.querySelectorAll('.pc-cb-vpage').forEach(v => { const r = v.getBoundingClientRect(), dd = Math.abs(r.top + r.height / 2 - mid); if (dd < bd) { bd = dd; best = Number(v.dataset.k); } });
                if (best !== at) { at = best; info(); }
            }, { passive: true });
            fill(stage); info();
            book.querySelector('.tip').textContent = '上下滑动一页一页往下看';
        }
        function build() {
            book.querySelectorAll('[data-mode]').forEach(b => b.classList.toggle('on', b.dataset.mode === mode));
            if (!pages.length) { stage.innerHTML = '<div class="empty">这个聊天里还没有漫画页<br>点右上角「目录」，挑一楼点「画成漫画」；<br>也可以点楼层按钮里的 📖。<br><button class="bb wide" data-b="toc">打开目录选一楼</button></div>'; book.querySelector('footer').hidden = true; info(); return; }
            mode === 'book' ? buildBook() : mode === 'scroll' ? buildScroll() : buildFlow();
        }
        function go(n) {
            if (!pages.length) return;
            if (mode === 'book') { turned = Math.max(0, Math.min(leafCount(), turned + n)); layoutBook(); return; }
            at = Math.max(0, Math.min(pages.length - 1, at + n));
            if (mode === 'flow') layoutFlow(); else { stage.querySelector(`[data-k="${at}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }); info(); }
        }
        const refresh = () => {
            for (const p of pages) p.caps = p.captionSource ? captionsHtml(p.captionSource, esc, opts().comicCapSize || 's') : '';
            build();
        };
        readers.add(refresh);
        const close = () => { readers.delete(refresh); book.remove(); doc.removeEventListener('keydown', key); panels.delete(close); };
        panels.add(close);
        const toc = () => {
            const first = new Map(); pages.forEach((p, n) => { if (!first.has(p.id)) first.set(p.id, { ...p, n }); });
            const chatNow = getContext().chat || [];
            const rows = [];
            chatNow.forEach((m, id) => {
                if (!m || m.is_user || m.is_system) return;
                const f = first.get(id);
                if (f) { rows.push(`<button data-goto="${f.n}"><img data-cb="${esc(f.url)}" alt=""><span>第 ${id} 楼 · ${esc(f.name)}<small>${f.total} 页 · 点一下翻到这里</small></span></button>`); return; }
                const text = storyText(m.mes);
                if (!text) return;
                const busy = isAdapting(id);
                rows.push(`<button data-adapt="${id}" class="todo"><i>${busy ? '…' : '＋'}</i><span>第 ${id} 楼 · ${esc(m.name || '')}<small>${busy ? '正在改编…' : esc(text.replace(/\s+/g, ' ').slice(0, 36)) + (text.length > 36 ? '…' : '')}</small></span><em>${busy ? '' : '画成漫画'}</em></button>`);
            });
            const sheet = doc.createElement('div');
            sheet.className = 'pc-comic-toc';
            sheet.innerHTML = `<h4>目录</h4><p class="pc-comic-toc-tip">已经画了的点一下翻过去；没画的点「画成漫画」，AI 会读那一楼的正文改编成漫画，画好就出现在这本书里。</p>${rows.join('') || '<p class="pc-comic-toc-tip">这个聊天里还没有角色的回复</p>'}`;
            book.appendChild(sheet); fill(sheet);
            sheet.querySelector('button:last-of-type')?.scrollIntoView({ block: 'end' });
        };
        // 手势
        let sx = null, moved = false, drag = null;
        stage.addEventListener('pointerdown', ev => { if (mode === 'scroll' || !pages.length) return; sx = ev.clientX; moved = false; drag = null; });
        stage.addEventListener('pointermove', ev => {
            if (sx == null) return;
            const dx = ev.clientX - sx;
            if (Math.abs(dx) > 6) moved = true;
            if (!moved) return;
            if (mode === 'book') {
                const w = stage.querySelector('.pc-cb-spread').offsetWidth / 2;
                drag = dx < 0 && turned < leaves.length ? { k: turned, a: Math.max(-180, dx / w * 180) } : dx > 0 && turned > 0 ? { k: turned - 1, a: Math.min(0, -180 + dx / w * 180) } : null;
                leaves.forEach(l => l.classList.add('drag')); layoutBook(drag);
            } else { cards.forEach(c => c.classList.add('drag')); layoutFlow(-dx / (win.innerWidth * 0.3)); }
        });
        const up = ev => {
            if (sx == null) return;
            const dx = ev.clientX - sx; sx = null;
            leaves.forEach(l => l.classList.remove('drag')); cards.forEach(c => c.classList.remove('drag'));
            if (mode === 'book') {
                if (!moved) { const r = stage.getBoundingClientRect(); go(ev.clientX < r.left + r.width / 2 ? -1 : 1); return; }
                if (drag && drag.k === turned && drag.a < -60) turned++;
                else if (drag && drag.k === turned - 1 && drag.a > -120) turned--;
                layoutBook();
            } else if (moved) {
                go(Math.round(-dx / (win.innerWidth * 0.3)) || (dx < -30 ? 1 : dx > 30 ? -1 : 0));
            } else {
                const c = ev.target.closest('.pc-cb-card');
                if (!c) return;
                const k = Number(c.dataset.k);
                if (k === at) { mode = 'book'; build(); } else { at = k; layoutFlow(); }
            }
        };
        stage.addEventListener('pointerup', up);
        stage.addEventListener('pointercancel', () => { sx = null; if (mode === 'book') layoutBook(); else if (mode === 'flow') layoutFlow(); });
        book.addEventListener('click', ev => {
            const ad = ev.target.closest('[data-adapt]');
            if (ad) {
                const id = Number(ad.dataset.adapt);
                if (isAdapting(id)) return;
                close();
                doc.querySelector(`.mes[mesid="${id}"]`)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
                void adapt(id);
                return;
            }
            const g = ev.target.closest('[data-goto]');
            if (g) { at = Number(g.dataset.goto); g.closest('.pc-comic-toc').remove(); build(); return; }
            if (ev.target.closest('.pc-comic-toc')) return;
            book.querySelector('.pc-comic-toc')?.remove();
            const m = ev.target.closest('[data-mode]');
            if (m) { mode = m.dataset.mode; build(); return; }
            const b = ev.target.closest('[data-b]')?.dataset.b;
            if (b === 'x') close(); else if (b === 'toc') toc(); else if (b === 'set') openSettings(); else if (b) go(Number(b));
        });
        bar.addEventListener('input', () => {
            const v = Number(bar.value) - 1;
            if (mode === 'book') { turned = v; layoutBook(); } else { at = v; mode === 'flow' ? layoutFlow() : (stage.querySelector(`[data-k="${at}"]`)?.scrollIntoView({ block: 'center' }), info()); }
        });
        const key = ev => { if (ev.key === 'ArrowRight' || ev.key === 'ArrowDown') go(1); else if (ev.key === 'ArrowLeft' || ev.key === 'ArrowUp') go(-1); else if (ev.key === 'Escape') close(); };
        doc.addEventListener('keydown', key);
        (doc.documentElement || doc.body).appendChild(book);
        build();
    }

    return {
        process, render, renderAll, openBook, generateOne, adapt, unadapt, openSettings,
        stop() {
            stopped = true;
            cancelPress({type:'stop'});
            for (const close of [...panels]) close();
            doc.removeEventListener('click', onClick, true);
            doc.removeEventListener('pointerdown', onDown, true);
            for (const e of ['pointerup', 'pointercancel', 'pointermove']) doc.removeEventListener(e, cancelPress, true);
            doc.removeEventListener('contextmenu', noMenu, true);
            doc.querySelectorAll('.pc-comic, .pc-comic-book').forEach(n => n.remove());
            style.remove();
        },
    };
}


// The entire editable instruction lives here; request assembly adds data, not hidden rules.
const DEFAULT_ILLUSTRATION_PROMPT = `你负责根据小说正文选择插图瞬间，并整理画面信息。

【图片数量】
遵循输入 imageLimit（玩家设置的最多张数），不自行固定张数。
每张图描绘一个独立瞬间，不把连续发生的动作塞进同一张图。

【正文范围】
存在 <content>...</content> 时，只从其中选择剧情画面。
忽略思考、状态栏、角色名单和正文之外的附加信息。
没有 content 标签时，使用提供的普通正文。

【画面选择】
优先选择体现角色情绪、人物互动或关键行动的瞬间。
明确这一刻：谁入画、在哪里、正在做什么、有什么表情。
角色被提及、被回忆、出现在名单中，不代表实际入画。
不要为了凑人数，把候选角色全部加入画面。

【人物与外貌】
候选角色资料用于识别名字、别名和固定外貌。
已登记的入画角色使用对应身份；未登记的人物按正文描述。
固定外貌沿用角色资料，动作、情绪和剧情服装以当前瞬间为准。
正文没有交代的信息不要当作已知事实。

【内容分级】
对应原文含成人性内容或私密部位裸露时，标记 nsfw，不得漏标，也不得标成 sfw。
分级与画面描述分开处理；画面标签完整描述非露骨的可见信息。
不能仅因角色性别、亲密关系或普通拥抱，就判定为 nsfw。

【画面标签：SFW 和 NSFW 均适用】
依据选定瞬间，完整描述剧情明确出现、且在当前镜头中可见的内容。
不要遗漏关键动作、情绪、物品及人物互动。
不要把先后发生的动作合并，也不要添加镜头外的人物和细节。
每个入画人物分别填写：身体姿势、朝向和重心；肢体动作、双手位置和物品；表情、视线和头部朝向；衣着状态；画面位置和前后层次。
多人画面还需填写：相对位置（面对面、并肩、一前一后等）、距离、朝向、遮挡、谁对谁做什么、主次关系。
整体构图填写：景别（特写到远景）、机位（平视、俯视、仰视、正侧背面）、主体位置、视觉重点、留白、前后层次、地点、关键物品、时间、光线和氛围。
剧情未指定的镜头与构图，可以选择适合表现该瞬间的方案；人物、事件和关键动作必须有正文依据。
标签使用英文，逗号分隔；场景与各角色标签分别输出。不添加画师串和质量词。
每个标签都写成 danbooru 风格的短标签（1 到 4 个词），不要写成整句或长短语：写 hand over mouth、covering mouth、hug from behind、tail around waist、whispering，不写 mouth and nose covered by boy's large hand、whispering near her ear 这类句子。

【输出格式】
mode=after：只输出 JSON：{"images":[画面对象]}，不输出分析过程。
mode=inline：其余正文照常写；逐图完成同样的选镜头、分级和人物分析，再在对应段落后，用输入 markers.start 和 markers.end 包住英文标签，不输出 JSON。格式为 Scene Composition: 分级、人数、场景、构图、互动标签; Character 1 Prompt: $角色名字-sfw-upperbody$, 该人物的姿势、动作、表情、视线、衣着、站位标签|centers:0.3,0.5; Character 2 Prompt: ...。登记角色用候选名字，未登记角色直接写英文外貌标签，不用角色标记；空镜仅有 Scene Composition。不得把人物标签合并到场景段。nsfw 画面必须以 Scene Composition: nsfw, 开头。sfw 也同样写完整姿势和构图。
每个画面对象必须包含：
source：从本次正文原样摘录的定位句（不少于 4 个字符）。
title：简短图片标题。
moment：一句话概括这个瞬间，不写分析过程。
rating：sfw 或 nsfw。
scene：英文环境、地点和关键物品标签。
composition：对象，包含 shot（景别）、camera（机位）、layout（布局和焦点）、lighting（光线），各字段为英文标签。
interaction：英文人物相对位置、距离、遮挡和互动关系标签；空镜可为空。
characters：实际入画人物数组，空镜用 []。每人包含：
name（名字）、registered（是否调用候选角色，布尔值）、gender（girl/boy/other）、appearance（未登记角色的英文外貌标签，登记角色可为空）、pose（姿势）、action（动作）、expression（表情）、gaze（视线）、outfit（此刻衣服）、position（对象：x、y 为 0 到 1 的画面坐标，depth 为 foreground/midground/background）、tags（其他英文细节，可为空）。
只有 name、source、title、moment 可以用中文，其余画面标签用英文。
characters 只列实际可见的人；人数标签由插件根据名单生成，scene 和各人物标签不另写人数。`;

function illustrationPrompt(options = {}) {
    return typeof options.illustPrompt === 'string' && options.illustPrompt.trim() ? options.illustPrompt : DEFAULT_ILLUSTRATION_PROMPT;
}

function saveIllustrationPrompt(options, value) {
    if (typeof value !== 'string' || !value.trim()) throw new Error('提示词不能为空；需要默认内容时点「恢复默认」');
    options.illustPrompt = value; // Preserve the player's literal text, including whitespace.
}

function illustrationCount(value = 1) {
    const count=Number(value);
    if (!Number.isSafeInteger(count) || count < 1) throw new Error('图片张数请填写大于 0 的整数');
    return count;
}

function illustrationRequest({ options, mode, roster, markers, story = '', selectedPassage, prompt }) {
    const candidates = roster.filter(row => row.on).map(({ char }) => ({
        name: char.name, aliases: char.aliases || '',
        appearance: (char.appearance || []).map(t => t.en).filter(Boolean).join(', '),
        outfitMode: char.outfitMode,
        outfit: char.outfitMode === 'fixed' ? ((char.outfits || []).find(o => o.id === char.outfitId) || char.outfits?.[0])?.tags?.map(t => t.en).filter(Boolean).join(', ') || '' : '',
    }));
    const data = { mode, imageLimit: selectedPassage ? 1 : illustrationCount(options.illustMax ?? 1), markers, candidates, ...(mode === 'after' ? { story, ...(selectedPassage ? { selectedPassage } : {}) } : {}) };
    const system = prompt ?? illustrationPrompt(options);
    const user = JSON.stringify(data, null, 2);
    return { mode, system, user, injection: system + '\n\n【本次输入】\n' + user };
}

function readIllustrationPlan(prompt) {
    const text = String(prompt || '').trim();
    if (!text.startsWith('{') || !/"(?:characters|composition|rating|moment)"\s*:/.test(text)) return null;
    try { return JSON.parse(text); } catch { throw new Error('画面方案 JSON 不完整，请编辑本图提示词后重试'); }
}

function compileIllustrationPlan(plan, roster, story) {
    const required = key => {
        if (typeof plan?.[key] !== 'string' || !plan[key].trim()) throw new Error(`画面方案缺少 ${key}`);
        return plan[key].trim();
    };
    const source = required('source'), title = required('title'), moment = required('moment');
    if (source.length < 4 || (typeof story === 'string' && !story.includes(source))) throw new Error('画面定位句不在正文中，请重新选择瞬间');
    const rating = required('rating').toLowerCase();
    if (!['sfw', 'nsfw'].includes(rating)) throw new Error('画面分级必须是 sfw 或 nsfw');
    if (!Array.isArray(plan.characters)) throw new Error('画面方案缺少入画人物数组 characters');
    const clean = value => {
        if (value == null) return '';
        if (typeof value !== 'string' || /[㐀-鿿豈-﫿$<>\n]/.test(value)) throw new Error('画面标签需要英文，人物名字请放在 name 字段');
        // Count and rating are compiled once, from structured fields.
        return value.split(/[,;]+/).map(s => s.trim()).filter(s => s && !/^(?:\d+(?:boys?|girls?|others?)|solo|no humans|sfw|nsfw)$/i.test(s)).join(', ');
    };
    const composition = plan.composition;
    if (!composition || typeof composition !== 'object') throw new Error('画面方案缺少镜头构图 composition');
    for (const field of ['shot', 'camera', 'layout', 'lighting']) if (!clean(composition[field])) throw new Error(`镜头构图缺少 ${field}`);
    const picks = [], cast = [], seen = new Set(), counts = {girl:0,boy:0,other:0};
    for (let person of plan.characters) {
        if (!person || typeof person.name !== 'string' || !person.name.trim() || /[$\n]/.test(person.name)) throw new Error('入画人物需要有效名字');
        // registered 只是模型的判断：在角色页找得到才算登记；找不到、没开、没写外貌都照样画
        let char = person.registered === false ? null : resolveImageCharacters('$' + person.name + '-sfw-upperbody$', roster).picks[0]?.char;
        if (char && !char.unregistered) cast.push(char);
        else { char = { name: person.name, appearance: [], outfits: [], outfitMode: 'story', negative: '', unregistered: true }; person = { ...person, registered: false }; }
        const identity = char.key || person.name.normalize('NFKC').replace(/\s+/g, '').toLowerCase();
        if (seen.has(identity)) throw new Error('同一人物在画面名单中出现两次，请合并动作');
        seen.add(identity);
        const registeredGender = (char.appearance || []).map(t => t.en?.trim().toLowerCase()).find(t => /^1(?:girl|boy|other)$/.test(t));
        let gender = registeredGender?.slice(1) || String(person.gender || '').toLowerCase().replace(/s$/, '');
        if (!Object.hasOwn(counts, gender)) gender = 'other';
        counts[gender]++;
        // 站位缺了或写错就用默认的，不为这个卡住出图
        const raw = person.position || {}, ok = n => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1;
        const pos = { x: ok(raw.x) ? raw.x : (picks.length + 1) / (plan.characters.length + 1), y: ok(raw.y) ? raw.y : 0.5, depth: ['foreground','midground','background'].includes(raw.depth) ? raw.depth : '' };
        const tags = [person.registered ? '' : person.appearance, person.pose, person.action, person.expression, person.gaze,
            char.outfitMode === 'fixed' ? '' : person.outfit, pos.x<0.4?'on left':pos.x>0.6?'on right':'centered', pos.depth, person.tags].map(clean).filter(Boolean).join(', ');
        picks.push({ char, tags, x:pos.x, y:pos.y });
    }
    const count = picks.length ? Object.entries(counts).filter(([,n])=>n).map(([g,n])=>`${n}${g}${n>1?'s':''}`).join(', ') : 'no humans';
    const scene = [rating, count, clean(required('scene')), ...['shot','camera','layout','lighting'].map(k=>clean(composition[k])), clean(plan.interaction)].filter(Boolean).join(', ');
    return { scene, picks, cast, summary:{source,title,moment,rating} };
}

function illustrationMarkerText(compiled) {
    const parts = ['Scene Composition: ' + compiled.scene];
    compiled.picks.forEach((p, i) => {
        const role = compiled.cast.includes(p.char) ? '$' + p.char.name + '-sfw-upperbody$' : '';
        parts.push(`Character ${i + 1} Prompt: ${[role,p.tags].filter(Boolean).join(', ')}|centers:${p.x},${p.y}`);
    });
    return parts.join('; ');
}

function applyIllustrationRating(positive, rating) {
    if (!['sfw','nsfw'].includes(rating)) return positive;
    const rest=String(positive || '').split(',').map(t=>t.trim()).filter(t=>t&&!/^(?:sfw|nsfw)$/i.test(t));
    return [rating,...rest].join(', ');
}


function createIllustrationPlanner({ getContext, getData, settings, roster, askLLM, pickJson, warn, onRequest = () => {}, afterSave = () => {} }) {
    let stopped = false;
    const seen = new WeakMap();
    const selectedBusy = new WeakSet();
    const chatKey=c=>String(c.getCurrentChatId?.() ?? c.chatId ?? '')+'|'+String(c.characterId??'')+'|'+String(c.groupId??'');
    function request(mode, story = '', selectedPassage) {
        const cfg = settings();
        const options=getData().options;
        return illustrationRequest({options, mode, roster:roster(), markers:{start:cfg.start,end:cfg.end}, story, selectedPassage});
    }
    function sync(type) {
        const c = getContext(), cfg = settings();
        if (typeof c.setExtensionPrompt !== 'function') return;
        const enabled = !stopped && type !== 'quiet' && getData().options.illustMode === 'inline' && cfg.start && cfg.end;
        const req = enabled ? request('inline') : null;
        c.setExtensionPrompt('zhiku_illust', req?.injection || '', 1, 0, false, 0);
        if (req) onRequest(req);
    }
    async function after(id, selection = null) {
        const c = getContext(), cfg = settings(), msg = c.chat?.[id];
        const manual=!!selection;
        if (stopped || !cfg.start || !cfg.end || !msg || msg.is_system || (!manual && (getData().options.illustMode !== 'after' || msg.is_user || id !== c.chat.length - 1))) return;
        const source = String(msg.mes || '');
        if (manual && (msg!==selection.msg || source!==selection.source || msg.swipe_id!==selection.swipe || chatKey(c)!==selection.chatKey)) throw new Error('聊天或原文已变化，请重新选择文字');
        if (!source.trim() || (!manual && parseImageMarkers(source,cfg.start,cfg.end).length)) return;
        const story = manual?selectedImageStory(source,cfg):imageStoryText(source);
        if (!story) return;
        const req = request('after', story,selection?.text), signature = String(msg.swipe_id) + source + req.system + req.user;
        if (!manual && seen.get(msg) === signature) return;
        if(!manual)seen.set(msg,signature);
        const forget=()=>{if(seen.get(msg)===signature)seen.delete(msg);};
        const chatId = chatKey(c), swipe = msg.swipe_id;
        const current = () => { const now=getContext();return !stopped && chatKey(now) === chatId && now.chat?.[id] === msg && msg.swipe_id === swipe && String(msg.mes || '') === source; };
        const max = JSON.parse(req.user).imageLimit;
        onRequest(req);
        let response;
        try { response = pickJson(await askLLM(req.system, req.user, {maxTokens:Math.min(16384,1200+1600*max)})); }
        catch(e) { if (current()) warn('自动插图没写出来：'+e.message);forget();return; }
        if (!current()) { if(manual)warn('原文或聊天已变化，选段结果没有写入');return; }
        const items = Array.isArray(response?.images) ? response.images : [];
        const selected = [];
        for (const item of items) {
            if (selected.length >= max) break;
            try {
                let tags, anchor, plan;
                if (Array.isArray(item?.characters)) {
                    const compiled = compileIllustrationPlan(item,roster(),story);
                    tags=illustrationMarkerText(compiled);anchor=compiled.summary.source;plan=item;
                } else {
                    // Keep older user-written prompts usable, with an actual story anchor.
                    anchor=String(item?.source || item?.after || '').trim();
                    if(anchor.length<4 || !story.includes(anchor))throw new Error('画面定位句不在正文中');
                    tags=cleanImageTags(item?.tags);resolveImageCharacters(tags,roster());
                }
                if(manual&&!selectionTextMap(selection.text).normalized.includes(selectionTextMap(anchor).normalized))throw new Error('画面定位句不在点选段落中');
                if(!tags)throw new Error('图片标签为空');
                if(tags.includes(cfg.start)||tags.includes(cfg.end))throw new Error('标签包含当前生图分隔符，请调整标签或分隔符');
                const raw=cfg.start+tags+cfg.end;
                if(selected.some(s=>s.raw===raw)){warn('跳过重复的画面方案');continue;}
                selected.push({raw,anchor,plan});
            } catch(e) { warn('跳过一张无效画面：'+e.message); }
        }
        if (!selected.length) { warn('没有可用的画面方案；请检查提示词输出格式或重新生成正文');forget();return; }
        // Locate against the original story once. Preserve order for images sharing an anchor.
        const insertions = new Map();
        for(const shot of selected){const at=manual?selection.insertAt:imageInsertionPoint(source,shot.anchor);if(!Number.isInteger(at)||at<0||at>source.length)throw new Error('选段插入位置无效');insertions.set(at,[...(insertions.get(at)||[]),shot]);}
        let next='',cursor=0;const positions=new Set(),shifts=[];
        for(const [at,shots] of [...insertions].sort((a,b)=>a[0]-b[0])){next+=source.slice(cursor,at);const before=next.length;for(const shot of shots){next+='\n';positions.add(next.length);next+=shot.raw+'\n';}shifts.push({at,length:next.length-before});cursor=at;}
        next+=source.slice(cursor);
        if(!current())return;
        const swipes=Array.isArray(msg.swipes)&&Number.isInteger(swipe)?msg.swipes:null,oldSwipe=swipes?.[swipe];
        const hadExtra=!!msg.extra;msg.extra||={};const oldPlans=msg.extra.zhikuIllustrations,oldImages=msg.extra.zhikuImages;
        if(manual&&oldImages)msg.extra.zhikuImages=shiftImageRecords(oldImages,parseImageMarkers(source,cfg.start,cfg.end),swipe,shifts);
        msg.extra.zhikuIllustrations=[...(manual&&Array.isArray(oldPlans)?oldPlans:[]),...selected.filter(s=>s.plan).map(s=>({raw:s.raw,plan:s.plan}))];
        msg.mes=next;if(swipes)swipes[swipe]=next;
        try{await getContext().saveChat();}
        catch(e){msg.mes=source;if(swipes)swipes[swipe]=oldSwipe;if(oldPlans===undefined)delete msg.extra.zhikuIllustrations;else msg.extra.zhikuIllustrations=oldPlans;if(oldImages===undefined)delete msg.extra.zhikuImages;else msg.extra.zhikuImages=oldImages;if(!hadExtra&&!Object.keys(msg.extra).length)delete msg.extra;forget();warn('自动插图存不进聊天：'+e.message);return;}
        const now=getContext();
        if(stopped || chatKey(now)!==chatId || now.chat?.[id]!==msg || msg.swipe_id!==swipe)return;
        const tokenIndices=parseImageMarkers(next,cfg.start,cfg.end).map((t,i)=>positions.has(t.index)?i:-1).filter(i=>i>=0);
        now.updateMessageBlock?.(id,msg);await afterSave(id,{manual,tokenIndices});
        return selected.length;
    }
    async function selected(selection) {
        if(!selection?.msg || selectedBusy.has(selection.msg))return;
        if(typeof selection.text!=='string'||selection.text.trim().length<4)throw new Error('请至少选择 4 个字符的正文');
        const location=locateSelectedText(selection.source,selection.text,{...settings(),occurrence:selection.occurrence??0});
        if(!location||location.insertAt!==selection.insertAt||!selectionTextMap(selectedImageStory(selection.source,settings())).normalized.includes(selectionTextMap(selection.text).normalized))throw new Error('所选文字无法对应聊天原文，请重新选择');
        selectedBusy.add(selection.msg);
        try{return await after(selection.id,selection);}finally{selectedBusy.delete(selection.msg);}
    }
    return {sync,after,selected,stop(){stopped=true;getContext().setExtensionPrompt?.('zhiku_illust','',1,0,false,0);}};
}


function renderIllustrationEditor(options, draft, hasRequest, esc) {
    return `<section class="pc-illust-editor pc-mt">
      <style>.pc-illust-editor textarea,.pc-illust-request{scrollbar-width:none;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere}.pc-illust-editor textarea::-webkit-scrollbar,.pc-illust-request::-webkit-scrollbar{display:none}.pc-illust-editor textarea{min-height:240px;width:100%;box-sizing:border-box}.pc-illust-request{max-height:65vh;font-size:14px;line-height:1.6}</style>
      <label class="pc-field"><span>正文转生图提示词 · SFW / NSFW 共用</span><textarea class="pc-textarea" data-bind="illustPromptDraft" rows="10">${esc(draft ?? illustrationPrompt(options))}</textarea></label>
      <div class="pc-actions wrap"><button class="pc-btn dark" data-act="illprompt-save">保存提示词</button><button class="pc-btn" data-act="illprompt-default">恢复默认</button><button class="pc-btn" data-act="illprompt-preview">预览当前请求</button><button class="pc-btn" data-act="illprompt-last" ${hasRequest?'':'disabled'}>最近组装的请求</button></div>
      <div class="pc-hint">保存后用于下一次自动插图；恢复默认先填回编辑框，保存才生效。两种分级都填写姿势、视线、站位、互动与构图。张数沿用上面的选择。修改输出格式时请保留画面字段。预览不发请求、不生图。</div>
    </section>`;
}

function createIllustrationEditor({ getOptions, getDraft, setDraft, commit, render, roster, settings, context, lastRequest, showRequest, notify }) {
    return async function action(name) {
        if (name === 'illprompt-default') { setDraft(DEFAULT_ILLUSTRATION_PROMPT);render();return; }
        if (name === 'illprompt-save') {
            const options=getOptions(), before=options.illustPrompt;
            saveIllustrationPrompt(options,getDraft() ?? illustrationPrompt(options));
            try { await commit({immediate:true}); }
            catch(e) { if(before===undefined)delete options.illustPrompt;else options.illustPrompt=before;throw e; }
            setDraft(undefined);render();notify('生图提示词已保存，下一次自动插图使用');return;
        }
        if (name === 'illprompt-last') { const request=lastRequest();if(request)showRequest(request,'最近组装的插图请求');return; }
        if (name === 'illprompt-preview') {
            const options=getOptions(),mode=options.illustMode==='inline'?'inline':'after',cfg=settings();
            const latest=[...(context().chat||[])].reverse().find(m=>!m.is_user&&!m.is_system);
            showRequest(illustrationRequest({options,mode,roster:roster(),markers:{start:cfg.start,end:cfg.end},story:imageStoryText(latest?.mes),prompt:getDraft()??illustrationPrompt(options)}),'当前编辑内容的请求预览');
        }
    };
}


// Match visible text back to original offsets without rewriting the original message.
function selectionTextMap(text) {
    let normalized='';const starts=[],ends=[];
    const entities={amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' '};
    for(let i=0;i<text.length;){
        const start=i;
        if(text[i]==='<'){const m=text.slice(i).match(/^<!--[\s\S]*?-->|^<\/?[a-zA-Z][^>]*>/);if(m){i+=m[0].length;continue;}}
        const entity=text[i]==='&'?text.slice(i).match(/^&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/i):null;
        let value=text[i++];
        if(entity){i=start+entity[0].length;const name=entity[1].toLowerCase();const code=name.startsWith('#x')?parseInt(name.slice(2),16):name.startsWith('#')?Number(name.slice(1)):null;value=code===null?entities[name]:code>=0&&code<=0x10ffff?String.fromCodePoint(code):'�';}
        for(const char of value){if(/[\s*_~`]/.test(char))continue;normalized+=char;for(let k=0;k<char.length;k++){starts.push(start);ends.push(i);}}
    }
    return {normalized,starts,ends};
}

function locateSelectedText(source,text,{occurrence=0,start='image###',end='###'}={}) {
    let raw=String(source||'');
    for(const token of parseImageMarkers(raw,start,end).reverse())raw=raw.slice(0,token.index)+' '.repeat(token.raw.length)+raw.slice(token.index+token.raw.length);
    raw=raw.replace(/<(think|thinking|analysis|imgthink|details|image|script|style)\b[^>]*>[\s\S]*?<\/\1>/gi,m=>' '.repeat(m.length)).replace(/<!--[\s\S]*?-->/g,m=>' '.repeat(m.length));
    const blocks=[...raw.matchAll(/<content\b[^>]*>([\s\S]*?)<\/content\s*>/gi)];
    if(blocks.length){let masked='',cursor=0;for(const block of blocks){masked+=' '.repeat(block.index-cursor)+block[0];cursor=block.index+block[0].length;}raw=masked+' '.repeat(raw.length-cursor);}
    const mapped=selectionTextMap(raw),needle=selectionTextMap(String(text||'')).normalized;
    if(needle.length<4)return null;
    let at=-1;
    for(let n=0;n<=occurrence;n++){at=mapped.normalized.indexOf(needle,at+1);if(at<0)return null;}
    const from=mapped.starts[at],to=mapped.ends[at+needle.length-1];
    // Finish the selected paragraph, before a closing content boundary or trailing status block.
    const tail=source.slice(to),boundary=tail.match(/\n|<\/(?:p|div|content)\s*>|<(?:details|image)\b/i);
    let insertAt=source.length;
    if(boundary){insertAt=to+boundary.index;if(/^<\/(?:p|div)\b/i.test(boundary[0]))insertAt+=boundary[0].length;}
    return {from,to,insertAt};
}

// Read the complete story while excluding existing generated prompts and status panels.
function selectedImageStory(source, {start='image###',end='###'}={}) {
    let text=String(source||'');
    for(const token of parseImageMarkers(text,start,end).reverse())text=text.slice(0,token.index)+text.slice(token.index+token.raw.length);
    return imageStoryText(text);
}

function createSelectedImageController({document:doc,getContext,settings,generate,notify}) {
    const win=doc.defaultView;
    let stopped=false,snapshot=null,panel=null,busy=false,timer;
    const key=c=>String(c.getCurrentChatId?.()??c.chatId??'')+'|'+String(c.characterId??'')+'|'+String(c.groupId??'');
    const mount=el=>(doc.documentElement||doc.body).appendChild(el);
    const style=doc.createElement('style');style.textContent=`
      .pc-selection-image{position:fixed;right:16px;bottom:100px;z-index:2147480100;padding:12px 18px;border:1px solid #aebbc6;border-radius:24px;background:#202a36;color:#fff;font-size:15px;box-shadow:0 4px 16px #0005;cursor:pointer}
      .pc-selection-image[hidden]{display:none}
      .pc-selection-backdrop{position:fixed;inset:0;z-index:2147480200;display:flex;align-items:center;justify-content:center;background:#0009;padding:14px;box-sizing:border-box}
      .pc-selection-dialog{width:min(100%,560px);max-height:90dvh;overflow:auto;box-sizing:border-box;border-radius:18px;padding:20px;background:#20242b;color:#f3f4f6;font:15px/1.6 sans-serif;scrollbar-width:none}
      .pc-selection-dialog *{box-sizing:border-box;scrollbar-width:none}.pc-selection-dialog::-webkit-scrollbar,.pc-selection-dialog *::-webkit-scrollbar{display:none}
      .pc-selection-dialog h3{margin:0 0 14px}.pc-selection-dialog label{display:block;margin:12px 0 6px}
      .pc-selection-dialog textarea{display:block;width:100%;height:160px;resize:vertical;overflow:auto;border:1px solid #627082;border-radius:10px;padding:10px;background:#15191f;color:inherit;font:inherit}
      .pc-selection-actions{display:flex;flex-wrap:wrap;gap:10px;margin-top:16px}.pc-selection-actions button{min-height:42px;padding:8px 18px;border-radius:10px;border:1px solid #627082;background:#303e50;color:#fff;font:inherit;cursor:pointer}.pc-selection-actions button:disabled{opacity:.6}
      .pc-selection-dialog p{font-size:13px;color:#bdc6d0;margin:10px 0}.pc-selection-status{white-space:pre-wrap;overflow-wrap:anywhere}
    `;mount(style);
    const button=doc.createElement('button');button.type='button';button.className='pc-selection-image';button.textContent='为这段生图';button.hidden=true;mount(button);
    const current=s=>{const c=getContext();return !stopped&&key(c)===s.chatKey&&c.chat?.[s.id]===s.msg&&s.msg.mes===s.source&&s.msg.swipe_id===s.swipe;};
    const element=node=>node?.nodeType===1?node:node?.parentElement;
    const excluded='.pc-marker-slot,.custom-pc-marker-slot,.pc-image-actions,a,button,input,textarea,select,img,video,audio,details,script,style,[contenteditable="true"]';
    function remember(range,text){
        const a=element(range.startContainer),b=element(range.endContainer),host=a?.closest('.mes_text');
        if(!host||host!==b?.closest('.mes_text')||a.closest(excluded)||b.closest(excluded)){button.hidden=true;snapshot=null;return false;}
        const floor=host.closest('.mes[mesid]'),id=Number(floor?.getAttribute('mesid')),c=getContext(),msg=c.chat?.[id];
        if(!floor||text.length<4||!Number.isInteger(id)||!msg||msg.is_system){button.hidden=true;snapshot=null;return false;}
        const prefix=range.cloneRange();prefix.selectNodeContents(host);prefix.setEnd(range.startContainer,range.startOffset);
        const before=selectionTextMap(prefix.toString()).normalized,needle=selectionTextMap(text).normalized;
        const occurrence=needle?before.split(needle).length-1:0;
        const source=String(msg.mes||''),cfg=settings(),location=locateSelectedText(source,text,{...cfg,occurrence});
        if(!location||!selectionTextMap(selectedImageStory(source,cfg)).normalized.includes(needle)){button.hidden=true;snapshot=null;return false;}
        snapshot={id,msg,source,swipe:msg.swipe_id,chatKey:key(c),text,occurrence,...location};button.hidden=false;return true;
    }
    function capture(){
        if(stopped||panel||busy)return;
        const selection=win?.getSelection?.();
        if(!selection||selection.isCollapsed||!selection.rangeCount){button.hidden=true;snapshot=null;return;}
        remember(selection.getRangeAt(0),selection.toString().trim());
    }
    // 双击（手机上是连点两下）段落才弹确认框，单击不打扰阅读
    let lastTap=null;
    function clickParagraph(event){
        if(stopped||panel||busy||event.defaultPrevented)return;
        const target=element(event.target),host=target?.closest('.mes_text');
        if(!host||target.closest(excluded)){lastTap=null;return;}
        const block=target.closest('p,li,blockquote');
        const paragraph=block||(host.querySelector('p,li,blockquote')?null:host);
        const now=Date.now();
        const twice=!!paragraph&&(event.detail===2||(lastTap&&lastTap.paragraph===paragraph&&now-lastTap.at<400));
        lastTap=twice?null:{paragraph,at:now};
        const selection=win?.getSelection?.();
        if(!twice){if(selection&&!selection.isCollapsed)capture();return;}
        // 电脑上双击会顺手选中一个词，清掉，按整段处理
        selection?.removeAllRanges?.();
        if(!host.contains(paragraph)||paragraph.querySelector(excluded))return;
        const range=doc.createRange();range.selectNodeContents(paragraph);
        if(remember(range,range.toString().trim()))openDialog();
    }
    const schedule=()=>{clearTimeout(timer);timer=setTimeout(capture,120);};
    const preserve=e=>{if(e.type==='mousedown'||e.pointerType==='mouse')e.preventDefault();};
    button.addEventListener('pointerdown',preserve);button.addEventListener('mousedown',preserve);
    function dismiss(){panel?.remove();panel=null;snapshot=null;button.hidden=true;}
    function openDialog(){
        if(!snapshot||busy)return;
        const shot=snapshot;
        if(!current(shot)){notify('聊天或原文已变化，请重新选择文字');dismiss();return;}
        if(!Number.isInteger(shot.insertAt)){notify('所选文字无法对应聊天原文，请在正文里重新选择一段');return;}
        button.hidden=true;
        panel=doc.createElement('div');panel.className='pc-selection-backdrop';
        const box=doc.createElement('div');box.className='pc-selection-dialog';box.setAttribute('role','dialog');box.setAttribute('aria-modal','true');box.setAttribute('aria-label','为这段生成图片？');
        box.innerHTML='<h3>为这段生成图片？</h3><textarea readonly aria-label="选中段落"></textarea><p>结合整篇正文，为这段生成一张图片，插在这段之后。</p><div class="pc-selection-status" role="status"></div><div class="pc-selection-actions"><button type="button" data-generate>生成图片</button><button type="button" data-close>取消</button></div>';
        box.querySelector('textarea').value=shot.text;
        const submit=box.querySelector('[data-generate]'),status=box.querySelector('[role="status"]');
        box.querySelector('[data-close]').onclick=dismiss;
        submit.onclick=async()=>{
            if(busy)return;
            if(!current(shot)){status.textContent='聊天或原文已变化，请关闭后重新选择';return;}
            busy=true;submit.disabled=true;status.textContent='正在结合正文生成这段的图片…';
            try{const result=await generate(shot);if(current({...shot,source:shot.msg.mes}))status.textContent=result?'已处理，图片结果显示在原楼层。':'没有生成新的画面，请查看提示信息。';submit.textContent=result?'已处理':'重试生成';if(!result)submit.disabled=false;}
            catch(e){status.textContent=e.message||String(e);submit.disabled=false;}
            finally{busy=false;}
        };
        panel.append(box);mount(panel);submit.focus();
    }
    button.addEventListener('click',openDialog);
    doc.addEventListener('click',clickParagraph);
    const escape=e=>{if(e.key==='Escape')dismiss();};
    for(const event of ['selectionchange','pointerup','touchend','keyup'])doc.addEventListener(event,schedule);
    doc.addEventListener('keydown',escape);
    return {capture,reset:dismiss,stop(){stopped=true;clearTimeout(timer);for(const event of ['selectionchange','pointerup','touchend','keyup'])doc.removeEventListener(event,schedule);doc.removeEventListener('keydown',escape);doc.removeEventListener('click',clickParagraph);dismiss();button.remove();style.remove();}};
}

let illustrationLastRequest = null;
// Per-image protocol adapter. Never use the surrounding message as the image cast.
function imageCharacterNames(character) {
    return [character.name, ...String(character.name || '').split('|'), ...String(character.aliases || '').split(/[,，、;；|]+/)]
        .map(s => String(s || '').trim()).filter(Boolean);
}

/** 解析 $…$ 里的角色标记。认不出的写法不再报错：JSON 里没有 name 的（比如别的插件的服装标记）返回 null，整段忽略；其他写法整段当角色名字 */
function parseCharacterToken(value) {
    const text = String(value || '').trim();
    if (!text) return null;
    if (text.startsWith('{')) {
        let data;
        try { data = JSON.parse(text); } catch { return null; }
        if (!data || typeof data.name !== 'string' || !data.name.trim()) return null;
        return { name: data.name.trim(), angle: typeof data.angle === 'string' ? data.angle.trim() : '', nsfw: [data.upperBody, data.lowerBody].some(v => String(v).toLowerCase() === 'nsfw') };
    }
    const match = text.match(/^(.+?)-(?:sfw|nsfw)-(?:upperbody|lowerbody|fullbody)(?:-(?:sfw|nsfw)-(?:upperbody|lowerbody|fullbody))?$/i);
    if (!match) return { name: text, angle: '', nsfw: false };
    const angle = match[1].match(/(?:[,，\s-]+)(from (?:front|behind|side))$/i);
    return { name: (angle ? match[1].slice(0, angle.index) : match[1]).trim(), angle: angle?.[1] || '', nsfw: /-nsfw-/i.test(text.slice(match[1].length)) };
}

/** 去掉认不出的 $…$ 和落单的 $，剩下的都是能用的角色标记 */
function dropBadCharacterTokens(text) {
    const src = String(text || '');
    let out = '', last = 0;
    for (const m of src.matchAll(/\$([^$]*)\$/g)) {
        out += src.slice(last, m.index).replace(/\$/g, '') + (parseCharacterToken(m[1]) ? m[0] : '');
        last = m.index + m[0].length;
    }
    return out + src.slice(last).replace(/\$/g, '');
}

function resolveImageCharacters(prompt, roster) {
    const normalize = s => String(s).normalize('NFKC').replace(/\s+/g, '').toLowerCase();
    const clean = s => s.trim().replace(/^[,;\s]+|[,;\s]+$/g, '');
    const matchCharacter = name => {
        const found = roster.filter(row => imageCharacterNames(row.char).some(n => normalize(n) === normalize(name)));
        const enabled = found.filter(row => row.on);
        if (enabled.length > 1) throw new Error(`角色「${name}」匹配到多人，请在角色页设置不同的名字或别名`);
        // 没登记或没开的人照样画：不带外貌和参考图，按这张图里写的标签画
        if (!enabled.length) { unknown.push(name); return { name, appearance: [], outfits: [], outfitMode: 'story', negative: '', unregistered: true }; }
        return enabled[0].char;
    };
    const picks = [], cast = [], unknown = [];
    let nsfw = false;
    function parsePart(text, uc = '', center = null) {
        text = dropBadCharacterTokens(text);
        const tokens = [...text.matchAll(/\$([^$]+)\$/g)];
        if (/(?:^|[,;\s])nsfw(?:$|[,;\s])/i.test(text.replace(/\$[^$]+\$/g, ''))) nsfw = true;
        // Reject broken placeholders before paying for a request.
        if (!tokens.length) return clean(text);
        for (let i = 0; i < tokens.length; i++) {
            const token = parseCharacterToken(tokens[i][1]);
            nsfw ||= token.nsfw;
            const char = matchCharacter(token.name);
            const tags = [token.angle, clean(text.slice(tokens[i].index + tokens[i][0].length, tokens[i + 1]?.index ?? text.length))].filter(Boolean).join(', ');
            const existing = picks.find(p => p.char === char || (char.unregistered && p.char.unregistered && p.char.name === char.name));
            if (existing) {
                existing.tags = [existing.tags, tags].filter(Boolean).join(', ');
                existing.uc = [existing.uc, uc].filter(Boolean).join(', ');
            } else {
                picks.push({ char, tags, uc, ...(center || {}) });
                if (!char.unregistered) cast.push(char);
            }
        }
        return clean(text.slice(0, tokens[0].index));
    }
    const text = String(prompt || '');
    const headers = [...text.matchAll(/(?:^|[;\n])\s*(Scene Composition|Character\s+(\d+)\s+(Prompt|UC))\s*:/gi)];
    let scene;
    if (headers.length) {
        const blocks = headers.map((h, i) => ({ kind: h[1].toLowerCase(), id: h[2], type: h[3]?.toLowerCase(), value: clean(text.slice(h.index + h[0].length, headers[i + 1]?.index ?? text.length)) }));
        scene = clean(text.slice(0, headers[0].index));
        const sceneParts = blocks.filter(b => !b.id).map(b => parsePart(b.value));
        scene = [scene, ...sceneParts].filter(Boolean).join(', ');
        for (const block of blocks.filter(b => b.type === 'prompt')) {
            const centerMatch = block.value.match(/\|centers:\s*([\d.]+)\s*,\s*([\d.]+)\s*$/i);
            const center = centerMatch ? { x: Number(centerMatch[1]), y: Number(centerMatch[2]) } : null;
            const value = centerMatch ? block.value.slice(0, centerMatch.index) : block.value;
            const uc = blocks.filter(b => b.id === block.id && b.type === 'uc').map(b => b.value).join(', ');
            const start = picks.length;
            const prefix = parsePart(value, uc, center);
            if (prefix && picks.length > start) picks[start].tags = [prefix, picks[start].tags].filter(Boolean).join(', ');
            else if (prefix) picks.push({ char: { appearance: [], outfits: [], negative: '' }, tags: prefix, uc, ...(center || {}) });
        }
    } else scene = parsePart(text);
    picks.forEach((p, i) => { p.x ??= (i + 1) / (picks.length + 1); p.y ??= 0.5; });
    if (nsfw) {
        const withoutRating = value => value.split(',').map(t => t.trim()).filter(t => t && !/^(?:sfw|nsfw)$/i.test(t)).join(', ');
        scene = ['nsfw', withoutRating(scene)].filter(Boolean).join(', ');
        picks.forEach(p => { p.tags = withoutRating(p.tags); });
    }
    return { scene, picks, cast, unknown: [...new Set(unknown)] };
}

// A closed content block is the story boundary; status panels after it stay outside.
function imageStoryText(source) {
    let text = String(source || '').replace(/<(think|thinking|analysis|imgthink)\b[^>]*>[\s\S]*?<\/\1>/gi, '').replace(/<!--[\s\S]*?-->/g, '');
    const blocks = [...text.matchAll(/<content\b[^>]*>([\s\S]*?)<\/content\s*>/gi)];
    if (blocks.length) text = blocks.map(m => m[1]).join('\n\n');
    else if (/<content\b/i.test(text)) return ''; // Wait for a complete story.
    return text.replace(/<(image|details|script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '').replace(/<[^>]+>/g, '').trim();
}

function imageCastInstruction(names) {
    if (!names.length) return '未登记的角色直接写完整英文外貌标签。';
    return `可调用的候选角色：${names.join('、')}。每张图只选择这一瞬间实际入画的人，在该图标签内逐人写 $角色名字-sfw-upperbody$（名字必须来自候选名单）。插件会补充标记角色的外貌、固定衣服和参考图，其后的英文标签描述该角色动作。候选名单不是全员入画要求；未入画的人不要写标记。空镜不写角色标记。`;
}

function cleanImageTags(value) {
    const tokens = [];
    const text = String(value || '').replace(/\$([^$]+)\$/g, (raw, body) => {
        if (!parseCharacterToken(body)) return '';
        tokens.push(raw);
        return `ZKROLEPLACEHOLDER${tokens.length - 1}END`;
    });
    return text.split(/[,，\n]+/).map(t => t.trim()).filter(t => t && !/[㐀-鿿豈-﫿]/.test(t)).join(', ')
        .replace(/ZKROLEPLACEHOLDER(\d+)END/g, (_, i) => tokens[Number(i)]);
}

function imageInsertionPoint(text, sentence) {
    const blocks = [...text.matchAll(/<content\b[^>]*>([\s\S]*?)<\/content\s*>/gi)];
    const ranges = blocks.length ? blocks.map(m => ({ start: m.index + m[0].indexOf('>') + 1, text: m[1] })) : [{ start: 0, text }];
    const s = String(sentence || '').trim();
    const tries = [s, s.replace(/[。！？!?…，,、；;："“”「」『』\s]+$/g, ''), s.slice(-12), s.slice(0, 12)].filter(t => t.length >= 4);
    for (const range of ranges) for (const term of tries) {
        const i = range.text.indexOf(term);
        if (i < 0) continue;
        const newline = range.text.indexOf('\n', i + term.length);
        return range.start + (newline < 0 ? range.text.length : newline);
    }
    // Even the fallback belongs inside the story, before a trailing status panel.
    const last = ranges.at(-1);
    return last.start + last.text.trimEnd().length;
}

// 智库 · 原生扩展版 v0.8.36（二改自从前佬的智绘姬）
// 不需要智绘姬，填 NovelAI key 就能用。
// NovelAI 请求格式参考了智绘姬（作者：从前跟你一样，https://github.com/damoshen123/st-chatu8，AFPL v9）。
const P = (() => { try { if (window.parent && window.parent !== window && window.parent.document) return window.parent; } catch (e) { /* 跨域 */ } return window; })();
const DOC = P.document;
const pcMount = el => (DOC.documentElement || DOC.body).appendChild(el);
const stToastr = P.toastr || window.toastr;
/** 智库开着的时候，提示显示在智库自己的界面里（不跑到酒馆那边、不被美化改样子）；关着就交给酒馆 */
const zkPanelOpen = () => !!DOC.querySelector('.pc-overlay.open, .pc-comic-book, .pc-modal-backdrop, .pc-viewer');
function zkToast(type, msg, title, opt = {}) {
    if (!zkPanelOpen() && typeof stToastr?.[type] === 'function') return stToastr[type](msg, title, opt);
    opt ||= {};
    let host = DOC.getElementById('pc-toasts');
    if (!host) {
        host = DOC.createElement('div'); host.id = 'pc-toasts';
        host.setAttribute('style', 'position:fixed;left:0;right:0;top:max(14px,env(safe-area-inset-top));z-index:2147483646;display:flex;flex-direction:column;align-items:center;gap:8px;padding:0 12px;box-sizing:border-box;max-height:calc(100dvh - 28px);overflow-y:auto;scrollbar-width:none;pointer-events:none');
        pcMount(host);
    }
    const color = { success: '#5f7d5a', info: '#7ea29c', warning: '#c98a3e', error: '#9b4f45' }[type] || '#7ea29c';
    const el = DOC.createElement('div');
    el.setAttribute('role', type === 'error' ? 'alert' : 'status');
    el.setAttribute('style', 'pointer-events:auto;box-sizing:border-box;flex-shrink:0;display:flex;gap:10px;align-items:flex-start;max-width:min(520px,100%);padding:10px 14px;border-radius:14px;background:#f4efe4;color:#3a2a22;border:1.5px solid #3a2a22;box-shadow:0 4px 0 rgba(26,22,18,.22);font:14px/1.55 "Noto Serif SC","Songti SC",serif;word-break:break-word;cursor:pointer;transition:opacity .2s,transform .2s;opacity:0;transform:translateY(-6px)');
    const dot = DOC.createElement('i');
    dot.setAttribute('style', `flex-shrink:0;width:12px;height:12px;margin-top:5px;border-radius:50%;background:${color}`);
    const body = DOC.createElement('div'); body.style.minWidth = '0';
    if (title) { const b = DOC.createElement('b'); b.textContent = title; b.setAttribute('style', `display:block;font-size:12px;letter-spacing:.1em;color:${color}`); body.appendChild(b); }
    const t = DOC.createElement('div'); t.textContent = String(msg ?? ''); body.appendChild(t);
    el.append(dot, body);
    host.appendChild(el);
    while (host.children.length > 4) host.firstChild.remove();
    requestAnimationFrame(() => { el.style.opacity = '1'; el.style.transform = 'none'; });
    const close = () => { el.style.opacity = '0'; setTimeout(() => el.remove(), 220); };
    el.addEventListener('click', close);
    const ms = Number(opt.timeOut ?? (type === 'error' ? 7000 : 3500));
    if (ms > 0) setTimeout(close, ms);
    return el;
}
const toastr = { success: (...a) => zkToast('success', ...a), info: (...a) => zkToast('info', ...a), warning: (...a) => zkToast('warning', ...a), error: (...a) => zkToast('error', ...a), clear: (el, ...a) => { const host = DOC.getElementById('pc-toasts'); if (el?.nodeType && host?.contains(el)) { el.remove(); return; } if (!el) host?.remove(); return stToastr?.clear?.(el, ...a); } };
const SillyTavern = P.SillyTavern || window.SillyTavern;
globalThis.__pcFetch = (...a) => P.fetch(...a);
const __ctx = () => SillyTavern.getContext();
const __shim = {
    getRequestHeaders: (...a) => __ctx().getRequestHeaders(...a),
    saveSettingsDebounced: (...a) => __ctx().saveSettingsDebounced(...a),
    get eventSource() { return __ctx().eventSource; },
    get event_types() { return __ctx().eventTypes; },
    get extension_settings() { return __ctx().extensionSettings; },
};

globalThis.__PC_VERSION = '0.8.36';

// ───── model.js ─────
const __mod_model = (() => {
/**
 * 票册数据模型：画师、画师组、合集、例图模板、当前用票。
 * 纯数据和字符串处理，不碰界面。
 */

const DATA_VERSION = 1;

/** 例图构图：头像 1:1、胸像 3:4、立绘 9:16（竖着放，人才够大） */
const SHOTS = {
    head: { name: '头像', width: 1024, height: 1024, ratio: '1:1' },
    bust: { name: '胸像', width: 896, height: 1152, ratio: '3:4' },
    full: { name: '立绘', width: 768, height: 1344, ratio: '9:16' },
};
const BASE = '1boy, solo, male focus, adult';
const NEG = '1girl, female, multiple boys, child, text, watermark, signature';
const BG = 'simple background, white background';
// 正脸、居中：每位画师的例图构图一样，只比画风。
// 不再写 symmetrical / arms at sides / feet apart 这类「人体参考图」的词，也写明穿着和上色，免得画成剪影、人台
const FRONT = 'front view, facing viewer, looking at viewer, centered';
const NOT_FRONT = 'profile, from side, from above, from below, dutch angle, looking away, three-quarter view, extreme close-up, cropped head, head out of frame, multiple views';
const NOT_FLAT = 'silhouette, monochrome, greyscale, mannequin, faceless, reference sheet, character sheet, turnaround, anatomy chart, flat color, solid color, blank eyes';
const CLOTHED = 'detailed face, detailed eyes, casual clothes, shirt, pants, full color';
const DEFAULT_TEMPLATES = {
    sfw_head: { id: 'sfw_head', name: 'SFW 头像', nsfw: false, shot: 'head', positive: `${BASE}, portrait, headshot, head and shoulders, ${FRONT}, detailed face, detailed eyes, shirt, light smile, ${BG}`, negative: `${NEG}, ${NOT_FRONT}, ${NOT_FLAT}, hands` },
    sfw_bust: { id: 'sfw_bust', name: 'SFW 胸像', nsfw: false, shot: 'bust', positive: `${BASE}, upper body, ${FRONT}, ${CLOTHED}, ${BG}`, negative: `${NEG}, ${NOT_FRONT}, ${NOT_FLAT}` },
    sfw_full: { id: 'sfw_full', name: 'SFW 立绘', nsfw: false, shot: 'full', positive: `${BASE}, full body, standing, ${FRONT}, ${CLOTHED}, shoes, ${BG}`, negative: `${NEG}, ${NOT_FRONT}, ${NOT_FLAT}, cropped` },
    nsfw_head: { id: 'nsfw_head', name: 'NSFW 头像', nsfw: true, shot: 'head', positive: `nsfw, ${BASE}, portrait, headshot, head and shoulders, ${FRONT}, detailed face, detailed eyes, blush, sweat, parted lips, half-closed eyes, ${BG}`, negative: `${NEG}, ${NOT_FRONT}, ${NOT_FLAT}, hands` },
    nsfw_bust: { id: 'nsfw_bust', name: 'NSFW 胸像', nsfw: true, shot: 'bust', positive: `nsfw, ${BASE}, upper body, ${FRONT}, detailed face, shirtless, pectorals, nipples, sweat, ${BG}`, negative: `${NEG}, ${NOT_FRONT}, ${NOT_FLAT}` },
    nsfw_full: { id: 'nsfw_full', name: 'NSFW 立绘', nsfw: true, shot: 'full', positive: `nsfw, ${BASE}, full body, standing, ${FRONT}, detailed face, completely nude, penis, ${BG}`, negative: `${NEG}, ${NOT_FRONT}, ${NOT_FLAT}, cropped` },
};
/** 0.8.x 的「证件照式」默认模板（没改过的换成上面的新版） */
const OLD_TEMPLATE_TEXT2 = (() => {
    // 正脸、正对镜头、居中：每位画师的例图构图一样，只比画风
    const FRONT = 'front view, facing viewer, looking at viewer, straight-on, centered, symmetrical composition';
    const NOT_FRONT = 'profile, from side, from above, from below, dutch angle, tilted head, head tilt, looking away, looking to the side, three-quarter view, extreme close-up, close-up of eye, cropped head, head out of frame, multiple views';
    const T = {
        sfw_head: { id: 'sfw_head', name: 'SFW 头像', nsfw: false, shot: 'head', positive: `${BASE}, portrait, headshot, head and shoulders, ${FRONT}, neutral expression, closed mouth, ${BG}`, negative: `${NEG}, ${NOT_FRONT}, hands` },
        sfw_bust: { id: 'sfw_bust', name: 'SFW 胸像', nsfw: false, shot: 'bust', positive: `${BASE}, upper body, ${FRONT}, standing straight, arms at sides, neutral expression, ${BG}`, negative: `${NEG}, ${NOT_FRONT}` },
        sfw_full: { id: 'sfw_full', name: 'SFW 立绘', nsfw: false, shot: 'full', positive: `${BASE}, full body, standing, ${FRONT}, arms at sides, feet apart, ${BG}`, negative: `${NEG}, ${NOT_FRONT}, cropped` },
        nsfw_head: { id: 'nsfw_head', name: 'NSFW 头像', nsfw: true, shot: 'head', positive: `nsfw, ${BASE}, portrait, headshot, head and shoulders, ${FRONT}, blush, sweat, parted lips, half-closed eyes, ${BG}`, negative: `${NEG}, ${NOT_FRONT}, hands` },
        nsfw_bust: { id: 'nsfw_bust', name: 'NSFW 胸像', nsfw: true, shot: 'bust', positive: `nsfw, ${BASE}, upper body, ${FRONT}, shirtless, pectorals, nipples, sweat, ${BG}`, negative: `${NEG}, ${NOT_FRONT}` },
        nsfw_full: { id: 'nsfw_full', name: 'NSFW 立绘', nsfw: true, shot: 'full', positive: `nsfw, ${BASE}, full body, standing, ${FRONT}, completely nude, penis, ${BG}`, negative: `${NEG}, ${NOT_FRONT}, cropped` },
    };

    return T;
})();
/** 上一版的默认模板（没改过的会换成上面的新版） */
const OLD_TEMPLATE_TEXT = (() => {
    const BASE = '1boy, solo, male focus, adult';
const NEG = '1girl, female, multiple boys, child, text, watermark, signature';
const BG = 'simple background, white background';
const T = {
    sfw_head: { id: 'sfw_head', name: 'SFW 头像', nsfw: false, shot: 'head', positive: `${BASE}, portrait, close-up, face focus, looking at viewer, ${BG}`, negative: NEG },
    sfw_bust: { id: 'sfw_bust', name: 'SFW 胸像', nsfw: false, shot: 'bust', positive: `${BASE}, upper body, looking at viewer, ${BG}`, negative: NEG },
    sfw_full: { id: 'sfw_full', name: 'SFW 立绘', nsfw: false, shot: 'full', positive: `${BASE}, full body, standing, looking at viewer, ${BG}`, negative: `${NEG}, cropped` },
    nsfw_head: { id: 'nsfw_head', name: 'NSFW 头像', nsfw: true, shot: 'head', positive: `nsfw, ${BASE}, portrait, close-up, face focus, blush, sweat, parted lips, half-closed eyes, looking at viewer, ${BG}`, negative: NEG },
    nsfw_bust: { id: 'nsfw_bust', name: 'NSFW 胸像', nsfw: true, shot: 'bust', positive: `nsfw, ${BASE}, upper body, shirtless, pectorals, nipples, sweat, looking at viewer, ${BG}`, negative: NEG },
    nsfw_full: { id: 'nsfw_full', name: 'NSFW 立绘', nsfw: true, shot: 'full', positive: `nsfw, ${BASE}, full body, standing, completely nude, penis, looking at viewer, ${BG}`, negative: `${NEG}, cropped` },
};

    return T;
})();
for (const t of Object.values(DEFAULT_TEMPLATES)) { t.width = SHOTS[t.shot].width; t.height = SHOTS[t.shot].height; }
const OLD_DEFAULT_POS = ['1boy, solo, male focus, upper body, looking at viewer, simple background', 'nsfw, 1boy, solo, male focus, shirtless, upper body, looking at viewer, simple background'];

/** 一张例图是哪种构图（旧的 SFW/NSFW 例图算胸像） */
function shotOf(data, img) {
    const t = data.templates[img.template];
    if (t?.shot) return t.shot;
    const m = /_(head|bust|full)$/.exec(img.template || '');
    return m ? m[1] : 'bust';
}


function emptyData() {
    return {
        version: DATA_VERSION,
        artists: {},      // id -> { id, tag, note, images: [Img], createdAt }
        groups: {},       // id -> { id, name, note, members: [{artistId, weight}], extra, images: [Img], collections: [id], fav, createdAt, usedAt }
        collections: {},  // id -> { id, name, createdAt }
        templates: structuredClone(DEFAULT_TEMPLATES),
        active: null,     // { type: 'group'|'artist', id }
        oneShot: false,
        previousActive: null,
        bindingActive: false,
        beforeBinding: null,
        rotate: 'off',    // off | seq | random
        rotatePool: 'recent', // recent | fav | collection:<id>
        bindings: {},     // characterKey -> { type, id }
        recent: [],       // [{ type, id }]
        options: {
            imageExpanded: true,
            stripArtistFromFixed: true, // 用票时去掉固定提示词里原有的 artist: 词
            showStub: true,             // 界面上的小票根
            showChip: false,            // 输入框上方显示当前画师串
            lobbyShowNsfw: false,
            charAutoBlocks: true,     // 从回复里的 <人物>/<外貌变化> 自动建档
            charBlockToast: true,     // 建档 / 改档时给一条小提示
            markerResultExpand: true, // 生成完自动展开这次新出的那张图
            markerStream: true,       // 流式预生成：标记一写完整就先出图
        },
        lobby: { server: 'https://soundbox.192-255-236-219.sslip.io:8443/zhiku', nickname: '', invite: '' },
        characters: {},   // key -> 角色（见 chars.js）
        chatCast: {},     // 聊天 id -> { 角色 key: 开/关 }
        vibeGroups: {},   // id -> { id, name, vibes: [{ id, path, thumb, strength, info, encoded:{model: base64} }] }
        vibeActive: null,
        charRefGroups: {}, // id -> { id, name, refs: [{ id, path, type: character|both|style, strength }] }
        charRefActive: null,
        blockedTags: [],
        outfits: {},      // 衣柜里还没给谁穿的衣服：id -> { id, name, tags:[{en,zh}], image }
        blacklist: {},    // 画师 key -> { tag, note, at }  拉黑的画师
        studio: null,
        history: [],      // 历史生图：[{ id, url, thumb, raw, sent, from, at }]
        aiPresets: { active: 'tavern:', list: {}, fn: {}, markOn: {} }, // AI 预设：active = plain / tavern:预设名（空 = 酒馆现在用的）/ 自己的预设 id
    };
}

function normalizeData(raw) {
    const d = emptyData();
    if (!raw || typeof raw !== 'object') return d;
    for (const k of Object.keys(d)) if (raw[k] !== undefined) d[k] = raw[k];
    d.options = { ...emptyData().options, ...(raw.options || {}) };
    d.lobby = { ...emptyData().lobby, ...(raw.lobby || {}) };
    const rawT = { ...(raw.templates || {}) };
    // 旧版的 SFW / NSFW 两个模板没改过就去掉（换成 头像/胸像/立绘），改过的留着
    for (const k of ['sfw', 'nsfw']) if (rawT[k] && OLD_DEFAULT_POS.includes(rawT[k].positive)) delete rawT[k];
    for (const set of [OLD_TEMPLATE_TEXT, OLD_TEMPLATE_TEXT2]) for (const [k, old] of Object.entries(set)) if (rawT[k] && rawT[k].positive === old.positive && rawT[k].negative === old.negative) rawT[k] = { ...rawT[k], positive: DEFAULT_TEMPLATES[k].positive, negative: DEFAULT_TEMPLATES[k].negative };
    for (const t of Object.values(rawT)) t.shot ||= 'bust';
    d.templates = { ...structuredClone(DEFAULT_TEMPLATES), ...rawT };
    for (const a of Object.values(d.artists)) { a.images ||= []; a.note ||= ''; a.collections ||= []; a.tag = normalizeArtistTag(a.tag); }
    for (const character of Object.values(d.characters || {})) {
        const list = Array.isArray(character.aliases) ? character.aliases.join(',') : String(character.aliases || '');
        character.aliases = list.split(/[,，、;；|\s]+/).map(x => x.trim()).filter(x => x && x !== character.name).join('，');
        if (typeof character.nl !== 'string') character.nl = '';
    }
    // 同一位画师存了两份的，合并成一份
    const seenA = {};
    for (const a of Object.values(d.artists)) {
        const k = artistKey(a.tag);
        const keep = seenA[k];
        if (!keep) { seenA[k] = a; continue; }
        keep.images.push(...a.images);
        keep.note ||= a.note;
        keep.collections = [...new Set([...keep.collections, ...a.collections])];
        for (const g of Object.values(d.groups)) for (const m of g.members || []) if (m.artistId === a.id) m.artistId = keep.id;
        if (d.active?.type === 'artist' && d.active.id === a.id) d.active.id = keep.id;
        delete d.artists[a.id];
    }
    for (const g of Object.values(d.groups)) { g.images ||= []; g.members ||= []; g.collections ||= []; g.note ||= ''; g.extra ||= ''; g.neg ||= ''; }
    // 以前生图页的「预设」并进画师库（预设和画师串是一回事）
    if (raw.presets && typeof raw.presets === 'object') {
        for (const [name, p] of Object.entries(raw.presets)) {
            if (!String(p?.pos || '').trim()) continue;
            const r = createFromString(d, { name, text: p.pos, neg: p.neg, note: '从预设搬过来' });
            if (r?.type === 'group') d.groups[r.id].name = name;
        }
    }
    // 以前误把 absurdres 之类当成了画师（还加了 artist:）：组里的放回普通词；单独的没例图就删，有例图的留着让人自己删
    const fake = a => a && (NOT_ARTIST.test(a.tag.replace(/^artist:/i, '').trim()) || /^(?:(?:ultra|very|highly|extremely|hyper)[ _-]?)?detailed$|^(?:illustration|anime(?: style)?|best|quality)$/i.test(a.tag.replace(/^artist:/i, '').trim()) || /[<>]/.test(a.tag));
    for (const g of Object.values(d.groups)) {
        const bad = g.members.filter(m => fake(d.artists[m.artistId]));
        if (!bad.length) continue;
        g.members = g.members.filter(m => !bad.includes(m));
        g.extra = [g.extra, ...bad.map(m => d.artists[m.artistId].tag.replace(/^artist:/i, '').trim())].filter(Boolean).join(', ');
    }
    for (const a of Object.values(d.artists)) {
        if (!fake(a)) continue;
        if (d.active?.type === 'artist' && d.active.id === a.id) d.active = null;
        if (!a.images.length) delete d.artists[a.id];
    }
    d.recent = Array.isArray(d.recent) ? d.recent : [];
    d.history = Array.isArray(d.history) ? d.history : [];
    if (!d.aiPresets || typeof d.aiPresets !== 'object') d.aiPresets = { active: 'tavern:', list: {}, fn: {}, markOn: {} };
    d.aiPresets.list ||= {}; d.aiPresets.fn ||= {}; d.aiPresets.markOn ||= {};
    if (typeof d.aiPresets.active !== 'string') d.aiPresets.active = 'tavern:';
    // 一位画师都没有、也没有例图的画师串（批量时把画风词误当成一串）删掉
    for (const g of Object.values(d.groups)) {
        if (g.members.length || g.images.length) continue;
        delete d.groups[g.id];
        if (d.active?.type === 'group' && d.active.id === g.id) d.active = null;
    }
    d.recent = d.recent.filter(r => r.type !== 'group' || d.groups[r.id]);
    return d;
}

const uid = (p = '') => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

// ───────────── 画师串解析 ─────────────

/** 画师名统一写法，用来判断是不是同一位画师 */
function artistKey(tag) {
    return String(tag || '').toLowerCase().replace(/^(\s*artist\s*:\s*)+/, '').replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
}

/** 把裸画师名补成 artist:xxx */
function normalizeArtistTag(text) {
    let t = String(text || '').trim().replace(/^(artist\s*:\s*)+/i, 'artist:');
    if (!t) return '';
    if (!/^artist\s*:/i.test(t)) t = 'artist:' + t;
    return t.replace(/^artist\s*:\s*/i, 'artist:');
}

const round2 = n => Math.round(n * 100) / 100;
function fmtWeight(w) { return String(round2(w)); }

/** 按顶层逗号拆分（括号里的逗号不拆） */
function splitTop(text) {
    const out = [];
    let depth = 0, cur = '';
    for (const ch of text) {
        if (ch === '{' || ch === '[' || ch === '(') depth++;
        if (ch === '}' || ch === ']' || ch === ')') depth = Math.max(0, depth - 1);
        if (ch === ',' && depth === 0) { out.push(cur); cur = ''; } else cur += ch;
    }
    out.push(cur);
    return out.map(s => s.trim()).filter(Boolean);
}

/** 把一个词外层的 {} [] 换算成权重（NAI：一层 {} ×1.05，一层 [] ÷1.05） */
function unwrapBrackets(tok) {
    let w = 1, t = tok.trim();
    for (;;) {
        if (t.startsWith('{') && t.endsWith('}')) { w *= 1.05; t = t.slice(1, -1).trim(); continue; }
        if (t.startsWith('[') && t.endsWith(']')) { w /= 1.05; t = t.slice(1, -1).trim(); continue; }
        break;
    }
    return { text: t, weight: w };
}

/**
 * 把一段提示词拆成词，每个词带权重和是否是画师。
 * 支持 1.2::a, b:: 写法、{} [] 写法。
 */
function tokenize(text) {
    const tokens = [];
    const src = String(text || '');
    const re = /(-?\d+(?:\.\d+)?)::([\s\S]*?)::/g;
    let last = 0, m;
    const pushPlain = (chunk, outer = 1) => {
        for (const raw of splitTop(chunk)) {
            const { text: t, weight } = unwrapBrackets(raw);
            if (!t) continue;
            tokens.push({ text: t, weight: round2(weight * outer), isArtist: /^artist\s*:/i.test(t), raw: outer === 1 ? raw : null });
        }
    };
    while ((m = re.exec(src))) {
        pushPlain(src.slice(last, m.index));
        pushPlain(m[2], Number(m[1]));
        last = re.lastIndex;
    }
    pushPlain(src.slice(last));
    return tokens;
}

function tokenToText(t) {
    if (t.raw) return t.raw;
    return Math.abs(t.weight - 1) < 0.001 ? t.text : `${fmtWeight(t.weight)}::${t.text}::`;
}

/** 画师串 → { members: [{tag, weight}], extra } */
function parseArtistString(text) {
    const toks = tokenize(text);
    const members = [], extra = [];
    for (const t of toks) {
        if (t.isArtist) members.push({ tag: normalizeArtistTag(t.text), weight: t.weight });
        else extra.push(tokenToText(t));
    }
    return { members, extra: extra.join(', ') };
}

/** 去掉提示词里所有 artist: 词，其他词原样保留 */
function stripArtists(text) {
    return tokenize(text).filter(t => !t.isArtist).map(tokenToText).join(', ');
}

/** 粘贴画师名时顺手带进来的质量词、年份等，不当成画师 */
const NOT_ARTIST = /^(masterpiece|best[ _]quality|amazing[ _]quality|great[ _]quality|good[ _]quality|normal[ _]quality|bad[ _]quality|worst[ _]quality|high[ _]quality|low[ _]quality|ultra[ -_]?detailed|highres|absurdres|very[ _]aesthetic|aesthetic|year \d{4}|\d{4}|no text|rating:.*|1boy|1girl|solo|nsfw|sfw)$/i;

/** 把一串画师名（换行或逗号隔开）拆成一个个画师 */
function parseArtistList(text) {
    const out = [];
    const seen = new Set();
    for (const line of String(text || '').split(/\n+/)) {
        for (const t of tokenize(line)) {
            if (!t.isArtist && NOT_ARTIST.test(t.text.trim())) continue;
            const tag = normalizeArtistTag(t.text);
            const k = artistKey(tag);
            if (!tag || seen.has(k)) continue;
            seen.add(k);
            out.push({ tag, weight: t.weight });
        }
    }
    return out;
}

/**
 * 批量用：一行一串。
 * 这一行里有 artist: 开头的词 → 整行就是一个画师串（别的词原样跟着）；
 * 没有 artist: → 当成一串画师名，一个个拆开。
 */
/** 普通词（画风、质量、构图），不是画师名 */
const BATCH_GENERAL = /^(?:\d+(?:boy|girl|other)s?|solo|male|female|nsfw|sfw|rating:.*|year \d{4}|\d{4}|newest|oldest|recent|masterpiece|absurdres|highres|lowres|very aesthetic|aesthetic|no text|uncensored|.*quality.*)$/i;
const BATCH_STYLE_WORD = /\b(?:background|lighting|light|lights|detailed|details?|emphasis|style|shading|colou?rs?|composition|focus|texture|fabric|depth of field|illustration|anime|realistic|photorealistic|sketch|painting|watercolor|lineart|cinematic|atmosphere|scenery|portrait)\b/i;
const batchNameLike = t => !/[<>:]/.test(t) && t.split(/\s+/).length <= 3 && !BATCH_GENERAL.test(t) && !BATCH_STYLE_WORD.test(t);
/** 一个词加上 artist:（保留前面的权重） */
const batchWithArtist = raw => /artist\s*:/i.test(raw) ? raw : raw.replace(/^(\s*(?:-?\d+(?:\.\d+)?::)?\s*[{\[(]*\s*)/, '$1artist:');
/** 一串词 → 一个批量单位（只有一位不带权重的画师时就是单个画师） */
function batchUnit(parts) {
    const text = parts.map(x => x.trim()).filter(Boolean).join(', ');
    if (!text) return null;
    const p = parseArtistString(text);
    if (!p.members.length) return null; // 一位画师都没有（只有 year 2025、detailed 这类词）的不算画师串
    if (p.members.length === 1 && !p.extra && Math.abs(p.members[0].weight - 1) < 0.001) return { tag: p.members[0].tag, weight: 1, key: artistKey(p.members[0].tag) };
    return { text, members: p.members, key: text.toLowerCase() };
}
/**
 * 批量用：
 * - <artist>…</artist> 写法：每个 artist 块里的是画师，后面跟着的 <style> 等块是画风词，合起来算一串；
 * - 一行里有 artist: 开头的词，或者混着画风、质量词 → 整行就是一个画师串（光秃秃的画师名自动补 artist:）；
 * - 一行全是画师名 → 一个个拆开。
 */
function parseBatchLines(text) {
    const out = [], seen = new Set();
    const push = u => { if (u && !seen.has(u.key)) { seen.add(u.key); const { key, ...rest } = u; out.push(rest); } };
    const src = String(text || '');
    const SEC = /<([a-z_][\w-]*)[^>]*>([\s\S]*?)<\/\1\s*>/gi;
    if ([...src.matchAll(SEC)].some(m => /artist/i.test(m[1]))) {
        let cur = null, pre = [];
        for (const m of src.matchAll(SEC)) {
            const words = m[2].split(/[,\n]/).map(t => t.trim()).filter(t => t && !/^<\/?[\w-]+>$/.test(t));
            if (/artist/i.test(m[1])) { if (cur) push(batchUnit(cur)); cur = [...words.map(batchWithArtist), ...pre]; }
            else if (cur) cur.push(...words); else pre.push(...words);
        }
        if (cur) push(batchUnit(cur));
        return out;
    }
    for (const line of src.split(/\n+/).map(x => x.replace(/<\/?[\w-]+[^>]*>/g, ' ').trim()).filter(Boolean)) {
        const toks = splitTop(line).map(t => t.trim()).filter(Boolean);
        const bare = t => t.replace(/^\s*-?\d+(?:\.\d+)?::/, '').replace(/::\s*$/, '').replace(/[{}\[\]]/g, '').trim();
        if (tokenize(line).some(t => t.isArtist)) push(batchUnit([line]));
        else if (!toks.every(t => batchNameLike(bare(t)))) {
            push(batchUnit(toks.map(t => batchNameLike(bare(t)) ? batchWithArtist(t) : t)));
        } else {
            for (const m of parseArtistList(line)) push({ ...m, key: artistKey(m.tag) });
        }
    }
    return out;
}

// ───────────── 增删查 ─────────────

function findArtistByTag(data, tag) {
    const k = artistKey(normalizeArtistTag(tag));
    return Object.values(data.artists).find(a => artistKey(a.tag) === k) || null;
}

function ensureArtist(data, tag) {
    const t = normalizeArtistTag(tag);
    if (!t) return null;
    let a = findArtistByTag(data, t);
    if (!a) {
        a = { id: uid('a_'), tag: t, note: '', images: [], createdAt: Date.now() };
        data.artists[a.id] = a;
    }
    return a;
}

/** 由一段画师串建立：只有一位画师 → 单个画师；两位以上 → 画师组 */
function createFromString(data, { name, text, note = '', collections = [], neg = '', forceGroup = false }) {
    const { members, extra } = parseArtistString(text);
    if (!members.length && !extra) return null;
    neg = String(neg || '').trim();
    if (!forceGroup && members.length === 1 && !extra && !neg && Math.abs(members[0].weight - 1) < 0.001) {
        const a = ensureArtist(data, members[0].tag);
        if (note && !a.note) a.note = note;
        return { type: 'artist', id: a.id };
    }
    const g = {
        id: uid('g_'), name: name || members.map(m => m.tag.replace(/^artist:/, '')).slice(0, 2).join(' + ') || extra.split(',').slice(0, 2).join(',').trim(),
        note, extra, neg, collections, fav: false, images: [], createdAt: Date.now(), usedAt: 0,
        members: members.map(m => ({ artistId: ensureArtist(data, m.tag).id, weight: m.weight })),
    };
    if (String(text || '').trim()) g.raw = String(text).trim();
    data.groups[g.id] = g;
    return { type: 'group', id: g.id };
}

/** Overwrite only content; keep identity, examples, tags, notes and character bindings. */
function overwriteGroup(data, ref, text, neg) {
    const g = ref?.type === 'group' && data.groups[ref.id];
    if (!g) throw new Error('原画师串已被删除，请另存为新串');
    const raw = String(text || '').trim();
    if (!raw) throw new Error('画师串是空的，请先填写再保存');
    const p = parseArtistString(raw);
    g.members = p.members.map(m => ({ artistId: ensureArtist(data, m.tag).id, weight: m.weight }));
    g.extra = p.extra; g.raw = raw; g.neg = String(neg || '').trim();
    return { type: 'group', id: g.id };
}
function groupsContaining(data, artistId) {
    return Object.values(data.groups).filter(g => g.members.some(m => m.artistId === artistId));
}

function deleteArtist(data, id) {
    delete data.artists[id];
    for (const g of Object.values(data.groups)) g.members = g.members.filter(m => m.artistId !== id);
    cleanupRefs(data);
}
function deleteGroup(data, id) {
    delete data.groups[id];
    cleanupRefs(data);
}
function cleanupRefs(data) {
    const exists = r => r && (r.type === 'group' ? data.groups[r.id] : data.artists[r.id]);
    if (!exists(data.active)) data.active = null;
    if (!exists(data.previousActive)) data.previousActive = null;
    data.recent = data.recent.filter(exists);
    for (const k of Object.keys(data.bindings)) if (!exists(data.bindings[k])) delete data.bindings[k];
}

// ───────────── 票 → 提示词 ─────────────

function resolveTicket(data, ref) {
    if (!ref) return null;
    if (ref.type === 'group') return data.groups[ref.id] ? { ...ref, item: data.groups[ref.id] } : null;
    return data.artists[ref.id] ? { ...ref, item: data.artists[ref.id] } : null;
}

function ticketName(data, ref) {
    const t = resolveTicket(data, ref);
    if (!t) return '';
    return t.type === 'group' ? t.item.name : t.item.tag.replace(/^artist:/, '');
}

/** 画师组的内容指纹：画师 + 权重 + 其他词。原样保存的那串和现在的画师、权重对得上，才原样输出 */
function groupSig(members, extra) {
    return members.map(m => artistKey(m.tag) + '@' + round2(Number(m.weight ?? 1))).join('|') + '#' + String(extra || '').replace(/\s+/g, ' ').trim();
}
const rawSigCache = new Map();
function rawStillValid(data, g) {
    if (!g.raw) return false;
    let sig = rawSigCache.get(g.raw);
    if (sig === undefined) { const p = parseArtistString(g.raw); sig = groupSig(p.members, p.extra); rawSigCache.set(g.raw, sig); }
    return sig === groupSig(g.members.map(m => ({ tag: data.artists[m.artistId]?.tag || '', weight: m.weight })), g.extra);
}
function ticketString(data, ref) {
    const t = resolveTicket(data, ref);
    if (!t) return '';
    if (t.type === 'artist') return t.item.tag;
    // 用户写的那串原样发：{artist:a}、1.2::a, b::、顺序、小数位都不动
    if (rawStillValid(data, t.item)) return t.item.raw;
    const parts = t.item.members
        .map(m => ({ a: data.artists[m.artistId], w: Number(m.weight) || 1 }))
        .filter(x => x.a)
        .map(({ a, w }) => Math.abs(w - 1) < 0.001 ? a.tag : `${fmtWeight(w)}::${a.tag}::`);
    if (t.item.extra) parts.push(t.item.extra);
    return parts.join(', ');
}

/** 画师串带的负面（只有画师组有） */
function ticketNeg(data, ref) {
    const t = resolveTicket(data, ref);
    return t && t.type === 'group' ? String(t.item.neg || '') : '';
}

function ticketCover(data, ref) {
    const t = resolveTicket(data, ref);
    if (!t) return null;
    const pick = imgs => imgs.find(i => !i.nsfw && shotOf(data, i) === 'head') || imgs.find(i => !i.nsfw) || imgs[0];
    return pick(t.item.images) || null;
}

function touchRecent(data, ref) {
    data.recent = [ref, ...data.recent.filter(r => !(r.type === ref.type && r.id === ref.id))].slice(0, 20);
    if (ref.type === 'group' && data.groups[ref.id]) data.groups[ref.id].usedAt = Date.now();
}

function sameRef(a, b) { return !!a && !!b && a.type === b.type && a.id === b.id; }

/** 轮换：从票池里挑下一张 */
function rotationPool(data) {
    const p = data.rotatePool || 'recent';
    if (p === 'fav') return Object.values(data.groups).filter(g => g.fav).map(g => ({ type: 'group', id: g.id }));
    if (p.startsWith('collection:')) {
        const cid = p.slice(11);
        return Object.values(data.groups).filter(g => g.collections.includes(cid)).map(g => ({ type: 'group', id: g.id }));
    }
    // 最近用过的票按名字排个固定顺序，免得轮换时在两张票之间来回跳
    return data.recent.slice(0, 8).slice().sort((a, b) => ticketName(data, a).localeCompare(ticketName(data, b)));
}
function nextInRotation(data) {
    const pool = rotationPool(data).filter(r => resolveTicket(data, r));
    if (pool.length < 2) return null;
    if (data.rotate === 'random') {
        const others = pool.filter(r => !sameRef(r, data.active));
        return others[Math.floor(Math.random() * others.length)];
    }
    const i = pool.findIndex(r => sameRef(r, data.active));
    return pool[(i + 1) % pool.length];
}

// ───────────── 生图页：在正面提示词里换画师 ─────────────

const tokKey = t => t.text.toLowerCase().replace(/_/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * 把正面提示词里的画师换成新的画师串，其他词原样保留。
 * oldExtra：上一个画师组自带的附加词（如 year 2025），换掉时一起去掉。
 * 新画师串放在最前面，重复的词只留一个。
 */
function replaceArtists(text, newStr, oldExtra = '') {
    const drop = new Set(tokenize(oldExtra).map(tokKey));
    const keep = tokenize(text).filter(t => !t.isArtist && !drop.has(tokKey(t)));
    // 新画师串原样放最前面，不拆开重写
    const seen = new Set(tokenize(newStr).map(tokKey));
    const out = String(newStr || '').trim() ? [String(newStr).trim()] : [];
    for (const t of keep) {
        const k = tokKey(t);
        if (seen.has(k)) continue;
        seen.add(k);
        out.push(tokenToText(t));
    }
    return out.join(', ');
}

/** 一段提示词里的画师，对应画师库里的哪一张（画师组要求画师和权重都一样） */
function findTicketForString(data, text) {
    const { members } = parseArtistString(text);
    if (!members.length) return null;
    const sig = arr => arr.map(m => artistKey(m.tag) + '@' + round2(m.weight)).sort().join('|');
    const want = sig(members);
    for (const g of Object.values(data.groups)) {
        const ms = g.members.map(m => ({ tag: data.artists[m.artistId]?.tag || '', weight: Number(m.weight) || 1 }));
        if (sig(ms) === want) return { type: 'group', id: g.id };
    }
    if (members.length === 1) {
        const a = findArtistByTag(data, members[0].tag);
        if (a) return { type: 'artist', id: a.id };
    }
    return null;
}

/** 把几段提示词接在一起，重复的词只留第一次出现的 */
function mergeTags(...texts) {
    const seen = new Set();
    const out = [];
    for (const t of tokenize(texts.filter(Boolean).join(', '))) {
        const k = tokKey(t);
        if (seen.has(k)) continue;
        seen.add(k);
        out.push(tokenToText(t));
    }
    return out.join(', ');
}

// ───────────── 画师黑名单 ─────────────

function banInfo(data, tag) {
    return data.blacklist?.[artistKey(normalizeArtistTag(tag))] || null;
}
function setBan(data, tag, note) {
    const t = normalizeArtistTag(tag);
    data.blacklist ||= {};
    data.blacklist[artistKey(t)] = { tag: t, note: note || '', at: Date.now() };
}
function unBan(data, tag) {
    delete data.blacklist?.[artistKey(normalizeArtistTag(tag))];
}
/** 一段提示词里出现了哪些拉黑的画师 */
function bannedIn(data, text) {
    return tokenize(text).filter(t => t.isArtist).map(t => banInfo(data, t.text)).filter(Boolean);
}
/** 画师组里有没有拉黑的画师 */
function groupBanned(data, g) {
    return (g.members || []).map(m => data.artists[m.artistId]).filter(a => a && banInfo(data, a.tag));
}

return { DATA_VERSION, SHOTS, DEFAULT_TEMPLATES, shotOf, emptyData, normalizeData, uid, artistKey, normalizeArtistTag, fmtWeight, tokenize, parseArtistString, stripArtists, parseArtistList, parseBatchLines, findArtistByTag, ensureArtist, createFromString, overwriteGroup, groupsContaining, deleteArtist, deleteGroup, resolveTicket, ticketName, ticketString, ticketNeg, ticketCover, touchRecent, sameRef, rotationPool, nextInRotation, replaceArtists, findTicketForString, mergeTags, banInfo, setBan, unBan, bannedIn, groupBanned };
})();

// ───── store.js ─────
const __mod_store = (() => {
/**
 * 票册数据的读写：数据存成酒馆服务器上的一个 json 文件，例图存进酒馆的 user/images/piaoce/。
 * 换设备、换浏览器都在。
 */
const getRequestHeaders = __shim.getRequestHeaders;
const { emptyData, normalizeData } = __mod_model;
const DATA_FILE = 'piaoce_data.json';
const IMG_FOLDER = 'piaoce';
const LOCAL_BACKUP = 'piaoce_data_backup';

let data = emptyData();
let loadedFromServer = false;
let saveTimer = null;
let saving = Promise.resolve();
const listeners = new Set();

const getData = () => data;
const onChange = fn => { listeners.add(fn); return () => listeners.delete(fn); };
const emit = () => listeners.forEach(fn => { try { fn(data); } catch (e) { console.error('[票册]', e); } });

function headers() {
    return getRequestHeaders();
}

function utf8ToBase64(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(bin);
}

async function loadData() {
    try {
        const res = await fetch(`/user/files/${DATA_FILE}?t=${Date.now()}`, { cache: 'no-store' });
        if (res.status === 404) {
            const backup = localStorage.getItem(LOCAL_BACKUP);
            data = normalizeData(backup ? JSON.parse(backup) : null);
            loadedFromServer = true;
        } else if (res.ok) {
            data = normalizeData(await res.json());
            loadedFromServer = true;
        } else {
            throw new Error(`HTTP ${res.status}`);
        }
    } catch (e) {
        console.warn('[票册] 从酒馆读取数据失败，先用本地备份', e);
        const backup = localStorage.getItem(LOCAL_BACKUP);
        data = normalizeData(backup ? JSON.parse(backup) : null);
        loadedFromServer = false;
        toastr.warning('票册数据没能从酒馆读到，这次的改动先存在浏览器里。', '画师票册');
    }
    emit();
    return data;
}

async function writeNow() {
    const json = JSON.stringify(data);
    try { localStorage.setItem(LOCAL_BACKUP, json); } catch { /* 太大就算了 */ }
    if (!loadedFromServer) return; // 没读到服务器的数据时不覆盖，免得把服务器上的旧数据清掉
    const res = await fetch('/api/files/upload', {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ name: DATA_FILE, data: utf8ToBase64(json) }),
    });
    if (!res.ok) throw new Error(`保存失败 HTTP ${res.status}`);
}

/** 改完数据调用：立刻通知界面，稍后写到服务器 */
function commit({ immediate = false, silent = false } = {}) {
    if (!silent) emit();
    clearTimeout(saveTimer);
    const run = () => {
        saveTimer = null;
        saving = saving.then(writeNow).catch(e => {
            console.error('[票册] 保存失败', e);
            toastr.error('票册保存到酒馆失败：' + e.message, '画师票册');
        });
        return saving;
    };
    if (immediate) return run();
    saveTimer = setTimeout(run, 600);
    return saving;
}

function replaceData(next) {
    data = normalizeData(next);
    loadedFromServer = true;
    return commit({ immediate: true });
}

// ───────────── 例图 ─────────────

/** dataURL → 存到酒馆，返回 { path, url } */
async function uploadImage(dataUrl, baseName) {
    const m = /^data:image\/(png|jpeg|jpg|webp);base64,(.+)$/s.exec(dataUrl);
    if (!m) throw new Error('图片格式不对');
    const format = m[1] === 'jpg' ? 'jpeg' : m[1];
    const res = await fetch('/api/images/upload', {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ image: m[2], format, ch_name: IMG_FOLDER, filename: baseName }),
    });
    if (!res.ok) throw new Error(`例图上传失败 HTTP ${res.status}`);
    const { path } = await res.json();
    return { path, url: '/' + String(path).replace(/^\/+/, '') };
}

async function deleteImageFile(path) {
    try {
        await fetch('/api/images/delete', { method: 'POST', headers: headers(), body: JSON.stringify({ path }) });
    } catch (e) { console.warn('[票册] 删除图片失败', e); }
}

function imgUrl(img) {
    if (!img) return '';
    return img.url || ('/' + String(img.path || '').replace(/^\/+/, ''));
}

/** 文件/Blob → dataURL */
function fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(r.result);
        r.onerror = reject;
        r.readAsDataURL(file);
    });
}

/** 远程图片（大堂）→ dataURL */
async function urlToDataUrl(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`下载图片失败 HTTP ${res.status}`);
    return fileToDataUrl(await res.blob());
}

/** 缩小图片，给大堂上传用，省流量 */
async function shrinkDataUrl(dataUrl, maxSide = 1024, quality = 0.88) {
    const img = await new Promise((resolve, reject) => {
        const i = new Image();
        i.onload = () => resolve(i);
        i.onerror = reject;
        i.src = dataUrl;
    });
    const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
    if (scale === 1 && dataUrl.length < 1.5e6) return dataUrl;
    const c = DOC.createElement('canvas');
    c.width = Math.round(img.width * scale);
    c.height = Math.round(img.height * scale);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', quality);
}

return { getData, onChange, loadData, commit, replaceData, uploadImage, deleteImageFile, imgUrl, fileToDataUrl, urlToDataUrl, shrinkDataUrl, flush: () => saveTimer !== null ? commit({ immediate: true, silent: true }) : saving };
})();

// ───── lobby.js ─────
const __mod_lobby = (() => {
/** 大堂（你的 VPS）接口 */
const { getData } = __mod_store;
function userId() {
    let id = localStorage.getItem('piaoce_uid');
    if (!id) {
        id = (crypto.randomUUID?.() || (Date.now().toString(36) + Math.random().toString(36).slice(2))).replace(/[^\w-]/g, '');
        localStorage.setItem('piaoce_uid', id);
    }
    return id;
}

function serverBase() {
    return String(getData().lobby.server || 'https://soundbox.192-255-236-219.sslip.io:8443/zhiku').trim().replace(/\/+$/, '');
}

async function call(path, { method = 'GET', body } = {}) {
    const base = serverBase();
    if (!base) throw new Error('还没填大堂服务器地址（票册设置里填）');
    const res = await fetch(base + path, {
        method,
        headers: {
            'Content-Type': 'application/json',
            'X-Piaoce-Uid': userId(),
            ...(getData().lobby.invite ? { 'X-Invite': getData().lobby.invite } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
    });
    let json = null;
    try { json = await res.json(); } catch { /* 空响应 */ }
    if (!res.ok) throw new Error(json?.error || `HTTP ${res.status}`);
    return json;
}

const lobbyImgUrl = u => (u && u.startsWith('/') ? serverBase() + u : u);

const health = () => call('/health');
const listPosts = ({ sort = 'new', tag = '', kind = '', q = '', nsfw = false, mine = false, offset = 0, limit = 20 } = {}) =>
    call(`/lobby/posts?${new URLSearchParams({ sort, tag, kind, q, nsfw: nsfw ? '1' : '0', mine: mine ? '1' : '0', offset, limit })}`);
const listTags = () => call('/lobby/tags');
const createPost = body => call('/lobby/posts', { method: 'POST', body: { nickname: getData().lobby.nickname, ...body } });
const likePost = id => call(`/lobby/posts/${id}/like`, { method: 'POST' });
const copyPost = id => call(`/lobby/posts/${id}/copy`, { method: 'POST' });
const reportPost = id => call(`/lobby/posts/${id}/report`, { method: 'POST' });
const deletePost = id => call(`/lobby/posts/${id}`, { method: 'DELETE' });

return { serverBase, lobbyImgUrl, health, listPosts, listTags, createPost, likePost, copyPost, reportPost, deletePost };
})();

// ───── nai.js ─────
const __mod_nai = (() => {
/**
 * 直接向 NovelAI 发生图请求（不再需要智绘姬）。
 * 请求格式参考了智绘姬（作者：从前跟你一样，https://github.com/damoshen123/st-chatu8，AFPL v9）的 NovelAI 部分。
 *
 * 三种连接方式：
 *  - key：填自己的 NovelAI key，浏览器直接连 image.novelai.net
 *  - tavern：用酒馆「API 连接」里已经填好的 NovelAI key，走酒馆后端
 *  - site：第三方站点（地址 + key）
 */
const getRequestHeaders = __shim.getRequestHeaders;
const saveSettingsDebounced = __shim.saveSettingsDebounced;
const extension_settings = new Proxy({}, { get: (_, k) => { const v = __shim.extension_settings[k]; return typeof v === 'function' ? v.bind(__shim.extension_settings) : v; }, set: (_, k, v) => { __shim.extension_settings[k] = v; return true; } });
const KEY = 'piaoce_nai';
/** 脚本版跑在 iframe 里，用酒馆页面的 fetch */
const http = (...a) => (globalThis.__pcFetch || fetch)(...a);

const MODELS = [
    ['nai-diffusion-4-5-full', 'NAI Diffusion 4.5 Full'],
    ['nai-diffusion-4-5-curated', 'NAI Diffusion 4.5 Curated'],
    ['nai-diffusion-4-full', 'NAI Diffusion 4 Full'],
    ['nai-diffusion-4-curated-preview', 'NAI Diffusion 4 Curated'],
    ['nai-diffusion-3', 'NAI Diffusion Anime 3'],
    ['nai-diffusion-5-full', 'NAI Diffusion 5 Full'],
    ['nai-diffusion-5-curated', 'NAI Diffusion 5 Curated'],
];
const SAMPLERS = [
    ['k_euler_ancestral', 'Euler Ancestral'],
    ['k_euler', 'Euler'],
    ['k_dpmpp_2s_ancestral', 'DPM++ 2S Ancestral'],
    ['k_dpmpp_2m_sde', 'DPM++ 2M SDE（默认）'],
    ['k_dpmpp_2m', 'DPM++ 2M'],
    ['k_dpmpp_sde', 'DPM++ SDE'],
];
const SCHEDULES = [['karras', 'karras（默认）'], ['exponential', 'exponential'], ['polyexponential', 'polyexponential'], ['native', 'native']];

const DEFAULTS = {
    naiMode: 'key', naiKey: '', naiSite: '', naiSiteKey: '',
    novelaimode: 'nai-diffusion-4-5-full',
    novelai_width: '832', novelai_height: '1216', novelai_steps: '28', nai3Scale: '5', novelai_seed: '0',
    novelai_sampler: 'k_dpmpp_2m_sde', Schedule: 'karras', cfg_rescale: '0.18', nai3Variety: 'false',
    AQT_novelai: 'on', UCP_novelai: 'Heavy', addFurryDataset: 'false',
};

/** 生图设置（存在酒馆的 settings.json 里）。字段名沿用智绘姬的，方便搬设置 */
function settings() {
    const all = extension_settings;
    if (!all[KEY]) all[KEY] = {};
    const s = all[KEY];
    if (!s.samplingDefaultsV2) {
        const oldDefault = (s.novelai_sampler == null || s.novelai_sampler === 'k_euler_ancestral')
            && (s.Schedule == null || s.Schedule === 'karras') && (s.cfg_rescale == null || Number(s.cfg_rescale) === 0);
        if (oldDefault) Object.assign(s, { novelai_sampler: 'k_dpmpp_2m_sde', Schedule: 'karras', cfg_rescale: '0.18' });
        s.samplingDefaultsV2 = true;
        saveSettingsDebounced();
    }
    for (const [k, v] of Object.entries(DEFAULTS)) if (s[k] === undefined || s[k] === null) s[k] = v;
    return s;
}
const save = () => saveSettingsDebounced();

function isReady() {
    const s = settings();
    if (s.naiMode === 'tavern') return true;
    if (s.naiMode === 'site') return !!s.naiSite.trim();
    return !!s.naiKey.trim();
}

/** 把负面预设的名字换成当前模型认得的写法（V5 用小写） */
function ucpValue(s) {
    const v = String(s.UCP_novelai ?? '');
    const isV5 = String(s.novelaimode).includes('nai-diffusion-5');
    const map5 = { Heavy: 'heavy', Light: 'light', 'Human Focus': 'humanFocus', 'Furry Focus': 'furryFocus', '': 'none' };
    const map4 = { heavy: 'Heavy', light: 'Light', humanFocus: 'Human Focus', furryFocus: 'Furry Focus', none: '' };
    return isV5 ? (map5[v] ?? v) : (map4[v] ?? v);
}

// ───────────── 请求体 ─────────────

const randomSeed = () => Math.floor(Math.random() * 1e10);

function skipSigma(w, h, model) {
    const magic = model.includes('nai-diffusion-4-5') ? 58 : 19;
    return Math.pow((w * h) / 1011712, 0.5) * magic;
}

/**
 * 组出 NovelAI 的请求参数。
 * chars：[{ prompt, uc, center:{x,y} }]（分角色，可不填）
 * refs：{ images:[base64], strengths:[], infos:[] }（氛围，可不填）
 */
function buildParameters({ positive, negative, width, height, seed, chars = [], refs = null, director = null, comic = false }) {
    const s = settings();
    const model = comic ? 'nai-diffusion-5-full' : s.novelaimode;
    const isV3 = model === 'nai-diffusion-3';
    const isV5 = model.includes('nai-diffusion-5');
    const w = Number(width || s.novelai_width) || 832;
    const h = Number(height || s.novelai_height) || 1216;
    const sd = Number(seed ?? s.novelai_seed);
    const p = {
        params_version: isV5 ? 4 : 3,
        width: w, height: h,
        scale: Number(s.nai3Scale) || 5,
        sampler: s.novelai_sampler || 'k_dpmpp_2m_sde',
        steps: Number(s.novelai_steps) || 28,
        n_samples: 1,
        ucPreset: 3,
        qualityToggle: false,
        dynamic_thresholding: false,
        controlnet_strength: 1,
        legacy: false,
        legacy_uc: false,
        add_original_image: true,
        cfg_rescale: Number(s.cfg_rescale) || 0,
        noise_schedule: s.Schedule || 'karras',
        skip_cfg_above_sigma: String(s.nai3Variety) === 'true' ? skipSigma(w, h, model) : null,
        legacy_v3_extend: false,
        seed: sd > 0 ? sd : randomSeed(),
        negative_prompt: negative,
        reference_image_multiple: [],
        reference_information_extracted_multiple: [],
        reference_strength_multiple: [],
        reference_image_multiple_cached: [],
    };
    if (isV3) {
        p.sm = false; p.sm_dyn = false;
    } else {
        const useCoords = chars.some(c => c.center);
        p.use_coords = useCoords;
        p.characterPrompts = chars.map(c => ({ enabled: true, prompt: c.prompt, uc: c.uc || '', center: c.center || { x: 0.5, y: 0.5 } }));
        p.v4_prompt = { caption: { base_caption: positive, char_captions: chars.map(c => ({ char_caption: c.prompt, centers: [c.center || { x: 0.5, y: 0.5 }] })) }, use_coords: useCoords, use_order: true };
        p.v4_negative_prompt = { caption: { base_caption: negative, char_captions: chars.map(c => ({ char_caption: c.uc || '', centers: [c.center || { x: 0.5, y: 0.5 }] })) }, legacy_uc: false };
        delete p.reference_image_multiple;
        delete p.reference_information_extracted_multiple;
    }
    if (isV5) {
        const k = ucpValue(s).toLowerCase();
        p.tag_hint_uc_preset = comic ? 0 : { heavy: 1, furryfocus: 2, light: 3, humanfocus: 4 }[k] ?? 0;
        p.tag_hint_qt = 1;
        delete p.skip_cfg_above_sigma;
        delete p.noise_schedule;
        if (p.sampler === 'ddim_v3') p.sampler = 'k_euler_ancestral';
        if (!p.reference_strength_multiple?.length) delete p.reference_strength_multiple;
        if (!p.reference_image_multiple_cached?.length) delete p.reference_image_multiple_cached;
    }
    if (p.sampler === 'k_euler_ancestral') { p.deliberate_euler_ancestral_bug = false; p.prefer_brownian = true; }
    if (director?.length && model.includes('4-5')) {
        // 角色参考（只有 4.5 能用，而且不能和氛围一起用）
        p.director_reference_images_cached = director.map(r => ({ cache_secret_key: r.key, data: r.data }));
        p.director_reference_descriptions = director.map(r => ({ caption: { base_caption: r.type === 'both' ? 'character&style' : r.type === 'style' ? 'style' : 'character', char_captions: [] }, legacy_uc: false }));
        p.director_reference_information_extracted = director.map(() => 1);
        p.director_reference_strength_values = director.map(r => r.strength);
        p.director_reference_secondary_strength_values = director.map(r => Math.round((1 - r.strength) * 1000) / 1000);
        refs = null;
    }
    if (refs?.images?.length) {
        if (isV3) {
            p.reference_image_multiple = refs.images;
            p.reference_information_extracted_multiple = refs.infos || refs.images.map(() => 1);
            p.reference_strength_multiple = refs.strengths;
        } else {
            p.reference_image_multiple_cached = refs.images;
            p.reference_strength_multiple = refs.strengths;
            p.normalize_reference_strength_multiple = !!refs.normalize;
        }
    }
    return p;
}

// ───────────── 发送 ─────────────

function siteUrl(path) {
    const s = settings();
    if (s.naiMode === 'site') {
        const base = s.naiSite.trim().replace(/\/+$/, '');
        if (!base) throw new Error('选了第三方站点，但没填地址');
        return base.endsWith(path) ? base : base + path;
    }
    return 'https://image.novelai.net' + path;
}
function authKey() {
    const s = settings();
    const k = (s.naiMode === 'site' ? s.naiSiteKey : s.naiKey).trim();
    if (!k && s.naiMode !== 'site') throw new Error('还没填 NovelAI key，到「设置」最上面填');
    return k;
}

/**
 * 生成一张图，返回 data:image/png;base64,...
 * 同时返回实际发送的内容 sent，给界面展示
 */
function createNaiGate({sleep=ms=>new Promise(r=>setTimeout(r,ms)),now=()=>Date.now(),notice=()=>{},gap=1500}={}) {
 let queue=Promise.resolve(),next=0,stopped=false;
 return {stop(){stopped=true;},run(fn){const job=queue.then(async()=>{
  for(let attempt=0;;attempt++){
   if(stopped)throw new Error('生图已停止');
   const delay=next-now();if(delay>0)await sleep(delay);
   if(stopped)throw new Error('生图已停止');
   try{return await fn();}
   catch(e){if((e.status!==429&&!e.retryable)||attempt>=2)throw e;
    const seconds=Number(e.retryAfter),date=Date.parse(e.retryAfter);
    const retry=Number.isFinite(seconds)&&seconds>0?seconds*1000:Number.isFinite(date)?Math.max(0,date-now()):0;
    next=now()+Math.max(retry,5000*2**attempt);notice('请求受到限流，等待 '+Math.ceil((next-now())/1000)+' 秒后重试');
   }finally{next=Math.max(next,now()+gap);}
  }
 });queue=job.catch(()=>{});return job;}};
}

const __naiGate=createNaiGate({notice:message=>toastr.info(message,'智库 · 生图排队')});
/** 浏览器层面的网络错误（Failed to fetch 之类）换成能看懂的说明 */
function netError(e) {
    if (!(e instanceof TypeError) || !/fetch|network|load failed/i.test(String(e.message))) return e;
    const mode = settings().naiMode;
    const where = mode === 'site' ? '第三方站点（站点可能挂了，或者地址填错了）' : mode === 'tavern' ? '酒馆后端（酒馆可能断开了，刷新页面试试）' : 'NovelAI（image.novelai.net）';
    return Object.assign(new Error(`连不上${where}，请求没发出去（${e.message}）。检查网络和 VPN，换个节点或稍后再试`), { status: 0 });
}
function generate(opts){return __naiGate.run(()=>generateRequest(opts)).catch(e=>{throw netError(e);});}
// ───────────── ComfyUI ─────────────
// 出图走酒馆自带的 /api/sd/comfy/* 转发（酒馆服务器去连 ComfyUI）；
// 读 ComfyUI 里存的工作流要浏览器直接去问 ComfyUI，ComfyUI 启动时得加 --enable-cors-header
const COMFY_Q = 'masterpiece, best quality, amazing quality, very aesthetic, absurdres';
const COMFY_UC = 'lowres, worst quality, bad quality, bad anatomy, bad hands, extra digits, fewer digits, jpeg artifacts, signature, watermark, username, text, blurry';
const COMFY_WORKFLOW = {
    3: { class_type: 'KSampler', inputs: { cfg: '%scale%', denoise: 1, latent_image: ['5', 0], model: ['4', 0], negative: ['7', 0], positive: ['6', 0], sampler_name: '%sampler%', scheduler: '%scheduler%', seed: '%seed%', steps: '%steps%' } },
    4: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: '%model%' } },
    5: { class_type: 'EmptyLatentImage', inputs: { batch_size: 1, height: '%height%', width: '%width%' } },
    6: { class_type: 'CLIPTextEncode', inputs: { clip: ['4', 1], text: '%prompt%' } },
    7: { class_type: 'CLIPTextEncode', inputs: { clip: ['4', 1], text: '%negative_prompt%' } },
    8: { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
    9: { class_type: 'SaveImage', inputs: { filename_prefix: 'zhiku', images: ['8', 0] } },
};
const comfyUrl = (s = settings()) => String(s.comfyUrl || '').trim().replace(/\/+$/, '');
const comfyReady = (s = settings()) => !!comfyUrl(s);
const chatBackend = (s = settings()) => String(s.comfyChat) === 'true' && comfyReady(s) ? 'comfy' : 'nai';
/** 没填过的话，从酒馆自带「图片生成」插件的 ComfyUI 设置里搬过来；那边也没有就用本机 8188 */
function comfyAutoConfig() {
    const s = settings();
    const sd = extension_settings?.sd || {};
    let changed = false;
    const put = (k, v) => { if (v != null && String(v).trim() !== '' && !String(s[k] ?? '').trim()) { s[k] = String(v); changed = true; } };
    put('comfyUrl', sd.comfy_url || 'http://127.0.0.1:8188');
    if (sd.source === 'comfy') { put('comfyModel', sd.model); put('comfySampler', sd.sampler); put('comfyScheduler', sd.scheduler); put('comfySteps', sd.steps); put('comfyCfg', sd.scale); }
    if (changed) save();
    return changed;
}
/** NovelAI 写法 → SD 写法：1.2::x:: → (x:1.2)，{x} → (x:1.05)，[x] → (x:0.95)，负权重去掉，artist:x 按设置改，原有括号转义 */
function naiToSd(text, artist = 'plain') {
    let src = String(text || '').replace(/\\?\(/g, '\u0004').replace(/\\?\)/g, '\u0005');
    src = src.replace(/(-?\d+(?:\.\d+)?)::([\s\S]*?)::/g, (m, w, body) => `\u0001${w}\u0002${body}\u0003`).replace(/::/g, '');
    const out = [];
    let mult = 1, buf = '', bufW = null;
    const stack = [];
    const flush = () => {
        const t = buf.trim(); buf = '';
        const w = bufW ?? mult; bufW = null;
        if (!t || w <= 0) return;
        let tag = t.replace(/\u0004/g, '\\(').replace(/\u0005/g, '\\)');
        if (/^artist:/i.test(tag)) { const name = tag.replace(/^artist:\s*/i, ''); tag = artist === 'keep' ? tag : artist === 'by' ? 'by ' + name : name; }
        out.push(Math.abs(w - 1) < 0.01 ? tag : `(${tag}:${Math.round(w * 100) / 100})`);
    };
    for (let i = 0; i < src.length; i++) {
        const ch = src[i];
        if (ch === ',' || ch === '\n' || ch === '|') { flush(); continue; }
        if (ch === '{') { mult *= 1.05; stack.push(1.05); continue; }
        if (ch === '[') { mult *= 0.95; stack.push(0.95); continue; }
        if ((ch === '}' || ch === ']') && stack.length) { mult /= stack.pop(); continue; }
        if (ch === '\u0001') { const j = src.indexOf('\u0002', i); const parsed = Number(src.slice(i + 1, j)); const w = Number.isFinite(parsed) ? parsed : 1; stack.push(mult); mult *= w; i = j; continue; }
        if (ch === '\u0003') { if (stack.length) mult = stack.pop(); continue; }
        if (ch.trim() && bufW === null && !buf.trim()) bufW = mult;
        buf += ch;
    }
    flush();
    return [...new Set(out)].join(', ');
}
async function comfyPost(path, body) {
    const r = await fetch('/api/sd/comfy/' + path, { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify(body) });
    if (!r.ok) {
        const t = await r.text().catch(() => '');
        throw new Error(path === 'generate' ? 'ComfyUI 出图失败：' + (t || ('HTTP ' + r.status)).slice(0, 400) : '连不上 ComfyUI：看看 ComfyUI 开着没有、地址对不对。手机上的酒馆连电脑的 ComfyUI，要填电脑的局域网地址，ComfyUI 启动时加 --listen');
    }
    return r;
}
/** 浏览器直接问 ComfyUI（读工作流、节点说明），要 ComfyUI 开 --enable-cors-header */
async function comfyDirect(path, url = comfyUrl()) {
    let r;
    try { r = await fetch(url + path, { cache: 'no-store' }); }
    catch { throw Object.assign(new Error('浏览器读不到 ComfyUI 里的工作流：ComfyUI 启动时加上 --enable-cors-header 再重连（不加也能生图，工作流可以「从电脑选文件」）'), { cors: true }); }
    if (!r.ok) throw new Error(`ComfyUI 返回 ${r.status}`);
    return r;
}
/** 连接：测通、读模型/采样器/调度器；顺手读 ComfyUI 里存的工作流和节点说明（读不到不算失败） */
async function comfyConnect() {
    const url = comfyUrl();
    if (!url) throw new Error('先填 ComfyUI 地址');
    await comfyPost('ping', { url });
    const [models, samplers, schedulers] = await Promise.all(['models', 'samplers', 'schedulers'].map(p => comfyPost(p, { url }).then(r => r.json()).catch(() => [])));
    const info = { models: (models || []).map(m => typeof m === 'string' ? { value: m, text: m } : m).filter(m => !/^(UNet:|GGUF:)/i.test(m.text || '')), samplers, schedulers, workflows: null, wfError: '' };
    try {
        let list;
        try { list = await (await comfyDirect('/api/userdata?dir=workflows&recurse=true&split=false', url)).json(); }
        catch (e) { if (e.cors) throw e; list = await (await comfyDirect('/userdata?dir=workflows&recurse=true&split=false', url)).json(); }
        info.workflows = (Array.isArray(list) ? list : []).map(x => typeof x === 'string' ? x : x?.path || x?.name).filter(x => x && /\.json$/i.test(x)).sort();
    } catch (e) { info.wfError = e.message; }
    return info;
}
let objectInfo = null, objectInfoUrl = '';
let comfyWorkflowSeq = 0;
async function comfyObjectInfo(url = comfyUrl()) {
    if (objectInfo && objectInfoUrl === url) return objectInfo;
    let info = null;
    try { info = await (await comfyDirect('/object_info', url)).json(); } catch {}
    if (comfyUrl() === url) { objectInfo = info; objectInfoUrl = url; }
    return info;
}
async function comfyLoadWorkflow(name) {
    const r = await comfyDirect('/api/userdata/' + encodeURIComponent('workflows/' + name));
    return await r.json();
}
/** 常见节点的控件顺序（读不到 ComfyUI 的节点说明时用） */
const WIDGETS = {
    KSampler: ['seed', 'steps', 'cfg', 'sampler_name', 'scheduler', 'denoise'],
    KSamplerAdvanced: ['add_noise', 'noise_seed', 'steps', 'cfg', 'sampler_name', 'scheduler', 'start_at_step', 'end_at_step', 'return_with_leftover_noise'],
    CheckpointLoaderSimple: ['ckpt_name'], CLIPTextEncode: ['text'], EmptyLatentImage: ['width', 'height', 'batch_size'],
    VAEDecode: [], VAEEncode: [], VAELoader: ['vae_name'], SaveImage: ['filename_prefix'], PreviewImage: [],
    LoraLoader: ['lora_name', 'strength_model', 'strength_clip'], LoraLoaderModelOnly: ['lora_name', 'strength_model'],
    CLIPSetLastLayer: ['stop_at_clip_layer'], LatentUpscale: ['upscale_method', 'width', 'height', 'crop'], LatentUpscaleBy: ['upscale_method', 'scale_by'],
    UpscaleModelLoader: ['model_name'], ImageUpscaleWithModel: [], ImageScale: ['upscale_method', 'width', 'height', 'crop'], ImageScaleBy: ['upscale_method', 'scale_by'],
    ConditioningCombine: [], ConditioningConcat: [], ConditioningSetArea: ['width', 'height', 'x', 'y', 'strength'], FreeU_V2: ['b1', 'b2', 's1', 's2'],
    ModelSamplingDiscrete: ['sampling', 'zsnr'], RescaleCFG: ['multiplier'], LoadImage: ['image'],
};
const NOT_RUN = new Set(['Note', 'MarkdownNote', 'Reroute', 'PrimitiveNode', 'PrimitiveString', 'PrimitiveInt', 'PrimitiveFloat']);
function widgetNames(type, info) {
    const def = info?.[type]?.input;
    if (def) {
        const names = [];
        for (const sec of ['required', 'optional']) for (const [n, spec] of Object.entries(def[sec] || {})) {
            const t = Array.isArray(spec) ? spec[0] : spec;
            if (!spec?.[1]?.forceInput && (Array.isArray(t) || ['INT', 'FLOAT', 'STRING', 'BOOLEAN', 'COMBO'].includes(t))) names.push(n);
        }
        return names;
    }
    return WIDGETS[type];
}
/** ComfyUI 画布上存的「界面版」工作流 → 出图用的「API 版」 */
function uiToApi(wf, info) {
    if (!Array.isArray(wf?.nodes)) return wf; // 本来就是 API 版
    if (wf.definitions?.subgraphs?.length || wf.nodes.some(n => /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(n.type))) throw new Error('这个工作流里有「组节点 / 子图」，智库还转不了。在 ComfyUI 里用「导出（API）」导出来，再「从电脑选文件」');
    const byId = new Map(wf.nodes.map(n => [n.id, n]));
    const links = new Map((wf.links || []).map(l => Array.isArray(l) ? [l[0], { from: l[1], slot: l[2] }] : [l.id, { from: l.origin_id, slot: l.origin_slot }]));
    const resolve = linkId => {
        let l = links.get(linkId);
        for (let guard = 0; l && guard < 64; guard++) {
            const src = byId.get(l.from);
            if (!src) return null;
            if (/^Primitive/.test(src.type)) return { value: Array.isArray(src.widgets_values) ? src.widgets_values[0] : undefined };
            if (src.type === 'Reroute') { l = links.get(src.inputs?.[0]?.link); continue; }
            if (src.mode === 4) { // 被「绕过」的节点：同类型的输入直接接到输出
                const type = src.outputs?.[l.slot]?.type;
                const inp = src.inputs?.find(i => i.link != null && i.type === type);
                if (!inp) return null;
                l = links.get(inp.link); continue;
            }
            if (src.mode === 2) return null;
            return { ref: [String(src.id), l.slot] };
        }
        return null;
    };
    const api = {};
    const unknown = new Set();
    for (const n of wf.nodes) {
        if (NOT_RUN.has(n.type) || n.mode === 2 || n.mode === 4) continue;
        const inputs = {};
        for (const inp of n.inputs || []) {
            if (inp.link == null) continue;
            const r = resolve(inp.link);
            if (r?.ref) inputs[inp.name] = r.ref; else if (r && r.value !== undefined) inputs[inp.name] = r.value;
        }
        const wv = n.widgets_values;
        if (Array.isArray(wv) && wv.length) {
            const names = widgetNames(n.type, info);
            if (!names) unknown.add(n.type);
            else {
                let i = 0;
                for (const name of names) {
                    if (i >= wv.length) break;
                    const v = wv[i++];
                    if (/^(seed|noise_seed)$/.test(name) && ['fixed', 'increment', 'decrement', 'randomize'].includes(wv[i])) i++;
                    if (!(name in inputs)) inputs[name] = v;
                }
            }
        } else if (wv && typeof wv === 'object') for (const [k, v] of Object.entries(wv)) if (!(k in inputs)) inputs[k] = v;
        api[String(n.id)] = { class_type: n.type, inputs };
    }
    if (unknown.size) throw new Error(`读不到这几个节点的说明：${[...unknown].join('、')}。ComfyUI 启动时加 --enable-cors-header 再重连，或者在 ComfyUI 里「导出（API）」后从电脑选文件`);
    return api;
}
/** 往工作流里填正面、负面、尺寸、种子（有 "%prompt%" 这类占位符就按占位符填） */
function fillWorkflow(api, v, builtin) {
    if (!api || Array.isArray(api) || typeof api !== 'object' || !Object.values(api).every(n => n && typeof n.class_type === 'string' && n.inputs && typeof n.inputs === 'object')) throw new Error('请导入 ComfyUI 的 API 工作流，或可转换的界面工作流');
    const text = JSON.stringify(api);
    if (builtin || text.includes('"%prompt%"')) {
        const fill = x => {
            if (typeof x === 'string' && /^%[a-z_]+%$/.test(x)) { const k = x.slice(1,-1); if (!(k in v)) throw new Error('工作流占位符没有对应参数：' + x); return v[k]; }
            if (Array.isArray(x)) return x.map(fill);
            if (x && typeof x === 'object') return Object.fromEntries(Object.entries(x).map(([k,val]) => [k,fill(val)]));
            return x;
        };
        return JSON.stringify(fill(api));
    }
    const wf = JSON.parse(text);
    const nodes = Object.values(wf);
    const sampler = nodes.find(n => /KSampler|SamplerCustom/i.test(n.class_type) && n.inputs?.positive);
    if (!sampler) throw new Error('工作流里没找到采样器（KSampler）节点，不知道把提示词填到哪');
    const setText = (ref, val, depth = 0) => {
        if (!Array.isArray(ref) || depth > 12) return false;
        const ins = wf[ref[0]]?.inputs;
        if (!ins) return false;
        for (const k of ['text', 'text_g', 'string', 'value', 'prompt']) {
            if (typeof ins[k] === 'string') { ins[k] = val; if (k === 'text_g' && typeof ins.text_l === 'string') ins.text_l = val; return true; }
            if (Array.isArray(ins[k]) && setText(ins[k], val, depth + 1)) return true;
        }
        for (const k of ['conditioning', 'conditioning_1', 'conditioning_to', 'conditioning_from', 'positive', 'cond']) if (Array.isArray(ins[k]) && setText(ins[k], val, depth + 1)) return true;
        return false;
    };
    if (!setText(sampler.inputs.positive, v.prompt)) throw new Error('顺着采样器找不到正面提示词的文字框');
    if (sampler.inputs.negative && !setText(sampler.inputs.negative, v.negative_prompt)) throw new Error('顺着采样器找不到负面提示词的文字框');
    for (const n of nodes) {
        if (/Sampler/i.test(n.class_type)) { if ('seed' in n.inputs && !Array.isArray(n.inputs.seed)) n.inputs.seed = v.seed; if ('noise_seed' in n.inputs && !Array.isArray(n.inputs.noise_seed)) n.inputs.noise_seed = v.seed; }
        if (/RandomNoise/.test(n.class_type) && 'noise_seed' in n.inputs) n.inputs.noise_seed = v.seed;
        if (/^Empty.*Latent/i.test(n.class_type)) { if (!Array.isArray(n.inputs.width)) n.inputs.width = v.width; if (!Array.isArray(n.inputs.height)) n.inputs.height = v.height; }
    }
    return JSON.stringify(wf);
}
async function comfyGenerate(opts, s) {
    const url = comfyUrl(s);
    if (!url) throw new Error('还没填 ComfyUI 地址，到智库「Comfy」页填');
    const custom = String(s.comfyWf || '');
    if (!custom && !String(s.comfyModel || '').trim()) throw new Error('还没选 ComfyUI 模型，到智库「Comfy」页连上后选一个');
    const artist = s.comfyArtist || 'plain';
    const cs = opts.chars || [];
    const positive = naiToSd([opts.positive, ...cs.map(c => c.prompt), s.comfyQuality ?? COMFY_Q].filter(Boolean).join(', '), artist);
    const negative = naiToSd([s.comfyNeg ?? COMFY_UC, opts.negative, ...cs.map(c => c.uc)].filter(Boolean).join(', '), artist);
    const w = Math.round((Number(opts.width || s.novelai_width) || 832) / 8) * 8;
    const h = Math.round((Number(opts.height || s.novelai_height) || 1216) / 8) * 8;
    const sd = Number(opts.seed ?? s.comfySeed);
    const seed = String(opts.seed ?? s.comfySeed ?? '').trim() !== '' && Number.isSafeInteger(sd) && sd >= 0 ? sd : Math.floor(Math.random() * 4294967294) + 1;
    const vals = { prompt: positive, negative_prompt: negative, model: String(s.comfyModel || '').trim(), width: w, height: h, seed, steps: Number(s.comfySteps) || 28, scale: Number(s.comfyCfg) || 6, sampler: s.comfySampler || 'euler_ancestral', scheduler: s.comfyScheduler || 'normal', denoise: 1, clip_skip: -2 };
    let api = COMFY_WORKFLOW;
    if (custom) {
        try { api = JSON.parse(String(s.comfyWfApi || '')); } catch { throw new Error('选的工作流没读好，到「Comfy」页重新选一次'); }
    }
    const wf = fillWorkflow(api, vals, !custom);
    const r = await comfyPost('generate', { url, prompt: `{"prompt": ${wf}}` });
    const { format, data } = await r.json();
    if (typeof data !== 'string' || !data.trim()) throw new Error('ComfyUI 没有返回图片数据');
    const sent = { prompt: positive, negative, size: `${w}×${h}`, chars: [], seed, model: 'ComfyUI · ' + (custom ? custom.replace(/^\w+:/, '') : vals.model), director: 0 };
    return { image: `data:image/${format || 'png'};base64,${data}`, sent };
}
/** 选工作流：内置 / ComfyUI 里存的 / 电脑上的文件；选的时候就转好格式存下来 */
async function comfyUseWorkflow(kind, name = '', raw = null) {
    const s = settings();
    const seq = ++comfyWorkflowSeq, url = comfyUrl();
    if (!kind) { s.comfyWf = ''; s.comfyWfApi = ''; save(); return; }
    const wf = raw ?? await comfyLoadWorkflow(name);
    const info = Array.isArray(wf?.nodes) ? await comfyObjectInfo(url) : null;
    const api = uiToApi(wf, info);
    if (!api || typeof api !== 'object' || !Object.keys(api).length) throw new Error('这个文件不像 ComfyUI 工作流');
    fillWorkflow(api, { prompt: 'x', negative_prompt: 'x', model: 'test', width: 832, height: 1216, seed: 1, steps: 28, scale: 6, sampler: 'euler', scheduler: 'normal', denoise: 1, clip_skip: -2 }, false);
    if (seq !== comfyWorkflowSeq || url !== comfyUrl()) return;
    s.comfyWf = kind + ':' + name; s.comfyWfApi = JSON.stringify(api); save();
}
async function generateRequest(opts) {
    const s = settings();
    if (opts.backend === 'comfy') {
        if (opts.i2i?.image) throw new Error('ComfyUI 通道暂不支持这里的垫图，请使用 NovelAI 通道');
        return comfyGenerate(opts, s);
    }
    if (!opts.comic && s.naiMode === 'site' && String(s.naiSiteSimple) === 'true') {
        const cs = opts.chars || [];
        opts = {
            ...opts, chars: [], director: null,
            positive: cs.length ? [opts.positive, ...cs.map(c => c.prompt)].filter(Boolean).join(', ') : opts.positive,
            negative: cs.length ? [opts.negative, ...cs.map(c => c.uc)].filter(Boolean).join(', ') : opts.negative,
        };
    }
    const model = opts.comic ? 'nai-diffusion-5-full' : s.novelaimode;
    if (opts.comic && s.naiMode === 'tavern') throw new Error('漫画要用自己的 NovelAI key：酒馆通道画不了分人物和画进图里的文字。到智库「设置 → NovelAI」改成自己填 key');
    const params = buildParameters(opts);
    // 垫图（img2img）：底图已经裁成这次的尺寸
    if (opts.i2i?.image) {
        if (s.naiMode === 'tavern') throw new Error('「用酒馆里的 key」不能垫图，到智库设置 → NovelAI 改成「填我的 key」');
        params.image = opts.i2i.image;
        const unit = (v, fallback) => v != null && Number.isFinite(Number(v)) ? Math.max(0, Math.min(1, Number(v))) : fallback;
        params.strength = unit(opts.i2i.strength, 0.7);
        params.noise = unit(opts.i2i.noise, 0);
        params.extra_noise_seed = params.seed;
    }
    const sent = {
        prompt: opts.positive, negative: opts.negative,
        size: `${params.width}×${params.height}`,
        chars: (opts.chars || []).map(c => c.prompt),
        seed: params.seed,
        model,
        director: params.director_reference_images_cached?.length || 0,
        ...(opts.i2i?.image ? { i2i: { strength: params.strength, noise: params.noise } } : {}),
    };
    if (s.naiMode === 'tavern') {
        const body = {
            prompt: opts.positive, model, sampler: params.sampler, scheduler: params.noise_schedule, steps: params.steps, scale: params.scale,
            width: params.width, height: params.height, negative_prompt: opts.negative, decrisper: false,
            variety_boost: !!params.skip_cfg_above_sigma, sm: false, sm_dyn: false, seed: params.seed,
        };
        if (model.includes('nai-diffusion-5')) { body.tag_hint_uc_preset = params.tag_hint_uc_preset; body.tag_hint_qt = 1; delete body.scheduler; }
        const r = await http('/api/novelai/generate-image', { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify(body) });
        const text = await r.text();
        if (!r.ok) throw Object.assign(new Error(explain(r.status, text, true)),{status:r.status,retryAfter:r.headers?.get('Retry-After'),retryable:r.status===500});
        let b64 = text.trim();
        try { const j = JSON.parse(b64); b64 = j.images?.[0] || j.image || j.data || b64; } catch { /* 原样就是 base64 */ }
        return { image: toDataUrl(b64), sent };
    }
    const key = authKey();
    const r = await http(siteUrl('/ai/generate-image'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: '*/*', ...(key ? { Authorization: 'Bearer ' + key } : {}) },
        body: JSON.stringify({ input: opts.positive, model, action: opts.i2i?.image ? 'img2img' : 'generate', parameters: params, use_new_shared_trial: true }),
    });
    const buf = new Uint8Array(await r.arrayBuffer());
    if (!r.ok) throw Object.assign(new Error(explain(r.status, new TextDecoder().decode(buf))),{status:r.status,retryAfter:r.headers?.get('Retry-After')});
    return { image: await imageFromResponse(buf), sent };
}

function toDataUrl(b64) {
    b64 = String(b64 || '').trim();
    if (!b64) throw new Error('NovelAI 没有返回图片');
    return b64.startsWith('data:') ? b64 : 'data:image/png;base64,' + b64;
}

/** 把常见的错误码翻成人话 */
function explain(status, text, viaTavern = false) {
    let msg = text;
    try { const j = JSON.parse(text); msg = j.message || j.error?.message || (typeof j.error === 'string' ? j.error : JSON.stringify(j.error)) || text; } catch { /* 不是 JSON */ }
    msg = String(msg || '').slice(0, 200);
    if (status === 401) return viaTavern ? '酒馆里的 NovelAI key 不对或没填（酒馆的「API 连接」→ NovelAI）' : 'NovelAI key 不对，到「设置」里重新填';
    if (status === 402) return 'NovelAI 点数不够，或者订阅不支持这个尺寸/步数';
    if (status === 429) return 'NovelAI 说太快了，同一个账号一次只能生成一张，等上一张出来再试';
    if (status === 400) return '参数不对：' + msg;
    if (status >= 500) return 'NovelAI 服务器出错了，过一会再试（' + status + '）' + (viaTavern ? '。用酒馆里的 key 时，请求太快也会显示成这个' : '');
    return `生成失败（${status}）：${msg}`;
}

// ───────────── 解压返回的 zip ─────────────

async function imageFromResponse(u8) {
    const isZip = u8[0] === 0x50 && u8[1] === 0x4b;
    const isPng = u8[0] === 0x89 && u8[1] === 0x50;
    if (isPng) return 'data:image/png;base64,' + toB64(u8);
    if (!isZip) {
        const t = new TextDecoder().decode(u8.slice(0, 2000)).trim();
        if (t.startsWith('{')) { try { const j = JSON.parse(t); if (j.images?.[0]) return toDataUrl(j.images[0]); throw new Error(j.message || j.error?.message || (typeof j.error === 'string' ? j.error : JSON.stringify(j.error)) || t.slice(0, 150)); } catch (e) { throw e; } }
        if (t.startsWith('iVBOR')) return toDataUrl(t);
        if (/^<|<html/i.test(t)) throw new Error('站点返回的是网页，不是图片。检查一下地址对不对');
        throw new Error('返回的不是图片：' + t.slice(0, 120));
    }
    const file = await unzipFirstImage(u8);
    return 'data:image/png;base64,' + toB64(file);
}

function toB64(u8) {
    let s = '';
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return btoa(s);
}

/** 只认 zip 里的第一张图（NovelAI 返回的就是一个 image_0.png） */
async function unzipFirstImage(u8) {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    // 找中央目录结尾
    let eocd = -1;
    for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new Error('图片压缩包坏了');
    const count = dv.getUint16(eocd + 10, true);
    let p = dv.getUint32(eocd + 16, true);
    for (let n = 0; n < count; n++) {
        if (dv.getUint32(p, true) !== 0x02014b50) break;
        const method = dv.getUint16(p + 10, true);
        const csize = dv.getUint32(p + 20, true);
        const nameLen = dv.getUint16(p + 28, true), extraLen = dv.getUint16(p + 30, true), commentLen = dv.getUint16(p + 32, true);
        const local = dv.getUint32(p + 42, true);
        const name = new TextDecoder().decode(u8.subarray(p + 46, p + 46 + nameLen)).toLowerCase();
        p += 46 + nameLen + extraLen + commentLen;
        if (!/\.(png|jpe?g|webp)$/.test(name)) continue;
        const lName = dv.getUint16(local + 26, true), lExtra = dv.getUint16(local + 28, true);
        const start = local + 30 + lName + lExtra;
        const data = u8.subarray(start, start + csize);
        if (method === 0) return data;
        if (method === 8) {
            const ds = new DecompressionStream('deflate-raw');
            const out = await new Response(new Blob([data]).stream().pipeThrough(ds)).arrayBuffer();
            return new Uint8Array(out);
        }
        throw new Error('不认识的压缩方式 ' + method);
    }
    throw new Error('压缩包里没有图片');
}

// ───────────── 测试 key、查点数 ─────────────

/** 返回 { ok, text } */
async function testConnection() {
    const s = settings();
    try {
        if (s.naiMode === 'tavern') {
            const r = await http('/api/novelai/status', { method: 'POST', headers: getRequestHeaders(), body: '{}' });
            if (!r.ok) return { ok: false, text: '酒馆里没填 NovelAI key，或者 key 不对（酒馆的「API 连接」→ NovelAI）' };
            const j = await r.json().catch(() => ({}));
            return { ok: true, text: '能用' + anlasText(j) };
        }
        if (s.naiMode === 'site') {
            if (!s.naiSite.trim()) return { ok: false, text: '没填站点地址' };
            return { ok: true, text: '第三方站点没法提前检查，直接去生图页试一张' };
        }
        const key = authKey();
        const r = await http('https://api.novelai.net/user/subscription', { headers: { Authorization: 'Bearer ' + key } });
        if (r.status === 401) return { ok: false, text: 'key 不对' };
        if (!r.ok) return { ok: false, text: `NovelAI 返回 ${r.status}` };
        return { ok: true, text: '能用' + anlasText(await r.json()) };
    } catch (e) {
        // 「Failed to fetch」：查余额的 api.novelai.net 被网络或浏览器拦了。生图走 image.novelai.net，不一定受影响
        if (s.naiMode === 'key' && e instanceof TypeError) return { ok: true, warn: true, text: '查不到余额：这台设备连不上 api.novelai.net（网络或浏览器拦了）。生图走的是另一个地址，去生图页试一张，能出图就是能用' };
        return { ok: false, text: '连不上：' + (e?.message || e) };
    }
}
function anlasText(j) {
    const t = j?.trainingStepsLeft || j?.subscription?.trainingStepsLeft;
    if (!t) return '';
    const n = (t.fixedTrainingStepsLeft || 0) + (t.purchasedTrainingSteps || 0);
    return ` · 剩 ${n.toLocaleString()} 点`;
}

// ───────────── 从智绘姬搬设置 ─────────────

/** 智绘姬装着的话，把它的 NovelAI key 和生图参数搬过来。返回搬了几项 */
function importFromZhihuiji() {
    const z = extension_settings['st-chatu8'];
    if (!z) return 0;
    const s = settings();
    let n = 0;
    const key = String(z.novelaiApi || '').trim();
    if (key && key !== '000000' && !s.naiKey) { s.naiKey = key; n++; }
    if (z.novelaisite && z.novelaisite !== '官网' && z.novelaiOtherSite && !s.naiSite) { s.naiSite = z.novelaiOtherSite; s.naiSiteKey = key; s.naiMode = 'site'; n++; }
    for (const k of ['novelaimode', 'novelai_width', 'novelai_height', 'novelai_steps', 'nai3Scale', 'novelai_sampler', 'Schedule', 'cfg_rescale', 'UCP_novelai']) {
        if (z[k] !== undefined && z[k] !== '') { s[k] = String(z[k]); n++; }
    }
    if (z.AQT_novelai !== undefined) s.AQT_novelai = z.AQT_novelai ? 'on' : '';
    save();
    return n;
}

// ───────────── 氛围（Vibe） ─────────────

/** 每个模型的氛围要单独编码 */
function encKey(model = settings().novelaimode) {
    if (model.includes('4-5-curated')) return 'v4-5curated';
    if (model.includes('4-5-full')) return 'v4-5full';
    if (model.includes('4-curated')) return 'v4curated';
    if (model.includes('4-full')) return 'v4full';
    if (model.includes('diffusion-5')) return model.includes('curated') ? 'v5curated' : 'v5full';
    return '';
}
function vibeSupported() {
    const s = settings();
    return s.naiMode !== 'tavern' && s.novelaimode !== 'nai-diffusion-3' && !String(s.novelaimode).includes('diffusion-5');
}

/** 把一张图编码成当前模型能用的氛围（NovelAI 会扣一点点数）。imageB64 不带 data: 前缀 */
function encodeVibe(...args){return __naiGate.run(()=>encodeVibeRequest(...args));}
/** 氛围图统一转成 PNG（长边不超过 1024）再编码：手机图片常是 JPEG / WebP，NovelAI 编码时可能直接 500 */
async function vibePng(b64) {
    try {
        const img = await new Promise((ok, bad) => { const i = new Image(); i.onload = () => ok(i); i.onerror = bad; i.src = 'data:image/png;base64,' + b64; });
        const sc = Math.min(1, 1024 / Math.max(img.naturalWidth, img.naturalHeight));
        const c = DOC.createElement('canvas');
        c.width = Math.max(1, Math.round(img.naturalWidth * sc)); c.height = Math.max(1, Math.round(img.naturalHeight * sc));
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        return c.toDataURL('image/png').split(',')[1];
    } catch { return b64; }
}
async function encodeVibeRequest(imageB64, infoExtracted = 1, model = settings().novelaimode) {
    const key = authKey();
    const image = await vibePng(imageB64);
    const send = () => http(siteUrl('/ai/encode-vibe'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: 'Bearer ' + key } : {}) },
        body: JSON.stringify({ image, information_extracted: infoExtracted, model }),
    });
    let r = await send();
    if (r.status >= 500) { await new Promise(ok => setTimeout(ok, 2000)); r = await send(); }
    const buf = new Uint8Array(await r.arrayBuffer());
    if (!r.ok) throw Object.assign(new Error((r.status === 402 ? '账号 Anlas 不够了：氛围每张图第一次用要先编码，NovelAI 每张扣约 2 点 Anlas，Opus 也要扣（编码会按模型保存，复用已保存的编码不再扣编码费）。去官网看看 Anlas 余额，或者导入官网导出的 .naiv4vibe 文件' : explain(r.status, new TextDecoder().decode(buf))) + (settings().naiMode === 'site' ? '。第三方站点可能不支持氛围' : '')),{status:r.status,retryAfter:r.headers?.get('Retry-After')});
    if (buf.length < 100) throw new Error('编码结果不对，可能 key 或站点有问题');
    return toB64(buf);
}

/** 读 NovelAI 官网导出的 .naiv4vibe 文件 */
function parseVibeFile(json) {
    const encodings = {};
    for (const [k, v] of Object.entries(json.encodings || {})) {
        const first = Object.values(v || {})[0];
        const e = first?.encoding;
        if (e) encodings[k] = typeof e === 'string' ? e : e.data || '';
    }
    if (!Object.keys(encodings).length && !json.image) throw new Error('这个文件里没有氛围数据');
    return {
        name: json.name || '',
        image: json.thumbnail || json.image || '',
        strength: Number(json.importInfo?.strength ?? 0.6),
        info: Number(json.importInfo?.information_extracted ?? 1),
        encodings,
    };
}

function charRefSupported() {
    const s = settings();
    return s.naiMode !== 'tavern' && s.novelaimode.includes('4-5') && !(s.naiMode === 'site' && String(s.naiSiteSimple) === 'true');
}

// ───────────── 局部重绘 ─────────────

function inpaintModel(model = settings().novelaimode) {
    if (model === 'nai-diffusion-3') return 'nai-diffusion-3-inpainting';
    if (model.includes('nai-diffusion-5')) return 'nai-diffusion-5-full-inpainting';
    return 'nai-diffusion-4-5-curated-inpainting';
}

/** image、mask 都是不带前缀的 PNG base64（mask：白色 = 重画） */
function inpaint(opts){return __naiGate.run(()=>inpaintRequest(opts)).catch(e=>{throw netError(e);});}
async function inpaintRequest({ image, mask, prompt, negative, width, height, strength = 0.7 }) {
    const s = settings();
    if (s.naiMode === 'tavern') throw new Error('「用酒馆里的 key」不能局部重绘，到设置里改成「填我的 key」');
    const key = authKey();
    const model = inpaintModel();
    const seed = Number(s.novelai_seed) > 0 ? Number(s.novelai_seed) : randomSeed();
    const isV5 = model.includes('nai-diffusion-5');
    const parameters = {
        width, height, scale: Number(s.nai3Scale) || 5, sampler: s.novelai_sampler || 'k_dpmpp_2m_sde', steps: Number(s.novelai_steps) || 28,
        seed, n_samples: 1, image, mask, params_version: isV5 ? 4 : 3, prefer_brownian: true, autoSmea: false,
        strength: 0.7, noise: 0, extra_noise_seed: seed, add_original_image: false, cfg_rescale: Number(s.cfg_rescale) || 0, controlnet_strength: 1,
        deliberate_euler_ancestral_bug: false, dynamic_thresholding: false, legacy: false, legacy_uc: false, legacy_v3_extend: false,
        normalize_reference_strength_multiple: false, noise_schedule: s.Schedule || 'karras', qualityToggle: true, skip_cfg_above_sigma: 19,
        ucPreset: 0, use_coords: false, image_format: 'png', img2img: { strength, color_correct: true }, inpaintImg2ImgStrength: strength,
        negative_prompt: negative,
        v4_prompt: { caption: { base_caption: prompt, char_captions: [] }, use_coords: false, use_order: true },
        v4_negative_prompt: { caption: { base_caption: negative, char_captions: [] }, use_coords: false, use_order: true },
    };
    if (isV5) delete parameters.noise_schedule;
    const r = await http(siteUrl('/ai/generate-image'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: '*/*', ...(key ? { Authorization: 'Bearer ' + key } : {}) },
        body: JSON.stringify({ action: 'infill', input: prompt, model, parameters, use_new_shared_trial: true }),
    });
    const buf = new Uint8Array(await r.arrayBuffer());
    if (!r.ok) throw Object.assign(new Error(explain(r.status, new TextDecoder().decode(buf))),{status:r.status,retryAfter:r.headers?.get('Retry-After')});
    return imageFromResponse(buf);
}

return { comfyReady, chatBackend, comfyAutoConfig, comfyConnect, comfyUseWorkflow, naiToSd, uiToApi, fillWorkflow, COMFY_Q, COMFY_UC, stopQueue:()=>__naiGate.stop(), MODELS, SAMPLERS, SCHEDULES, settings, save, isReady, ucpValue, buildParameters, generate, unzipFirstImage, testConnection, importFromZhihuiji, encKey, vibeSupported, encodeVibe, parseVibeFile, charRefSupported, inpaintModel, inpaint };
})();

// ───── engine.js ─────
const __mod_engine = (() => {
/**
 * 生图引擎：直接调用 NovelAI（见 nai.js），不再需要智绘姬。
 */
const { getData, commit, uploadImage, urlToDataUrl } = __mod_store;
const M = __mod_model;
const N = __mod_nai;
const runtime = {
    lastSent: null,   // 最近一次真正发给 NovelAI 的内容（给界面展示）
    busy: 0,
};

/** 生图设置（NovelAI key、模型、尺寸……） */
function stSettings() { return N.settings(); }

/** 正面、负面最后会被自动加上的质量词和负面预设 */
function extras(s = N.settings()) {
    const r = qualityPresets({ ...s, UCP_novelai: N.ucpValue(s) });
    if (String(s.UCP_novelai) === 'custom') r.ucp = String(s.UCP_custom || '').trim();
    return r;
}

const stripNotes = t => { let r = String(t || ''), prev; do { prev = r; r = r.replace(/（[^（）]*）/g, ''); } while (r !== prev); return r; };
const joinTags = arr => arr.map(x => stripNotes(x).trim().replace(/^,+|,+$/g, '').trim()).filter(Boolean).join(', ');

/**
 * 拼出最终提示词：
 * 正面 = 正面提示词 + 质量词
 * 负面 = 负面预设 + 负面提示词
 */
/** 去掉 text 里已经在前面出现过的词（不看权重），质量词、固定提示词不会和正面重复 */
function dropRepeats(text, ...before) {
    const seen = new Set(M.tokenize(before.filter(Boolean).join(', ')).map(t => t.text.toLowerCase()));
    return M.tokenize(text).filter(t => { const k = t.text.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; })
        .map(t => t.raw || (Math.abs(t.weight - 1) < 0.001 ? t.text : `${M.fmtWeight(t.weight)}::${t.text}::`)).join(', ');
}
/**
 * 正面 = 正面提示词 + 固定提示词 + 质量词（后两个去掉和前面重复的）
 * 负面 = 负面预设 + 负面提示词
 */
/** (tag:1.3) → 1.3::tag::；不带数字的括号（比如 rourou (been)）不动 */
function sdWeights(text) {
    let t = String(text || ''), prev;
    do { prev = t; t = t.replace(/\(([^()]*?(?:\([^()]*\)[^()]*?)*?):\s*(-?\d+(?:\.\d+)?)\s*\)/g, (_, tag, w) => `${Number(w)}::${tag.trim()}::`); } while (t !== prev);
    return t;
}
function composeStudio({ pos = '', neg = '', scene = '' }, s = N.settings()) {
    pos = sdWeights(pos); neg = sdWeights(neg); scene = sdWeights(scene);
    const { aqt, ucp } = extras(s);
    const fur = String(s.addFurryDataset) === 'true' ? 'fur dataset' : '';
    let negative = joinTags([ucp, neg]);
    const tags = negative.split(',').map(t => t.trim()).filter(Boolean);
    if (tags.some(t => t.toLowerCase() === 'nsfw')) negative = ['nsfw', ...tags.filter(t => t.toLowerCase() !== 'nsfw')].join(', ');
    const sc = dropRepeats(scene, pos);
    return { positive: joinTags([fur, pos, sc, dropRepeats(aqt, pos, sc)]), negative, aqt, ucp };
}

/** 当前氛围组 → 请求里的参考数据；没开或不支持就返回 null */
async function vibeRefs() {
    const d = getData();
    const g = d.vibeGroups?.[d.vibeActive];
    if (!g?.vibes?.length) return null;
    if (!N.vibeSupported()) {
        const m = N.settings().novelaimode;
        if (String(m).includes('diffusion-5') && !globalThis.__zkV5VibeTold) { globalThis.__zkV5VibeTold = 1; toastr.info('NAI 5 还不支持氛围，用 5 的时候不带氛围出图（不会产生氛围编码费用）。想带氛围请换回 4.5。', '氛围', { timeOut: 6000 }); }
        return null;
    }
    const key = N.encKey();
    const modelName = (N.MODELS.find(x => x[0] === N.settings().novelaimode)?.[1] || N.settings().novelaimode).replace('NAI Diffusion ', '');
    const keyName = k => ({ 'v4-5full': '4.5 Full', 'v4-5curated': '4.5 Curated', v4full: '4 Full', v4curated: '4 Curated' })[k] || k;
    const list = [];
    const failed = [];
    let lastErr = null;
    for (const v of g.vibes) {
        v.encodings ||= {};
        if (!v.encodings[key]) {
            if (!v.path) continue; // 官网文件导入的，没有原图，只能用文件里带的模型
            try {
                const b64 = (await urlToDataUrl('/' + v.path.replace(/^\/+/, ''))).split(',')[1];
                v.encodings[key] = await N.encodeVibe(b64, v.info || 1);
                commit({ silent: true });
            } catch (e) { failed.push(v.name || '参考图'); lastErr = e; continue; } // 编码失败：这张图先不带它，别让整张图失败
        }
        list.push({ data: v.encodings[key], strength: Number(v.strength ?? 0.6) });
    }
    if (failed.length) {
        const had = [...new Set(g.vibes.flatMap(v => Object.keys(v.encodings || {}).filter(k => v.encodings[k])))].map(keyName);
        toastr.warning(`氛围「${failed.join('、')}」要按 ${modelName} 编码，编码失败，这张先不带${list.length ? '它' : '氛围'}出图。${had.length ? `（这组已经编码过的模型：${had.join('、')}。换了模型就得重新编码一次）` : '（这几张还没编码成功过）'}：${lastErr?.message || ''}`, '氛围', { timeOut: 9000 });
    }
    if (!list.length) return null;
    const total = list.reduce((a, b) => a + b.strength, 0);
    const is45 = N.settings().novelaimode.includes('4-5');
    const strengths = (g.normalize && is45) || total <= 1 ? list.map(x => x.strength) : list.map(x => x.strength / total);
    return {
        images: list.map(x => ({ cache_secret_key: (crypto.randomUUID?.() || M.uid('k')), data: x.data })),
        strengths, normalize: !!g.normalize,
    };
}

/** 当前角色参考组 → 请求里的数据 */
/** groupIds：角色页里给出场角色绑定的组；不给就不用角色参考 */
async function charRefs(groupIds) {
    const d = getData();
    const groups = (groupIds || []).map(id => d.charRefGroups?.[id]).filter(g => g?.refs?.length);
    if (!groups.length || !N.charRefSupported()) return null;
    const out = [];
    for (const r of groups.flatMap(g => g.refs)) {
        r.cache ||= '';
        const data = (await urlToDataUrl('/' + r.path.replace(/^\/+/, ''))).split(',')[1];
        out.push({ key: crypto.randomUUID?.() || M.uid('k'), data, type: r.type || 'character', strength: Number(r.strength ?? 0.6) });
    }
    return out.length ? out : null;
}

async function run(opts) {
    if (opts.backend === 'comfy') { if (!N.comfyReady()) throw new Error('还没连上 ComfyUI，到智库「Comfy」页看看'); opts.noVibe = true; opts.director = null; }
    else if (!N.isReady()) throw new Error('还没填 NovelAI key，到「设置」最上面填');
    runtime.busy++;
    try {
        if (!opts.noVibe && opts.director === undefined) opts.director = await charRefs();
        if (!opts.noVibe && !opts.director && opts.refs === undefined) opts.refs = await vibeRefs();
        const r = await N.generate(opts);
        const vg = getData().vibeGroups?.[getData().vibeActive];
        runtime.lastSent = { ...r.sent, vibes: opts.refs?.images?.length ? { name: vg?.name || '', n: opts.refs.images.length } : null, director: r.sent.director ?? (opts.director?.length || 0) };
        return r.image;
    } finally {
        runtime.busy--;
    }
}

/** 生图页 */
async function generate({ pos, neg, scene = '', width, height, i2i }) {
    const { positive, negative } = composeStudio({ pos, neg, scene });
    return run({ positive, negative, width, height, i2i });
}

/** 已经拼好的提示词（聊天生图用，可带分角色） */
async function generateFull({ positive, negative, chars = [], width, height, director, backend, i2i }) {
    return run({ positive, negative, chars, width, height, director, backend, i2i });
}

/** 生成一张例图：画师串 + 例图模板（不带氛围和角色） */
async function generateSample({ fixed, template, neg = '' }) {
    const { positive, negative } = composeStudio({ pos: joinTags([fixed, template.positive]), neg: joinTags([neg, template.negative]) });
    const o = getData().options;
    const seed = o.sampleSameSeed === false ? undefined : (Number(o.sampleSeed) > 0 ? Number(o.sampleSeed) : (o.sampleSeed = Math.floor(Math.random() * 4294967294) + 1));
    return run({ noVibe: true, positive, negative, width: Number(template.width) || undefined, height: Number(template.height) || undefined, seed });
}

// ───────────── 切换 ─────────────

/** 聊天里生成一张后：「只用一次」换回原来的；「每生成一张就换一个」换下一个 */
function afterChatImage() {
    const d = getData();
    if (d.oneShot) {
        const back = d.previousActive && M.resolveTicket(d, d.previousActive) ? d.previousActive : null;
        setActive(back);
        toastr.info(back ? `只用一次：已换回「${M.ticketName(d, back)}」` : '只用一次：已取消画师串', '智库', { timeOut: 2000 });
        return;
    }
    if (d.rotate && d.rotate !== 'off') {
        const next = M.nextInRotation(d);
        if (next) setActive(next);
    }
}

function setActive(ref, { oneShot = false } = {}) {
    const d = getData();
    if (oneShot) {
        if (!d.oneShot) d.previousActive = d.active;
        d.oneShot = true;
    } else {
        d.oneShot = false;
        d.previousActive = null;
    }
    d.active = ref || null;
    if (ref) M.touchRecent(d, ref);
    commit();
}

// ───────────── 绑定角色卡 ─────────────


function currentCharacterKey() {
    const c = ctx();
    if (c.groupId) return 'group:' + c.groupId;
    const ch = c.characters?.[c.characterId];
    return ch?.avatar ? 'char:' + ch.avatar : '';
}
function currentCharacterName() {
    const c = ctx();
    if (c.groupId) return c.groups?.find(g => g.id === c.groupId)?.name || '这个群聊';
    return c.characters?.[c.characterId]?.name || '';
}
function bindCurrentCharacter(ref) {
    const key = currentCharacterKey();
    if (!key) return false;
    const d = getData();
    if (ref) {
        d.bindings[key] = ref;
        if (!d.bindingActive) {
            // 绑定前在用的那串（选的时候已经换成 ref 了，就从最近用过里找上一串）
            d.beforeBinding = !M.sameRef(d.active, ref) ? d.active : (d.recent.find(r => !M.sameRef(r, ref)) || null);
            d.bindingActive = true;
        }
    } else delete d.bindings[key];
    commit();
    return true;
}
function boundTicketForCurrent() {
    const key = currentCharacterKey();
    return key ? getData().bindings[key] || null : null;
}
function applyBindingOnChatChange() {
    const d = getData();
    const ref = boundTicketForCurrent();
    if (ref && M.resolveTicket(d, ref)) {
        if (!d.bindingActive) { d.beforeBinding = d.active; d.bindingActive = true; }
        if (!M.sameRef(ref, d.active)) {
            setActive(ref);
            toastr.info(`这个角色卡绑定了画师串「${M.ticketName(d, ref)}」，已自动切换`, '智库', { timeOut: 2500 });
        } else commit({ silent: true });
        return;
    }
    if (d.bindingActive) {
        const back = d.beforeBinding && M.resolveTicket(d, d.beforeBinding) ? d.beforeBinding : null;
        d.bindingActive = false;
        d.beforeBinding = null;
        if (!(back ? M.sameRef(back, d.active) : !d.active)) {
            setActive(back);
            toastr.info(back ? `离开绑定的角色卡，换回「${M.ticketName(d, back)}」` : '离开绑定的角色卡，已取消画师串', '智库', { timeOut: 2500 });
        } else commit({ silent: true });
    }
}


const ctx = () => SillyTavern.getContext();

async function saveImageTo(ref, dataUrl, { nsfw = false, templateId = '' } = {}) {
    const d = getData();
    const t = M.resolveTicket(d, ref);
    if (!t) throw new Error('这个画师 / 画师组已经被删掉了');
    const id = M.uid('i_');
    const { path } = await uploadImage(dataUrl, `${ref.type}_${ref.id}_${id}`);
    t.item.images.push({ id, path, nsfw: !!nsfw, template: templateId, createdAt: Date.now() });
    commit();
    return id;
}

async function makeSampleFor(ref, templateId) {
    const d = getData();
    const tpl = d.templates[templateId] || d.templates.sfw_bust;
    const fixed = M.ticketString(d, ref);
    const image = await generateSample({ fixed, template: tpl, neg: M.ticketNeg(d, ref) });
    await saveImageTo(ref, image, { nsfw: tpl.nsfw, templateId: tpl.id });
    return image;
}

function createBatch(jobs, { onUpdate } = {}) {
    const state = {
        jobs: jobs.map(j => ({ ...j, status: 'wait', error: '', image: '' })),
        paused: false, stopped: false, running: false,
    };
    const tick = () => onUpdate?.(state);
    state.run = async () => {
        if (state.running) return;
        state.running = true; state.stopped = false; state.paused = false; tick();
        for (const job of state.jobs) {
            if (state.stopped) break;
            while (state.paused && !state.stopped) await new Promise(r => setTimeout(r, 400));
            if (state.stopped) break;
            if (job.status === 'done' || job.status === 'skip') continue;
            job.status = 'run'; tick();
            try {
                job.image = await makeSampleFor(job.ref, job.templateId);
                job.status = 'done';
            } catch (e) {
                job.status = 'error'; job.error = e.message || String(e);
            }
            tick();
        }
        state.running = false; tick();
    };
    state.pause = () => { state.paused = !state.paused; tick(); };
    state.stop = () => { state.stopped = true; state.paused = false; tick(); };
    return state;
}

// ───────────── 聊天 ─────────────

async function insertIntoLastMessage(dataUrl) {
    const c = ctx();
    const idx = c.chat.length - 1;
    if (idx < 0) throw new Error('当前没有聊天楼层');
    const { url } = await uploadImage(dataUrl, `chat_${Date.now()}`);
    const msg = c.chat[idx];
    msg.mes = `${msg.mes || ''}\n\n<img src="${url}" alt="画师库生成">`;
    c.updateMessageBlock(idx, msg);
    await c.saveChat();
}

function canOpenVibeEditor() { return false; }
// ───────────── 智绘姬自动加的质量词和负面预设（照抄智绘姬，保证显示的和发送的一样） ─────────────

function qualityPresets(settings3) {
  let aqt = "";
  if (settings3.AQT_novelai != "" && settings3.novelaimode == "nai-diffusion-4-curated-preview") {
    aqt = "rating:general, best quality, very aesthetic, absurdres";
  } else if (settings3.AQT_novelai != "" && settings3.novelaimode == "nai-diffusion-4-full") {
    aqt = "no text, best quality, very aesthetic, absurdres";
  } else if (settings3.AQT_novelai != "" && settings3.novelaimode == "nai-diffusion-4-5-full") {
    aqt = "very aesthetic, masterpiece, no text";
  } else if (settings3.AQT_novelai != "" && settings3.novelaimode == "nai-diffusion-4-5-curated") {
    aqt = "very aesthetic, masterpiece, no text, -0.8::feet::, rating:general";
  } else if (settings3.AQT_novelai != "" && String(settings3.novelaimode || "").includes("nai-diffusion-5-full")) {
    aqt = "very aesthetic, amazing quality, no text";
  } else if (settings3.AQT_novelai != "" && settings3.novelaimode == "nai-diffusion-5-curated") {
    aqt = "very aesthetic, masterpiece, no text";
  } else if (settings3.AQT_novelai != "" && settings3.novelaimode == "nai-diffusion-3") {
    aqt = "best quality, amazing quality, very aesthetic, absurdres";
  }
  let ucp = "";
  if (settings3.novelaimode == "nai-diffusion-3" && settings3.UCP_novelai == "Heavy") {
    ucp = "lowres, {bad}, error, fewer, extra, missing, worst quality, jpeg artifacts, bad quality, watermark, unfinished, displeasing, chromatic aberration, signature, extra digits, artistic error, username, scan, [abstract]";
  } else if (settings3.novelaimode == "nai-diffusion-3" && settings3.UCP_novelai == "Light") {
    ucp = "lowres, jpeg artifacts, worst quality, watermark, blurry, very displeasing";
  } else if (settings3.novelaimode == "nai-diffusion-3" && settings3.UCP_novelai == "Human Focus") {
    ucp = "lowres, {bad}, error, fewer, extra, missing, worst quality, jpeg artifacts, bad quality, watermark, unfinished, displeasing, chromatic aberration, signature, extra digits, artistic error, username, scan, [abstract], bad anatomy, bad hands, @_@, mismatched pupils, heart-shaped pupils, glowing eyes";
  } else if (settings3.novelaimode == "nai-diffusion-4-full" && settings3.UCP_novelai == "Heavy") {
    ucp = "blurry, lowres, error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, multiple views, logo, too many watermarks, white blank page, blank page";
  } else if (settings3.novelaimode == "nai-diffusion-4-full" && settings3.UCP_novelai == "Light") {
    ucp = "blurry, lowres, error, worst quality, bad quality, jpeg artifacts, very displeasing, white blank page, blank page";
  } else if (settings3.novelaimode == "nai-diffusion-4-curated-preview" && settings3.UCP_novelai == "Heavy") {
    ucp = "blurry, lowres, error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, logo, dated, signature, multiple views, gigantic breasts, white blank page, blank page";
  } else if (settings3.novelaimode == "nai-diffusion-4-curated-preview" && settings3.UCP_novelai == "Light") {
    ucp = "blurry, lowres, error, worst quality, bad quality, jpeg artifacts, very displeasing, logo, dated, signature, white blank page, blank page";
  } else if (settings3.novelaimode == "nai-diffusion-4-5-curated" && settings3.UCP_novelai == "Human Focus") {
    ucp = "blurry, lowres, upscaled, artistic error, film grain, scan artifacts, bad anatomy, bad hands, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, halftone, multiple views, logo, too many watermarks, @_@, mismatched pupils, glowing eyes, negative space, blank page";
  } else if (settings3.novelaimode == "nai-diffusion-4-5-curated" && settings3.UCP_novelai == "Heavy") {
    ucp = "blurry, lowres, upscaled, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, halftone, multiple views, logo, too many watermarks, negative space, blank page";
  } else if (settings3.novelaimode == "nai-diffusion-4-5-curated" && settings3.UCP_novelai == "Light") {
    ucp = "blurry, lowres, upscaled, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, halftone, multiple views, logo, too many watermarks, negative space, blank page";
  } else if (settings3.novelaimode == "nai-diffusion-4-5-full" && settings3.UCP_novelai == "Human Focus") {
    ucp = "lowres, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, dithering, halftone, screentone, multiple views, logo, too many watermarks, negative space, blank page, @_@, mismatched pupils, glowing eyes, bad anatomy";
  } else if (settings3.novelaimode == "nai-diffusion-4-5-full" && settings3.UCP_novelai == "Heavy") {
    ucp = "lowres, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, dithering, halftone, screentone, multiple views, logo, too many watermarks, negative space, blank page";
  } else if (settings3.novelaimode == "nai-diffusion-4-5-full" && settings3.UCP_novelai == "Light") {
    ucp = "lowres, artistic error, scan artifacts, worst quality, bad quality, jpeg artifacts, multiple views, very displeasing, too many watermarks, negative space, blank page";
  } else if (settings3.novelaimode == "nai-diffusion-4-5-full" && settings3.UCP_novelai == "Furry Focus") {
    ucp = "{worst quality}, distracting watermark, unfinished, bad quality, {widescreen}, upscale, {sequence}, {{grandfathered content}}, blurred foreground, chromatic aberration, sketch, everyone, [sketch background], simple, [flat colors], ych (character), outline, multiple scenes, [[horror (theme)]], comic";
  } else if (settings3.novelaimode.includes("nai-diffusion-5") && settings3.UCP_novelai == "heavy") {
    ucp = "lowres, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, dithering, halftone, screentone, multiple views, logo, too many watermarks, negative space, blank page";
  } else if (settings3.novelaimode.includes("nai-diffusion-5") && settings3.UCP_novelai == "light") {
    ucp = "lowres, bad hands, bad anatomy, artistic error, sepia, white haze, worst quality, very displeasing, jpeg artifacts, 0::ai-generated::";
  } else if (settings3.novelaimode.includes("nai-diffusion-5") && settings3.UCP_novelai == "humanFocus") {
    ucp = "lowres, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, dithering, halftone, screentone, multiple views, logo, too many watermarks, negative space, blank page, @_@, mismatched pupils, glowing eyes, bad anatomy";
  } else if (settings3.novelaimode.includes("nai-diffusion-5") && settings3.UCP_novelai == "furryFocus") {
    ucp = "{worst quality}, distracting watermark, unfinished, bad quality, {widescreen}, upscale, {sequence}, {{grandfathered content}}, blurred foreground, chromatic aberration, sketch, everyone, [sketch background], simple, [flat colors], ych (character), outline, multiple scenes, [[horror (theme)]], comic";
  }
  return { aqt, ucp };
}

/** 局部重绘：image、mask 是 dataURL */
async function inpaint({ image, mask, pos, neg, width, height, strength }) {
    const { positive, negative } = composeStudio({ pos, neg });
    return N.inpaint({ image: image.split(',')[1], mask: mask.split(',')[1], prompt: positive, negative, width, height, strength });
}

return { afterChatImage, runtime, stSettings, extras, composeStudio, vibeRefs, charRefs, generate, generateFull, generateSample, setActive, currentCharacterKey, currentCharacterName, bindCurrentCharacter, boundTicketForCurrent, applyBindingOnChatChange, saveImageTo, makeSampleFor, createBatch, insertIntoLastMessage, canOpenVibeEditor, qualityPresets, inpaint };
})();

// ───── translate.js ─────
const __mod_translate = (() => {
/**
 * 中文 → NovelAI 英文 tag
 * 默认用酒馆现在连接的 API；也可以在设置里单独填一个。
 */
const getRequestHeaders = __shim.getRequestHeaders;
const { getData } = __mod_store;
const hasChinese = s => /[㐀-鿿豈-﫿]/.test(String(s || ''));

const SYSTEM = `你把中文的画面描述改写成 NovelAI 用的英文标签（Danbooru 风格）。
规则：
1. 只输出标签，用英文逗号加空格分隔，不要解释，不要引号，不要换行。
2. 已经是英文标签的部分原样保留，包括权重写法（比如 1.2::xxx::、{xxx}、[xxx]）和 artist: 开头的词。
3. 人物数量用 1boy / 1girl / 2boys 这类标签；「男的」「男人」写 1boy，「女的」「女孩」写 1girl。
4. 尽量用常见标签，不要编造。`;

const EXPAND = `你是 NovelAI 提示词写手。把用户给的画面描述（中文或英文都可能）写成一份完整的 NovelAI 英文标签提示词，像给插画师下单一样补全细节。
按这个顺序写，用英文逗号加空格分隔，只输出标签，不要解释，不要换行：
1. 人数和性别（1boy / 1girl / 2boys …）
2. 外貌：发型发色、眼睛、体型（用户没说就按画面合理补，不要和用户写的冲突）
3. 衣着
4. 动作、姿势、表情
5. 场景、背景、时间、天气
6. 光线、氛围
7. 构图和镜头（比如 upper body、full body、from side、close-up）
规则：
- 不要写画师（artist: 开头的词）、不要写质量词（masterpiece、best quality 之类），这些会另外加。
- 用户已经写的英文标签和权重写法（1.2::xxx::、{xxx}、[xxx]）原样保留。
- 用常见的 Danbooru 标签，总数 20 到 40 个。`;

/** 存好的 AI 接口（可以存好几个，快速切换）。'st' = 酒馆现在连接的 */
function apiProfiles() {
    const o = getData().options;
    if (!Array.isArray(o.apis)) {
        o.apis = [];
        const t = o.translate || {};
        if (t.mode === 'custom' && t.url) { o.apis.push({ id: 'api_old', name: '单独填的', url: t.url, key: t.key || '', model: t.model || '', bypass: !!t.bypass }); o.apiActive = 'api_old'; }
    }
    return o.apis;
}
function activeApiId() {
    const o = getData().options;
    const list = apiProfiles();
    return list.some(x => x.id === o.apiActive) ? o.apiActive : 'st';
}
/** 现在用哪个 API：{ url, key, model, bypass, from, st } */
function currentApi() {
    const id = activeApiId();
    if (id === 'st') return { st: true, from: '酒馆现在连接的 API' };
    const p = apiProfiles().find(x => x.id === id);
    return { url: (p.url || '').trim().replace(/\/+$/, ''), key: (p.key || '').trim(), model: (p.model || '').trim(), bypass: !!p.bypass, from: p.name };
}

function cleanOutput(raw) {
    const out = String(raw ?? '').replace(/<think>[\s\S]*?<\/think>/g, '').trim()
        .replace(/^["'`]+|["'`]+$/g, '').replace(/\n+/g, ', ').replace(/，/g, ', ');
    if (!out) throw new Error('翻译 API 返回了空内容');
    if (hasChinese(out)) throw new Error('翻译结果里还有中文，可能这个模型不太听话：' + out.slice(0, 80));
    return out;
}

/** 调一次 AI，返回原始文本（用设置里选的 API） */
/** 各个让 AI 干活的功能：[键, 名字, 在哪用] */
const AI_FNS = [['img', '看图写提示词', '生图页「看图写提示词」'], ['pose', '读姿势构图', '生图页「看图读姿势构图」'], ['tr', '中文转标签', '固定提示词、正面、角色页里写的中文'], ['scene', '聊天生图写画面', '双击段落 / 聊天里生图'], ['ill', '正文插图', '「写完再请求」读剧情插图（指令在「正文转生图提示词」里改）'], ['look', '读角色外貌', '从角色卡、人设、图片、世界书读'], ['outfit', '设计 / 读衣服', 'AI 设计、从剧情读、看图读'], ['comic', '漫画改编', '「画成漫画」「重新改编」'], ['zh', '标签翻中文', '角色页「译成中文」']];
const aiSeen = {}; // 这次打开酒馆后各功能实际用过的指令，给设置页看
function aiCfg() {
    const d = __mod_store.getData();
    const c = d.aiPresets ||= { active: 'tavern:', list: {}, fn: {}, markOn: {} };
    c.list ||= {}; c.fn ||= {}; c.markOn ||= {};
    return c;
}
/** 指令拆成「主指令」和「输出格式」：输出格式插件要靠它读回复，不让改 */
function splitFormat(sys) {
    const s = String(sys || ''), i = s.search(/只输出\s*JSON|<image> 用分段文本协议/);
    return i > 0 ? [s.slice(0, i).trim(), s.slice(i).trim()] : [s.trim(), ''];
}
/** 功能指令 + 自己加的要求 */
function fnSystem(fn, sys) {
    if (!fn) return sys;
    const [main, fmt] = splitFormat(sys);
    aiSeen[fn] = { main, fmt };
    const extra = (aiCfg().fn[fn]?.extra || []).filter(e => e.on !== false && String(e.t || '').trim());
    return [main, extra.length ? '额外要求：\n' + extra.map(e => '- ' + e.t.trim()).join('\n') : '', fmt].filter(Boolean).join('\n\n');
}
const ST_MARKERS = { chatHistory: '上下文', worldInfoBefore: '世界书（前）', worldInfoAfter: '世界书（后）', charDescription: '角色卡描述', charPersonality: '角色性格', scenario: '场景', personaDescription: '人设描述', dialogueExamples: '对话示例' };
const MARK_MACRO = { charDescription: '{{description}}', charPersonality: '{{personality}}', scenario: '{{scenario}}', personaDescription: '{{persona}}', dialogueExamples: '{{mesExamples}}' };
/** 酒馆的对话补全预设 → 条目 */
function stToEntries(p) {
    const prompts = Array.isArray(p?.prompts) ? p.prompts : [];
    const orders = Array.isArray(p?.prompt_order) ? p.prompt_order : [];
    const ord = (orders.find(o => String(o.character_id) === '100001') || orders.at(-1))?.order || prompts.map(x => ({ identifier: x.identifier, enabled: true }));
    const out = [];
    for (const o of ord) {
        const pr = prompts.find(x => x.identifier === o.identifier);
        if (!pr) continue;
        if (pr.identifier === 'chatHistory') { out.push({ id: 'ctx', n: '上下文', r: 'user', on: true, ctx: true }); continue; }
        if (ST_MARKERS[pr.identifier] || pr.marker) { out.push({ id: pr.identifier, n: ST_MARKERS[pr.identifier] || pr.name || pr.identifier, r: pr.role || 'system', on: false, mark: pr.identifier }); continue; }
        out.push({ id: pr.identifier, n: pr.name || pr.identifier, r: pr.role || 'system', on: o.enabled !== false, t: String(pr.content || '') });
    }
    if (!out.some(e => e.ctx)) out.push({ id: 'ctx', n: '上下文', r: 'user', on: true, ctx: true });
    return out;
}
let stPresetCache = null;
/** 酒馆里所有对话补全预设：[{ name, data }] */
async function tavernPresets(force = false) {
    if (stPresetCache && !force) return stPresetCache;
    const res = await fetch('/api/settings/get', { method: 'POST', headers: getRequestHeaders(), body: '{}' });
    if (!res.ok) throw new Error('读不到酒馆的预设（' + res.status + '）');
    const j = await res.json();
    const names = j.openai_setting_names || [], list = j.openai_settings || [];
    stPresetCache = names.map((name, i) => { try { return { name, data: typeof list[i] === 'string' ? JSON.parse(list[i]) : list[i] }; } catch { return null; } }).filter(Boolean);
    return stPresetCache;
}
const currentTavernPreset = () => SillyTavern.getContext().chatCompletionSettings?.preset_settings_openai || '';
/** 某个预设现在的条目；酒馆的预设还没读到时返回 null */
function entriesFor(active, stList = stPresetCache) {
    const c = aiCfg();
    if (active === 'plain') return [{ id: 'ctx', n: '上下文', r: 'user', on: true, ctx: true }];
    if (active.startsWith('tavern:')) {
        const name = active.slice(7);
        const p = !name || name === currentTavernPreset() ? SillyTavern.getContext().chatCompletionSettings : stList?.find(x => x.name === name)?.data;
        return p ? stToEntries(p).map(e => e.mark ? { ...e, on: !!c.markOn[e.mark] } : e) : null;
    }
    return c.list[active]?.ents || null;
}
function markText(id) {
    const ctx = SillyTavern.getContext();
    return MARK_MACRO[id] && ctx.substituteParams ? ctx.substituteParams(MARK_MACRO[id]) : '';
}
/** 按选中的预设拼出要发的消息；智库的指令和内容放在「上下文」那一格 */
async function aiMessages(fn, system, userContent) {
    const core = [{ role: 'system', content: fnSystem(fn, system) }, { role: 'user', content: userContent }];
    const c = aiCfg(), act = c.active ?? 'tavern:';
    if (!fn || act === 'plain') return core;
    let ents = null;
    try {
        if (act.startsWith('tavern:') && act.slice(7) && act.slice(7) !== currentTavernPreset()) await tavernPresets();
        ents = entriesFor(act);
    } catch (e) { console.warn('[智库] 读酒馆预设失败，这次不套预设', e); }
    if (!ents?.length) return core;
    const ctx = SillyTavern.getContext(), sp = s => (ctx.substituteParams ? ctx.substituteParams(s) : s);
    const out = [];
    for (const e of ents) {
        if (e.ctx) { out.push(...core); continue; }
        if (!e.on) continue;
        const text = e.mark ? markText(e.mark) : sp(String(e.t || ''));
        if (text.trim()) out.push({ role: ['system', 'user', 'assistant'].includes(e.r) ? e.r : 'system', content: text });
    }
    if (!out.includes(core[0])) out.push(...core);
    return out;
}
/** 这个功能用哪个 AI：功能里单独选了就用它，没选跟「翻译和 AI」 */
function apiFor(fn) {
    const f = fn ? aiCfg().fn[fn] : null;
    const id = f?.api || '';
    if (!id) return currentApi();
    if (id === 'st') return { st: true, from: '酒馆现在连接的 API' };
    const p = apiProfiles().find(x => x.id === id);
    if (!p) return currentApi();
    const model = String(f.model || '').trim() || (p.model || '').trim();
    return { url: (p.url || '').trim().replace(/\/+$/, ''), key: (p.key || '').trim(), model, bypass: !!p.bypass, from: p.name + (f.model ? ' · ' + f.model : '') };
}
let zkCleanFetch = null, zkFetchFrame = null, zkFetchStopped = false;
/** 从隐藏的同源空白 iframe 借 fetch，隔离父窗口的 fetch 改写。 */
function stopFetch() {
    zkFetchStopped = true;
    zkCleanFetch = null;
    zkFetchFrame?.remove();
    zkFetchFrame = null;
}
function zkPageWindow() {
    try { if (typeof DOC !== 'undefined' && DOC.defaultView) return DOC.defaultView; } catch {}
    return typeof window !== 'undefined' ? window : globalThis;
}
function zkLocalApi(input, w) {
    const raw = String(input?.url ?? input ?? '');
    try {
        const base = new URL(w.location.href), url = new URL(raw, base);
        return url.protocol === base.protocol && url.host === base.host && url.pathname.startsWith('/api/');
    } catch { return /^\/api\//.test(raw); }
}
function zkClientBridge(w) {
    try { if (w.__TAURI__ || w.__TAURI_INTERNALS__) return true; } catch {}
    try { if (w.top?.__TAURI__ || w.top?.__TAURI_INTERNALS__) return true; } catch {}
    try { return /TauriTavern/i.test(DOC.title || ''); } catch { return false; }
}
function zkFetch(...args) {
    if (zkFetchStopped) throw new Error('智库已关闭');
    const w = zkPageWindow(), local = zkLocalApi(args[0], w);
    const pageFetch = (...request) => typeof w.fetch === 'function' ? w.fetch(...request) : fetch(...request);
    // Client API bridges must be selected before creating an isolated iframe.
    if (local && zkClientBridge(w)) return pageFetch(...args);
    if (zkFetchFrame && !zkFetchFrame.isConnected) {
        zkFetchFrame = null;
        zkCleanFetch = null;
    }
    if (!zkCleanFetch) {
        let frame;
        try {
            frame = DOC.createElement('iframe');
            frame.setAttribute('aria-hidden', 'true'); frame.tabIndex = -1;
            frame.style.cssText = 'display:none!important';
            (DOC.body || DOC.documentElement).appendChild(frame);
            const child = frame.contentWindow;
            if (!child?.fetch) throw new Error('no fetch');
            zkCleanFetch = child.fetch.bind(child);
            zkFetchFrame = frame;
        } catch { frame?.remove(); }
    }
    if (!zkCleanFetch) return pageFetch(...args);
    if (!local) return zkCleanFetch(...args);
    // Preserve Request bodies before the first send; streams in init cannot be replayed.
    let replay = args;
    try {
        if (args[1]?.body && typeof args[1].body.getReader === 'function') replay = null;
        else if (typeof args[0]?.clone === 'function') replay = [args[0].clone(), ...args.slice(1)];
    } catch { replay = null; }
    return Promise.resolve(zkCleanFetch(...args)).then(async res => {
        // Only a successful local HTML response gets one bridge fallback. Network,
        // cancellation, authentication and server failures are never auto-resubmitted.
        if (!res.ok || !/text\/html/i.test(res.headers?.get('content-type') || '') || !replay) return res;
        if (zkFetchStopped) throw new Error('智库已关闭');
        const signal = args[1]?.signal || args[0]?.signal;
        if (signal?.aborted) { signal.throwIfAborted(); }
        try { await res.body?.cancel(); } catch {}
        if (zkFetchStopped) throw new Error('智库已关闭');
        return pageFetch(...replay);
    });
}
async function readBody(res) {
    const unavailable = res.bodyUsed || res.body?.locked;
    try { return await res.text(); }
    catch (e) {
        if (e?.name === 'AbortError') throw e;
        if (unavailable || /body.*(already.*(read|used)|unusable|locked)|body stream already read/i.test(String(e?.message || e))) {
            throw new Error('AI 回复正文已被读取或锁定，可能有扩展或脚本提前读取了回复：' + (e?.message || e), { cause: e });
        }
        throw e;
    }
}
async function askLLM(system, user, { maxTokens = 800, fn = '' } = {}) {
    const api = apiFor(fn);
    const messages = await aiMessages(fn, system, user);
    let res;
    if (api.st) {
        const ctx = SillyTavern.getContext();
        if (typeof ctx.generateRaw !== 'function') throw new Error('这个版本的酒馆不支持，请到设置里改用「单独填」');
        // ST 1.14.0 generateRaw accepts ordered text messages and keeps backend settings.
        const out = String(await ctx.generateRaw({ prompt: messages, responseLength: maxTokens, trimNames: false }) ?? '');
        if (!out.trim()) throw Object.assign(new Error('AI 回复是空的'), { emptyLength: true, diag: `通过酒馆现在连接的 API 转发，这次限长 ${maxTokens}；酒馆没把详细原因传回来，想看原因可以在智库设置「AI」里改成「单独填」再读一次` });
        return out;
    }
    if (!res && !api.url) throw new Error('单独填的 AI 没填地址，到设置里填');
    if (!res && !api.model) throw new Error('单独填的 AI 没选模型');
    if (res) { /* 上面已经照预设发给酒馆了 */ }
    else if (api.bypass) {
        res = await zkFetch(`${api.url}/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...(api.key ? { Authorization: `Bearer ${api.key}` } : {}) },
            body: JSON.stringify({ model: api.model, messages, temperature: 0.3, stream: false, max_tokens: maxTokens }),
        });
    } else {
        res = await zkFetch('/api/backends/chat-completions/generate', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                chat_completion_source: 'custom',
                custom_url: api.url,
                custom_include_headers: api.key ? `Authorization: "Bearer ${api.key.replace(/"/g, '\\"')}"` : '',
                model: api.model, messages, temperature: 0.3, stream: false, max_tokens: maxTokens,
            }),
        });
    }
    const raw = await readBody(res);
    if (!res.ok) throw new Error(`AI 请求失败（${res.status}）：${raw.slice(0, 160)}`);
    let json;
    try { json = JSON.parse(raw); } catch { throw new Error(/^\s*<(?:!doctype|html)/i.test(raw) ? 'AI 请求拿回来的是一张网页，不是 AI 的回复：多半是请求没到后端（客户端或别的插件拦了），或者 AI 地址填成了网页地址（OpenAI 兼容的地址一般以 /v1 结尾）' : 'AI 返回的不是正常格式：' + raw.slice(0, 120)); }
    if (json.error) throw new Error('AI 报错：' + (json.error.message || JSON.stringify(json.error)).slice(0, 160));
    const ch = json.choices?.[0] || {};
    const content = String(ch.message?.content ?? ch.text ?? '');
    if (content.trim()) return content;
    const think = String(ch.message?.reasoning_content ?? ch.message?.reasoning ?? '');
    if (think.includes('{') && ch.finish_reason !== 'length') return think;
    // 正文是空的：把 API 实际返回的情况记下来，报错时给用户看，不靠猜
    const u = json.usage || {}, rt = u.completion_tokens_details?.reasoning_tokens;
    const diag = `模型 ${json.model || api.model || '?'}，结束原因 ${ch.finish_reason || '没给'}，这次限长 ${maxTokens}，用了 ${u.completion_tokens ?? '?'} token${rt !== undefined ? `（其中思考 ${rt}）` : think ? `（有 ${think.length} 字思考内容）` : ''}${!json.choices?.length ? '，返回里没有 choices：' + raw.slice(0, 80) : ''}`;
    throw Object.assign(new Error('AI 回复是空的（' + diag + '）'), { emptyLength: true, diag });
}

async function translateToTags(text, { expand = false } = {}) {
    return cleanOutput(await askLLM(expand ? EXPAND : SYSTEM, text, { maxTokens: 600, fn: 'tr' }));
}

/** 从 AI 的回复里挖出 JSON */
function pickJson(raw) {
    const t = String(raw || '').replace(/<think>[\s\S]*?<\/think>/g, '').replace(/```(?:json)?/g, '');
    const a = t.indexOf('{'), b = t.lastIndexOf('}');
    if (!t.trim()) throw new Error('AI 回复是空的。带思考的模型可能把长度都用在思考上了：换不带思考的模型，或者在模型设置里关掉思考（推理）再试');
    if (a < 0) throw new Error('AI 没按格式回答，可能拒绝了或没看懂，换个模型再试：' + t.slice(0, 100));
    try { if (b > a) return JSON.parse(t.slice(a, b + 1)); } catch { /* 下面试着修 */ }
    const fixed = repairJson(t.slice(a));
    if (fixed) return fixed;
    throw new Error('AI 的回答不完整（可能太长被截断了）：换不带思考的模型、关掉思考（推理），或者关掉没用的世界书条目再试：' + t.slice(a, a + 80));
}
/** 回答被截断时：退回到最后一个写完整的值，把没关上的括号补上 */
function repairJson(s) {
    const stack = [], cuts = [];
    let inStr = false, esc = false;
    for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
        if (ch === '"') inStr = true;
        else if (ch === '{' || ch === '[') stack.push(ch === '{' ? '}' : ']');
        else if (ch === '}' || ch === ']') { stack.pop(); cuts.push([i + 1, stack.slice()]); }
    }
    for (let k = cuts.length - 1; k >= 0; k--) {
        const [at, open] = cuts[k];
        try { return JSON.parse(s.slice(0, at) + open.reverse().join('')); } catch { /* 再往前退 */ }
    }
    return null;
}

const PAIRS = `每个标签写成 {"en": "英文 Danbooru 标签", "zh": "简短中文意思"}。只用常见的 Danbooru 标签。`;

/** 从角色卡 / 人设描述里挑出固定外貌和默认衣服 */
async function extractAppearance(name, description) {
    const sys = `你从角色设定里挑出画图用的外貌标签。只挑不会变的外貌：性别人数（1boy / 1girl）、年龄感、发型发色、眼睛、脸部特征、身材、肤色、明显的痣疤纹身等。衣服另外放。
${PAIRS}
NSFW 身体单独放进 nsfw：只给明确是成年人的角色写（未成年、年龄不明、非人类幼体一律留空 []）。写脱了衣服才看得到的身体特征：乳头 / 乳晕颜色和大小、阴毛、私处、男性的阴茎等；设定写了就照写，没写的按这个人的身材和气质补 2～4 个常见的。不要写动作和姿势。
只输出 JSON：{"appearance": [...], "outfit": [...], "nsfw": [...]}。外貌和衣服设定里没写的不要编。`;
    const j = await askShrinking(sys, limit => `角色名：${name}\n设定（可能有好几个人，只挑「${name}」的）：\n${String(description || '').slice(0, limit)}`, { maxTokens: 8000, fn: 'look' });
    const norm = arr => (Array.isArray(arr) ? arr : []).map(x => typeof x === 'string' ? { en: x, zh: '' } : { en: String(x.en || '').trim(), zh: String(x.zh || '').trim() }).filter(x => x.en && !hasChinese(x.en));
    return { appearance: norm(j.appearance), outfit: norm(j.outfit), nsfw: norm(j.nsfw) };
}

/** 设定很长时：先发 6 万字；模型说太长（上下文不够、请求太大、超时）就缩到 3 万、1.5 万再试。设定是按描述在前、世界书在后排的，缩的时候先丢后面的 */
/** 去掉思考部分后还有没有内容；思考没写完（只有 <think> 没有 </think>）也算空 */
const answerOf = raw => String(raw || '').replace(/<think>[\s\S]*?<\/think>/g, '').replace(/^\s*<think>[\s\S]*$/, '').trim();
/** 回复是空的就给大很多的长度再试一次（思考模型要先思考，2000 不够用） */
async function askRoomy(sys, user, opts) {
    try {
        const raw = await askLLM(sys, user, opts);
        if (answerOf(raw) || String(raw || '').includes('{')) return raw;
    } catch (e) { if (!e.emptyLength) throw e; }
    console.warn('[智库] AI 回复是空的，加大长度再试一次');
    let diag = '';
    try {
        const raw = await askLLM(sys, user, { ...opts, maxTokens: Math.max(16000, (opts?.maxTokens || 800) * 2) });
        if (answerOf(raw) || String(raw || '').includes('{')) return raw;
    } catch (e) { if (!e.emptyLength && !/max_tokens|max tokens|max_completion/i.test(String(e?.message))) throw e; diag = e.diag || String(e?.message || ''); }
    throw new Error('AI 回复是空的，加大长度又试了一次还是空的。实际情况：' + (diag || '没有更多信息') + '。如果写着思考用了很多 token，换不带思考的模型或关掉思考；如果结束原因是 stop 但用了 0 token，多半是中转站或模型拒绝了这段设定');
}
async function askShrinking(sys, userFor, opts) {
    const TOO_LONG = /context|length|too long|too large|token|maximum|exceed|413|504|524|timeout|超出|过长|太长|上限/i;
    let last;
    for (const limit of [60000, 30000, 15000]) {
        let raw;
        try { raw = await askRoomy(sys, userFor(limit), opts); }
        catch (e) {
            last = e;
            if (!TOO_LONG.test(String(e?.message || e))) throw e;
            console.warn(`[智库] 设定 ${limit} 字太长，缩短再试`, e);
            continue;
        }
        // 只有请求本身报太长才缩；回答格式的问题交给 pickJson 报
        return pickJson(raw);
    }
    throw new Error('设定太长，缩到 1.5 万字模型还是放不下：换个上下文更大的模型，或者关掉没用的世界书条目。' + (last?.message ? '（' + String(last.message).slice(0, 120) + '）' : ''));
}
/** 一张卡（连世界书）里所有人：[{ name, aliases, appearance, outfit }] */
async function extractCastFromChat(cardName, chatText) {
    const sys = `你从聊天正文里找出所有出场过、并且写到了外貌的角色（主角、配角、路人都算，{{user}} / 玩家本人不要），每人挑画图用的外貌标签。
外貌只挑不会变的：性别人数（1boy / 1girl）、年龄感、发型发色、眼睛、脸部特征、身材、肤色、明显的痣疤纹身、角尾巴翅膀等。最近一次写到的衣服另外放。正文没写到的不要编；同一个人前后写法不同时以较新的为准。
${PAIRS}
NSFW 身体单独放进 nsfw：只给明确是成年人的角色写（未成年、年龄不明、非人类幼体一律留空 []）。写脱了衣服才看得到的身体特征：乳头 / 乳晕颜色和大小、阴毛、私处、男性的阴茎等；设定写了就照写，没写的按这个人的身材和气质补 2～4 个常见的。不要写动作和姿势。
只输出 JSON：{"people": [{"name": "正文里的名字", "aliases": ["昵称、称呼、别的叫法"], "appearance": [...], "outfit": [...], "nsfw": [...]}]}`;
    const j = await askShrinking(sys, limit => `卡名：${cardName}\n聊天正文（从旧到新）：\n${String(chatText || '').slice(-limit)}`, { maxTokens: 8000, fn: 'look' });
    const norm = arr => (Array.isArray(arr) ? arr : []).map(x => typeof x === 'string' ? { en: x, zh: '' } : { en: String(x?.en || '').trim(), zh: String(x?.zh || '').trim() }).filter(x => x.en && !hasChinese(x.en));
    return (Array.isArray(j.people) ? j.people : []).map(p => ({
        name: String(p?.name || '').trim().slice(0, 30),
        aliases: (Array.isArray(p?.aliases) ? p.aliases : []).map(a => String(a || '').trim()).filter(Boolean).slice(0, 6),
        appearance: norm(p?.appearance), outfit: norm(p?.outfit), nsfw: norm(p?.nsfw),
    })).filter(p => p.name && !/^\{\{?user\}?\}$|^user$/i.test(p.name) && p.appearance.length);
}
async function extractCast(cardName, description) {
    const sys = `你从角色卡和世界书里找出所有有外貌描写的角色（主角、配角都要，{{user}} / 玩家本人不要），每人挑画图用的外貌标签。
外貌只挑不会变的：性别人数（1boy / 1girl）、年龄感、发型发色、眼睛、脸部特征、身材、肤色、明显的痣疤纹身等。衣服另外放。设定里没写的不要编。
${PAIRS}
NSFW 身体单独放进 nsfw：只给明确是成年人的角色写（未成年、年龄不明、非人类幼体一律留空 []）。写脱了衣服才看得到的身体特征：乳头 / 乳晕颜色和大小、阴毛、私处、男性的阴茎等；设定写了就照写，没写的按这个人的身材和气质补 2～4 个常见的。不要写动作和姿势。
只输出 JSON：{"people": [{"name": "设定里的名字", "aliases": ["昵称、简称、别的叫法"], "appearance": [...], "outfit": [...], "nsfw": [...]}]}`;
    const j = await askShrinking(sys, limit => `卡名：${cardName}\n设定：\n${String(description || '').slice(0, limit)}`, { maxTokens: 8000, fn: 'look' });
    const norm = arr => (Array.isArray(arr) ? arr : []).map(x => typeof x === 'string' ? { en: x, zh: '' } : { en: String(x?.en || '').trim(), zh: String(x?.zh || '').trim() }).filter(x => x.en && !hasChinese(x.en));
    return (Array.isArray(j.people) ? j.people : []).map(p => ({
        name: String(p?.name || '').trim().slice(0, 30),
        aliases: (Array.isArray(p?.aliases) ? p.aliases : []).map(a => String(a || '').trim()).filter(Boolean).slice(0, 6),
        appearance: norm(p?.appearance), outfit: norm(p?.outfit), nsfw: norm(p?.nsfw),
    })).filter(p => p.name && !/^\{\{?user\}?\}$|^user$/i.test(p.name) && p.appearance.length);
}

/** 用户自己写的一句（中文也行）→ 一个或几个标签 */
async function textToPairs(text) {
    // 整套粘贴：逗号、顿号、分号、换行都算分隔；英文的直接用，只有带中文的那几项才问 AI
    const parts = String(text || '').split(/[,，、;；\r\n]+/).map(t => t.trim().replace(/^(?:[-*•·]\s*|\d+[.)）]\s+)/, '').trim()).filter(Boolean);
    const out = parts.map(p => hasChinese(p) ? null : { en: p, zh: '' });
    const zh = parts.filter(hasChinese);
    if (!zh.length) return out;
    const j = pickJson(await askLLM(`把用户写的外貌或衣服描述翻成 NovelAI 标签，每一行都要翻。${PAIRS}只输出 JSON：{"tags": [...]}`, zh.join('\n'), { maxTokens: Math.min(2400, 300 + zh.length * 80), fn: 'tr' }));
    const got = (j.tags || []).map(x => ({ en: String(x.en || '').trim(), zh: String(x.zh || '').trim() })).filter(x => x.en && !hasChinese(x.en));
    const at = out.indexOf(null);
    return [...out.slice(0, at).filter(Boolean), ...got, ...out.slice(at).filter(Boolean)];
}

/**
 * 聊天生图：读最近的剧情，写出这一张图的画面。
 * cast：[{ name, story: 衣服跟剧情? }]
 */
async function sceneFromChat(chatText, cast, { maxChars = 3 } = {}) {
    const names = cast.map(c => `${c.name}${c.story ? '（衣服按剧情写）' : '（衣服已固定，不用写）'}`).join('、') || '（没有登记的角色）';
    const sys = `你是插画分镜师。读最后一段剧情，挑最有画面感的一个瞬间，写成 NovelAI 提示词。
已登记的角色：${names}。他们的长相已经另外写好，你只写这一瞬间的动作、表情、姿势、视线${cast.some(c => c.story) ? '，以及「衣服按剧情写」的角色此刻穿什么' : ''}。
没登记但出场的人，写在 scene 里（比如 1girl, waitress）。画面里最多 ${maxChars} 个登记角色。
只输出 JSON：
{"scene": "场景、背景、时间、光线、构图的英文标签，逗号隔开",
 "characters": [{"name": "登记的角色名", "tags": "这个角色此刻的动作表情姿势${cast.some(c => c.story) ? '和衣服' : ''}，英文标签", "x": 0.1到0.9, "y": 0.1到0.9}]}
规则：只用常见 Danbooru 英文标签；不写画师，不写质量词，不写长相；x、y 是角色在画面里的大概位置。`;
    const j = pickJson(await askLLM(sys, chatText.slice(-6000), { maxTokens: 900, fn: 'scene' }));
    return {
        scene: String(j.scene || '').trim(),
        characters: (Array.isArray(j.characters) ? j.characters : []).map(c => ({ name: String(c.name || '').trim(), tags: String(c.tags || '').trim(), x: Number(c.x), y: Number(c.y) })).filter(c => c.name),
    };
}

/** 拉取模型列表（单独填的 API） */
async function listModels({ url, key, bypass }) {
    url = String(url || '').trim().replace(/\/+$/, '');
    if (!url) throw new Error('先填 API 地址');
    let res;
    if (bypass) {
        res = await fetch(`${url}/models`, { headers: key ? { Authorization: `Bearer ${key}` } : {} });
    } else {
        res = await fetch('/api/backends/chat-completions/status', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ chat_completion_source: 'custom', custom_url: url, custom_include_headers: key ? `Authorization: "Bearer ${key.replace(/"/g, '\\"')}"` : '' }),
        });
    }
    const raw = await res.text();
    if (!res.ok) throw new Error(`拉取失败（${res.status}）：${raw.slice(0, 120)}`);
    let json;
    try { json = JSON.parse(raw); } catch { throw new Error('返回的不是模型列表'); }
    if (json.error) throw new Error('拉取失败：地址或 Key 不对');
    const list = (Array.isArray(json) ? json : json.data || json.models || []).map(m => typeof m === 'string' ? m : m.id || m.name).filter(Boolean);
    if (!list.length) throw new Error('没拿到模型，检查一下地址和 Key');
    return list.sort();
}

/** AI 设计一套衣服 */
async function designOutfit(name, appearance, desc, want) {
    const sys = `你是服装设计师，给角色设计一套衣服，写成 NovelAI 标签。只写衣服、鞋、配饰、发饰，不写长相、动作、背景。
${PAIRS}
只输出 JSON：{"name": "这套衣服的中文名，6 个字以内", "tags": [...]}。标签 6 到 14 个，从上到下写全（上衣、外套、下装、鞋、配饰）。`;
    const user = `角色：${name}\n长相标签：${appearance || '（没写）'}\n设定（节选）：${String(desc || '').slice(0, 1500)}\n想要的衣服：${want}`;
    const j = pickJson(await askLLM(sys, user, { maxTokens: 600, fn: 'outfit' }));
    return { name: String(j.name || '').slice(0, 12), tags: (j.tags || []).map(x => ({ en: String(x.en || '').trim(), zh: String(x.zh || '').trim() })).filter(x => x.en && !hasChinese(x.en)) };
}

/** 从最近的剧情里读出这个角色现在穿什么 */
async function outfitFromStory(name, chatText) {
    const sys = `读剧情，找出「${name}」此刻穿的衣服，写成 NovelAI 标签。只写衣服、鞋、配饰；剧情没写到的不要编。
${PAIRS}
只输出 JSON：{"name": "这套衣服的中文名，6 个字以内", "tags": [...]}。完全没写到就输出 {"name": "", "tags": []}。`;
    const j = pickJson(await askLLM(sys, chatText.slice(-6000), { maxTokens: 500, fn: 'outfit' }));
    return { name: String(j.name || '').slice(0, 12), tags: (j.tags || []).map(x => ({ en: String(x.en || '').trim(), zh: String(x.zh || '').trim() })).filter(x => x.en && !hasChinese(x.en)) };
}

/**
 * 按剧情给几个角色一起设计衣服。
 * chars：[{ name, appearance }]；demand：用户想要的（可空）
 * 返回 [{ owner, name, tags }]
 */
async function designOutfitsFromChat(chatText, chars, demand) {
    const sys = `你是服装设计师。读剧情，给下面这些角色设计衣服，写成 NovelAI 标签。
角色：${chars.map(c => `${c.name}${c.appearance ? `（长相：${c.appearance}）` : ''}`).join('；')}
${demand ? `用户的要求：${demand}` : '用户没提要求：按剧情此刻的场合、季节、身份来设计；剧情里已经写了穿什么，就照剧情写。'}
规则：只写衣服、鞋、配饰、发饰，不写长相、动作、背景。每套 6 到 14 个标签，从上到下写全。可以给同一个角色出两套备选。
${PAIRS}
只输出 JSON：{"outfits": [{"owner": "角色名（必须是上面列出的）", "name": "这套衣服的中文名，6 个字以内", "tags": [...]}]}`;
    const j = pickJson(await askLLM(sys, chatText.slice(-6000) || '（没有剧情）', { maxTokens: 1500, fn: 'outfit' }));
    return (Array.isArray(j.outfits) ? j.outfits : []).map(o => ({
        owner: String(o.owner || '').trim(),
        name: String(o.name || '').slice(0, 12),
        tags: (o.tags || []).map(x => ({ en: String(x.en || '').trim(), zh: String(x.zh || '').trim() })).filter(x => x.en && !hasChinese(x.en)),
    })).filter(o => o.tags.length);
}

// ───────────── 看图 ─────────────

/** 让 AI 看一张图（要能看图的模型）。imageDataUrl 是 data:image/... */
async function askVision(system, text, imageDataUrl, { maxTokens = 800, fn = '' } = {}) {
    const api = apiFor(fn);
    const messages = await aiMessages(fn, system, [{ type: 'text', text }, { type: 'image_url', image_url: { url: imageDataUrl } }]);
    let body;
    if (api.st) {
        const ctx = SillyTavern.getContext();
        if (ctx.mainApi !== 'openai') throw new Error('酒馆现在连的不是「聊天补全」类的 API，看不了图。到设置 → 翻译和 AI 里加一个能看图的接口（比如 GPT-4o、Claude、Gemini）');
        const s = ctx.chatCompletionSettings || {};
        body = {
            chat_completion_source: s.chat_completion_source, model: ctx.getChatCompletionModel?.(),
            messages, max_tokens: maxTokens, temperature: 0.3, stream: false,
            reverse_proxy: s.reverse_proxy, proxy_password: s.proxy_password,
            custom_url: s.custom_url, custom_include_headers: s.custom_include_headers, custom_include_body: s.custom_include_body,
        };
    } else {
        if (!api.url || !api.model) throw new Error('这个 AI 接口没填地址或模型');
        if (api.bypass) {
            const r = await zkFetch(`${api.url}/chat/completions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...(api.key ? { Authorization: `Bearer ${api.key}` } : {}) },
                body: JSON.stringify({ model: api.model, messages, temperature: 0.3, stream: false, max_tokens: maxTokens }),
            });
            return readChat(r);
        }
        body = {
            chat_completion_source: 'custom', custom_url: api.url,
            custom_include_headers: api.key ? `Authorization: "Bearer ${api.key.replace(/"/g, '\\"')}"` : '',
            model: api.model, messages, temperature: 0.3, stream: false, max_tokens: maxTokens,
        };
    }
    const r = await zkFetch('/api/backends/chat-completions/generate', { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify(body) });
    return readChat(r);
}
async function readChat(r) {
    const raw = await readBody(r);
    if (!r.ok) throw new Error(`AI 请求失败（${r.status}）：${raw.slice(0, 160)}。如果这个模型不能看图，到设置 → 翻译和 AI 换一个`);
    let json;
    try { json = JSON.parse(raw); } catch { throw new Error(/^\s*<(?:!doctype|html)/i.test(raw) ? 'AI 请求拿回来的是一张网页，不是 AI 的回复：多半是请求没到后端（客户端或别的插件拦了），或者 AI 地址填成了网页地址（OpenAI 兼容的地址一般以 /v1 结尾）' : 'AI 返回的不是正常格式：' + raw.slice(0, 120)); }
    if (json.error) throw new Error('AI 报错：' + (json.error.message || JSON.stringify(json.error)).slice(0, 160) + '。可能这个模型不能看图');
    const c = json.choices?.[0]?.message?.content ?? json.content?.[0]?.text ?? '';
    return String(Array.isArray(c) ? c.map(x => x.text || '').join('') : c);
}

const normPairs = arr => (Array.isArray(arr) ? arr : []).map(x => typeof x === 'string' ? { en: x, zh: '' } : { en: String(x.en || '').trim(), zh: String(x.zh || '').trim() }).filter(x => x.en && !hasChinese(x.en));

/** 看图提取衣服 */
async function outfitFromImage(imageDataUrl) {
    const sys = `你看图，把画面里主要人物穿的衣服写成 NovelAI 标签。只写衣服、鞋、配饰、发饰，不写长相、动作、背景、画风。从上到下写全，颜色、材质、款式写清楚。
${PAIRS}
只输出 JSON：{"name": "这套衣服的中文名，6 个字以内", "tags": [...]}`;
    const j = pickJson(await askVision(sys, '提取这张图里的衣服。', imageDataUrl, { maxTokens: 700, fn: 'outfit' }));
    return { name: String(j.name || '').slice(0, 12), tags: normPairs(j.tags) };
}
/** 看图提取长相 */
async function lookFromImage(imageDataUrl) {
    const sys = `你看图，把画面里主要人物不会变的长相写成 NovelAI 标签：先写 1boy 或 1girl，再写年龄感、发型发色、眼睛颜色和形状、脸部特征、身材、肤色、明显的痣疤纹身、动物耳尾等。不写衣服、动作、表情、背景、画风。
${PAIRS}
只输出 JSON：{"appearance": [...]}`;
    const j = pickJson(await askVision(sys, '提取这张图里人物的长相。', imageDataUrl, { maxTokens: 700, fn: 'look' }));
    return normPairs(j.appearance);
}

/** 穿搭管理器里的一段服装描述（可带单品描述）→ 标签，配饰标 acc */
async function outfitFromText(name, desc, accDescs = []) {
    const sys = `把下面这套衣服的文字描述改写成 NovelAI 标签。只写衣服、鞋袜、配饰、发饰，不写长相、动作、表情、背景、画风；描述里没写的不要编。颜色、材质、款式能写就写进标签。
每个标签写成 {"en": "英文 Danbooru 标签", "zh": "简短中文意思", "acc": 是不是配饰}。眼镜、首饰、帽子、发饰、包、手套、围巾、手表、面具这类 acc 写 true，其余写 false。只用常见的 Danbooru 标签。
只输出 JSON：{"tags": [...]}`;
    const user = `穿搭名：${name || '（没写）'}\n描述：${String(desc || '').slice(0, 3000)}${accDescs.length ? '\n单品：\n' + accDescs.map(a => '- ' + String(a).slice(0, 600)).join('\n') : ''}`;
    const j = pickJson(await askLLM(sys, user, { maxTokens: 900, fn: 'outfit' }));
    return (Array.isArray(j.tags) ? j.tags : []).map(x => ({ en: String(x?.en || '').trim(), zh: String(x?.zh || '').trim(), ...(x?.acc === true ? { acc: true } : x?.acc === false ? { acc: false } : {}) })).filter(x => x.en && !hasChinese(x.en));
}

/** 英文标签 → 简短中文。返回 { 小写英文: 中文 } */
async function zhForTags(ens) {
    const list = [...new Set((ens || []).map(s => String(s || '').trim()).filter(Boolean))];
    const out = {};
    for (let i = 0; i < list.length; i += 60) {
        const part = list.slice(i, i + 60);
        const j = pickJson(await askLLM('把 NovelAI / Danbooru 英文标签翻成简短自然的中文（一般 2–6 个字），照原意翻，不要解释，每一个都要翻。只输出 JSON：{"zh": {"英文标签": "中文", ...}}', part.join('\n'), { maxTokens: Math.min(3000, 200 + part.length * 40), fn: 'zh' }));
        if (Array.isArray(j.zh)) j.zh.forEach((z, k) => { const en = part[k]; const v = String(z?.zh ?? z ?? '').trim(); if (en && v) out[en.toLowerCase()] = v; });
        else if (j.zh && typeof j.zh === 'object') for (const [en, z] of Object.entries(j.zh)) { const v = String(z || '').trim(); if (v) out[en.trim().toLowerCase()] = v; }
    }
    return out;
}
/** 看图写成 NovelAI 标签（不写画师和质量词）：分栏写，镜头语言单独一栏、必须写 */
async function imageToPrompt(imageDataUrl) {
    const sys = `你是给 NovelAI / Danbooru 打标签的专业标注员。看图，把这张图拆成英文 Danbooru 标签，按下面每一栏分别写，每栏是标签数组。看不清的不要编，但「镜头」这一栏必须写，不能空。
1. people：人数和性别（1girl、1boy、2girls、1boy 1girl、multiple girls、no humans 等）。
2. outfit：衣服状态，只写大类和穿脱状态（shirt、dress、open clothes、naked 等），不写颜色细节。不写长相（发色、眼睛、脸、身材都不要写）。
3. action：动作，这一栏和镜头一样重要，写细：
   - 全身姿势：standing、sitting、kneeling、squatting、lying on back、lying on side、on stomach、all fours、leaning forward、leaning back、bent over、arched back、crossed legs、spread legs、walking、running、jumping。
   - 身体朝向：facing viewer、facing away、turning around、looking back、profile。
   - 手和手臂：每只手在做什么（hand on own chest、hand on hip、hands up、arms behind back、arm support、reaching towards viewer、holding xx、covering mouth、v sign、hand in hair）。
   - 腿和脚：knees up、legs together、one knee up、feet up、standing on one leg。
   - 头：head tilt、chin rest、looking down、looking up。
   - 多人时写互动和相对位置：hug、hug from behind、holding hands、carrying、lap pillow、face-to-face、back-to-back、on top、between legs，谁在谁的哪边。
4. expression：表情和视线（smile、blush、open mouth、tears、looking at viewer、looking away、looking back、eyes closed 等）。
5. camera：镜头语言，这一栏最重要，逐项看清再写：
   - 景别：extreme close-up、close-up、portrait、upper body、cowboy shot、full body、wide shot、very wide shot 里选一个；脸占满画面就是 close-up。
   - 机位角度：from above、from below、from side、from behind、straight-on、dutch angle、pov、high angle、low angle 里看到哪个写哪个。
   - 裁切和取景：head out of frame、cropped legs、cropped torso、feet out of frame、upper body focus、ass focus、foot focus、hand focus 等。
   - 构图：centered、off-center、symmetry、rule of thirds、negative space、split screen 等。
   - 透视和镜头：foreshortening、perspective、fisheye、wide-angle lens、depth of field、bokeh、blurry background、blurry foreground、motion blur、lens flare、chromatic aberration。
6. background：地点、背景、物件；纯色背景写 simple background / white background 等。
7. lighting：光线和色调：backlighting、rim lighting、sunlight、dim lighting、night、golden hour、high contrast、monochrome、muted colors 等。
不写画师名，不写 masterpiece 这类质量词，不写画风名（除非是明显的 monochrome、sketch、lineart 这类）。
只输出 JSON：{"people":[],"outfit":[],"action":[],"expression":[],"camera":[],"background":[],"lighting":[],"zh":"一句话中文描述，带上镜头（比如：俯拍的半身特写……）"}`;
    const j = pickJson(await askVision(sys, '把这张图拆成标签：镜头语言（景别、角度、裁切、构图、透视景深）和动作（姿势、朝向、手、腿、互动）一定要写细，长相不要写。', imageDataUrl, { maxTokens: 2400, fn: 'img' }));
    const arr = v => (Array.isArray(v) ? v : String(v || '').split(',')).map(x => String(typeof x === 'object' ? x?.en || '' : x).trim()).filter(x => x && !hasChinese(x));
    // 人数 → 镜头 → 动作 → 表情 → 衣服 → 背景光影；镜头和动作放前面权重更高；长相不写，方便套到自己的角色上
    const order = ['people', 'camera', 'action', 'expression', 'outfit', 'background', 'lighting'];
    let list = order.flatMap(k => arr(j[k]));
    if (!list.length && j.tags) list = arr(j.tags);
    const seen = new Set();
    const tags = list.filter(t => { const k = t.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; }).join(', ');
    if (!tags) throw new Error('AI 没写出标签，换个能识图的模型试试');
    return { positive: tags, negative: '', zh: String(j.zh || '').trim(), camera: arr(j.camera).join(', ') };
}

/** 看图只读姿势和构图（带中文） */
async function imagePose(imageDataUrl) {
    const sys = `你看图，只写人物的姿势和画面构图，写成 NovelAI 标签。
姿势：身体姿势（standing、sitting、leaning forward、lying on side 等）、手和手臂的动作、腿的动作、头的朝向和视线方向；多人时写互动和相对位置（hug、holding hands、back-to-back 等）；表情最多写一两个。
构图（必须写，不能空）：景别（extreme close-up、close-up、portrait、upper body、cowboy shot、full body、wide shot 选一个）、机位角度（from above、from below、from side、from behind、straight-on、dutch angle、pov）、裁切（head out of frame、cropped legs、feet out of frame、xx focus）、人物在画面里的位置（centered、off-center、rule of thirds）、透视和景深（foreshortening、fisheye、depth of field、blurry background）。
不写长相、衣服、背景、画风、画师。看不清的不要编。
只在 NSFW 图里才会用的标签（性行为、裸露部位、体液、明显带性暗示的姿势，比如 spread legs、presenting、sex、saliva、cum、nipples 等）不要放进 pose，单独放进 nsfw；普通图里也常见的姿势放 pose。
${PAIRS}
只输出 JSON：{"pose": [...], "composition": [...], "nsfw": [...]}`;
    const j = pickJson(await askVision(sys, '读这张图的姿势和构图。', imageDataUrl, { maxTokens: 1200, fn: 'pose' }));
    const NSFW_RE = /\b(nsfw|sex|penis|vagina|pussy|nipples?|cum|ejaculation|saliva|spread legs|presenting|masturbation|fellatio|paizuri|orgasm|ahegao|nude|naked|bdsm|bondage|groping|panties aside|after sex|rape)\b/i;
    let pose = normPairs(j.pose), composition = normPairs(j.composition), nsfw = normPairs(j.nsfw);
    // AI 偶尔还是放错栏：明显的挪到 NSFW
    const restricted = p => NSFW_RE.test(p.en.replace(/_/g, ' '));
    const moved = [...pose, ...composition].filter(restricted);
    pose = pose.filter(p => !restricted(p)); composition = composition.filter(p => !restricted(p));
    nsfw = [...new Map([...nsfw, ...moved].map(p => [p.en.replace(/_/g, ' ').trim().toLowerCase(), p])).values()];
    if (!pose.length && !composition.length && !nsfw.length) throw new Error('AI 没读出姿势和构图，换个能识图的模型试试');
    return { pose, composition, nsfw };
}
return { AI_FNS, stopFetch, extractCastFromChat, apiFor, aiSeen, aiCfg, splitFormat, stToEntries, tavernPresets, entriesFor, currentTavernPreset, imagePose, imageToPrompt, zhForTags, extractCast, hasChinese, apiProfiles, activeApiId, currentApi, askLLM, translateToTags, pickJson, extractAppearance, textToPairs, sceneFromChat, listModels, designOutfit, outfitFromStory, designOutfitsFromChat, askVision, outfitFromImage, lookFromImage, outfitFromText };
})();

// 世界书宏 {{zhiku_characters}} 的注册与注销。
// 宿主用 SillyTavern.getContext() 暴露的 registerMacro / unregisterMacro（1.14 的扩展接口）；
// 老版本或没有这个接口时只写一条 warn，不影响其它功能。
// 构建时由 tools/apply-char-lib.mjs 去掉 export 后内联进 runtime.js。

const CHAR_MACRO_NAME = 'zhiku_characters';

/**
 * 注册宏；返回 { supported, uninstall }。
 * text 是一个函数，每次展开宏时现算（角色开关、聊天切换都能立刻反映）。
 */
function installCharMacro(ctx, { text, log = () => {} } = {}) {
    const api = ctx || {};
    const read = typeof text === 'function' ? text : () => '';
    let active = true;
    const handler = () => (active ? String(read() ?? '') : '');
    const register = api.registerMacro;
    if (typeof register !== 'function') {
        log('[智库] 宿主没有 registerMacro，{{zhiku_characters}} 宏不可用');
        return { supported: false, uninstall() { active = false; } };
    }
    // 不同版本的 registerMacro 签名不一样：先试 (name, handler)，再试 (name, description, handler)。
    const attempts = register.length >= 3
        ? [[CHAR_MACRO_NAME, '智库：本聊天出场角色的 $名字$ 清单', handler], [CHAR_MACRO_NAME, handler]]
        : [[CHAR_MACRO_NAME, handler], [CHAR_MACRO_NAME, '', handler]];
    let registered = false;
    for (const args of attempts) {
        try {
            register.apply(api, args);
            registered = true;
            break;
        } catch (error) {
            // 换一种签名再试；都不行会在下面报 warn。
        }
    }
    if (!registered) {
        log('[智库] 注册 {{zhiku_characters}} 宏失败');
        return { supported: false, uninstall() { active = false; } };
    }
    return {
        supported: true,
        uninstall() {
            active = false;
            const unregister = api.unregisterMacro;
            if (typeof unregister === 'function') {
                try {
                    unregister.call(api, CHAR_MACRO_NAME);
                } catch (error) {
                    log('[智库] 注销 {{zhiku_characters}} 宏失败');
                }
            }
        },
    };
}

// ───── chars.js ─────
const __mod_chars = (() => {
/**
 * 角色：自动读取酒馆的角色卡（char）和人设（user），只存画图用的固定外貌和衣服。
 * 还有聊天里生图：读剧情 → AI 选择入画角色 → 补充所选角色 → 生成 → 插进这一楼。
 */
const { getData, commit, uploadImage } = __mod_store;
const M = __mod_model;
const N = __mod_nai;
const E = __mod_engine;
const T = __mod_translate;
// 角色外观库：<人物> / <外貌变化> 块 → 按楼重放的角色档案。
// 纯函数，不碰 DOM、不发请求；构建时由 tools/apply-char-lib.mjs 去掉 export 后内联进 runtime.js。
// 设计（与 README「角色外观库」一节一致）：
// - 全局库 = piaoce_data.json 的 characters，AI 只读；本聊天库 = chatMetadata[CHAT_META_KEY]。
// - 回复里的块不直接写库，而是写成该消息的 ops（msg.extra[CHAR_OPS_KEY]），按楼层重放。
// - 状态(N) = 本聊天基线 + 第 0..N 楼（含本楼）的 ops；swipe 不匹配的 ops 忽略。

const CHAT_META_KEY = 'zhiku_chat_chars';
const CHAR_OPS_KEY = 'zhikuCharOps';
const CHAR_BLOCK_TYPES = ['人物', '外貌变化'];

/** 用于正则里匹配两种块（不含 $ 与反斜杠问题）。 */
const CHAR_BLOCK_PATTERN_SOURCE = '<(?:人物|外貌变化)>[\\s\\S]*?<\\/(?:人物|外貌变化)>';

/** 全角标点与全角尖括号 → 半角，便于解析。 */
function normalizeBlockText(text) {
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
function pairsFromTags(text) {
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

function tagsText(list) {
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
function parseCharacterBlocks(text) {
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
function buildCharOps(text, { locked = new Set(), known = new Set(), at = Date.now() } = {}) {
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
function buildCharOpsIfEnabled(text, options = {}) {
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
function applyCharOps(entries, ops, floor, { locked, pos } = {}) {
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

function messageOps(message) {
    const raw = message?.extra?.[CHAR_OPS_KEY];
    if (!raw || raw.v !== 1 || !Array.isArray(raw.ops)) return null;
    return { v: 1, swipe: Number.isInteger(raw.swipe) ? raw.swipe : 0, ops: raw.ops };
}

function messageOpsPayload(ops, swipe) {
    const list = Array.isArray(ops) ? ops : [];
    return list.length ? { v: 1, swipe: Number.isInteger(swipe) ? swipe : 0, ops: list } : undefined;
}

/** 忽略 at 的比较，避免每次渲染都重写消息。 */
function sameCharOps(a, b) {
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
function deriveTimeline(baseEntries, chat, { locked } = {}) {
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
function stripOpsForName(chat, name) {
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
function lockedCharNames(characters, baseEntries) {
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

function normalizeChatEntry(raw) {
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

function normalizeChatStore(raw) {
    const entries = Array.isArray(raw?.entries) ? raw.entries : [];
    const out = [];
    for (const item of entries) {
        const entry = normalizeChatEntry(item);
        if (entry && !out.some(e => e.name === entry.name)) out.push(entry);
    }
    return out;
}

function chatStorePayload(entries) {
    return { v: 1, entries: (Array.isArray(entries) ? entries : []).map(cloneEntry) };
}

/** 从全局角色复制一份聊天库条目（「复制到本聊天」）。 */
function entryFromGlobal(character) {
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
function globalFromChatEntry(entry) {
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
function mergeCharacterLayers(chatEntry, globalChar) {
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
function mergeChatEntriesWithGlobals(chatEntries, globals) {
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
function capHistory(records) {
    return (Array.isArray(records) ? records : []).slice(-HISTORY_CAP);
}

/** 把某名字在各楼层的 ops 收成字段级历史记录（不修改消息）。 */
function historyFromOps(timeline, name, chat) {
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
function manualHistoryRecord(entry, reason = '手动', at = Date.now()) {
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
function charCacheKey(chat, baseEntries) {
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
function chatMacroText(chatEntries, cast, { locked, globals } = {}) {
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

/** 全局角色的 aliases 存成字符串（逗号拼接）：数组、竖线、中文逗号都认。 */
function ensureAliases(character) {
    if (!character || typeof character !== 'object') return character;
    const list = splitAliasList(character.aliases).filter(alias => alias !== character.name);
    character.aliases = list.join('，');
    character.nl = typeof character.nl === 'string' ? character.nl.trim() : '';
    return character;
}

/** 别名列表（表单、分享、本聊天条目用）。 */
function splitAliases(value) {
    return splitAliasList(value);
}
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

const ctx = () => SillyTavern.getContext();

// ───────────── 读酒馆里的角色卡、人设 ─────────────

function avatarUrl(c) {
    if (c.kind === 'user') return `/thumbnail?type=persona&file=${encodeURIComponent(c.avatar)}`;
    if (c.kind === 'free') return c.image || '';
    const file = c.kind === 'side' ? c.card : c.avatar;
    return file ? `/thumbnail?type=avatar&file=${encodeURIComponent(file)}` : '';
}

/** 酒馆里所有角色卡 */
function stCards() {
    return (ctx().characters || []).filter(c => c?.avatar).map(c => ({ key: 'char:' + c.avatar, kind: 'char', name: c.name, avatar: c.avatar, desc: [c.description, c.data?.description].find(Boolean) || '' }));
}
/** 酒馆里所有人设 */
function stPersonas() {
    const pu = ctx().powerUserSettings || {};
    return Object.entries(pu.personas || {}).map(([id, name]) => ({ key: 'user:' + id, kind: 'user', name, avatar: id, desc: pu.persona_descriptions?.[id]?.description || '' }));
}
function currentPersonaKey() {
    const c = ctx();
    const pu = c.powerUserSettings || {};
    const locked = c.chatMetadata?.persona;
    if (locked && pu.personas?.[locked]) return 'user:' + locked;
    const hit = Object.entries(pu.personas || {}).find(([, n]) => n === c.name1);
    return hit ? 'user:' + hit[0] : '';
}

const blank = src => ({
    key: src.key, kind: src.kind, name: src.name, avatar: src.avatar || '', card: src.card || '',
    appearance: [], nsfwBody: [], outfitMode: 'story', outfits: [], outfitId: '', negative: '', charRef: '',
    aliases: '', nl: '',
});

/** 取一个角色（还没写过外貌的也给一份空的，存档时才写进数据） */
function getChar(key) {
    const d = getData();
    if (d.characters[key]) return ensureAliases(d.characters[key]);
    const src = [...stCards(), ...stPersonas()].find(x => x.key === key);
    return src ? blank(src) : null;
}
function saveChar(c) {
    const d = getData();
    linkSameOutfits();
    d.characters[c.key] = c;
    try { syncOutfitsFrom(c); } catch (e) { console.warn('[智库] 同步衣服', e); }
    commit({ silent: true });
}
/** 角色卡描述（给 AI 读外貌用） */
function descOf(c) {
    if (c.kind === 'side') return '';
    return [...stCards(), ...stPersonas()].find(x => x.key === c.key)?.desc || '';
}
/** 读人设用：描述、性格、场景、卡里的世界书、绑定的世界书都拿来；配角只拿提到它名字的世界书条目 */
async function descOfFull(c) {
    const cx = ctx();
    const parts = [];
    const add = (title, text) => { text = String(text || '').trim(); if (text) parts.push(`【${title}】\n${text}`); };
    const fromBook = (title, entries, name) => {
        const list = (Array.isArray(entries) ? entries : Object.values(entries || {}))
            .filter(e => e && !e.disable && e.enabled !== false && String(e.content || '').trim());
        const picked = name ? list.filter(e => [e.comment, e.content, ...(e.key || e.keys || [])].some(x => String(x || '').includes(name))) : list;
        for (const e of picked) add(`${title}：${e.comment || (e.key || e.keys || []).join('、') || '条目'}`, e.content);
    };
    const loadBook = async name => { try { return name ? (await cx.loadWorldInfo?.(name))?.entries : null; } catch { return null; } };
    const fullCard = async avatar => {
        let card = (cx.characters || []).find(x => x?.avatar === avatar) || null;
        if (card && !card.shallow && (card.description || card.data?.character_book || card.data?.extensions?.world)) return card;
        // 酒馆开了懒加载时，列表里的卡只有名字和头像
        try {
            const r = await fetch('/api/characters/get', { method: 'POST', headers: cx.getRequestHeaders(), body: JSON.stringify({ avatar_url: avatar }) });
            if (r.ok) card = await r.json();
        } catch { /* 用列表里的 */ }
        return card;
    };
    if (c.kind === 'user') {
        const pd = (cx.powerUserSettings || {}).persona_descriptions?.[String(c.key).replace(/^user:/, '')] || {};
        add('人设', pd.description);
        fromBook('人设世界书', await loadBook(pd.lorebook), parts.length ? c.name : '');
    } else {
        const side = c.kind === 'side';
        const card = await fullCard(side ? c.card : c.avatar);
        const dd = card?.data || {};
        if (!side) {
            add('描述', card?.description || dd.description);
            add('性格', card?.personality || dd.personality);
            add('场景', card?.scenario || dd.scenario);
        }
        // 卡里已经写了设定：世界书只拿提到这个名字的条目；没写：整本都给 AI 挑
        const only = side || parts.length ? c.name : '';
        fromBook('卡里的世界书', dd.character_book?.entries, only);
        fromBook('绑定的世界书', await loadBook(dd.extensions?.world), only);
        if (!side && !parts.length) add('开场白', card?.first_mes || dd.first_mes);
    }
    return parts.join('\n\n').slice(0, 60000);
}

/** 卡里的配角 */
function sideKicks(cardAvatar) {
    return Object.values(getData().characters).filter(c => c.kind === 'side' && c.card === cardAvatar);
}
function addSideKick(cardAvatar, name) {
    const c = blank({ key: `side:${cardAvatar}:${M.uid('')}`, kind: 'side', name, card: cardAvatar });
    saveChar(c);
    return c;
}
function deleteChar(key) {
    const d = getData();
    delete d.characters[key];
    commit();
}

// ───────────── 这次聊天里的角色 ─────────────

function chatId() {
    const c = ctx();
    return c.getCurrentChatId?.() || c.chatId || (c.groupId ? 'group:' + c.groupId : 'char:' + (c.characters?.[c.characterId]?.avatar || ''));
}

/** 当前聊天出场的角色：[{ key, char, on, group: 'user'|'char' }] */
function currentCast() {
    const c = ctx();
    const d = getData();
    const cards = [];
    if (c.groupId) {
        const g = (c.groups || []).find(x => x.id === c.groupId);
        for (const av of g?.members || []) cards.push(av);
    } else if (c.characters?.[c.characterId]?.avatar) {
        cards.push(c.characters[c.characterId].avatar);
    }
    const keys = [];
    const pk = currentPersonaKey();
    if (pk) keys.push(['user', pk]);
    for (const av of cards) {
        keys.push(['char', 'char:' + av]);
        for (const s of sideKicks(av)) keys.push(['char', s.key]);
    }
    for (const k of Object.keys(d.chatCast[chatId()] || {})) if (!keys.some(x => x[1] === k) && d.characters[k]) keys.push(['char', k]);
    const flags = d.chatCast[chatId()] || {};
    return keys.map(([group, key]) => {
        const ch = getChar(key);
        if (!ch) return null;
        const on = flags[key] ?? (ch.appearance.length > 0);
        return { key, char: ch, on, group };
    }).filter(Boolean);
}
function removeFromCast(key) {
    const d = getData();
    if (d.chatCast[chatId()]) delete d.chatCast[chatId()][key];
    commit({ silent: true });
}
function setCastOn(key, on) {
    const d = getData();
    (d.chatCast[chatId()] ||= {})[key] = !!on;
    commit({ silent: true });
}

// ───────────── 提示词 ─────────────

const tagText = list => (list || []).map(t => t.en).filter(Boolean).join(', ');
function currentOutfit(c) { return c.outfits.find(o => o.id === c.outfitId) || c.outfits[0] || null; }
/** 这个角色固定会发的标签（外貌 + 固定的衣服） */
function fixedTags(c, { nsfw = false } = {}) {
    const parts = [tagText(c.appearance)];
    // NSFW 身体：只有这张图是 NSFW 时才加
    if (nsfw) parts.push(tagText(c.nsfwBody));
    if (c.outfitMode === 'fixed') parts.push(tagText(currentOutfit(c)?.tags));
    return parts.filter(Boolean).join(', ');
}

const GENDER = { '1boy': 'boy', '1girl': 'girl', '1other': 'other' };
function genderOf(c) {
    const t = c.appearance.map(x => x.en.toLowerCase()).find(x => GENDER[x]);
    return t ? GENDER[t] : '';
}
/** 分角色时，角色那一段里的 1boy 写成 boy（照 NovelAI 官网的写法） */
const soloize = s => s.replace(/\b1boy\b/gi, 'boy').replace(/\b1girl\b/gi, 'girl').replace(/\b1other\b/gi, 'other');
function countTags(chars) {
    const n = { boy: 0, girl: 0, other: 0 };
    for (const c of chars) { const g = genderOf(c); if (g) n[g]++; }
    const out = [];
    if (n.boy) out.push(n.boy === 1 ? '1boy' : `${Math.min(n.boy, 6)}boys`);
    if (n.girl) out.push(n.girl === 1 ? '1girl' : `${Math.min(n.girl, 6)}girls`);
    if (n.other) out.push(n.other === 1 ? '1other' : `${n.other}others`);
    return out.join(', ');
}
const snap = v => { const g = [0.1, 0.3, 0.5, 0.7, 0.9]; v = Number(v); return Number.isFinite(v) ? g.reduce((a, b) => Math.abs(b - v) < Math.abs(a - v) ? b : a) : 0.5; };

/** 能不能分角色（酒馆转发和 V3 不行） */
function canSplit() {
    const s = N.settings();
    return s.naiMode !== 'tavern' && s.novelaimode !== 'nai-diffusion-3' && !(s.naiMode === 'site' && String(s.naiSiteSimple) === 'true');
}

/**
 * 拼出这一张的提示词。
 * scene：AI 写的场景；picks：[{ char, tags, x, y }]
 */
const hasNsfwRating = text => M.tokenize(String(text || '').replace(/[;\n]/g, ',')).some(t => t.text.trim().toLowerCase() === 'nsfw');
function buildChatPrompt(scene, picks, { nsfw = hasNsfwRating(scene) } = {}) {
    const d = getData();
    const artist = d.active ? M.ticketString(d, d.active) : '';
    const chars = picks.map(p => p.char);
    const base = M.mergeTags(artist, /\b(?:\d+(?:boys?|girls?|others?)|no humans)\b/i.test(scene) ? '' : countTags(chars), scene, d.options.chatPositive || '');
    const chatNeg = [d.active ? M.ticketNeg(d, d.active) : '', d.options.chatNegative || ''].filter(Boolean).join(', ');
    if (d.options.chatNoSplit || !canSplit() || picks.length === 0) {
        const flat = M.mergeTags(base, ...picks.map(p => [fixedTags(p.char, { nsfw }), p.tags].filter(Boolean).join(', ')));
        const { positive, negative } = E.composeStudio({ pos: flat, neg: [chatNeg, ...picks.flatMap(p => [p.char.negative, p.uc])].filter(Boolean).join(', ') });
        return { positive, negative, chars: [] };
    }
    const { positive, negative } = E.composeStudio({ pos: base, neg: chatNeg });
    return {
        positive, negative,
        chars: picks.map(p => ({ prompt: soloize([fixedTags(p.char, { nsfw }), p.tags].filter(Boolean).join(', ')), uc: [p.char.negative, p.uc].filter(Boolean).join(', '), center: { x: snap(p.x), y: snap(p.y) } })),
    };
}

/** 名字和别名（别名用逗号隔开），两个字以上才算，免得「我」「她」到处都对上 */
function namesOf(ch) {
    return [ch.name, ...String(ch.aliases || '').split(/[,，、;；\s]+/)].map(s => String(s || '').trim()).filter(s => s.length >= 2);
}
/** 这段文字里提到了谁：只看这次聊天开着的、写了外貌的角色 */
function castIn(text) {
    const t = String(text || '');
    if (!t) return [];
    return currentCast().filter(x => x.on && fixedTags(x.char) && namesOf(x.char).some(n => t.includes(n))).map(x => x.char);
}
/** 每张图独立解析角色；周围正文只用于选镜头，不参与入画名单。 */
function markerPrompt(prompt, { story, floor, pos } = {}) {
    // 本聊天档案按楼层（和位置）重放后并进名单；与全局同名时覆盖全局条目，免得「匹配到多人」
    const roster = rosterAt(floor, pos);
    const plan = readIllustrationPlan(prompt);
    const parsed = plan ? compileIllustrationPlan(plan, roster, story === undefined ? undefined : imageStoryText(story)) : resolveImageCharacters(prompt, roster);
    if (parsed.unknown?.length) toastr.info(`「${parsed.unknown.join('、')}」没在角色页登记（或这次聊天没开），按图里写的标签画`, '智库', { timeOut: 4000 });
    const rating = plan?.rating?.toLowerCase() || (hasNsfwRating(parsed.scene) ? 'nsfw' : undefined);
    const built = buildChatPrompt(parsed.scene, parsed.picks, { nsfw: rating === 'nsfw' });
    return { ...built, positive: applyIllustrationRating(built.positive, rating), cast: parsed.cast };
}

/** 「会发送的内容」预览（不调 AI，只看角色那部分） */
function previewCast() {
    return currentCast().filter(x => x.on).map(x => ({ name: x.char.name, tags: fixedTags(x.char), story: x.char.outfitMode === 'story' }));
}

// ───────────── 聊天里生图 ─────────────

function chatText(upTo, n = 6) {
    const chat = ctx().chat || [];
    const from = Math.max(0, upTo - n + 1);
    return chat.slice(from, upTo + 1).filter(m => !m.is_system).map(m => `${m.name}: ${String(m.mes || '').replace(/<[^>]+>/g, '')}`).join('\n\n');
}

/** 给第 mesId 楼生一张图，插到这一楼后面。返回 dataUrl */
async function generateForMessage(mesId, { onStep } = {}) {
    if ((typeof __mod_nai === 'undefined' || __mod_nai.chatBackend?.() !== 'comfy') && !N.isReady()) throw new Error('还没填 NovelAI key，到画师库 → 设置填');
    const c = ctx();
    if (!c.chat?.[mesId]) throw new Error('找不到这一楼');
    const cast = currentCast().filter(x => x.on).map(x => x.char);
    onStep?.('AI 正在写画面…');
    const sc = await T.sceneFromChat(chatText(mesId), cast.map(ch => ({ name: ch.name, story: ch.outfitMode === 'story' })));
    const picks = [];
    for (const p of sc.characters) {
        const ch = cast.find(x => x.name === p.name) || cast.find(x => p.name.includes(x.name) || x.name.includes(p.name));
        if (ch && !picks.some(q => q.char === ch)) picks.push({ char: ch, tags: p.tags, x: p.x, y: p.y });
    }
    const prompt = buildChatPrompt(sc.scene, picks);
    onStep?.(N.chatBackend() === 'comfy' ? 'ComfyUI 正在画…' : 'NovelAI 正在画…');
    // 只用出场角色在角色页里绑的角色参考
    const bound = [...new Set(picks.map(p => p.char.charRef).filter(id => id && getData().charRefGroups?.[id]))];
    const director = N.chatBackend() !== 'comfy' && bound.length ? await E.charRefs(bound) : null;
    const image = await E.generateFull({ ...prompt, director, backend: (typeof __mod_nai !== 'undefined' && __mod_nai.chatBackend?.()) || 'nai' });
    await insertImage(mesId, image);
    return image;
}

async function insertImage(mesId, dataUrl) {
    const c = ctx();
    const msg = c.chat[mesId];
    const { url } = await uploadImage(dataUrl, `chat_${Date.now()}`);
    msg.mes = `${msg.mes || ''}\n\n<img src="${url}" alt="画师库生成" class="pc-chat-img">`;
    c.updateMessageBlock(mesId, msg);
    await c.saveChat();
}

// ───────────── 共享 / 从智绘姬搬：角色和衣服 ─────────────

/** "black hair（黑发）, short hair" → [{en, zh}] */
function parsePairs(text) {
    const out = [];
    let depth = 0, cur = '';
    for (const ch of String(text || '')) {
        if ('({[（'.includes(ch)) depth++;
        if (')}]）'.includes(ch)) depth = Math.max(0, depth - 1);
        if ((ch === ',' || ch === '，') && depth === 0) { out.push(cur); cur = ''; } else cur += ch;
    }
    out.push(cur);
    return out.map(s => s.trim()).filter(Boolean).map(s => {
        const m = s.match(/^(.*?)（([^（）]*)）\s*$/);
        return m ? { en: m[1].trim(), zh: m[2].trim() } : { en: s, zh: '' };
    }).filter(x => x.en && !T.hasChinese(x.en));
}

/** 不绑定角色卡的角色（从共享存下来、从智绘姬搬来的） */
function freeChars() { return Object.values(getData().characters).filter(c => c.kind === 'free'); }

function uniqueName(name) {
    const names = new Set(Object.values(getData().characters).map(c => c.name));
    let n = name || '角色', i = 2;
    while (names.has(n)) n = `${name} (${i++})`;
    return n;
}

/** 智绘姬的角色 / 服装格式 → 我们的 */
function fromZhihuijiChar(ch, outfits = {}) {
    return {
        name: ch.nameCN || ch.nameEN || '角色',
        aliases: splitAliases(ch.nameEN),
        appearance: parsePairs([ch.facialFeatures, ch.characterTraits && !T.hasChinese(String(ch.characterTraits).replace(/（[^（）]*）/g, '')) ? ch.characterTraits : ''].filter(Boolean).join(', ')),
        // 智绘姬里带 nsfw 的字段（NSFW 身体特征）放进「NSFW 身体」
        nsfwBody: parsePairs(Object.entries(ch || {}).filter(([k, v]) => /nsfw/i.test(k) && typeof v === 'string' && v.trim() && !T.hasChinese(v.replace(/（[^（）]*）/g, ''))).map(([, v]) => v).join(', ')),
        outfitMode: Object.keys(outfits).length ? 'fixed' : 'story',
        outfits: Object.entries(outfits).map(([n, o]) => fromZhihuijiOutfit(n, o)),
        negative: '',
    };
}
function fromZhihuijiOutfit(name, o) {
    return { id: M.uid('o_'), name: o.nameCN || name, tags: parsePairs(o.fullBody || o.upperBody || '') };
}

/** 把共享里的一条角色存成「存下的角色」，返回 key */
function saveCharacterPost(payload, fallbackName) {
    const src = payload.character || {};
    const ours = Array.isArray(src.appearance)
        ? { name: src.name, aliases: splitAliases(src.aliases), nl: String(src.nl || "").trim(), appearance: src.appearance, nsfwBody: Array.isArray(src.nsfwBody) ? src.nsfwBody : [], outfitMode: src.outfitMode || 'story', outfits: (src.outfits || []).map(o => ({ ...o, id: M.uid('o_') })), negative: src.negative || '' }
        : fromZhihuijiChar(src, payload.outfits || {});
    const c = blank({ key: 'free:' + M.uid(''), kind: 'free', name: uniqueName(ours.name || fallbackName) });
    Object.assign(c, ours, { name: c.name });
    c.outfitId = c.outfits[0]?.id || '';
    saveChar(c);
    return c.key;
}
/** 共享里的一套衣服 → 加到某个角色身上 */
function outfitFromPost(payload, fallbackName) {
    const o = payload.outfit || {};
    if (Array.isArray(o.tags)) return { id: M.uid('o_'), name: o.name || fallbackName, tags: o.tags };
    return fromZhihuijiOutfit(fallbackName, o);
}

/** 分享用的内容 */
function characterPayload(c) {
    return { character: { name: c.name, aliases: splitAliases(c.aliases), nl: String(c.nl || "").trim(), appearance: c.appearance, nsfwBody: c.nsfwBody || [], outfitMode: c.outfitMode, outfits: c.outfits.map(({ name, tags }) => ({ name, tags })), negative: c.negative } };
}

/** 智绘姬里存的角色全搬过来，返回搬了几个 */
function importZhihuijiCharacters(z) {
    const d = getData();
    let n = 0;
    for (const [name, ch] of Object.entries(z?.characterPresets || {})) {
        if (!ch || typeof ch !== 'object') continue;
        const cn = ch.nameCN || name;
        if (freeChars().some(c => c.name === cn)) continue;
        const owners = [ch.nameEN, ch.nameCN, name].filter(Boolean).map(x => String(x).toLowerCase());
        const outfits = {};
        for (const [on, o] of Object.entries(z.outfitPresets || {})) {
            const ow = String(o?.owner || '').split('|').map(x => x.trim().toLowerCase());
            if (ow.some(x => owners.includes(x))) outfits[on] = o;
        }
        saveCharacterPost({ character: ch, outfits }, cn);
        n++;
    }
    if (n) commit();
    return n;
}

/** 把一个角色的外貌、衣服套到另一个角色上 */
function copyLook(fromKey, toKey) {
    const a = getChar(fromKey), b = getChar(toKey);
    if (!a || !b) return;
    b.appearance = structuredClone(a.appearance);
    b.nsfwBody = structuredClone(a.nsfwBody || []);
    b.outfitMode = a.outfitMode;
    b.outfits = a.outfits.map(o => ({ ...structuredClone(o), id: M.uid('o_') }));
    b.outfitId = b.outfits[0]?.id || '';
    b.negative = a.negative;
    b.nl = String(a.nl || '');
    saveChar(b);
}

// ───────────── 衣柜 ─────────────

/** 衣柜里所有衣服：角色身上的 + 还没给谁穿的。[{ o, owner }] */
function wardrobe() {
    const d = getData();
    const out = [];
    for (const c of Object.values(d.characters)) for (const o of c.outfits || []) out.push({ o, owner: c });
    for (const o of Object.values(d.outfits || {})) out.push({ o, owner: null });
    return out;
}
function findOutfit(ownerKey, id) {
    const d = getData();
    if (!ownerKey) return d.outfits?.[id] ? { o: d.outfits[id], owner: null } : null;
    const c = d.characters[ownerKey];
    const o = c?.outfits?.find(x => x.id === id);
    return o ? { o, owner: c } : null;
}
// 同一套衣服给好几个人穿：每人身上各有一份（生图照旧按人读），用 sid 连起来，改一份其余跟着改；衣柜里只显示一张
const outSig = o => JSON.stringify([o.name || '', (o.tags || []).map(t => [String(t.en || '').toLowerCase(), t.acc ?? null]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))]);
/** Only migrate legacy duplicates once; preserve explicitly separate outfits afterwards. */
function linkSameOutfits() {
    const d = getData();
    if (d.options.wardrobeLinkedV1) return;
    const groups = new Map();
    for (const c of Object.values(d.characters)) for (const o of c.outfits || []) {
        if (!o.tags?.length) continue;
        const key = outSig(o), list = groups.get(key) || [];
        list.push({ c, o }); groups.set(key, list);
    }
    for (const list of groups.values()) {
        if (list.length < 2 || new Set(list.map(x => x.c.key)).size !== list.length) continue;
        const sids = new Set(list.map(x => x.o.sid).filter(Boolean));
        if (sids.size > 1) continue;
        const sid = sids.values().next().value || M.uid('os_');
        for (const { o } of list) o.sid = sid;
    }
    d.options.wardrobeLinkedV1 = true;
    commit({ silent: true });
}
/** 这套衣服的所有份：[{ o, owner }] */
function outfitHolders(o) {
    if (!o?.sid) return wardrobe().filter(x => x.o === o);
    return wardrobe().filter(x => x.owner && x.o.sid === o.sid);
}
/** 衣柜按「同一套」分组：[{ o, owner, holders }] */
function wardrobeGroups() {
    linkSameOutfits();
    const groups = new Map(), out = [];
    for (const x of wardrobe()) {
        const k = x.owner && x.o.sid ? 'sid:' + x.o.sid : 'one:' + (x.owner?.key || '') + ':' + x.o.id;
        let g = groups.get(k);
        if (!g) { g = { o: x.o, owner: x.owner, holders: [] }; groups.set(k, g); out.push(g); }
        g.holders.push(x);
    }
    return out;
}
/** 改了某人身上的那份：同一套的其他份跟着改 */
function syncOutfitsFrom(c) {
    const d = getData();
    for (const o of c.outfits || []) {
        if (!o.sid) continue;
        for (const other of Object.values(d.characters)) {
            if (other === c) continue;
            for (const x of other.outfits || []) if (x.sid === o.sid && x !== o && (x.name !== o.name || x.image !== o.image || JSON.stringify(x.tags) !== JSON.stringify(o.tags))) {
                x.name = o.name; x.image = o.image; x.tags = structuredClone(o.tags);
            }
        }
    }
}
/** 从某人身上拿掉：别人还穿着就只删他那份；没人穿了就放回衣柜 */
function takeOffOutfit(ownerKey, id) {
    const d = getData();
    const hit = findOutfit(ownerKey, id);
    if (!hit?.owner) return null;
    const rest = outfitHolders(hit.o).filter(x => x.owner.key !== ownerKey);
    const c = hit.owner;
    c.outfits = c.outfits.filter(x => x !== hit.o);
    if (c.outfitId === id) c.outfitId = c.outfits[0]?.id || '';
    if (!rest.length) { const o = { ...hit.o }; delete o.sid; d.outfits ||= {}; d.outfits[o.id] = o; }
    commit({ silent: true });
    return rest[0] || { o: d.outfits[id], owner: null };
}
/** 删掉整套：所有人身上的都删 */
function deleteOutfitGroup(ownerKey, id) {
    const hit = findOutfit(ownerKey, id);
    if (!hit) return;
    const all = hit.owner ? outfitHolders(hit.o) : [hit];
    for (const x of all) deleteOutfit(x.owner?.key || '', x.o.id);
}
/** 给角色穿：衣柜里的那件挪过去；已经在别人身上的，给他也挂一份（和原来那份连在一起） */
function giveOutfit(ownerKey, id, toKey, { wear = true } = {}) {
    const d = getData();
    const hit = findOutfit(ownerKey, id);
    const to = getChar(toKey);
    if (!hit || !to) return null;
    let o = hit.o;
    if (!hit.owner) delete d.outfits[id];
    else if (hit.owner.key !== to.key) {
        hit.o.sid ||= hit.o.id;
        const same = to.outfits.find(x => x.sid === hit.o.sid);
        if (same) { if (wear) { to.outfitId = same.id; to.outfitMode = 'fixed'; } saveChar(to); saveChar(hit.owner); return same; }
        o = { ...structuredClone(o), id: M.uid('o_'), sid: hit.o.sid };
        saveChar(hit.owner);
    }
    else { if (wear) { to.outfitId = o.id; to.outfitMode = 'fixed'; } saveChar(to); return o; }
    to.outfits.push(o);
    if (wear) { to.outfitId = o.id; to.outfitMode = 'fixed'; }
    saveChar(to);
    return o;
}
function deleteOutfit(ownerKey, id) {
    const d = getData();
    if (!ownerKey) delete d.outfits[id];
    else {
        const c = d.characters[ownerKey];
        if (c) { c.outfits = c.outfits.filter(x => x.id !== id); if (c.outfitId === id) c.outfitId = c.outfits[0]?.id || ''; }
    }
    commit();
}

/** 生图页选的入画角色 → 提示词。cast：[{ key, pos: 'L'|'C'|'R', outfit?: 衣服 id，'' = 不穿固定衣服 }] */
const CAST_X = { L: 0.3, C: 0.5, R: 0.7 };
function studioCastPick(e, nsfw = false) {
    const ch = getChar(e.key);
    if (!ch) return null;
    const out = e.outfit === '' ? null : (ch.outfits.find(o => o.id === e.outfit) || currentOutfit(ch));
    const look = [tagText(ch.appearance), nsfw ? tagText(ch.nsfwBody) : ''].filter(Boolean).join(', ');
    const act = String(e.act || '').trim(), fit = tagText(out?.tags);
    // 分角色时：外貌 → 这个人的动作 → 衣服，动作别被一长串衣服挤到最后
    return { char: ch, pos: CAST_X[e.pos] ? e.pos : 'C', look, act, fit, tags: [look, act, fit].filter(Boolean).join(', '), x: CAST_X[e.pos] ?? 0.5 };
}
function studioCastPrompt({ pos = '', neg = '', scene = '' }, cast) {
    const nsfw = hasNsfwRating([pos, scene].filter(Boolean).join(', '));
    const picks = (cast || []).map(e => studioCastPick(e, nsfw)).filter(Boolean);
    if (!picks.length) return { ...E.composeStudio({ pos, neg, scene }), chars: [], picks };
    const chars = picks.map(p => p.char);
    const hasCount = /\b(?:\d+(?:boys?|girls?|others?)|no humans)\b/i.test(pos);
    const negAll = [neg, ...chars.map(c => c.negative)].filter(Boolean).join(', ');
    if (picks.length === 1 || !canSplit({ chat: false })) {
        const lead = picks.length === 1 ? 'solo' : (hasCount ? '' : countTags(chars));
        // 固定提示词（动作、镜头）放在外貌后面、衣服前面：NovelAI 越靠前越听话，原来排在一长串衣服后面容易被忽略
        return { ...E.composeStudio({ pos: M.mergeTags(pos, lead, ...picks.map(p => [p.look, p.act].filter(Boolean).join(', ')), scene, ...picks.map(p => p.fit)), neg: negAll, scene: '' }), chars: [], picks };
    }
    const r = E.composeStudio({ pos: M.mergeTags(hasCount ? '' : countTags(chars), pos), neg, scene });
    return { ...r, chars: picks.map(p => ({ prompt: soloize(p.tags), uc: p.char.negative || '', center: { x: p.x, y: 0.5 } })), picks };
}
/** 入画角色绑的长相参考组 */
function studioCastRefs(picks) {
    const d = getData();
    return [...new Set((picks || []).map(p => p.char.charRef).filter(id => id && d.charRefGroups?.[id]))];
}

return { studioCastPrompt, wardrobeGroups, outfitHolders, takeOffOutfit, deleteOutfitGroup, studioCastRefs, namesOf, castIn, markerPrompt, avatarUrl, stCards, stPersonas, currentPersonaKey, getChar, saveChar, descOf, descOfFull, sideKicks, addSideKick, deleteChar, chatId, currentCast, removeFromCast, setCastOn, tagText, currentOutfit, fixedTags, canSplit, buildChatPrompt, previewCast, generateForMessage, insertImage, parsePairs, freeChars, saveCharacterPost, outfitFromPost, characterPayload, importZhihuijiCharacters, copyLook, wardrobe, findOutfit, giveOutfit, deleteOutfit, allChars, mergedChatEntries, rosterAt, stageStreamText, characterMacroText, chatBaseEntries, writeChatBase, chatStateAt, chatLatest, chatLockedNames, applyCharacterBlocks, applyAllCharacterBlocks, invalidateCharState, saveChatEntry, deleteChatEntry, chatEntryRollback, promoteChatEntry, copyGlobalToChat };
})();

// ───── ui.js ─────
// Marker-triggered generation and prompt-only filtering. No chat LLM request.
// 智库插进楼层的图片（<img class="pc-chat-img"> / alt="画师库生成"）也不发给聊天 AI
const CHAT_IMG_PATTERN='<img\\b[^>]*(?:pc-chat-img|画师库生成)[^>]*>';
const MARKER_REGEX_ID = '72c57f73-46af-46ac-a28e-bf31b131332a';
const MARKER_DISPLAY_ID = '6ba93a8e-cabb-494c-a7e8-6c9dfcf5fb80';
const CHAR_BLOCK_DISPLAY_ID = 'a7c1d9b4-2f5e-4c6a-9d31-8b0f4e2a5c77';
const CHAR_BLOCK_RE_SOURCE = '<(?:人物|外貌变化)>[\\s\\S]*?<\\/(?:人物|外貌变化)>';
function escapeMarker(value) { return value.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&'); }
function markerPattern(start, end) { return escapeMarker(start) + '[\\s\\S]*?' + escapeMarker(end); }
function parseImageMarkers(text, start, end) {
    if (!start || !end) return [];
    const result=[];
    const regex=new RegExp(escapeMarker(start)+'([\\s\\S]*?)'+escapeMarker(end),'g');
    for (const m of String(text || '').matchAll(regex)) {
        const prompt=m[1].trim();
        if (prompt) result.push({raw:m[0],prompt,index:m.index});
    }
    return result;
}
// Preserve identities when new markers are inserted before existing, possibly identical markers.
function shiftImageRecords(records, tokens, swipe, shifts) {
    if(!records)return records;
    const next={...records},prefix=String(swipe??0)+':',used=new Set(),moves=[];
    for(const token of tokens){
        const exact=prefix+token.index+':'+token.raw;
        const candidates=Object.keys(records).filter(k=>k.startsWith(prefix)&&k.endsWith(':'+token.raw)&&/^\d+$/.test(k.slice(prefix.length,k.length-token.raw.length-1))).sort((a,b)=>parseInt(a.slice(prefix.length))-parseInt(b.slice(prefix.length)));
        const old=records[exact]&&!used.has(exact)?exact:candidates.find(k=>!used.has(k));
        if(!old)continue;used.add(old);
        const index=token.index+shifts.filter(s=>s.at<=token.index).reduce((sum,s)=>sum+s.length,0);
        moves.push([old,prefix+index+':'+token.raw]);
    }
    for(const [old]of moves)delete next[old];
    for(const [old,key]of moves)next[key]=records[old];
    return next;
}
function createMarkerController({context,getData,generate,upload,notify,expandPrompt,getStreamingText,document:doc=globalThis.document,resolveUrl=u=>u}) {
    // 图存在本地浏览器时地址是 idb:xxx，要先换成能显示的地址；换不出来（存在别的设备上）就是空的
    function showUrl(url,apply,missing){Promise.resolve(resolveUrl(url)).then(u=>{if(u)apply(u);else missing?.();},()=>missing?.());}
    let queue=Promise.resolve(), stopped=false;
    const pending=new WeakMap(), failed=new WeakMap();
    const imageBindings=new WeakSet(), overlays=new Set(), holds=new Set(), inflight=new Set(), keepOpen=new Set();
    // 这次刚生成出来的记录：只自动展开一次，重新打开聊天时仍按收起显示
    const freshResults=new Set();
    // 流式预生成：chat|floor|swipe:index:raw -> {state,job,token,image,prompt,error,floor,chat}
    const pregen=new Map();
    function settings() {
        const opts=getData().options;
        const old=context().extensionSettings['st-chatu8'] || {};
        return {
            start: String(opts.imageStartTag ?? old.startTag ?? 'image###'),
            end: String(opts.imageEndTag ?? old.endTag ?? '###'),
            auto: opts.markerAuto !== false,
            imageExpanded: opts.imageExpanded !== false,
            // 生成完自动展开结果图（关掉就退回「点一下才展开」）
            expand: opts.markerResultExpand !== false,
            // 流式预生成：回复还在流、标记一成型就先发生图请求
            stream: opts.markerStream !== false,
        };
    }
    function syncRegex() {
        const c=context(), {start,end}=settings();
        const block='(?:'+CHAR_BLOCK_RE_SOURCE+')';
        const rule={id:MARKER_REGEX_ID,scriptName:'智库 · 生图标记不发送',findRegex:'/'+(start&&end?'(?:'+markerPattern(start,end)+')|':'')+block+'|'+CHAT_IMG_PATTERN+'/g',replaceString:'',trimStrings:[],placement:[1,2],disabled:false,markdownOnly:false,promptOnly:true,runOnEdit:false,substituteRegex:0,minDepth:null,maxDepth:null};
        const rules=c.extensionSettings.regex ||= [];
        const display={...rule,id:MARKER_DISPLAY_ID,scriptName:'智库 · 生图标记折叠',findRegex:start&&end?'/'+escapeMarker(start)+'(?!\\s*'+escapeMarker(end)+')[\\s\\S]*?'+escapeMarker(end)+'/g':'/(?!)/g',markdownOnly:true,promptOnly:false,replaceString:'<div class="pc-marker-slot"><details><summary>图片提示词</summary></details><button type="button" class="pc-marker-generate">生成图片</button></div>'};
        // 角色档案块（<人物> / <外貌变化>）既不发给聊天模型，也在正文里折起来
        const charBlock={...rule,id:CHAR_BLOCK_DISPLAY_ID,scriptName:'智库 · 角色档案折叠',findRegex:'/'+block+'/g',markdownOnly:true,promptOnly:false,replaceString:'<div class="pc-marker-slot pc-char-slot"><details><summary>角色档案</summary><pre>$&</pre></details></div>'};
        let changed=false;
        for(const item of [rule,display,charBlock]) {
            const index=rules.findIndex(r=>r.id===item.id);
            if(index>=0 && JSON.stringify(rules[index])===JSON.stringify(item))continue;
            if(index<0)rules.push(item);else rules[index]=item;
            changed=true;
        }
        if(changed)c.saveSettingsDebounced();
    }
    function state(msg,token){return pending.get(msg)?.get(recordKey(msg,token))?.state;}
    function label(msg,token,record){return state(msg,token)|| (failed.get(msg)?.has(recordKey(msg,token))?'重试生成':record?.url?'重新生成':'生成图片');}
    function decorate(id) {
        if(!doc || stopped)return;
        const cfg=settings(),msg=context().chat?.[id];
        if(!msg)return;
        decorateImages(id,msg);
        const tokens=parseImageMarkers(msg.mes,cfg.start,cfg.end);
        const slots=doc.querySelectorAll(`.mes[mesid="${Number(id)}"] .mes_text :is(.pc-marker-slot,.custom-pc-marker-slot)`);
        slots.forEach((slot,index)=>{
            slot.classList.add('pc-marker-slot');
            const token=tokens[index];if(!token)return;
            const record=findRecord(msg,token);
            const ready=token.raw+'|'+(record?.url||'');
            if(slot.dataset.pcReady===ready) { const b=slot.querySelector('button');if(b){b.disabled=!!state(msg,token);b.textContent=label(msg,token,record);}return; }
            slot.dataset.pcReady=ready;
            slot.replaceChildren();
            const details=doc.createElement('details'),summary=doc.createElement('summary'),pre=doc.createElement('pre'),button=doc.createElement('button');
            const effectivePrompt=record?.prompt??token.prompt;
            const plan=effectivePrompt===token.prompt?msg.extra?.zhikuIllustrations?.find(item=>item.raw===token.raw)?.plan:undefined;
            summary.textContent=plan?.title?'画面方案 · '+plan.title:'图片提示词';
            pre.textContent=(plan?`瞬间：${plan.moment}\n原句：${plan.source}\n分级：${plan.rating}\n\n`:'')+effectivePrompt;
            details.append(summary,pre);button.type='button';button.className='pc-marker-generate';button.title='点击生成，长按编辑提示词';
            button.disabled=!!state(msg,token);button.textContent=label(msg,token,record);
            button.addEventListener('click',ev=>{ev.preventDefault();ev.stopPropagation();if(button._pcHeld)return;void process(Number(id),{manual:true,tokenIndex:index});});
            slot.append(details,button);
            const edit=()=>editPrompt(id,msg,token,index);
            bindHold(button,edit);
            if(record?.url){
                const wrapper=doc.createElement('details');wrapper.className='pc-result-collapse';
                wrapper.open=cfg.imageExpanded;
                // 「生成后自动展开」：只对这次刚生成的那张生效，历史图片仍按默认显示
                const fresh=freshResults.delete(recordKey(msg,token));
                if(cfg.expand&&fresh)wrapper.open=true;
                const header=doc.createElement('summary');
                let imageTitle='图片',imageMissing=false;
                const syncTitle=()=>{if(!imageMissing)header.textContent=imageTitle+(wrapper.open?' · 点击折叠':' · 点击展开');};
                wrapper.addEventListener('toggle',syncTitle);
                const img=doc.createElement('img');img.className='pc-result-image';img.alt='生成图片';
                showUrl(record.url,u=>{img.src=u;},()=>{imageMissing=true;header.textContent='这张图存在别的设备 / 浏览器里，这里看不到，可以点「重新生成」';img.remove();});
                wrapper.append(header,img);slot.append(wrapper);
                const vs=Array.isArray(record.versions)?record.versions:[];
                if(vs.length>1){
                    const cur=Math.max(0,vs.findIndex(v=>v.url===record.url));
                    imageTitle=`图片 · 第 ${cur+1}/${vs.length} 版`;
                    const nav=doc.createElement('div');nav.className='pc-version-nav';
                    const step=(text,to)=>{const b=doc.createElement('button');b.type='button';b.textContent=text;b.disabled=!vs[to];
                        b.addEventListener('click',ev=>{ev.preventDefault();ev.stopPropagation();void switchVersion(id,msg,token,to);});return b;};
                    const n=doc.createElement('span');n.textContent=`${cur+1} / ${vs.length}`;
                    nav.append(step('‹ 上一版',cur-1),n,step('下一版 ›',cur+1));wrapper.append(nav);
                }
                if(keepOpen.delete(id+'|'+token.index))wrapper.open=true;
                syncTitle();
                img.addEventListener('click',ev=>{ev.preventDefault();ev.stopPropagation();if(!img._pcHeld)preview(id,msg,token,index,record);});
                bindHold(img,edit);
                button.textContent=label(msg,token,record);
            }

        });
    }
    function recordKey(msg,token){return String(msg.swipe_id??0)+':'+token.index+':'+token.raw;}
    // ───────── 流式预生成 ─────────
    // 回复还在流的时候标记就已经完整出现，这里先把这张图生成掉；
    // 等消息真正落地时 process() 发现这条记录已经在手上，就直接复用，不再等。
    // 按「聊天|楼层|标记」存，不按消息对象：宿主落地时可能换掉那个对象，按对象存会对不上、白生成一次。
    function pregenSlot(chat,floor,msg,token){return chat+'|'+floor+'|'+recordKey(msg,token);}
    /** 流式文本里已经闭合的标记（没闭合的不管：那时提示词还没写完） */
    function closedMarkers(text,cfg){return parseImageMarkers(text,cfg.start,cfg.end);}
    function streamBuffer(){return typeof getStreamingText==='function'?String(getStreamingText()||''):'';}
    function pregenReset(){pregen.clear();}
    /** 没人来取（被打断、消息没落地）的结果不会一直堆着：超过 8 条就丢掉已经跑完的那些，在跑的留着 */
    function pregenPrune(){
        if(pregen.size<=8)return;
        for(const [slot,entry] of pregen){
            if(pregen.size<=8)break;
            if(!entry.job)pregen.delete(slot);
        }
    }
    /** 把这一楼所有生图标记从正文里删掉，给结构化分镜当原句证据（算法与 process 里一致） */
    function storyOf(source,all){
        let story=source;
        for(const marker of [...all].reverse())story=story.slice(0,marker.index)+story.slice(marker.index+marker.raw.length);
        return story;
    }
    /** 提示词展开：expandPrompt 可以返回字符串，也可以返回 { text, record }（record 是可读版本，存进记录） */
    function resolvePrompt(rawPrompt,meta){
        const resolved=typeof expandPrompt==='function'?expandPrompt(rawPrompt,meta):rawPrompt;
        const prompt=resolved&&typeof resolved==='object'&&resolved.text!==undefined?String(resolved.text):String(resolved??rawPrompt);
        const record=resolved&&typeof resolved==='object'&&resolved.record!==undefined?String(resolved.record):prompt;
        return {prompt,record};
    }
    async function pregenSweep(){
        if(stopped)return 0;
        const cfg=settings();
        if(!cfg.auto||!cfg.stream)return 0;
        const text=streamBuffer();
        if(!text.includes(cfg.start))return 0;
        const c=context(),chat=c.chat||[];
        // 流式阶段这条助手消息有时还没进 chat：它会落在 chat.length 这个位置，先按占位对象算好键，
        // 等它真正出现时记录键（swipe 0 + 标记下标 + 标记原文）与楼层都对得上，这张图就不会白生成。
        let floor=chat.length-1,msg=chat[floor];
        if(msg&&msg.is_system)return 0;
        if(!msg||msg.is_user){
            const generating=c.is_send_press||c.generating||c.streamingProcessor?.isStreaming;
            if(!generating)return 0;
            floor=chat.length;msg={swipe_id:0,mes:''};
        }
        const tokens=closedMarkers(text,cfg);
        if(!tokens.length)return 0;
        const chatId=chatKey(c);
        const story=storyOf(text,tokens);
        let fired=0;
        for(const token of tokens){
            const key=recordKey(msg,token),slot=pregenSlot(chatId,floor,msg,token);
            if(pregen.has(slot))continue;
            if(msg.extra?.zhikuImages?.[key])continue;
            if(failed.get(msg)?.has(key))continue;
            const entry={state:'预生成中…',job:null,token,raw:token.raw,key,floor,chat:chatId};
            pregen.set(slot,entry);
            entry.job=queue.then(async()=>{
                if(stopped)return 0;
                entry.state='生成中…';
                const meta={msgId:floor,floor,key,swipe:msg.swipe_id,pos:token.index};
                const resolved=resolvePrompt(token.prompt,meta);
                entry.prompt=resolved.record;
                entry.image=await generate(resolved.prompt,{...meta,story});
                return 1;
            }).catch(error=>{entry.error=error?.message||String(error);return 0;})
              .finally(()=>{entry.job=null;});
            queue=entry.job.catch(()=>{});
            pregenPrune();
            fired++;
        }
        return fired;
    }
    /**
     * 取出流式阶段的成果并删掉它（只能取一次）。
     * 先按「聊天|楼层|记录键」精确找；流式文本与落地文本偶尔有细微出入（多一个空格、标记位置挪了），
     * 这时退一步按标记原文找同一楼的那条，别让已经生成好的图白扔。
     */
    function takePregen(id,msg,token){
        if(!pregen.size)return null;
        const chatId=chatKey(context()),floor=Number(id),slot=pregenSlot(chatId,floor,msg,token);
        let hit=pregen.has(slot)?slot:null;
        if(!hit){
            for(const [k,entry] of pregen){
                if(entry.floor===floor&&entry.chat===chatId&&entry.raw===token.raw){hit=k;break;}
            }
        }
        if(!hit)return null;
        const entry=pregen.get(hit);
        pregen.delete(hit);
        return entry;
    }
    // 已经存的结果按「swipe + 标记原文」找：标记前面的文字被别的脚本改过、位置挪了，也认得出是同一张，不会再生成一次
    function findRecordKey(msg,token){
        const recs=msg.extra?.zhikuImages;if(!recs)return '';
        const exact=recordKey(msg,token);if(recs[exact])return exact;
        const pre=String(msg.swipe_id??0)+':',suf=':'+token.raw;
        const keys=Object.keys(recs).filter(k=>k.startsWith(pre)&&k.endsWith(suf)&&/^\d+$/.test(k.slice(pre.length,k.length-suf.length)))
            .sort((a,b)=>parseInt(a.slice(pre.length))-parseInt(b.slice(pre.length)));
        if(!keys.length)return '';
        // 同一段标记出现好几次时，按第几次出现对上
        const same=parseImageMarkers(String(msg.mes||''),settings().start,settings().end).filter(t=>t.raw===token.raw);
        return keys[Math.max(0,same.findIndex(t=>t.index===token.index))]||keys[0];
    }
    function findRecord(msg,token){const k=findRecordKey(msg,token);return k?msg.extra.zhikuImages[k]:undefined;}
    function bindHold(el,action){
        let timer=null,start=null;
        const cancel=()=>{if(timer!==null){clearTimeout(timer);holds.delete(timer);timer=null;}};
        el.addEventListener('pointerdown',ev=>{if(ev.button!=null&&ev.button!==0)return;cancel();el._pcHeld=false;start=[ev.clientX,ev.clientY];timer=setTimeout(()=>{holds.delete(timer);timer=null;el._pcHeld=true;if(!stopped)action();},500);holds.add(timer);});
        el.addEventListener('pointermove',ev=>{if(start&&Math.hypot(ev.clientX-start[0],ev.clientY-start[1])>10)cancel();});
        for(const name of ['pointerup','pointercancel','pointerleave'])el.addEventListener(name,cancel);
        el.addEventListener('contextmenu',ev=>{ev.preventDefault();ev.stopPropagation();cancel();el._pcHeld=true;action();});
    }
    function dialog(){const back=doc.createElement('div'),box=doc.createElement('div'),close=doc.createElement('button');back.className='pc-image-preview';box.className='pc-image-dialog';close.type='button';close.textContent='关闭';box.append(close);back.append(box);doc.body.append(back);overlays.add(back);const dismiss=()=>{back.remove();overlays.delete(back);};close.onclick=dismiss;back.onclick=e=>{if(e.target===back)dismiss();};return {box,dismiss};}
    async function deleteResult(id,msg,token){
        if(pending.has(msg))throw new Error('请等本楼生成结束');
        if(context().chat?.[id]!==msg)throw new Error('聊天已变化，请重新操作');
        const records=msg.extra?.zhikuImages,key=findRecordKey(msg,token)||recordKey(msg,token),old=records?.[key];
        if(!old)return;
        // 有别的版本就只删当前这张，换到剩下的最后一张
        const rest=(old.versions||[]).filter(v=>v.url!==old.url);
        records[key]=rest.length?{...old,url:rest[rest.length-1].url,prompt:rest[rest.length-1].prompt,versions:rest}:{deleted:true};
        try{await context().saveChat();}catch(e){records[key]=old;throw e;}
        decorate(id);
    }
    async function switchVersion(id,msg,token,to){
        if(context().chat?.[id]!==msg)return;
        const k=findRecordKey(msg,token),rec=k?msg.extra.zhikuImages[k]:null,v=rec?.versions?.[to];
        if(!v)return;
        const was={url:rec.url,prompt:rec.prompt};rec.url=v.url;rec.prompt=v.prompt;keepOpen.add(id+'|'+token.index);
        try{await context().saveChat();}catch(e){Object.assign(rec,was);notify(e.message||String(e),'error');}
        decorate(id);
    }
    function preview(id,msg,token,index,record){
        const {box,dismiss}=dialog(),img=doc.createElement('img'),download=doc.createElement('a'),edit=doc.createElement('button'),remove=doc.createElement('button');
        showUrl(record.url,u=>{img.src=u;download.href=u;});download.download='zhiku_'+Date.now()+'.png';download.textContent='下载';edit.type=remove.type='button';edit.textContent='编辑 / 重新生成';remove.textContent='删除当前图片';
        edit.onclick=()=>{dismiss();editPrompt(id,msg,token,index);};
        remove.onclick=async()=>{try{await deleteResult(id,msg,token);dismiss();}catch(e){notify(e.message,'error');}};
        box.append(img,download,edit,remove);
    }
    function editPrompt(id,msg,token,index){
        const source=msg.mes,swipe=msg.swipe_id,{box,dismiss}=dialog(),input=doc.createElement('textarea'),send=doc.createElement('button'),remove=doc.createElement('button');
        input.value=token.prompt;input.rows=6;send.type=remove.type='button';send.textContent='生成图片';remove.textContent='删除当前图片';
        send.onclick=async()=>{
            if(pending.has(msg))return;
            if(context().chat?.[id]!==msg||msg.mes!==source||msg.swipe_id!==swipe){notify('消息已变化，请重新打开编辑','info');return;}
            const prompt=input.value.trim();if(!prompt)return;
            // Keep the original marker and attach the edited prompt to the generated result.
            dismiss();await process(id,{manual:true,tokenIndex:index,promptOverride:prompt});
        };
        const record=findRecord(msg,token);if(record?.prompt)input.value=record.prompt;
        remove.disabled=!record;
        remove.onclick=async()=>{try{await deleteResult(id,msg,token);dismiss();}catch(e){notify(e.message,'error');}};
        box.append(input,send,remove);
    }
    function decorateImages(id,msg) {
        for(const img of doc.querySelectorAll(`.mes[mesid="${Number(id)}"] .mes_text img:is(.pc-chat-img,.custom-pc-chat-img)`)) {
            img.classList.add('pc-chat-img');
            if(imageBindings.has(img))continue;
            imageBindings.add(img);
            const bar=doc.createElement('div');bar.className='pc-image-actions';
            const view=doc.createElement('button'),remove=doc.createElement('button');
            view.type=remove.type='button';view.textContent='查看';remove.textContent='删除图片';
            const open=()=>{
                const overlay=doc.createElement('div');overlay.className='pc-image-preview';
                const picture=doc.createElement('img'),close=doc.createElement('button');
                picture.src=img.src;close.type='button';close.textContent='关闭';
                overlay.append(picture,close);doc.body.append(overlay);overlays.add(overlay);
                const dismiss=()=>{overlay.remove();overlays.delete(overlay);};
                close.onclick=dismiss;overlay.onclick=e=>{if(e.target===overlay)dismiss();};
            };
            view.onclick=open;img.addEventListener('click',e=>{e.preventDefault();e.stopPropagation();open();});
            remove.onclick=async()=>{
                if(pending.has(msg)){notify('请等本楼生成结束后再删除图片','info');return;}
                if(context().chat?.[id]!==msg)return;
                const source=String(msg.mes),swipe=msg.swipe_id;
                const tags=[...source.matchAll(/<img\b[^>]*>/g)];
                const tag=tags.find(m=>{const holder=doc.createElement('div');holder.innerHTML=m[0];const el=holder.firstElementChild;return el?.getAttribute('src')===img.getAttribute('src') && /(?:^| )pc-chat-img(?: |$)/.test(el.className);});
                if(!tag)return;
                let raw='';try{raw=decodeURIComponent(img.getAttribute('data-pc-marker')||'');}catch{}
                const next=source.slice(0,tag.index)+raw+source.slice(tag.index+tag[0].length);
                const swipes=Array.isArray(msg.swipes)&&Number.isInteger(swipe)?msg.swipes:null,oldSwipe=swipes?.[swipe];
                msg.mes=next;if(swipes)swipes[swipe]=next;
                try {await context().saveChat();context().updateMessageBlock(id,msg);decorate(id);}
                catch(e){msg.mes=source;if(swipes)swipes[swipe]=oldSwipe;notify(e.message||String(e),'error');}
            };
            img.addEventListener('contextmenu',e=>{e.preventDefault();bar.hidden=false;remove.focus();});
            bar.append(view,remove);
            let raw='';try{raw=decodeURIComponent(img.getAttribute('data-pc-marker')||'');}catch{}
            if(raw){const details=doc.createElement('details'),summary=doc.createElement('summary'),pre=doc.createElement('pre');summary.textContent='图片提示词';pre.textContent=parseImageMarkers(raw,settings().start,settings().end)[0]?.prompt||raw;details.append(summary,pre);bar.prepend(details);}
            img.after(bar);
        }
    }
    function decorateAll() { if(doc)for(const el of doc.querySelectorAll('.mes[mesid]'))decorate(Number(el.getAttribute('mesid'))); }
    function applyImageDefault() {
        if(!doc || stopped)return;
        const open=settings().imageExpanded;
        for(const el of doc.querySelectorAll('.mes_text .pc-marker-slot .pc-result-collapse'))el.open=open;
    }
    function refresh() {
        if(!doc || stopped)return;
        const cfg=settings();
        for(const el of doc.querySelectorAll('.mes[mesid]')) {
            const id=Number(el.getAttribute('mesid')),msg=context().chat?.[id];
            if(msg && parseImageMarkers(msg.mes,cfg.start,cfg.end).length)context().updateMessageBlock(id,msg);
        }
        decorateAll();
    }
    const chatKey=c=>String(c.getCurrentChatId?.() ?? c.chatId ?? '')+'|'+String(c.characterId ?? '')+'|'+String(c.groupId ?? '');
    async function process(id,{manual=false,tokenIndex=null,tokenIndices=null,promptOverride=null}={}) {
        const c=context(),msg=c.chat?.[id],cfg=settings();
        if(stopped||!msg||msg.is_system||(!manual&&(!cfg.auto||msg.is_user)))return 0;
        const source=String(msg.mes||''),swipe=msg.swipe_id,chat=chatKey(c),all=parseImageMarkers(source,cfg.start,cfg.end);
        if(manual&&tokenIndex===null&&!Array.isArray(tokenIndices)&&all.length>1){notify('请点击具体提示词旁的生成按钮，一次只生成所选图片','info');decorate(id);return 0;}
        const selected=Array.isArray(tokenIndices)?all.filter((_,i)=>tokenIndices.includes(i)):tokenIndex===null?all:all.filter((_,i)=>i===tokenIndex);
        if(!selected.length){if(manual)notify('没有完整生图标记','info');return 0;}
        const jobs=selected.map(token=>{
            const key=recordKey(msg,token);let map=pending.get(msg);
            if(map?.has(key))return map.get(key).job;
            if(!manual&&(findRecord(msg,token)||failed.get(msg)?.has(key)))return Promise.resolve(0);
            // 酒馆把这一楼换成了新对象（重新加载、别的脚本改楼层）时，上面按对象记的排队查不到：再按楼层记一份，同一张不会同时生成两次
            const flight=chat+'|'+id+'|'+swipe+'|'+token.index+'|'+token.raw;
            if(inflight.has(flight))return Promise.resolve(0);
            // 流式阶段可能已经先生成好了这张图：取出来直接用，不再排一次队
            const ready=takePregen(id,msg,token);
            if(!map){map=new Map();pending.set(msg,map);}
            const entry={state:'排队中…',job:null};map.set(key,entry);inflight.add(flight);
            // 别的脚本改了这一楼其他地方（状态栏、正则）不算变：只要这个标记还在原位置，结果照样存
            const current=()=>!stopped&&chatKey(context())===chat&&context().chat?.[id]===msg&&msg.swipe_id===swipe&&String(msg.mes||'').slice(token.index,token.index+token.raw.length)===token.raw;
            // 预生成已出图 / 正在生成 / 报过错，都不用再排队；只有都没有时才从队尾开始
            const wait=ready?Promise.resolve(0):queue;
            const job=wait.then(async()=>{
                if(!current())return 0;
                entry.state=ready?.image!==undefined?'保存中…':'生成中…';decorate(id);
                try {
                    const rawPrompt=promptOverride??findRecord(msg,token)?.prompt??token.prompt;
                    const meta={msgId:Number(id),floor:Number(id),key,swipe,pos:token.index};
                    const resolved=resolvePrompt(rawPrompt,meta);
                    const prompt=resolved.prompt,recordPrompt=resolved.record;
                    // Story is only evidence for a structured shot's source quote, never a cast lookup.
                    let story=source;
                    for(const marker of [...all].reverse())story=story.slice(0,marker.index)+story.slice(marker.index+marker.raw.length);
                    if(ready?.job)await ready.job.catch(()=>{});
                    if(!current())return 0;
                    // 预生成已经给了图就直接用；只有用户在编辑框里改了提示词才重新生成
                    const reuse=ready?.image!==undefined&&!promptOverride;
                    const image=reuse?ready.image:await generate(prompt,{...meta,story});
                    if(!current())return 0;
                    entry.state='保存中…';decorate(id);
                    const {url}=await upload(image,'marker_'+Date.now());if(!current())return 0;
                    if(!url)throw new Error('图片上传未返回地址');
                    const hadExtra=!!msg.extra;msg.extra ||= {};const hadRecords=!!msg.extra.zhikuImages,records=msg.extra.zhikuImages ||= {},old=records[key];
                    // 重新生成不覆盖：以前的版本留着，可以翻回去（最多 10 个）
                    const prevKey=findRecordKey(msg,token),prev=prevKey&&records[prevKey]?.url?records[prevKey]:null;
                    const versions=[...(prev?.versions||(prev?[{url:prev.url,prompt:prev.prompt}]:[])),{url:String(url),prompt:recordPrompt}].slice(-10);
                    records[key]={url:String(url),prompt:recordPrompt,versions};
                    try{await c.saveChat();}catch(e){if(old)records[key]=old;else delete records[key];if(!hadRecords&&!Object.keys(records).length)delete msg.extra.zhikuImages;if(!hadExtra&&!Object.keys(msg.extra).length)delete msg.extra;throw e;}
                    failed.get(msg)?.delete(key);
                    freshResults.add(key);return 1;
                }catch(e){let errors=failed.get(msg);if(!errors){errors=new Set();failed.set(msg,errors);}errors.add(key);notify(e.message||String(e),'error');return 0;}
            }).finally(()=>{inflight.delete(flight);map.delete(key);if(!map.size)pending.delete(msg);if(!stopped&&chatKey(context())===chat)decorate(id);});
            entry.job=job;queue=job.catch(()=>{});return job;
        });
        decorate(id);return (await Promise.all(jobs)).reduce((a,b)=>a+b,0);
    }
    return {settings,syncRegex,process,decorate,decorateAll,refresh,applyImageDefault,pregenSweep,pregenReset,stop(){stopped=true;freshResults.clear();pregenReset();for(const timer of holds)clearTimeout(timer);holds.clear();for(const el of overlays)el.remove();overlays.clear();if(doc)doc.querySelectorAll('.pc-image-actions').forEach(el=>el.remove());},idle(){return queue;}};
}
/** 本地图片库：存在用户自己的浏览器（IndexedDB）里，不占酒馆服务器。地址写成 idb:xxx */
const pcLocal = (() => {
    const IDB = P.indexedDB || globalThis.indexedDB, STORE = 'images';
    let dbp = null;
    const open = () => dbp ||= new Promise((ok, bad) => {
        const r = IDB.open('zhiku_images', 1);
        r.onupgradeneeded = () => r.result.createObjectStore(STORE);
        r.onsuccess = () => ok(r.result); r.onerror = () => { dbp = null; bad(r.error); };
    });
    const run = async (mode, fn) => { const db = await open(); return new Promise((ok, bad) => { const t = db.transaction(STORE, mode); const req = fn(t.objectStore(STORE)); t.oncomplete = () => ok(req?.result); t.onerror = () => bad(t.error); t.onabort = () => bad(t.error); }); };
    const shown = new Map();
    const isLocal = u => String(u || '').startsWith('idb:');
    return {
        isLocal,
        async put(dataUrl) {
            const id = 'idb:' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
            // data: 地址自己拆成二进制，不用 fetch（有的手机浏览器不让 fetch data: 地址）
            const m = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(String(dataUrl));
            if (!m) throw new Error('图片格式不对');
            const bin = m[2] ? atob(m[3]) : decodeURIComponent(m[3]);
            const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            const blob = new Blob([bytes], { type: m[1] });
            await run('readwrite', st => st.put(blob, id));
            return id;
        },
        /** idb:xxx → 能显示的 blob 地址；别的地址原样返回；这台设备上没有就返回空 */
        async url(u) {
            if (!isLocal(u)) return u || '';
            if (shown.has(u)) return shown.get(u);
            const blob = await run('readonly', st => st.get(u)).catch(() => null);
            if (!blob) return '';
            const url = URL.createObjectURL(blob); shown.set(u, url); return url;
        },
        async del(u) { if (isLocal(u)) { await run('readwrite', st => st.delete(u)).catch(() => {}); const b = shown.get(u); if (b) { URL.revokeObjectURL(b); shown.delete(u); } } },
    };
})();
/** 生成的图存哪：默认存本地浏览器；设置里可以改成存酒馆服务器（自己的服务器、想换设备也能看时用） */
async function pcStoreImage(dataUrl, name) {
    if ((__mod_store.getData().options.imageStore || 'local') === 'server') return __mod_store.uploadImage(dataUrl, name);
    try { return { url: await pcLocal.put(dataUrl) }; }
    catch (e) {
        // 浏览器存不了（无痕模式、空间满了、浏览器不让用）：这张先存酒馆服务器，图不能丢
        console.warn('[智库] 本地存图失败，改存酒馆服务器', e);
        if (!pcStoreImage.warned) { pcStoreImage.warned = true; toastr.warning('这个浏览器存不了图（' + (e?.message || e) + '），这次先存到酒馆服务器', '智库', { timeOut: 8000 }); }
        return __mod_store.uploadImage(dataUrl, name);
    }
}
/** 删一张图：本地的从浏览器删，服务器上的调酒馆删 */
function pcDropImage(u) {
    if (!u) return;
    if (pcLocal.isLocal(u)) void pcLocal.del(u);
    else __mod_store.deleteImageFile(String(u).replace(/^\/+/, ''));
}
/** 页面里 data-pc-src / data-pc-href 写的是 idb: 地址，渲染完再换成能显示的 */
function pcHydrate(root = DOC) {
    for (const el of root.querySelectorAll('[data-pc-src]:not([data-pc-done]), [data-pc-href]:not([data-pc-done])')) {
        el.setAttribute('data-pc-done', '1');
        if (el.dataset.pcSrc) pcLocal.url(el.dataset.pcSrc).then(u => { if (u) el.src = u; else el.closest('.pc-hist-item')?.classList.add('missing'); });
        if (el.dataset.pcHref) pcLocal.url(el.dataset.pcHref).then(u => { if (u) el.href = u; });
    }
}
/** 缩略图：长边 360、JPEG，历史画廊只加载它 */
async function pcMakeThumb(dataUrl) {
    const img = await new Promise((ok, bad) => { const i = new Image(); i.onload = () => ok(i); i.onerror = bad; i.src = dataUrl; });
    const sc = Math.min(1, 360 / Math.max(img.naturalWidth, img.naturalHeight));
    const c = DOC.createElement('canvas');
    c.width = Math.max(1, Math.round(img.naturalWidth * sc)); c.height = Math.max(1, Math.round(img.naturalHeight * sc));
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.82);
}
/** 记一张生成过的图：原图地址、缩略图、提示词和参数。缩略图总是存在本地浏览器 */
async function pcRecordImage({ dataUrl, url, raw = '', sent = null, from }) {
    if (!url) return;
    let thumb = '';
    try { thumb = await pcLocal.put(await pcMakeThumb(dataUrl)); } catch (e) { console.warn('[智库] 缩略图没存上', e); }
    const d = __mod_store.getData();
    const cut = (v, n) => String(v || '').slice(0, n);
    const entry = { id: 'h' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), url: String(url), thumb, raw: String(raw ?? ''), prompt: String(sent?.prompt ?? ''), negative: String(sent?.negative ?? ''), chars: (sent?.chars || []).map(c => String(typeof c === 'string' ? c : c?.prompt ?? '')).filter(Boolean), seed: sent?.seed ?? '', size: cut(sent?.size, 20), model: cut(sent?.model, 40), from, at: Date.now() };
    d.history = [entry, ...(Array.isArray(d.history) ? d.history : []).filter(h => h.url !== entry.url)].slice(0, 300);
    __mod_store.commit({ silent: !DOC.querySelector('#pc-root.open') });
}
let pcMarkerRaw = '';
const __mod_marker=createMarkerController({
        context:()=>SillyTavern.getContext(),getData:__mod_store.getData,getStreamingText:()=>{const c=SillyTavern.getContext();const live=c.streamingProcessor?.messageText;if(typeof live==="string"&&live){__mod_chars.stageStreamText(live);return live;}const node=[...DOC.querySelectorAll("#chat .mes[mesid]")].pop();const body=node?.querySelector(".mes_text");if(!body)return "";const clone=body.cloneNode(true);clone.querySelectorAll(".pc-marker-slot,.pc-image-actions").forEach(el=>el.remove());const text=clone.textContent||"";__mod_chars.stageStreamText(text);return text;},document:DOC,
        generate:async (prompt,where)=>{const d=__mod_store.getData();pcMarkerRaw=prompt;
            // 外貌、负面词和参考图都来自这一张图的角色标记
            const hit=__mod_chars.markerPrompt(prompt,where);
            const {positive,negative,chars}=hit||__mod_engine.composeStudio({pos:__mod_model.mergeTags(d.active?__mod_model.ticketString(d,d.active):'',prompt,d.options.chatPositive||''),neg:[d.active?__mod_model.ticketNeg(d,d.active):'',d.options.chatNegative||''].filter(Boolean).join(', ')});
            const bound=[...new Set((hit?.cast||[]).map(ch=>ch.charRef).filter(id=>id&&d.charRefGroups?.[id]))];
            const image=await __mod_engine.generateFull({positive,negative,...(chars?.length?{chars}:{}),backend:(typeof __mod_nai!=='undefined'&&__mod_nai.chatBackend?.()||'nai'),director:__mod_nai.chatBackend?.()!=='comfy'&&bound.length?await __mod_engine.charRefs(bound):null});__mod_engine.afterChatImage();return image;},
        resolveUrl:u=>pcLocal.url(u),upload:async(image,name)=>{const r=await pcStoreImage(image,name);void pcRecordImage({dataUrl:image,url:r?.url,raw:pcMarkerRaw,sent:__mod_engine.runtime.lastSent,from:'chat'}).catch(e=>console.warn('[智库] 历史生图没存上',e));return r;},notify:(message,level)=>toastr[level]?.(message,'智库 · 标记生图')
    });
const __mod_ui = (() => {
/**
 * 画师库界面：生图 / 画师库 / 氛围 / 共享 / 设置，切换画师串的抽屉，批量生成例图。
 */
const saveSettingsDebounced = __shim.saveSettingsDebounced;
const { getData, commit, onChange, imgUrl, fileToDataUrl, deleteImageFile, urlToDataUrl, shrinkDataUrl, replaceData, uploadImage } = __mod_store;
const M = __mod_model;
const E = __mod_engine;
const L = __mod_lobby;
const T = __mod_translate;
const N = __mod_nai;
const C = __mod_chars;
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const $q = (sel, root = document) => root.querySelector(sel);

const ui = {
    view: 'studio',          // studio | book | vibe | lobby | batch | artist | group
    detailId: null,
    backTo: 'book',
    bookTab: 'groups',       // groups | artists
    bookFilter: 'all',       // all | fav | <collectionId>
    search: '',
    strOpen: {},
    studio: { loaded: false, pos: '', neg: '', lastExtra: '', prompt: '', promptEn: '', transErr: '', expand: true, scene: '', sceneOn: true, sceneEn: '', sceneSrc: '', sceneExpand: false, sceneBusy: false, busy: false, result: null, sent: null, open: {} },
    naiTest: null,
    setOpen: {},
    chatHistName: '',
    castTab: 'char', castSearch: '', castTop: 'chars', wardFilter: 'all', wardSearch: '', outfit: null, charKey: '', charBusy: '', addText: { app: '', nsfw: '', out: '' },
    showKey: false,
    lobby: { sort: 'new', tag: '', tag2: '', kind: '', q: '', items: [], total: 0, loading: false, error: '', tags: [], mine: false },
    batch: { text: '', rating: 'sfw', shot: 'all', skipExisting: true, state: null },
    sample: { rating: 'sfw', shots: new Set(['bust']) },
    selecting: false, picked: new Set(),
    busyRefs: new Set(),
};

let root = null;

// ═════════════════════ 小组件 ═════════════════════

const seal = (txt = '', cls = '') => `<span class="pc-seal ${cls}" aria-hidden="true">${esc(txt)}</span>`;
const notch = () => `<div class="pc-notch" aria-hidden="true"><i></i><i></i></div>`;
const label = t => `<div class="pc-label">${esc(t)}</div>`;
function thumb(img, { cls = '', showNsfw = false } = {}) {
    if (!img) return `<div class="pc-thumb pc-thumb-empty ${cls}"></div>`;
    const hide = img.nsfw && !showNsfw;
    return `<div class="pc-thumb ${cls} ${hide ? 'pc-nsfw-hide' : ''}" data-act="viewimg" data-src="${esc(imgUrl(img))}">
        ${hide ? '<span class="pc-nsfw-note">NSFW · 点开</span>' : `<img src="${esc(imgUrl(img))}" loading="lazy" alt="">`}
        <span class="pc-tag-mini">${img.nsfw ? 'NSFW' : 'SFW'}</span></div>`;
}
const refAttr = ref => `data-type="${ref.type}" data-id="${esc(ref.id)}"`;

function settingsST() { return N.settings(); }
const zSettings = () => { try { return SillyTavern.getContext().extensionSettings['st-chatu8'] || null; } catch { return null; } };

// ═════════════════════ 外框 ═════════════════════

function openWindow(view) {
    if (!view && !N.isReady()) view = 'settings';
    if (!root) {
        root = DOC.createElement('div');
        root.id = 'pc-root';
        root.className = 'pc-overlay';
        pcMount(root);
        root.addEventListener('click', onClick);
        root.addEventListener('input', onInput);
        root.addEventListener('change', onChangeEv);
        root.addEventListener('click', ev => {
            const label = ev.target.closest?.('label');
            const input = ev.target.matches?.('input[type=file]') ? ev.target : label?.querySelector('input[type=file]');
            if (!input || input.dataset.pcProxy) return;
            ev.preventDefault(); ev.stopPropagation();
            DOC.querySelectorAll('input[data-pc-proxy]').forEach(n => n.remove());
            const tmp = DOC.createElement('input');
            tmp.type = 'file'; tmp.accept = input.accept; tmp.multiple = input.multiple;
            for (const [k, v] of Object.entries(input.dataset)) tmp.dataset[k] = v;
            tmp.dataset.pcProxy = '1';
            tmp.style.cssText = 'position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0';
            DOC.body.appendChild(tmp);
            tmp.addEventListener('change', async () => { try { await onChangeEv({ target: tmp }); } catch (e) { toastr.error(e.message, '智库'); } finally { tmp.remove(); } }, { once: true });
            tmp.click();
        }, true);
        root.addEventListener('pointerdown', onPointerDown);
        root.addEventListener('keydown', ev => {
            // 电脑：回车加、Shift+回车换行；手机（触屏）：回车就是换行，点「加」才加
            const touch = P.matchMedia?.('(pointer: coarse)').matches;
            const m = ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing && !touch && ev.target.dataset?.enter?.match(/^addpair-(\w+)$/);
            if (m) { ev.preventDefault(); charAction('addpair', { dataset: { where: m[1] } }); }
        });
        for (const t of ['pointerup', 'pointercancel', 'pointermove', 'scroll']) root.addEventListener(t, cancelLongPress, true);
        root.addEventListener('contextmenu', ev => { if (ev.target.closest?.('[data-lp]')) ev.preventDefault(); });
        root.addEventListener('toggle', ev => {
            const f = ev.target.closest?.('[data-fold]'); if (f) ui.studio.open[f.dataset.fold] = f.open;
            const g = ev.target.closest?.('[data-sfold]'); if (g) ui.setOpen[g.dataset.sfold] = g.open;
        }, true);
        onChange(() => { if (root?.classList.contains('open')) render(); });
    }
    if (view) ui.view = view;
    root.classList.add('open');
    DOC.body.classList.add('pc-lock');
    render();
    if (ui.view === 'lobby' && !ui.lobby.items.length) loadLobby();
}
function closeWindow() {
    root?.classList.remove('open');
    DOC.body.classList.remove('pc-lock');
}

/** 重画界面时记住正在打字的框，画完放回去：后台有东西触发重画时，手机键盘不会被收掉 */
let tapOutAt = 0, focusComposing = false, focusPending = false;
const onFocusPointer = ev => { tapOutAt = ev.target?.closest?.('input, textarea') ? 0 : Date.now(); };
const onFocusCompositionStart = ev => { if (root?.contains(ev.target)) focusComposing = true; };
const onFocusCompositionEnd = () => { focusComposing = false; if (focusPending) { focusPending = false; setTimeout(render, 0); } };
if (globalThis.__zhikuInputCleanup) globalThis.__zhikuInputCleanup();
DOC.addEventListener('pointerdown', onFocusPointer, true);
DOC.addEventListener('compositionstart', onFocusCompositionStart, true);
DOC.addEventListener('compositionend', onFocusCompositionEnd, true);
globalThis.__zhikuInputCleanup = () => {
    DOC.removeEventListener('pointerdown', onFocusPointer, true);
    DOC.removeEventListener('compositionstart', onFocusCompositionStart, true);
    DOC.removeEventListener('compositionend', onFocusCompositionEnd, true);
};
function keepFocus() {
    if (Date.now() - tapOutAt < 1200 || (render.focusView && render.focusView !== ui.view)) return null;
    const ae = DOC.activeElement;
    if (!root?.classList.contains('open') || !ae || !root.contains(ae) || !/^(INPUT|TEXTAREA)$/.test(ae.tagName) || /^(checkbox|radio|range|file|button|submit|color)$/i.test(ae.type || '')) return null;
    const attrs = Array.from(ae.attributes).filter(a => a.name.startsWith('data-') || ['name','placeholder'].includes(a.name));
    const sel = ae.tagName.toLowerCase() + (ae.id ? '#' + P.CSS.escape(ae.id) : attrs.map(a => '[' + a.name + '="' + P.CSS.escape(a.value) + '"]').join(''));
    if (sel === ae.tagName.toLowerCase() || root.querySelectorAll(sel).length !== 1) return null;
    return { sel, node: ae, value: ae.value, s: ae.selectionStart, e: ae.selectionEnd, top: ae.scrollTop };
}
function restoreFocus(k) {
    if (!k || !root?.classList.contains('open')) return;
    let n = root.querySelector(k.sel);
    if (!n || DOC.activeElement === n) return;
    for (let p = n.parentElement; p && p !== root; p = p.parentElement) if (p.tagName === 'DETAILS') p.open = true;
    n.replaceWith(k.node); n = k.node;
    n.value = k.value;
    try { n.focus({ preventScroll: true }); } catch { n.focus(); }
    try { const L = n.value.length; n.setSelectionRange(Math.min(k.s ?? L, L), Math.min(k.e ?? L, L)); } catch {}
    n.scrollTop = k.top;
}
function render() {
    if (typeof stopped !== 'undefined' && stopped) return;
    if (focusComposing && root?.contains(DOC.activeElement) && render.focusView === ui.view) { focusPending = true; return; }
    const kept = keepFocus();
    renderView();
    render.focusView = ui.view;
    restoreFocus(kept);
}
function renderView() {
    if (!root) return;
    const d = getData();
    const body = root.querySelector('.pc-body');
    const scroll = body ? body.scrollTop : 0;
    ensureCfyCss();
    const navs = [['studio', '生图'], ['comfy', 'Comfy'], ['comic', '漫画'], ['book', '画师库'], ['vibe', '氛围'], ['cast', '角色'], ['lobby', '共享']];
    const mainView = ['artist', 'group', 'batch'].includes(ui.view) ? 'book' : ['charedit', 'outfit', 'chatlib', 'charhist'].includes(ui.view) ? 'cast' : ui.view;
    root.innerHTML = `
    <div class="pc-shell">
      <header class="pc-head">
        <div class="pc-head-card">
          <div>
            <div class="pc-title">智库</div>
            <div class="pc-subtitle">二改自从前佬的智绘姬</div>
          </div>
          <button class="pc-head-ticket" title="正文生图用的画师串，点一下切换" data-act="switcher">
            <small class="pc-head-lab">正文画师串${d.oneShot ? ' · 只用一次' : ''}</small>
            <span>${esc(M.ticketName(d, d.active) || '没选，点这里')}</span><b class="pc-head-caret">▾</b>
          </button>
          <button class="pc-icon-btn ${ui.view === 'settings' ? 'on' : ''}" data-act="nav" data-view="settings" aria-label="设置">${SYM.gear}</button>
          <button class="pc-icon-btn" data-act="close" aria-label="关闭">${ICON.close}</button>
        </div>
        <nav class="pc-nav"><span class="pc-nav-ind" aria-hidden="true"></span>${navs.map(([k, t]) => `<button class="pc-pill ${mainView === k ? 'on' : ''}" data-act="nav" data-view="${k}">${t}</button>`).join('')}</nav>
      </header>
      <main class="pc-body"><div class="pc-page ${pageAnim(mainView)}">${VIEWS[ui.view]?.(d) || ''}</div></main>
    </div>`;
    const nb = root.querySelector('.pc-body');
    // 每个页面记住自己滚到哪：从画师详情返回画师库时回到原来的位置
    const scrollKey = ui.view === 'book' ? `book:${ui.bookTab}:${ui.bookFilter}` : ui.view + ':' + (ui.detailId || '');
    ui.scrollMem ||= {};
    if (render.scrollKey && render.scrollKey !== scrollKey) ui.scrollMem[render.scrollKey] = scroll;
    const wantScroll = render.scrollKey === scrollKey ? scroll : (ui.scrollMem[scrollKey] || 0);
    if (nb) {
        nb.scrollTop = wantScroll;
        // 图片还没撑开高度时可能滚不到，等一下再补一次
        if (nb.scrollTop < wantScroll) for (const ms of [60, 300]) setTimeout(() => { if (render.scrollKey === scrollKey && nb.isConnected && nb.scrollTop < wantScroll) nb.scrollTop = wantScroll; }, ms);
    }
    render.scrollKey = scrollKey;
    if (ui.view === 'comic') { const cv = root.querySelector('#pc-comic-view'); if (cv) globalThis.__zhikuComic?.openSettings(cv); }
    // 导航底色从上一个位置滑过来
    const ind = root.querySelector('.pc-nav-ind'), on = root.querySelector('.pc-nav .pc-pill.on');
    if (ind && on) {
        const to = { left: on.offsetLeft, width: on.offsetWidth };
        const from = render.ind || to;
        ind.style.transition = 'none'; ind.style.left = from.left + 'px'; ind.style.width = from.width + 'px';
        ind.style.opacity = ui.view === 'settings' ? '0' : '1';
        requestAnimationFrame(() => { ind.style.transition = ''; ind.style.left = to.left + 'px'; ind.style.width = to.width + 'px'; });
        render.ind = to;
    }
    // 切换画师串时盖个章
    if (ui.stamp) { root.querySelectorAll('.pc-use.on').forEach(b => b.classList.add('stamp')); ui.stamp = false; }
}

/** 换页动画：只在页面真的换了时才动 */
const NAV_ORDER = ['studio', 'comfy', 'comic', 'book', 'vibe', 'cast', 'lobby', 'settings'];
const SUB_VIEWS = ['artist', 'group', 'batch', 'charedit', 'outfit'];
function pageAnim(mainView) {
    const prev = pageAnim.last;
    pageAnim.last = ui.view;
    if (!prev || prev === ui.view) return '';
    if (SUB_VIEWS.includes(ui.view) && !SUB_VIEWS.includes(prev)) return 'push';
    if (SUB_VIEWS.includes(prev) && !SUB_VIEWS.includes(ui.view)) return 'pop';
    if (SUB_VIEWS.includes(prev) && SUB_VIEWS.includes(ui.view)) return 'push';
    return NAV_ORDER.indexOf(ui.view) > NAV_ORDER.indexOf(prev) ? 'from-right' : 'from-left';
}

// ═════════════════════ 生图台 ═════════════════════

const SIZE_PRESETS = [[832, 1216, '竖 832×1216'], [1216, 832, '横 1216×832'], [1024, 1024, '方 1024×1024'], [1024, 1536, '大竖 1024×1536'], [1536, 1024, '大横 1536×1024'], [512, 768, '小竖 512×768']];

/** 生图页第一次打开：读上次的内容；没有就用当前画师串 */
function loadStudio() {
    const st = ui.studio;
    if (st.loaded) return;
    const d = getData();
    const saved = d.studio || {};
    st.pos = saved.pos ?? (d.active ? M.ticketString(d, d.active) : '');
    const exact = Object.values(d.groups).find(g => M.ticketString(d, {type:'group',id:g.id}).trim() === st.pos.trim() && String(g.neg || '').trim() === String(saved.neg || '').trim());
    st.sourceRef = M.resolveTicket(d, saved.sourceRef) ? { ...saved.sourceRef }
        : saved.sourceRef === undefined ? (saved.pos == null && d.active ? { ...d.active } : exact ? {type:'group',id:exact.id} : null) : null;
    st.neg = saved.neg ?? M.ticketNeg(d, st.sourceRef);
    st.lastExtra = saved.lastExtra ?? (st.sourceRef?.type === 'group' ? d.groups[st.sourceRef.id]?.extra || '' : '');
    st.lastNeg = saved.lastNeg ?? M.ticketNeg(d, st.sourceRef);
    st.scene = saved.scene || '';
    st.sceneOn = saved.sceneOn !== false;
    st.sceneEn = saved.sceneEn || '';
    st.sceneSrc = saved.sceneSrc || '';
    st.sceneExpand = !!saved.sceneExpand;
    st.cast = Array.isArray(saved.cast) ? saved.cast : [];
    st.castByChat = saved.castByChat && typeof saved.castByChat === 'object' ? saved.castByChat : {};
    st.castMemo = saved.castMemo !== false;
    st.scenes = Array.isArray(saved.scenes) ? saved.scenes : [];
    st.recentScenes = Array.isArray(saved.recentScenes) ? saved.recentScenes : [];
    st.loaded = true;
}
function saveStudio() {
    const d = getData();
    const st = ui.studio;
    d.studio = { sourceRef: st.sourceRef || null, pos: st.pos, neg: st.neg, lastExtra: st.lastExtra, lastNeg: st.lastNeg || '', scene: st.scene || '', sceneOn: st.sceneOn !== false, sceneEn: st.sceneEn || '', sceneSrc: st.sceneSrc || '', sceneExpand: !!st.sceneExpand, cast: st.cast || [], castByChat: st.castByChat || {}, castMemo: st.castMemo !== false, scenes: st.scenes || [], recentScenes: st.recentScenes || [] };
    commit({ silent: true });
}
function studioSource() {
    const ref = ui.studio.sourceRef;
    return ref?.type === 'group' && M.resolveTicket(getData(), ref) ? ref : null;
}
async function saveStudioTicket() {
    const d = getData(), st = ui.studio;
    if (!st.pos.trim()) { toastr.warning('画师串是空的，请先填写再保存', '智库'); return; }
    const original = studioSource();
    const groups = Object.values(d.groups);
    const options = [original ? '覆盖原串：' + M.ticketName(d, original) : '覆盖已有画师串', '另存为新画师串'];
    let mode = groups.length ? await chooseBox('保存画师串（正面、负面一起保存）', options) : 1;
    if (mode == null) return;
    let ref;
    if (mode === 0) {
        let target = original;
        if (!target) {
            const index = await chooseBox('选择要覆盖的画师串', groups.map(g => g.name));
            if (index == null) return;
            target = {type:'group',id:groups[index].id};
        }
        ref = M.overwriteGroup(d, target, st.pos, st.neg);
    } else {
        const name = await promptText('新画师串的名字', original ? M.ticketName(d, original) + ' · 副本' : '');
        if (name == null) return;
        ref = M.createFromString(d, { name, text: st.pos, neg: st.neg, forceGroup: true });
    }
    if (!ref) return;
    st.sourceRef = ref; st.lastExtra = d.groups[ref.id]?.extra || ''; st.lastNeg = st.neg; st.clearUndo = null;
    saveStudio(); E.setActive(ref);
    await __mod_store.commit({ immediate: true, silent: true });
    render(); toastr.success(mode === 0 ? '已覆盖原画师串' : '已另存为新画师串', '智库');
}
function applyArtistToStudio(ref) {
    const d = getData();
    const st = ui.studio;
    const t = M.resolveTicket(d, ref);
    if (!t) return;
    st.sourceRef = { type: ref.type, id: ref.id };
    st.clearUndo = null;
    st.pos = M.replaceArtists(st.pos, M.ticketString(d, ref), st.lastExtra);
    st.lastExtra = t.type === 'group' ? (t.item.extra || '') : '';
    const neg = M.ticketNeg(d, ref);
    const drop = new Set(M.tokenize(st.lastNeg || '').map(x => x.text.toLowerCase()));
    st.neg = M.mergeTags(neg, M.tokenize(st.neg).filter(x => !drop.has(x.text.toLowerCase())).map(x => x.raw || x.text).join(', '));
    st.lastNeg = neg;
    saveStudio();
}
/** 固定提示词：有中文的先让 AI 转成标签，转过一次就记住，中文改了才重新转 */
function sceneZh() { return T.hasChinese(ui.studio.scene || ''); }
function sceneReady() { const st = ui.studio; return !sceneZh() || !!(String(st.sceneEn || '').trim() && st.sceneSrc === String(st.scene || '').trim()); }
function sceneStateText() { return sceneReady() ? '有中文，实际发的是下面 AI 转好的英文标签。' : ui.studio.sceneEn ? '中文改过了：生成时会先用 AI 重新转成标签。' : '有中文，NovelAI 看不懂：生成时会先用 AI 转成标签，转一次就记住。'; }
function sceneTags() {
    const st = ui.studio;
    if (st.sceneOn === false || !String(st.scene || '').trim()) return '';
    if (!sceneZh()) return st.scene;
    return sceneReady() ? st.sceneEn : '';
}
async function translateScene() {
    const st = ui.studio;
    st.sceneBusy = true; render();
    try {
        const source = String(st.scene || '').trim(), expand = !!st.sceneExpand;
        const translated = await T.translateToTags(source, { expand });
        if (ui.studio !== st || String(st.scene || '').trim() !== source || !!st.sceneExpand !== expand) throw new Error('固定提示词已更改，请重新操作');
        st.sceneEn = translated;
        st.sceneSrc = source;
        saveStudio();
    } finally { st.sceneBusy = false; }
}
const CAST_POS = { L: '左', C: '中', R: '右' };
const castMemoOn = () => ui.studio.castMemo !== false;
/** 生图页现在选的入画角色（开着「记住」时按聊天分开存） */
function studioCast() {
    const st = ui.studio;
    st.cast ||= []; st.castByChat ||= {};
    const list = castMemoOn() ? st.castByChat[C.chatId()] || [] : st.cast;
    return list.filter(e => C.getChar(e.key));
}
function setStudioCast(list) {
    const st = ui.studio;
    if (castMemoOn()) st.castByChat[C.chatId()] = list; else st.cast = list;
    saveStudio();
}
function castAv(c, cls = 'pc-castav') {
    const u = c.kind === 'side' ? '' : C.avatarUrl(c);
    const letter = esc(String(c.name || '?').slice(0, 1));
    return u ? `<img class="${cls}" src="${esc(u)}" alt="" onerror="this.outerHTML='<span class=&quot;${cls}&quot;>${letter}</span>'">` : `<span class="${cls}">${letter}</span>`;
}
const CAST_CSS = `<style>
.pc-castmode{font-size:12px;color:var(--pc-ink-soft);background:var(--pc-paper);border-radius:12px;padding:9px 11px;line-height:1.6}
.pc-castmode b{color:var(--pc-ink)}
.pc-castrow{background:var(--pc-paper);border-radius:16px;padding:10px 12px;margin-top:8px}
.pc-castrow-top{display:flex;align-items:center;gap:9px}
.pc-castrow-top>b{flex:1;min-width:0;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pc-castav{flex:0 0 auto;width:30px;height:30px;border-radius:9px;object-fit:cover;background:var(--pc-gold);color:#fbf8f0;display:inline-grid;place-items:center;font-family:var(--pc-font-name);font-weight:700;font-size:14px}
.pc-castseg{display:inline-flex !important;padding:2px;border-radius:10px;background:transparent;border:1.5px solid var(--pc-ink)}
.pc-castseg button{min-height:26px !important;padding:0 9px;border-radius:7px !important;font-size:12px !important}
.pc-castseg button.on{background:var(--pc-ink) !important;color:var(--pc-paper) !important}
.pc-casttags{font-size:11.5px;line-height:1.55;color:var(--pc-ink-soft);margin-top:6px;word-break:break-word}
.pc-castadd{width:100%;margin:9px 0 6px;min-height:42px;border:1.5px dashed var(--pc-dash);border-radius:14px;background:transparent;font-family:var(--pc-font);font-size:14px;color:var(--pc-ink);cursor:pointer}
.pc-castsec{font-size:11px;letter-spacing:.3em;color:var(--pc-ink-soft);margin:10px 0 4px}
.pc-castgrid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px}
.pc-castpick{position:relative;min-width:0;border:1.5px dashed var(--pc-dash);border-radius:16px;background:transparent;padding:9px 4px 7px;text-align:center;cursor:pointer;font-family:var(--pc-font);color:var(--pc-ink);display:flex;flex-direction:column;align-items:center;gap:2px}
.pc-castpick.on{border:1.5px solid var(--pc-ink);background:var(--pc-paper-2)}
.pc-castpick .pc-castbig{width:46px;height:46px;border-radius:14px;object-fit:cover;background:var(--pc-gold);color:#fbf8f0;display:grid;place-items:center;font-family:var(--pc-font-name);font-weight:700;font-size:18px;margin-bottom:3px}
.pc-castpick b{max-width:100%;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pc-castpick small{font-size:10px;letter-spacing:.08em;color:var(--pc-ink-soft)}
.pc-castpick small.warn{color:#a8582c}.pc-castpick small.ref{color:#5f7a52}
.pc-castnum{position:absolute;top:-7px;right:-5px;width:22px;height:22px;border-radius:7px;background:var(--pc-ink);color:var(--pc-paper);font-size:12px;display:grid;place-items:center;transform:rotate(6deg)}
</style>`;
function castFold() {
    const d = getData();
    const list = studioCast().map(e => ({ e, c: C.getChar(e.key) }));
    const n = list.length, split = C.canSplit({ chat: false });
    const mode = n === 0 ? '<b>不选人：</b>就按上面的提示词画，跟以前一样。'
        : n === 1 ? '<b>单人：</b>把这个人的外貌、衣服接在提示词后面（加 solo）。'
        : split ? `<b>${n} 人：</b>每个人的外貌单独发给 NAI（分角色），发色瞳色不会串到别人身上；人数词自动补上。`
        : `<b>${n} 人：</b>现在的模型或通道（V3 / 酒馆里的 key）不能分角色，几个人的外貌会按顺序接在一起，容易串色。`;
    const rows = list.map(({ e, c }) => {
        const look = C.tagText(c.appearance);
        const ref = c.charRef && d.charRefGroups?.[c.charRef];
        const fitOn = id => e.outfit === undefined ? C.currentOutfit(c)?.id === id : e.outfit === id;
        const k = esc(e.key);
        return `<div class="pc-castrow"><div class="pc-castrow-top">${castAv(c)}<b>${esc(c.name)}</b>
            ${n > 1 && split ? `<span class="pc-seg pc-castseg">${['L', 'C', 'R'].map(v => `<button class="${(e.pos || 'C') === v ? 'on' : ''}" data-act="castpos" data-key="${k}" data-v="${v}">${CAST_POS[v]}</button>`).join('')}</span>` : ''}
            <button class="pc-x" data-act="castrm" data-key="${k}" aria-label="不画${esc(c.name)}">×</button></div>
          <div class="pc-casttags mono">${look ? esc(look) : '这个角色还没写外貌：去「角色」页写一下，或者在提示词里自己写'}</div>
          ${n > 1 ? `<input class="pc-castact mono" data-castact="${k}" value="${esc(e.act || '')}" placeholder="${esc(c.name)}自己的动作、表情">` : ''}
          ${c.outfits.length ? `<div class="pc-chips wrap">${c.outfits.map(o => `<button class="pc-pill tiny ${fitOn(o.id) ? 'on' : 'dashed'}" data-act="castfit" data-key="${k}" data-id="${esc(o.id)}">${esc(o.name)}</button>`).join('')}<button class="pc-pill tiny ${e.outfit === '' ? 'on' : 'dashed'}" data-act="castfit" data-key="${k}" data-id="">不穿固定衣服</button></div>` : ''}
          ${ref ? `<div class="pc-dim small" style="margin-top:6px">带上长相参考「${esc(ref.name)}」${N.charRefSupported() ? '' : '（现在的模型用不了，这次不带）'}</div>` : ''}</div>`;
    }).join('');
    return CAST_CSS + fold('cast', '入画角色', n ? list.map(x => x.c.name).join('、') : '不画指定的人', `
      <div class="pc-castmode">${mode}</div>${n > 1 ? `<div class="pc-dim small" style="margin-top:6px">${split ? '两个人容易弄错谁在做什么：' : ''}每个人的动作、表情写在他自己那一栏，固定提示词里只放镜头、场景这类大家共用的。两人之间的动作用 NovelAI 的互动写法：做的人写 <span class="mono">source#hug</span>，被做的人写 <span class="mono">target#hug</span>，一起做写 <span class="mono">mutual#hug</span>。</div>` : ''}${rows}
      <button class="pc-castadd" data-act="castopen">＋ 从角色库里选人</button>
      <label class="pc-switch"><input type="checkbox" data-cast-memo ${castMemoOn() ? 'checked' : ''}><span></span>记住这次聊天选的人<small>下次打开同一个聊天，自动选好</small></label>`);
}
function openCastPicker() {
    const d = getData();
    DOC.querySelector('.pc-sheet-backdrop')?.remove();
    const back = DOC.createElement('div');
    back.className = 'pc-sheet-backdrop fresh'; setTimeout(() => back.classList.remove('fresh'), 400);
    const openedAt = Date.now();
    pcMount(back);
    const here = C.currentCast().map(x => x.char);
    const hereKeys = new Set(here.map(c => c.key));
    const others = Object.values(d.characters || {}).filter(c => c?.key && !hereKeys.has(c.key));
    const KIND = { user: 'USER', char: 'CHAR', side: '配角', free: '自建' };
    const card = c => {
        const i = studioCast().findIndex(e => e.key === c.key);
        const ref = c.charRef && d.charRefGroups?.[c.charRef];
        const look = (c.appearance || []).length;
        return `<button class="pc-castpick ${i >= 0 ? 'on' : ''}" data-key="${esc(c.key)}">${i >= 0 ? `<span class="pc-castnum">${i + 1}</span>` : ''}${castAv(c, 'pc-castbig')}<b>${esc(c.name)}</b><small class="${look ? '' : 'warn'}">${look ? KIND[c.kind] || '角色' : '没写外貌'}</small>${ref ? '<small class="ref">参考图</small>' : ''}</button>`;
    };
    const close = () => { back.remove(); render(); };
    const draw = () => {
        back.innerHTML = CAST_CSS + `<section class="pc-sheet" role="dialog" aria-label="选入画角色"><div class="pc-sheet-grip" aria-hidden="true"></div>
          <div class="pc-row-between"><h3 class="pc-h3" style="margin:0">选入画角色</h3><button class="pc-icon-btn" data-c="close" aria-label="关闭">${ICON.close}</button></div>
          <div class="pc-dim small">点头像选上 / 取消，数字是入画顺序。可以只选一个人，也可以选几个人。</div>
          <div class="pc-castsec">这次聊天</div><div class="pc-castgrid">${here.map(card).join('') || '<div class="pc-dim small">这次聊天里没有角色</div>'}</div>
          ${others.length ? `<div class="pc-castsec">角色库里的其他人</div><div class="pc-castgrid">${others.map(card).join('')}</div>` : ''}
          <button class="pc-btn dark big pc-mt" data-c="close">好了</button></section>`;
    };
    back.addEventListener('click', ev => {
        if (ev.target === back) { if (Date.now() - openedAt > 400) close(); return; }
        if (ev.target.closest('[data-c="close"]')) { close(); return; }
        const b = ev.target.closest('.pc-castpick');
        if (!b) return;
        const list = studioCast().slice();
        const i = list.findIndex(e => e.key === b.dataset.key);
        if (i >= 0) list.splice(i, 1);
        else {
            const used = new Set(list.map(e => e.pos));
            list.push({ key: b.dataset.key, pos: ['L', 'R', 'C'].find(p => !used.has(p)) || 'C' });
        }
        setStudioCast(list);
        draw();
    });
    draw();
}
/** 现在的固定提示词 */
function sceneSnapshot() {
    const st = ui.studio;
    return { scene: String(st.scene || '').trim(), sceneEn: st.sceneEn || '', sceneSrc: st.sceneSrc || '', at: Date.now() };
}
const sceneSig = p => String(p.scene || '').toLowerCase().replace(/[\s，,]+/g, ',');
const sceneName = text => String(text || '').split(/[,，\n]/).map(s => s.trim()).filter(s => s && !/quality|masterpiece|highres|absurdres|detailed/i.test(s)).slice(0, 3).join(', ').slice(0, 24);
function rememberScene(p = sceneSnapshot(), enabled = ui.studio.sceneOn !== false) {
    const st = ui.studio;
    if (!enabled || !p.scene) return;
    const sig = sceneSig(p);
    if ((st.scenes || []).some(x => sceneSig(x) === sig)) return; // 已经存下的就不再记
    st.recentScenes = [p, ...(st.recentScenes || []).filter(x => sceneSig(x) !== sig)].slice(0, 20);
    saveStudio();
}
function applyScene(p) {
    const st = ui.studio;
    st.scene = p.scene || ''; st.sceneEn = p.sceneEn || ''; st.sceneSrc = p.sceneSrc || '';
    st.sceneOn = true;
    saveStudio();
}
const SCENE_NSFW = /\b(?:nsfw|nude|naked|nipples?|areolae?|penis|pussy|vagina|clitoris|sex|cum|ejaculation|masturbation|erection|anus|anal|fellatio|paizuri|handjob|cunnilingus|testicles|pubic hair|topless|bottomless|spread (?:ass|legs|pussy))\b/i;
/** 没标过的旧条目：带明显 NSFW 词的先标上 NSFW */
const sceneAutoTags = text => SCENE_NSFW.test(String(text || '')) ? ['NSFW'] : [];
function sceneRow(p, i, kind) {
    const cur = sceneSig(p) === sceneSig(sceneSnapshot());
    const title = kind === 'saved' ? p.name || '没起名' : new Date(p.at).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
    return `<div class="pc-promptrow ${cur ? 'cur' : ''}">
      <div class="pc-grow"><b>${esc(title)}${cur ? ' <em>在用</em>' : ''}</b>${kind === 'saved' && p.tags?.length ? `<span class="pc-scenetags">${p.tags.map(t => `<i>${esc(t)}</i>`).join('')}</span>` : ''}<small class="mono">${esc(p.scene)}</small></div>
      <div class="pc-promptacts">${cur ? '' : `<button class="pc-pill tiny on" data-act="sceneuse" data-kind="${kind}" data-i="${i}">换上</button>`}
        ${kind === 'recent' ? `<button class="pc-pill tiny dashed" data-act="scenekeep" data-i="${i}">存下</button>` : `<button class="pc-pill tiny dashed" data-act="scenerename" data-i="${i}">改名</button><button class="pc-pill tiny dashed" data-act="scenetags" data-i="${i}">标签</button>`}
        <button class="pc-x" data-act="scenedel" data-kind="${kind}" data-i="${i}" aria-label="删掉">×</button></div></div>`;
}
function sceneLibrary() {
    const st = ui.studio;
    const saved = st.scenes || [], recent = st.recentScenes || [];
    return `<style>
.pc-promptrow{display:flex;gap:8px;align-items:flex-start;background:var(--pc-paper-2);border-radius:14px;padding:9px 10px;margin-top:7px}
.pc-promptrow.cur{box-shadow:inset 0 0 0 1.5px var(--pc-ink)}
.pc-promptrow b{display:block;font-size:14px}
.pc-promptrow b em{font-style:normal;font-size:11px;font-weight:400;color:var(--pc-ink-soft);margin-left:4px}
.pc-promptrow small{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;font-size:11.5px;line-height:1.5;color:var(--pc-ink-soft);word-break:break-word}
.pc-promptacts{display:flex;flex-wrap:wrap;gap:4px;justify-content:flex-end;align-items:center;max-width:132px}
.pc-promptsec{font-size:11px;letter-spacing:.3em;color:var(--pc-ink-soft);margin:12px 0 0}
.pc-recent-scenes>summary{cursor:pointer;font-size:12px;color:var(--pc-ink-soft);margin-top:12px;list-style:none}
.pc-recent-scenes>summary::-webkit-details-marker{display:none}
.pc-saved-scenes>summary{font-size:13px;color:var(--pc-ink);letter-spacing:.05em}
.pc-scenetags{display:flex;flex-wrap:wrap;gap:4px;margin:3px 0 2px}
.pc-scenetags i{font-style:normal;font-size:11px;padding:1px 8px;border-radius:99px;border:1px solid var(--pc-dash);color:var(--pc-ink-soft)}
.pc-i2i{display:flex;gap:10px;align-items:flex-start}
.pc-castact{width:100%;box-sizing:border-box;margin-top:6px;padding:7px 12px;border-radius:12px;border:1.5px dashed var(--pc-dash);background:transparent;color:var(--pc-ink);font-size:12px}
.pc-i2i img{width:84px;max-height:120px;object-fit:cover;border-radius:12px;cursor:zoom-in}
.pc-i2i input[type=range]{width:100%}
</style>
      <div class="pc-actions wrap" style="margin-top:8px"><button class="pc-pill dashed" data-act="scenesave">＋ 存下这段</button></div>
      ${saved.length ? (() => {
        const tagsOf = p => (p.tags ??= sceneAutoTags(p.scene));
        const all = [...new Set(saved.flatMap(tagsOf))];
        const f = all.includes(st.sceneTag) || st.sceneTag === '__none' ? st.sceneTag : '', q = String(st.sceneQ || '').trim().toLowerCase();
        const rows = saved.map((p, i) => [p, i]).filter(([p]) => (!f || (f === '__none' ? !tagsOf(p).length : tagsOf(p).includes(f))) && (!q || [p.name, p.scene, p.sceneSrc, ...tagsOf(p)].join(' ').toLowerCase().includes(q)));
        const curP = saved.find(p => sceneSig(p) === sceneSig(sceneSnapshot()));
        const chip = (v, t) => `<button class="pc-pill tiny ${f === v ? 'on' : 'dashed'}" data-act="scenetag" data-v="${esc(v)}">${esc(t)}</button>`;
        return `<details class="pc-recent-scenes pc-saved-scenes" ${st.open.savedScenes ? 'open' : ''} data-fold="savedScenes"><summary>存下的固定提示词 ${saved.length} 条${curP ? ` · 在用「${esc(curP.name || '没起名')}」` : ''} ▸</summary>
          ${saved.length > 0 ? `<label class="pc-search pc-mt-s"><span class="pc-sr">搜固定提示词</span>${ICON.search}<input data-bind="studio.sceneQ" value="${esc(st.sceneQ || '')}" placeholder="搜名字、标签、提示词"></label>` : ''}
          ${all.length ? `<div class="pc-chips wrap" style="margin-top:8px">${chip('', '全部')}${all.map(t => chip(t, t)).join('')}${saved.some(p => !tagsOf(p).length) ? chip('__none', '没标签') : ''}</div>` : '<div class="pc-dim small" style="margin-top:6px">点每条的「标签」可以分类，比如 证件照、NSFW、双人</div>'}
          ${rows.map(([p, i]) => sceneRow(p, i, 'saved')).join('') || '<div class="pc-dim small" style="margin-top:8px">没有对得上的</div>'}</details>`;
      })() : ''}
      ${recent.length ? `<details class="pc-recent-scenes" ${ui.studio.open.recentScenes ? 'open' : ''} data-fold="recentScenes"><summary>最近用过 ${recent.length} 条（生成时自动记）▸</summary>${recent.map((p, i) => sceneRow(p, i, 'recent')).join('')}<div class="pc-actions" style="margin-top:6px"><button class="pc-pill tiny dashed" data-act="sceneclear">清空最近</button></div></details>` : ''}`;
}
function studioParts() { return { pos: ui.studio.pos, neg: ui.studio.neg, scene: sceneTags() }; }
/** 垫图：底图按这次的尺寸铺满裁好，返回不带前缀的 PNG base64 */
async function i2iImage(dataUrl, w, h) {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('底图读不出来，换一张试试')); i.src = dataUrl; });
    const c = DOC.createElement('canvas'); c.width = w; c.height = h;
    const k = Math.max(w / img.width, h / img.height), dw = img.width * k, dh = img.height * k;
    c.getContext('2d').drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
    return c.toDataURL('image/png').replace(/^data:image\/png;base64,/, '');
}
/** 按底图比例算尺寸：64 的倍数，不超过 1024×1024 的像素数（Opus 免费档以内） */
function i2iFitSize(iw, ih) {
    if (!(Number.isFinite(iw) && Number.isFinite(ih) && iw > 0 && ih > 0)) return [1024, 1024];
    const scale = Math.min(1600 / iw, 1600 / ih, Math.sqrt(1024 * 1024 / (iw * ih)));
    return [iw, ih].map(v => Math.max(64, Math.floor(v * scale / 64) * 64));
}
let i2iLoadSeq = 0;
async function loadI2i(source, file = false) {
    const seq = ++i2iLoadSeq, st = ui.studio;
    const current = () => seq === i2iLoadSeq && ui.studio === st && !stopped;
    try {
        const du = file ? await shrinkDataUrl(await fileToDataUrl(source), 1600, 0.92) : source;
        const im = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = du; });
        if (!current()) return false;
        st.i2i = { strength: 0.7, noise: 0, ...(st.i2i || {}), image: du, iw: im.width, ih: im.height };
        st.open.i2i = true; render(); return true;
    } catch { if (current()) toastr.error('这张图读不出来，换一张试试', '垫图'); return false; }
}
function i2iFold(s) {
    const g = ui.studio.i2i || {};
    const w = Number(s.novelai_width) || 832, h = Number(s.novelai_height) || 1216;
    const pct = v => Math.round(v * 100) + '%';
    const strength = g.strength ?? 0.7, noise = g.noise ?? 0;
    const fit = g.image && g.iw ? i2iFitSize(g.iw, g.ih) : null;
    const body = g.image ? `<div class="pc-i2i">
        <img src="${esc(g.image)}" alt="底图" data-act="viewimg" data-src="${esc(g.image)}">
        <div class="pc-grow">
          <label class="pc-field"><span>重绘强度 <b data-i2i-out="strength">${pct(strength)}</b> · 越大越不像底图</span><input type="range" min="0.01" max="0.99" step="0.01" value="${strength}" data-i2i="strength"></label>
          <label class="pc-field"><span>噪声 <b data-i2i-out="noise">${pct(noise)}</b> · 加一点能多些细节</span><input type="range" min="0" max="0.99" step="0.01" value="${noise}" data-i2i="noise"></label>
        </div></div>
      <div class="pc-chips wrap pc-mt-s"><label class="pc-pill dashed tiny" style="cursor:pointer">换一张<input type="file" accept="image/*" data-i2iimg hidden></label>
        ${fit && (fit[0] !== w || fit[1] !== h) ? `<button class="pc-pill dashed tiny" data-act="i2ifit">尺寸改成底图比例（${fit[0]}×${fit[1]}）</button>` : ''}
        <button class="pc-pill dashed tiny danger" data-act="i2ioff">不垫了</button></div>
      <div class="pc-hint">生成时底图铺满裁成现在的尺寸（${w}×${h}）。画师串、提示词、角色、氛围照常发。底图只留在这次打开里，刷新就没了。</div>`
      : `<label class="pc-pill dashed" style="cursor:pointer">放一张底图<input type="file" accept="image/*" data-i2iimg hidden></label>
      ${ui.studio.result ? '<button class="pc-pill dashed" data-act="i2iresult">用上面生成的这张</button>' : ''}
      <div class="pc-hint">按底图的构图和颜色重画（img2img）。要用自己的 NovelAI key，酒馆转发不行。</div>`;
    return fold('i2i', '垫图', g.image ? `开 · 强度 ${pct(strength)}${noise ? ' · 噪声 ' + pct(noise) : ''}` : '没放底图', body);
}
function previewHtml(s) {
    const cast = studioCast();
    const c = cast.length ? C.studioCastPrompt(studioParts(), cast) : E.composeStudio(studioParts(), s);
    const charLines = (c.chars || []).map((x, i) => `<br><b>角色${i + 1}（${CAST_POS[c.picks[i].pos]}）</b>：${esc(x.prompt)}`).join('');
    const wait = ui.studio.sceneOn !== false && String(ui.studio.scene || '').trim() && !sceneReady();
    return { pos: esc(c.positive) + charLines + (wait ? '<br><i class="pc-dim">＋ 固定提示词（有中文，生成时先转成标签，放在质量词前面）</i>' : ''), neg: esc(c.negative), aqt: c.aqt, ucp: c.ucp };
}

function ucpOptions(s) {
    const v5 = String(s.novelaimode || '').includes('nai-diffusion-5');
    const o = [['', '不加'], ['custom', '自定义'], ['Heavy', '重（Heavy）'], ['Light', '轻（Light）']];
    if (v5 || ['nai-diffusion-3', 'nai-diffusion-4-5-full'].includes(s.novelaimode)) o.push(['Human Focus', '人物（Human Focus）']);
    if (v5 || s.novelaimode === 'nai-diffusion-4-5-full') o.push(['Furry Focus', '兽人（Furry Focus）']);
    return o;
}

/** 折叠栏：标题旁边显示现在的内容 */
function fold(key, title, summary, body) {
    const open = ui.studio.open[key];
    return `<details class="pc-fold" data-fold="${key}" ${open ? 'open' : ''}><summary><b>${esc(title)}</b><i>${esc(summary)}</i></summary><div class="pc-fold-in">${body}</div></details>`;
}

function paramFields(s, { withSize = false } = {}) {
    const w = Number(s.novelai_width) || 832, h = Number(s.novelai_height) || 1216;
    return `<div class="pc-actions wrap"><button type="button" class="pc-pill dashed" data-act="samplingpreset">使用推荐采样</button><small class="pc-dim">DPM++ 2M SDE · karras · CFG 修正 0.18</small></div>
      ${s.naiMode === 'tavern' ? '<div class="pc-hint">酒馆内置 Key 通道不支持 CFG 修正；使用独立 Key 或第三方站点时按设置发送。</div>' : ''}
      <div class="pc-grid4">
        ${withSize ? `<label class="pc-field span4"><span>尺寸</span>
          <select data-st="size">${SIZE_PRESETS.map(([pw, ph, t]) => `<option value="${pw}x${ph}" ${pw === w && ph === h ? 'selected' : ''}>${t}</option>`).join('')}
          ${SIZE_PRESETS.some(([pw, ph]) => pw === w && ph === h) ? '' : `<option selected value="${w}x${h}">自定义 ${w}×${h}</option>`}</select></label>` : ''}
        <label class="pc-field span2"><span>步数</span><input type="number" data-st="novelai_steps" value="${esc(s.novelai_steps)}"></label>
        <label class="pc-field span2"><span>种子（0 = 随机）</span><input type="number" data-st="novelai_seed" value="${esc(s.novelai_seed)}"></label>
        <label class="pc-field span4"><span>采样器</span><select data-st="novelai_sampler">${N.SAMPLERS.map(([v, t]) => `<option value="${v}" ${v === s.novelai_sampler ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
        <label class="pc-field span2"><span>噪声表</span><select data-st="Schedule">${N.SCHEDULES.map(([v, t]) => `<option value="${v}" ${v === s.Schedule ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
        <label class="pc-field span2"><span>CFG 修正</span><input type="number" step="0.01" data-st="cfg_rescale" value="${esc(s.cfg_rescale)}"></label>
      </div>
      <label class="pc-switch"><input type="checkbox" data-st-check="nai3Variety" ${String(s.nai3Variety) === 'true' ? 'checked' : ''}><span></span>多样性加强（Variety+）<small>画面更多变化，偶尔会乱</small></label>`;
}

/** 没写 artist: 的画师名：开头一串名字（遇到普通词就停），加上画师库里已有的名字 */
function guessBareArtists(d, text) {
    const GENERAL = /^(\d+(boy|girl|other)s?|solo|male|female|nsfw|sfw|rating:.*|year \d{4}|\d{4}|newest|oldest|recent|early|mid|late|masterpiece|absurdres|highres|lowres|very aesthetic|aesthetic|no[ _]text|artist[ _]collaboration|uncensored|censored|.*quality.*|ultra[ -_]?detailed)$/i;
    const nameLike = t => !/\s/.test(t) || /^[^\s()]+ \((?!medium|style)[^()]+\)$/i.test(t);
    const out = [];
    let lead = true;
    for (const t of M.tokenize(text)) {
        if (t.isArtist) continue;
        const name = t.text.trim();
        const known = !!M.findArtistByTag(d, 'artist:' + name);
        if (lead && (GENERAL.test(name) || !nameLike(name))) lead = false;
        if ((lead || known) && !GENERAL.test(name) && !name.includes(":") && /[\p{L}\p{N}]/u.test(name) && !out.includes(name)) out.push(name);
    }
    return out;
}
function addArtistPrefix(text, names) {
    let s = String(text || '');
    for (const n of names) {
        const e = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        s = s.replace(new RegExp('(^|[,{\\[]|::)(\\s*)(' + e + ')(?=\\s*(?:,|::|[}\\]]|$))', 'g'), '$1$2artist:$3');
    }
    return s;
}

// ───────────── 历史生图 ─────────────
const HIST_CSS = `<style>.pc-hist{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:6px}.pc-hist-item{position:relative;padding:0;border:0;border-radius:10px;overflow:hidden;aspect-ratio:2/3;background:var(--pc-paper-2);cursor:pointer}.pc-hist-item img{width:100%;height:100%;object-fit:cover;display:block}.pc-hist-item i{position:absolute;left:4px;bottom:4px;font-style:normal;font-size:10px;padding:0 5px;border-radius:6px;background:rgba(0,0,0,.55);color:#fff}.pc-hist-item.missing::after{content:'这台设备上没有';position:absolute;inset:0;display:grid;place-items:center;font-size:11px;color:var(--pc-ink-soft)}.pc-hist-item.sel{outline:3px solid var(--pc-gold);outline-offset:-3px}.pc-hist-item b{position:absolute;right:5px;top:5px;width:20px;height:20px;border-radius:50%;border:2px solid #fff;background:rgba(0,0,0,.35);display:grid;place-items:center;color:#fff;font-size:12px}.pc-hist-item.sel b{background:var(--pc-gold)}.pc-hist-detail img{width:100%;border-radius:12px;display:block}.pc-hist-meta{display:grid;grid-template-columns:auto 1fr;gap:2px 10px;font-size:12px;margin-top:8px}.pc-hist-meta dt{color:var(--pc-ink-soft)}.pc-hist-meta dd{margin:0;word-break:break-all}@media (max-width:420px){.pc-hist{grid-template-columns:repeat(3,minmax(0,1fr))}}</style>`;
const histList = () => (Array.isArray(getData().history) ? getData().history : []);
function historyFold(d) {
    const hist = histList();
    if (!hist.length) return '';
    const h = ui.hist ||= { select: false, picked: [], show: 60 };
    const shown = hist.slice(0, h.show);
    setTimeout(() => pcHydrate(), 0);
    return fold('history', '历史生图', `${hist.length} 张`, `${HIST_CSS}
      <div class="pc-chips wrap" style="margin-top:0">
        <button class="pc-pill ${h.select ? 'on' : 'dashed'} tiny" data-act="histselect">${h.select ? '完成' : '多选'}</button>
        ${h.select ? `<button class="pc-pill dashed tiny" data-act="histall">${h.picked.length === hist.length ? '全不选' : '全选'}</button>
        <button class="pc-pill dashed tiny" data-act="histdownload" ${h.picked.length ? '' : 'disabled'}>下载选中（${h.picked.length}）</button>
        <button class="pc-pill dashed tiny danger" data-act="histdelete" ${h.picked.length ? '' : 'disabled'}>删除选中</button>` : `
        <button class="pc-pill dashed tiny" data-act="histclean" data-days="7">清理 7 天前</button>
        <button class="pc-pill dashed tiny" data-act="histclean" data-days="30">清理 30 天前</button>`}
      </div>
      <div class="pc-hist pc-mt-s">${shown.map(x => `<button class="pc-hist-item ${h.picked.includes(x.id || x.url) ? 'sel' : ''}" data-act="histopen" data-id="${esc(x.id || x.url)}"><img data-pc-src="${esc(x.thumb || x.url)}" alt=""><i>${x.from === 'chat' ? '聊天' : '生图'}</i>${h.select ? `<b>${h.picked.includes(x.id || x.url) ? '✓' : ''}</b>` : ''}</button>`).join('')}</div>
      ${hist.length > shown.length ? `<div class="pc-center pc-mt-s"><button class="pc-pill dashed tiny" data-act="histmore">再显示 60 张（还有 ${hist.length - shown.length} 张）</button></div>` : ''}
      <div class="pc-dim small pc-mt-s">${(d.options.imageStore || 'local') === 'server' ? '新图存在酒馆服务器的 user/images 里。' : '图存在这台设备的浏览器里，不占酒馆服务器；换设备、清浏览器数据就看不到了。'}删除和清理会真的删掉图片，聊天里用到这张图的地方也会显示不出来。</div>`);
}
const histFind = id => histList().find(x => (x.id || x.url) === id);
/** 删掉记录和文件（原图 + 缩略图） */
function histRemove(entries) {
    const gone = new Set(entries.map(x => x.id || x.url));
    for (const x of entries) for (const u of [x.url, x.thumb]) pcDropImage(u);
    getData().history = histList().filter(x => !gone.has(x.id || x.url));
    if (ui.hist) ui.hist.picked = ui.hist.picked.filter(id => !gone.has(id));
    commit();
}
function histDownload(entries) {
    entries.forEach((x, i) => setTimeout(async () => { const a = DOC.createElement('a'); a.href = await pcLocal.url(x.url); if (!a.href) return; a.download = `zhiku_${new Date(x.at).toISOString().slice(0, 19).replace(/[:T]/g, '-')}_${i + 1}.png`; pcMount(a); a.click(); a.remove(); }, i * 400));
}
function histDetail(x) {
    const row = (k, v) => v === '' || v === undefined || v === null ? '' : `<dt>${k}</dt><dd>${esc(String(v))}</dd>`;
    const box = modal(`<div class="pc-hist-detail">${HIST_CSS}<img data-pc-src="${esc(x.url)}" alt="">
      <dl class="pc-hist-meta">${row('来源', x.from === 'chat' ? '聊天标记' : '生图页')}${row('时间', new Date(x.at).toLocaleString())}${row('种子', x.seed)}${row('尺寸', x.size)}${row('模型', x.model)}</dl>
      ${x.raw ? `<div class="pc-label">${x.from === 'chat' ? '标记里的提示词' : '正面提示词'}</div><p class="pc-quote small mono">${esc(x.raw)}</p>` : ''}
      ${x.prompt ? `<details class="pc-details"><summary>实际发出去的内容</summary><div class="pc-label">正面</div><p class="pc-quote small mono">${esc(x.prompt)}</p>${x.negative ? `<div class="pc-label">负面</div><p class="pc-quote small mono">${esc(x.negative)}</p>` : ''}${(x.chars || []).map((c, i) => `<div class="pc-label">人物 ${i + 1}</div><p class="pc-quote small mono">${esc(c)}</p>`).join('')}</details>` : ''}
      <div class="pc-actions wrap pc-mt-s">
        <button class="pc-btn dark" type="button" data-h="reuse">用这组参数再生成</button>
        <a class="pc-btn" data-pc-href="${esc(x.url)}" download="zhiku_${x.at}.png">下载</a>
        <button class="pc-btn" type="button" data-h="share">上传到共享</button>
        <button class="pc-btn danger" type="button" data-h="delete">删除</button>
        <button class="pc-btn" type="button" data-h="close">关闭</button>
      </div></div>`);
    box.style.maxHeight = '90dvh'; box.style.overflowY = 'auto';
    pcHydrate(box);
    box.addEventListener('click', async ev => {
        const act = ev.target.closest('[data-h]')?.dataset.h;
        if (act === 'close') box.closeModal();
        if (act === 'share') {
            if (!L.serverBase()) { toastr.warning('先到「设置」里填共享服务器地址', '共享'); return; }
            box.closeModal();
            openSharedUpload({ artistString: x.prompt || x.raw || '', negative: x.negative || '', image: await pcLocal.url(x.url) });
        }
        if (act === 'delete') { if (!(await confirmBox('删掉这张图？图片也会删掉。', { ok: '删除', cancel: '算了' }))) return; histRemove([x]); box.closeModal(); render(); }
        if (act === 'reuse') {
            const st = ui.studio, n = N.settings();
            st.pos = x.raw || x.prompt || st.pos;
            const m = /^(\d+)\D+(\d+)$/.exec(String(x.size || ''));
            if (m) { n.novelai_width = Number(m[1]); n.novelai_height = Number(m[2]); }
            if (x.seed !== '' && x.seed !== undefined) n.novelai_seed = Number(x.seed) || 0;
            N.save(); saveStudio();
            box.closeModal(); ui.view = 'studio'; render();
            toastr.info(x.seed ? `种子已设为 ${x.seed}，想随机就把种子改回 0` : '提示词已填好', '历史生图', { timeOut: 5000 });
        }
    });
}

// ═════════════════════ ComfyUI 页 ═════════════════════
function loadCfy() {
    if (ui.cfy?.loaded) return ui.cfy;
    const saved = getData().options.comfyPage || {};
    ui.cfy = { loaded: true, pos: saved.pos ?? '', neg: saved.neg ?? '', size: saved.size || '832x1216', result: '', sent: null, busy: false };
    return ui.cfy;
}
function saveCfy() {
    const c = ui.cfy; if (!c) return;
    getData().options.comfyPage = { pos: c.pos, neg: c.neg, size: c.size };
    commit({ silent: true });
}
function comfyConnectNow(force = false) {
    const k = ui.comfy || (ui.comfy = {});
    if (!force && (k.busy || k.tried)) return;
    const seq = (k.seq || 0) + 1; k.seq = seq;
    Object.assign(k, { busy:true, tried:true, ok:false, err:'', models:[], samplers:[], schedulers:[], workflows:[] });
    N.comfyAutoConfig();
    const url = N.settings().comfyUrl;
    const current = () => k.seq === seq && N.settings().comfyUrl === url && !stopped;
    N.comfyConnect().then(info => {
        if (!current()) return;
        Object.assign(k, info, { busy:false, ok:true, err:'' });
        const s = N.settings();
        if (!s.comfyModel && info.models.length) { s.comfyModel = info.models[0].value; N.save(); }
    }).catch(e => { if (current()) Object.assign(k, { busy:false, ok:false, err:e.message }); }).finally(() => { if (current() && ui.view === 'comfy') render(); });
}
function ensureCfyCss() {
    if (!DOC.getElementById('pc-comfy-css')) {
        const st = DOC.createElement('style'); st.id = 'pc-comfy-css';
        st.textContent = `.pc-nav{grid-template-columns:repeat(7,minmax(0,1fr))!important;gap:3px!important}
.pc-nav .pc-pill{white-space:nowrap!important;font-size:12px!important;padding:0 1px!important;letter-spacing:0!important}
.pc-cf-conn{display:flex;align-items:center;gap:12px}.pc-cf-dot{flex:none;width:12px;height:12px;border-radius:50%;background:#9a948b}
.pc-cf-dot.ok{background:#7fae79;box-shadow:0 0 0 4px rgba(127,174,121,.18)}.pc-cf-dot.err{background:#c0675c;box-shadow:0 0 0 4px rgba(192,103,92,.18)}.pc-cf-dot.busy{background:#c9a24a;animation:pc-cf-blink 1s infinite}
@keyframes pc-cf-blink{50%{opacity:.35}}
.pc-cf-conn .pc-grow small{display:block;opacity:.7;font-size:12px;line-height:1.5;word-break:break-all}
.pc-cf-kv{display:grid;grid-template-columns:1fr 1fr;gap:8px}`;
        pcMount(st);
    }
}
function viewComfy(d) {
    ensureCfyCss();
    const s = N.settings();
    const k = ui.comfy || {};
    if (!k.tried) setTimeout(() => comfyConnectNow(), 0);
    const c = loadCfy();
    const dot = k.busy ? 'busy' : k.ok ? 'ok' : k.err ? 'err' : '';
    const url = String(s.comfyUrl || '').trim() || '（还没填）';
    const custom = String(s.comfyWf || '');
    const pick = (key, list, def = '') => {
        const cur = String(s[key] || def);
        const arr = (list || []).map(x => typeof x === 'string' ? { value: x, text: x } : x);
        if (!arr.length) return `<input data-st="${key}" value="${esc(cur)}" placeholder="${esc(def || '点「重连」后可以选')}">`;
        if (cur && !arr.some(x => x.value === cur)) arr.unshift({ value: cur, text: cur + '（列表里没有）' });
        return `<select data-st="${key}">${cur ? '' : '<option value="">选一个</option>'}${arr.map(x => `<option value="${esc(x.value)}" ${x.value === cur ? 'selected' : ''}>${esc(x.text)}</option>`).join('')}</select>`;
    };
    const wfOpts = [['', '内置：基础文生图']];
    for (const w of k.workflows || []) wfOpts.push(['cu:' + w, 'ComfyUI 里的：' + w.replace(/\.json$/i, '')]);
    if (custom && !wfOpts.some(o => o[0] === custom)) wfOpts.push([custom, (custom.startsWith('file:') ? '电脑上的文件：' : 'ComfyUI 里的：') + custom.replace(/^\w+:/, '').replace(/\.json$/i, '')]);
    const [w, h] = c.size.split('x').map(Number);
    const sizeBtn = (v, t) => `<button class="pc-pill ${c.size === v ? 'on' : ''}" data-act="cfysize" data-v="${v}">${t}</button>`;
    const sum = custom ? '用工作流自己的参数' : `${esc(s.comfySteps || 28)} 步 · CFG ${esc(s.comfyCfg || 6)} · ${esc(s.comfySampler || 'euler_ancestral')}`;
    return `
    <section class="pc-card pc-pad">
      <div class="pc-label" style="margin-top:0">连接</div>
      <div class="pc-cf-conn"><i class="pc-cf-dot ${dot}"></i><div class="pc-grow"><b>${k.busy ? '正在连接…' : k.ok ? '已连上' : k.err ? '没连上' : '还没连接'}</b>
        <small>${esc(url)}${k.err ? ' · ' + esc(k.err) : k.ok ? ` · ${(k.models || []).length} 个模型` : ''}</small></div>
        <button class="pc-pill dashed" data-act="cfyconnect" ${k.busy ? 'disabled' : ''}>重连</button></div>
      <details class="pc-details pc-mt-s" ${ui.cfyUrlOpen || k.err ? 'open' : ''}><summary class="pc-dim small">改地址</summary>
        <label class="pc-field"><span>ComfyUI 地址</span><input data-st="comfyUrl" value="${esc(s.comfyUrl || '')}" placeholder="http://127.0.0.1:8188" autocomplete="off"></label>
        <div class="pc-hint">打开这页会自动连：先用酒馆「图片生成」里填的 ComfyUI 地址，没填就用本机 127.0.0.1:8188。手机上的酒馆连电脑的 ComfyUI，填电脑的局域网地址，ComfyUI 启动时加 --listen。</div>
      </details>
      <label class="pc-field"><span>工作流</span><select data-act-change="cfywf">${wfOpts.map(([v, t]) => `<option value="${esc(v)}" ${v === custom ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></label>
      <div class="pc-actions wrap" style="margin-top:6px"><label class="pc-pill dashed tiny" style="cursor:pointer">从电脑选文件<input type="file" accept=".json,application/json" data-cfyfile hidden></label>${k.wfError ? `<span class="pc-dim small">${esc(k.wfError)}</span>` : k.workflows ? `<span class="pc-dim small">ComfyUI 里有 ${k.workflows.length} 个工作流</span>` : ''}</div>
      ${custom ? '<div class="pc-hint">用自己的工作流时，模型和采样参数都按工作流里设好的；智库只填正面、负面、尺寸和种子。</div>' : `
      <label class="pc-field"><span>模型</span>${pick('comfyModel', k.models)}</label>`}
      <details class="pc-details pc-mt-s"><summary class="pc-row-between"><span>采样参数</span><span class="pc-dim small">${sum}</span></summary>
        ${custom ? '' : `<div class="pc-cf-kv">
          <label class="pc-field"><span>步数</span><input data-st="comfySteps" inputmode="numeric" value="${esc(s.comfySteps || '28')}"></label>
          <label class="pc-field"><span>CFG</span><input data-st="comfyCfg" inputmode="decimal" value="${esc(s.comfyCfg || '6')}"></label>
          <label class="pc-field"><span>采样器</span>${pick('comfySampler', k.samplers, 'euler_ancestral')}</label>
          <label class="pc-field"><span>调度器</span>${pick('comfyScheduler', k.schedulers, 'normal')}</label></div>`}
        <div class="pc-cf-kv">
          <label class="pc-field"><span>种子（空着随机）</span><input data-st="comfySeed" inputmode="numeric" value="${esc(s.comfySeed || '')}" placeholder="随机"></label>
          <label class="pc-field"><span>画师名写法</span><select data-st="comfyArtist">${[['plain', 'xxx'], ['by', 'by xxx'], ['keep', 'artist:xxx']].map(([v, t]) => `<option value="${v}" ${(s.comfyArtist || 'plain') === v ? 'selected' : ''}>${t}</option>`).join('')}</select></label></div>
        <label class="pc-field"><span>质量词（加在正面最后）</span><textarea class="pc-textarea mono small" data-st="comfyQuality" rows="2">${esc(s.comfyQuality ?? N.COMFY_Q)}</textarea></label>
        <label class="pc-field"><span>负面预设（加在负面最前）</span><textarea class="pc-textarea mono small" data-st="comfyNeg" rows="3">${esc(s.comfyNeg ?? N.COMFY_UC)}</textarea></label>
        <div class="pc-hint">二次元画师串推荐 Illustrious / NoobAI 系的 SDXL 模型。画师串照 NovelAI 写法就行：1.2::xxx::、{xxx}、[xxx]、artist:xxx 会自动换成 ComfyUI 写法。</div>
      </details>
    </section>
    <section class="pc-card pc-pad pc-mt">
      <div class="pc-row-between"><h2 class="pc-h2" style="margin:0">ComfyUI 生图</h2><span class="pc-dim small">${esc(custom ? custom.replace(/^\w+:/, '').replace(/\.json$/i, '') : String(s.comfyModel || '还没选模型').replace(/\.[^.]+$/, ''))}</span></div>
      <label class="pc-label" for="pc-cfy-pos">正面</label>
      <textarea id="pc-cfy-pos" class="pc-textarea mono big" data-bind="cfy.pos" placeholder="artist:xxx, 1girl, solo, white dress …">${esc(c.pos)}</textarea>
      <div class="pc-chips" style="margin-top:6px"><button class="pc-pill dashed tiny" data-act="cfyfill" data-from="active">＋ 用正文画师串</button><button class="pc-pill dashed tiny" data-act="cfyfill" data-from="studio">＋ 用生图页的正面</button></div>
      <label class="pc-label" for="pc-cfy-neg">负面</label>
      <textarea id="pc-cfy-neg" class="pc-textarea small mono" data-bind="cfy.neg" placeholder="不想出现的东西">${esc(c.neg)}</textarea>
      <div class="pc-chips" style="margin-top:10px">${sizeBtn('832x1216', '竖')}${sizeBtn('1216x832', '横')}${sizeBtn('1024x1024', '方')}<span class="pc-dim small" style="align-self:center">${w}×${h}</span></div>
    </section>
    <button class="pc-btn dark big pc-mt" data-act="cfygen" ${c.busy ? 'disabled' : ''}>${seal()}${c.busy ? '<span class="pc-busy">生成中</span>' : '生成'}</button>
    ${c.result ? `
    <section class="pc-card pc-mt pc-result">
      <img src="${esc(c.result)}" alt="生成结果" data-act="viewimg" data-src="${esc(c.result)}">
      <div class="pc-actions wrap">
        <a class="pc-btn" href="${esc(c.result)}" download="zhiku_comfy_${Date.now()}.png">下载</a>
        <button class="pc-btn" data-act="cfyinsert">插到聊天最后一楼</button>
        <button class="pc-btn" data-act="cfygen">再来一张</button>
        <button class="pc-btn" data-act="cfyshare">上传到共享</button>
        <button class="pc-btn danger" data-act="cfyclear">删掉</button>
      </div>
      ${c.sent ? `<details class="pc-details pc-sent-box"><summary>实际发出去的内容（${esc(c.sent.size)} · 种子 ${esc(c.sent.seed)}）</summary>
        <div class="pc-label">正面</div><p class="pc-quote small mono">${esc(c.sent.prompt)}</p>
        <div class="pc-label">负面</div><p class="pc-quote small mono">${esc(c.sent.negative)}</p></details>` : ''}
    </section>` : ''}
    <section class="pc-card pc-pad pc-mt">
      <div class="pc-label" style="margin-top:0">聊天里</div>
      <label class="pc-switch"><input type="checkbox" data-st-check="comfyChat" ${String(s.comfyChat) === 'true' ? 'checked' : ''}><span></span>聊天插图也用 ComfyUI<small>关着就还是 NovelAI。漫画一直用 NovelAI。NovelAI 的生图页和这页互不影响。</small></label>
    </section>`;
}
function viewStudio(d) {
    const s = settingsST();
    loadStudio();
    const st = ui.studio;
    const w = Number(s.novelai_width) || 832, h = Number(s.novelai_height) || 1216;
    const pv = previewHtml(s);
    const ucpVal = String(s.UCP_novelai ?? '');
    const owner = M.resolveTicket(d, st.sourceRef) ? st.sourceRef : null;
    const nArtists = M.parseArtistString(st.pos).members.length;
    const nOther = M.tokenize(st.pos).filter(t => !t.isArtist).length;
    const sizeBtn = (pw, ph, t) => `<button class="pc-pill ${pw === w && ph === h ? 'on' : ''}" data-act="studiosize" data-size="${pw}x${ph}">${t}</button>`;
    const modelName = (N.MODELS.find(m => m[0] === s.novelaimode) || [0, s.novelaimode])[1];
    return `
    ${!N.isReady() ? `<section class="pc-card pc-pad pc-warn-card"><b>还没填 NovelAI key</b><div class="pc-hint">填好才能生图。</div><button class="pc-btn dark pc-mt-s" data-act="nav" data-view="settings">去填</button></section>` : ''}
    <section class="pc-card pc-pad ${!N.isReady() ? 'pc-mt' : ''}">
      <div class="pc-row-between"><h2 class="pc-h2" style="margin:0">生成图片</h2><span class="pc-dim small">${esc(modelName)}</span></div>
      <div class="pc-row-between" style="margin-top:10px"><span class="pc-label" style="margin:0">正面提示词</span><span class="pc-chips" style="margin:0;flex-wrap:wrap;justify-content:flex-end"><label class="pc-pill dashed tiny" style="cursor:pointer">${ui.img2pBusy ? '<span class="pc-busy">看图中</span>' : '看图写提示词'}<input type="file" accept="image/*" data-img2prompt hidden ${ui.img2pBusy ? 'disabled' : ''}></label><label class="pc-pill dashed tiny" style="cursor:pointer">${ui.poseBusy ? '<span class="pc-busy">读姿势中</span>' : '看图读姿势构图'}<input type="file" accept="image/*" data-imgpose hidden ${ui.poseBusy ? 'disabled' : ''}></label></span></div>
      <div class="pc-artline">
        ${(() => { const cv = owner && M.ticketCover(d, owner); return cv ? `<img class="pc-artcover" src="${esc(imgUrl(cv))}" alt="看例图" data-act="viewticket" data-type="${owner.type}" data-id="${esc(owner.id)}">` : seal(); })()}
        <div class="pc-grow"><b>${owner ? esc(M.ticketName(d, owner)) : (st.pos.trim() ? '这串还没存进画师库' : '还没写')}</b><small>${[nArtists ? nArtists + ' 位画师' : '没有 artist: 画师', nOther ? nOther + ' 个别的词' : ''].filter(Boolean).join(' · ')}${owner && M.ticketCover(d, owner) ? ' · 点图看大图' : ''}</small></div>
        <button class="pc-pill dashed" data-act="pickartist">换画师</button>
      </div>
      ${(() => { const bare = guessBareArtists(d, st.pos); return bare.length ? `<div class="pc-bare" style="margin-top:8px"><div class="pc-row-between"><span class="pc-dim small">没写 artist: 的画师名 · 点名字单个补</span><button class="pc-pill tiny on" data-act="addprefix">全部补上</button></div><div class="pc-chips wrap">${bare.map(n => `<button class="pc-pill dashed tiny" data-act="addprefix" data-name="${esc(n)}">${esc(n)}</button>`).join('')}</div></div>` : ''; })()}
      <div class="pc-actions wrap pc-mt-s">
        <button class="pc-pill" data-act="saveartist">保存画师串</button>
        <button class="pc-pill dashed" data-act="clearstudio">清空当前串</button>
        ${st.clearUndo ? '<button class="pc-pill dashed" data-act="undoclearstudio">撤销清空</button>' : ''}
        ${owner?.type === 'group' ? `<button class="pc-pill dashed danger" data-act="delete" ${refAttr(owner)}>删除原串</button>` : ''}
      </div>
      <textarea id="pc-pos" class="pc-textarea mono big" data-bind="studio.pos" placeholder="artist:xxx, 1boy, solo, black hair, sitting, rain …">${esc(st.pos)}</textarea>
      <div id="pc-pos-ban">${banWarn(d, st.pos)}${lintHtml(st.pos)}</div>
      <label class="pc-label" for="pc-neg">负面提示词</label>
      <textarea id="pc-neg" class="pc-textarea small mono" data-bind="studio.neg" placeholder="不想出现的东西，比如 1girl, text">${esc(st.neg)}</textarea>
      <div class="pc-mt-s">${castFold()}</div>
      <div class="pc-mt-s">${i2iFold(s)}</div>
      <div class="pc-row-between" style="margin-top:10px">
        <div class="pc-chips" style="margin:0">${sizeBtn(832, 1216, '竖')}${sizeBtn(1216, 832, '横')}${sizeBtn(1024, 1024, '方')}</div>
        <label class="pc-cfg">CFG <input type="number" step="0.1" data-st="nai3Scale" value="${esc(s.nai3Scale)}"></label>
      </div>
    </section>
    <button class="pc-btn dark big pc-mt" data-act="generate" ${st.busy ? 'disabled' : ''}>${seal()}${st.busy ? '<span class="pc-busy">生成中</span>' : '生成'}</button>
    ${st.result ? `
    <section class="pc-card pc-mt pc-result">
      <img src="${esc(st.result)}" alt="生成结果" data-act="viewimg" data-src="${esc(st.result)}">
      <div class="pc-actions wrap">
        <button class="pc-btn" data-act="saveresult">存为例图</button>
        <button class="pc-btn" data-act="i2iresult">拿这张垫图</button>
        <button class="pc-btn" data-act="quickshare">上传到共享</button>
        <button class="pc-btn" data-act="inpaint">局部重绘</button>
        <button class="pc-btn" data-act="insertresult">插到聊天最后一楼</button>
        <a class="pc-btn" href="${esc(st.result)}" download="piaoce_${Date.now()}.png">下载</a>
        <button class="pc-btn danger" data-act="clearresult">删掉</button>
      </div>
      ${st.sent ? `<details class="pc-details pc-sent-box"><summary>这张图实际发出去的内容（${esc(st.sent.size)} · 种子 ${esc(st.sent.seed)}）</summary>
        <div class="pc-label">正面</div><p class="pc-quote small mono">${esc(st.sent.prompt)}</p>
        <div class="pc-label">负面</div><p class="pc-quote small mono">${esc(st.sent.negative)}</p>
        ${(st.sent.chars || []).map((c, i) => `<div class="pc-label">人物 ${i + 1}</div><p class="pc-quote small mono">${esc(typeof c === 'string' ? c : c?.prompt || '')}</p>`).join('')}
        ${st.sent.vibes ? `<div class="pc-banwarn">还带了氛围「${esc(st.sent.vibes.name)}」${st.sent.vibes.n} 张参考图：画面会往这几张图的色调、构图、质感靠。不想要就到「氛围」选「不用氛围」。</div>` : ''}
        ${st.sent.director ? `<div class="pc-banwarn">还带了角色参考 ${st.sent.director} 张：人物长相会往参考图靠。</div>` : ''}</details>` : ''}
    </section>` : ''}

    ${historyFold(d)}

    ${fold('scene', '固定提示词', st.sceneOn === false ? '不发送' : !String(st.scene || '').trim() ? '跟着发送 · 还没写' : !sceneReady() ? '跟着发送 · 生成时转成标签' : `跟着发送 · ${M.tokenize(sceneTags()).length} 个词`, `
      <label class="pc-switch"><input type="checkbox" data-scene-on ${st.sceneOn !== false ? 'checked' : ''}><span></span>每次生成都带上<small>接在正面提示词后面、质量词前面一起发。不改你的正面提示词，也不进画师串。</small></label>
      <textarea id="pc-scene" class="pc-textarea small" data-bind="studio.scene" placeholder="中文英文都行。比如：坐在窗边喝咖啡，外面下雨 / 1boy, sitting, window, rain">${esc(st.scene || '')}</textarea>
      ${sceneLibrary()}
      <div id="pc-scene-ai" ${sceneZh() ? '' : 'hidden'}>
        <div class="pc-dim small pc-mt-s" id="pc-scene-state">${sceneStateText()}</div>
        <div class="pc-row-between pc-mt-s"><span class="pc-dim small">用哪个 AI 转</span></div>${apiChips(true)}
        <label class="pc-switch"><input type="checkbox" data-bind-check="studio.sceneExpand" ${st.sceneExpand ? 'checked' : ''}><span></span>让 AI 补全细节<small>外貌、衣服、动作、场景、光线、构图都写全。关掉就只翻译你写的。</small></label>
        <button class="pc-btn" data-act="scenetrans" ${st.sceneBusy ? 'disabled' : ''}>${st.sceneBusy ? '<span class="pc-busy">转换中</span>' : sceneReady() ? '重新转换' : '现在转换'}</button>
        ${st.sceneEn ? `<label class="pc-label">AI 转好的（实际发这段，可以直接改）</label>
        <textarea class="pc-textarea small mono" data-bind="studio.sceneEn">${esc(st.sceneEn)}</textarea>` : ''}
      </div>`)}
    ${fold('extra', '自动加的词', `质量词 ${pv.aqt ? '开' : '关'} · 负面预设 ${(ucpOptions(s).find(o => o[0] === ucpVal) || [0, '自定义'])[1].replace(/（.*）/, '')}`, `
      <label class="pc-switch"><input type="checkbox" data-aqt ${String(s.AQT_novelai ?? '') !== '' ? 'checked' : ''}><span></span>质量词（加在正面最后）<small>${pv.aqt ? esc(pv.aqt) : '现在不加'}</small></label>
      <label class="pc-field"><span>负面预设（加在负面最前面）</span>
        <select data-st="UCP_novelai">${ucpOptions(s).map(([v, t]) => `<option value="${esc(v)}" ${v === ucpVal ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
      ${ucpVal === 'custom' ? `<textarea class="pc-textarea small mono" data-ucp-custom placeholder="自己写的固定负面，比如 lowres, bad hands, watermark, text">${esc(s.UCP_custom || '')}</textarea>
      <div class="pc-hint">每次出图都加在负面最前面：生图页、聊天标记出图、例图、试穿都带上。</div>` : pv.ucp ? `<p class="pc-quote small mono">${esc(pv.ucp)}</p>` : ''}`)}
    ${fold('params', '更多参数', `步数 ${s.novelai_steps} · 种子 ${Number(s.novelai_seed) > 0 ? s.novelai_seed : '随机'} · ${w}×${h}`, paramFields(s, { withSize: true }))}
    ${fold('preview', '将会发送的内容', '正面 + 固定提示词 + 质量词，负面预设 + 负面', `
      ${d.vibeGroups?.[d.vibeActive]?.vibes?.length && N.vibeSupported() ? `<div class="pc-banwarn" style="margin-top:0">生成时还会带上氛围「${esc(d.vibeGroups[d.vibeActive].name)}」${d.vibeGroups[d.vibeActive].vibes.length} 张参考图，画面会往它们靠。</div>` : ''}
      <div class="pc-label" style="margin-top:0">正面</div><p class="pc-quote small mono" id="pc-pv-pos">${pv.pos || '（空）'}</p>
      <div class="pc-label">负面</div><p class="pc-quote small mono" id="pc-pv-neg">${pv.neg || '（空）'}</p>`)}`;
}

// ═════════════════════ 票册 ═════════════════════

const SYM = {
    swap: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 4 3 8l4 4"/><path d="M3 8h14"/><path d="m17 20 4-4-4-4"/><path d="M21 16H7"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 5 5 9-10"/></svg>',
    down: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11"/><path d="m7 10 5 5 5-5"/><path d="M5 20h14"/></svg>',
    grid: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/></svg>',
    list: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M5 6h14M5 12h14M5 18h14"/></svg>',
    copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/></svg>',
    gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
};
/** 画师串里拉黑的画师标红 */
function markStr(d, str) {
    // 没有拉黑的画师就原样显示，写法不变
    if (!M.tokenize(str).some(t => t.isArtist && M.banInfo(d, t.text))) return esc(str);
    const out = [];
    for (const t of M.tokenize(str)) {
        const raw = t.raw || (Math.abs(t.weight - 1) < 0.001 ? t.text : `${M.fmtWeight(t.weight)}::${t.text}::`);
        const ban = t.isArtist && M.banInfo(d, t.text);
        out.push(ban ? `<mark class="pc-ban" title="${esc(ban.note || '拉黑的画师')}">${esc(raw)}</mark>` : esc(raw));
    }
    return out.join(', ');
}
/** 找出会让 NovelAI 把后面一大段都按错权重读的写法；fixed 是能自动改好的版本 */
function lintPrompt(text) {
    const t = String(text || '');
    const issues = [], cut = [];
    let open = null;
    for (const m of t.matchAll(/(-?\d+(?:\.\d+)?)?::/g)) {
        const head = t.slice(0, m.index);
        const junk = m[1] && /(^|[,\s])_+$/.test(head);
        const isNum = m[1] && (m.index === 0 || /[\s,{}\[\]()|:]/.test(head.at(-1)) || junk);
        if (junk) { const u = head.match(/_+$/)[0]; cut.push([m.index - u.length, u.length]); issues.push(`权重 ${m[1]}:: 前面多了「${u}」，NovelAI 认不出这个权重`); }
        if (isNum) { open = { at: m.index, w: m[1] }; continue; }
        const at = m.index + (m[1] ? m[1].length : 0);
        if (open) { open = null; continue; }
        cut.push([at, 2]);
        const near = t.slice(Math.max(0, at - 12), at + 14).trim();
        issues.push(`多了一个「::」（${near}）：前面没有开头的权重，可能打乱后面词的权重`);
    }
    if (open) issues.push(`「${open.w}::」没有关上，后面整段（包括画面描述）都会按 ${open.w} 倍算`);
    const sd = (t.match(/\([^()]*:\s*-?\d+(?:\.\d+)?\s*\)/g) || []).length;
    let fixed = t;
    for (const [at, len] of cut.sort((a, b) => b[0] - a[0])) fixed = fixed.slice(0, at) + fixed.slice(at + len);
    fixed = fixed.replace(/,\s*,/g, ',').replace(/\s{2,}/g, ' ');
    return { issues, sd, fixed, canFix: cut.length > 0 };
}
function lintHtml(text) {
    const r = lintPrompt(text);
    if (!r.issues.length && !r.sd) return '';
    return `<div class="pc-banwarn">${r.issues.map(x => `<div>⚠ ${esc(x)}</div>`).join('')}${r.sd ? `<div>ⓘ 有 ${r.sd} 处 SD 写法的 (词:1.3)，发送时会自动换成 1.3::词::</div>` : ''}${r.canFix ? '<button class="pc-pill dashed tiny" data-act="lintfix" style="margin-top:6px">一键修正</button>' : ''}</div>`;
}
function banWarn(d, str) {
    const list = M.bannedIn(d, str);
    if (!list.length) return '';
    return `<div class="pc-banwarn">⚠ 有拉黑的画师：${list.map(b => `<b>${esc(b.tag.replace(/^artist:/, ''))}</b>${b.note ? `（${esc(b.note)}）` : ''}`).join('、')}</div>`;
}
const useBtn = (d, ref) => `<button class="pc-use ${M.sameRef(ref, d.active) ? 'on' : ''}" data-act="use" ${refAttr(ref)} aria-label="${M.sameRef(ref, d.active) ? '正在用' : '用这个'}">${M.sameRef(ref, d.active) ? SYM.check : SYM.swap}</button>`;
const itemOf = (d, ref) => ref.type === 'group' ? d.groups[ref.id] : d.artists[ref.id];
/** 标签（原来叫收藏夹）：「收藏」放最前 */
function tagChips(d, ref, { small = false } = {}) {
    const it = itemOf(d, ref);
    const cls = small ? 'pc-pill tiny' : 'pc-pill';
    return `<button class="${cls} ${it.fav ? 'on' : 'dashed'}" data-act="fav" ${refAttr(ref)}>收藏</button>`
        + Object.values(d.collections).map(c => `<button class="${cls} ${it.collections?.includes(c.id) ? 'on' : 'dashed'}" data-act="togglecol" ${refAttr(ref)} data-col="${c.id}">${esc(c.name)}</button>`).join('')
        + `<button class="${cls} dashed" data-act="newcol" ${refAttr(ref)}>＋${small ? '' : ' 新标签'}</button>`;
}

function bookList(d) {
    const q = ui.search.trim().toLowerCase();
    const groups = ui.bookTab === 'groups';
    let list = groups ? Object.values(d.groups) : Object.values(d.artists);
    if (ui.bookFilter === 'fav') list = list.filter(x => x.fav);
    else if (ui.bookFilter !== 'all') list = list.filter(x => x.collections?.includes(ui.bookFilter));
    const text = x => groups ? x.name + ' ' + x.note + ' ' + M.ticketString(d, { type: 'group', id: x.id }) : x.tag + ' ' + x.note;
    if (q) list = list.filter(x => text(x).toLowerCase().includes(q));
    if (groups) list.sort((a, b) => (b.usedAt || b.createdAt) - (a.usedAt || a.createdAt));
    else list.sort((a, b) => a.tag.localeCompare(b.tag));
    return list.map(x => ({ type: groups ? 'group' : 'artist', id: x.id }));
}

/** 随机用的画师：当前标签（全部 / 收藏 / 自建标签）和搜索下的单个画师，跳过拉黑的 */
function randomPool(d) {
    const keep = ui.bookTab; ui.bookTab = 'artists';
    try { return bookList(d).map(r => d.artists[r.id]).filter(a => a && !M.banInfo(d, a.tag)); } finally { ui.bookTab = keep; }
}
function randomString(d, n, weighted) {
    const pool = randomPool(d);
    for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
    const W = [0.8, 0.9, 1, 1, 1.1, 1.2, 1.3];
    return pool.slice(0, n).map(a => { const w = weighted ? W[Math.floor(Math.random() * W.length)] : 1; return Math.abs(w - 1) < 0.001 ? a.tag : `${M.fmtWeight(w)}::${a.tag}::`; }).join(', ');
}
/** 组成 / 随机画师串：可以改、复制、存成画师组、直接设为正文画师串 */
function openStringMaker({ text = '', random = false } = {}) {
    const d = getData();
    const st = ui.maker ||= { n: 3, weighted: false };
    if (random) text = randomString(d, st.n, st.weighted);
    const poolSize = random ? randomPool(d).length : 0;
    const from = ui.bookFilter === 'all' ? '全部' : ui.bookFilter === 'fav' ? '收藏的' : `「${d.collections[ui.bookFilter]?.name || '这个标签'}」里的`;
    const box = modal(`<h3 class="pc-h3">${random ? '随机画师串' : '组成画师串'}</h3>
      ${random ? `<div class="pc-dim small">从${esc(from)}单个画师里随机抽${ui.search.trim() ? '（只抽搜索出来的）' : ''}，共 ${poolSize} 位，跳过拉黑的。换上面的标签就能换抽取范围。</div>
      <div class="pc-row-between pc-mt-s"><span class="pc-dim small">抽几位</span><div class="pc-chips" style="margin:0" data-mk-n>${[2, 3, 4, 5, 6].map(n => `<button class="pc-pill ${st.n === n ? 'on' : 'dashed'} tiny" type="button" data-n="${n}">${n}</button>`).join('')}</div></div>
      <label class="pc-switch"><input type="checkbox" data-mk-w ${st.weighted ? 'checked' : ''}><span></span>随机权重<small>每位画师随机给 0.8～1.3 的权重</small></label>` : ''}
      <label class="pc-label" for="pc-mk-text">画师串（可以直接改）</label>
      <textarea id="pc-mk-text" class="pc-textarea small mono" rows="3">${esc(text)}</textarea>
      <label class="pc-field pc-mt-s"><span>名字（不填就用前两位画师的名字）</span><input id="pc-mk-name" value=""></label>
      <div class="pc-actions wrap pc-mt-s">
        ${random ? '<button class="pc-btn" type="button" data-mk="again">再随机一次</button>' : ''}
        <button class="pc-btn" type="button" data-mk="copy">复制</button>
        <button class="pc-btn" type="button" data-mk="save">存成画师组</button>
        <button class="pc-btn dark" type="button" data-mk="use">存并设为正文画师串</button>
        <button class="pc-btn" type="button" data-mk="close">关闭</button>
      </div>`);
    const ta = box.querySelector('#pc-mk-text');
    const again = () => { ta.value = randomString(getData(), st.n, st.weighted); };
    box.addEventListener('change', ev => { if (ev.target.matches('[data-mk-w]')) { st.weighted = ev.target.checked; again(); } });
    box.addEventListener('click', async ev => {
        const nb = ev.target.closest('[data-n]');
        if (nb) { st.n = Number(nb.dataset.n); box.querySelectorAll('[data-mk-n] [data-n]').forEach(b => { b.classList.toggle('on', b === nb); b.classList.toggle('dashed', b !== nb); }); again(); return; }
        const act = ev.target.closest('[data-mk]')?.dataset.mk;
        if (!act) return;
        if (act === 'close') { box.closeModal(); return; }
        if (act === 'again') { again(); return; }
        const textNow = ta.value.trim();
        if (!textNow) { toastr.warning(random ? '没有能抽的单个画师，换个标签试试' : '画师串是空的', '画师串'); return; }
        if (act === 'copy') { try { await P.navigator.clipboard.writeText(textNow); toastr.success('已复制', '', { timeOut: 1200 }); } catch { ta.select(); } return; }
        const dd = getData();
        const ref = M.createFromString(dd, { name: box.querySelector('#pc-mk-name').value.trim(), text: textNow });
        if (!ref) { toastr.warning('没认出画师', '画师串'); return; }
        commit();
        if (act === 'use') E.setActive(ref);
        toastr.success(`${act === 'use' ? '已设为正文画师串' : '已存成画师组'}：${M.ticketName(dd, ref)}`, '画师串');
        if (!random) { ui.selecting = false; ui.picked.clear(); }
        box.closeModal(); render();
    });
}

function viewBook(d) {
    const cols = Object.values(d.collections);
    const view = d.options.bookView || 'grid';
    const refs = bookList(d);
    const emptyTxt = ui.bookTab === 'groups' ? empty('还没有画师组', '点右上角「＋」，粘贴一串画师就行。') : empty('还没有单个画师', '添加画师组时，组里的每位画师会自动出现在这里。');
    return `
    <div class="pc-toprow">
      <label class="pc-search"><span class="pc-sr">搜索</span>${ICON.search}<input data-bind="search" value="${esc(ui.search)}" placeholder="搜画师名、备注"></label>
      <div class="pc-vt"><button class="${view === 'grid' ? 'on' : ''}" data-act="bookview" data-v="grid" aria-label="网格">${SYM.grid}</button><button class="${view === 'list' ? 'on' : ''}" data-act="bookview" data-v="list" aria-label="列表">${SYM.list}</button></div>
      <button class="pc-add" data-act="register" aria-label="添加">＋</button>
    </div>
    <div class="pc-seg pc-mt-s">
      <button class="${ui.bookTab === 'groups' ? 'on' : ''}" data-act="booktab" data-tab="groups">画师组 · ${Object.keys(d.groups).length}</button>
      <button class="${ui.bookTab === 'artists' ? 'on' : ''}" data-act="booktab" data-tab="artists">单个画师 · ${Object.keys(d.artists).length}</button>
    </div>
    <div class="pc-chips">
      ${[['all', '全部'], ['fav', '收藏'], ...cols.map(c => [c.id, c.name])].map(([k, t]) => `<button class="pc-pill ${ui.bookFilter === k ? 'on' : 'dashed'}" data-act="bookfilter" data-f="${esc(k)}" ${d.collections[k] ? `data-lp="col" data-col="${esc(k)}"` : ''}>${esc(t)}</button>`).join('')}
      <button class="pc-pill dashed" data-act="newcol">＋</button>
    </div>
    <div class="pc-chips wrap pc-book-acts">
      <button class="pc-pill ${ui.selecting ? 'on' : 'dashed'}" data-act="selmode">${ui.selecting ? '退出多选' : '多选'}</button>
      ${ui.selecting ? '' : '<button class="pc-pill dashed" data-act="nav" data-view="batch">批量生成例图</button><button class="pc-pill dashed" data-act="randstring">随机画师串</button>'}
    </div>
    ${cols.length && !ui.selecting ? '<div class="pc-tip">长按标签可以改名或删除</div>' : ''}
    ${ui.selecting ? `<div class="pc-selbar"><span>已选 ${ui.picked.size} 个</span><button class="pc-pill dashed tiny" data-act="selall">全选</button>
      <button class="pc-pill dashed tiny" data-act="seltag" ${ui.picked.size ? '' : 'disabled'}>加标签</button>
      ${ui.bookTab === 'artists' ? `<button class="pc-pill dashed tiny" data-act="selstring" ${ui.picked.size ? '' : 'disabled'}>组成画师串</button>` : ''}
      ${ui.bookTab === 'artists' ? `<button class="pc-pill dashed tiny danger" data-act="selban" ${ui.picked.size ? '' : 'disabled'}>拉黑</button>` : ''}
      <button class="pc-pill tiny danger-solid" data-act="seldel" ${ui.picked.size ? '' : 'disabled'}>删除</button></div>` : ''}
    ${view === 'grid' ? `<div class="pc-grid2 pc-mt-s">${refs.map(r => ticketCard(d, r)).join('') || emptyTxt}</div>`
        : `<div class="pc-mt-s">${refs.map(r => listCard(d, r)).join('') || emptyTxt}</div>`}

    <div style="height:24px"></div>`;
}

function empty(t, s) { return `<div class="pc-empty span2"><b>${esc(t)}</b><span>${esc(s)}</span></div>`; }

function coverHtml(d, ref) {
    const c = M.ticketCover(d, ref);
    if (!c) return '<span>还没有例图</span>';
    return `<img src="${esc(imgUrl(c))}" loading="lazy" alt="">`;
}
function subLine(d, ref) {
    const it = itemOf(d, ref);
    if (ref.type === 'group') return it.members.map(m => d.artists[m.artistId]?.tag.replace(/^artist:/, '')).filter(Boolean).slice(0, 3).join(' · ') + (it.members.length > 3 ? ` 等 ${it.members.length} 位` : '');
    return it.note || (it.images.length ? `${it.images.length} 张例图` : '单个画师');
}

function ticketCard(d, ref) {
    const isActive = M.sameRef(ref, d.active);
    const name = M.ticketName(d, ref);
    const it = itemOf(d, ref);
    const banned = ref.type === 'artist' ? !!M.banInfo(d, it.tag) : M.groupBanned(d, it).length > 0;
    return `<article class="pc-ticket ${isActive ? 'active' : ''} ${banned ? 'banned' : ''}" data-act="${ui.selecting ? 'selpick' : 'open'}" data-lp="ticket" ${refAttr(ref)}>${ui.selecting ? `<span class="pc-selbox ${ui.picked.has(ref.id) ? 'on' : ''}">${ui.picked.has(ref.id) ? '✓' : ''}</span>` : ''}
      <div class="pc-ticket-img">${coverHtml(d, ref)}</div>
      ${ui.selecting ? '' : useBtn(d, ref)}${banned ? `<span class="pc-banbadge">${ref.type === 'artist' ? '黑名单' : '含黑名单画师'}</span>` : ''}
      <div class="pc-ticket-text"><b>${esc(name)}</b><small>${esc(subLine(d, ref))}</small></div>
    </article>`;
}

function listCard(d, ref) {
    const it = itemOf(d, ref);
    const isActive = M.sameRef(ref, d.active);
    const imgs = (it.images || []).slice(0, 6);
    return `<article class="pc-li ${isActive ? 'active' : ''}">
      <div class="pc-row-between">${ui.selecting ? `<button class="pc-selbox static ${ui.picked.has(ref.id) ? 'on' : ''}" data-act="selpick" ${refAttr(ref)}>${ui.picked.has(ref.id) ? '✓' : ''}</button>` : ''}<button class="pc-li-name pc-grow" data-act="open" ${refAttr(ref)}>${esc(M.ticketName(d, ref))} ›</button>${ui.selecting ? '' : useBtn(d, ref)}</div>
      ${(() => { const full = M.ticketString(d, ref); const key = ref.type + ':' + ref.id; const long = full.length > 110; const open = !!ui.strOpen[key]; return `<div class="pc-li-str mono ${long && !open ? 'clamp' : ''}">${markStr(d, full)}</div>${long ? `<button class="pc-strtoggle" data-act="strtoggle" data-key="${esc(key)}">${open ? '收起' : `展开全部 · ${M.tokenize(full).length} 个词`}</button>` : ''}`; })()}
      ${imgs.length ? `<div class="pc-li-imgs">${imgs.map(i => `<img src="${esc(imgUrl(i))}" loading="lazy" alt="" data-act="viewimg" data-src="${esc(imgUrl(i))}">`).join('')}</div>` : ''}
      <div class="pc-chips wrap">${tagChips(d, ref, { small: true })}</div>
      <textarea class="pc-textarea tiny" ${ref.type === 'group' ? `data-bind-group="${it.id}" data-field="note"` : `data-bind-artist="${it.id}"`} placeholder="写点备注…">${esc(it.note)}</textarea>
    </article>`;
}

/** 长按卡片弹出的面板 */
function openTicketSheet(ref) {
    const d = getData();
    if (!itemOf(d, ref)) return;
    const openedAt = Date.now();
    DOC.querySelector('.pc-sheet-backdrop')?.remove();
    const back = DOC.createElement('div');
    back.className = 'pc-sheet-backdrop fresh'; setTimeout(() => back.classList.remove('fresh'), 400);
    pcMount(back);
    const draw = () => {
        const it = itemOf(getData(), ref);
        if (!it) { back.remove(); return; }
        const imgs = it.images;
        back.innerHTML = `<section class="pc-sheet" role="dialog">
          <div class="pc-sheet-grip" aria-hidden="true"></div>
          <div class="pc-row-between"><h3 class="pc-h3" style="margin:0">${esc(M.ticketName(d, ref))}</h3><button class="pc-pill dashed tiny" data-sa="full">⤢ 整页</button></div>
          <div class="pc-dim small mono" style="word-break:break-all">${markStr(d, M.ticketString(d, ref))}</div>
          <div class="pc-hscroll pc-mt-s">${imgs.map(i => `<img class="pc-sheet-img" src="${esc(imgUrl(i))}" alt="">`).join('')}<button class="pc-sheet-img add" data-sa="sample">${ui.busyRefs.has(ref.id) ? '<span class="pc-busy">生成中</span>' : '＋<br>生成'}</button></div>
          ${label('标签')}<div class="pc-chips wrap" data-sheet-tags>${tagChips(d, ref)}</div>
          ${label('备注')}<textarea class="pc-textarea small" data-sa-note placeholder="适合什么题材…">${esc(it.note)}</textarea>
          <div class="pc-actions wrap"><button class="pc-btn danger" data-act="delete" ${refAttr(ref)}>删除</button>${ref.type === 'artist' && !M.banInfo(d, it.tag) ? `<button class="pc-btn" data-act="ban" data-tag="${esc(it.tag)}">拉黑</button>` : ''}<button class="pc-btn" data-sa="share">分享</button><button class="pc-btn dark" data-sa="use">${M.sameRef(ref, d.active) ? '正在用' : '用这串'}</button></div>
        </section>`;
    };
    draw();
    back.addEventListener('input', ev => { if (ev.target.matches('[data-sa-note]')) { itemOf(getData(), ref).note = ev.target.value; commit({ silent: true }); } });
    back.addEventListener('click', async ev => {
        if (ev.target === back) { if (Date.now() - openedAt > 400) { back.remove(); render(); } return; }
        const act = ev.target.closest('[data-act]');
        if (act) { await onClick({ target: act, stopPropagation() {} }, true); draw(); return; }
        const el = ev.target.closest('[data-sa]');
        if (!el) return;
        try {
            switch (el.dataset.sa) {
                case 'full': back.remove(); d.options.detailMode = 'full'; ui.backTo = 'book'; ui.view = ref.type; ui.detailId = ref.id; commit({ silent: true }); render(); break;
                case 'use': E.setActive(ref); back.remove(); toastr.success(`已切换到：${M.ticketName(d, ref)}`, '智库', { timeOut: 1800 }); break;
                case 'share': back.remove(); await shareToLobby(ref); break;
                case 'sample': if (!ui.busyRefs.has(ref.id)) openSamplePicker(ref, draw); break;
            }
        } catch (e) { toastr.error(e.message, '智库'); }
    });
}

/** 长按标签：改名 / 删除 */
async function tagMenu(colId) {
    const d = getData();
    const c = d.collections[colId];
    if (!c) return;
    const i = await chooseBox(`标签「${c.name}」`, ['改名', '删除这个标签']);
    if (i === 0) {
        const name = await promptText('新名字', c.name);
        if (name) { c.name = name.slice(0, 20); commit(); }
    } else if (i === 1) {
        if (!(await confirmBox(`删除标签「${c.name}」？画师和画师组不会被删。`))) return;
        delete d.collections[c.id];
        for (const x of [...Object.values(d.groups), ...Object.values(d.artists)]) x.collections = (x.collections || []).filter(y => y !== c.id);
        if (ui.bookFilter === c.id) ui.bookFilter = 'all';
        commit();
    }
}

function galleryHtml(d, ref) {
    const it = itemOf(d, ref);
    const busy = ui.busyRefs.has(ref.id);
    const order = { head: 0, bust: 1, full: 2 };
    const imgs = [...it.images].sort((a, b) => order[M.shotOf(d, a)] - order[M.shotOf(d, b)]);
    return `<div class="pc-gallery">${imgs.map(i => { const sh = M.shotOf(d, i); return `<div class="pc-gal-item shot-${sh}">${thumb(i, { showNsfw: true })}<span class="pc-shot">${i.nsfw ? 'NSFW ' : ''}${M.SHOTS[sh].name}</span><button class="pc-thumb-del" data-act="delimg" ${refAttr(ref)} data-img="${i.id}" aria-label="删除这张例图">×</button></div>`; }).join('')}
      <button class="pc-gal-add" data-act="sample" ${refAttr(ref)} ${busy ? 'disabled' : ''}><b>＋</b>${busy ? '<span class="pc-busy">生成中</span>' : '生成例图'}</button>
      <label class="pc-gal-add"><b>↑</b>上传<input type="file" accept="image/*" multiple data-upload="${it.id}" data-type="${ref.type}" hidden></label></div>
`;
}

function detailHead(d, ref, titleHtml) {
    return `<div class="pc-dhead"><button class="pc-round" data-act="back" aria-label="返回">‹</button>${titleHtml}
      <button class="pc-pill dashed tiny" data-act="tosheet" ${refAttr(ref)}>⤡ 面板</button>${useBtn(d, ref)}</div>`;
}
/** 例图：SFW/NSFW × 头像/胸像/立绘 */
function sampleChooser(scope) {
    const o = scope === 'batch' ? ui.batch : ui.sample;
    const ratings = scope === 'batch' ? [['sfw', 'SFW'], ['nsfw', 'NSFW'], ['both', '两种']] : [['sfw', 'SFW'], ['nsfw', 'NSFW']];
    const shots = [...Object.entries(M.SHOTS).map(([k, v]) => [k, `${v.name} ${v.ratio}`]), ['all', '三种都要']];
    return `<div class="pc-chips wrap">${ratings.map(([k, t]) => `<button class="pc-pill tiny ${o.rating === k ? 'on' : 'dashed'} ${k === 'nsfw' ? 'nsfw' : ''}" data-act="pickrating" data-scope="${scope}" data-v="${k}">${t}</button>`).join('')}</div>
      <div class="pc-chips wrap">${shots.map(([k, t]) => `<button class="pc-pill tiny ${o.shot === k ? 'on' : 'dashed'}" data-act="pickshot" data-scope="${scope}" data-v="${k}">${t}</button>`).join('')}
      <button class="pc-pill tiny dashed" data-act="edittpl" data-scope="${scope}">改提示词</button></div>`;
}
/** 生成例图：先弹小面板选 SFW/NSFW 和构图 */
function openSamplePicker(ref, redraw) {
    const d = getData();
    DOC.querySelector('.pc-sp-back')?.remove();
    const back = DOC.createElement('div');
    back.className = 'pc-sheet-backdrop pc-sp-back fresh'; setTimeout(() => back.classList.remove('fresh'), 400);
    const openedAt = Date.now();
    const shapes = { head: [22, 22], bust: [20, 27], full: [15, 27] };
    const draw = () => {
        const n = chosenTemplates('sample').length;
        back.innerHTML = `<section class="pc-sheet pc-sp">
          <div class="pc-sheet-grip" aria-hidden="true"></div>
          <h3 class="pc-h3" style="margin:0">生成例图 · ${esc(M.ticketName(d, ref))}</h3>
          <div class="pc-label">内容</div>
          <div class="pc-seg">${[['sfw', 'SFW'], ['nsfw', 'NSFW']].map(([k, t]) => `<button class="${ui.sample.rating === k ? 'on' : ''}" data-sp="rating" data-v="${k}">${t}</button>`).join('')}</div>
          <div class="pc-label">构图（可以多选）</div>
          <div class="pc-sp-shots">${Object.entries(M.SHOTS).map(([k, v]) => `<button class="${ui.sample.shots.has(k) ? 'on' : ''}" data-sp="shot" data-v="${k}"><i style="width:${shapes[k][0]}px;height:${shapes[k][1]}px"></i>${v.name}<small>${v.ratio}</small></button>`).join('')}</div>
          <div class="pc-row-between pc-mt-s"><button class="pc-linkish" data-sp="tpl">改提示词</button><span class="pc-dim small">会生成 ${n} 张</span></div>
          <button class="pc-btn dark big pc-mt-s" data-sp="go" ${n ? '' : 'disabled'}>${seal()}${n ? '开始生成' : '先选一种构图'}</button>
        </section>`;
    };
    draw();
    pcMount(back);
    back.addEventListener('click', async ev => {
        if (ev.target === back) { if (Date.now() - openedAt > 400) back.remove(); return; }
        const el = ev.target.closest('[data-sp]');
        if (!el) return;
        const k = el.dataset.sp;
        if (k === 'rating') { ui.sample.rating = el.dataset.v; draw(); }
        if (k === 'shot') { const v = el.dataset.v; if (ui.sample.shots.has(v)) ui.sample.shots.delete(v); else ui.sample.shots.add(v); draw(); }
        if (k === 'tpl') { back.remove(); await openTemplateEditor(chosenTemplates('sample')[0] || 'sfw_bust'); }
        if (k === 'go') {
            const tpls = chosenTemplates('sample');
            back.remove();
            ui.busyRefs.add(ref.id); redraw();
            try { for (const t of tpls) { await E.makeSampleFor(ref, t); redraw(); } toastr.success(`例图已保存（${tpls.length} 张）`, '智库', { timeOut: 1800 }); }
            catch (e) { toastr.error(e.message, '生成例图失败'); }
            finally { ui.busyRefs.delete(ref.id); redraw(); }
        }
    });
}

/** 选中的组合对应哪些模板 id */
function chosenTemplates(scope) {
    const o = scope === 'batch' ? ui.batch : ui.sample;
    const rs = o.rating === 'both' ? ['sfw', 'nsfw'] : [o.rating];
    const ss = scope === 'batch' ? (o.shot === 'all' ? Object.keys(M.SHOTS) : [o.shot]) : Object.keys(M.SHOTS).filter(k => o.shots.has(k));
    return rs.flatMap(r => ss.map(sh => `${r}_${sh}`)).filter(id => getData().templates[id]);
}

function viewArtist(d) {
    const a = d.artists[ui.detailId];
    if (!a) { ui.view = 'book'; return viewBook(d); }
    const ref = { type: 'artist', id: a.id };
    const groups = M.groupsContaining(d, a.id);
    return `
    ${detailHead(d, ref, `<h2 class="pc-dtitle mono">${esc(a.tag.replace(/^artist:/, ''))}</h2>`)}
    ${M.banInfo(d, a.tag) ? `<div class="pc-card pc-pad pc-mt-s pc-ban-card"><b>已拉黑</b>${M.banInfo(d, a.tag).note ? `：${esc(M.banInfo(d, a.tag).note)}` : ''}<button class="pc-pill dashed tiny" data-act="unban" data-tag="${esc(a.tag)}">取消拉黑</button></div>` : ''}
    ${galleryHtml(d, ref)}
    <section class="pc-card pc-pad pc-mt">
      ${label('画师名（发送的就是这个）')}
      <div class="pc-strrow"><p class="pc-quote small mono">${markStr(d, a.tag)}</p><button class="pc-round dashed" data-act="copytext" data-text="${esc(a.tag)}" aria-label="复制">${SYM.copy}</button></div>
    </section>
    <section class="pc-card pc-pad pc-mt">
      <b>标签</b><div class="pc-chips wrap">${tagChips(d, ref)}</div>
      <b class="pc-block pc-mt-s">备注</b>
      <textarea class="pc-textarea small" data-bind-artist="${a.id}" placeholder="适合什么题材、权重心得…">${esc(a.note)}</textarea>
    </section>
    <section class="pc-card pc-pad pc-mt">
      <b>在哪些画师组里</b>
      <div class="pc-chips wrap">${groups.map(g => `<button class="pc-pill gold" data-act="open" data-type="group" data-id="${g.id}">${esc(g.name)} ›</button>`).join('') || '<span class="pc-dim">还不在任何画师组里</span>'}</div>
    </section>
    <div class="pc-center pc-mt"><button class="pc-pill dashed" data-act="share" ${refAttr(ref)}>分享</button></div>
    <div class="pc-center pc-mt">${M.banInfo(d, a.tag) ? '' : `<button class="pc-pill dashed danger" data-act="ban" data-tag="${esc(a.tag)}">拉黑这个画师</button> `}<button class="pc-pill dashed danger" data-act="delete" ${refAttr(ref)}>删除这个画师</button></div>
    <div style="height:24px"></div>`;
}

function viewGroup(d) {
    const g = d.groups[ui.detailId];
    if (!g) { ui.view = 'book'; return viewBook(d); }
    const ref = { type: 'group', id: g.id };
    const str = M.ticketString(d, ref);
    return `
    ${detailHead(d, ref, `<input class="pc-dtitle" data-bind-group="${g.id}" data-field="name" value="${esc(g.name)}" aria-label="画师组名字">`)}
    ${galleryHtml(d, ref)}
    <section class="pc-card pc-pad pc-mt">
      ${label('画师串（发送的就是这一串）')}
      <div class="pc-actions wrap"><button class="pc-pill dashed" data-act="editstring" data-id="${g.id}">改写原串</button><button class="pc-pill dashed danger" data-act="delete" ${refAttr(ref)}>删除整串</button></div>
      <div class="pc-strrow"><p class="pc-quote small mono">${markStr(d, str)}</p><button class="pc-round dashed" data-act="copytext" data-text="${esc(str)}" aria-label="复制">${SYM.copy}</button></div>
      <label class="pc-field pc-mt-s"><span>负面（选这串时一起换上，可不填）</span><textarea class="pc-textarea small mono" data-bind-group="${g.id}" data-field="neg" placeholder="比如 1girl, text">${esc(g.neg || '')}</textarea></label>
      <label class="pc-field pc-mt-s"><span>绑定模型（这串当正文画师串时自动换成这个模型）</span><select class="pc-input" data-bind-group="${g.id}" data-field="model"><option value="">不绑，跟设置走</option>${N.MODELS.map(([v, t]) => `<option value="${v}" ${g.model === v ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></label>
    </section>
    <section class="pc-card pc-pad pc-mt">
      <b>标签</b><div class="pc-chips wrap">${tagChips(d, ref)}</div>
      <b class="pc-block pc-mt-s">备注</b>
      <textarea class="pc-textarea small" data-bind-group="${g.id}" data-field="note" placeholder="适合什么题材、配哪个氛围…">${esc(g.note)}</textarea>
    </section>
    <section class="pc-card pc-pad pc-mt">
      <div class="pc-row-between"><b>组里的画师 · ${g.members.length}</b><button class="pc-pill dashed tiny" data-act="addmember" data-id="${g.id}">＋ 加画师</button></div>
      ${g.members.map((m, i) => memberRow(d, g, m, i)).join('')}
      <div class="pc-center pc-mt-s"><button class="pc-pill dashed tiny" data-act="samplemembers" data-id="${g.id}">给每位画师生成例图</button></div>
    </section>
    <details class="pc-fold"><summary><b>更多</b><i>画师后面跟的词 · 整串改写 · 分享</i></summary><div class="pc-fold-in">
      <label class="pc-field"><span>画师后面跟的词（比如年份，可不填）</span><input class="pc-input" data-bind-group="${g.id}" data-field="extra" value="${esc(g.extra)}" placeholder="比如 year 2024"></label>
      <div class="pc-actions wrap"><button class="pc-btn" data-act="editstring" data-id="${g.id}">整串改写</button><button class="pc-btn" data-act="share" ${refAttr(ref)}>分享</button></div>
    </div></details>
    <div class="pc-center pc-mt"><button class="pc-pill dashed danger" data-act="delete" ${refAttr(ref)}>删除这个画师组</button></div>
    <div style="height:24px"></div>`;
}

function memberRow(d, g, m, i) {
    const a = d.artists[m.artistId];
    if (!a) return '';
    const ref = { type: 'artist', id: a.id };
    const cover = a.images.find(x => !x.nsfw) || a.images[0];
    const ban = M.banInfo(d, a.tag);
    return `<div class="pc-mem ${ban ? 'banned' : ''}">
      <button class="pc-mem-av" data-act="open" ${refAttr(ref)}>${cover ? `<img src="${esc(imgUrl(cover))}" alt="">` : ''}</button>
      <button class="pc-mem-name" data-act="open" ${refAttr(ref)}><b class="mono">${esc(a.tag.replace(/^artist:/, ''))}</b><small>${ban ? '黑名单' + (ban.note ? '：' + esc(ban.note) : '') : a.images.length ? a.images.length + ' 张例图' : '还没有例图'}</small></button>
      <div class="pc-stepper">
        <button data-act="weight" data-id="${g.id}" data-i="${i}" data-d="-0.05" aria-label="减权重">−</button>
        <span>${M.fmtWeight(m.weight)}</span>
        <button data-act="weight" data-id="${g.id}" data-i="${i}" data-d="0.05" aria-label="加权重">＋</button>
      </div>
      <button class="pc-x" data-act="rmmember" data-id="${g.id}" data-i="${i}" aria-label="移出这个组">×</button>
    </div>`;
}

// ═════════════════════ 局部重绘 ═════════════════════

/** 在图上涂要重画的地方，写这块画什么，生成后把新图交给 onDone */
function openInpaintEditor(src, { pos = '', neg = '', onDone } = {}) {
    if (N.settings().naiMode === 'tavern') { toastr.warning('「用酒馆里的 key」不能局部重绘，到设置里改成「填我的 key」', '局部重绘'); return; }
    DOC.querySelector('.pc-inpaint')?.remove();
    const box = DOC.createElement('div');
    box.className = 'pc-inpaint pc-modal-backdrop';
    box.innerHTML = `<section class="pc-ip">
      <div class="pc-row-between"><h3 class="pc-h3" style="margin:0">局部重绘</h3><button class="pc-icon-btn" data-ip="close" aria-label="关闭">${ICON.close}</button></div>
      <div class="pc-dim small">用手指涂要重画的地方（红色），其他地方不变。</div>
      <div class="pc-ip-stage"><canvas class="pc-ip-img"></canvas><canvas class="pc-ip-mask"></canvas></div>
      <div class="pc-ip-tools">
        <div class="pc-seg" style="flex:1"><button class="on" data-ip="draw">涂</button><button data-ip="erase">擦</button></div>
        <label class="pc-slider" style="flex:1.4"><span>笔刷</span><input type="range" min="8" max="120" value="40" data-ip-size><b>40</b></label>
        <button class="pc-pill dashed tiny" data-ip="clear">清空</button>
      </div>
      <label class="pc-label">这块要画成什么（写全一点，画师串也带上）</label>
      <textarea class="pc-textarea small mono" data-ip-pos>${esc(pos)}</textarea>
      <label class="pc-label">负面</label>
      <textarea class="pc-textarea tiny mono" data-ip-neg>${esc(neg)}</textarea>
      <label class="pc-slider"><span>改动多少</span><input type="range" min="0.1" max="1" step="0.01" value="0.7" data-ip-str><b>0.70</b></label>
      <div class="pc-hint">越大改得越多。只想修一点点细节用 0.4 左右。</div>
      <button class="pc-btn dark big pc-mt-s" data-ip="go">${seal()}重画涂的地方</button>
    </section>`;
    pcMount(box);
    const imgC = box.querySelector('.pc-ip-img'), maskC = box.querySelector('.pc-ip-mask');
    const img = new Image();
    const data = DOC.createElement('canvas'); // 原图大小的遮罩：白 = 重画
    let mode = 'draw', size = 40, drawing = false, last = null;
    img.onload = () => {
        const W = img.naturalWidth, H = img.naturalHeight;
        for (const c of [imgC, maskC]) { c.width = W; c.height = H; }
        imgC.getContext('2d').drawImage(img, 0, 0);
        data.width = W; data.height = H;
        const dc = data.getContext('2d'); dc.fillStyle = '#000'; dc.fillRect(0, 0, W, H);
    };
    img.src = src;
    const pt = ev => { const r = maskC.getBoundingClientRect(); return { x: (ev.clientX - r.left) * maskC.width / r.width, y: (ev.clientY - r.top) * maskC.height / r.height, k: maskC.width / r.width }; };
    const stroke = (a, b) => {
        const r = size * a.k / 2;
        for (const [ctx, col] of [[maskC.getContext('2d'), 'rgba(220,40,40,.55)'], [data.getContext('2d'), '#fff']]) {
            ctx.save();
            ctx.globalCompositeOperation = mode === 'erase' && ctx.canvas === maskC ? 'destination-out' : 'source-over';
            ctx.strokeStyle = ctx.fillStyle = mode === 'erase' && ctx.canvas === data ? '#000' : col;
            ctx.lineWidth = r * 2; ctx.lineCap = 'round';
            ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
            ctx.restore();
        }
    };
    maskC.addEventListener('pointerdown', ev => { drawing = true; maskC.setPointerCapture(ev.pointerId); last = pt(ev); stroke(last, last); });
    maskC.addEventListener('pointermove', ev => { if (!drawing) return; const p = pt(ev); stroke(last, p); last = p; });
    for (const t of ['pointerup', 'pointercancel']) maskC.addEventListener(t, () => { drawing = false; });
    box.addEventListener('input', ev => {
        const t = ev.target;
        if (t.matches('[data-ip-size]')) { size = Number(t.value); t.nextElementSibling.textContent = t.value; }
        if (t.matches('[data-ip-str]')) t.nextElementSibling.textContent = Number(t.value).toFixed(2);
    });
    box.addEventListener('click', async ev => {
        const el = ev.target.closest('[data-ip]');
        if (!el) return;
        const k = el.dataset.ip;
        if (k === 'close') box.remove();
        if (k === 'draw' || k === 'erase') { mode = k; box.querySelectorAll('[data-ip="draw"],[data-ip="erase"]').forEach(b => b.classList.toggle('on', b === el)); }
        if (k === 'clear') { maskC.getContext('2d').clearRect(0, 0, maskC.width, maskC.height); const dc = data.getContext('2d'); dc.fillStyle = '#000'; dc.fillRect(0, 0, data.width, data.height); }
        if (k === 'go') {
            const mask = alignMask(data);
            if (!mask) { toastr.warning('先涂一下要重画的地方', '局部重绘'); return; }
            el.disabled = true; el.lastChild.textContent = '重画中…';
            try {
                const out = await E.inpaint({
                    image: imgC.toDataURL('image/png'), mask, width: img.naturalWidth, height: img.naturalHeight,
                    pos: box.querySelector('[data-ip-pos]').value, neg: box.querySelector('[data-ip-neg]').value,
                    strength: Number(box.querySelector('[data-ip-str]').value),
                });
                box.remove();
                onDone?.(out);
                toastr.success('重画好了', '局部重绘');
            } catch (e) {
                toastr.error(e.message, '局部重绘失败', { timeOut: 8000 });
                el.disabled = false; el.lastChild.textContent = '重画涂的地方';
            }
        }
    });
}

/** 遮罩按 8 像素对齐（NovelAI 要这样），没涂就返回 null */
function alignMask(src) {
    const W = src.width, H = src.height;
    const s = src.getContext('2d').getImageData(0, 0, W, H).data;
    const out = DOC.createElement('canvas'); out.width = W; out.height = H;
    const oc = out.getContext('2d');
    oc.fillStyle = '#000'; oc.fillRect(0, 0, W, H); oc.fillStyle = '#fff';
    let any = false;
    for (let by = 0; by < H; by += 8) for (let bx = 0; bx < W; bx += 8) {
        let hit = false;
        for (let y = by; y < Math.min(by + 8, H) && !hit; y++) for (let x = bx; x < Math.min(bx + 8, W); x++) { if (s[(y * W + x) * 4] > 128) { hit = true; break; } }
        if (hit) { oc.fillRect(bx, by, 8, 8); any = true; }
    }
    return any ? out.toDataURL('image/png') : null;
}

// ═════════════════════ 服装设计 ═════════════════════

/** 按剧情给角色设计衣服；设计好的可以存进衣柜、生成展示图 */
function openOutfitDesigner({ mesId = null } = {}) {
    const d = getData();
    const cast = C.currentCast();
    if (!cast.length) { toastr.warning('先打开一张角色卡', '服装设计'); return; }
    const picked = new Set(cast.filter(x => x.on && x.group === 'char').map(x => x.key));
    if (!picked.size) cast.filter(x => x.group === 'char').forEach(x => picked.add(x.key));
    let demand = '', busy = false, results = [], err = '';
    DOC.querySelector('.pc-od-back')?.remove();
    const back = DOC.createElement('div');
    back.className = 'pc-sheet-backdrop pc-od-back fresh'; setTimeout(() => back.classList.remove('fresh'), 400);
    const openedAt = Date.now();
    const draw = () => {
        back.innerHTML = `<section class="pc-sheet pc-od">
          <div class="pc-sheet-grip" aria-hidden="true"></div>
          <div class="pc-row-between"><h3 class="pc-h3" style="margin:0">设计服装</h3><button class="pc-icon-btn small" data-od="close" aria-label="关闭">${ICON.close}</button></div>
          <div class="pc-dim small">AI 读${mesId != null ? `第 ${mesId} 楼和前面` : '最近'}的剧情，给选中的角色设计衣服。</div>
          ${label('给谁设计')}
          <div class="pc-chips wrap">${cast.map(x => `<button class="pc-pill ${picked.has(x.key) ? 'on' : 'dashed'}" data-od="who" data-key="${esc(x.key)}">${esc(x.char.name)}</button>`).join('')}</div>
          ${label('想要什么（可不填，不填就按剧情）')}
          <textarea class="pc-textarea small" data-od-demand placeholder="比如：冬天约会穿的、正式晚宴、两人穿情侣装">${esc(demand)}</textarea>
          <button class="pc-btn dark big pc-mt-s" data-od="go" ${busy || !picked.size ? 'disabled' : ''}>${seal()}${busy ? '<span class="pc-busy">AI 设计中</span>' : results.length ? '再设计一次' : '开始设计'}</button>
          ${err ? `<div class="pc-warn">${esc(err)}</div>` : ''}
          ${results.map((r, i) => `<div class="pc-odres">
            <div class="pc-row-between"><b>${esc(r.owner)} · ${esc(r.name)}</b>${r.saved ? '<span class="pc-dim small">✓ 已存进衣柜</span>' : ''}</div>
            <div class="pc-pairs">${r.tags.map(t => `<span class="pc-pair"><span class="mono" style="padding:6px 10px 6px 12px;font-size:13px">${esc(t.en)}${t.zh ? `<em>${esc(t.zh)}</em>` : ''}</span></span>`).join('')}</div>
            <div class="pc-actions wrap">
              ${r.saved ? '' : `<button class="pc-btn" data-od="save" data-i="${i}">存进衣柜</button><button class="pc-btn" data-od="wear" data-i="${i}">存并固定穿</button>`}
              <button class="pc-btn" data-od="img" data-i="${i}" ${r.busy ? 'disabled' : ''}>${r.busy ? '<span class="pc-busy">生成中</span>' : r.image ? '再生成一张' : '生成展示图'}</button>
            </div>
            ${r.image ? `<img class="pc-outimg" src="${esc(r.image)}" alt="" data-od="view" data-src="${esc(r.image)}">` : ''}
          </div>`).join('')}
        </section>`;
    };
    draw();
    pcMount(back);
    const charOf = r => cast.map(x => x.char).find(c => c.name === r.owner) || cast.map(x => x.char).find(c => r.owner.includes(c.name) || c.name.includes(r.owner));
    const saveOne = (r, wear) => {
        const c = charOf(r);
        if (!c) throw new Error(`找不到角色「${r.owner}」`);
        const o = { id: M.uid('o_'), name: r.name || '新衣服', tags: r.tags };
        c.outfits.push(o);
        if (wear) { c.outfitId = o.id; c.outfitMode = 'fixed'; }
        C.saveChar(c);
        r.saved = true;
        return c;
    };
    back.addEventListener('input', ev => { if (ev.target.matches('[data-od-demand]')) demand = ev.target.value; });
    back.addEventListener('click', async ev => {
        if (ev.target === back) { if (Date.now() - openedAt > 400) back.remove(); return; }
        const el = ev.target.closest('[data-od]');
        if (!el) return;
        buzz();
        const k = el.dataset.od;
        const r = results[Number(el.dataset.i)];
        try {
            if (k === 'close') { back.remove(); if (root?.classList.contains('open')) render(); return; }
            if (k === 'view') { openViewer(el.dataset.src); return; }
            if (k === 'who') { const key = el.dataset.key; if (picked.has(key)) picked.delete(key); else picked.add(key); draw(); return; }
            if (k === 'go') {
                busy = true; err = ''; draw();
                const chat = SillyTavern.getContext().chat || [];
                const upTo = mesId != null ? mesId : chat.length - 1;
                const text = chat.slice(Math.max(0, upTo - 7), upTo + 1).filter(m => !m.is_system).map(m => `${m.name}: ${String(m.mes || '').replace(/<[^>]+>/g, '')}`).join('\n\n');
                const chars = cast.filter(x => picked.has(x.key)).map(x => ({ name: x.char.name, appearance: C.tagText(x.char.appearance) }));
                try { results = await T.designOutfitsFromChat(text, chars, demand.trim()); if (!results.length) err = 'AI 没给出能用的衣服，换个说法再试'; }
                catch (e) { err = e.message; }
                busy = false; draw();
                return;
            }
            if (k === 'save' || k === 'wear') { const c = saveOne(r, k === 'wear'); toastr.success(`已存进${c.name}的衣柜${k === 'wear' ? '，并设为固定穿' : ''}`, '服装设计', { timeOut: 2000 }); draw(); return; }
            if (k === 'img') {
                if (!N.isReady()) { toastr.warning('先到设置里填 NovelAI key', '服装设计'); return; }
                const c = charOf(r);
                r.busy = true; draw();
                try {
                    const pos = M.mergeTags(d.active ? M.ticketString(d, d.active) : '', c ? C.tagText(c.appearance) : '1boy', C.tagText(r.tags), 'solo, full body, standing, looking at viewer, simple background, white background');
                    const { positive, negative } = E.composeStudio({ pos, neg: c?.negative || '' });
                    r.image = await E.generateFull({ positive, negative, width: 768, height: 1344, director: c?.charRef ? await E.charRefs([c.charRef]) : undefined });
                } catch (e) { toastr.error(e.message, '生成失败'); }
                r.busy = false; draw();
            }
        } catch (e) { toastr.error(e.message, '服装设计'); }
    });
}

// ═════════════════════ 角色 ═════════════════════

const sw2 = (on, attrs) => `<label class="pc-switch only"><input type="checkbox" ${attrs} ${on ? 'checked' : ''}><span></span></label>`;
const av = (c, cls = 'pc-av') => { const u = C.avatarUrl(c); return `<span class="${cls}">${u ? `<img src="${esc(u)}" alt="" loading="lazy" onerror="this.remove()">` : ''}</span>`; };

const IMG_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="18" height="18"><rect x="3" y="4" width="18" height="16" rx="2.5"/><circle cx="9" cy="10" r="2"/><path d="m21 16-5-5-9 9"/></svg>';
const castTop = () => `<div class="pc-seg"><button class="${ui.castTop !== 'wardrobe' ? 'on' : ''}" data-act="casttop" data-v="chars">角色</button><button class="${ui.castTop === 'wardrobe' ? 'on' : ''}" data-act="casttop" data-v="wardrobe">衣柜 · ${C.wardrobe().length}</button></div>`;

// ───────────── 从穿搭管理器导入（只读它的数据，不改它） ─────────────
const OM_BASE = '/api/plugins/outfit-manager';
const OM_SHARED = '__shared__';
/** 一个分区（User / 某个角色）→ 要导入的衣服列表 */
function omOutfits(part, assets) {
    const accs = Array.isArray(part?.accessories) ? part.accessories : [];
    return (Array.isArray(part?.outfits) ? part.outfits : []).filter(o => o && (o.description || o.imageData || o.name)).map(o => {
        const kits = Array.isArray(o.kits) ? o.kits : [];
        const kit = kits.find(k => k && k.id === o.activeKitId) || kits[0];
        const off = new Set(kit?.disabledAccIds || []);
        const acc = (kit?.accIds || []).filter(id => !off.has(id)).map(id => accs.find(a => a && a.id === id)).filter(Boolean);
        return { id: String(o.id || ''), name: String(o.name || '').trim(), desc: String(o.description || '').trim(), image: omImage(o.imageData, assets), accDescs: acc.map(a => [a.name, a.description].filter(Boolean).join('：')).filter(Boolean) };
    });
}
function omImage(v, assets) {
    v = typeof v === 'string' ? v : '';
    if (!v || v.startsWith('data:')) return v;
    const k = v.startsWith(OM_BASE + '/images/') ? v.slice((OM_BASE + '/images/').length) : '';
    if (k && assets?.[k]) return assets[k];
    return v.startsWith('/') || /^https?:/.test(v) ? v : '';
}
/** 它导出的 .json（完整备份 / 只 User / 单个角色 / 全部角色）→ 分组 */
function omGroupsFromJson(j) {
    if (!j || typeof j !== 'object') throw new Error('不是穿搭管理器导出的文件');
    const assets = j._assets || {};
    const groups = [];
    const add = (label, isUser, part) => { const outfits = omOutfits(part, assets); if (outfits.length) groups.push({ label, isUser, outfits }); };
    if (j.type === 'char') add(String(j.charName || '角色'), false, j);
    else {
        if (j.type !== 'chars_all' && Array.isArray(j.outfits)) add('User', true, j);
        for (const [name, part] of Object.entries(j.chars || {})) add(name === OM_SHARED ? '通用衣柜' : name, false, part);
    }
    if (!groups.length) throw new Error('文件里没有穿搭');
    return groups;
}
/** v2 数据：meta + 分区 → 分组 */
function omGroupsFromParts(meta, getPart) {
    const groups = [];
    const add = (label, isUser, part) => { const outfits = omOutfits(part, {}); if (outfits.length) groups.push({ label, isUser, outfits }); };
    add('User', true, getPart('user:__default__'));
    for (const ci of meta?.charIndex || []) if (ci?.partKey) add(ci.name === OM_SHARED || ci.id === OM_SHARED ? '通用衣柜' : String(ci.name || '角色'), false, getPart(ci.partKey));
    return groups;
}
/** 直接读：先找它的后端，再找浏览器里的 IndexedDB，最后是最老的 localStorage */
async function omReadLocal() {
    try {
        const r = await fetch(OM_BASE + '/partitions/keys', { credentials: 'same-origin' });
        const j = r.ok ? await r.json().catch(() => null) : null;
        if (j?.ok && Array.isArray(j.keys)) {
            const parts = {};
            for (const k of j.keys) {
                const pr = await fetch(OM_BASE + '/partitions/' + encodeURIComponent(k), { credentials: 'same-origin' });
                const pj = pr.ok ? await pr.json().catch(() => null) : null;
                if (pj?.ok && pj.data) parts[k] = pj.data;
            }
            const groups = omGroupsFromParts(parts.meta, k => parts[k]);
            if (groups.length) return groups;
        }
    } catch { /* 没装后端 */ }
    const idb = P.indexedDB || indexedDB;
    try {
        if (idb.databases) { const list = await idb.databases(); if (!list.some(x => x.name === 'outfit_mgr_db')) throw 0; }
        const db = await new Promise((ok, bad) => {
            const req = idb.open('outfit_mgr_db');
            req.onupgradeneeded = e => e.target.transaction.abort(); // 不存在就别新建
            req.onsuccess = () => ok(req.result); req.onerror = () => bad(req.error);
        });
        try {
            if (db.objectStoreNames.contains('data')) {
                const all = await new Promise((ok, bad) => {
                    const st = db.transaction('data', 'readonly').objectStore('data');
                    const out = {}; const cur = st.openCursor();
                    cur.onsuccess = e => { const c = e.target.result; if (c) { out[c.key] = c.value; c.continue(); } else ok(out); };
                    cur.onerror = () => bad(cur.error);
                });
                const groups = all.meta ? omGroupsFromParts(all.meta, k => all[k]) : all.main ? omGroupsFromJson(all.main) : [];
                if (groups.length) return groups;
            }
        } finally { db.close(); }
    } catch { /* 没有 */ }
    try { const raw = (P.localStorage || localStorage).getItem('outfit_mgr_v4'); if (raw) return omGroupsFromJson(JSON.parse(raw)); } catch { /* 没有 */ }
    throw new Error('这个酒馆里没找到穿搭管理器的数据。可以在它里面点「导出」，再选那个 .json 导入');
}
function omDefaultTarget(g, people) {
    if (g.isUser) return C.currentPersonaKey?.() || '';
    return people.find(p => p.name === g.label)?.key || '';
}
function openOmImport() {
    const people = [...C.stCards(), ...C.stPersonas()];
    const box = modal(`<h3 class="pc-h3">从穿搭管理器导入</h3>
      <div class="pc-dim small">只读它的数据，不会改动穿搭管理器。文字描述会用 AI 转成标签。</div>
      <div class="pc-actions wrap pc-mt-s" data-om-src><button class="pc-btn dark" type="button" data-om="local">读这个酒馆里的</button><label class="pc-btn">选导出的 .json<input type="file" accept=".json,application/json" data-om-file hidden></label></div>
      <div data-om-body></div>
      <p class="pc-dim small" data-om-status role="status" aria-live="polite"></p>
      <div class="pc-actions"><button class="pc-btn" type="button" data-om="close">关闭</button><button class="pc-btn dark" type="button" data-om="go" hidden>开始导入</button></div>`);
    box.style.maxHeight = '90dvh'; box.style.overflowY = 'auto';
    const body = box.querySelector('[data-om-body]'), status = box.querySelector('[data-om-status]'), goBtn = box.querySelector('[data-om="go"]');
    let groups = null, running = false, stop = false;
    const say = t => { status.textContent = t; };
    const show = gs => {
        groups = gs;
        const opt = sel => `<option value="" ${!sel ? 'selected' : ''}>只存进衣柜</option>` + people.map(p => `<option value="${esc(p.key)}" ${p.key === sel ? 'selected' : ''}>给${esc(p.name)}${p.kind === 'user' ? '（人设）' : ''}</option>`).join('');
        body.innerHTML = `<div class="pc-mt-s">${gs.map((g, i) => `<div class="pc-om-row"><label class="pc-switch"><input type="checkbox" data-om-on="${i}" checked><span></span><b>${esc(g.label)}</b><i class="pc-dim" style="font-style:normal;font-size:12px">${g.outfits.length} 套</i></label>
          <select class="pc-mini-select" data-om-to="${i}">${opt(omDefaultTarget(g, people))}</select></div>`).join('')}</div>
          <label class="pc-switch"><input type="checkbox" data-om-vision ${T.currentApi ? 'checked' : ''}><span></span>只有图没写描述的，用 AI 看图<small>要能识图的模型</small></label>`;
        goBtn.hidden = false;
        say(`找到 ${gs.reduce((a, g) => a + g.outfits.length, 0)} 套。选好给谁，点「开始导入」。`);
    };
    box.addEventListener('click', async ev => {
        const act = ev.target.closest('[data-om]')?.dataset.om;
        if (act === 'close') { if (running) { stop = true; say('正在停…'); } else box.closeModal(); }
        if (act === 'local' && !running) { say('正在找…'); try { show(await omReadLocal()); } catch (e) { say(e.message); } }
        if (act === 'go' && !running && groups) await run();
    });
    box.querySelector('[data-om-file]').addEventListener('change', async ev => {
        const f = ev.target.files[0]; ev.target.value = '';
        if (!f || running) return;
        try { show(omGroupsFromJson(JSON.parse(await f.text()))); } catch (e) { say('读不了：' + e.message); }
    });
    async function run() {
        const d = getData();
        const vision = !!box.querySelector('[data-om-vision]')?.checked;
        const jobs = [];
        groups.forEach((g, i) => { if (box.querySelector(`[data-om-on="${i}"]`)?.checked) for (const o of g.outfits) jobs.push({ o, to: box.querySelector(`[data-om-to="${i}"]`)?.value || '' }); });
        if (!jobs.length) { say('一组都没选'); return; }
        running = true; stop = false; goBtn.disabled = true;
        box.querySelectorAll('[data-om-src] button, [data-om-src] input, [data-om-on], [data-om-to], [data-om-vision]').forEach(x => { x.disabled = true; });
        const seen = new Set([...C.wardrobe().map(x => x.o.from).filter(Boolean)]);
        let done = 0, skipped = 0, noTags = 0;
        for (let n = 0; n < jobs.length && !stop; n++) {
            const { o, to } = jobs[n];
            const from = 'om:' + o.id;
            if (o.id && seen.has(from)) { skipped++; continue; }
            say(`正在导入 ${n + 1}/${jobs.length}：${o.name || '没名字的穿搭'}`);
            let tags = [], image = '', name = o.name;
            let du = '';
            if (o.image) { try { du = o.image.startsWith('data:') ? o.image : await urlToDataUrl(o.image); } catch { du = ''; } }
            try {
                if (o.desc || o.accDescs.length) tags = await T.outfitFromText(o.name, o.desc, o.accDescs);
                else if (du && vision) { const r = await T.outfitFromImage(await shrinkDataUrl(du, 1024, 0.88)); tags = r.tags; name ||= r.name; }
            } catch (e) { console.warn('[智库] 穿搭管理器导入：转标签失败', e); }
            if (du) { try { image = (await uploadImage(await shrinkDataUrl(du, 768), `outfit_${M.uid('')}`)).path; } catch { image = ''; } }
            if (!tags.length) noTags++;
            const out = { id: M.uid('o_'), name: (name || '导入的穿搭').slice(0, 20), tags, ...(image ? { image } : {}), from, ...(o.desc ? { note: o.desc.slice(0, 2000) } : {}) };
            if (to) { const c = C.getChar(to); if (c) { c.outfits.push(out); if (!c.outfitId) c.outfitId = out.id; C.saveChar(c); } else d.outfits[out.id] = out; }
            else d.outfits[out.id] = out;
            seen.add(from); done++;
            commit({ silent: true });
        }
        running = false; goBtn.disabled = false;
        commit();
        say(`${stop ? '停了。' : '好了。'}导入 ${done} 套${skipped ? `，${skipped} 套以前导过、跳过了` : ''}${noTags ? `，${noTags} 套没转出标签（AI 没接上或只有图），打开改一下` : ''}。`);
        goBtn.hidden = true;
        ui.view = 'cast'; ui.castTop = 'wardrobe'; ui.wardFilter = 'all';
        render();
    }
}

function viewWardrobe(d) {
    const all = C.wardrobeGroups();
    const owners = [...new Map(all.flatMap(g => g.holders).filter(x => x.owner).map(x => [x.owner.key, x.owner])).values()];
    const q = ui.wardSearch.trim().toLowerCase();
    const list = all.filter(x => (ui.wardFilter === 'all' || (ui.wardFilter === 'none' ? !x.owner : x.holders.some(h => h.owner?.key === ui.wardFilter)))
        && (!q || (x.o.name + ' ' + C.tagText(x.o.tags) + ' ' + x.o.tags.map(t => t.zh).join(' ')).toLowerCase().includes(q)));
    return `${castTop()}
    <div class="pc-outmake">
      <label class="pc-btn dark">${IMG_ICON} 图片<input type="file" accept="image/*" data-wardimg hidden></label>
      <button class="pc-btn" data-act="wardai">✦ AI 设计</button>
      <button class="pc-btn" data-act="wardnew">＋ 自己写</button>
      <button class="pc-btn" data-act="omimport">从穿搭管理器导入</button>
    </div>
    <label class="pc-search pc-mt-s"><span class="pc-sr">搜索</span>${ICON.search}<input data-bind="wardSearch" value="${esc(ui.wardSearch)}" placeholder="搜衣服名、标签"></label>
    <div class="pc-chips">${[['all', '全部'], ...owners.map(c => [c.key, c.name]), ['none', '没给谁穿']].map(([k, t]) => `<button class="pc-pill ${ui.wardFilter === k ? 'on' : 'dashed'}" data-act="wardfilter" data-v="${esc(k)}">${esc(t)}</button>`).join('')}</div>
    <div class="pc-grid2 pc-mt-s">${list.map(({ o, owner, holders }) => `<article class="pc-ticket" data-act="openoutfit" data-owner="${esc(owner?.key || '')}" data-id="${esc(o.id)}">
        <div class="pc-ticket-img">${o.image ? `<img src="${esc(o.image.startsWith('data:') ? o.image : '/' + o.image.replace(/^\/+/, ''))}" loading="lazy" alt="">` : '<span>还没有图</span>'}</div>
        <div class="pc-ticket-text"><b>${esc(o.name)}</b><small>${o.tags.length} 个标签</small><span class="pc-state ${owner ? '' : 'todo'}">${owner ? '穿在：' + esc(holders.map(h => h.owner.name).join('、')) : '还没给谁穿'}</span></div></article>`).join('')
        || empty('衣柜是空的', '点上面「图片」放一张图，AI 会把衣服写成标签；也可以让 AI 设计，或者自己写。')}</div>
    <div style="height:24px"></div>`;
}

/** 一套衣服的页面（新的草稿也用这页） */
function viewOutfit(d) {
    const u = ui.outfit;
    if (!u) { ui.view = 'cast'; return viewCast(d); }
    const hit = u.draft ? null : C.findOutfit(u.owner, u.id);
    if (!u.draft && !hit) { ui.view = 'cast'; return viewCast(d); }
    const o = u.draft ? u : hit.o;
    const owner = hit?.owner || null;
    const img = o.image ? (o.image.startsWith('data:') ? o.image : '/' + o.image.replace(/^\/+/, '')) : '';
    const cast = C.currentCast().filter(x => x.char.kind !== 'user' || true).map(x => x.char);
    const people = [...new Map([...cast, ...Object.values(d.characters)].map(c => [c.key, c])).values()];
    const holders = !u.draft && owner ? C.outfitHolders(o).map(x => x.owner) : [];
    return `
    <div class="pc-dhead"><button class="pc-round" data-act="outback" aria-label="返回">‹</button>
      <input class="pc-dtitle" data-outname value="${esc(o.name)}" placeholder="给这套衣服起个名字"></div>
    <div class="pc-outhero">${img ? `<img src="${esc(img)}" alt="" data-act="viewimg" data-src="${esc(img)}">` : '<span>还没有图</span>'}
      ${u.busy === 'read' ? '<em class="pc-outhero-busy"><span class="pc-busy">AI 正在看图</span></em>' : ''}
      <label class="pc-outhero-btn">换一张<input type="file" accept="image/*" data-outimg hidden></label></div>
    ${u.draft ? (() => { const n = [img || o.tags.length, o.tags.length, u.destChosen || u.dest].filter(Boolean).length; return fold('outsteps', '怎么做', n ? `三步做完 ${n} 步` : '放图或打字 → 检查标签 → 选存到哪里', `<div class="pc-outsteps">
      <span class="${img || o.tags.length ? 'done' : ''}"><b>第一步</b>点图片右下「换一张」放一张衣服的图，AI 会写成标签；没图就直接在下面打字加</span>
      <span class="${o.tags.length ? 'done' : ''}"><b>第二步</b>看看下面的标签：点一下改、× 删掉、↓↑ 在整体和配饰之间挪</span>
      <span class="${u.destChosen || u.dest ? 'done' : ''}"><b>第三步</b>选「存到哪里」：只进衣柜，或者直接给某个人穿，再点「保存」</span></div>`); })() : ''}
    <section class="pc-card pc-pad pc-mt">
      <div class="pc-row-between"><b>${o.tags.length ? `${o.tags.length} 件` : '还没有标签'}</b>${o.tags.length ? `<button class="pc-pill dashed tiny" data-act="copytext" data-text="${esc(C.tagText(o.tags))}">复制整套</button>` : ''}</div>
      ${outfitSections(o.tags, 'ward', { busy: u.busy === 'add', busyKey: u.addKey })}
    </section>
    <section class="pc-card pc-pad pc-mt">
      <b>${u.draft ? '存到哪里' : holders.length ? '谁在穿' : '给谁穿'}</b>
      ${holders.length ? `<div class="pc-chips wrap">${holders.map(h => `<button class="pc-pill on" data-act="outtakeoff" data-v="${esc(h.key)}" title="从${esc(h.name)}身上拿掉">${esc(h.name)} ×</button>`).join('')}</div><div class="pc-dim small">点名字 × 从他身上拿掉（衣柜里还在）。下面点名字再给别人穿，几个人穿的是同一套，改了一起变。</div>${label('再给谁穿')}` : ''}
      <div class="pc-chips wrap">${u.draft ? `<button class="pc-pill ${!u.dest ? 'on' : 'dashed'}" data-act="outdest" data-v="">只存进衣柜</button>` : ''}
        ${people.filter(c => c.key !== owner?.key && !holders.some(h => h.key === c.key)).map(c => `<button class="pc-pill ${u.dest === c.key ? 'on' : 'dashed'}" data-act="${u.draft ? 'outdest' : 'outgive'}" data-v="${esc(c.key)}">${u.draft ? '给' : ''}${esc(c.name)}${u.draft ? '穿' : ''}</button>`).join('') || '<span class="pc-dim small">「角色」里还没有角色</span>'}</div>
      ${!u.draft && !holders.length ? '<div class="pc-dim small">点名字：给他穿，并设为他固定穿的衣服。</div>' : ''}
    </section>
    ${u.draft ? `<button class="pc-btn dark big pc-mt" data-act="outsave" ${o.tags.length ? '' : 'disabled'}>${seal()}保存</button>${o.tags.length ? '' : '<div class="pc-dim small pc-center" style="margin-top:6px">至少要有一件衣服才能保存</div>'}` : ''}
    <button class="pc-btn pc-mt-s wide" data-act="outimggen" ${u.busy ? 'disabled' : ''}>${u.busy === 'gen' ? '<span class="pc-busy">生成中</span>' : u.draft ? '先生成一张看看' : '生成展示图'}</button>
    ${!u.draft ? `<div class="pc-center pc-mt"><button class="pc-pill dashed tiny" data-act="outshare">分享</button> <button class="pc-linkdanger" style="margin:0 0 0 12px" data-act="outdel">${holders.length > 1 ? '删掉这套（所有人身上的都删）' : '删掉这套'}</button></div>` : ''}
    <div style="height:24px"></div>`;
}

function viewCast(d) {
    if (ui.castTop === 'wardrobe') return viewWardrobe(d);
    const cast = C.currentCast();
    const users = cast.filter(x => x.group === 'user'), chars = cast.filter(x => x.group === 'char');
    const row = x => `<div class="pc-who">
        <button class="pc-who-main" data-act="openchar" data-key="${esc(x.key)}">${av(x.char)}<span class="pc-grow"><b>${esc(x.char.name)}${x.char.kind === 'side' ? '<em class="pc-badge-s">卡里的配角</em>' : ''}</b>
        <small>${x.char.appearance.length ? esc(C.tagText(x.char.appearance)) + ' · ' + (x.char.outfitMode === 'fixed' ? '衣服固定：' + esc(C.currentOutfit(x.char)?.name || '') : '衣服跟剧情') : '还没写外貌，点这里写'}</small></span></button>
        ${sw2(x.on, `data-cast="${esc(x.key)}"`)}</div>`;
    const list = (ui.castTab === 'user' ? C.stPersonas() : ui.castTab === 'free' ? C.freeChars() : C.stCards()).filter(c => !ui.castSearch || c.name.toLowerCase().includes(ui.castSearch.toLowerCase()));
    const card = src => {
        const c = C.getChar(src.key);
        const side = src.kind === 'char' ? C.sideKicks(src.avatar).length : 0;
        if (src.kind === 'free') return `<article class="pc-ticket" data-act="openchar" data-key="${esc(src.key)}">
          <div class="pc-ticket-img">${c.image ? `<img src="${esc(c.image)}" loading="lazy" alt="" onerror="this.remove()">` : '<span>没有图</span>'}</div>
          <div class="pc-ticket-text"><b>${esc(src.name)}</b><span class="pc-state">${C.currentCast().some(x => x.key === src.key) ? '在这次聊天里' : '没绑定角色卡'}</span></div></article>`;
        const ok = c.appearance.length > 0;
        return `<article class="pc-ticket" data-act="openchar" data-key="${esc(src.key)}">
          <div class="pc-ticket-img">${C.avatarUrl(c) ? `<img src="${esc(C.avatarUrl(c))}" loading="lazy" alt="" onerror="this.remove()">` : ''}</div>
          <div class="pc-ticket-text"><b>${esc(src.name)}</b><span class="pc-state ${ok ? '' : 'todo'}">${ok ? '外貌已写' + (side ? ` · ${side} 个配角` : '') : '还没写外貌，点一下写'}</span></div></article>`;
    };
    return `${castTop()}
    <section class="pc-card pc-pad pc-mt">
      <h2 class="pc-h2" style="margin:0">这次聊天</h2>
      <div class="pc-dim small">自动读取当前的角色卡和人设。开着的，聊天里生图时会带上。</div>
      ${users.length ? `<div class="pc-grouplbl">我（user）</div>${users.map(row).join('')}` : ''}
      <div class="pc-grouplbl">角色（char）</div>
      ${chars.map(row).join('') || '<div class="pc-dim small">现在没有打开角色卡</div>'}
      <div class="pc-actions wrap">
        ${chars.length ? `<button class="pc-pill dashed tiny" data-act="addside">＋ 加配角</button>` : ''}
        <button class="pc-pill dashed tiny" data-act="castpreview">查看候选角色外貌</button>
      </div>
      ${chars.length ? '<button class="pc-btn dark pc-mt-s" data-act="outdesign" style="width:100%">✦ 按剧情设计服装</button>' : ''}
      ${ui.castPreview ? `<div class="pc-mt-s">${C.previewCast().map(p => `<div class="pc-label">${esc(p.name)}${p.story ? '（衣服由 AI 按剧情写）' : ''}</div><p class="pc-quote small mono">${esc(p.tags) || '（没有外貌）'}</p>`).join('') || '<div class="pc-dim small">没有开着的角色</div>'}
        <div class="pc-hint">这里是可调用的角色库。每张图只带该图角色标记指定的人，再结合画师串、场景动作和质量词。</div></div>` : ''}
    </section>
    <section class="pc-card pc-pad pc-mt">
      <div class="pc-row-between"><b>本聊天角色</b><button class="pc-pill dashed tiny" data-act="openchatlib">管理</button></div>
      <div class="pc-dim small">AI 用 &lt;人物&gt; 建档、&lt;外貌变化&gt; 改档，按楼层生效；这里是最新状态。全局角色对 AI 只读。</div>
    </section>
    <div class="pc-seg three pc-mt">
      <button class="${ui.castTab === 'char' ? 'on' : ''}" data-act="casttab" data-tab="char">角色卡（char）· ${C.stCards().length}</button>
      <button class="${ui.castTab === 'user' ? 'on' : ''}" data-act="casttab" data-tab="user">人设（user）· ${C.stPersonas().length}</button>
      <button class="${ui.castTab === 'free' ? 'on' : ''}" data-act="casttab" data-tab="free">存下的 · ${C.freeChars().length}</button>
    </div>
    <label class="pc-search pc-mt-s"><span class="pc-sr">搜索</span>${ICON.search}<input data-bind="castSearch" value="${esc(ui.castSearch)}" placeholder="搜角色名"></label>
    <div class="pc-grid2 pc-mt-s">${list.map(card).join('') || empty('这里是空的', ui.castTab === 'user' ? '酒馆里还没有人设' : '酒馆里还没有角色卡')}</div>
    <div style="height:24px"></div>`;
}

/** 配饰：眼镜、首饰、帽子、发饰这类。没手动分过的按词猜 */
const ACC_RE = /(glasses|eyewear|monocle|goggles|earring|piercing|necklace|pendant|choker|bracelet|wristband|wristwatch|\bwatch\b|\brings?\b|anklet|brooch|jewelry|\bhat\b|\bcap\b|beret|beanie|crown|tiara|veil|hairclip|hairpin|hair ornament|hair ribbon|hair bow|hairband|headband|scrunchie|\bbow\b|ribbon|scarf|gloves?|mittens|\bbag\b|handbag|backpack|\bbelt\b|bandana|\bmask\b|eyepatch|flower|corsage|tie clip|cufflinks|眼镜|耳钉|耳环|耳饰|项链|吊坠|颈圈|手链|手环|手表|戒指|脚链|胸针|首饰|帽|皇冠|头纱|发夹|发卡|发饰|发带|头箍|蝴蝶结|丝带|围巾|手套|包|腰带|面具|眼罩)/i;
const isAcc = p => p.acc ?? ACC_RE.test(`${p.en} ${p.zh || ''}`);
/** 一套衣服：整体和配饰分开显示，下标仍是原列表里的 */
function outfitSections(list, where, { busy = false, busyKey = '', disabled = '' } = {}) {
    const chips = acc => list.map((t, i) => [t, i]).filter(([t]) => isAcc(t) === acc).map(([t, i]) => `<span class="pc-pair"><button data-act="editpair" data-where="${where}" data-i="${i}"><span class="mono">${esc(t.en)}</span>${t.zh ? `<em>${esc(t.zh)}</em>` : ''}</button><button class="pc-pair-x" data-act="movepair" data-where="${where}" data-i="${i}" aria-label="${acc ? '移到整体' : '移到配饰'}" title="${acc ? '移到整体' : '移到配饰'}">${acc ? '↑' : '↓'}</button><button class="pc-pair-x" data-act="delpair" data-where="${where}" data-i="${i}" aria-label="删掉">×</button></span>`).join('');
    const row = (acc, ph) => { const k = where + (acc ? 'acc' : ''); return `<div class="pc-addrow"><textarea rows="1" data-bind="addText.${k}" placeholder="${ph}" data-enter="addpair-${k}">${esc(ui.addText[k] || '')}</textarea><button class="pc-btn dark" data-act="addpair" data-where="${k}" ${disabled}>${busy && busyKey === k ? '…' : '加'}</button></div>`; };
    const n = list.filter(t => !isAcc(t)).length, m = list.length - n;
    return `<div class="pc-outsec"><div class="pc-outsec-h"><b>整体</b><small>${n ? n + ' 件' : '上衣、裤裙、鞋袜、外套'}</small></div>
        <div class="pc-pairs">${chips(false) || '<span class="pc-dim small">还没有</span>'}</div>
        ${row(false, '加一件，或整套粘贴进来，配饰会自动分到下面')}</div>
      <div class="pc-outsec"><div class="pc-outsec-h"><b>配饰</b><small>${m ? m + ' 件' : '眼镜、首饰、帽子、发饰、包'}</small></div>
        <div class="pc-pairs">${chips(true) || '<span class="pc-dim small">还没有</span>'}</div>
        ${row(true, '加配饰，比如：黑框眼镜、银耳钉')}</div>
      <div class="pc-dim small">点标签改，↓↑ 换到另一栏，× 删掉</div>`;
}
/** 往一套里加：配饰栏加的都算配饰；整体栏加的按词猜，猜成配饰的会自动分过去 */
function addToOutfit(list, pairs, toAcc) {
    for (const p of pairs) {
        if (toAcc) p.acc = true;
        const old = list.find(x => x.en.toLowerCase() === p.en.toLowerCase());
        if (old) { if (toAcc) old.acc = true; } else list.push(p);
    }
}
function newOutfitBox(defName) {
    return new Promise(resolve => {
        const box = modal(`<h3 class="pc-h3">自己写一套</h3>
          <label class="pc-field"><span>整套衣服（整套粘贴也行，逗号、换行隔开，中文也行）</span><textarea class="pc-textarea" data-v placeholder="white shirt, navy blazer, red necktie, black pants, loafers, 黑框眼镜"></textarea></label>
          <label class="pc-field"><span>名字（可以不填）</span><input class="pc-input" data-n placeholder="${esc(defName)}"></label>
          <div class="pc-dim small">配饰会自动分出来，建好后还能改。</div>
          <div class="pc-actions"><button class="pc-btn" data-m="no">算了</button><button class="pc-btn dark" data-m="ok">建好</button></div>`);
        const done = v => { box.closeModal(); resolve(v); };
        box.addEventListener('click', ev => { const m = ev.target.closest('[data-m]')?.dataset.m; if (m === 'ok') done({ text: box.querySelector('[data-v]').value.trim(), name: box.querySelector('[data-n]').value.trim() || defName }); if (m === 'no') done(null); });
        box.parentElement.addEventListener('click', ev => { if (ev.target === box.parentElement) resolve(null); });
    });
}

/** 一个角色的全部标签：外貌 + 每一套衣服 */
const charPairs = c => [...(c.appearance || []), ...(c.nsfwBody || []), ...(c.outfits || []).flatMap(o => o.tags || [])];
/** 给没有中文的标签补上中文；quiet 时出错不弹窗 */
async function fillZh(c, { quiet = false } = {}) {
    const need = charPairs(c).filter(t => t.en && !t.zh).map(t => ({ tag: t, en: t.en }));
    if (!need.length) return 0;
    const map = await T.zhForTags(need.map(t => t.en)).catch(e => { if (!quiet) throw e; return {}; });
    if (getData().characters[c.key] !== c) return 0;
    const current = new Set(charPairs(c));
    let n = 0;
    for (const { tag: t, en } of need) { const z = map[en.toLowerCase()]; if (z && current.has(t) && t.en === en && !t.zh) { t.zh = z; n++; } }
    return n;
}
function pairChips(list, where) {
    return list.map((t, i) => `<span class="pc-pair"><button data-act="editpair" data-where="${where}" data-i="${i}"><span class="mono">${esc(t.en)}</span>${t.zh ? `<em>${esc(t.zh)}</em>` : ''}</button><button class="pc-pair-x" data-act="delpair" data-where="${where}" data-i="${i}" aria-label="删掉">×</button></span>`).join('');
}

function viewCharEdit(d) {
    const c = C.getChar(ui.charKey);
    if (!c) { ui.view = 'cast'; return viewCast(d); }
    const card = c.kind === 'side' ? c.card : c.kind === 'char' ? c.avatar : '';
    const family = card ? [C.getChar('char:' + card), ...C.sideKicks(card)].filter(Boolean) : [];
    const out = C.currentOutfit(c);
    const castRow = C.currentCast().find(x => x.key === c.key);
    const busy = ui.charBusy;
    return `
    <div class="pc-dhead"><button class="pc-round" data-act="nav" data-view="cast" aria-label="返回">‹</button>${av(c, 'pc-av big')}
      <div class="pc-grow"><h2 class="pc-dtitle">${esc(c.name)}</h2><div class="pc-tip" style="margin:0">${c.kind === 'user' ? '我的人设（user）' : c.kind === 'free' ? '存下的角色（没绑定角色卡）' : '角色卡（char）'}${c.kind === 'side' ? ' · 卡里的配角' : ''}</div></div></div>
    ${c.kind === 'free' ? `<div class="pc-chips wrap"><button class="pc-pill ${castRow ? 'on' : 'dashed'}" data-act="freecast">${castRow ? '✓ 在这次聊天里' : '＋ 加到这次聊天'}</button><button class="pc-pill dashed" data-act="copylook">套用到角色卡…</button><button class="pc-pill dashed" data-act="renamefree">改名</button></div>` : ''}
    ${c.kind !== 'free' && (family.length > 1 || c.kind !== 'user') ? `<div class="pc-chips">${family.map(f => `<button class="pc-pill ${f.key === c.key ? 'on' : 'dashed'}" data-act="openchar" data-key="${esc(f.key)}">${esc(f.name)}${f.kind === 'side' ? '（配角）' : ''}</button>`).join('')}${card ? '<button class="pc-pill dashed" data-act="addside">＋ 配角</button>' : ''}</div>` : ''}

    <section class="pc-card pc-pad pc-mt">
      <div class="pc-row-between"><b>固定外貌</b><span class="pc-chips" style="margin:0">${c.kind !== 'free' ? `<button class="pc-pill dashed tiny" data-act="readcard" ${busy ? 'disabled' : ''}>${busy === 'read' ? '读取中…' : c.kind === 'user' ? '从人设读' : c.kind === 'side' ? '从卡和世界书读' : '从角色卡读'}</button>` : ''}<label class="pc-pill dashed tiny">${busy === 'look' ? '<span class="pc-busy">看图中</span>' : '从图片读'}<input type="file" accept="image/*" data-lookimg hidden></label></span></div>
      <div class="pc-dim small">头发、眼睛、脸、身材这类不会变的。第一个写 1boy 或 1girl。点标签可以改，× 删掉。</div>
      ${c.kind === 'char' || c.kind === 'side' ? `<button class="pc-pill dashed tiny pc-mt-s" data-act="readcast" ${busy ? 'disabled' : ''}>${busy === 'cast' ? '<span class="pc-busy">读取中</span>' : '读出这张卡里所有人（含世界书）'}</button><button class="pc-pill dashed tiny pc-mt-s" style="margin-left:6px" data-act="readchatcast" ${busy ? 'disabled' : ''}>${busy === 'chatcast' ? '<span class="pc-busy">读取中</span>' : '从聊天正文读出人物（最近 40 楼）'}</button>` : ''}
      <label class="pc-field pc-mt-s"><span>别名（逗号隔开）· 图片角色标记可使用名字或别名</span><input data-charalias value="${esc(c.aliases || '')}" placeholder="比如 小秋，秋秋"></label>
      <label class="pc-field"><span>描述（英文自然语言，可空）</span><textarea class="pc-textarea mono" data-charnl rows="2" placeholder="a girl with long black hair and blue eyes">${esc(c.nl || '')}</textarea></label>
      <div class="pc-hint">描述接在这个角色的外貌标签后面，作为分角色提示词的自然语言补充（NovelAI 4.5 / v4.5 分人物时用）。</div>
      ${(() => { const n = charPairs(c).filter(t => !t.zh).length; return n ? `<div class="pc-chips wrap"><button class="pc-pill dashed tiny" data-act="zhtags" ${busy ? 'disabled' : ''}>${busy === 'zh' ? '<span class="pc-busy">翻译中</span>' : `译成中文 · ${n} 个没有中文`}</button></div>` : ''; })()}
      <div class="pc-pairs">${pairChips(c.appearance, 'app') || '<span class="pc-dim small">还没有</span>'}</div>
      <div class="pc-addrow"><textarea rows="1" data-bind="addText.app" placeholder="自己加，中文也行，可以一次粘贴好几个" data-enter="addpair-app">${esc(ui.addText.app)}</textarea><button class="pc-btn dark" data-act="addpair" data-where="app" ${busy ? 'disabled' : ''}>${busy === 'app' ? '…' : '加'}</button></div>
    </section>

    <section class="pc-card pc-pad pc-mt">
      <div class="pc-row-between"><b>NSFW 身体</b><span class="pc-dim small">只在 NSFW 图里发</span></div>
      <div class="pc-dim small">脱了衣服才看得到的：乳头、阴毛、私处这类。只有这张图是 NSFW（标记里带 nsfw、提示词里有 nsfw）时才加进去，SFW 的图不会发。读卡时 AI 会给成年角色顺便写上。</div>
      <div class="pc-pairs">${pairChips(c.nsfwBody || [], 'nsfw') || '<span class="pc-dim small">还没有</span>'}</div>
      <div class="pc-addrow"><textarea rows="1" data-bind="addText.nsfw" placeholder="自己加，比如 pink nipples, pubic hair，中文也行" data-enter="addpair-nsfw">${esc(ui.addText.nsfw || '')}</textarea><button class="pc-btn dark" data-act="addpair" data-where="nsfw" ${busy ? 'disabled' : ''}>${busy === 'nsfw' ? '…' : '加'}</button></div>
    </section>

    <section class="pc-card pc-pad pc-mt">
      <b>衣服</b>
      <div class="pc-seg pc-mt-s"><button class="${c.outfitMode === 'story' ? 'on' : ''}" data-act="outmode" data-v="story">跟剧情（AI 决定）</button><button class="${c.outfitMode === 'fixed' ? 'on' : ''}" data-act="outmode" data-v="fixed">固定穿一套</button></div>
      <div class="pc-dim small pc-mt-s">${c.outfitMode === 'fixed' ? '聊天生图时一直穿下面选中的这套。' : '聊天生图时 AI 按剧情决定穿什么。下面的衣柜照样能存衣服，想固定时直接选。'}</div>
      ${label('衣柜')}
      <div class="pc-chips wrap">${c.outfits.map(o => `<button class="pc-pill ${o.id === out?.id ? 'on' : 'dashed'}" data-act="pickout" data-id="${o.id}">${esc(o.name)}</button>`).join('') || '<span class="pc-dim small">还没有衣服</span>'}</div>
      <div class="pc-outmake">
        <button class="pc-btn" data-act="newout">＋ 自己写一套</button>
        <button class="pc-btn" data-act="aiout" ${busy ? 'disabled' : ''}>${busy === 'aiout' ? '<span class="pc-busy">AI 设计中</span>' : '✦ 让 AI 设计一套'}</button>
        ${c.kind !== 'user' ? `<button class="pc-btn" data-act="storyout" ${busy ? 'disabled' : ''}>${busy === 'storyout' ? '<span class="pc-busy">读剧情中</span>' : '从剧情里读现在穿的'}</button>` : ''}
      </div>
      ${out ? `<div class="pc-outbox">
        <div class="pc-row-between" style="flex-wrap:wrap;gap:6px"><b>${esc(out.name)}</b><span class="pc-chips wrap" style="margin:0">${out.tags.length ? `<button class="pc-pill dashed tiny" data-act="copytext" data-text="${esc(C.tagText(out.tags))}">复制整套</button>` : ''}<button class="pc-pill dashed tiny" data-act="renameout">改名</button><button class="pc-pill dashed tiny" data-act="shareout">分享</button><button class="pc-pill dashed tiny danger" data-act="delout">删掉</button></span></div>
        ${ui.outEditOpen || !out.tags.length ? `${outfitSections(out.tags, 'out', { busy: !!busy, busyKey: busy, disabled: busy ? 'disabled' : '' })}${out.tags.length ? '<button class="pc-pill dashed tiny pc-mt-s" data-act="outedittoggle">收起标签</button>' : ''}`
          : `<button class="pc-outfold" data-act="outedittoggle"><span class="pc-dim small">${out.tags.length} 件：</span><span class="mono small">${esc(C.tagText(out.tags.slice(0, 8)))}${out.tags.length > 8 ? ' …' : ''}</span><em>展开编辑 ›</em></button>`}
        <button class="pc-btn pc-mt-s" data-act="outtest" ${busy ? 'disabled' : ''}>${busy === 'outtest' ? '<span class="pc-busy">生成中</span>' : '穿这套生成一张看看'}</button>
        ${ui.outTestImg ? `<img class="pc-outimg" src="${esc(ui.outTestImg)}" alt="" data-act="viewimg" data-src="${esc(ui.outTestImg)}">` : ''}
      </div>` : ''}
    </section>

    <section class="pc-card pc-pad pc-mt">
      <b>长相参考</b>
      <div class="pc-dim small">绑一组角色参考图，聊天生图带上${esc(c.name)}时，就照着这组图画出同一个人。只有 NAI 4.5 能用；用上时那张图不加氛围（NovelAI 不能两个一起用）。</div>
      ${!N.charRefSupported() ? '<div class="pc-warn pc-mt-s">现在用不了：要选 NAI 4.5 模型，而且不能是「用酒馆里的 key」。</div>' : ''}
      ${(() => {
        const g = c.charRef && d.charRefGroups?.[c.charRef];
        const TYPES = [['character', '只参考长相'], ['both', '长相和画风'], ['style', '只参考画风']];
        return `<div class="pc-chips wrap"><button class="pc-pill ${!g ? 'on' : 'dashed'}" data-act="charrefpick" data-id="">不用</button>${Object.values(d.charRefGroups || {}).map(x => `<button class="pc-pill ${g && g.id === x.id ? 'on' : 'dashed'}" data-act="charrefpick" data-id="${x.id}" data-lp="crgroup">${esc(x.name)}</button>`).join('')}
        <label class="pc-pill dashed">＋ 新的一组<input type="file" accept="image/*" data-charrefup hidden></label></div>
        ${g ? `<div class="pc-row-between pc-mt-s"><span class="pc-dim small">「${esc(g.name)}」· ${g.refs.length} 张</span><label class="pc-pill dashed tiny">＋ 加图<input type="file" accept="image/*" multiple data-cradd="${g.id}" hidden></label></div>
        ${g.refs.map((r, i) => `<div class="pc-vrow"><div class="pc-vthumb"><img src="${esc('/' + r.path)}" alt=""></div>
          <div class="pc-grow"><div class="pc-row-between"><select class="pc-mini-select" data-crtype="${g.id}:${i}">${TYPES.map(([v, t]) => `<option value="${v}" ${v === (r.type || 'character') ? 'selected' : ''}>${t}</option>`).join('')}</select><button class="pc-x" data-act="crdel" data-g="${g.id}" data-i="${i}" aria-label="删掉">×</button></div>
          <label class="pc-slider"><span>像不像</span><input type="range" min="0" max="1" step="0.01" value="${Number(r.strength ?? 0.6)}" data-crstr="${g.id}:${i}"><b>${Number(r.strength ?? 0.6).toFixed(2)}</b></label></div></div>`).join('') || '<div class="pc-dim small pc-mt-s">这组还没有图，点「＋ 加图」。最好是单人、看得清脸和衣服。</div>'}
        <div class="pc-hint">「像不像」越大越像参考图，太大会不听提示词，一般 0.5 到 0.8。长按组名可以改名或删除。</div>` : ''}`;
      })()}
    </section>

    ${castRow ? `<section class="pc-card pc-pad pc-mt"><div class="pc-row-between"><b>这次聊天</b>${sw2(castRow.on, `data-cast="${esc(c.key)}"`)}</div><div class="pc-dim small">开着 = 允许图片角色标记调用${esc(c.name)}的外貌和参考图</div></section>` : ''}

    <details class="pc-fold"><summary><b>不想出现的</b><i>${esc(c.negative) || '这个角色专用的负面词'}</i></summary><div class="pc-fold-in">
      <textarea class="pc-textarea small mono" data-charneg placeholder="比如 beard, glasses">${esc(c.negative)}</textarea></div></details>
    <details class="pc-fold"><summary><b>被图片角色标记选中时补充</b><i>${esc(C.fixedTags(c)) || '（空）'}</i></summary><div class="pc-fold-in">
      <p class="pc-quote small mono">${esc(C.fixedTags(c)) || '（空）'}</p><div class="pc-hint">标记里写 $名字$ 或别名会展开成这一串（分角色时带描述）；聊天生图时，再加上 AI 写的动作表情${c.outfitMode === 'story' ? '和衣服' : ''}。</div></div></details>
    <div class="pc-center pc-mt"><button class="pc-btn dark" data-act="chartest" ${busy ? 'disabled' : ''}>${busy === 'test' ? '<span class="pc-busy">生成中</span>' : `用${esc(c.name)}生成一张试试`}</button></div>
    ${ui.charTestImg ? `<section class="pc-card pc-mt pc-result"><img src="${esc(ui.charTestImg)}" alt="" data-act="viewimg" data-src="${esc(ui.charTestImg)}"></section>` : ''}
    <div class="pc-center pc-mt"><button class="pc-pill dashed" data-act="sharechar">分享这个角色</button></div>
    ${c.kind === 'side' || c.kind === 'free' ? `<div class="pc-center pc-mt"><button class="pc-pill dashed danger" data-act="delside">删除这个角色</button></div>` : ''}
    <div style="height:24px"></div>`;
}

// 本聊天角色页的按钮动作：手动建档 / 编辑 / 历史回滚 / 提升为全局 / 删除 / 复制。
// 由 tools/apply-char-lib.mjs 内联进 UI 模块（在 charAction 之前），因此可直接用
// C / getData / toastr / render / ui / esc / promptText / confirmBox 这些同模块的东西。

// 保存一条本聊天档案：先把这个名字在各楼层的历史收成字段级记录，再写基线并清掉旧 ops。
function saveManualChatEntry(input, oldName, previous) {
    const name = String(input.name || '').trim();
    if (!name) return false;
    const tags = pairsFromTags(input.appearance || '');
    const outfitTags = pairsFromTags(input.outfit || '');
    const id = 'o_manual_' + Date.now();
    // 衣服没改就保持「是否显式」的原状态（空字段继续沿用同名全局角色）；改了才算显式覆盖。
    const previousOutfit = previous && previous.outfitMode === 'fixed'
        ? tagsText(C.currentOutfit(previous)?.tags)
        : '';
    const outfitChanged = tagsText(outfitTags) !== previousOutfit;
    const aliases = input.aliases === undefined
        ? (previous ? (previous.aliases || []).join('，') : '')
        : String(input.aliases || '');
    const ok = C.saveChatEntry({
        name,
        aliases,
        appearance: tags,
        nl: String(input.nl || '').trim(),
        outfitMode: outfitTags.length ? 'fixed' : 'story',
        outfitModeExplicit: outfitChanged ? true : previous ? previous.outfitModeExplicit === true : false,
        outfits: outfitTags.length ? [{ id, name: '固定着装', tags: outfitTags }] : [],
        outfitId: outfitTags.length ? id : '',
    }, oldName || name);
    if (ok) toastr.success('已保存 ' + name, '角色档案');
    else toastr.warning('保存失败：名字不能为空', '角色档案');
    return ok;
}

async function chatCharAction(act, el) {
    const name = el?.dataset?.name || '';
    switch (act) {
        case 'openchatlib':
            ui.view = 'chatlib'; render(); root.querySelector('.pc-body')?.scrollTo(0, 0); return true;
        case 'chatlibhist':
            ui.chatHistName = name; ui.view = 'charhist'; render(); return true;
        case 'chatlibnew': {
            const newName = await promptText('新角色叫什么？', '');
            if (!newName) return true;
            const appearance = await promptText('外貌标签（英文逗号分隔；留空 = 沿用同名全局角色）', '', true);
            const nl = await promptText('描述（英文自然语言，可留空）', '', true);
            const outfit = await promptText('固定衣服（留空 = 跟剧情 / 沿用全局）', '', true);
            saveManualChatEntry({ name: newName, appearance, nl, outfit }, newName, null);
            ui.view = 'chatlib'; render();
            return true;
        }
        case 'chatlibedit': {
            const entry = C.chatLatest().find(item => item.name === name)
                || C.chatBaseEntries().find(item => item.name === name);
            if (!entry) return true;
            const nextName = await promptText('名字', entry.name);
            if (!nextName) return true;
            const aliases = await promptText('别名（逗号分隔）', (entry.aliases || []).join('，'));
            const appearance = await promptText('外貌标签（英文逗号分隔；留空 = 沿用同名全局角色）', C.tagText(entry.appearance), true);
            const nl = await promptText('描述（英文自然语言；留空 = 沿用同名全局角色）', entry.nl || '', true);
            const outfit = await promptText('固定衣服（留空 = 跟剧情 / 沿用全局）', entry.outfitMode === 'fixed' ? C.tagText(C.currentOutfit(entry)?.tags) : '', true);
            saveManualChatEntry({ name: nextName, aliases, appearance, nl, outfit }, entry.name, entry);
            ui.view = 'chatlib'; render();
            return true;
        }
        case 'chatlibrollback': {
            if (C.chatEntryRollback(name, Number(el.dataset.index))) {
                toastr.success('已回到所选档案', '角色档案');
                ui.view = 'chatlib'; render();
            }
            return true;
        }
        case 'chatlibdel': {
            if (!(await confirmBox('删除本聊天角色「' + name + '」？会连带清掉这个名字早先楼层记下的变化。'))) return true;
            if (C.deleteChatEntry(name)) { toastr.success('已删除', '角色档案'); render(); }
            return true;
        }
        case 'chatlibpromote': {
            if (!(await confirmBox('把「' + name + '」提升为全局角色？之后所有聊天都能用，AI 不再修改它。'))) return true;
            if (C.promoteChatEntry(name)) { toastr.success('已提升为全局角色', '角色档案'); render(); }
            return true;
        }
        case 'chatlibcopy': {
            if (C.copyGlobalToChat(el.dataset.key || '')) { toastr.success('已复制到本聊天，AI 可以改它了', '角色档案'); render(); }
            return true;
        }
        default:
            return false;
    }
}

async function charAction(act, el) {
    const c = C.getChar(ui.charKey);
    const d = getData();
    if (typeof chatCharAction === "function" && await chatCharAction(act, el)) return true;
    switch (act) {
        case 'openchar': ui.charKey = el.dataset.key; ui.view = 'charedit'; ui.charTestImg = ''; ui.outTestImg = ''; render(); root.querySelector('.pc-body')?.scrollTo(0, 0); return true;
        case 'casttab': ui.castTab = el.dataset.tab; render(); return true;
        case 'castpreview': ui.castPreview = !ui.castPreview; render(); return true;
        case 'outdesign': openOutfitDesigner(); return true;
        case 'addside': {
            const cast = C.currentCast().filter(x => x.group === 'char');
            const cardAvatar = ui.view === 'charedit' && c ? (c.kind === 'side' ? c.card : c.avatar) : cast[0]?.char.avatar || cast[0]?.char.card;
            if (!cardAvatar) { toastr.warning('先打开一张角色卡', '角色'); return true; }
            const name = await promptText('配角叫什么？', '');
            if (!name) return true;
            const s = C.addSideKick(cardAvatar, name.slice(0, 30));
            ui.charKey = s.key; ui.view = 'charedit'; render();
            return true;
        }
    }
    // ── 衣柜 ──
    const curOutfit = () => ui.outfit?.draft ? ui.outfit : C.findOutfit(ui.outfit?.owner, ui.outfit?.id)?.o;
    const saveOutfit = () => { if (!ui.outfit?.draft) { const h = C.findOutfit(ui.outfit.owner, ui.outfit.id); if (h?.owner) C.saveChar(h.owner); else commit({ silent: true }); } render(); };
    switch (act) {
        case 'casttop': ui.castTop = el.dataset.v; render(); return true;
        case 'wardfilter': ui.wardFilter = el.dataset.v; render(); return true;
        case 'wardnew': ui.outfit = { draft: true, name: '', tags: [], image: '', dest: '' }; ui.view = 'outfit'; render(); return true;
        case 'omimport': openOmImport(); return true;
        case 'wardai': {
            const want = await promptText('想要什么样的衣服？（比如：冬天的校服、去海边、正式晚宴、哥特风）', '');
            if (!want) return true;
            ui.outfit = { draft: true, name: '', tags: [], image: '', dest: '', busy: 'read' }; ui.view = 'outfit'; render();
            try { const r = await T.designOutfit('', '', '', want); Object.assign(ui.outfit, { name: r.name || want.slice(0, 12), tags: r.tags }); }
            catch (e) { toastr.error(e.message, 'AI 设计失败'); }
            ui.outfit.busy = ''; render();
            return true;
        }
        case 'openoutfit': ui.outfit = { owner: el.dataset.owner, id: el.dataset.id }; ui.view = 'outfit'; ui.addText.ward = ''; render(); root.querySelector('.pc-body')?.scrollTo(0, 0); return true;
        case 'outback': ui.view = 'cast'; ui.castTop = 'wardrobe'; ui.outfit = null; render(); return true;
        case 'outdest': ui.outfit.dest = el.dataset.v; ui.outfit.destChosen = true; render(); return true;
        case 'outsave': {
            const u = ui.outfit;
            let image = u.image;
            if (image?.startsWith('data:')) { try { image = (await uploadImage(await shrinkDataUrl(image, 768), `outfit_${M.uid('')}`)).path; } catch { image = ''; } }
            const o = { id: M.uid('o_'), name: u.name || '新衣服', tags: u.tags, image };
            d.outfits[o.id] = o;
            commit();
            if (u.dest) C.giveOutfit('', o.id, u.dest);
            toastr.success(u.dest ? `已存，并给${C.getChar(u.dest)?.name}穿上` : '已存进衣柜', '衣柜', { timeOut: 2000 });
            ui.outfit = u.dest ? { owner: u.dest, id: o.id } : { owner: '', id: o.id };
            render();
            return true;
        }
        case 'outgive': {
            const to = C.getChar(el.dataset.v);
            const o = C.giveOutfit(ui.outfit.owner, ui.outfit.id, el.dataset.v);
            if (o) { toastr.success(`${to.name} 现在固定穿「${o.name}」`, '衣柜', { timeOut: 2000 }); if (!ui.outfit.owner) ui.outfit = { owner: to.key, id: o.id }; }
            render();
            return true;
        }
        case 'outimggen': {
            if (!N.isReady()) { toastr.warning('先到设置里填 NovelAI key', '衣柜'); return true; }
            const o = curOutfit();
            const owner = ui.outfit.draft ? C.getChar(ui.outfit.dest) : C.findOutfit(ui.outfit.owner, ui.outfit.id)?.owner;
            ui.outfit.busy = 'gen'; render();
            try {
                const pos = M.mergeTags(d.active ? M.ticketString(d, d.active) : '', owner ? C.tagText(owner.appearance) : '1boy, solo, male focus, adult', C.tagText(o.tags), 'solo, full body, standing, looking at viewer, simple background, white background');
                const { positive, negative } = E.composeStudio({ pos, neg: owner?.negative || '' });
                const img = await E.generateFull({ positive, negative, width: 768, height: 1344, director: owner?.charRef ? await E.charRefs([owner.charRef]) : undefined });
                if (ui.outfit.draft) o.image = img;
                else { o.image = (await uploadImage(img, `outfit_${M.uid('')}`)).path; saveOutfit(); }
            } catch (e) { toastr.error(e.message, '生成失败'); }
            ui.outfit.busy = ''; render();
            return true;
        }
        case 'outshare': { const h = C.findOutfit(ui.outfit.owner, ui.outfit.id); if (h) await shareCharacterPost('outfit', h.owner || { name: '' }, h.o); return true; }
        case 'outtakeoff': {
            const key = el.dataset.v, hit = C.findOutfit(ui.outfit.owner, ui.outfit.id);
            const mine = hit && C.outfitHolders(hit.o).find(x => x.owner.key === key);
            if (!mine) return true;
            const next = C.takeOffOutfit(key, mine.o.id);
            toastr.info(`已从${C.getChar(key)?.name || ''}身上拿掉`, '衣柜', { timeOut: 1800 });
            if (ui.outfit.owner === key && next) ui.outfit = { owner: next.owner?.key || '', id: next.o.id };
            render(); return true;
        }
        case 'outdel': {
            const o = curOutfit();
            const n = ui.outfit.owner && o ? C.outfitHolders(o).length : 1;
            if (!o || !(await confirmBox(n > 1 ? `删掉「${o.name}」？${n} 个人身上的都会删掉。只想从某个人身上拿掉，点他名字旁边的 ×。` : `删掉「${o.name}」？`))) return true;
            C.deleteOutfitGroup(ui.outfit.owner, ui.outfit.id);
            ui.view = 'cast'; ui.castTop = 'wardrobe'; ui.outfit = null; render();
            return true;
        }
    }
    const wardList = () => curOutfit()?.tags;
    if (['addpair', 'editpair', 'delpair', 'movepair'].includes(act) && ['ward', 'wardacc'].includes(el.dataset.where)) {
        const list = wardList();
        if (!list) return true;
        if (act === 'delpair') { list.splice(Number(el.dataset.i), 1); saveOutfit(); return true; }
        if (act === 'movepair') { const t = list[Number(el.dataset.i)]; if (t) t.acc = !isAcc(t); saveOutfit(); return true; }
        if (act === 'editpair') {
            const t = list[Number(el.dataset.i)];
            const en = await promptText(`改这个标签${t.zh ? `（${t.zh}）` : ''}`, t.en);
            if (en == null) return true;
            if (!en.trim()) list.splice(Number(el.dataset.i), 1);
            else if (T.hasChinese(en)) { const p = await T.textToPairs(en); if (p[0]) Object.assign(t, p[0]); }
            else { if (en.trim() !== t.en) t.zh = ''; t.en = en.trim(); }
            saveOutfit();
            return true;
        }
        const key = el.dataset.where;
        const text = (ui.addText[key] || '').trim();
        if (!text) return true;
        ui.outfit.busy = 'add'; ui.outfit.addKey = key; render();
        try { addToOutfit(list, await T.textToPairs(text), key === 'wardacc'); ui.addText[key] = ''; }
        catch (e) { toastr.error(e.message, '加不进去'); }
        ui.outfit.busy = ''; saveOutfit();
        return true;
    }
    if (!c) return false;
    const save = () => { C.saveChar(c); render(); };
    switch (act) {
        case 'readchatcast':
        case 'readcast': {
            const cardAvatar = c.kind === 'side' ? c.card : c.avatar;
            const main = C.getChar('char:' + cardAvatar);
            if (!cardAvatar || !main) return true;
            if (ui.charBusy) return true;
            const fromChat = act === 'readchatcast';
            const startContext = SillyTavern.getContext(), startChat = startContext.chat, startChatId = C.chatId();
            const startKey = ui.charKey, startMain = d.characters[main.key];
            const stillCurrent = () => getData() === d && ui.charKey === startKey && d.characters[main.key] === startMain && C.chatId() === startChatId && SillyTavern.getContext().chat === startChat;
            ui.charBusy = fromChat ? 'chatcast' : 'cast'; render();
            try {
                let people;
                if (fromChat) {
                    const ctx = SillyTavern.getContext();
                    const msgs = (ctx.chat || []).filter(m => !m.is_system && m.mes).slice(-40);
                    const text = msgs.map(m => { const body = imageStoryText(m.mes); return body ? '【' + (m.name || (m.is_user ? '用户' : main.name)) + '】' + body : ''; }).filter(Boolean).join('\n\n');
                    if (!text.trim()) { toastr.warning('这个聊天还没有正文', '角色'); return true; }
                    people = await T.extractCastFromChat(main.name, text);
                    if (!people.length) { toastr.warning('AI 没在最近的正文里找到写了外貌的人', '角色'); return true; }
                } else {
                const desc = await C.descOfFull(main);
                if (!desc.trim()) { toastr.warning('描述、性格、场景、世界书里都没找到设定', '角色'); return true; }
                people = await T.extractCast(main.name, desc);
                }
                if (!people.length) { toastr.warning('AI 没在设定里找到写了外貌的人', '角色'); return true; }
                if (!stillCurrent()) return true;
                const made = [], filled = [], kept = [];
                for (const p of people) {
                    if (fromChat && p.name === startContext.name1) continue;
                    const all = [main, ...C.sideKicks(cardAvatar)];
                    let ch = all.find(x => x.name === p.name || C.namesOf(x).some(n => n === p.name || p.aliases.includes(n)));
                    if (!ch) { ch = C.addSideKick(cardAvatar, p.name); made.push(p.name); }
                    else if (ch.appearance.length) { kept.push(ch.name); }
                    else filled.push(ch.name);
                    if (!ch.appearance.length) {
                        ch.appearance = p.appearance;
                        if (p.nsfw?.length && !(ch.nsfwBody || []).length) ch.nsfwBody = p.nsfw;
                        if (p.outfit.length && !ch.outfits.length) { const o = { id: M.uid('o_'), name: '默认', tags: p.outfit }; ch.outfits.push(o); ch.outfitId = o.id; }
                    }
                    const al = new Set(String(ch.aliases || '').split(/[,，、;；\s]+/).filter(Boolean));
                    for (const a of p.aliases) if (a !== ch.name) al.add(a);
                    ch.aliases = [...al].join('，');
                    C.saveChar(ch);
                }
                toastr.success([made.length ? `新加配角：${made.join('、')}` : '', filled.length ? `填了外貌：${filled.join('、')}` : '', kept.length ? `已有外貌没动：${kept.join('、')}` : ''].filter(Boolean).join('；'), '读出卡里的人', { timeOut: 8000 });
            } catch (e) { toastr.error(e.message, '读取失败'); }
            finally { ui.charBusy = ''; render(); }
            return true;
        }
        case 'readcard': {
            ui.charBusy = 'read'; render();
            const desc = await C.descOfFull(c).catch(() => '');
            ui.charBusy = ''; render();
            if (!desc.trim()) { toastr.warning(c.kind === 'side' ? `卡和世界书里都没提到「${c.name}」，可以在下面手动填外貌` : '描述、性格、场景、世界书里都没找到设定，可以在下面手动填外貌', '角色', { timeOut: 6000 }); return true; }
            if (c.appearance.length && !(await confirmBox('用读到的外貌替换现在的？', { ok: '替换', cancel: '算了' }))) return true;
            ui.charBusy = 'read'; render();
            try {
                const r = await T.extractAppearance(c.name, desc);
                c.appearance = r.appearance;
                if (r.nsfw?.length) c.nsfwBody = r.nsfw;
                if (r.outfit.length && !c.outfits.length) { const o = { id: M.uid('o_'), name: '默认', tags: r.outfit }; c.outfits.push(o); c.outfitId = o.id; }
                toastr.success(`读到 ${r.appearance.length} 个外貌标签${r.outfit.length ? `，${r.outfit.length} 个衣服标签（存在「默认」这套里）` : ''}`, '角色');
            } catch (e) { toastr.error(e.message, '读取失败'); }
            ui.charBusy = ''; save();
            return true;
        }
        case 'addpair': {
            const where = el.dataset.where;
            const text = (ui.addText[where] || '').trim();
            if (!text) return true;
            ui.charBusy = where; render();
            try {
                const pairs = await T.textToPairs(text);
                if (where === 'app') { for (const p of pairs) if (!c.appearance.some(x => x.en === p.en)) c.appearance.push(p); }
                else if (where === 'nsfw') { c.nsfwBody ||= []; for (const p of pairs) if (!c.nsfwBody.some(x => x.en === p.en)) c.nsfwBody.push(p); }
                else { const list = C.currentOutfit(c)?.tags; if (list) addToOutfit(list, pairs, where === 'outacc'); }
                ui.addText[where] = '';
            } catch (e) { toastr.error(e.message, '加不进去'); }
            ui.charBusy = ''; save();
            // 刚加的英文标签悄悄补上中文
            if (charPairs(c).some(t => !t.zh)) void fillZh(c, { quiet: true }).then(n => { if (n && getData().characters[c.key] === c) save(); });
            return true;
        }
        case 'zhtags': {
            ui.charBusy = 'zh'; render();
            try {
                const n = await fillZh(c);
                toastr.success(n ? `翻好了 ${n} 个` : 'AI 没给出中文，再点一次试试', '标签翻译', { timeOut: 1800 });
            } catch (e) { toastr.error(e.message || String(e), '翻译失败'); }
            ui.charBusy = ''; if (getData().characters[c.key] === c) save(); else render();
            return true;
        }
        case 'editpair': {
            const list = el.dataset.where === 'app' ? c.appearance : el.dataset.where === 'nsfw' ? (c.nsfwBody ||= []) : C.currentOutfit(c)?.tags;
            const t = list?.[Number(el.dataset.i)];
            if (!t) return true;
            const en = await promptText(`改这个标签${t.zh ? `（${t.zh}）` : ''}`, t.en);
            if (en == null) return true;
            if (!en.trim()) list.splice(Number(el.dataset.i), 1);
            else if (T.hasChinese(en)) { const p = await T.textToPairs(en); if (p[0]) Object.assign(t, p[0]); }
            else { if (en.trim() !== t.en) t.zh = ''; t.en = en.trim(); }
            save();
            return true;
        }
        case 'delpair': {
            const list = el.dataset.where === 'app' ? c.appearance : el.dataset.where === 'nsfw' ? (c.nsfwBody ||= []) : C.currentOutfit(c)?.tags;
            list?.splice(Number(el.dataset.i), 1);
            save();
            return true;
        }
        case 'movepair': { const t = C.currentOutfit(c)?.tags[Number(el.dataset.i)]; if (t) t.acc = !isAcc(t); save(); return true; }
        case 'outmode': c.outfitMode = el.dataset.v; save(); return true;
        case 'charrefpick': c.charRef = el.dataset.id; save(); return true;
        case 'pickout': c.outfitId = el.dataset.id; ui.outTestImg = ''; save(); return true;
        case 'aiout': {
            const want = await promptText(`想给${c.name}设计什么样的衣服？（可以写得很随便，比如：冬天的校服、去海边、正式晚宴、睡衣）`, '');
            if (!want) return true;
            ui.charBusy = 'aiout'; render();
            try {
                const r = await T.designOutfit(c.name, C.tagText(c.appearance), C.descOf(c), want);
                const o = { id: M.uid('o_'), name: r.name || want.slice(0, 12), tags: r.tags };
                c.outfits.push(o); c.outfitId = o.id; ui.outTestImg = '';
                toastr.success(`设计好了：${o.name}（${o.tags.length} 个标签），可以再改`, '角色');
            } catch (e) { toastr.error(e.message, 'AI 设计失败'); }
            ui.charBusy = ''; save();
            return true;
        }
        case 'storyout': {
            ui.charBusy = 'storyout'; render();
            try {
                const chat = SillyTavern.getContext().chat || [];
                const text = chat.slice(-8).filter(m => !m.is_system).map(m => `${m.name}: ${String(m.mes || '').replace(/<[^>]+>/g, '')}`).join('\n\n');
                if (!text.trim()) throw new Error('现在的聊天里没有内容');
                const r = await T.outfitFromStory(c.name, text);
                if (!r.tags.length) throw new Error('剧情里没写到他穿什么');
                const o = { id: M.uid('o_'), name: r.name || '剧情里的', tags: r.tags };
                c.outfits.push(o); c.outfitId = o.id; ui.outTestImg = '';
                toastr.success(`读到了：${o.name}`, '角色');
            } catch (e) { toastr.error(e.message, '读不出来'); }
            ui.charBusy = ''; save();
            return true;
        }
        case 'outtest': {
            if (!N.isReady()) { toastr.warning('先到设置里填 NovelAI key', '角色'); return true; }
            const o = C.currentOutfit(c);
            ui.charBusy = 'outtest'; render();
            try {
                const pos = M.mergeTags(d.active ? M.ticketString(d, d.active) : '', C.tagText(c.appearance), C.tagText(o?.tags), 'solo, full body, standing, looking at viewer, simple background, white background');
                const { positive, negative } = E.composeStudio({ pos, neg: c.negative });
                ui.outTestImg = await E.generateFull({ positive, negative, width: 768, height: 1344, director: c.charRef ? await E.charRefs([c.charRef]) : undefined });
            } catch (e) { toastr.error(e.message, '生成失败'); }
            ui.charBusy = ''; render();
            return true;
        }
        case 'newout': {
            // 一步建好：整套粘进去，名字可以不填（默认「第 N 套」）
            let n = c.outfits.length + 1;
            while (c.outfits.some(o => o.name === `第 ${n} 套`)) n++;
            const r = await newOutfitBox(`第 ${n} 套`);
            if (!r) return true;
            const o = { id: M.uid('o_'), name: r.name.slice(0, 20), tags: [] };
            c.outfits.push(o); c.outfitId = o.id; ui.outTestImg = '';
            if (r.text) {
                ui.charBusy = 'out'; save();
                try { addToOutfit(o.tags, await T.textToPairs(r.text), false); }
                catch (e) { ui.addText.out = r.text; toastr.error(e.message + '（写的内容留在输入框里了）', '加不进去'); }
                ui.charBusy = '';
            }
            save();
            return true;
        }
        case 'renameout': { const o = C.currentOutfit(c); const n = o && await promptText('新名字', o.name); if (n) { o.name = n.slice(0, 20); save(); } return true; }
        case 'delout': {
            const o = C.currentOutfit(c);
            const others = o ? C.outfitHolders(o).filter(x => x.owner.key !== c.key) : [];
            if (!o || !(await confirmBox(others.length ? `把「${o.name}」从${c.name}身上拿掉？${others.map(x => x.owner.name).join('、')}还穿着这套，不受影响。` : `删掉「${o.name}」这套衣服？`))) return true;
            c.outfits = c.outfits.filter(x => x !== o); c.outfitId = c.outfits[0]?.id || ''; save();
            return true;
        }
        case 'freecast': if (C.currentCast().some(x => x.key === c.key)) C.removeFromCast(c.key); else C.setCastOn(c.key, true); render(); return true;
        case 'renamefree': { const n = await promptText('新名字', c.name); if (n) { c.name = n.slice(0, 30); save(); } return true; }
        case 'copylook': {
            const targets = [...C.stCards(), ...C.stPersonas()];
            const cast = C.currentCast().filter(x => x.key !== c.key).map(x => x.char);
            const opts = cast.length ? cast : targets.map(t => C.getChar(t.key));
            const i = await chooseBox(`把「${c.name}」的外貌和衣服套到谁身上？（会覆盖原来的）`, opts.map(t => t.name));
            if (i == null) return true;
            C.copyLook(c.key, opts[i].key);
            toastr.success(`已套用到 ${opts[i].name}`, '角色');
            return true;
        }
        case 'sharechar': await shareCharacterPost('character', c); return true;
        case 'shareout': { const o = C.currentOutfit(c); if (o) await shareCharacterPost('outfit', c, o); return true; }
        case 'delside': {
            if (!(await confirmBox(`删除「${c.name}」？`))) return true;
            C.deleteChar(c.key); ui.view = 'cast'; render();
            return true;
        }
        case 'chartest': {
            if (!N.isReady()) { toastr.warning('先到设置里填 NovelAI key', '角色'); return true; }
            ui.charBusy = 'test'; render();
            try {
                const pos = M.mergeTags(d.active ? M.ticketString(d, d.active) : '', C.fixedTags(c), 'solo, upper body, looking at viewer, simple background');
                const { positive, negative } = E.composeStudio({ pos, neg: c.negative });
                ui.charTestImg = await E.generateFull({ positive, negative, director: c.charRef ? await E.charRefs([c.charRef]) : undefined });
            } catch (e) { toastr.error(e.message, '生成失败'); }
            ui.charBusy = ''; render();
            return true;
        }
    }
    return false;
}

// ═════════════════════ 批量 ═════════════════════

function viewBatch(d) {
    const b = ui.batch;
    const st = b.state;
    const done = st ? st.jobs.filter(j => ['done', 'error', 'skip'].includes(j.status)).length : 0;
    const names = batchUnits(d, b.text);
    const tpls = chosenTemplates('batch');
    const count = names.reduce((n, u) => { const r = findUnit(d, u); const it = r && M.resolveTicket(d, r)?.item; return n + tpls.filter(t => !(b.skipExisting && it?.images.some(i => i.template === t))).length; }, 0);
    const tplText = tpls.map(t => d.templates[t]?.positive).filter(Boolean).join(' / ');
    const picked = st ? st.jobs.filter(j => j.picked).length : 0;
    const head = `<div class="pc-dhead"><button class="pc-round" data-act="back" aria-label="返回">‹</button><h2 class="pc-dtitle">批量生成例图</h2></div>`;
    if (st && !b.showSetup) return `${head}
    <section class="pc-card pc-pad pc-mt">
      <div class="pc-row-between"><b>${done} / ${st.jobs.length} 张</b>
        <div class="pc-chips" style="margin:0">${st.running ? `<button class="pc-round" data-act="batchpause" aria-label="${st.paused ? '继续' : '暂停'}">${st.paused ? '▶' : '❚❚'}</button><button class="pc-round" data-act="batchstop" aria-label="停止">■</button>` : ''}</div></div>
      <div class="pc-prog"><i style="width:${st.jobs.length ? Math.round(done / st.jobs.length * 100) : 0}%"></i></div>
      <div class="pc-dim small pc-mt-s">每张出来会自动存进那位画师的例图。${st.running ? '关掉这一页也会继续生成。' : ''}</div>
      <div class="pc-actions wrap"><button class="pc-btn" data-act="batchsetup">${st.running ? '‹ 回到设置，再加一批' : '‹ 回到设置，再来一批'}</button></div>
    </section>
    <div class="pc-grid2 pc-mt pc-bgrid">${st.jobs.map((j, i) => `<div class="pc-bcell shot-${d.templates[j.templateId]?.shot || 'bust'} ${j.picked ? 'on' : ''} ${j.status}" ${j.status === 'done' ? `data-act="batchpick" data-i="${i}"` : ''} title="${esc(j.error)}">
        ${j.image ? `<img src="${esc(j.image)}" alt="">` : `<span>${{ wait: '排队', run: '<span class="pc-busy">生成中</span>', error: '失败', skip: '已有，跳过' }[j.status] || ''}</span>`}
        ${j.status === 'done' ? `<i class="pc-bpick">${j.picked ? '✓' : ''}</i>` : ''}
        <b class="mono">${esc(M.ticketName(d, j.ref))} · ${esc(d.templates[j.templateId]?.name || '')}</b></div>`).join('')}</div>
    ${!st.running && st.jobs.some(j => j.status === 'done') ? `<div class="pc-tip">点图片可以勾选，看中的几位能直接拼成一个画师组</div>
    <button class="pc-btn dark big pc-mt" data-act="batchgroup" ${picked ? '' : 'disabled'}>${picked ? `把勾选的 ${picked} 位拼成画师组` : '先勾选几张'}</button>` : ''}
    <div style="height:24px"></div>`;
    const doneN = st ? st.jobs.filter(j => ['done', 'error', 'skip'].includes(j.status)).length : 0;
    return `${head}
    ${st ? `<section class="pc-card pc-pad pc-mt pc-row-between"><div><b>${st.running ? '正在生成' : '上一批'} ${doneN} / ${st.jobs.length} 张</b><div class="pc-dim small">${st.running ? '再点「开始生成」会排到后面一起生成' : '点右边看结果'}</div></div><button class="pc-btn dark" data-act="batchview">看进度 ›</button></section>` : ''}
    <section class="pc-card pc-pad pc-mt">
      <label class="pc-label" for="pc-batch" style="margin-top:0">画师名（一行一个，或用逗号隔开）</label>
      <textarea id="pc-batch" class="pc-textarea mono" style="min-height:150px" data-bind="batch.text" placeholder="一行一个：画师名，或整串（artist:xxx, artist:yyy, 别的词…）">${esc(b.text)}</textarea>
      <div id="pc-batch-ban">${batchBanWarn(d, b.text)}</div>
      <div class="pc-chips wrap"><button class="pc-pill dashed tiny" data-act="batchfill" data-v="all">放进画师库里全部单个画师</button><button class="pc-pill dashed tiny" data-act="batchfill" data-v="empty">只放还没有例图的</button></div>
      ${label('用哪种提示词')}
      ${sampleChooser('batch')}
      <label class="pc-switch"><input type="checkbox" data-bind-check="batch.skipExisting" ${b.skipExisting ? 'checked' : ''}><span></span>已经有这种例图的画师跳过</label>
      <label class="pc-switch"><input type="checkbox" data-opt="sampleSameSeed" ${d.options.sampleSameSeed !== false ? 'checked' : ''}><span></span>所有画师用同一个种子<small>同一张脸、同一个姿势，只比画风${Number(d.options.sampleSeed) > 0 ? ` · 种子 ${d.options.sampleSeed}` : ''}</small></label>
      ${d.options.sampleSameSeed !== false && Number(d.options.sampleSeed) > 0 ? '<button class="pc-pill dashed tiny" data-act="newsampleseed">换一个种子</button>' : ''}
      <div class="pc-row-between"><span>共 ${names.length} 位画师，会生成 <b>${count}</b> 张</span><span class="pc-dim small">会用掉 NovelAI 点数</span></div>
    </section>
    <details class="pc-fold"><summary><b>例图提示词</b><i>${esc(tplText)}</i></summary><div class="pc-fold-in">
      ${tpls.map(t => `<div class="pc-label">${esc(d.templates[t]?.name)}</div><p class="pc-quote small mono">正面：${esc(d.templates[t]?.positive)}<br>负面：${esc(d.templates[t]?.negative)}</p>`).join('')}
      <button class="pc-btn" data-act="edittpl" data-scope="batch">改提示词</button></div></details>
    <button class="pc-btn dark big pc-mt" data-act="batchstart">${seal()}开始生成</button>
    <div style="height:24px"></div>`;
}

// ═════════════════════ 氛围 ═════════════════════

const vibeThumbCache = new Map();
function vibeTabs() {
    return '';
}

function viewCharRef(d) {
    const groups = Object.values(d.charRefGroups || {});
    const cur = d.charRefGroups?.[d.charRefActive];
    const show = d.charRefGroups?.[ui.crShow] || cur || groups[0];
    const TYPES = [['character', '只参考长相'], ['both', '长相和画风'], ['style', '只参考画风']];
    const card = g => `<article class="pc-ticket ${g.id === d.charRefActive ? 'active' : ''}" data-act="crshow" data-id="${g.id}" data-lp="crgroup">
        <div class="pc-ticket-img">${g.refs[0] ? `<img src="${esc('/' + g.refs[0].path)}" alt="" loading="lazy">` : '<span>还没有图</span>'}</div>
        <button class="pc-use ${g.id === d.charRefActive ? 'on' : ''}" data-act="cruse" data-id="${g.id}" aria-label="用这组">${g.id === d.charRefActive ? SYM.check : SYM.swap}</button>
        <div class="pc-ticket-text"><b>${esc(g.name)}</b><small>${g.refs.length} 张</small></div></article>`;
    return `${vibeTabs()}
    <section class="pc-card pc-pad pc-row-between pc-mt">
      <div class="pc-grow"><b class="pc-big">正在用：${cur ? esc(cur.name) : '不用角色参考'}</b>
        <div class="pc-dim small">给一张角色图，让 NovelAI 照着画出同一个人。只有 NAI 4.5 能用；开着时氛围会暂停。</div></div>
      <button class="pc-add" data-act="crnew" aria-label="新建角色参考组">＋</button>
    </section>
    ${!N.charRefSupported() ? '<div class="pc-card pc-pad pc-mt pc-warn-card">现在用不了：要选 NAI 4.5 模型，而且不能是「用酒馆里的 key」。</div>' : ''}
    <div class="pc-grid2 pc-mt">${groups.map(card).join('')}
      <article class="pc-ticket ${!cur ? 'active' : ''}" data-act="cruse" data-id="">
        <div class="pc-ticket-img"><span>不加参考</span></div>
        <button class="pc-use ${!cur ? 'on' : ''}" data-act="cruse" data-id="">${!cur ? SYM.check : SYM.swap}</button>
        <div class="pc-ticket-text"><b>不用角色参考</b><small>只靠提示词</small></div></article></div>
    ${groups.length ? '<div class="pc-tip">长按一组可以改名或删除</div>' : ''}
    ${show ? `<section class="pc-card pc-pad pc-mt">
      <div class="pc-row-between"><b>${esc(show.name)} · ${show.refs.length} 张</b>
        <label class="pc-pill dashed tiny">＋ 加图<input type="file" accept="image/*" data-cradd="${show.id}" hidden></label></div>
      ${show.refs.map((r, i) => `<div class="pc-vrow">
        <div class="pc-vthumb"><img src="${esc('/' + r.path)}" alt=""></div>
        <div class="pc-grow"><div class="pc-row-between"><select class="pc-mini-select" data-crtype="${show.id}:${i}">${TYPES.map(([v, t]) => `<option value="${v}" ${v === (r.type || 'character') ? 'selected' : ''}>${t}</option>`).join('')}</select><button class="pc-x" data-act="crdel" data-g="${show.id}" data-i="${i}" aria-label="删掉">×</button></div>
          <label class="pc-slider"><span>像不像</span><input type="range" min="0" max="1" step="0.01" value="${Number(r.strength ?? 0.6)}" data-crstr="${show.id}:${i}"><b>${Number(r.strength ?? 0.6).toFixed(2)}</b></label></div></div>`).join('') || '<div class="pc-dim small pc-mt-s">点「＋ 加图」放一张角色图，最好是单人、看得清脸和衣服。</div>'}
      <div class="pc-hint">「像不像」越大越像参考图，太大会不听提示词。一般 0.5 到 0.8。</div>
    </section>` : ''}
    <div style="height:24px"></div>`;
}

function viewVibe(d) {

    const groups = Object.values(d.vibeGroups || {});
    const cur = d.vibeGroups?.[d.vibeActive];
    const show = d.vibeGroups?.[ui.vibeShow] || cur || groups[0];
    const mosaic = g => `<div class="pc-mosaic4">${[0, 1, 2, 3].map(i => { const v = g.vibes[i]; const u = v && (v.path ? '/' + v.path : v.thumb); return `<i>${u ? `<img src="${esc(u)}" alt="" loading="lazy">` : ''}</i>`; }).join('')}</div>`;
    const card = g => `<article class="pc-ticket ${g.id === d.vibeActive ? 'active' : ''}" data-act="vibeshow" data-id="${g.id}" data-lp="vibe">
        ${mosaic(g)}<button class="pc-use ${g.id === d.vibeActive ? 'on' : ''}" data-act="vibeuse" data-id="${g.id}" aria-label="用这组">${g.id === d.vibeActive ? SYM.check : SYM.swap}</button>
        <div class="pc-ticket-text"><b>${esc(g.name)}</b><small>${g.vibes.length} 张</small></div></article>`;
    return `${vibeTabs()}
    <section class="pc-card pc-pad pc-row-between">
      <div class="pc-grow"><b class="pc-big">正在用：${cur ? esc(cur.name) : '不用氛围'}</b>
        <div class="pc-dim small">氛围就是参考图：照着这几张图的色调、光线、质感去画，不会照抄里面的人和构图。角色长相参考在「角色」里给每个角色单独绑。</div></div>
      <button class="pc-add" data-act="vibenew" aria-label="新建氛围组">＋</button>
    </section>
    ${!N.vibeSupported() ? '<div class="pc-card pc-pad pc-mt pc-warn-card">现在的连接方式或模型用不了氛围（「用酒馆里的 key」、NAI 3、NAI 5 都不支持）。</div>' : ''}
    <div class="pc-grid2 pc-mt">${groups.map(card).join('')}
      <article class="pc-ticket ${!cur ? 'active' : ''}" data-act="vibeuse" data-id="">
        <div class="pc-ticket-img"><span>不加氛围</span></div>
        <button class="pc-use ${!cur ? 'on' : ''}" data-act="vibeuse" data-id="">${!cur ? SYM.check : SYM.swap}</button>
        <div class="pc-ticket-text"><b>不用氛围</b><small>只靠提示词和画师</small></div></article>
    </div>
    ${groups.length ? '<div class="pc-tip">点一组看里面的图，下面可以改名、删除整组；单张图点右边的 × 删除</div>' : ''}
    ${show ? `<section class="pc-card pc-pad pc-mt">
      <div class="pc-row-between"><b>${esc(show.name)} · ${show.vibes.length} 张</b>
        <label class="pc-pill dashed tiny">＋ 加图<input type="file" accept="image/*,.naiv4vibe,.json" multiple data-vibeadd="${show.id}" hidden></label></div>
      <div class="pc-chips wrap pc-mt-s"><button class="pc-pill dashed tiny" data-act="viberename" data-id="${show.id}">改名</button><button class="pc-pill dashed tiny danger" data-act="vibegdel" data-id="${show.id}">删除这一组</button></div>
      ${show.vibes.map((v, i) => `<div class="pc-vrow">
        <div class="pc-vthumb">${v.path || v.thumb ? `<img src="${esc(v.path ? '/' + v.path : v.thumb)}" alt="">` : ''}</div>
        <div class="pc-grow"><div class="pc-row-between"><small class="pc-dim">${esc(v.name || '参考图 ' + (i + 1))}<br><span style="font-size:10px">${(() => { const ks = Object.keys(v.encodings || {}).filter(k => v.encodings[k]); const nm = { 'v4-5full': '4.5 Full', 'v4-5curated': '4.5 Curated', v4full: '4 Full', v4curated: '4 Curated' }; return ks.length ? '已编码：' + ks.map(k => esc(nm[k] || k)).join('、') : (v.path ? '还没编码（第一次用时扣约 2 点 Anlas）' : '官网文件，没有原图'); })()}</span></small><button class="pc-x" data-act="vibedel" data-g="${show.id}" data-i="${i}" aria-label="删掉">×</button></div>
          <label class="pc-slider"><span>强度</span><input type="range" min="0" max="1" step="0.01" value="${Number(v.strength ?? 0.6)}" data-vibestr="${show.id}:${i}"><b>${Number(v.strength ?? 0.6).toFixed(2)}</b></label></div></div>`).join('') || '<div class="pc-dim small pc-mt-s">点「＋ 加图」放几张参考图。也可以放 NovelAI 官网导出的 .naiv4vibe 文件。</div>'}
      <div class="pc-hint">强度一般 0.3 到 0.6。太大会盖过提示词。首次为当前模型编码会收取编码费；复用已保存的编码不再收取编码费。</div>
    </section>
    <details class="pc-fold"><summary><b>更多</b><i>强度归一化 ${show.normalize ? '开' : '关'}</i></summary><div class="pc-fold-in">
      <label class="pc-switch"><input type="checkbox" data-vibenorm="${show.id}" ${show.normalize ? 'checked' : ''}><span></span>强度归一化（Normalize，只对 4.5 有用）</label></div></details>` : ''}
    <div style="height:24px"></div>`;
}
async function crMenu(id) {
    const d = getData();
    const g = d.charRefGroups[id];
    if (!g) return;
    const i = await chooseBox(`角色参考组「${g.name}」`, ['改名', '删除这一组']);
    if (i === 0) { const n = await promptText('新名字', g.name); if (n) { g.name = n.slice(0, 20); commit(); } }
    if (i === 1 && await confirmBox(`删除「${g.name}」？`)) {
        for (const r of g.refs) deleteImageFile(r.path);
        delete d.charRefGroups[id];
        if (d.charRefActive === id) d.charRefActive = null;
        commit();
    }
}

/** 角色参考图要缩放到 NovelAI 认的三种尺寸之一 */
async function fitCharRef(dataUrl) {
    const img = await new Promise((ok, bad) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => bad(new Error('图片打不开')); i.src = dataUrl; });
    const r = img.width / img.height;
    const sizes = [[1024, 1536], [1472, 1472], [1536, 1024]];
    const [w, h] = sizes.reduce((a, b) => Math.abs(b[0] / b[1] - r) < Math.abs(a[0] / a[1] - r) ? b : a);
    const c = DOC.createElement('canvas'); c.width = w; c.height = h;
    const ctx = c.getContext('2d'); ctx.imageSmoothingQuality = 'high';
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
    const k = Math.min(w / img.width, h / img.height), dw = img.width * k, dh = img.height * k;
    ctx.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
    return c.toDataURL('image/jpeg', 0.92);
}

async function vibeMenu(id) {
    const d = getData();
    const g = d.vibeGroups[id];
    if (!g) return;
    const i = await chooseBox(`氛围组「${g.name}」`, ['改名', '删除这一组']);
    if (i === 0) await renameVibeGroup(id);
    if (i === 1) await deleteVibeGroup(id);
}
async function renameVibeGroup(id) {
    const g = getData().vibeGroups[id];
    if (!g) return;
    const n = await promptText('新名字', g.name);
    if (n) { g.name = n.slice(0, 20); commit(); render(); }
}
async function deleteVibeGroup(id) {
    const d = getData(), g = d.vibeGroups[id];
    if (!g || !(await confirmBox(`删除「${g.name}」和里面的 ${g.vibes.length} 张图？`))) return;
    for (const v of g.vibes) if (v.path) deleteImageFile(v.path);
    delete d.vibeGroups[id];
    if (d.vibeActive === id) d.vibeActive = null;
    if (ui.vibeShow === id) ui.vibeShow = null;
    commit(); render();
}

/** 加参考图：图片会上传到酒馆并马上编码；.naiv4vibe 文件直接读 */
async function addVibeFiles(gid, files) {
    const d = getData();
    const g = d.vibeGroups[gid];
    if (!g) return;
    for (const f of files) {
        try {
            if (/\.(naiv4vibe|json)$/i.test(f.name)) {
                const v = N.parseVibeFile(JSON.parse(await f.text()));
                let path = '';
                if (v.image) { const du = v.image.startsWith('data:') ? v.image : 'data:image/png;base64,' + v.image; path = (await uploadImage(await shrinkDataUrl(du, 512), `vibe_${M.uid('')}`)).path; }
                g.vibes.push({ id: M.uid('vb_'), name: v.name || f.name.replace(/\.\w+$/, ''), path: '', thumb: path ? '/' + path : '', strength: v.strength, info: v.info, encodings: v.encodings });
            } else {
                const du = await shrinkDataUrl(await fileToDataUrl(f), 1024, 0.92);
                const { path } = await uploadImage(du, `vibe_${M.uid('')}`);
                const v = { id: M.uid('vb_'), name: f.name.replace(/\.\w+$/, ''), path, strength: 0.6, info: 1, encodings: {} };
                g.vibes.push(v); commit();
                toastr.success(`已加上「${v.name}」${files.length > 1 ? `（${files.indexOf(f) + 1}/${files.length}）` : ''}`, '氛围', { timeOut: 1500 });
                if (N.vibeSupported() && N.isReady()) {
                    toastr.info(`正在编码「${v.name}」…`, '氛围', { timeOut: 1500 });
                    try { v.encodings[N.encKey()] = await N.encodeVibe(du.split(',')[1], 1); }
                    catch (e) { toastr.warning('先存下了，编码失败：' + e.message + '。生图时会再试。', '氛围'); }
                }
            }
            commit();
        } catch (e) { toastr.error(`${f.name}：${e.message}`, '加不进去'); }
    }
}

let vibeLoading = false;
async function queueVibeThumbs(groups) {
    if (vibeLoading) return;
    const ids = [...new Set(Object.values(groups).flatMap(g => (g.vibes || []).map(v => v.vibeDataId)))].filter(id => id && !vibeThumbCache.has(id));
    if (!ids.length) return;
    vibeLoading = true;
    let changed = false;
    for (const id of ids) {
        try {
            const j = await E.bridge().resolveVibeData(id);
            const u = j?.thumbnail || j?.image || '';
            vibeThumbCache.set(id, u ? (u.startsWith('data:') || u.startsWith('http') || u.startsWith('/') ? u : 'data:image/png;base64,' + u) : '');
            changed = true;
        } catch { vibeThumbCache.set(id, ''); }
    }
    vibeLoading = false;
    if (changed && ui.view === 'vibe') render();
}

// ═════════════════════ 大堂 ═════════════════════

const AUD = ['BL', 'BG', 'GB', 'GL'];
/** 共享用的标签：只能从这里选 */
const LOBBY_TAGS = [
    ['性向', ['男性向', '女性向', '全性向'], true],
    ['题材', ['BL', 'BG', 'GB', 'GL'], false],
    ['画风', ['厚涂', '半厚涂', '平涂', '赛璐璐', '水彩', '写实', '2.5D', '古风', '日系', '韩系', '欧美', '像素', 'Q版', '线稿', '暗黑', '清新', '柔和', '华丽'], false],
];
const ORIENT = LOBBY_TAGS[0][1];
const LOBBY_TAG_SET = new Set(LOBBY_TAGS.flatMap(g => g[1]));
function lobbyTagPicker(sel = []) {
    const on = new Set(sel);
    return LOBBY_TAGS.map(([title, list, single]) => `<div class="pc-field"><span>${title}${single ? '（必选一个）' : '（可多选）'}</span><div class="pc-chips wrap" data-tagset="${title}" ${single ? 'data-single' : ''}>${list.map(t => `<button type="button" class="pc-pill ${on.has(t) ? 'on' : 'dashed'}" data-tagpick="${esc(t)}">${esc(t)}</button>`).join('')}</div></div>`).join('');
}
function wireTagPicker(root) {
    root.addEventListener('click', ev => {
        const b = ev.target.closest('[data-tagpick]');
        if (!b) return;
        const set = b.closest('[data-tagset]');
        if (set?.hasAttribute('data-single')) set.querySelectorAll('[data-tagpick]').forEach(x => { if (x !== b) { x.classList.remove('on'); x.classList.add('dashed'); } });
        const now = !b.classList.contains('on');
        b.classList.toggle('on', now); b.classList.toggle('dashed', !now);
    });
}
const pickedTags = root => [...root.querySelectorAll('[data-tagpick].on')].map(b => b.dataset.tagpick);
/** 选标签的小窗：返回标签数组，取消返回 null */
function chooseLobbyTags(sel = []) {
    return new Promise(resolve => {
        const box = modal(`<h3 class="pc-h3">选标签</h3>${lobbyTagPicker(sel)}<p class="pc-dim small" data-tagerr></p>
          <div class="pc-actions"><button class="pc-btn" type="button" data-x="no">取消</button><button class="pc-btn dark" type="button" data-x="ok">好了</button></div>`);
        wireTagPicker(box);
        box.addEventListener('click', ev => {
            const x = ev.target.closest('[data-x]')?.dataset.x;
            if (x === 'no') { box.closeModal(); resolve(null); }
            if (x === 'ok') {
                const tags = pickedTags(box);
                if (!tags.some(t => ORIENT.includes(t))) { box.querySelector('[data-tagerr]').textContent = '先选一个性向：男性向、女性向或全性向'; return; }
                box.closeModal(); resolve(tags);
            }
        });
    });
}
/**
 * 共享只要画师串：留下 artist: 画师、带权重的画风词、质量和年份词；
 * 人物、动作、衣服、场景这些标签去掉（权重组里的逗号不拆开）
 */
const KEEP_STYLE = /^(?:masterpiece|best quality|amazing quality|high quality|good quality|very aesthetic|aesthetic|absurdres|highres|ultra[- ]detailed|detailed|newest|recent|year \d{4}|\d{4}s|no text|official art|illustration|painting|sketch|lineart|flat color|watercolor.*|water color.*|oil painting.*|realistic|photorealistic|semi-realistic|anime coloring|cel shading|chiaroscuro|.*lighting|.*rendering|depth of field|bokeh|.*shading|.*texture[s]?|.*style)$/i;
function artistOnly(text) {
    // Expand weighted groups before filtering so weighted people/scenery cannot slip through.
    return M.tokenize(String(text || '').replace(/\n/g, ', ')).flatMap(t => {
        const inner = M.tokenize(t.text);
        return inner.map(x => ({ ...x, weight: t.weight * x.weight }));
    }).filter(t => t.isArtist || KEEP_STYLE.test(t.text.replace(/_/g, ' ').trim()))
      .map(t => Math.abs(t.weight - 1) < 0.001 ? t.text : M.fmtWeight(t.weight) + '::' + t.text + '::').join(', ');
}
const lobbyBlock = () => { const o = getData().options; o.lobbyBlock ||= { users: [], posts: [] }; o.lobbyBlock.users ||= []; o.lobbyBlock.posts ||= []; return o.lobbyBlock; };
const KIND_NAME = { artist: '单个画师', group: '画师组', character: '角色', outfit: '服装' };
function viewLobby(d) {
    const lb = ui.lobby;
    if (!L.serverBase()) return `<section class="pc-card pc-pad"><h2 class="pc-h2">共享</h2>
      <p>还没填共享服务器地址。到设置里填上就能用。</p>
      <button class="pc-btn dark" data-act="nav" data-view="settings">去设置</button></section>`;
    const blocked = new Set(d.blockedTags || []);
    const view = d.options.lobbyView || 'grid';
    const blk = lobbyBlock();
    const items = lb.items.filter(p => (p.mine || (!p.tags.some(t => blocked.has(t)) && !blk.users.includes(p.nickname) && !blk.posts.includes(p.id))) && (!lb.tag2 || p.tags.includes(lb.tag2)));
    const tags = lb.tags.map(t => t.tag).filter(t => t !== 'NSFW' && !AUD.includes(t) && !ORIENT.includes(t));
    for (const t of blocked) if (!tags.includes(t)) tags.push(t);
    return `
    <div class="pc-row-between pc-mt-s"><h2 class="pc-h2" style="margin:0">共享</h2><button class="pc-btn dark" data-act="lobbyupload" aria-label="上传画师串">＋ 上传</button></div>
    <div class="pc-toprow">
      <label class="pc-search"><span class="pc-sr">搜索共享</span>${ICON.search}<input data-bind="lobby.q" data-enter="lobbysearch" value="${esc(lb.q)}" placeholder="搜画师名、标签"></label>
      <div class="pc-vt"><button class="${view === 'grid' ? 'on' : ''}" data-act="lobbyview" data-v="grid" aria-label="网格">${SYM.grid}</button><button class="${view === 'list' ? 'on' : ''}" data-act="lobbyview" data-v="list" aria-label="列表">${SYM.list}</button></div>
    </div>
    <div class="pc-chips">
      ${[['', '全部'], ['group', '画师组'], ['artist', '单个画师'], ['character', '角色'], ['outfit', '服装']].map(([k, t]) => `<button class="pc-pill ${!lb.mine && lb.kind === k ? 'on' : 'dashed'}" data-act="lobbykind" data-kind="${k}">${t}</button>`).join('')}
      <button class="pc-pill ${lb.mine ? 'on' : 'dashed'}" data-act="lobbymine">我分享的</button>
    </div>
    <div class="pc-chips">
      ${[...ORIENT, ...AUD].map(t => `<button class="pc-pill ${lb.tag === t ? 'on' : 'dashed'}" data-act="lobbyaud" data-tag="${t}">${t}</button>`).join('')}
      <button class="pc-pill nsfw ${d.options.lobbyShowNsfw ? 'on' : 'dashed'}" data-act="nsfwtoggle" title="只管共享里别人的图，你自己的例图一直显示">NSFW ${d.options.lobbyShowNsfw ? '开' : '关'}</button>
    </div>
    ${tags.length ? `<div class="pc-chips">${tags.slice(0, 24).map(t => `<button class="pc-pill ${blocked.has(t) ? 'blocked' : lb.tag2 === t ? 'on' : 'dashed'}" data-act="lobbytag2" data-tag="${esc(t)}" data-lp="ltag">${blocked.has(t) ? '⊘ ' : ''}${esc(t)}</button>`).join('')}</div>
    <div class="pc-tip">点标签 = 只看这类　长按 = 屏蔽，带这个标签的都不显示</div>` : ''}
    <div class="pc-sort"><button class="${lb.sort === 'new' ? 'on' : ''}" data-act="lobbysort" data-sort="new">最新</button><button class="${lb.sort === 'hot' ? 'on' : ''}" data-act="lobbysort" data-sort="hot">最多人保存</button><button data-act="lobbyrefresh">刷新</button></div>
    ${lb.error ? `<div class="pc-card pc-pad pc-mt">连不上共享服务器：${esc(lb.error)}</div>` : ''}
    ${lb.loading && !lb.items.length ? '<div class="pc-tip pc-mt">加载中…</div>' : ''}
    ${view === 'grid' ? `<div class="pc-grid2 pc-mt-s">${items.map(p => lobbyGridCard(p)).join('')}</div>` : `<div class="pc-list pc-mt">${items.map(p => lobbyCard(p)).join('')}</div>`}
    ${!lb.loading && !items.length ? '<div class="pc-empty pc-mt"><b>这里还没有东西</b><span>点右上角「＋ 上传」，填写画师串和署名就能发布。</span></div>' : ''}
    ${lb.items.length < lb.total ? '<button class="pc-btn pc-mt wide" data-act="lobbymore">加载更多</button>' : ''}
    <div style="height:24px"></div>`;
}

function lobbyGridCard(p) {
    const img = p.images[0];
    const banned = p.content?.artistString && M.bannedIn(getData(), p.content.artistString).length;
    return `<article class="pc-ticket ${p.copied ? 'saved' : ''} ${banned ? 'banned' : ''}" data-act="lobbyopen" data-id="${p.id}">${banned ? '<span class="pc-banbadge">含黑名单画师</span>' : ''}
      <div class="pc-ticket-img">${img ? `<img src="${esc(L.lobbyImgUrl(img.url))}" loading="lazy" alt="">` : '<span>无图</span>'}</div>
      <span class="pc-kind">${KIND_NAME[p.kind] || p.kind}</span>
      <button class="pc-use ${p.copied ? 'on dark' : ''}" data-act="lobbycopy" data-id="${p.id}" aria-label="保存">${p.copied ? SYM.check : SYM.down}</button>
      <div class="pc-ticket-text"><b>${esc(p.name)}</b><div class="pc-row-between pc-meta"><span>${esc(p.nickname)}</span><span>♡ ${p.likes} · ${p.copies} 存</span></div></div>
    </article>`;
}

/** 点卡片：看全部例图、画师串，保存 / 点赞 / 举报 */
function openLobbySheet(p) {
    DOC.querySelector('.pc-sheet-backdrop')?.remove();
    const back = DOC.createElement('div');
    back.className = 'pc-sheet-backdrop fresh'; setTimeout(() => back.classList.remove('fresh'), 400);
    const openedAt = Date.now();
    back.innerHTML = `<section class="pc-sheet" role="dialog">
      <div class="pc-sheet-grip" aria-hidden="true"></div>
      <div class="pc-row-between"><h3 class="pc-h3" style="margin:0">${esc(p.name)}</h3><span class="pc-dim small">${esc(p.nickname)} · ${KIND_NAME[p.kind] || p.kind}</span></div>
      ${p.images.length ? `<div class="pc-hscroll pc-mt-s">${p.images.map(i => `<img class="pc-sheet-img" src="${esc(L.lobbyImgUrl(i.url))}" alt="" data-act="viewimg" data-src="${esc(L.lobbyImgUrl(i.url))}">`).join('')}</div>` : ''}
      ${p.content?.artistString ? `<div class="pc-label">画师串</div><div class="pc-dim small mono" style="word-break:break-all;max-height:7.5em;overflow:auto;scrollbar-width:none">${markStr(getData(), p.content.artistString)}</div>${banWarn(getData(), p.content.artistString)}` : ''}
      ${p.content?.negative ? `<details class="pc-details pc-mt-s"><summary class="pc-dim small">负面（${p.content.negative.length} 字，点开看）</summary><div class="pc-dim small mono" style="word-break:break-all">${esc(p.content.negative)}</div></details>` : ''}
      ${p.note ? `<p class="pc-quote small">${esc(p.note)}</p>` : ''}
      <div class="pc-chips wrap">${p.tags.map(t => `<span class="pc-tagchip ${t === 'NSFW' ? 'nsfw' : ''}">${esc(t)}</span>`).join('')}</div>
      <div class="pc-actions wrap">
        ${p.mine ? `<button class="pc-btn danger" data-act="lobbydel" data-id="${p.id}">删除</button>` : `<button class="pc-btn" data-act="lobbyreport" data-id="${p.id}">举报</button><button class="pc-btn" data-act="lobbyblockpost" data-id="${p.id}">屏蔽这条</button><button class="pc-btn" data-act="lobbyblockuser" data-nick="${esc(p.nickname)}">屏蔽作者</button>`}
        <button class="pc-btn" data-act="lobbylike" data-id="${p.id}">♡ ${p.likes}</button>
        <button class="pc-btn dark" data-act="lobbycopy" data-id="${p.id}">${p.copied ? '已保存' : '保存到我的' + (p.kind === 'character' || p.kind === 'outfit' ? '角色' : '智库')}</button>
      </div></section>`;
    pcMount(back);
    back.addEventListener('click', async ev => {
        if (ev.target === back) { if (Date.now() - openedAt > 400) back.remove(); return; }
        const act = ev.target.closest('[data-act]');
        if (act) { await onClick({ target: act, stopPropagation() {} }, true); if (act.dataset.act !== 'viewimg') back.remove(); }
    });
}

function toggleBlockTag(tag) {
    const d = getData();
    d.blockedTags ||= [];
    const was = d.blockedTags.includes(tag);
    d.blockedTags = was ? d.blockedTags.filter(t => t !== tag) : [...d.blockedTags, tag];
    if (!was && ui.lobby.tag2 === tag) ui.lobby.tag2 = '';
    commit();
    toastr.info(was ? `不再屏蔽「${tag}」` : `已屏蔽「${tag}」，带这个标签的都不显示`, '共享', { timeOut: 2000 });
}

function lobbyCard(p) {
    const img = p.images[0];
    return `<article class="pc-lobby-card">
      <div class="pc-lobby-img" ${img ? `data-act="viewimg" data-src="${esc(L.lobbyImgUrl(img.url))}"` : ''}>${img ? `<img src="${esc(L.lobbyImgUrl(img.url))}" loading="lazy" alt="">` : '<span>无图</span>'}${p.images.length > 1 ? `<em>+${p.images.length - 1}</em>` : ''}</div>
      <div class="pc-lobby-text">
        <div class="pc-row-between"><span class="pc-label">${esc(p.nickname)} · ${KIND_NAME[p.kind] || p.kind}</span>
          ${p.mine ? `<button class="pc-icon-btn small" data-act="lobbydel" data-id="${p.id}" aria-label="删除我分享的">×</button>` : `<button class="pc-icon-btn small" data-act="lobbyreport" data-id="${p.id}" aria-label="举报">${ICON.flag}</button>`}</div>
        <b>${esc(p.name)}</b>
        <small>${esc(p.note || p.content?.artistString || '')}</small>
        <div class="pc-chips wrap tiny">${p.tags.map(t => `<span class="pc-tagchip ${t === 'NSFW' ? 'nsfw' : ''}">${esc(t)}</span>`).join('')}</div>
        <div class="pc-row-between">
          <button class="pc-linkish ${p.liked ? 'strong' : ''}" data-act="lobbylike" data-id="${p.id}">♡ ${p.likes}</button>
          <span class="pc-label">${p.copies} 人保存</span>
          <button class="pc-use static ${p.copied ? 'on dark' : ''}" data-act="lobbycopy" data-id="${p.id}" aria-label="保存">${p.copied ? SYM.check : SYM.down}</button>
        </div>
      </div>
    </article>`;
}

async function loadLobby({ more = false } = {}) {
    const lb = ui.lobby;
    if (!L.serverBase()) return;
    lb.loading = true; lb.error = '';
    if (!more) render();
    try {
        const [res, tags] = await Promise.all([
            L.listPosts({ sort: lb.sort, tag: lb.tag, kind: lb.kind || '', q: lb.q, nsfw: getData().options.lobbyShowNsfw, mine: lb.mine, offset: more ? lb.items.length : 0 }),
            more ? Promise.resolve(null) : L.listTags().catch(() => null),
        ]);
        lb.items = more ? [...lb.items, ...res.items] : res.items;
        lb.total = res.total;
        if (tags) lb.tags = tags.tags;
    } catch (e) {
        lb.error = e.message;
    }
    lb.loading = false;
    if (ui.view === 'lobby') render();
}

// ═════════════════════ 设置 ═════════════════════

/** 翻译 / AI 接口快速切换的一排 */
function apiChips(small = false) {
    const cur = T.activeApiId();
    return `<div class="pc-chips wrap">${[{ id: 'st', name: '酒馆当前的' }, ...T.apiProfiles()].map(p => `<button class="pc-pill ${small ? 'tiny' : ''} ${p.id === cur ? 'on' : 'dashed'}" data-act="apiuse" data-id="${esc(p.id)}">${esc(p.name)}</button>`).join('')}
      <button class="pc-pill ${small ? 'tiny' : ''} dashed" data-act="apinew">＋</button></div>`;
}

function setFold(key, title, status, body, open = false) {
    const isOpen = ui.setOpen[key] ?? open;
    return `<details class="pc-fold" data-sfold="${key}" ${isOpen ? 'open' : ''}><summary><b>${esc(title)}</b><i>${status}</i></summary><div class="pc-fold-in">${body}</div></details>`;
}

const illustrationEditor = createIllustrationEditor({
    getOptions: () => getData().options, getDraft: () => ui.illustPromptDraft, setDraft: value => { ui.illustPromptDraft = value; },
    commit, render, roster: () => C.currentCast(), settings: () => __mod_marker.settings(), context: () => SillyTavern.getContext(),
    lastRequest: () => illustrationLastRequest, notify: message => toastr.success(message, '智库'),
    showRequest: (request, title) => {
        const text = request.mode === 'inline' ? request.injection : 'SYSTEM\n' + request.system + '\n\nUSER\n' + request.user;
        const box = modal(`<h3 class="pc-h3">${esc(title)}</h3><p class="pc-hint">${request.mode === 'inline' ? '这里是智库注入的完整内容；酒馆另行组合聊天预设与对话。' : '这是正文转画面方案的完整 system / user 内容。'}不包含 API 密钥。</p><pre class="pc-illust-request">${esc(text)}</pre><button class="pc-btn dark" data-illclose>关闭</button>`);
        box.querySelector('[data-illclose]').onclick = () => box.closeModal();
    },
});

function viewSettings(d) {
    const sw = (key, text, small = '') => `<label class="pc-switch"><input type="checkbox" data-opt="${key}" ${d.options[key] ? 'checked' : ''}><span></span>${esc(text)}${small ? `<small>${esc(small)}</small>` : ''}</label>`;
    const n = settingsST();
    const modeBtn = (v, t) => `<button class="${n.naiMode === v ? 'on' : ''}" data-act="naimode" data-mode="${v}">${t}</button>`;
    const naiStatus = ui.naiTest ? `${ui.naiTest.warn ? '!' : ui.naiTest.ok ? '✓' : '✗'} ${esc(ui.naiTest.text)}` : N.isReady() ? '已填好' : '<span class="pc-warn-text">还没填 key</span>';
    const nai = setFold('nai', 'NovelAI', naiStatus, `
      <div class="pc-seg three">${modeBtn('key', '填我的 key')}${modeBtn('tavern', '用酒馆里的')}${modeBtn('site', '第三方站点')}</div>
      ${n.naiMode === 'key' ? `
      <label class="pc-field"><span>NovelAI key</span>
        <div class="pc-keyrow"><input data-st="naiKey" type="${ui.showKey ? 'text' : 'password'}" value="${esc(n.naiKey)}" placeholder="pst-…" autocomplete="off"><button class="pc-pill dashed" data-act="togglekey">${ui.showKey ? '藏起来' : '显示'}</button></div></label>
      <div class="pc-hint">在 NovelAI 网页：左上角菜单 → Account Settings → Get Persistent API Token，复制过来。</div>` : ''}
      ${n.naiMode === 'tavern' ? '<div class="pc-hint">用酒馆「API 连接」里 NovelAI 那一栏填好的 key。走这条路时不能分角色、不能用氛围和角色参考、不能局部重绘。</div>' : ''}
      ${n.naiMode === 'site' ? `
      <label class="pc-field"><span>站点地址</span><input data-st="naiSite" value="${esc(n.naiSite)}" placeholder="https://…"></label>
      <label class="pc-field"><span>站点给的 key</span><input data-st="naiSiteKey" type="password" value="${esc(n.naiSiteKey)}"></label>
      <label class="pc-switch"><input type="checkbox" data-st-check="naiSiteSimple" ${String(n.naiSiteSimple) === 'true' ? 'checked' : ''}><span></span>中转站兼容模式<small>生图页正常、聊天里出图却是满屏噪点 / 乱码图时打开：几个人的外貌合成一段发，不带长相参考图（有些中转站不支持分角色和角色参考）。漫画不受影响。</small></label>` : ''}
      <div class="pc-row-between pc-mt-s"><button class="pc-btn dark" data-act="naitest">测试</button><span class="${ui.naiTest?.ok && !ui.naiTest?.warn ? '' : 'pc-warn-text'}">${ui.naiTest ? (ui.naiTest.warn ? '! ' : ui.naiTest.ok ? '✓ ' : '✗ ') + esc(ui.naiTest.text) : ''}</span></div>
      <label class="pc-field"><span>模型</span><select data-st="novelaimode">${N.MODELS.map(([v, t]) => `<option value="${v}" ${v === n.novelaimode ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
      <details class="pc-details"><summary>更多生图参数</summary>${paramFields(n, { withSize: true })}
        <label class="pc-switch"><input type="checkbox" data-st-check="addFurryDataset" ${String(n.addFurryDataset) === 'true' ? 'checked' : ''}><span></span>兽人数据集（fur dataset）</label></details>`, !N.isReady());

    const cur = T.activeApiId();
    const prof = T.apiProfiles().find(x => x.id === cur);
    const ai0 = setFold('ai', '翻译和 AI', esc(T.currentApi().from) + (T.currentApi().model ? ' · ' + esc(T.currentApi().model) : ''), `
      <div class="pc-dim small">翻译、补全细节、读角色外貌、聊天生图都用这个。点一下就切换，可以存好几个。</div>
      ${apiChips()}
      ${prof ? `
      <label class="pc-field"><span>名字</span><input data-api="name" value="${esc(prof.name)}"></label>
      <label class="pc-field"><span>API 地址（要带 /v1 这类后缀）</span><input data-api="url" value="${esc(prof.url)}" placeholder="https://api.xxx.com/v1"></label>
      <label class="pc-field"><span>API Key</span><input data-api="key" type="password" value="${esc(prof.key)}"></label>
      <label class="pc-field"><span>模型</span>
        ${ui.transModels?.length ? `<select data-api="model">${ui.transModels.map(m => `<option ${m === prof.model ? 'selected' : ''}>${esc(m)}</option>`).join('')}</select>`
            : `<input data-api="model" value="${esc(prof.model)}" placeholder="先点「拉取模型」，或者直接填">`}</label>
      <label class="pc-switch"><input type="checkbox" data-api-check="bypass" ${prof.bypass ? 'checked' : ''}><span></span>不通过酒馆转发<small>一般不用开。只有 API 支持浏览器直接访问时才开。</small></label>
      <div class="pc-actions wrap"><button class="pc-btn" data-act="transmodels">拉取模型</button><button class="pc-btn" data-act="transtest">测试</button><button class="pc-linkdanger" data-act="apidel">删掉这个</button></div>`
        : `<div class="pc-actions wrap"><button class="pc-btn" data-act="transtest">测试</button></div>`}`);

    const aipFold = setFold('aip', 'AI 预设', (() => { const c = T.aiCfg(), a = c.active ?? 'tavern:'; return a === 'plain' ? '不套预设' : a.startsWith('tavern:') ? '跟酒馆预设' : esc(c.list[a]?.name || ''); })(), `
      <div class="pc-dim small">AI 发出去的结构：系统 / 用户 / 助手条目，可以直接跟酒馆的预设走；每个功能还能单独选 API 和模型。</div>
      <div class="pc-actions wrap" style="margin-top:6px"><button class="pc-btn dark" data-act="nav" data-view="aipreset">打开 AI 预设</button></div>`);
    const dlo = dlOpts();
    const opt = (v, t, cur) => `<option value="${v}" ${cur === v ? 'selected' : ''}>${t}</option>`;
    const dlFold = setFold('dl', '下载和水印', [dlo.strip ? '读不出画师串' : '', dlo.on ? '水印「' + esc(dlo.text) + '」' : ''].filter(Boolean).join(' · ') || '原图下载', `
      <div class="pc-dim small">看大图、生图结果、历史生图、漫画里点「下载」都按这里来。原图在智库里不变。</div>
      <label class="pc-field"><span>手机上点下载</span><select data-optstr="dlMode">${opt('auto', '自动：iPhone 弹分享面板，安卓存进 Download', dlo.mode)}${opt('share', '总是弹分享面板（选「存储图像」进相册）', dlo.mode)}${opt('file', '总是下载成文件', dlo.mode)}</select></label>
      <div class="pc-hint">iPhone 下载的文件在「文件」App 里，不进相册；要进相册得从分享面板点「存储图像」。安卓下载的在 Download 文件夹，相册一般有「Download / 下载」相簿。</div>
      ${sw('dlStrip', '下载的图读不出画师串', 'NovelAI 原图里藏着正面、负面和画师串，别人拖进读图工具就能看到。开了以后下载的图会去掉这些。')}
      ${sw('dlMark', '下载的图打水印', '填了文字才会打。打水印也会顺带去掉图里的提示词。')}
      <label class="pc-field"><span>水印文字</span><input data-optstr="dlMarkText" maxlength="60" value="${esc(dlo.text)}" placeholder="比如 @if love"></label>
      <div class="pc-row" style="gap:8px;flex-wrap:wrap">
        <label class="pc-field" style="flex:1;min-width:120px"><span>位置</span><select data-optstr="dlMarkPos">${opt('br', '右下', dlo.pos)}${opt('bl', '左下', dlo.pos)}${opt('tr', '右上', dlo.pos)}${opt('tl', '左上', dlo.pos)}${opt('c', '正中', dlo.pos)}${opt('tile', '斜着铺满', dlo.pos)}</select></label>
        <label class="pc-field" style="flex:1;min-width:120px"><span>不透明度</span><input type="range" min="0.1" max="1" step="0.05" data-optstr="dlMarkAlpha" value="${dlo.alpha}"></label>
        <label class="pc-field" style="flex:1;min-width:120px"><span>字号</span><input type="range" min="1" max="10" step="0.5" data-optstr="dlMarkSize" value="${dlo.size}"></label>
      </div>
      <div class="pc-actions wrap"><button class="pc-btn" data-act="dlmarkpreview">看看效果</button></div>`);
    const ai = ai0 + aipFold + dlFold;
    const tpl = setFold('tpl', '例图提示词', '头像 · 胸像 · 立绘', `
      <div class="pc-dim small">头像 1:1、胸像 3:4、立绘 9:16，SFW 和 NSFW 各一套。</div>
      <button class="pc-btn pc-mt-s" data-act="edittplid" data-tpl="sfw_head">编辑例图提示词</button>`);

    const marker=__mod_marker.settings();
    const chat = setFold('chat', '文生图标记', marker.auto ? '识别标记后自动生成' : '手动识别标记', `
      ${sw('markerAuto', '开启标记自动生图', '默认开启 · 回复出现完整生图标记时自动生成，提示词默认折叠')}${sw('imageExpanded', '图片默认展开', '开启：默认展开；关闭：默认折叠。立即应用到当前图片，并记住选择。')}${sw('charAutoBlocks', '从回复自动建档 / 记录外貌变化', '解析回复里的 &lt;人物&gt; / &lt;外貌变化&gt;，按楼层生效；全局角色只读')}${sw('charBlockToast', '建档时提示', '每楼最多一条小提示')}${sw('markerResultExpand', '生成后自动展开图片', '默认开启 · 这次新生成的图直接展开，历史图片仍然收起')}${sw('markerStream', '流式预生成', '默认开启 · 回复还在流、标记一写完整就先发生图请求，正文写完时图片往往已经好了')}
      <div class="pc-hint">用开始与结束标记包住提示词，例如 <code>${esc(marker.start)}1boy, solo, sunset${esc(marker.end)}</code>。只生成标记里的画面，图片放在原位置；没有标记的回复不生图。</div>
      <label class="pc-field"><span>开始标记（前缀）</span><input data-optstr="imageStartTag" value="${esc(marker.start)}" placeholder="image###"></label>
      <label class="pc-field"><span>结束标记</span><input data-optstr="imageEndTag" value="${esc(marker.end)}" placeholder="###"></label>
      <div class="pc-hint">逐图调用角色：在图片提示词内写 $名字-sfw-upperbody$，也支持智绘姬 JSON 角色标记；名字可以是角色页登记的别名，本聊天建档的角色按楼层生效。只补这张图指定角色的外貌和参考图；纯英文标签照常使用。使用外部生图预设时，请在该预设中加入逐图角色标记规则。<br>已内置「智库 · 生图标记不发送」正则：过滤发送给聊天模型的生图标记，不影响生图读取。修改标记时自动同步。</div>
      ${sw('chatNoSplit', '聊天插图不分人物', '打开：几个人的描写都合并进正面（和生图页一样），画师串和质量词作用到所有内容，画风更稳；代价是人物特征可能串（比如发色互换）。关闭：用 NovelAI 4.5 的分人物提示词，人物更不容易混，但画风可能变弱。')}
      <label class="pc-field"><span>聊天生图额外正面词 · 每张都加在场景后面</span><textarea class="pc-textarea small mono" data-optstr="chatPositive" placeholder="比如 masterpiece, best quality, ultra-detailed, illustration, detailed background, cinematic lighting">${esc(d.options.chatPositive || '')}</textarea></label>
      <div class="pc-hint">生图页的「固定提示词」只在生图页用，不会带进聊天。生图页更精致、聊天里出图更糙的话，把固定提示词里的画质、画风、光影词（不要写人物外貌和人数）复制到这里。</div>
      <label class="pc-field"><span>聊天生图额外负面词</span><input data-optstr="chatNegative" value="${esc(d.options.chatNegative || '')}"></label>
      <div class="pc-row-between pc-mt-s"><b>正文自动插图</b><span class="pc-dim small">点击正文段落即可确认生图</span></div>
      <div class="pc-seg three">${[['off', '关'], ['inline', '跟正文一起写'], ['after', '写完再请求']].map(([v, t]) => `<button class="${(d.options.illustMode || 'off') === v ? 'on' : ''}" data-act="illmode" data-mode="${v}">${t}</button>`).join('')}</div>
      <div class="pc-hint">${d.options.illustMode === 'inline' ? '每次发消息时告诉聊天 AI：在有画面感的地方顺手写一行生图标记。不多花请求，但要模型听话；破限或预设管得很死的话可能不写。' : d.options.illustMode === 'after' ? '回复写完后，用「AI」设置里选的 API 另外请求一次，先整理瞬间、人物姿势和镜头构图，再转成标签插回正文。多一次请求，但不改聊天 AI 的输出，跟智绘姬的「自动 LLM 请求生图」一样。' : '打开后不用自己写标记，回复里会自动出现生图标记，再按上面的开关自动出图。'}</div>
      ${d.options.illustMode && d.options.illustMode !== 'off' ? `<label class="pc-field"><span>每条回复最多几张 · 自行填写</span><input type="number" min="1" step="1" inputmode="numeric" data-illmax value="${esc(d.options.illustMax ?? 1)}"></label>` : ''}`);

    const illustEditor = renderIllustrationEditor(d.options, ui.illustPromptDraft, !!illustrationLastRequest, esc);
    const nightMode = d.options.nightMode || 'day';
    const look = setFold('look', '外观', { day: '日间', night: '夜间', auto: '跟随酒馆' }[nightMode] || '日间', `
      <div class="pc-seg three">${[['day', '日间'], ['night', '夜间'], ['auto', '跟随酒馆']].map(([v, t]) => `<button class="${nightMode === v ? 'on' : ''}" data-act="nightmode" data-mode="${v}">${t}</button>`).join('')}</div>
      ${nightMode !== 'day' ? `<div class="pc-dim small pc-mt-s">夜间配色</div><div class="pc-chips wrap">${[['mono', '黑与白', '#131112', '#e6e6e6'], ['sea', '黑蓝深海', '#101828', '#8fb0dc']].map(([v, t, bg, ac]) => `<button class="pc-pill ${(['mono', 'sea'].includes(d.options.nightTheme) ? d.options.nightTheme : 'mono') === v ? 'on' : 'dashed'}" data-act="nighttheme" data-theme="${v}"><span style="display:inline-block;width:14px;height:14px;border-radius:50%;background:${bg};box-shadow:inset 0 0 0 4px ${ac};margin-right:6px;vertical-align:-2px"></span>${t}</button>`).join('')}</div>` : ''}
      <div class="pc-hint">「跟随酒馆」：酒馆用深色主题时自动换成夜间，每次打开智库时检查一次。</div>`);

    const entry = setFold('entry', '入口', ['魔棒', d.options.showStub ? '小票根' : '', d.options.showChip ? '输入框上方' : ''].filter(Boolean).join(' · '), `
      ${sw('showStub', '界面上显示小票根', '点一下切换画师串，长按打开画师库，可以上下拖动')}
      ${sw('showChip', '聊天输入框上方显示当前画师串')}
      <div class="pc-hint">魔棒菜单里一直有「画师库」。</div>`);

    const share = setFold('share', '共享', L.serverBase() ? `${esc(d.lobby.nickname || '没起昵称')} · 屏蔽 ${(d.blockedTags || []).length} 个标签` : '没填服务器', `
      <label class="pc-field"><span>服务器地址</span><input data-lobby="server" value="${esc(d.lobby.server)}" placeholder="https://你的域名"></label>
      <label class="pc-field"><span>分享署名</span><input data-lobby="nickname" maxlength="24" value="${esc(d.lobby.nickname)}"></label>
      <label class="pc-field"><span>邀请码（服务器要求时才填）</span><input data-lobby="invite" value="${esc(d.lobby.invite)}"></label>
      <div class="pc-actions wrap"><button class="pc-btn" data-act="lobbytest">测试连接</button></div>
      ${label('屏蔽的标签')}
      <div class="pc-chips wrap">${(d.blockedTags || []).map(t => `<button class="pc-pill blocked" data-act="unblock" data-tag="${esc(t)}">⊘ ${esc(t)}</button>`).join('') || '<span class="pc-dim small">没有。在共享页长按标签就能屏蔽。</span>'}${(d.blockedTags || []).length ? '<button class="pc-pill dashed" data-act="unblockall">全部取消</button>' : ''}</div>
      ${label('屏蔽的作者')}
      <div class="pc-chips wrap">${lobbyBlock().users.map(n => `<button class="pc-pill blocked" data-act="unblockuser" data-nick="${esc(n)}">⊘ ${esc(n)}</button>`).join('') || '<span class="pc-dim small">没有。在共享里点开一条，点「屏蔽作者」。</span>'}</div>
      ${lobbyBlock().posts.length ? `<div class="pc-actions wrap"><span class="pc-dim small">屏蔽了 ${lobbyBlock().posts.length} 条分享</span><button class="pc-pill dashed" data-act="unblockposts">全部恢复</button></div>` : ''}`);

    const bl = Object.entries(d.blacklist || {});
    const ban = setFold('ban', '画师黑名单', bl.length ? `${bl.length} 位` : '没有', `
      <div class="pc-dim small">拉黑的画师会在画师串里标红，批量生成例图时自动跳过。</div>
      ${bl.map(([k, b]) => `<div class="pc-banrow"><b class="mono">${esc(b.tag.replace(/^artist:/, ''))}</b><button class="pc-banrow-note" data-act="banedit" data-key="${esc(k)}">${esc(b.note) || '加备注'}</button><button class="pc-x" data-act="unban" data-tag="${esc(b.tag)}" aria-label="取消拉黑">×</button></div>`).join('')}
      <button class="pc-pill dashed tiny pc-mt-s" data-act="banadd">＋ 拉黑画师</button>`);

    const data = setFold('data', '数据', '导出 · 导入' + (zSettings() ? ' · 从智绘姬搬' : ''), `
      <div class="pc-dim small" style="margin-top:0">生成的图存在哪（聊天标记、生图页、历史生图）</div>
      <div class="pc-seg pc-mt-s">${[['local', '本地浏览器'], ['server', '酒馆服务器']].map(([v, t]) => `<button class="${(d.options.imageStore || 'local') === v ? 'on' : ''}" data-act="imgstore" data-mode="${v}">${t}</button>`).join('')}</div>
      <div class="pc-hint">${(d.options.imageStore || 'local') === 'server' ? '存在酒馆的 user/images 里，换设备也能看到；共用服务器、人多的话会占很多空间。' : '存在这台设备的浏览器里，不占酒馆服务器。换设备、换浏览器或清除浏览器数据后就看不到了，需要的图记得下载。'}只影响以后生成的图。</div>
      <div class="pc-hint">画师库存在酒馆的 user/files/piaoce_data.json，例图在 user/images/piaoce/，换设备也在。</div>
      <div class="pc-actions wrap">
        ${zSettings() ? '<button class="pc-btn" data-act="importfixed">从智绘姬搬过来</button>' : ''}
        <button class="pc-btn" data-act="exportdata">导出</button>
        <label class="pc-btn">导入<input type="file" accept=".json,application/json" data-importdata hidden></label>
        <label class="pc-btn">导入画师串包<input type="file" accept=".json,application/json" multiple data-importpack hidden></label>
      </div>
      <div class="pc-hint">「导入画师串包」用来导入场外脚本 zhiku-artist-pack 生成的画师串和例图，只往画师库里加，不会替换现有的；可以一次选多个文件。</div>`);

    const comicOn = !!d.options.comicOn;
    const comic = setFold('comic', '漫画', comicOn ? '开着' : '关着', `
      ${sw('comicOn', '漫画模式', '认出回复里的 <image>@page…</image> 漫画页，按页画出来存在这一楼')}
      <div class="pc-hint">画风、颜色、对白、尺寸、每楼几页、改编要求和负面，都在顶上「漫画」那一页调。楼层按钮里的 📖「画成漫画」不开漫画模式也能用。</div>
      <div class="pc-hint">配合「酒馆看漫画」预设（漫画台）用时，<b>先把预设里自带的「漫画台」脚本关掉</b>，不然两边各画一遍、扣两次点。</div>
      <div class="pc-actions wrap"><button class="pc-btn dark" data-act="nav" data-view="comic">打开漫画设置</button><button class="pc-btn" data-act="comicbook">翻看这个聊天的漫画</button></div>`);
    const about = setFold('about', '关于', '智库 v' + (globalThis.__PC_VERSION || ''), `
      <style>.pc-about-card{text-align:center;padding:22px 10px 10px;border-radius:16px;background:radial-gradient(circle at 50% 0,rgba(201,138,62,.22),transparent 70%)}.pc-about-name{font-family:var(--pc-font-name);font-size:34px;font-weight:800;letter-spacing:.3em;padding-left:.3em;color:var(--pc-ink)}.pc-about-card .pc-subtitle{font-size:13px;margin-top:4px}.pc-about-ver{display:block;margin-top:12px;font:11px var(--pc-font-label);letter-spacing:.25em;color:var(--pc-ink-soft);text-transform:uppercase}.pc-about-card .pc-actions{justify-content:center;margin-top:14px}.pc-about-note{text-align:center;font-size:12px;color:var(--pc-ink-soft);margin-top:12px;line-height:1.7}</style>
      <div class="pc-about-card"><div class="pc-about-name">智库</div><div class="pc-subtitle">二改自从前佬的智绘姬</div>
        <span class="pc-about-ver">v${esc(globalThis.__PC_VERSION || '')} · if love</span>
        <div class="pc-actions wrap"><a class="pc-btn dark" href="https://github.com/ruoege49-ship-it/zhiku-tavern-helper" target="_blank" rel="noopener">仓库 / 更新</a><a class="pc-btn" href="https://github.com/damoshen123/st-chatu8" target="_blank" rel="noopener">智绘姬原仓库</a></div></div>
      <div class="pc-about-note">看图提取需要能识图的模型 · 原脚本 AFPL v9，署名保留</div>
      <div class="pc-about-note">漫画模式的页面协议和玩法来自「漫画台」预设 · 作者 小鸟游星野（Discord：__takanashi_hoshino__）</div>`);

    return `<h2 class="pc-pagetitle">设置</h2>${nai}${ai}${chat}${setFold('illprompt', '正文转生图提示词', d.options.illustPrompt ? '自己改过' : '默认', illustEditor)}${tpl}${look}${entry}${share}${ban}${data}${comic}${about}<div style="height:24px"></div>`;
}

/** 漫画页：漫画设置直接摊开，外加翻看漫画书 */
function viewComic(d) {
    return `<h2 class="pc-pagetitle">漫画</h2>
      <section class="pc-card pc-pad"><div class="pc-dim small">AI 读楼层的正文改编成漫画，再用 NAI 一页页画出来。楼层按钮里的 📖「画成漫画」、漫画书「目录」里都能挑一楼画。</div>
        <div class="pc-dim small" style="margin-top:6px;opacity:.8">漫画协议和玩法来自「漫画台」预设，作者 小鸟游星野（__takanashi_hoshino__）。</div>
        <div class="pc-actions wrap"><button class="pc-btn dark" data-act="comicbook">翻看这个聊天的漫画</button></div></section>
      <section class="pc-card pc-pad pc-mt"><h3 class="pc-h3">漫画设置</h3><div id="pc-comic-view"></div></section>
      <div style="height:24px"></div>`;
}
function viewChatLib() {
    const d = getData();
    const merged = C.mergedChatEntries();
    const locked = C.chatLockedNames();
    const srcTag = (sources, key) => sources[key] === 'global' ? '（来自全局）' : sources[key] === 'union' ? '（合并）' : '';
    const rows = merged.map(({ entry, sources }) => `<div class="pc-who">
      <div class="pc-grow"><b>${esc(entry.name)}</b><small>${entry.source === 'ai' ? 'AI 建档' : '手动'} · ${esc(C.tagText(entry.appearance)) || '（没有外貌）'}${entry.outfitMode === 'fixed' ? ` · 固定衣服${srcTag(sources, 'outfit')}` : ''}${entry.nl ? ` · 描述${srcTag(sources, 'nl')}` : ''}${sources.aliases === 'union' ? ' · 别名（合并）' : ''}</small></div>
      <div class="pc-chips wrap">
        <button class="pc-pill dashed tiny" data-act="chatlibedit" data-name="${esc(entry.name)}">编辑</button>
        <button class="pc-pill dashed tiny" data-act="chatlibhist" data-name="${esc(entry.name)}">历史</button>
        <button class="pc-pill dashed tiny" data-act="chatlibpromote" data-name="${esc(entry.name)}">提升为全局</button>
        <button class="pc-pill dashed tiny danger" data-act="chatlibdel" data-name="${esc(entry.name)}">删除</button>
      </div></div>`).join('');
    const lockedRows = Object.values(d.characters || {}).filter(c => locked.has(c.name)).map(c => `<div class="pc-who">
      <div class="pc-grow"><b>${esc(c.name)}</b><small>全局库 · 固定，不可改${c.nl ? ' · 有描述' : ''}</small></div>
      <button class="pc-pill dashed tiny" data-act="chatlibcopy" data-key="${esc(c.key || '')}">复制到本聊天</button></div>`).join('');
    return `<div class="pc-dhead"><button class="pc-round" data-act="nav" data-view="cast" aria-label="返回">‹</button><div class="pc-grow"><h2 class="pc-dtitle">本聊天角色</h2><div class="pc-tip" style="margin:0">按楼层重放：改档只影响它之后的楼层；空字段回落到同名全局角色。</div></div></div>
    <section class="pc-card pc-pad pc-mt"><div class="pc-row-between"><b>本聊天档案</b><button class="pc-pill dashed tiny" data-act="chatlibnew">＋ 新建</button></div>
    ${rows || '<div class="pc-dim small">还没有本聊天角色。AI 回复里写 &lt;人物&gt; 就会自动建档。</div>'}</section>
    <section class="pc-card pc-pad pc-mt"><b>全局角色（固定）</b><div class="pc-dim small">AI 不会改全局角色；想要它在本聊天可改，就复制一份到本聊天。</div>${lockedRows || '<div class="pc-dim small">没有全局角色</div>'}</section>
    <div style="height:24px"></div>`;
}

function viewChatHist() {
    const entry = C.chatLatest().find(e => e.name === ui.chatHistName) || C.chatBaseEntries().find(e => e.name === ui.chatHistName);
    const history = entry?.history || [];
    const FIELD = { new: '建档', appearance: '外貌', outfit: '服装', nl: '描述', manual: '手动' };
    const rows = history.map((h, i) => `<div class="pc-who">
      <div class="pc-grow"><b>${h.floor >= 0 ? `第 ${h.floor + 1} 楼` : '手动'} · ${esc(h.reason || '变化')} · ${FIELD[h.field] || esc(h.field)}</b><small>${esc(h.from || '（无）')} → ${esc(h.to || '（无）')}</small></div>
      <button class="pc-pill dashed tiny" data-act="chatlibrollback" data-name="${esc(entry?.name || ui.chatHistName)}" data-index="${i}">回到这里</button></div>`).join('');
    return `<div class="pc-dhead"><button class="pc-round" data-act="nav" data-view="chatlib" aria-label="返回">‹</button><div class="pc-grow"><h2 class="pc-dtitle">${esc(ui.chatHistName || '')} · 档案历史</h2></div></div>
    <section class="pc-card pc-pad pc-mt">${rows || '<div class="pc-dim small">还没有记录。</div>'}</section>
    <div class="pc-hint">「回到这里」会把当时的字段写成手动值（手动值优先，AI 之后的改动仍会记在历史里）。</div>`;
}

const VIEWS = { comfy: viewComfy, chatlib: viewChatLib, charhist: viewChatHist, aipreset: viewAiPreset, comic: viewComic, cast: viewCast, charedit: viewCharEdit, outfit: viewOutfit, studio: viewStudio, book: viewBook, artist: viewArtist, group: viewGroup, batch: viewBatch, vibe: viewVibe, lobby: viewLobby, settings: viewSettings };

// ═════════════════════ 事件 ═════════════════════

/** 手机上轻轻震一下（iPhone 不支持就算了） */
function buzz() { try { DOC.defaultView?.navigator?.vibrate?.(8); } catch { /* 不支持 */ } }

// 长按
const lp = { timer: 0, fired: 0, x: 0, y: 0 };
function onPointerDown(ev) {
    const t = ev.target.closest?.('[data-lp]');
    if (!t || (ui.selecting && t.dataset.lp === 'ticket')) return;
    lp.x = ev.clientX; lp.y = ev.clientY;
    clearTimeout(lp.timer);
    lp.timer = setTimeout(() => {
        lp.fired = Date.now();
        if (t.dataset.lp === 'ticket') openTicketSheet(refFrom(t));
        else if (t.dataset.lp === 'col') tagMenu(t.dataset.col);
        else if (t.dataset.lp === 'ltag') toggleBlockTag(t.dataset.tag);
        else if (t.dataset.lp === 'vibe') vibeMenu(t.dataset.id);
        else if (t.dataset.lp === 'crgroup') crMenu(t.dataset.id);
    }, 520);
}
function cancelLongPress(ev) {
    if (ev.type === 'pointermove' && Math.hypot(ev.clientX - lp.x, ev.clientY - lp.y) < 10) return;
    clearTimeout(lp.timer);
}
function refFrom(el) { return { type: el.dataset.type, id: el.dataset.id }; }

async function onClick(ev, outside = false) {
    if (lp.fired && Date.now() - lp.fired < 600) { lp.fired = 0; ev.preventDefault?.(); return; }
    const el = ev.target.closest('[data-act]');
    if (!el || (!outside && !root.contains(el))) return;
    const act = el.dataset.act;
    buzz();
    const d = getData();
    try {
        if (await charAction(act, el)) return;
        switch (act) {
            case 'close': closeWindow(); break;
            case 'nav':
                ui.view = el.dataset.view; render();
                if (ui.view === 'lobby') loadLobby();
                root.querySelector('.pc-body')?.scrollTo(0, 0);
                break;
            case 'back': ui.view = ui.backTo || 'book'; render(); break;
            case 'booktab': ui.bookTab = el.dataset.tab; ui.picked.clear(); render(); break;
            case 'bookfilter': ui.bookFilter = el.dataset.f; render(); break;
            case 'open': {
                ev.stopPropagation();
                const r = refFrom(el);
                if (ui.view === 'book' && (d.options.detailMode || 'sheet') === 'sheet') { openTicketSheet(r); break; }
                ui.backTo = ['artist', 'group'].includes(ui.view) ? 'book' : ui.view;
                ui.view = r.type; ui.detailId = r.id; render();
                root.querySelector('.pc-body')?.scrollTo(0, 0);
                break;
            }
            case 'switcher': openSwitcher(); break;
            case 'pickartist': openSwitcher({ onPick: ref => { applyArtistToStudio(ref); render(); } }); break;
            case 'i2iresult': { const r = ui.studio.result; if (r && await loadI2i(r)) toastr.info('用这张垫图了，调一下重绘强度再生成', '垫图', { timeOut: 2000 }); break; }
            case 'i2ioff': ++i2iLoadSeq; ui.studio.i2i = { ...(ui.studio.i2i || {}), image: '' }; render(); break;
            case 'i2ifit': { const g = ui.studio.i2i; if (!g?.iw) break; const [w, h] = i2iFitSize(g.iw, g.ih); const n = N.settings(); n.novelai_width = String(w); n.novelai_height = String(h); N.save(); render(); break; }
            case 'studiosize': { const [w, h] = el.dataset.size.split('x'); const n = N.settings(); n.novelai_width = w; n.novelai_height = h; N.save(); render(); break; }
            case 'insertai': case 'replaceai': {
                const st = ui.studio;
                const add = st.promptEn.trim();
                if (!add) break;
                if (el.dataset.act === 'insertai') st.pos = M.mergeTags(st.pos, add);
                else {
                    const artists = M.tokenize(st.pos).filter(t => t.isArtist).map(t => Math.abs(t.weight - 1) < 0.001 ? t.text : `${M.fmtWeight(t.weight)}::${t.text}::`);
                    st.pos = M.mergeTags(artists.join(', '), st.lastExtra, add);
                }
                saveStudio(); render();
                toastr.success('已放进正面提示词', '生成图片');
                break;
            }
            case 'naimode': { const n = N.settings(); n.naiMode = el.dataset.mode; N.save(); ui.naiTest = null; render(); break; }
            case 'illprompt-save': case 'illprompt-default': case 'illprompt-preview': case 'illprompt-last':
                await illustrationEditor(act); break;
            case 'illmode': { getData().options.illustMode = el.dataset.mode; commit(); render(); break; }
            case 'nightmode': { getData().options.nightMode = el.dataset.mode; commit(); render(); break; }
            case 'newsampleseed': getData().options.sampleSeed = Math.floor(Math.random() * 4294967294) + 1; commit(); render(); break;
            case 'comicsize': getData().options.comicSize = el.dataset.size; commit(); render(); break;
            case 'comictext': getData().options.comicText = el.dataset.v; commit(); render(); break;
            case 'comicbook': globalThis.__zhikuComic?.openBook(); break;
            case 'comicsettings': globalThis.__zhikuComic?.openSettings(); break;
            case 'imgstore': { getData().options.imageStore = el.dataset.mode; commit(); render(); break; }
            case 'nighttheme': { getData().options.nightTheme = el.dataset.theme; commit(); render(); break; }
            case 'togglekey': ui.showKey = !ui.showKey; render(); break;
            case 'naitest': {
                el.disabled = true; el.textContent = '测试中…';
                N.save();
                ui.naiTest = await N.testConnection();
                render();
                break;
            }
            case 'lintfix': ui.studio.pos = lintPrompt(ui.studio.pos).fixed; saveStudio(); render(); toastr.success('改好了，发送前再看一眼', '智库', { timeOut: 2000 }); break;
            case 'clearresult': ui.studio.result = null; ui.studio.sent = null; render(); break;
            case 'histselect': { const h = ui.hist ||= { select: false, picked: [], show: 60 }; h.select = !h.select; h.picked = []; render(); break; }
            case 'histall': { const h = ui.hist; const all = histList().map(x => x.id || x.url); h.picked = h.picked.length === all.length ? [] : all; render(); break; }
            case 'histmore': { ui.hist.show += 60; render(); break; }
            case 'histopen': {
                const id = el.dataset.id, h = ui.hist ||= { select: false, picked: [], show: 60 };
                if (h.select) { h.picked = h.picked.includes(id) ? h.picked.filter(x => x !== id) : [...h.picked, id]; render(); break; }
                const x = histFind(id); if (x) histDetail(x);
                break;
            }
            case 'histdownload': { histDownload(ui.hist.picked.map(histFind).filter(Boolean)); break; }
            case 'histdelete': {
                const list = ui.hist.picked.map(histFind).filter(Boolean);
                if (!list.length || !(await confirmBox(`删掉选中的 ${list.length} 张？图片文件也会删掉，聊天里用到的地方会显示不出来。`, { ok: '删除', cancel: '算了' }))) break;
                histRemove(list); ui.hist.select = false; render(); break;
            }
            case 'histclean': {
                const days = Number(el.dataset.days), before = Date.now() - days * 86400000;
                const list = histList().filter(x => (x.at || 0) < before);
                if (!list.length) { toastr.info(`没有 ${days} 天前的图`, '历史生图'); break; }
                if (!(await confirmBox(`删掉 ${days} 天前的 ${list.length} 张图？图片文件也会删掉，聊天里用到的地方会显示不出来。`, { ok: '删除', cancel: '算了' }))) break;
                histRemove(list); render(); break;
            }
            case 'strtoggle': ui.strOpen[el.dataset.key] = !ui.strOpen[el.dataset.key]; render(); break;
            case 'addprefix': {
                const names = el.dataset.name ? [el.dataset.name] : guessBareArtists(d, ui.studio.pos);
                ui.studio.pos = addArtistPrefix(ui.studio.pos, names);
                saveStudio(); render();
                break;
            }
            case 'samplingpreset': {
                Object.assign(N.settings(), { novelai_sampler: 'k_dpmpp_2m_sde', Schedule: 'karras', cfg_rescale: '0.18', samplingDefaultsV2: true });
                N.save(); render(); break;
            }
            case 'clearstudio': {
                const st = ui.studio;
                if (!st.pos) break;
                st.clearUndo = st.pos; st.pos = '';
                saveStudio(); render(); break;
            }
            case 'undoclearstudio': {
                if (!ui.studio.clearUndo) break;
                if (ui.studio.pos.trim() && !(await confirmBox('恢复清空前的画师串？会替换现在的正面提示词'))) break;
                ui.studio.pos = ui.studio.clearUndo; ui.studio.clearUndo = null;
                saveStudio(); render(); break;
            }
            case 'saveartist': await saveStudioTicket(); break;
            case 'unticket': E.setActive(null); break;
            case 'use': {
                const r = refFrom(el);
                if (M.sameRef(r, d.active)) { toastr.info('正在用这个', '智库', { timeOut: 1500 }); break; }
                ui.stamp = true;
                E.setActive(r);
                toastr.success(`已切换到：${M.ticketName(d, r)}`, '智库', { timeOut: 1800 });
                break;
            }
            case 'register': openRegister(); break;
            case 'newcol': {
                const name = await promptText('新标签叫什么？', '');
                if (!name) break;
                const id = M.uid('c_');
                d.collections[id] = { id, name: name.slice(0, 20), createdAt: Date.now() };
                if (el.dataset.type) { const it = itemOf(d, refFrom(el)); it.collections ||= []; it.collections.push(id); }
                commit();
                break;
            }
            case 'togglecol': {
                const g = itemOf(d, refFrom(el));
                const c = el.dataset.col;
                g.collections ||= [];
                g.collections = g.collections.includes(c) ? g.collections.filter(x => x !== c) : [...g.collections, c];
                commit();
                break;
            }
            case 'fav': { const g = itemOf(d, refFrom(el)); g.fav = !g.fav; commit(); break; }
            case 'bookview': d.options.bookView = el.dataset.v; commit(); break;
            case 'tosheet': { const r = refFrom(el); d.options.detailMode = 'sheet'; commit({ silent: true }); ui.view = 'book'; render(); openTicketSheet(r); break; }
            case 'weight': {
                const g = d.groups[el.dataset.id];
                const m = g.members[Number(el.dataset.i)];
                m.weight = Math.max(0.05, Math.round((Number(m.weight) + Number(el.dataset.d)) * 100) / 100);
                commit();
                break;
            }
            case 'rmmember': {
                const g = d.groups[el.dataset.id];
                g.members.splice(Number(el.dataset.i), 1);
                commit();
                break;
            }
            case 'addmember': {
                const g = d.groups[el.dataset.id];
                const text = await promptText('加哪几位画师？（一行一位或逗号隔开，可以带权重）', '', true);
                if (!text) break;
                for (const m of M.parseArtistList(text)) {
                    const a = M.ensureArtist(d, m.tag);
                    if (!g.members.some(x => x.artistId === a.id)) g.members.push({ artistId: a.id, weight: m.weight });
                }
                commit();
                break;
            }
            case 'editstring': {
                const g = d.groups[el.dataset.id];
                if (!g) break;
                const text = await promptText('改写画师串', M.ticketString(d, {type:'group',id:g.id}), true);
                if (text == null) break;
                if (!text.trim()) { toastr.warning('画师串是空的，请先填写再保存', '智库'); break; }
                const mode = await chooseBox('保存画师串', ['覆盖原串：' + g.name, '另存为新画师串']);
                if (mode == null) break;
                if (mode === 0) M.overwriteGroup(d, {type:'group',id:g.id}, text, g.neg);
                else {
                    const name = await promptText('新画师串的名字', g.name + ' · 副本');
                    if (name == null) break;
                    const ref = M.createFromString(d, {name,text,neg:g.neg,forceGroup:true});
                    if (ref) { ui.detailId = ref.id; ui.view = 'group'; }
                }
                await commit({immediate:true});
                break;
            }
            case 'copytext':
                await P.navigator.clipboard.writeText(el.dataset.text || '');
                toastr.success('已复制', '', { timeOut: 1200 });
                break;
            case 'pickrating': (el.dataset.scope === 'batch' ? ui.batch : ui.sample).rating = el.dataset.v; render(); break;
            case 'pickshot': (el.dataset.scope === 'batch' ? ui.batch : ui.sample).shot = el.dataset.v; render(); break;
            case 'edittpl': await openTemplateEditor(chosenTemplates(el.dataset.scope || 'sample')[0] || 'sfw_bust'); break;
            case 'sample': { const r = refFrom(el); if (!ui.busyRefs.has(r.id)) openSamplePicker(r, render); break; }
            case 'samplemembers': {
                const g = d.groups[el.dataset.id];
                ui.batch.text = g.members.map(m => d.artists[m.artistId]?.tag).filter(Boolean).join('\n');
                ui.batch.rating = ui.sample.rating; ui.batch.shot = ui.sample.shot;
                ui.batch.state = null;
                ui.view = 'batch'; ui.backTo = 'group'; render();
                break;
            }
            case 'delimg': {
                const t = M.resolveTicket(d, refFrom(el));
                const img = t?.item.images.find(i => i.id === el.dataset.img);
                if (!img || !(await confirmBox('删掉这张例图？'))) break;
                t.item.images = t.item.images.filter(i => i !== img);
                commit();
                deleteImageFile(img.path);
                break;
            }
            case 'delete': {
                const r = refFrom(el);
                const name = M.ticketName(d, r);
                if (!(await confirmBox(r.type === 'group' ? `删除画师组「${name}」？组里的画师和他们的例图不会被删。` : `删除画师「${name}」？他的例图会一起删掉，也会从所有画师组里移出。`))) break;
                const t = M.resolveTicket(d, r);
                const imgs = t.item.images.slice();
                if (r.type === 'group') M.deleteGroup(d, r.id); else M.deleteArtist(d, r.id);
                if (M.sameRef(ui.studio.sourceRef, r)) { ui.studio.sourceRef = null; saveStudio(); }
                if (['artist', 'group'].includes(ui.view)) ui.view = 'book';
                DOC.querySelector('.pc-sheet-backdrop')?.remove();
                commit();
                imgs.forEach(i => deleteImageFile(i.path));
                break;
            }
            case 'viewimg': {
                const box = el.closest('.pc-card, .pc-sheet, .pc-grid2, .pc-hscroll, section') || root;
                const list = [...box.querySelectorAll('[data-act="viewimg"]')].map(x => x.dataset.src).filter(Boolean);
                openViewer(el.dataset.src, list);
                break;
            }
            case 'viewticket': {
                const t = M.resolveTicket(d, { type: el.dataset.type, id: el.dataset.id });
                if (!t) break;
                const imgs = [...t.item.images, ...(t.type === 'group' ? t.item.members.flatMap(m => d.artists[m.artistId]?.images || []) : [])];
                const list = [...new Set(imgs.map(imgUrl))]; // 自己的图，NSFW 也给看
                openViewer(list[0], list);
                break;
            }
            case 'generate': await doGenerate(); break;
            case 'castopen': openCastPicker(); break;
            case 'aipuse': { const cfg = T.aiCfg(); cfg.active = el.dataset.v; commit(); render(); break; }
            case 'aipnew': {
                const cfg = T.aiCfg(), id = M.uid('ap');
                let k = Object.keys(cfg.list).length + 1;
                while (Object.values(cfg.list).some(x => x.name === '我的预设 ' + k)) k++;
                const name = '我的预设 ' + k;
                toastr.success(`新建好了「${name}」，想换名字点「改名」`, 'AI 预设', { timeOut: 2500 });
                cfg.list[id] = { id, name, ents: [{ id: M.uid('e'), n: '主指令', r: 'system', on: true, t: '' }, { id: 'ctx', n: '上下文', r: 'user', on: true, ctx: true }] };
                cfg.active = id; commit(); render(); break;
            }
            case 'aipcopy': {
                const cfg = T.aiCfg(), act = cfg.active;
                const ents = T.entriesFor(act, ui.stPresets);
                if (!ents) { toastr.info('预设还没读出来，等一下再点', 'AI 预设'); break; }
                const id = M.uid('ap');
                cfg.list[id] = { id, name: (act.slice(7) || T.currentTavernPreset() || '酒馆预设') + ' · 副本', ents: ents.map(e => ({ ...e, id: e.ctx ? 'ctx' : M.uid('e') })) };
                cfg.active = id; commit(); render(); toastr.success('复制好了，现在可以改了', 'AI 预设', { timeOut: 1500 }); break;
            }
            case 'aiprename': { const p = T.aiCfg().list[T.aiCfg().active]; if (!p) break; const n = await promptText('改名', p.name); if (n == null) break; p.name = n.trim() || p.name; commit(); render(); break; }
            case 'aipdel': {
                const cfg = T.aiCfg(), p = cfg.list[cfg.active];
                if (!p || !(await confirmBox(`删掉预设「${p.name}」？`, { ok: '删除', cancel: '算了' }))) break;
                delete cfg.list[p.id]; cfg.active = 'tavern:'; commit(); render(); break;
            }
            case 'aipexport': {
                const cfg = T.aiCfg(), p = cfg.list[cfg.active];
                if (!p) break;
                const blob = new Blob([JSON.stringify({ app: 'zhiku-ai-preset', version: 1, name: p.name, ents: p.ents, fn: cfg.fn }, null, 2)], { type: 'application/json' });
                const a = DOC.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `zhiku_AI预设_${p.name}.json`; DOC.body.appendChild(a); a.click(); a.remove();
                break;
            }
            case 'aipadd': {
                const p = T.aiCfg().list[T.aiCfg().active]; if (!p) break;
                const t = await promptText('这一条的内容（之后点左边可以切 system / user / assistant）', '', true);
                if (t == null || !t.trim()) break;
                p.ents.splice(p.ents.findIndex(e => e.ctx), 0, { id: M.uid('e'), n: '条目 ' + p.ents.length, r: 'system', on: true, t: t.trim() });
                commit(); render(); break;
            }
            case 'aiprole': { const p = T.aiCfg().list[T.aiCfg().active]; const e = p?.ents[Number(el.dataset.i)]; if (!e || e.ctx) break; const R = ['system', 'user', 'assistant']; e.r = R[(R.indexOf(e.r) + 1) % 3]; commit(); render(); break; }
            case 'aipsw': {
                const cfg = T.aiCfg(), i = Number(el.dataset.i);
                const own = cfg.list[cfg.active];
                if (own) { const e = own.ents[i]; if (e && !e.ctx) e.on = !e.on; }
                else { const e = T.entriesFor(cfg.active, ui.stPresets)?.[i]; if (e?.mark) cfg.markOn[e.mark] = !cfg.markOn[e.mark]; }
                commit(); render(); break;
            }
            case 'aipmove': {
                const p = T.aiCfg().list[T.aiCfg().active]; if (!p) break;
                const i = Number(el.dataset.i), j = i + Number(el.dataset.d);
                if (j < 0 || j >= p.ents.length) break;
                [p.ents[i], p.ents[j]] = [p.ents[j], p.ents[i]]; commit(); render(); break;
            }
            case 'aipedit': {
                const cfg = T.aiCfg(), own = cfg.list[cfg.active], i = Number(el.dataset.i);
                const e = own ? own.ents[i] : T.entriesFor(cfg.active, ui.stPresets)?.[i];
                if (!e) break;
                if (!own) { modal(`<h3 class="pc-h3">${esc(e.n)}</h3><div class="pc-dim small">${esc(e.r)} · 跟着酒馆的预设，这里只能看</div><textarea class="pc-textarea mono" readonly style="min-height:240px">${esc(e.t || '')}</textarea>`); break; }
                const name = await promptText('名字', e.n);
                if (name == null) break;
                const t = await promptText(`「${name.trim() || e.n}」的内容（留空就删掉这一条）`, e.t || '', true);
                if (t == null) break;
                if (!t.trim() && await confirmBox('内容空了，删掉这一条？', { ok: '删除', cancel: '留着' })) own.ents.splice(i, 1);
                else { e.n = name.trim() || e.n; e.t = t; }
                commit(); render(); break;
            }
            case 'aipfn': ui.aipOpen = ui.aipOpen === el.dataset.k ? '' : el.dataset.k; render(); break;
            case 'aipmodels': {
                const k = el.dataset.k, f = T.aiCfg().fn[k], p = T.apiProfiles().find(x => x.id === f?.api);
                if (!p) break;
                const seq = (ui.aipModelSeq ||= {})[k] = (ui.aipModelSeq[k] || 0) + 1;
                const current = () => ui.aipModelSeq[k] === seq && T.aiCfg().fn[k]?.api === p.id;
                ui.aipModelsBusy = k; render();
                try { const models = await T.listModels(p); if (current()) { (ui.aipModels ||= {})[k] = models; if (!models.length) toastr.info('这个接口没列出模型，自己填名字也行', 'AI 预设'); } }
                catch (e) { if (current()) toastr.error(e.message || String(e), '拉取模型失败'); }
                if (current()) { if (ui.aipModelsBusy === k) ui.aipModelsBusy = ''; render(); } break;
            }
            case 'aipmodelpick': { const f = (T.aiCfg().fn[el.dataset.k] ||= { extra: [] }); f.model = f.model === el.dataset.m ? '' : el.dataset.m; commit(); render(); break; }
            case 'aipseen': { const s = T.aiSeen[el.dataset.k]; if (!s) break; modal(`<h3 class="pc-h3">${el.dataset.w === 'fmt' ? '输出格式（只能看）' : '内置指令'}</h3><textarea class="pc-textarea mono" readonly style="min-height:260px">${esc(el.dataset.w === 'fmt' ? s.fmt : s.main)}</textarea>`); break; }
            case 'aipxadd': {
                const t = await promptText('加一条要求，比如「多写镜头和光影」「不要写 NSFW」', '', true);
                if (t == null || !t.trim()) break;
                const cfg = T.aiCfg(); (cfg.fn[el.dataset.k] ||= { extra: [] }).extra ||= [];
                cfg.fn[el.dataset.k].extra.push({ id: M.uid('x'), n: '', t: t.trim(), on: true });
                commit(); render(); break;
            }
            case 'aipxsw': { const x = T.aiCfg().fn[el.dataset.k]?.extra?.[Number(el.dataset.i)]; if (!x) break; x.on = x.on === false; commit(); render(); break; }
            case 'aipxedit': {
                const list = T.aiCfg().fn[el.dataset.k]?.extra, i = Number(el.dataset.i), x = list?.[i];
                if (!x) break;
                const t = await promptText('改这条要求（留空就删掉）', x.t, true);
                if (t == null) break;
                if (!t.trim()) list.splice(i, 1); else x.t = t.trim();
                commit(); render(); break;
            }
            case 'scenesave': {
                const p = sceneSnapshot();
                if (!p.scene) { toastr.info('固定提示词还是空的', '固定提示词'); break; }
                if ((ui.studio.scenes || []).some(x => sceneSig(x) === sceneSig(p))) { toastr.info('这段已经存过了', '固定提示词'); break; }
                ui.studio.scenes = [{ ...p, name: sceneName(p.scene) || '没起名' }, ...(ui.studio.scenes || [])];
                ui.studio.recentScenes = (ui.studio.recentScenes || []).filter(x => sceneSig(x) !== sceneSig(p));
                saveStudio(); toastr.success('存好了，想换名字点它旁边的「改名」', '固定提示词', { timeOut: 2500 }); render(); break;
            }
            case 'sceneuse': {
                const p = (el.dataset.kind === 'saved' ? ui.studio.scenes : ui.studio.recentScenes)?.[Number(el.dataset.i)];
                if (!p) break;
                const cur = sceneSnapshot();
                // 现在这段没存过，换掉前先记进「最近用过」，免得丢
                if (cur.scene && ![...(ui.studio.scenes || []), ...(ui.studio.recentScenes || [])].some(x => sceneSig(x) === sceneSig(cur))) ui.studio.recentScenes = [cur, ...(ui.studio.recentScenes || [])].slice(0, 20);
                applyScene(p);
                toastr.info(`固定提示词换成了${p.name ? '「' + p.name + '」' : '这一段'}`, '固定提示词', { timeOut: 1800 }); render(); break;
            }
            case 'scenekeep': {
                const list = ui.studio.recentScenes || [];
                const p = list[Number(el.dataset.i)];
                if (!p) break;
                const name = await promptText('给这段固定提示词起个名字', sceneName(p.scene));
                if (name == null) break;
                ui.studio.scenes = [{ ...p, name: name.trim() || '没起名' }, ...(ui.studio.scenes || [])];
                ui.studio.recentScenes = list.filter(x => x !== p);
                saveStudio(); render(); break;
            }
            case 'scenetag': ui.studio.sceneTag = el.dataset.v || ''; render(); break;
            case 'scenetags': {
                const p = ui.studio.scenes?.[Number(el.dataset.i)];
                if (!p) break;
                const had = [...new Set((ui.studio.scenes || []).flatMap(x => x.tags || []))];
                const t = await promptText(`「${p.name || '没起名'}」的标签，逗号隔开${had.length ? `（已有：${had.join('、')}）` : '（比如 证件照，NSFW，双人）'}`, (p.tags || []).join('，'));
                if (t == null) break;
                p.tags = [...new Set(t.split(/[,，、;；\n]+/).map(x => x.trim()).filter(Boolean))].slice(0, 8);
                saveStudio(); render(); break;
            }
            case 'scenerename': {
                const p = ui.studio.scenes?.[Number(el.dataset.i)];
                if (!p) break;
                const name = await promptText('改名', p.name || '');
                if (name == null) break;
                p.name = name.trim() || p.name; saveStudio(); render(); break;
            }
            case 'scenedel': {
                const key = el.dataset.kind === 'saved' ? 'scenes' : 'recentScenes';
                const list = (ui.studio[key] || []).slice();
                const [gone] = list.splice(Number(el.dataset.i), 1);
                if (el.dataset.kind === 'saved' && gone && !(await confirmBox(`删掉「${gone.name || '没起名'}」？现在框里的固定提示词不受影响。`, { ok: '删除', cancel: '算了' }))) break;
                ui.studio[key] = list; saveStudio(); render(); break;
            }
            case 'sceneclear': {
                if (!(await confirmBox('清空最近用过的固定提示词？存下的不受影响。', { ok: '清空', cancel: '算了' }))) break;
                ui.studio.recentScenes = []; saveStudio(); render(); break;
            }
            case 'castrm': setStudioCast(studioCast().filter(e => e.key !== el.dataset.key)); render(); break;
            case 'castpos': setStudioCast(studioCast().map(e => e.key === el.dataset.key ? { ...e, pos: el.dataset.v } : e)); render(); break;
            case 'castfit': setStudioCast(studioCast().map(e => e.key === el.dataset.key ? { ...e, outfit: el.dataset.id } : e)); render(); break;
            case 'scenetrans': {
                if (!String(ui.studio.scene || '').trim()) { toastr.info('先写一点固定提示词', '固定提示词'); break; }
                try { await translateScene(); } catch (e) { toastr.error('转换失败：' + e.message, '固定提示词'); }
                render();
                break;
            }
            case 'translatenow': {
                if (!ui.studio.prompt.trim()) { toastr.info('先写一点画面描述', '翻译'); break; }
                el.disabled = true; el.textContent = '转换中…';
                ui.studio.transErr = '';
                try { ui.studio.promptEn = await T.translateToTags(ui.studio.prompt, { expand: ui.studio.expand }); }
                catch (e) { ui.studio.transErr = '转换失败：' + e.message; }
                render();
                break;
            }
            case 'apiuse': d.options.apiActive = el.dataset.id; ui.transModels = null; commit(); toastr.info(`翻译和 AI 改用：${el.textContent}`, '智库', { timeOut: 1500 }); break;
            case 'apinew': {
                const name = await promptText('给这个 AI 接口起个名字（比如：DeepSeek、便宜的那个）', '');
                if (!name) break;
                const id = M.uid('api_');
                T.apiProfiles().push({ id, name: name.slice(0, 20), url: '', key: '', model: '', bypass: false });
                d.options.apiActive = id; ui.transModels = null; ui.setOpen.ai = true; commit();
                break;
            }
            case 'apidel': {
                const list = T.apiProfiles();
                const p = list.find(x => x.id === T.activeApiId());
                if (!p || !(await confirmBox(`删掉「${p.name}」？`))) break;
                list.splice(list.indexOf(p), 1); d.options.apiActive = 'st'; commit();
                break;
            }
            case 'transmodels': {
                el.disabled = true; el.textContent = '拉取中…';
                try {
                    const t = T.apiProfiles().find(x => x.id === T.activeApiId()) || {};
                    ui.transModels = await T.listModels(t);
                    if (!ui.transModels.includes(t.model)) { t.model = ui.transModels[0]; commit(); }
                    toastr.success(`拉到 ${ui.transModels.length} 个模型`, '翻译');
                } catch (e) { toastr.error(e.message, '拉取模型'); }
                render();
                break;
            }
            case 'transtest': {
                el.disabled = true; el.textContent = '测试中…';
                try { const r = await T.translateToTags('一个黑发男人坐在窗边，下雨'); toastr.success(r, '翻译能用'); }
                catch (e) { toastr.error(e.message, '翻译不能用'); }
                render();
                break;
            }
            case 'inpaint': {
                openInpaintEditor(el.dataset.src || ui.studio.result, { pos: ui.studio.pos, neg: ui.studio.neg, onDone: image => { ui.studio.result = image; ui.studio.sent = null; render(); } });
                break;
            }
            case 'renamecol': {
                const c = d.collections[el.dataset.col];
                const name = await promptText('收藏夹的新名字', c.name);
                if (!name) break;
                c.name = name.slice(0, 20); commit();
                break;
            }
            case 'delcol': {
                const c = d.collections[el.dataset.col];
                if (!(await confirmBox(`删除收藏夹「${c.name}」？里面的画师组不会被删。`))) break;
                delete d.collections[c.id];
                for (const g of Object.values(d.groups)) g.collections = g.collections.filter(x => x !== c.id);
                ui.bookFilter = 'all'; commit();
                break;
            }
            case 'edittplid': await openTemplateEditor(el.dataset.tpl); break;
            case 'lobbytest': {
                const r = await L.health();
                toastr.success(`连上了，共有 ${r.posts} 条分享${r.invite ? '，这台服务器要求邀请码' : ''}`, '共享');
                break;
            }
            case 'importfixed': {
                const n = importArtistsFromPresets();
                const k = N.importFromZhihuiji();
                const cn = C.importZhihuijiCharacters(zSettings());
                toastr.success(`画师：加了 ${n} 个画师组 / 画师。角色：搬了 ${cn} 个（在「角色」页 → 存下的）。生图设置：搬了 ${k} 项（包括 NovelAI key）。`, '从智绘姬搬过来', { timeOut: 7000 });
                render();
                break;
            }
            case 'exportdata': exportData(); break;
            case 'dlmarkpreview': {
                const o = { ...dlOpts(), on: true };
                if (!o.text) o.text = '水印示例';
                let blob;
                if (ui.studio.result) { try { blob = await (await fetch(ui.studio.result)).blob(); } catch { } }
                if (!blob) {
                    const c = DOC.createElement('canvas'); c.width = 832; c.height = 1216;
                    const g = c.getContext('2d'), gr = g.createLinearGradient(0, 0, 832, 1216);
                    gr.addColorStop(0, '#c9b9a6'); gr.addColorStop(1, '#5b6b7a'); g.fillStyle = gr; g.fillRect(0, 0, 832, 1216);
                    blob = await new Promise(r => c.toBlob(r, 'image/png'));
                }
                const url = URL.createObjectURL(await processImage(blob, o));
                const box = modal(`<h3 class="pc-h3">水印效果</h3><img src="${url}" alt="" style="width:100%;border-radius:10px"><div class="pc-actions"><button class="pc-btn" type="button" data-x="close">关闭</button></div>`);
                box.addEventListener('click', ev => { if (ev.target.closest('[data-x="close"]')) box.closeModal(); });
                break;
            }
            case 'quickshare': {
                if (!L.serverBase()) { toastr.warning('先到「设置」里填共享服务器地址', '共享'); break; }
                const st = ui.studio;
                openSharedUpload({ artistString: st.pos, negative: st.neg, image: st.result });
                break;
            }
            case 'saveresult': await saveStudioResult(); break;
            case 'cfyconnect': comfyConnectNow(true); render(); break;
            case 'cfysize': loadCfy().size = el.dataset.v; saveCfy(); render(); break;
            case 'cfyfill': {
                const c = loadCfy(), d = getData();
                let add = '';
                if (el.dataset.from === 'active') { add = d.active ? M.ticketString(d, d.active) : ''; if (!add) { toastr.info('还没选正文画师串', '智库'); break; } }
                else { loadStudio(); add = ui.studio.pos || ''; if (!add.trim()) { toastr.info('生图页的正面是空的', '智库'); break; } }
                c.pos = M.mergeTags ? M.mergeTags(add, c.pos) : [add, c.pos].filter(Boolean).join(', ');
                saveCfy(); render(); break;
            }
            case 'cfygen': {
                const c = loadCfy();
                if (c.busy) break;
                if (!N.comfyReady()) { toastr.warning('先连上 ComfyUI', 'ComfyUI'); break; }
                if (!c.pos.trim()) { toastr.warning('正面是空的', 'ComfyUI'); break; }
                saveCfy(); const input = { pos:c.pos, neg:c.neg, size:c.size }; c.busy = true; render();
                try {
                    const [w, h] = input.size.split('x').map(Number);
                    const result = await E.generateFull({ positive: input.pos, negative: input.neg, width: w, height: h, backend: 'comfy' });
                    if (stopped) break;
                    c.result = result;
                    c.sent = E.runtime.lastSent;
                    const shot = { dataUrl: c.result, raw: input.pos, sent: c.sent, from: 'comfy' };
                    pcStoreImage(shot.dataUrl, 'comfy_' + Date.now()).then(r => pcRecordImage({ ...shot, url: r.url })).catch(e => console.warn('[智库] 历史生图没存上', e));
                } catch (e) { toastr.error(e.message, 'ComfyUI 生成失败', { timeOut: 10000 }); }
                finally { c.busy = false; render(); }
                break;
            }
            case 'cfyinsert': await E.insertIntoLastMessage(loadCfy().result); toastr.success('已插到聊天最后一楼', '智库'); break;
            case 'cfyshare': {
                if (!L.serverBase()) { toastr.warning('先到「设置」里填共享服务器地址', '共享'); break; }
                const c = loadCfy(); openSharedUpload({ artistString: c.pos, negative: c.neg, image: c.result }); break;
            }
            case 'cfyclear': loadCfy().result = ''; ui.cfy.sent = null; render(); break;
            case 'insertresult':
                await E.insertIntoLastMessage(ui.studio.result);
                toastr.success('已插到聊天最后一楼', '智库');
                break;
            // 批量
            case 'batchstart': startBatch(); break;
            case 'batchsetup': ui.batch.showSetup = true; render(); root.querySelector('.pc-body')?.scrollTo(0, 0); break;
            case 'batchview': ui.batch.showSetup = false; render(); root.querySelector('.pc-body')?.scrollTo(0, 0); break;
            case 'batchpick': { const j = ui.batch.state?.jobs[Number(el.dataset.i)]; if (j) { j.picked = !j.picked; render(); } break; }
            case 'batchfill': {
                const arts = Object.values(d.artists).filter(a => (el.dataset.v === 'all' || !a.images.length) && !M.banInfo(d, a.tag));
                ui.batch.text = arts.map(a => a.tag.replace(/^artist:/, '')).join('\n');
                render(); break;
            }
            case 'batchpause': ui.batch.state?.pause(); break;
            case 'batchstop': ui.batch.state?.stop(); break;
            case 'batchgroup': {
                const picked = ui.batch.state.jobs.filter(j => j.picked);
                const name = await promptText('新画师组的名字', picked.map(j => M.ticketName(d, j.ref)).slice(0, 2).join(' + '));
                if (!name) break;
                const id = M.uid('g_');
                d.groups[id] = { id, name, note: '', extra: '', collections: [], fav: false, images: [], createdAt: Date.now(), usedAt: 0, members: [...new Set(picked.flatMap(j => j.ref.type === 'group' ? (d.groups[j.ref.id]?.members || []).map(m => m.artistId) : [j.ref.id]))].map(artistId => ({ artistId, weight: 1 })) };
                commit();
                ui.view = 'group'; ui.detailId = id; ui.backTo = 'book'; render();
                break;
            }
            // 氛围
            // 大堂
            case 'selmode': ui.selecting = !ui.selecting; ui.picked.clear(); render(); break;
            case 'selpick': { const id = el.dataset.id; if (ui.picked.has(id)) ui.picked.delete(id); else ui.picked.add(id); render(); break; }
            case 'selall': { const refs = bookList(d); if (ui.picked.size === refs.length) ui.picked.clear(); else refs.forEach(r => ui.picked.add(r.id)); render(); break; }
            case 'selstring': { const tags = [...ui.picked].map(id => d.artists[id]?.tag).filter(Boolean); if (tags.length) openStringMaker({ text: tags.join(', ') }); break; }
            case 'randstring': openStringMaker({ random: true }); break;
            case 'seldel': {
                const type = ui.bookTab === 'groups' ? 'group' : 'artist';
                const ids = [...ui.picked].filter(id => itemOf(d, { type, id }));
                if (!ids.length) break;
                if (!(await confirmBox(type === 'group' ? `删除选中的 ${ids.length} 个画师组？组里的画师不会被删。` : `删除选中的 ${ids.length} 位画师？他们的例图会一起删掉，也会从所有画师组里移出。`, { ok: '删除', cancel: '算了' }))) break;
                const imgs = ids.flatMap(id => itemOf(d, { type, id }).images.map(i => i.path));
                for (const id of ids) { if (type === 'group') M.deleteGroup(d, id); else M.deleteArtist(d, id); }
                ui.picked.clear(); ui.selecting = false;
                commit();
                imgs.forEach(p => deleteImageFile(p));
                toastr.success(`删掉了 ${ids.length} 个`, '智库');
                break;
            }
            case 'selban': {
                const ids = [...ui.picked].filter(id => d.artists[id]);
                if (!ids.length) break;
                const note = await promptText(`拉黑选中的 ${ids.length} 位画师——备注（可不填）`, '');
                if (note == null) break;
                for (const id of ids) M.setBan(d, d.artists[id].tag, note.trim());
                ui.picked.clear(); ui.selecting = false; commit();
                break;
            }
            case 'seltag': {
                const cols = Object.values(d.collections);
                const i = await chooseBox('加哪个标签？', [...cols.map(c => c.name), '收藏', '＋ 新标签']);
                if (i == null) break;
                const type = ui.bookTab === 'groups' ? 'group' : 'artist';
                let colId = cols[i]?.id;
                if (i === cols.length + 1) {
                    const name = await promptText('新标签叫什么？', '');
                    if (!name) break;
                    colId = M.uid('c_'); d.collections[colId] = { id: colId, name: name.slice(0, 20), createdAt: Date.now() };
                }
                for (const id of ui.picked) {
                    const it = itemOf(d, { type, id });
                    if (!it) continue;
                    if (i === cols.length) it.fav = true;
                    else { it.collections ||= []; if (!it.collections.includes(colId)) it.collections.push(colId); }
                }
                ui.picked.clear(); ui.selecting = false; commit();
                break;
            }
            case 'ban': {
                const note = await promptText(`拉黑「${el.dataset.tag.replace(/^artist:/, '')}」——写个备注（为什么拉黑，可不填）`, '');
                if (note == null) break;
                M.setBan(d, el.dataset.tag, note.trim()); commit();
                toastr.info('已拉黑。以后画师串里出现它会标红，批量生成会跳过它。', '智库', { timeOut: 3500 });
                break;
            }
            case 'unban': M.unBan(d, el.dataset.tag); commit(); break;
            case 'banedit': {
                const b = d.blacklist[el.dataset.key];
                const note = b && await promptText(`「${b.tag.replace(/^artist:/, '')}」的备注`, b.note);
                if (note != null && b) { b.note = note.trim(); commit(); }
                break;
            }
            case 'banadd': {
                const name = await promptText('要拉黑的画师名（可以一次写几个，用逗号隔开）', '');
                if (!name) break;
                const note = await promptText('备注（为什么拉黑，可不填）', '');
                if (note == null) break;
                for (const t of M.parseArtistList(name)) M.setBan(d, t.tag, note.trim());
                commit();
                break;
            }
            case 'unblock': toggleBlockTag(el.dataset.tag); break;
            case 'unblockall': d.blockedTags = []; commit(); break;
            case 'vibetab': ui.vibeTab = el.dataset.v; render(); break;
            case 'crshow': ui.crShow = el.dataset.id; render(); break;
            case 'cruse': ui.stamp = true; d.charRefActive = el.dataset.id || null; if (el.dataset.id) ui.crShow = el.dataset.id; commit(); break;
            case 'crnew': {
                const name = await promptText('角色参考组叫什么？（比如角色名）', '');
                if (!name) break;
                const id = M.uid('r_');
                d.charRefGroups[id] = { id, name: name.slice(0, 20), refs: [] };
                ui.crShow = id; commit();
                break;
            }
            case 'crdel': {
                const g = d.charRefGroups[el.dataset.g];
                const r = g?.refs[Number(el.dataset.i)];
                if (!r || !(await confirmBox('删掉这张参考图？'))) break;
                g.refs.splice(Number(el.dataset.i), 1);
                deleteImageFile(r.path); commit();
                break;
            }
            case 'vibeshow': ui.vibeShow = el.dataset.id; render(); break;
            case 'vibeuse': ui.stamp = true; d.vibeActive = el.dataset.id || null; if (el.dataset.id) ui.vibeShow = el.dataset.id; commit(); break;
            case 'vibenew': {
                const name = await promptText('氛围组叫什么？', '');
                if (!name) break;
                const id = M.uid('v_');
                d.vibeGroups[id] = { id, name: name.slice(0, 20), vibes: [], normalize: false };
                ui.vibeShow = id; commit();
                break;
            }
            case 'viberename': await renameVibeGroup(el.dataset.id); break;
            case 'vibegdel': await deleteVibeGroup(el.dataset.id); break;
            case 'vibedel': {
                const g = d.vibeGroups[el.dataset.g];
                const v = g?.vibes[Number(el.dataset.i)];
                if (!v || !(await confirmBox('删掉这张参考图？'))) break;
                g.vibes.splice(Number(el.dataset.i), 1);
                if (v.path) deleteImageFile(v.path);
                commit();
                break;
            }
            case 'outedittoggle': ui.outEditOpen = !ui.outEditOpen; render(); break;
            case 'lobbyblockpost': { const b = lobbyBlock(); if (!b.posts.includes(el.dataset.id)) b.posts.push(el.dataset.id); commit(); toastr.info('这条不再显示，可以在 设置 → 共享 里恢复', '共享', { timeOut: 2500 }); break; }
            case 'lobbyblockuser': { const n = el.dataset.nick; if (!n) break; if (!(await confirmBox(`屏蔽「${n}」？他分享的都不再显示（只在你这里，对方不会知道）。`))) break; const b = lobbyBlock(); if (!b.users.includes(n)) b.users.push(n); commit(); toastr.info(`已屏蔽「${n}」`, '共享', { timeOut: 2500 }); break; }
            case 'unblockuser': { const b = lobbyBlock(); b.users = b.users.filter(x => x !== el.dataset.nick); commit(); break; }
            case 'unblockposts': { lobbyBlock().posts = []; commit(); break; }
            case 'lobbyaud': ui.lobby.tag = ui.lobby.tag === el.dataset.tag ? '' : el.dataset.tag; loadLobby(); break;
            case 'lobbykind': ui.lobby.kind = el.dataset.kind; ui.lobby.mine = false; loadLobby(); break;
            case 'lobbytag2': { const t = el.dataset.tag; if ((d.blockedTags || []).includes(t)) { toggleBlockTag(t); break; } ui.lobby.tag2 = ui.lobby.tag2 === t ? '' : t; render(); break; }
            case 'lobbyview': d.options.lobbyView = el.dataset.v; commit(); break;
            case 'lobbyopen': { const p = ui.lobby.items.find(x => x.id === el.dataset.id); if (p) openLobbySheet(p); break; }
            case 'lobbymine': ui.lobby.mine = !ui.lobby.mine; ui.lobby.kind = ''; loadLobby(); break;
            case 'lobbysort': ui.lobby.sort = el.dataset.sort; loadLobby(); break;
            case 'lobbyupload': openSharedUpload(); break;
            case 'lobbyrefresh': case 'lobbysearch': loadLobby(); break;
            case 'lobbymore': loadLobby({ more: true }); break;
            case 'nsfwtoggle':
                d.options.lobbyShowNsfw = !d.options.lobbyShowNsfw;
                commit(); loadLobby();
                break;
            case 'lobbylike': {
                const p = ui.lobby.items.find(x => x.id === el.dataset.id);
                const r = await L.likePost(p.id);
                Object.assign(p, { likes: r.likes, liked: r.liked });
                render();
                break;
            }
            case 'lobbyreport': {
                if (!(await confirmBox('举报这一条？被几个人举报后会自动隐藏。'))) break;
                await L.reportPost(el.dataset.id);
                toastr.info('已举报', '共享');
                break;
            }
            case 'lobbydel': {
                if (!(await confirmBox('删除你分享的这一条？'))) break;
                await L.deletePost(el.dataset.id);
                ui.lobby.items = ui.lobby.items.filter(x => x.id !== el.dataset.id);
                render();
                break;
            }
            case 'lobbycopy': await copyFromLobby(ui.lobby.items.find(x => x.id === el.dataset.id), el); break;
            case 'share': await shareToLobby(refFrom(el)); break;
        }
    } catch (e) {
        console.error('[票册]', e);
        toastr.error(e.message || String(e), '智库');
    }
}

/** 点了智库的下载链接后提示一下；连着下好几张的合成一条 */
let dlCount = 0, dlTimer = null, dlLast = '';
const isIOS = () => /iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isAndroid = () => /Android|HarmonyOS/i.test(navigator.userAgent);
function dlOpts() {
    const o = getData().options, text = String(o.dlMarkText || '').trim();
    return { strip: !!o.dlStrip, on: !!o.dlMark && !!text, text, pos: o.dlMarkPos || 'br', alpha: Number(o.dlMarkAlpha ?? 0.5) || 0.5, size: Number(o.dlMarkSize ?? 3) || 3, mode: o.dlMode || 'auto' };
}
function dlNote(name) {
    dlCount++; dlLast = name;
    clearTimeout(dlTimer);
    dlTimer = setTimeout(() => {
        const json = /\.json$/i.test(dlLast);
        const where = json ? '' : isIOS() ? '。在「文件」App 的「下载」里，不在相册；想进相册，到 设置 →「下载和水印」把「手机上点下载」改回「自动」，再从分享面板点「存储图像」' : isAndroid() ? '。存在手机的 Download 文件夹，相册里一般在「Download / 下载」相簿' : '，在浏览器的「下载」里';
        toastr.success(dlCount > 1 ? `已发起 ${dlCount} 项下载${where}` : `${json ? '数据' : '图片'}已发起下载：${dlLast}${where}`, '智库', { timeOut: json ? 2500 : 5000 });
        dlCount = 0;
    }, 700);
}
/** 水印：pos = br 右下 / bl 左下 / tr 右上 / tl 左上 / c 正中 / tile 铺满；size 是短边的百分比 */
function drawMark(ctx, w, h, o) {
    const fs = Math.max(12, Math.round(Math.min(w, h) * o.size / 100));
    ctx.save();
    ctx.globalAlpha = Math.min(1, Math.max(0.05, o.alpha));
    ctx.font = `bold ${fs}px "PingFang SC","Microsoft YaHei",sans-serif`;
    ctx.fillStyle = '#fff'; ctx.strokeStyle = 'rgba(0,0,0,.55)'; ctx.lineWidth = Math.max(1, fs / 10); ctx.lineJoin = 'round';
    ctx.textBaseline = 'middle';
    const put = (x, y) => { ctx.strokeText(o.text, x, y); ctx.fillText(o.text, x, y); };
    const tw = ctx.measureText(o.text).width;
    if (o.pos === 'tile') {
        ctx.translate(w / 2, h / 2); ctx.rotate(-Math.PI / 6);
        const R = Math.hypot(w, h) / 2, stepX = tw + fs * 3, stepY = fs * 4;
        for (let y = -R, row = 0; y < R; y += stepY, row++) for (let x = -R - (row % 2) * stepX / 2; x < R; x += stepX) put(x, y);
    } else {
        const m = fs * 0.8;
        const x = o.pos.endsWith('l') ? m : o.pos === 'c' ? (w - tw) / 2 : w - m - tw;
        const y = o.pos.startsWith('t') ? m + fs / 2 : o.pos === 'c' ? h / 2 : h - m - fs / 2;
        put(x, y);
    }
    ctx.restore();
}
function blobImage(blob) {
    return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(blob), img = new Image();
        img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
        img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('图片读不出来')); };
        img.src = url;
    });
}
/** 在不透明画布上重画一遍：PNG 里的文字信息和 NovelAI 藏在透明通道里的提示词都会没掉；需要时再打水印 */
async function processImage(blob, o) {
    if (!o.strip && !o.on) return blob;
    const img = await blobImage(blob);
    const w = img.naturalWidth, h = img.naturalHeight;
    const c = DOC.createElement('canvas'); c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0);
    if (o.on) drawMark(ctx, w, h, o);
    return await new Promise((resolve, reject) => c.toBlob(b => b ? resolve(b) : reject(new Error('图片处理失败')), 'image/png'));
}
function saveBlob(blob, name) {
    const url = URL.createObjectURL(blob), a = DOC.createElement('a');
    a.href = url; a.download = name; a.dataset.zkdl = '1';
    pcMount(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    dlNote(name);
}
/** 分享面板要「刚点过」才肯打开；处理图片耽误久了就再给一个按钮点 */
function shareAsk(file) {
    const box = modal(`<h3 class="pc-h3">图片准备好了</h3><p class="pc-dim small">点下面的按钮打开分享面板，选「存储图像 / 保存到相册」就进相册了。</p>
      <div class="pc-actions"><button class="pc-btn" type="button" data-x="file">下载成文件</button><button class="pc-btn dark" type="button" data-x="share">存到相册 / 分享</button></div>`);
    box.addEventListener('click', ev => {
        const x = ev.target.closest('[data-x]')?.dataset.x;
        if (x === 'share') { navigator.share({ files: [file] }).catch(e => { if (e?.name !== 'AbortError') saveBlob(file, file.name); }); box.closeModal(); }
        if (x === 'file') { saveBlob(file, file.name); box.closeModal(); }
    });
}
async function dlImage(href, name, o, wantShare) {
    let blob;
    try { const response = await fetch(href); if (!response.ok) throw new Error('读取图片失败（' + response.status + '）'); blob = await response.blob(); blob = await processImage(blob, o); }
    catch (e) { console.warn('[智库] 下载处理', e); toastr.error('图片处理失败：' + (e.message || e), '智库'); return; }
    const fname = (o.strip || o.on) ? name.replace(/\.(jpe?g|webp)$/i, '.png') : name;
    if (wantShare) {
        const file = new File([blob], fname, { type: blob.type || 'image/png' });
        if (navigator.canShare?.({ files: [file] })) {
            try { await navigator.share({ files: [file] }); return; }
            catch (e) { if (e?.name === 'AbortError') return; if (e?.name === 'NotAllowedError') { shareAsk(file); return; } console.warn('[智库] 分享', e); }
        }
    }
    saveBlob(blob, fname);
}
function onDownloadClick(ev) {
    const a = ev.target?.closest?.('a[download]');
    if (!a || !a.getAttribute('href') || a.dataset.zkdl) return;
    const name = a.getAttribute('download') || '';
    if (!/^(zhiku|piaoce|漫画|画师库)/.test(name)) return;
    const img = !/\.json$/i.test(name), o = dlOpts();
    const wantShare = img && ev.isTrusted && !!navigator.canShare && (o.mode === 'share' || (o.mode === 'auto' && isIOS()));
    if (img && (o.strip || o.on || wantShare)) { ev.preventDefault(); ev.stopPropagation(); dlImage(a.href, name, o, wantShare); return; }
    dlNote(name);
}
if (globalThis.__zhikuDl) DOC.removeEventListener('click', globalThis.__zhikuDl, true);
globalThis.__zhikuDl = onDownloadClick;
DOC.addEventListener('click', onDownloadClick, true);
function updateStudioPreview() {
    const pv = previewHtml(settingsST() || {});
    const a = root?.querySelector('#pc-pv-pos'), b = root?.querySelector('#pc-pv-neg');
    if (a) a.innerHTML = pv.pos || '（空）';
    if (b) b.innerHTML = pv.neg || '（空）';
}

function setPath(obj, path, val) {
    const ks = path.split('.');
    let o = obj;
    while (ks.length > 1) o = o[ks.shift()];
    o[ks[0]] = val;
}

function onInput(ev) {
    tapOutAt = 0;
    const el = ev.target;
    const d = getData();
    if (el.dataset.ucpCustom !== undefined) { N.settings().UCP_custom = el.value; N.save(); updateStudioPreview(); return; }
    if (el.dataset.castact) { const k = el.dataset.castact; setStudioCast(studioCast().map(e => e.key === k ? { ...e, act: el.value.trim() } : e)); updateStudioPreview(); return; }
    if (el.dataset?.i2i) { (ui.studio.i2i ||= {})[el.dataset.i2i] = Number(el.value); const o = root.querySelector(`[data-i2i-out="${el.dataset.i2i}"]`); if (o) o.textContent = Math.round(Number(el.value) * 100) + '%'; }
    if (el.dataset.bind) {
        setPath(ui, el.dataset.bind, el.value);
        if (el.dataset.bind === 'studio.sceneQ') { clearTimeout(onInput.sq); onInput.sq = setTimeout(render, 250); }
        if (el.dataset.bind === 'studio.pos') { const w = root.querySelector('#pc-pos-ban'); if (w) w.innerHTML = banWarn(getData(), el.value) + lintHtml(el.value); }
        if (el.dataset.bind === 'batch.text') { const w = root.querySelector('#pc-batch-ban'); if (w) w.innerHTML = batchBanWarn(getData(), el.value); }
        if (String(el.dataset.bind).startsWith('cfy.')) { clearTimeout(onInput.cf); onInput.cf = setTimeout(saveCfy, 600); }
        if (['studio.pos', 'studio.neg', 'studio.scene', 'studio.sceneEn'].includes(el.dataset.bind)) { updateStudioPreview(); clearTimeout(onInput.ss); onInput.ss = setTimeout(saveStudio, 600); }
        if (el.dataset.bind === 'studio.scene') { const box = root.querySelector('#pc-scene-ai'); if (box) box.hidden = !sceneZh(); const s2 = root.querySelector('#pc-scene-state'); if (s2) s2.textContent = sceneStateText(); }
        if (el.dataset.bind === 'search') { clearTimeout(onInput.t); onInput.t = setTimeout(() => { render(); const i = root.querySelector('[data-bind="search"]'); if (i) { i.focus(); i.setSelectionRange(i.value.length, i.value.length); } }, 250); }
        return;
    }
    if (el.dataset.bindArtist) { d.artists[el.dataset.bindArtist].note = el.value; commit({ silent: true }); return; }
    if (el.dataset.outname !== undefined) {
        const u = ui.outfit;
        if (u?.draft) u.name = el.value.trim();
        else { const h = u && C.findOutfit(u.owner, u.id); if (h) { h.o.name = el.value.trim(); if (h.owner) C.saveChar(h.owner); else commit({ silent: true }); } }
        return;
    }
    if (el.dataset.charneg !== undefined) { const c = C.getChar(ui.charKey); if (c) { c.negative = el.value; C.saveChar(c); } return; }
    if (el.dataset.charnl !== undefined) { const c = C.getChar(ui.charKey); if (c) { c.nl = el.value.trim(); C.saveChar(c); } return; }
    if (el.dataset.charalias !== undefined) { const c = C.getChar(ui.charKey); if (c) { c.aliases = el.value.trim(); C.saveChar(c); } return; }
    if (el.dataset.bindGroup) { d.groups[el.dataset.bindGroup][el.dataset.field] = el.value; commit({ silent: true }); return; }
    if (el.dataset.crstr !== undefined) {
        const [gid, i] = el.dataset.crstr.split(':');
        const r = d.charRefGroups?.[gid]?.refs?.[Number(i)];
        if (r) { r.strength = Number(el.value); el.nextElementSibling.textContent = Number(el.value).toFixed(2); commit({ silent: true }); }
    }
    if (el.dataset.vibestr !== undefined) {
        const [gid, i] = el.dataset.vibestr.split(':');
        const v = d.vibeGroups?.[gid]?.vibes?.[Number(i)];
        if (v) { v.strength = Number(el.value); el.nextElementSibling.textContent = Number(el.value).toFixed(2); commit({ silent: true }); }
    }
}

async function onChangeEv(ev) {
    const el = ev.target;
    const d = getData();
    if (el.dataset?.actChange === 'cfywf') {
        const v = el.value;
        if (v.startsWith('file:')) return;
        try { await N.comfyUseWorkflow(v ? 'cu' : '', v.slice(3)); toastr.success(v ? '工作流读好了' : '换回内置工作流', 'ComfyUI', { timeOut: 1800 }); }
        catch (e) { toastr.error(e.message, 'ComfyUI 工作流', { timeOut: 10000 }); }
        render(); return;
    }
    if (el.dataset?.cfyfile !== undefined) {
        const f = el.files?.[0]; if (!f) return;
        try { let j; try { j = JSON.parse(await f.text()); } catch { throw new Error('这个文件不是 JSON'); } await N.comfyUseWorkflow('file', f.name, j); toastr.success('工作流读好了：' + f.name, 'ComfyUI', { timeOut: 1800 }); }
        catch (e) { toastr.error(e.message, 'ComfyUI 工作流', { timeOut: 10000 }); }
        render(); return;
    }
    if (el.dataset?.st === 'comfyUrl') { N.settings().comfyUrl = el.value.trim(); N.save(); comfyConnectNow(true); render(); return; }
    if (el.matches?.('[data-aipst]')) { T.aiCfg().active = 'tavern:' + el.value; commit(); render(); return; }
    if (el.matches?.('[data-aipapi]')) { const f = (T.aiCfg().fn[el.dataset.k] ||= { extra: [] }); if (f.api !== el.value) { f.model = ''; if (ui.aipModels) delete ui.aipModels[el.dataset.k]; (ui.aipModelSeq ||= {})[el.dataset.k] = (ui.aipModelSeq[el.dataset.k] || 0) + 1; if (ui.aipModelsBusy === el.dataset.k) ui.aipModelsBusy = ''; } f.api = el.value; commit(); render(); return; }
    if (el.matches?.('[data-aipmodel]')) { const f = (T.aiCfg().fn[el.dataset.k] ||= { extra: [] }); f.model = el.value.trim(); commit(); return; }
    if (el.dataset.castMemo !== undefined) {
        const st = ui.studio, list = studioCast();
        st.castMemo = el.checked;
        if (el.checked) st.castByChat[C.chatId()] = list; else st.cast = list;
        saveStudio(); render(); return;
    }
    if (el.dataset.sceneOn !== undefined) { ui.studio.sceneOn = el.checked; saveStudio(); render(); return; }
    if (el.dataset.bindCheck === 'studio.sceneExpand') { ui.studio.sceneExpand = el.checked; saveStudio(); }
    if (el.dataset.bindGroup || el.dataset.bindArtist) { commit(); return; }
    if (el.dataset.cast) { C.setCastOn(el.dataset.cast, el.checked); render(); return; }
    if (el.dataset.crtype) { const [g, i] = el.dataset.crtype.split(':'); d.charRefGroups[g].refs[Number(i)].type = el.value; commit({ silent: true }); return; }
    if (el.dataset.i2iimg !== undefined) {
        const f = el.files?.[0]; el.value = ''; if (!f) return;
        await loadI2i(f, true); return;
    }
    if (el.dataset.i2i) { const g = (ui.studio.i2i ||= {}); g[el.dataset.i2i] = Number(el.value); render(); return; }
    if (el.dataset.castact) { const k = el.dataset.castact, v = el.value.trim(); setStudioCast(studioCast().map(e => e.key === k ? { ...e, act: v } : e)); updateStudioPreview?.(); return; }
    if (el.dataset.wardimg !== undefined || el.dataset.outimg !== undefined) {
        const f = el.files[0];
        el.value = '';
        if (!f) return;
        const du = await shrinkDataUrl(await fileToDataUrl(f), 1024, 0.88);
        if (el.dataset.wardimg !== undefined) { ui.outfit = { draft: true, name: '', tags: [], image: du, dest: '' }; ui.view = 'outfit'; }
        const u = ui.outfit;
        const target = u.draft ? u : C.findOutfit(u.owner, u.id)?.o;
        if (!target) return;
        const replaceTags = u.draft || !target.tags.length || await confirmBox('用这张图重新提取衣服标签吗？（不提取就只换图）', { ok: '重新提取', cancel: '只换图' });
        if (u.draft) target.image = du;
        else { try { target.image = (await uploadImage(await shrinkDataUrl(du, 768), `outfit_${M.uid('')}`)).path; } catch (e) { toastr.error(e.message, '上传失败'); } }
        if (!replaceTags) { if (!u.draft) { const h = C.findOutfit(u.owner, u.id); if (h?.owner) C.saveChar(h.owner); else commit(); } render(); return; }
        u.busy = 'read'; render();
        try {
            const r = await T.outfitFromImage(du);
            if (!r.tags.length) throw new Error('图里没认出衣服');
            target.tags = r.tags;
            if (!target.name) target.name = r.name;
            toastr.success(`提取到 ${r.tags.length} 件`, '衣柜', { timeOut: 1800 });
        } catch (e) { toastr.error(e.message, '看不了图', { timeOut: 9000 }); }
        u.busy = '';
        if (!u.draft) { const h = C.findOutfit(u.owner, u.id); if (h?.owner) C.saveChar(h.owner); else commit({ silent: true }); }
        render();
        return;
    }
    if (el.dataset.imgpose !== undefined) {
        const f = el.files?.[0];
        el.value = '';
        if (!f || ui.poseBusy) return;
        ui.poseBusy = true; render();
        try {
            const r = await T.imagePose(await shrinkDataUrl(await fileToDataUrl(f), 1024, 0.88));
            ui.poseBusy = false; render();
            showPose(r);
        } catch (e) { ui.poseBusy = false; render(); toastr.error(e.message || String(e), '看不了图', { timeOut: 9000 }); }
        return;
    }
    if (el.dataset.aipimport !== undefined) {
        const f = el.files?.[0];
        el.value = '';
        if (!f) return;
        try {
            const j = JSON.parse(await f.text());
            const cfg = T.aiCfg();
            let ents, name;
            if (j.app === 'zhiku-ai-preset') { ents = j.ents; name = j.name; }
            else if (Array.isArray(j.prompts)) { ents = T.stToEntries(j); name = f.name.replace(/\.json$/i, ''); }
            if (!Array.isArray(ents) || !ents.length || ents.some(e => !e || typeof e !== 'object')) throw new Error('不是智库或酒馆的预设文件');
            ents = ents.map(e => ({ ...e, r: ['system', 'user', 'assistant'].includes(e.r) ? e.r : 'system', n: String(e.n || ''), t: String(e.t || '') }));
            if (!ents.some(e => e.ctx)) ents.push({ id: 'ctx', n: '上下文', r: 'user', on: true, ctx: true });
            const id = M.uid('ap');
            cfg.list[id] = { id, name: String(name || '导入的预设').slice(0, 30), ents: ents.map(e => ({ ...e })) };
            if (j.app === 'zhiku-ai-preset' && j.fn && typeof j.fn === 'object') for (const [k] of T.AI_FNS) { const v = j.fn[k]; if (Array.isArray(v?.extra)) { const target = (cfg.fn[k] ||= {}); target.extra ||= []; target.extra.push(...v.extra.filter(x => x && typeof x.t === 'string').map(x => ({ ...x, id: M.uid('x') }))); } }
            cfg.active = id; commit(); render();
            toastr.success('导入好了', 'AI 预设', { timeOut: 1500 });
        } catch (e) { toastr.error(e.message || String(e), '导入不了'); }
        return;
    }
    if (el.dataset.img2prompt !== undefined) {
        const f = el.files?.[0];
        el.value = '';
        if (!f || ui.img2pBusy) return;
        ui.img2pBusy = true; render();
        try {
            let r = await readImagePrompt(f).catch(() => null), from = 'meta';
            if (!r?.positive) { from = 'ai'; r = await T.imageToPrompt(await shrinkDataUrl(await fileToDataUrl(f), 1024, 0.88)); }
            ui.img2pBusy = false; render();
            showImg2Prompt(r, from);
        } catch (e) { ui.img2pBusy = false; render(); toastr.error(e.message || String(e), '看不了图', { timeOut: 9000 }); }
        return;
    }
    if (el.dataset.lookimg !== undefined) {
        const f = el.files[0];
        el.value = '';
        const c = C.getChar(ui.charKey);
        if (!f || !c) return;
        if (c.appearance.length && !(await confirmBox('用图里读到的长相替换现在的？', { ok: '替换', cancel: '算了' }))) return;
        ui.charBusy = 'look'; render();
        try {
            const look = await T.lookFromImage(await shrinkDataUrl(await fileToDataUrl(f), 1024, 0.88));
            if (!look.length) throw new Error('图里没认出人');
            c.appearance = look; C.saveChar(c);
            toastr.success(`读到 ${look.length} 个长相标签，可以再改`, '角色', { timeOut: 2000 });
        } catch (e) { toastr.error(e.message, '看不了图', { timeOut: 9000 }); }
        ui.charBusy = ''; render();
        return;
    }
    if (el.dataset.charrefup !== undefined) {
        const c = C.getChar(ui.charKey);
        const f = el.files[0];
        if (c && f) {
            try {
                const du = await fitCharRef(await fileToDataUrl(f));
                const { path } = await uploadImage(du, `charref_${M.uid('')}`);
                const id = M.uid('r_');
                const names = new Set(Object.values(d.charRefGroups || {}).map(g => g.name));
                let name = c.name.slice(0, 20), k = 2;
                while (names.has(name)) name = `${c.name.slice(0, 16)} ${k++}`;
                d.charRefGroups[id] = { id, name, refs: [{ id: M.uid('cr_'), path, type: 'character', strength: 0.6 }] };
                c.charRef = id; C.saveChar(c); commit();
                toastr.success(`建好「${name}」并绑定了，下面能加图、调「像不像」。`, '角色');
            } catch (e) { toastr.error(e.message, '上传失败'); }
        }
        el.value = '';
        return;
    }
    if (el.dataset.cradd) {
        const g = d.charRefGroups[el.dataset.cradd];
        for (const f of el.files) {
            try {
                const du = await fitCharRef(await fileToDataUrl(f));
                const { path } = await uploadImage(du, `charref_${M.uid('')}`);
                g.refs.push({ id: M.uid('cr_'), path, type: 'character', strength: 0.6 });
                commit();
            } catch (e) { toastr.error(e.message, '加不进去'); }
        }
        el.value = '';
        return;
    }
    if (el.dataset.vibenorm) { d.vibeGroups[el.dataset.vibenorm].normalize = el.checked; commit(); return; }
    if (el.dataset.vibeadd) { await addVibeFiles(el.dataset.vibeadd, [...el.files]); el.value = ''; return; }
    if (el.dataset.aqt !== undefined) {
        N.settings().AQT_novelai = el.checked ? 'on' : '';
        N.save(); render(); return;
    }
    if (el.dataset.st === 'UCP_novelai' && el.value === 'custom' && !String(N.settings().UCP_custom || '').trim()) {
        // 第一次选自定义：先放进原来预设的内容，在它基础上改
        N.settings().UCP_custom = E.extras(N.settings()).ucp || '';
    }
    if (el.dataset.st === 'UCP_novelai' || el.dataset.st === 'novelaimode') { N.settings()[el.dataset.st] = el.value; N.save(); render(); return; }
    if (el.dataset.st) {
        const s = N.settings();
        if (el.dataset.st === 'size') { const [w, h] = el.value.split('x'); s.novelai_width = w; s.novelai_height = h; }
        else s[el.dataset.st] = el.value.trim();
        N.save();
        if (el.dataset.st === 'naiKey' || el.dataset.st === 'naiSite') ui.naiTest = null;
        if (el.dataset.st === 'size') render();
        return;
    }
    if (el.dataset.stCheck) {
        N.settings()[el.dataset.stCheck] = el.checked ? 'true' : 'false';
        N.save();
        return;
    }
    if (el.dataset.bindCheck) { setPath(ui, el.dataset.bindCheck, el.checked); if (ui.view === 'batch') render(); return; }
    if (el.dataset.bind === 'batch.text') { render(); return; }
    if (el.dataset.opt) { d.options[el.dataset.opt] = el.checked; if (el.dataset.opt === 'imageExpanded') __mod_marker.applyImageDefault(); commit(); return; }
    if (el.hasAttribute('data-illmax')) { try { d.options.illustMax = illustrationCount(el.value); commit(); } catch(e) { el.value = String(d.options.illustMax ?? 1); toastr.warning(e.message, '智库'); } return; }
    if (el.dataset.optstr) { d.options[el.dataset.optstr] = el.value.trim(); if (['imageStartTag','imageEndTag'].includes(el.dataset.optstr)) __mod_marker.syncRegex(); commit({ silent: true }); return; }
    if (el.dataset.api) {
        const p = T.apiProfiles().find(x => x.id === T.activeApiId());
        if (p) { p[el.dataset.api] = el.value.trim(); if (el.dataset.api === 'url' || el.dataset.api === 'key') ui.transModels = null; commit({ silent: el.dataset.api !== 'name' && el.dataset.api !== 'model' }); }
        return;
    }
    if (el.dataset.apiCheck) { const p = T.apiProfiles().find(x => x.id === T.activeApiId()); if (p) { p[el.dataset.apiCheck] = el.checked; commit({ silent: true }); } return; }
    if (el.dataset.lobby) { d.lobby[el.dataset.lobby] = el.value.trim(); commit({ silent: true }); return; }
    if (el.matches('[data-importpack]')) {
        const fs = [...el.files];
        el.value = '';
        if (fs.length) await importPacks(fs).catch(e => toastr.error('导入失败：' + e.message, '智库'));
        return;
    }
    if (el.matches('[data-importdata]')) {
        const f = el.files[0];
        if (!f) return;
        try {
            const json = JSON.parse(await f.text());
            if (!(await confirmBox('用这个文件替换现在的画师库？（已经存好的例图文件不会被删）'))) return;
            await replaceData(json.data || json);
            toastr.success('已导入', '智库');
        } catch (e) { toastr.error('文件不对：' + e.message, '智库'); }
        el.value = '';
        return;
    }
    if (el.dataset.batchpick !== undefined) { ui.batch.state.jobs[Number(el.dataset.batchpick)].picked = el.checked; render(); return; }
    if (el.dataset.upload) {
        const ref = { type: el.dataset.type, id: el.dataset.upload };
        const files = [...el.files];
        if (!files.length) return;
        const nsfw = await confirmBox('这几张是 NSFW 吗？', { ok: '是 NSFW', cancel: '不是' });
        for (const f of files) {
            try { await E.saveImageTo(ref, await fileToDataUrl(f), { nsfw }); }
            catch (e) { toastr.error(e.message, '上传例图失败'); }
        }
        return;
    }
    if (el.matches('[data-enter="lobbysearch"]')) loadLobby();
    void d;
}

// ═════════════════════ 生图台动作 ═════════════════════

async function doGenerate() {
    const st = ui.studio;
    if (st.generating || st.busy) return;
    st.generating = true;
    try {
    if (!N.isReady()) { toastr.warning('先到设置里填 NovelAI key', '生成图片'); ui.view = 'settings'; render(); return; }
    if (!st.pos.trim() && !studioCast().length) { toastr.warning('正面提示词是空的', '生成图片'); return; }
    if (T.hasChinese(st.pos.replace(/（[^（）]*）/g, ''))) {
        if (!(await confirmBox('正面提示词里有中文，NovelAI 看不懂中文。还是要生成吗？（中文描述可以写进下面的「固定提示词」，会自动转成标签）', { ok: '照样生成', cancel: '先不' }))) return;
    }
    if (st.sceneOn !== false && String(st.scene || '').trim() && !sceneReady()) {
        try { await translateScene(); }
        catch (e) { render(); toastr.error('固定提示词转标签失败：' + e.message, '生成图片', { timeOut: 8000 }); return; }
    }
    saveStudio();
    st.busy = true; render();
    try {
        const g = { ...st.i2i }, ns = N.settings();
        const width = Number(ns.novelai_width) || 832, height = Number(ns.novelai_height) || 1216;
        const parts = studioParts(), scene = sceneSnapshot(), sceneOn = st.sceneOn !== false;
        const cast = studioCast(), p = cast.length ? C.studioCastPrompt(parts, cast) : E.composeStudio(parts);
        const ids = cast.length ? C.studioCastRefs(p.picks) : null;
        const i2i = g.image ? { image: await i2iImage(g.image, width, height), strength: g.strength ?? 0.7, noise: g.noise ?? 0 } : null;
        st.result = await E.generateFull({ i2i, width, height, positive: p.positive, negative: p.negative, chars: p.chars || [], director: ids ? (ids.length ? await E.charRefs(ids) : null) : undefined });
        st.sent = E.runtime.lastSent;
        rememberScene(scene, sceneOn);
        // 存起来（默认本地浏览器），记到历史生图里；关掉智库、刷新页面后也能找回来
        const shot = { dataUrl: st.result, raw: parts.pos, sent: st.sent, from: 'studio' };
        pcStoreImage(shot.dataUrl, 'studio_' + Date.now()).then(r => pcRecordImage({ ...shot, url: r.url })).catch(e => console.warn('[智库] 历史生图没存上', e));
    } catch (e) {
        toastr.error(e.message, '生成失败', { timeOut: 8000 });
    } finally {
        st.busy = false; render();
    }
    } finally { st.generating = false; }
}

async function saveStudioResult() {
    const d = getData();
    const choices = [];
    const owner = studioSource() || M.findTicketForString(d, ui.studio.pos);
    if (owner) choices.push({ ref: owner, text: `${owner.type === 'group' ? '画师组' : '画师'}：${M.ticketName(d, owner)}` });
    const members = M.parseArtistString(ui.studio.pos).members;
    if (members.length > 1) {
        for (const m of members) {
            const a = M.findArtistByTag(d, m.tag);
            if (a) choices.push({ ref: { type: 'artist', id: a.id }, text: `组里的画师：${a.tag}` });
        }
    }
    if (!choices.length) { toastr.warning('正面提示词里的画师还没存进画师库。先点「保存画师串」', '生成图片'); return; }
    const pick = await chooseBox('存到哪里？', choices.map(c => c.text));
    if (pick == null) return;
    const nsfw = await confirmBox('这张是 NSFW 吗？', { ok: '是 NSFW', cancel: '不是' });
    await E.saveImageTo(choices[pick].ref, ui.studio.result, { nsfw });
    toastr.success('已保存', '智库');
}

/** 批量的每一行 → 画师或整串；带黑名单画师的跳过 */
function batchUnits(d, text) {
    return M.parseBatchLines(text).filter(u => u.text ? !u.members.some(m => M.banInfo(d, m.tag)) : !M.banInfo(d, u.tag));
}
function findUnit(d, u) {
    if (!u.text) { const a = M.findArtistByTag(d, u.tag); return a ? { type: 'artist', id: a.id } : null; }
    const norm = x => M.tokenize(x).map(t => t.text.toLowerCase() + '@' + t.weight).sort().join('|');
    const want = norm(u.text);
    const g = Object.values(d.groups).find(g => norm(M.ticketString(d, { type: 'group', id: g.id })) === want);
    return g ? { type: 'group', id: g.id } : null;
}
/** 导入 zhiku-artist-pack.mjs 打出来的画师串包；同一串、同一张图重复导入会跳过 */
async function importPacks(files) {
    const d = getData();
    let strings = 0, images = 0, skipped = 0, failed = 0;
    const say = msg => toastr.info(msg, '智库 · 导入画师串包', { timeOut: 1500 });
    for (const f of files) {
        let pack;
        try { pack = JSON.parse(await f.text()); } catch { toastr.error(`${f.name} 不是画师串包`, '智库'); continue; }
        if (pack?.app !== 'zhiku-pack' || !Array.isArray(pack.items)) { toastr.error(`${f.name} 不是画师串包`, '智库'); continue; }
        say(`正在导入 ${f.name}（${pack.items.length} 串）`);
        for (const it of pack.items) {
            const text = String(it.text || '').trim();
            if (!text) continue;
            const p = M.parseArtistString(text);
            const single = p.members.length === 1 && !p.extra && Math.abs(p.members[0].weight - 1) < 0.001;
            const unit = single ? { tag: p.members[0].tag } : { text, members: p.members };
            let ref = findUnit(d, unit);
            if (!ref) { ref = M.createFromString(d, { name: String(it.name || '').slice(0, 40), text, note: it.note || '' }); if (ref) strings++; }
            if (!ref) continue;
            const item = M.resolveTicket(d, ref).item;
            if (it.collection) {
                let col = Object.values(d.collections).find(c => c.name === it.collection);
                if (!col) { const id = M.uid('c_'); col = d.collections[id] = { id, name: String(it.collection).slice(0, 20), createdAt: Date.now() }; }
                item.collections ||= [];
                if (!item.collections.includes(col.id)) item.collections.push(col.id);
            }
            for (const im of it.images || []) {
                const key = `${it.key || ''}:${im.template}:${im.seed}`;
                if (item.images.some(x => x.packKey === key)) { skipped++; continue; }
                try {
                    const id = await E.saveImageTo(ref, im.data, { nsfw: !!im.nsfw, templateId: im.template || '' });
                    const saved = item.images.find(x => x.id === id);
                    if (saved) saved.packKey = key;
                    images++;
                } catch (e) { failed++; console.warn('[智库] 画师串包例图没存上', e); }
            }
        }
        commit();
    }
    render();
    toastr.success(`新增 ${strings} 串、${images} 张例图${skipped ? `，${skipped} 张以前导过、跳过了` : ''}${failed ? `，${failed} 张没存上` : ''}`, '智库 · 导入画师串包', { timeOut: 6000 });
}
function batchBanWarn(d, text) {
    const list = M.parseArtistList(text).map(m => M.banInfo(d, m.tag)).filter(Boolean);
    return list.length ? `<div class="pc-banwarn">⚠ 这些在黑名单里，会跳过：${list.map(x => `<b>${esc(x.tag.replace(/^artist:/, ''))}</b>${x.note ? `（${esc(x.note)}）` : ''}`).join('、')}</div>` : '';
}

function startBatch() {
    const d = getData();
    const list = batchUnits(d, ui.batch.text);
    if (!list.length) { toastr.warning('先粘贴几位画师或画师串', '批量生成例图'); return; }
    if (!N.isReady()) { toastr.warning('先到设置里填 NovelAI key', '批量生成例图'); return; }
    const tpls = chosenTemplates('batch');
    const jobs = [];
    for (const u of list) {
        const ref = findUnit(d, u) || (u.text ? M.createFromString(d, { name: '', text: u.text }) : { type: 'artist', id: M.ensureArtist(d, u.tag).id });
        if (!ref) continue;
        const item = M.resolveTicket(d, ref).item;
        for (const t of tpls) jobs.push({ ref, templateId: t, skip: ui.batch.skipExisting && item.images.some(i => i.template === t) });
    }
    commit();
    const old = ui.batch.state;
    if (old?.running) {
        // 正在生成：排到后面
        for (const j of jobs) old.jobs.push({ ...j, status: j.skip ? 'skip' : 'wait', error: '', image: '' });
        toastr.info(`已排到后面，共 ${old.jobs.length} 张`, '批量生成例图');
    } else {
        const st = E.createBatch(jobs, { onUpdate: () => { if (ui.view === 'batch') render(); } });
        st.jobs.forEach(j => { if (j.skip) j.status = 'skip'; });
        ui.batch.state = st;
        st.run();
    }
    ui.batch.showSetup = false;
    render();
    root.querySelector('.pc-body')?.scrollTo(0, 0);
}

// ═════════════════════ 大堂动作 ═════════════════════

/** 图片里存的提示词：NovelAI 原图（PNG 文字块 / 透明通道隐写）或 WebUI 的 parameters */
function promptFromTexts(t) {
    if (!t) return null;
    let j = null;
    try { j = typeof t.Comment === 'string' ? JSON.parse(t.Comment) : (t.Comment || null); } catch { j = null; }
    if (j) {
        const pos = j.prompt || j.v4_prompt?.caption?.base_caption || t.Description || '';
        const neg = j.uc || j.v4_negative_prompt?.caption?.base_caption || '';
        if (pos) return { positive: String(pos).trim(), negative: String(neg).trim() };
    }
    if (t.parameters) {
        const s = String(t.parameters);
        const ni = s.indexOf('\nNegative prompt:'), si = s.search(/\nSteps:/);
        const pos = s.slice(0, ni >= 0 ? ni : si >= 0 ? si : undefined).trim();
        const neg = ni >= 0 ? s.slice(ni + 17, si > ni ? si : undefined).trim() : '';
        if (pos) return { positive: pos, negative: neg };
    }
    if (t.Description) return { positive: String(t.Description).trim(), negative: '' };
    return null;
}
const inflateBytes = async (bytes, fmt) => new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream(fmt))).arrayBuffer());
/** NovelAI 的透明通道隐写（stealth_pngcomp）：按列读 alpha 最低位 */
async function readStealthTexts(file) {
    const url = URL.createObjectURL(file);
    try {
        const img = await new Promise((ok, bad) => { const i = new Image(); i.onload = () => ok(i); i.onerror = bad; i.src = url; });
        const w = img.naturalWidth, h = img.naturalHeight;
        if (!w || !h || w * h > 40e6) return null;
        const cv = DOC.createElement('canvas'); cv.width = w; cv.height = h;
        const g = cv.getContext('2d', { willReadFrequently: true });
        g.drawImage(img, 0, 0);
        const px = g.getImageData(0, 0, w, h).data;
        const total = w * h;
        let i = 0;
        const bit = () => { const x = Math.floor(i / h), y = i % h; i++; return px[(y * w + x) * 4 + 3] & 1; };
        const bytes = n => { const out = new Uint8Array(n); for (let k = 0; k < n; k++) { let v = 0; for (let b = 0; b < 8; b++) v = (v << 1) | bit(); out[k] = v; } return out; };
        const magic = 'stealth_pngcomp';
        if (total < 200 || new TextDecoder().decode(bytes(magic.length)) !== magic) return null;
        let len = 0;
        for (let b = 0; b < 32; b++) len = len * 2 + bit();
        if (!len || i + len > total) return null;
        return JSON.parse(new TextDecoder().decode(await inflateBytes(bytes(Math.floor(len / 8)), 'gzip')));
    } catch { return null; } finally { URL.revokeObjectURL(url); }
}
async function readImagePrompt(file) {
    const buf = new Uint8Array(await file.arrayBuffer());
    const utf8 = b => new TextDecoder('utf-8').decode(b);
    const texts = {};
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
        const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
        for (let p = 8; p + 8 <= buf.length;) {
            const len = dv.getUint32(p), type = String.fromCharCode(...buf.subarray(p + 4, p + 8));
            const data = buf.subarray(p + 8, p + 8 + len);
            p += 12 + len;
            if (type === 'IEND') break;
            if (!['tEXt', 'iTXt', 'zTXt'].includes(type)) continue;
            const z = data.indexOf(0);
            if (z < 0) continue;
            const key = utf8(data.subarray(0, z));
            try {
                if (type === 'tEXt') texts[key] = utf8(data.subarray(z + 1));
                else if (type === 'zTXt') texts[key] = utf8(await inflateBytes(data.subarray(z + 2), 'deflate'));
                else {
                    let q = data.indexOf(0, z + 3);
                    q = data.indexOf(0, q + 1);
                    const body = data.subarray(q + 1);
                    texts[key] = utf8(data[z + 1] ? await inflateBytes(body, 'deflate') : body);
                }
            } catch { /* 坏块跳过 */ }
        }
    }
    let r = promptFromTexts(texts);
    if (!r && /png|webp/i.test(file.type || file.name)) r = promptFromTexts(await readStealthTexts(file));
    return r;
}

/** 看图写出来的提示词：改一改，再选怎么填进生图页 */
function showImg2Prompt(r, from) {
    const st = ui.studio;
    const hasArtist = M.parseArtistString(r.positive).members.length > 0;
    const box = modal(`<h3 class="pc-h3">看图写出的提示词</h3>
      <div class="pc-dim small">${from === 'meta' ? '这是 NovelAI 原图，直接读出了当时发的提示词' : '识图 AI 看图写的（不含画师和质量词），可以先改一改'}${r.zh ? '：' + esc(r.zh) : ''}</div>${r.camera ? `<div class="pc-dim small mono" style="margin-top:4px">镜头：${esc(r.camera)}</div>` : ''}
      <label class="pc-field pc-mt-s"><span>正面</span><textarea class="pc-textarea mono" data-i2p-pos>${esc(r.positive)}</textarea></label>
      ${r.negative ? `<label class="pc-field pc-mt-s"><span>负面</span><textarea class="pc-textarea small mono" data-i2p-neg>${esc(r.negative)}</textarea></label>
      <label class="pc-switch"><input type="checkbox" data-i2p-useneg checked><span></span>负面也换成这个</label>` : ''}
      <div class="pc-actions wrap">
        <button class="pc-btn dark" data-i2p="replace">换掉正面（保留现在的画师）</button>
        <button class="pc-btn" data-i2p="append">接在正面后面</button>
        ${hasArtist ? '<button class="pc-btn" data-i2p="all">连图里的画师一起用</button>' : ''}
        <button class="pc-btn" data-i2p="copy">复制</button>
        <button class="pc-btn" data-i2p="no">算了</button>
      </div>`);
    box.addEventListener('click', async ev => {
        const act = ev.target.closest('[data-i2p]')?.dataset.i2p;
        if (!act) return;
        const pos = box.querySelector('[data-i2p-pos]').value.trim();
        if (act === 'no') { box.closeModal(); return; }
        if (act === 'copy') { try { await navigator.clipboard.writeText(pos); toastr.success('复制好了', '看图写提示词', { timeOut: 1200 }); } catch { toastr.info('复制不了，长按文本框自己复制', '看图写提示词'); } return; }
        const keep = M.parseArtistString(st.pos || '').members.map(m => Math.abs(m.weight - 1) < 0.001 ? m.tag : `${M.fmtWeight(m.weight)}::${m.tag}::`).join(', ');
        if (act === 'replace') st.pos = M.replaceArtists(M.stripArtists(pos), [keep, st.lastExtra].filter(Boolean).join(', '));
        else if (act === 'append') st.pos = M.mergeTags(st.pos || '', M.stripArtists(pos));
        else if (act === 'all') st.pos = pos;
        const negBox = box.querySelector('[data-i2p-neg]');
        if (negBox && box.querySelector('[data-i2p-useneg]')?.checked) st.neg = negBox.value.trim();
        saveStudio();
        box.closeModal();
        ui.view = 'studio'; render();
        toastr.success(act === 'all' ? '已填进正面（含画师）' : '已填进正面，画师串没动', '看图写提示词', { timeOut: 1800 });
    });
}
/** 看图读出的姿势和构图：挑着用，带中文 */
function showPose(r) {
    const st = ui.studio;
    const all = [...r.pose.map(p => ({ ...p, g: '姿势' })), ...r.composition.map(p => ({ ...p, g: '构图' })), ...(r.nsfw || []).map(p => ({ ...p, g: 'NSFW' }))];
    const picked = new Set(all.map((_, i) => i));
    const box = modal('<div data-pose></div>');
    const draw = () => {
        const grp = g => all.map((p, i) => [p, i]).filter(([p]) => p.g === g).map(([p, i]) => `<button class="pc-pair-pick ${picked.has(i) ? 'on' : ''}" data-pi="${i}"><span class="mono">${esc(p.en)}</span>${p.zh ? `<em>${esc(p.zh)}</em>` : ''}</button>`).join('') || '<span class="pc-dim small">没读出来</span>';
        box.querySelector('[data-pose]').innerHTML = `<style>.pc-pair-pick{display:inline-flex;align-items:baseline;gap:6px;margin:0 6px 6px 0;padding:6px 11px;border-radius:999px;border:1.5px dashed var(--pc-dash);background:transparent;color:var(--pc-ink);font-family:var(--pc-font);font-size:13px;cursor:pointer}.pc-pair-pick em{font-style:normal;font-size:12px;color:var(--pc-ink-soft)}.pc-pair-pick.on{border-style:solid;border-color:var(--pc-ink);background:var(--pc-paper-2)}</style>
          <h3 class="pc-h3">图里的姿势和构图</h3><div class="pc-dim small">点标签选上 / 取消，选上的才会用。</div>
          <div class="pc-label">姿势</div><div>${grp('姿势')}</div>
          <div class="pc-label">构图</div><div>${grp('构图')}</div>
          ${all.some(p => p.g === 'NSFW') ? `<div class="pc-label">NSFW（默认选上，不要就点掉）</div><div>${grp('NSFW')}</div>` : ''}
          <div class="pc-actions wrap">
            <button class="pc-btn dark" data-pa="pos">接在正面后面</button>
            <button class="pc-btn" data-pa="scene">换成固定提示词</button>
            <button class="pc-btn" data-pa="copy">复制</button>
            <button class="pc-btn" data-pa="no">算了</button></div>`;
    };
    box.addEventListener('click', async ev => {
        const pi = ev.target.closest('[data-pi]');
        if (pi) { const i = Number(pi.dataset.pi); picked.has(i) ? picked.delete(i) : picked.add(i); draw(); return; }
        const a = ev.target.closest('[data-pa]')?.dataset.pa;
        if (!a) return;
        if (a === 'no') { box.closeModal(); return; }
        const tags = all.filter((_, i) => picked.has(i)).map(p => p.en).join(', ');
        if (!tags) { toastr.info('一个都没选', '姿势构图'); return; }
        if (a === 'copy') { try { await navigator.clipboard.writeText(tags); toastr.success('复制好了', '姿势构图', { timeOut: 1200 }); } catch { toastr.info(tags, '复制不了，自己长按复制'); } return; }
        if (a === 'pos') st.pos = M.mergeTags(st.pos || '', tags);
        else { st.scene = tags; st.sceneEn = ''; st.sceneSrc = ''; st.sceneOn = true; }
        saveStudio(); box.closeModal(); ui.view = 'studio'; render();
        toastr.success(a === 'pos' ? '接在正面后面了' : '固定提示词换成这些了', '姿势构图', { timeOut: 1500 });
    });
    draw();
}
/** AI 预设页 */
function viewAiPreset(d) {
    const cfg = T.aiCfg(), act = cfg.active ?? 'tavern:';
    const kind = act === 'plain' ? 'plain' : act.startsWith('tavern:') ? 'tavern' : 'own';
    const curST = T.currentTavernPreset();
    if (kind === 'tavern' && !ui.stPresets && !ui.stPresetsLoading) {
        ui.stPresetsLoading = true;
        T.tavernPresets().then(l => { ui.stPresets = l; }).catch(e => { ui.stPresets = []; ui.stPresetsErr = e.message; }).finally(() => { ui.stPresetsLoading = false; if (ui.view === 'aipreset') render(); });
    }
    const ents = T.entriesFor(act, ui.stPresets);
    const mine = Object.values(cfg.list);
    const ro = kind !== 'own';
    const stName = act.slice(7) || curST;
    const chip = (v, t) => `<button class="pc-pill ${act === v || (v === 'tavern:' && kind === 'tavern') ? 'on' : 'dashed'}" data-act="aipuse" data-v="${esc(v)}">${t}</button>`;
    const entRow = (e, i) => {
        const moveUp = !ro && i > 0, moveDown = !ro && i < ents.length - 1;
        return `<div class="pc-aient ${e.ctx ? 'ctx' : ''} ${e.mark && !e.on ? 'skip' : ''} ${!e.on && !e.ctx && !e.mark ? 'off' : ''}">
          <button class="pc-airole ${e.r}" data-act="aiprole" data-i="${i}" ${ro || e.ctx ? 'disabled' : ''}>${esc(e.r)}</button>
          <div class="pc-grow"><b>${e.ctx ? '📌 ' : ''}${esc(e.n)}</b><small>${e.ctx ? '智库的指令 + 这次要处理的内容放在这里' : e.mark ? (e.on ? '酒馆自动填：' + esc(e.n) + (/worldInfo/.test(e.mark) ? '（世界书暂时带不了）' : '') : '角色卡、世界书这类，默认不发') : esc(String(e.t || '').slice(0, 80))}</small></div>
          ${e.ctx ? '' : `<button class="pc-aisw ${e.on ? 'on' : ''}" data-act="aipsw" data-i="${i}" ${ro && !e.mark ? 'disabled' : ''} aria-label="开关"></button>`}
          ${moveUp ? `<button class="pc-aiib" data-act="aipmove" data-i="${i}" data-d="-1" aria-label="上移">↑</button>` : ''}
          ${moveDown ? `<button class="pc-aiib" data-act="aipmove" data-i="${i}" data-d="1" aria-label="下移">↓</button>` : ''}
          ${e.ctx || e.mark ? '' : `<button class="pc-aiib" data-act="aipedit" data-i="${i}">${ro ? '看' : '✎'}</button>`}</div>`;
    };
    const fnRows = T.AI_FNS.map(([k, n, where]) => {
        const f = cfg.fn[k] || { extra: [] }, extra = f.extra || [], seen = T.aiSeen[k];
        const open = ui.aipOpen === k;
        const profiles = T.apiProfiles(), apiId = f.api || '', prof = profiles.find(p => p.id === apiId);
        const apiName = !apiId ? '' : apiId === 'st' ? '酒馆现在连接的' : prof ? prof.name + (f.model ? ' · ' + f.model : '') : '';
        const models = ui.aipModels?.[k] || [];
        const apiPick = `<div class="pc-aiapi"><label class="pc-field"><span>用哪个 AI</span><select class="pc-input" data-aipapi data-k="${k}"><option value="">跟「翻译和 AI」一样（现在：${esc(T.currentApi().from || '')}）</option><option value="st" ${apiId === 'st' ? 'selected' : ''}>酒馆现在连接的 API</option>${profiles.map(p => `<option value="${esc(p.id)}" ${apiId === p.id ? 'selected' : ''}>${esc(p.name || p.url)}${p.model ? ' · ' + esc(p.model) : ''}</option>`).join('')}</select></label>
            ${prof ? `<label class="pc-field"><span>模型（不填就用这个接口里选的${prof.model ? '：' + esc(prof.model) : ''}）</span><span class="pc-row" style="gap:6px"><input class="pc-input" data-aipmodel data-k="${k}" list="pc-aipm-${k}" value="${esc(f.model || '')}" placeholder="${esc(prof.model || '比如 gpt-4o-mini')}"><button class="pc-btn" data-act="aipmodels" data-k="${k}">${ui.aipModelsBusy === k ? '…' : '拉取'}</button></span><datalist id="pc-aipm-${k}">${models.map(m => `<option value="${esc(m)}">`).join('')}</datalist></label>${models.length ? `<div class="pc-chips wrap">${models.slice(0, 30).map(m => `<button class="pc-pill tiny ${f.model === m ? 'on' : 'dashed'}" data-act="aipmodelpick" data-k="${k}" data-m="${esc(m)}">${esc(m)}</button>`).join('')}</div>` : ''}` : ''}
            ${!profiles.length ? '<div class="pc-hint">想给这个功能单独配一个 API，先到「设置 → 翻译和 AI」里点「＋」加一个接口。</div>' : ''}
            ${k === 'img' || k === 'pose' ? '<div class="pc-hint">这个功能要看图，选能识图的模型（比如 GPT-4o、Claude、Gemini）。</div>' : ''}</div>`;
        return `<div class="pc-aifn ${open ? 'open' : ''}"><button class="pc-aifn-h" data-act="aipfn" data-k="${k}"><span class="pc-grow"><b>${esc(n)}</b><small>${esc(where)}${apiName ? ' · 用 ' + esc(apiName) : ''}${extra.length ? ` · 加了 ${extra.length} 条要求` : ''}</small></span><span>${open ? '⌄' : '›'}</span></button>
          ${open ? apiPick + `<div class="pc-aient"><span class="pc-airole tag">内置</span><div class="pc-grow"><b>指令</b><small>${seen ? esc(seen.main.slice(0, 80)) : '这次打开酒馆后还没用过，用一次就能看到'}</small></div>${seen ? `<button class="pc-aiib" data-act="aipseen" data-k="${k}" data-w="main">看</button>` : ''}</div>
            ${seen?.fmt ? `<div class="pc-aient"><span class="pc-airole tag">🔒</span><div class="pc-grow"><b>输出格式</b><small>插件要按这个读 AI 的回复，只能看</small></div><button class="pc-aiib" data-act="aipseen" data-k="${k}" data-w="fmt">看</button></div>` : ''}
            ${extra.map((x, i) => `<div class="pc-aient ${x.on === false ? 'off' : ''}"><span class="pc-airole tag">我的</span><div class="pc-grow"><b>${esc(x.n || '要求 ' + (i + 1))}</b><small>${esc(x.t)}</small></div><button class="pc-aisw ${x.on !== false ? 'on' : ''}" data-act="aipxsw" data-k="${k}" data-i="${i}" aria-label="开关"></button><button class="pc-aiib" data-act="aipxedit" data-k="${k}" data-i="${i}">✎</button></div>`).join('')}
            <button class="pc-castadd" data-act="aipxadd" data-k="${k}">＋ 加一条要求</button>
            <div class="pc-dim small">内置指令里会自动填角色名这类东西，所以不能直接改；想让 AI 换个写法，加一条要求就行。</div>` : ''}</div>`;
    }).join('');
    return `<style>
.pc-aient{display:flex;align-items:center;gap:7px;padding:8px 9px;border-radius:13px;background:var(--pc-paper-2);margin-top:6px}
.pc-aient b{font-size:14px}
.pc-aient small{display:block;font-size:11px;color:var(--pc-ink-soft);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pc-aient.off b::after{content:" · 关着";font-size:11px;font-weight:400;color:var(--pc-danger)}
.pc-aient.skip{background:transparent;border:1.5px dashed var(--pc-dash)}
.pc-aient.ctx{background:var(--pc-ink);color:var(--pc-paper)}
.pc-aient.ctx small{color:var(--pc-paper);opacity:.8}
.pc-airole{flex:0 0 auto;min-width:64px;height:26px;border-radius:8px;border:1.5px solid var(--pc-ink);background:var(--pc-paper);color:var(--pc-ink);font:11px var(--pc-font-label);cursor:pointer;display:inline-grid;place-items:center;padding:0 6px}
.pc-airole.user{background:rgba(201,138,62,.28)}.pc-airole.assistant{background:rgba(126,162,156,.35)}
.pc-airole.tag{min-width:auto}
.pc-airole[disabled]{cursor:default}
.pc-aient.ctx .pc-airole{background:transparent;color:var(--pc-gold);border-color:var(--pc-gold)}
.pc-aisw{flex:0 0 auto;width:40px;height:23px;border-radius:999px;background:rgba(58,42,34,.18);position:relative;cursor:pointer;border:0}
.pc-aisw::after{content:"";position:absolute;top:3px;left:3px;width:17px;height:17px;border-radius:50%;background:var(--pc-gold);transition:left .15s}
.pc-aisw.on{background:var(--pc-ink)}.pc-aisw.on::after{left:20px}
.pc-aisw[disabled]{cursor:default}
.pc-aiib{flex:0 0 auto;width:28px;height:28px;border-radius:8px;border:1.5px dashed var(--pc-dash);background:transparent;color:inherit;cursor:pointer;font-size:12px}
.pc-aient.ctx .pc-aiib{border-color:rgba(244,239,228,.55)}
.pc-castadd{width:100%;margin:9px 0 6px;min-height:42px;border:1.5px dashed var(--pc-dash);border-radius:14px;background:transparent;font-family:var(--pc-font);font-size:14px;color:var(--pc-ink);cursor:pointer}
.pc-aifn{border-top:1.5px dashed var(--pc-dash);padding:6px 0}
.pc-aifn:first-of-type{border-top:0}
.pc-aifn-h{display:flex;align-items:center;gap:8px;width:100%;border:0;background:transparent;color:var(--pc-ink);font-family:var(--pc-font);text-align:left;padding:6px 2px;cursor:pointer}
.pc-aifn-h b{display:block;font-size:15px}
.pc-aifn-h small{display:block;font-size:11px;color:var(--pc-ink-soft)}
</style>
      <button class="pc-back" data-act="nav" data-view="settings">‹ 回设置</button>
      <h2 class="pc-pagetitle">AI 预设</h2>
      <section class="pc-card pc-pad">
        <div class="pc-dim small">智库让 AI 干活时（看图、转标签、插图、读外貌、漫画……）按这里的预设发：预设里的条目照常发，智库的指令放在 📌「上下文」那一格。</div>
        <div class="pc-chips wrap pc-mt-s">${chip('plain', '不套预设')}${chip('tavern:', '跟酒馆预设')}${mine.map(p => chip(p.id, esc(p.name))).join('')}<button class="pc-pill dashed" data-act="aipnew">＋ 新建</button></div>
        ${kind === 'tavern' ? `<select class="pc-input pc-mt-s" data-aipst><option value="">酒馆现在用的${curST ? '（' + esc(curST) + '）' : ''}</option>${(ui.stPresets || []).map(p => `<option value="${esc(p.name)}" ${act === 'tavern:' + p.name ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select>
          <div class="pc-hint">${ui.stPresetsLoading ? '正在读酒馆的预设…' : ui.stPresetsErr ? '读不到酒馆的预设列表：' + esc(ui.stPresetsErr) : '跟着酒馆的预设「' + esc(stName || '现在用的') + '」走：酒馆里改了这里跟着变，这里只能看（角色卡、世界书那几格能开关）。想自己调，点「复制一份改」。'}</div>` : ''}
        ${kind === 'plain' ? '<div class="pc-hint">不套预设：只发智库自己的指令，跟以前一样。API 不需要破限时用。</div>' : ''}
        ${kind === 'own' ? `<div class="pc-hint">智库自己的预设「${esc(cfg.list[act]?.name || '')}」：条目、角色（点左边切 system / user / assistant）、开关、顺序都能改。</div>` : ''}
        <div class="pc-actions wrap">
          ${kind === 'tavern' ? '<button class="pc-btn dark" data-act="aipcopy">复制一份改</button>' : ''}
          <label class="pc-btn" style="cursor:pointer">导入文件<input type="file" accept=".json,application/json" data-aipimport hidden></label>
          ${kind === 'own' ? '<button class="pc-btn" data-act="aipexport">导出</button><button class="pc-btn" data-act="aiprename">改名</button><button class="pc-linkdanger" data-act="aipdel">删掉这个预设</button>' : ''}
        </div>
        <div class="pc-hint">只对「翻译和 AI」里用「酒馆现在连接的 API」或「单独填」的聊天补全接口有效；酒馆连的是文本补全时，会把条目合成一段发。</div>
      </section>
      <section class="pc-card pc-pad pc-mt">
        <h3 class="pc-h3" style="margin:0">条目</h3><div class="pc-dim small">从上往下按顺序发。</div>
        ${ents ? ents.map(entRow).join('') : '<div class="pc-dim small pc-mt-s">正在读这个预设…</div>'}
        ${kind === 'own' ? '<button class="pc-castadd" data-act="aipadd">＋ 加一条</button>' : ''}
      </section>
      <section class="pc-card pc-pad pc-mt">
        <h3 class="pc-h3" style="margin:0">各个功能</h3><div class="pc-dim small">这些是放进 📌「上下文」的部分。每个功能都能加自己的要求，所有预设通用。</div>
        ${fnRows}
      </section>
      <div style="height:24px"></div>`;
}
function openSharedUpload(pre = {}) {
    const d = getData();
    const box = modal(`<form data-share-form>
      <h3 class="pc-h3">上传画师串</h3>
      <label class="pc-field"><span>名称</span><input class="pc-input" name="title" maxlength="200" required placeholder="给这串起个名字" value="${esc(pre.title || '')}"></label>
      <label class="pc-field"><span>署名</span><input class="pc-input" name="signature" maxlength="24" required value="${esc(d.lobby.nickname || '')}" placeholder="显示在共享卡片上的名字"></label>
      <div class="pc-field"><span>例图（可选，最多 6 张）</span><label class="pc-pill dashed pc-share-pick">＋ 选图<input name="images" type="file" accept="image/png,image/jpeg,image/webp" multiple hidden></label>
        <small class="pc-dim" style="display:block;margin-top:4px">选 NovelAI 原图，会自动读出正面和负面填到下面</small></div>
      <div data-share-previews style="display:flex;gap:8px;flex-wrap:wrap;margin:8px 0"></div>
      <button class="pc-pill dashed" type="button" data-share-clear hidden>清空例图</button>
      <p class="pc-dim small" data-share-meta role="status" aria-live="polite"></p>
      <label class="pc-field"><span>画师串（正面）</span><textarea class="pc-textarea mono" name="artistString" maxlength="20000" required placeholder="artist:aaa, 0.8::artist:bbb::">${esc(artistOnly(pre.artistString || ''))}</textarea><small class="pc-dim" style="display:block;margin-top:4px">只分享画师串和画风、质量词；人物、动作、衣服、场景这些标签会自动去掉。</small></label>
      <label class="pc-field"><span>负面（可选）</span><textarea class="pc-textarea mono" name="negative" maxlength="20000" placeholder="lowres, bad anatomy …">${esc(pre.negative || '')}</textarea></label>
      ${lobbyTagPicker(pre.tags || [])}
      <label class="pc-field"><span>说明（可选）</span><textarea class="pc-textarea" name="note" maxlength="5000" placeholder="适合的画面、使用建议或来源"></textarea></label>
      <label class="pc-switch"><input type="checkbox" name="nsfw"><span></span>含 NSFW 内容</label>
      ${(() => { const o = dlOpts(); return `<label class="pc-switch"><input type="checkbox" name="mark" ${o.on ? 'checked' : ''} ${o.text ? '' : 'disabled'}><span></span>例图打上我的水印<small>${o.text ? '「' + esc(o.text) + '」，位置和大小在 设置 →「下载和水印」' : '先到 设置 →「下载和水印」填水印文字'}</small></label>`; })()}
      <p class="pc-dim small" data-share-status role="status" aria-live="polite"></p>
      <div class="pc-actions"><button class="pc-btn" type="button" data-share-cancel>取消</button><button class="pc-btn dark" type="submit">发布到共享</button></div>
    </form>`);
    box.style.maxHeight = '90dvh';
    box.style.overflowY = 'auto';
    box.style.scrollbarWidth = 'none';
    const style = DOC.createElement('style');
    style.textContent = '.pc-modal:has([data-share-form])::-webkit-scrollbar,.pc-modal [data-share-form] *::-webkit-scrollbar{display:none}.pc-modal [data-share-form] *{scrollbar-width:none}.pc-modal [data-share-form] input[type=file]{max-width:100%;font-size:13px}.pc-modal [data-share-form] textarea{min-height:72px}';
    box.appendChild(style);
    const form = box.querySelector('form');
    wireTagPicker(box);
    const status = box.querySelector('[data-share-status]');
    const files = form.elements.namedItem('images');
    const clear = box.querySelector('[data-share-clear]');
    const previews = box.querySelector('[data-share-previews]');
    let busy = false, previewVersion = 0;
    const say = message => { status.textContent = message; };
    const metaBox = box.querySelector('[data-share-meta]');
    const fillFromImageMeta = async version => {
        let meta = null;
        for (const file of files.files) {
            try { meta = await readImagePrompt(file); } catch (e) { console.warn('[智库] 读图片里的提示词', e); }
            if (version !== previewVersion || !box.isConnected) return;
            if (meta?.positive) break;
        }
        metaBox.replaceChildren();
        if (!meta?.positive) { if (files.files.length) metaBox.textContent = '例图里没读到提示词（不是 NovelAI 原图，或者被压缩、截图过）。'; return; }
        const pos = form.elements.namedItem('artistString'), neg = form.elements.namedItem('negative');
        const apply = () => { pos.value = artistOnly(meta.positive); neg.value = meta.negative || ''; metaBox.textContent = `已从例图读出正面${meta.negative ? '和负面' : ''}，可以再改。`; };
        if (!pos.value.trim() && !neg.value.trim()) { apply(); return; }
        if (pos.value.trim() === artistOnly(meta.positive) && neg.value.trim() === (meta.negative || '')) return;
        const b = DOC.createElement('button');
        b.type = 'button'; b.className = 'pc-pill dashed tiny'; b.textContent = '例图里有提示词，用它替换下面的';
        b.addEventListener('click', apply);
        metaBox.appendChild(b);
    };
    clear.addEventListener('click', () => { ++previewVersion; files.value = ''; previews.replaceChildren(); metaBox.replaceChildren(); clear.hidden = true; say(''); });
    files.addEventListener('change', async () => {
        const version = ++previewVersion;
        previews.replaceChildren(); clear.hidden = !files.files.length;
        if (files.files.length > 6) { say('最多选择 6 张例图，请重新选择。'); return; }
        say('');
        for (const file of files.files) {
            if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 20 * 1024 * 1024) { say('请选择 20MB 以内的 PNG、JPEG 或 WebP 图片。'); return; }
            try {
                const src = await shrinkDataUrl(await fileToDataUrl(file), 240, 0.75);
                if (version !== previewVersion || !box.isConnected) return;
                const img = DOC.createElement('img'); img.src = src; img.alt = file.name;
                img.style.cssText = 'width:72px;height:88px;object-fit:cover;border-radius:8px'; previews.appendChild(img);
            } catch { say('有一张例图无法读取，请重新选择。'); }
        }
        if (version === previewVersion && box.isConnected) await fillFromImageMeta(version);
    });
    box.querySelector('[data-share-cancel]').addEventListener('click', () => { if (!busy) box.closeModal(); });
    let preLoading = !!pre.image;
    if (pre.image) (async () => {
        const version = previewVersion;
        try {
            const response = await fetch(pre.image); if (!response.ok) throw new Error('读取例图失败（' + response.status + '）');
            const blob = await response.blob();
            if (!box.isConnected || previewVersion !== version || files.files.length) return;
            const dt = new DataTransfer();
            dt.items.add(new File([blob], 'zhiku.png', { type: blob.type || 'image/png' }));
            files.files = dt.files; files.dispatchEvent(new Event('change'));
        } catch (e) { console.warn('[智库] 带上例图', e); if (box.isConnected && previewVersion === version) say('例图没带上，可以自己点「选图」。'); }
        finally { preLoading = false; }
    })();
    box.parentElement.addEventListener('click', ev => { if (busy && ev.target === box.parentElement) ev.stopImmediatePropagation(); }, true);
    form.addEventListener('submit', async ev => {
        ev.preventDefault();
        if (busy) return;
        if (preLoading && !files.files.length) { say('例图正在载入，请稍等再发布。'); return; }
        const value = name => form.elements.namedItem(name).value.trim();
        const name = value('title'), nickname = value('signature'), artistString = artistOnly(value('artistString')), negative = value('negative');
        const { members } = M.parseArtistString(artistString);
        if (!name || !nickname) { say('请填写名称和署名。'); return; }
        if (!members.length) { say('请填写带 artist: 的画师串，例如 artist:aaa。'); return; }
        if (files.files.length > 6) { say('最多选择 6 张例图。'); return; }
        const selected = Array.from(files.files);
        if (selected.some(f => !['image/png', 'image/jpeg', 'image/webp'].includes(f.type) || f.size > 20 * 1024 * 1024)) { say('请选择 20MB 以内的 PNG、JPEG 或 WebP 图片。'); return; }
        const nsfw = form.elements.namedItem('nsfw').checked;
        const mark = !!form.elements.namedItem('mark')?.checked;
        const tags = pickedTags(box).filter(t => LOBBY_TAG_SET.has(t));
        if (!tags.some(t => ORIENT.includes(t))) { say('先在标签里选一个性向：男性向、女性向或全性向。'); return; }
        const note = value('note');
        busy = true;
        Array.from(form.elements).forEach(el => { el.disabled = true; });
        try {
            const images = [];
            for (let i = 0; i < selected.length; i++) {
                say(`正在处理例图 ${i + 1}/${selected.length}…`);
                const src = mark ? await processImage(selected[i], { ...dlOpts(), strip: false, on: true }) : selected[i];
                const data = await shrinkDataUrl(await fileToDataUrl(src), 1024, 0.85);
                if ((data.split(',')[1]?.length || 0) * 0.75 > 1024 * 1024) throw new Error('例图压缩后仍超过 1MB，请换一张较小的图片。');
                images.push({ data, nsfw });
            }
            say('正在发布…');
            const post = { nickname, name, kind: members.length === 1 ? 'artist' : 'group', note, tags, nsfw, content: { artistString, members, ...(negative ? { negative } : {}) }, images };
            await L.createPost(post);
            d.lobby.nickname = nickname;
            if (nsfw) d.options.lobbyShowNsfw = true;
            commit();
            box.closeModal();
            Object.assign(ui.lobby, { mine: true, q: '', tag: '', tag2: '', kind: '', sort: 'new' });
            ui.view = 'lobby';
            await loadLobby();
            toastr.success('已发布到共享', '智库');
        } catch (e) {
            say(e.message || '上传失败，请重试');
        } finally {
            busy = false;
            Array.from(form.elements).forEach(el => { el.disabled = false; });
        }
    });
}


async function shareToLobby(ref) {
    const d = getData();
    if (!L.serverBase()) { toastr.warning('先到「设置」里填共享服务器地址', '共享'); return; }
    if (!d.lobby.nickname) {
        const n = await promptText('分享时显示的昵称', '');
        if (!n) return;
        d.lobby.nickname = n.slice(0, 24); commit();
    }
    const t = M.resolveTicket(d, ref);
    const picked = await chooseLobbyTags();
    if (!picked) return;
    const images = [];
    for (const img of t.item.images.slice(0, 6)) {
        try { images.push({ data: await shrinkDataUrl(await urlToDataUrl(imgUrl(img))), nsfw: !!img.nsfw }); } catch { /* 跳过 */ }
    }
    const members = ref.type === 'group'
        ? t.item.members.map(m => ({ tag: d.artists[m.artistId]?.tag, weight: m.weight })).filter(m => m.tag)
        : [{ tag: t.item.tag, weight: 1 }];
    await L.createPost({
        kind: ref.type, name: M.ticketName(d, ref), note: t.item.note || '',
        tags: picked,
        nsfw: images.some(i => i.nsfw),
        content: { artistString: artistOnly(M.ticketString(d, ref)), members, ...(M.ticketNeg(d, ref) ? { negative: M.ticketNeg(d, ref) } : {}) },
        images,
    });
    toastr.success('已分享', '共享');
}

async function copyFromLobby(p, btn) {
    if (!p) return;
    btn.disabled = true;
    const d = getData();
    if (p.kind === 'character' || p.kind === 'outfit') {
        await copyCharacterFromLobby(p);
    } else {
        let ref;
        if ((p.kind === 'artist' || p.content?.members?.length === 1) && !p.content?.negative && !M.parseArtistString(p.content?.artistString || '').extra && (p.content?.members?.[0]?.weight ?? 1) === 1) {
            const a = M.ensureArtist(d, p.content.members?.[0]?.tag || p.content.artistString);
            if (p.note && !a.note) a.note = p.note;
            ref = { type: 'artist', id: a.id };
        } else {
            ref = M.createFromString(d, { name: p.name, text: p.content.artistString, note: p.note, neg: p.content.negative || '', forceGroup: true });
        }
        if (!ref) throw new Error('这一条里没有画师');
        for (const img of p.images) {
            try { await E.saveImageTo(ref, await urlToDataUrl(L.lobbyImgUrl(img.url)), { nsfw: img.nsfw }); } catch (e) { console.warn(e); }
        }
        commit();
        toastr.success(`已保存到画师库：${p.name}`, '共享');
    }
    p.copied = true; render();
    L.copyPost(p.id).then(r => { p.copies = r.copies; render(); }).catch(() => {});
}

/** 共享里的角色 → 角色页「存下的角色」；衣服 → 选一个角色加上去 */
async function copyCharacterFromLobby(p) {
    const payload = p.content?.payload || {};
    if (p.kind === 'character' && payload.character) {
        const key = C.saveCharacterPost(payload, p.name);
        const c = C.getChar(key);
        if (p.images?.[0]) { try { c.image = '/' + (await uploadImage(await shrinkDataUrl(await urlToDataUrl(L.lobbyImgUrl(p.images[0].url)), 512), `char_${M.uid('')}`)).path; C.saveChar(c); } catch { /* 没图也行 */ } }
        toastr.success(`已存到「角色」页 → 存下的角色：${c.name}`, '共享', { timeOut: 4000 });
        return;
    }
    if (p.kind === 'outfit' && payload.outfit) {
        const targets = [...C.currentCast().map(x => x.char), ...C.freeChars().filter(f => !C.currentCast().some(x => x.key === f.key))];
        if (!targets.length) throw new Error('没有可以加衣服的角色，先打开一张角色卡');
        const i = await chooseBox('这套衣服给谁？', targets.map(t => t.name));
        if (i == null) return;
        const c = targets[i];
        const o = C.outfitFromPost(payload, p.name);
        c.outfits.push(o); c.outfitId = o.id; c.outfitMode = 'fixed';
        C.saveChar(c);
        toastr.success(`「${o.name}」已加给 ${c.name}，并设为固定衣服`, '共享', { timeOut: 4000 });
        return;
    }
    throw new Error('这一条的内容不完整');
}

/** 角色页里分享角色 / 衣服 */
async function shareCharacterPost(kind, c, outfit) {
    const d = getData();
    if (!L.serverBase()) throw new Error('先到设置里填共享服务器地址');
    if (!d.lobby.nickname) {
        const n = await promptText('分享时显示的昵称', '');
        if (!n) return;
        d.lobby.nickname = n.slice(0, 24); commit();
    }
    const tags = await chooseLobbyTags();
    if (!tags) return;
    const images = [];
    const pic = kind === 'outfit' ? outfit.image : ui.charTestImg || (c.kind === 'free' ? c.image : '') || C.avatarUrl(c);
    if (pic) { try { images.push({ data: await shrinkDataUrl(pic.startsWith('data:') ? pic : await urlToDataUrl(pic)), nsfw: false }); } catch { /* 没图也行 */ } }
    const payload = kind === 'character' ? C.characterPayload(c) : { outfit: { name: outfit.name, tags: outfit.tags }, owner: c.name };
    await L.createPost({
        kind, name: kind === 'character' ? c.name : outfit.name, note: kind === 'character' ? C.tagText(c.appearance) : C.tagText(outfit.tags),
        tags,
        content: { payload }, images,
    });
    toastr.success('已分享', '共享');
}

// ═════════════════════ 登记 / 模板编辑 ═════════════════════

async function openRegister() {
    const d = getData();
    const presetFixed = ui.studio.pos || '';
    const box = modal(`
      <h3 class="pc-h3">添加画师 / 画师组</h3>
      <label class="pc-label" for="pc-reg-text">画师串（一位画师就存成单个画师，两位以上存成画师组）</label>
      <textarea id="pc-reg-text" class="pc-textarea mono" placeholder="比如：artist:aaa, 0.8::artist:bbb::, year 2024"></textarea>
      ${presetFixed && /artist\s*:/i.test(presetFixed) ? '<button class="pc-pill dashed" data-m="fromfixed">从生图页的正面提示词里取</button>' : ''}
      <label class="pc-label" for="pc-reg-name">名字（画师组用）</label>
      <input id="pc-reg-name" class="pc-input" placeholder="比如：雾面厚涂">
      <label class="pc-label" for="pc-reg-note">备注</label>
      <input id="pc-reg-note" class="pc-input" placeholder="适合什么题材…">
      <div class="pc-actions"><button class="pc-btn" data-m="cancel">算了</button><button class="pc-btn dark" data-m="ok">添加</button></div>`);
    box.addEventListener('click', ev => {
        const m = ev.target.closest('[data-m]')?.dataset.m;
        if (m === 'fromfixed') box.querySelector('#pc-reg-text').value = M.tokenize(presetFixed).filter(t => t.isArtist).map(t => Math.abs(t.weight - 1) < 0.001 ? t.text : `${t.weight}::${t.text}::`).join(', ');
        if (m === 'cancel') box.closeModal();
        if (m === 'ok') {
            const text = box.querySelector('#pc-reg-text').value;
            const ref = M.createFromString(d, { name: box.querySelector('#pc-reg-name').value.trim(), text, note: box.querySelector('#pc-reg-note').value.trim() });
            if (!ref) { toastr.warning('是空的', '添加'); return; }
            commit();
            box.closeModal();
            ui.view = ref.type; ui.detailId = ref.id; ui.backTo = 'book'; render();
        }
    });
}

async function openTemplateEditor(tplId) {
    const d = getData();
    let t = d.templates[tplId] || d.templates.sfw_bust;
    const box = modal('<div data-tpl-body></div>');
    const draw = () => {
        const sh = M.SHOTS[t.shot] || M.SHOTS.bust;
        box.querySelector('[data-tpl-body]').innerHTML = `
      <h3 class="pc-h3">例图提示词</h3>
      <div class="pc-chips wrap">${Object.values(d.templates).map(x => `<button class="pc-pill tiny ${x.id === t.id ? 'on' : 'dashed'} ${x.nsfw ? 'nsfw' : ''}" data-tsel="${esc(x.id)}">${esc(x.name)}</button>`).join('')}</div>
      <div class="pc-dim small pc-mt-s">${esc(t.name)} · ${sh.name} ${sh.ratio}（${t.width}×${t.height}）· 画师串会放在最前面</div>
      <label class="pc-label" for="pc-t-pos">正面</label><textarea id="pc-t-pos" class="pc-textarea mono">${esc(t.positive)}</textarea>
      <label class="pc-label" for="pc-t-neg">负面</label><textarea id="pc-t-neg" class="pc-textarea small mono">${esc(t.negative)}</textarea>
      <div class="pc-actions wrap">
        ${M.DEFAULT_TEMPLATES[t.id] ? '<button class="pc-btn" data-m="reset">恢复默认</button>' : '<button class="pc-btn danger" data-m="del">删除</button>'}
        <button class="pc-btn dark" data-m="ok">保存</button></div>`;
    };
    draw();
    const keep = () => { t.positive = box.querySelector('#pc-t-pos').value; t.negative = box.querySelector('#pc-t-neg').value; };
    box.addEventListener('click', ev => {
        const sel = ev.target.closest('[data-tsel]');
        if (sel) { keep(); t = d.templates[sel.dataset.tsel]; draw(); return; }
        const m = ev.target.closest('[data-m]')?.dataset.m;
        if (m === 'ok') { keep(); commit(); box.closeModal(); }
        if (m === 'reset') { Object.assign(t, structuredClone(M.DEFAULT_TEMPLATES[t.id])); draw(); }
        if (m === 'del') { delete d.templates[t.id]; commit(); box.closeModal(); }
    });
}

// ═════════════════════ 换票抽屉 ═════════════════════

let sheetFilter = 'recent';
function openSwitcher({ onPick } = {}) {
    const d = getData();
    const openedAt = Date.now();
    DOC.querySelector('.pc-sheet-backdrop')?.remove();
    const back = DOC.createElement('div');
    back.className = 'pc-sheet-backdrop fresh'; setTimeout(() => back.classList.remove('fresh'), 400);
    pcMount(back);
    let picked = d.active;
    const charName = E.currentCharacterName();
    const draw = () => {
        let refs = [];
        if (sheetFilter === 'recent') refs = d.recent.filter(r => M.resolveTicket(d, r));
        else if (sheetFilter === 'fav') refs = Object.values(d.groups).filter(g => g.fav).map(g => ({ type: 'group', id: g.id }));
        else if (sheetFilter === 'artists') refs = Object.values(d.artists).map(a => ({ type: 'artist', id: a.id }));
        else if (sheetFilter === 'groups') refs = Object.values(d.groups).sort((a, b) => (b.usedAt || b.createdAt) - (a.usedAt || a.createdAt)).map(g => ({ type: 'group', id: g.id }));
        else refs = Object.values(d.groups).filter(g => g.collections.includes(sheetFilter)).map(g => ({ type: 'group', id: g.id }));
        const bound = E.boundTicketForCurrent();
        const filters = [['recent', '最近用过'], ['fav', '收藏'], ['groups', '全部画师组'], ['artists', '单个画师'], ...Object.values(d.collections).map(c => [c.id, c.name])];
        back.innerHTML = `<section class="pc-sheet" role="dialog" aria-label="切换画师串">
          <div class="pc-sheet-grip" aria-hidden="true"></div>
          <div class="pc-row-between"><div><h3 class="pc-h3">切换画师串</h3></div>
            <button class="pc-icon-btn" data-s="close" aria-label="关闭">${ICON.close}</button></div>
          <div class="pc-current">${seal('在用')}<div class="pc-grow"><b>${d.active ? esc(M.ticketName(d, d.active)) : '没用画师串'}</b><small>${d.active ? esc(M.ticketString(d, d.active)) : '用的是固定提示词里原来的画师'}</small></div>
            ${d.active ? '<button class="pc-pill dashed" data-s="none">不用画师串</button>' : ''}</div>
          <div class="pc-chips">${filters.map(([k, t]) => `<button class="pc-pill ${sheetFilter === k ? 'on' : 'dashed'}" data-s="filter" data-f="${esc(k)}">${esc(t)}</button>`).join('')}</div>
          <div class="pc-hscroll">${refs.map(r => { const c = M.ticketCover(d, r); return `<button class="pc-mini-stub ${M.sameRef(r, picked) ? 'picked' : ''} ${M.sameRef(r, d.active) ? 'active' : ''}" data-s="pick" ${refAttr(r)}>
              <span class="pc-mini-img">${c ? `<img src="${esc(imgUrl(c))}" alt="">` : ''}</span>
              <b>${esc(M.ticketName(d, r))}</b><small>${r.type === 'group' ? `${d.groups[r.id].members.length} 位画师` : '单个画师'}</small></button>`; }).join('') || '<div class="pc-dim">这里还没有画师串</div>'}</div>
          ${charName ? `<label class="pc-switch"><input type="checkbox" data-s-check="bind" ${bound ? 'checked' : ''}><span></span>绑定到角色卡「${esc(charName)}」<small>以后打开这个角色卡，自动用这个画师串</small></label>` : ''}
          <label class="pc-switch"><input type="checkbox" data-s-check="rotate" ${d.rotate !== 'off' ? 'checked' : ''}><span></span>每生成一张就换一个<small>从收藏（没有就从最近用过）里随机换</small></label>
          <label class="pc-switch"><input type="checkbox" data-s-check="once" ${d.oneShot ? 'checked' : ''}><span></span>只用一次<small>生成一张后，自动换回原来的画师串</small></label>
          <button class="pc-btn dark big" data-s="apply" ${picked ? '' : 'disabled'}>${seal()}${picked ? (onPick ? `用「${esc(M.ticketName(d, picked))}」` : `切换到「${esc(M.ticketName(d, picked))}」`) : '先选一个画师串'}</button>
        </section>`;
    };
    let onceNext = d.oneShot;
    back.addEventListener('click', ev => {
        // 手机上松手后浏览器会补发一次点击，刚打开的 0.4 秒内不响应点空白处关闭
        if (ev.target === back) { if (Date.now() - openedAt > 400) back.remove(); return; }
        const el = ev.target.closest('[data-s]');
        if (!el) return;
        const s = el.dataset.s;
        if (s === 'close') back.remove();
        if (s === 'filter') { sheetFilter = el.dataset.f; draw(); }
        if (s === 'pick') { picked = refFrom(el); draw(); }
        if (s === 'none') { E.setActive(null); E.bindCurrentCharacter(null); back.remove(); }
        if (s === 'apply' && picked && onPick) { onPick(picked); back.remove(); return; }
        if (s === 'apply' && picked) {
            E.setActive(picked, { oneShot: onceNext });
            if (back.querySelector('[data-s-check="bind"]')?.checked) E.bindCurrentCharacter(picked);
            toastr.success(`已切换到：${M.ticketName(d, picked)}${onceNext ? '（只用一次）' : ''}`, '智库', { timeOut: 1800 });
            back.remove();
        }
    });
    back.addEventListener('change', ev => {
        const c = ev.target.dataset.sCheck;
        if (c === 'bind') { if (!ev.target.checked) E.bindCurrentCharacter(null); else if (picked) E.bindCurrentCharacter(picked); }
        if (c === 'rotate') { d.rotate = ev.target.checked ? 'random' : 'off'; d.rotatePool = Object.values(d.groups).some(g => g.fav) ? 'fav' : 'recent'; commit(); }
        if (c === 'once') { onceNext = ev.target.checked; }
    });
    draw();
}

// ═════════════════════ 输入框上方的「当前票」 ═════════════════════

function renderChip() {
    const d = getData();
    let chip = DOC.getElementById('pc-chip');
    if (!d.options.showChip) { chip?.remove(); return; }
    const form = DOC.getElementById('send_form');
    if (!form) return;
    if (!chip) {
        chip = DOC.createElement('button');
        chip.id = 'pc-chip';
        chip.type = 'button';
        chip.addEventListener('click', () => openSwitcher());
        form.parentElement.insertBefore(chip, form);
    }
    chip.innerHTML = `${seal('画')}<span>${d.active ? `画师串：${esc(M.ticketName(d, d.active))}${d.oneShot ? '（只用一次）' : ''}` : '没用画师串 · 点这里选'}</span><b>▾</b>`;
    chip.title = d.active ? M.ticketString(d, d.active) : '点一下切换画师串';
}

// ═════════════════════ 数据 ═════════════════════

function importArtistsFromPresets() {
    const s = zSettings() || {};
    const d = getData();
    let n = 0;
    for (const [name, p] of Object.entries(s.yushe || {})) {
        const text = M.tokenize(p.fixedPrompt || '').filter(t => t.isArtist).map(t => Math.abs(t.weight - 1) < 0.001 ? t.text : `${t.weight}::${t.text}::`).join(', ');
        if (!text || Object.values(d.groups).some(g => g.name === name)) continue;
        if (M.createFromString(d, { name, text, note: '从固定提示词预设导入' })) n++;
    }
    commit();
    return n;
}

function exportData() {
    const blob = new Blob([JSON.stringify({ app: 'piaoce', exportedAt: new Date().toISOString(), data: getData() }, null, 2)], { type: 'application/json' });
    const a = DOC.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `画师库_${new Date().toISOString().slice(0, 10)}.json`;
    pcMount(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

// ═════════════════════ 界面上的小票根 ═════════════════════

function renderStub() {
    const d = getData();
    let stub = DOC.getElementById('pc-stub');
    if (!d.options.showStub) { stub?.remove(); return; }
    if (!stub) {
        stub = DOC.createElement('button');
        stub.id = 'pc-stub';
        stub.type = 'button';
        const y = Number(localStorage.getItem('piaoce_stub_y'));
        stub.style.top = (y > 40 && y < P.innerHeight - 60 ? y : Math.round(P.innerHeight * 0.42)) + 'px';
        let startY = 0, startTop = 0, moved = false, pressTimer = null, longPressed = false;
        stub.addEventListener('pointerdown', ev => {
            startY = ev.clientY; startTop = stub.offsetTop; moved = false; longPressed = false;
            stub.setPointerCapture(ev.pointerId);
            pressTimer = setTimeout(() => { longPressed = true; openWindow('book'); }, 550);
        });
        stub.addEventListener('pointermove', ev => {
            if (!stub.hasPointerCapture(ev.pointerId)) return;
            const dy = ev.clientY - startY;
            if (Math.abs(dy) > 6) { moved = true; clearTimeout(pressTimer); }
            if (moved) stub.style.top = Math.min(P.innerHeight - 60, Math.max(40, startTop + dy)) + 'px';
        });
        stub.addEventListener('pointerup', () => {
            clearTimeout(pressTimer);
            if (moved) localStorage.setItem('piaoce_stub_y', String(stub.offsetTop));
        });
        stub.addEventListener('click', ev => {
            ev.stopPropagation();
            if (moved || longPressed) { moved = false; longPressed = false; return; }
            openSwitcher();
        });
        stub.addEventListener('contextmenu', ev => ev.preventDefault());
        pcMount(stub);
    }
    stub.innerHTML = `<span class="pc-stub-label">画师串</span><b>${esc(d.active ? M.ticketName(d, d.active) : '未选')}</b>${d.oneShot ? '<em>一次</em>' : ''}`;
    stub.title = d.active ? `当前画师串：${M.ticketString(d, d.active)}\n点一下切换，长按打开画师库` : '点一下选画师串，长按打开画师库';
}

// ═════════════════════ 弹窗小工具 ═════════════════════

function modal(inner) {
    const back = DOC.createElement('div');
    back.className = 'pc-modal-backdrop';
    back.innerHTML = `<div class="pc-modal" role="dialog">${inner}</div>`;
    pcMount(back);
    const box = back.querySelector('.pc-modal');
    box.closeModal = () => back.remove();
    const openedAt = Date.now();
    back.addEventListener('click', ev => { if (ev.target === back && Date.now() - openedAt > 400) back.remove(); });
    setTimeout(() => { if (back.isConnected && DOC.querySelectorAll('.pc-modal-backdrop')[DOC.querySelectorAll('.pc-modal-backdrop').length - 1] === back) box.querySelector('textarea, input')?.focus(); }, 30);
    return box;
}
function promptText(title, value = '', multiline = false) {
    return new Promise(resolve => {
        const box = modal(`<h3 class="pc-h3">${esc(title)}</h3>
          ${multiline ? `<textarea class="pc-textarea mono" data-v>${esc(value)}</textarea>` : `<input class="pc-input" data-v value="${esc(value)}">`}
          <div class="pc-actions"><button class="pc-btn" data-m="no">算了</button><button class="pc-btn dark" data-m="ok">好</button></div>`);
        const done = v => { box.closeModal(); resolve(v); };
        // 单行（取名字之类）：打开时全选，一打字就替换掉旧的
        if (!multiline) {
            const inp = box.querySelector('[data-v]'), initial = inp.value;
            let touched = false;
            for (const event of ['pointerdown', 'input', 'keydown']) inp.addEventListener(event, () => { touched = true; }, { once: true });
            setTimeout(() => {
                if (!box.isConnected || touched || inp.value !== initial) return;
                if (DOC.activeElement?.matches('input, textarea') && DOC.activeElement !== inp) return;
                try { inp.focus({ preventScroll: true }); inp.select(); } catch { }
            }, 60);
        }
        box.addEventListener('click', ev => { const m = ev.target.closest('[data-m]')?.dataset.m; if (m === 'ok') done(box.querySelector('[data-v]').value.trim()); if (m === 'no') done(null); });
        box.addEventListener('keydown', ev => { if (ev.key === 'Enter' && !multiline && !ev.isComposing && ev.keyCode !== 229) done(box.querySelector('[data-v]').value.trim()); });
        box.parentElement.addEventListener('click', ev => { if (ev.target === box.parentElement) resolve(null); });
    });
}
function confirmBox(text, { ok = '好', cancel = '算了' } = {}) {
    return new Promise(resolve => {
        const box = modal(`<p class="pc-confirm">${esc(text)}</p><div class="pc-actions"><button class="pc-btn" data-m="no">${esc(cancel)}</button><button class="pc-btn dark" data-m="ok">${esc(ok)}</button></div>`);
        box.addEventListener('click', ev => { const m = ev.target.closest('[data-m]')?.dataset.m; if (m) { box.closeModal(); resolve(m === 'ok'); } });
        box.parentElement.addEventListener('click', ev => { if (ev.target === box.parentElement) resolve(false); });
    });
}
function chooseBox(title, options) {
    return new Promise(resolve => {
        const box = modal(`<h3 class="pc-h3">${esc(title)}</h3><div class="pc-choose">${options.map((o, i) => `<button class="pc-btn wide" data-i="${i}">${esc(o)}</button>`).join('')}</div><div class="pc-actions"><button class="pc-btn" data-m="no">算了</button></div>`);
        box.addEventListener('click', ev => {
            const b = ev.target.closest('[data-i]');
            if (b) { box.closeModal(); resolve(Number(b.dataset.i)); }
            if (ev.target.closest('[data-m="no"]')) { box.closeModal(); resolve(null); }
        });
    });
}
function openViewer(src, list = []) {
    if (!src) return;
    const all = list.length ? list : [src];
    let i = Math.max(0, all.indexOf(src));
    const back = DOC.createElement('div');
    back.className = 'pc-viewer';
    const draw = () => {
        back.innerHTML = `<img src="${esc(all[i])}" alt="">
          <button class="pc-viewer-x" data-v="x" aria-label="关闭">${ICON.close}</button>
          ${all.length > 1 ? `<button class="pc-viewer-nav l" data-v="-1" aria-label="上一张">‹</button><button class="pc-viewer-nav r" data-v="1" aria-label="下一张">›</button><span class="pc-viewer-n">${i + 1} / ${all.length}</span>` : ''}
          <a class="pc-viewer-dl" href="${esc(all[i])}" download="zhiku_${Date.now()}.png" data-v="dl">下载</a>`;
    };
    const go = n => { i = (i + n + all.length) % all.length; draw(); };
    draw();
    back.addEventListener('click', ev => {
        const v = ev.target.closest('[data-v]')?.dataset.v;
        if (v === 'dl') return;
        if (v === '-1' || v === '1') { ev.stopPropagation(); go(Number(v)); return; }
        if (ev.target.tagName === 'IMG') return; // 点图本身不关
        back.remove();
    });
    let sx = null;
    back.addEventListener('touchstart', ev => { sx = ev.touches[0].clientX; }, { passive: true });
    back.addEventListener('touchend', ev => { if (sx == null) return; const dx = ev.changedTouches[0].clientX - sx; sx = null; if (Math.abs(dx) > 50 && all.length > 1) go(dx < 0 ? 1 : -1); });
    pcMount(back);
}

const ICON = {
    close: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>',
    back: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>',
    search: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="m16 16 4 4"/></svg>',
    flag: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 21V4h11l-2 4 2 4H5"/></svg>',
};

return { modal, esc, openWindow, closeWindow, openInpaintEditor, openOutfitDesigner, openSwitcher, renderChip, importArtistsFromPresets, exportData, renderStub };
})();

// ───── script-entry.js ─────
const __mod_script_entry = (() => {
/**
 * 画师库 · 酒馆助手脚本版入口
 * 不需要智绘姬：填好 NovelAI key 就能用。
 */
const eventSource = new Proxy({}, { get: (_, k) => { const v = __shim.eventSource[k]; return typeof v === 'function' ? v.bind(__shim.eventSource) : v; }, set: (_, k, v) => { __shim.eventSource[k] = v; return true; } });
const event_types = new Proxy({}, { get: (_, k) => { const v = __shim.event_types[k]; return typeof v === 'function' ? v.bind(__shim.event_types) : v; }, set: (_, k, v) => { __shim.event_types[k] = v; return true; } });
const { loadData, onChange } = __mod_store;
const E = __mod_engine;
const N = __mod_nai;
const UI = __mod_ui;
const C = __mod_chars;
const { getData } = __mod_store;
const cleanups = [];


function injectCss() {
    DOC.getElementById('pc-css')?.remove();
    const style = DOC.createElement('style');
    style.id = 'pc-css';
    style.textContent = "/*\n * 画师票册 · 旅馆票卡风\n * 开着「旅馆票卡」美化时直接用它的颜色和字体变量，没开时用下面的默认值。\n */\n@import url(\"https://fonts.googleapis.com/css2?family=Noto+Serif+SC:wght@400;500;700&display=swap\");\n\n:root {\n    --pc-mist: var(--tk-accent, #7ea29c);\n    --pc-ink: var(--tk-ink, #3a2a22);\n    --pc-ink-soft: var(--tk-ink-soft, #6e5a4d);\n    --pc-paper: var(--tk-paper, #f4efe4);\n    --pc-paper-2: var(--cl-paper, #ebe4d2);\n    --pc-paper-user: var(--tk-paper-user, #f1e8d3);\n    --pc-gold: var(--tk-gold, #c98a3e);\n    --pc-danger: var(--cl-danger, #9b4f45);\n    --pc-dash: var(--tk-dash, rgba(58, 42, 34, .55));\n    --pc-font: \"Noto Serif SC\", \"Source Han Serif SC\", \"Songti SC\", \"SimSun\", serif;\n    --pc-font-name: \"Noto Serif SC\", \"Source Han Serif SC\", \"Songti SC\", serif;\n    --pc-font-label: ui-monospace, \"SFMono-Regular\", Menlo, Consolas, \"Noto Sans Mono\", monospace;\n    --pc-shadow: 0 4px 0 rgba(26, 22, 18, .22);\n    --pc-wax: var(--pc-gold);\n}\n\n/* ───────── 外框 ───────── */\nbody.pc-lock { overflow: hidden; }\n.pc-overlay {\n    position: fixed; inset: 0; z-index: 2147480000; display: none;\n    background-color: var(--pc-mist);\n    background-image: radial-gradient(rgba(28, 34, 38, .22) 1px, transparent 1.5px);\n    background-size: 7px 7px;\n    color: var(--pc-ink); font-family: var(--pc-font); font-size: 15px; line-height: 1.6;\n}\n.pc-overlay.open { display: block; }\n.pc-overlay *, .pc-sheet *, .pc-modal * { box-sizing: border-box; }\n.pc-overlay ::-webkit-scrollbar, .pc-sheet ::-webkit-scrollbar, .pc-modal ::-webkit-scrollbar { display: none; }\n.pc-overlay *, .pc-sheet *, .pc-modal * { scrollbar-width: none; }\n\n.pc-shell { height: 100%; max-width: 620px; margin: 0 auto; display: flex; flex-direction: column; }\n.pc-head { padding: max(12px, env(safe-area-inset-top)) 12px 0; flex-shrink: 0; }\n.pc-head-card {\n    position: relative; display: flex; align-items: center; gap: 10px;\n    padding: 10px 12px 10px 16px; background: var(--pc-paper);\n    border: 1.5px solid var(--pc-ink); border-radius: 18px; box-shadow: var(--pc-shadow);\n}\n.pc-title { font-family: var(--pc-font-name); font-weight: 700; font-size: 24px; letter-spacing: 4px; line-height: 1.2; }\n.pc-head-ticket { flex: 1; min-width: 0; display: grid; grid-template-columns: auto auto; grid-template-rows: auto auto; justify-content: end; align-items: center; column-gap: 4px; text-align: right; font-size: 13px; border: 0; background: transparent; color: var(--pc-ink); font-family: var(--pc-font); cursor: pointer; padding: 4px; }\n.pc-head-ticket span:not(.pc-seal) { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }\n.pc-head-lab { grid-column: 1 / 3; font-size: 10px; letter-spacing: .12em; color: var(--pc-ink-soft); }\n.pc-head-ticket > span { font-weight: 600; max-width: 34vw; }\n.pc-head-caret { font-size: 10px; color: var(--pc-ink-soft); font-weight: 400; }\n.pc-head-ticket em { font-style: normal; font-size: 11px; color: var(--pc-ink-soft); }\n.pc-nav { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 4px; margin-top: 10px; }\n.pc-nav .pc-pill { font-size: 13px; padding: 0 2px; letter-spacing: 0; }\n.pc-nav .pc-pill { padding: 0 4px; }\n.pc-body { flex: 1; overflow-y: auto; padding: 12px 12px 120px; -webkit-overflow-scrolling: touch; }\n\n/* ───────── 基础件 ───────── */\n.pc-label { font-size: 12px; color: var(--pc-ink-soft); margin-top: 10px; display: block; }\n.pc-label:first-child { margin-top: 0; }\n.pc-h2 { margin: 2px 0 6px; font-family: var(--pc-font-name); font-weight: 700; font-size: 22px; letter-spacing: 3px; }\n.pc-h3 { margin: 2px 0 10px; font-family: var(--pc-font-name); font-weight: 700; font-size: 19px; letter-spacing: 2px; }\n.mono, .pc-h2.mono { font-family: var(--pc-font-label); letter-spacing: 0; }\n.pc-dim { color: var(--pc-ink-soft); }\n.small { font-size: 12px; }\n.pc-hint { font-size: 12px; color: var(--pc-ink-soft); margin-top: 6px; }\n.pc-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }\n.pc-mt { margin-top: 14px; }\n.pc-mt-s { margin-top: 10px; }\n.pc-grow { flex: 1; min-width: 0; }\n.span2 { grid-column: span 2; }\n.pc-row-between { display: flex; justify-content: space-between; align-items: center; gap: 8px; }\n\n.pc-card { position: relative; background: var(--pc-paper); border: 1.5px solid var(--pc-ink); border-radius: 18px; box-shadow: var(--pc-shadow); }\n.pc-pad { padding: 14px 16px; }\n.pc-pad-s { padding: 10px 12px; }\n.pc-badge { padding: 4px 12px; border-radius: 999px; background: var(--pc-paper); border: 1.5px solid var(--pc-ink); font-size: 13px; }\n\n.pc-pill, .pc-btn, .pc-icon-btn, .pc-back, .pc-linkish, #pc-chip, .pc-seg button, .pc-stepper button {\n    font-family: var(--pc-font); color: var(--pc-ink); cursor: pointer; -webkit-tap-highlight-color: transparent;\n}\n.pc-pill {\n    flex-shrink: 0; min-height: 36px; padding: 0 14px; border-radius: 999px; font-size: 14px;\n    border: 1.5px solid var(--pc-ink); background: var(--pc-paper);\n}\n.pc-pill.dashed { border-style: dashed; border-color: var(--pc-dash); background: rgba(244, 239, 228, .7); }\n.pc-pill.on { background: var(--pc-ink); color: var(--pc-paper); border-style: solid; border-color: var(--pc-ink); }\n.pc-pill.gold { border: 0; background: rgba(201, 138, 62, .2); }\n.pc-pill.nsfw { border-color: var(--pc-danger); color: #7a3a32; font-family: var(--pc-font-label); }\n.pc-pill.nsfw.on { background: var(--pc-danger); color: #fbf8f0; }\n.pc-nav .pc-pill { width: 100%; }\n\n.pc-btn {\n    display: inline-flex; align-items: center; justify-content: center; gap: 8px; min-height: 44px; padding: 0 16px;\n    border: 1.5px solid var(--pc-ink); border-radius: 999px; background: var(--pc-paper); font-size: 14px;\n    box-shadow: var(--pc-shadow); text-decoration: none;\n}\n.pc-btn.dark { background: var(--pc-ink); color: var(--pc-paper); }\n.pc-btn.big { width: 100%; min-height: 54px; font-size: 17px; }\n.pc-btn.wide { width: 100%; }\n.pc-btn.small { min-height: 32px; padding: 0 12px; font-size: 12px; box-shadow: none; }\n.pc-btn.danger { border-color: var(--pc-danger); color: var(--pc-danger); box-shadow: none; }\n.pc-btn:disabled { opacity: .6; cursor: default; }\n.pc-btn:active, .pc-pill:active { transform: translateY(2px); box-shadow: none; }\n\n.pc-icon-btn {\n    flex-shrink: 0; width: 40px; height: 40px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center;\n    border: 1.5px dashed var(--pc-dash); background: rgba(244, 239, 228, .9); font-size: 16px;\n}\n.pc-icon-btn.small { width: 30px; height: 30px; border: 0; background: transparent; }\n.pc-icon-btn.gold { border: 0; background: var(--pc-wax); color: #fbf8f0; font-family: var(--pc-font-name); font-weight: 700; }\n.pc-back {\n    display: inline-flex; align-items: center; gap: 4px; min-height: 40px; padding: 0 14px;\n    border: 1.5px dashed var(--pc-dash); border-radius: 999px; background: rgba(244, 239, 228, .9); font-size: 14px;\n}\n.pc-linkish { border: 0; background: transparent; padding: 4px 0; font-size: 14px; color: #26352f; }\n.pc-card .pc-linkish { color: var(--pc-ink); }\n.pc-linkish.strong { font-weight: 700; color: var(--pc-ink); }\n\n/* 蜡封：贯穿整个插件的记号 */\n.pc-seal {\n    flex-shrink: 0; width: 22px; height: 22px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center;\n    background: var(--pc-wax);\n    color: #fbf8f0; font-family: var(--pc-font-name); font-weight: 700; font-size: 11px; line-height: 1;\n}\n.pc-head-ticket .pc-seal, .pc-current .pc-seal { width: 30px; height: 30px; font-size: 12px; }\n.pc-on-seam { position: absolute; left: 50%; top: 104px; margin-left: -15px; width: 30px; height: 30px; font-size: 13px; z-index: 2; }\n\n/* 票根缺口分隔：虚线两头各挖一个半圆 */\n.pc-notch { position: relative; height: 0; margin: 12px -16px; border-top: 1.5px dashed rgba(58, 42, 34, .45); }\n.pc-notch i { position: absolute; top: -10px; width: 18px; height: 18px; border-radius: 50%; background: var(--pc-mist); border: 1.5px solid var(--pc-ink); }\n.pc-notch i:first-child { left: -10px; clip-path: inset(0 0 0 50%); }\n.pc-notch i:last-child { right: -10px; clip-path: inset(0 50% 0 0); }\n\n/* 输入 */\n.pc-textarea, .pc-input, .pc-field input, .pc-field select, .pc-title-input {\n    width: 100%; border: 0; border-radius: 12px; background: var(--pc-paper-2); color: var(--pc-ink);\n    font-family: var(--pc-font); font-size: 14px; padding: 10px 12px; outline: none; margin-top: 4px;\n}\n.pc-textarea { min-height: 92px; resize: vertical; line-height: 1.6; }\n.pc-textarea.small { min-height: 64px; }\n.pc-textarea.mono, .pc-input.mono { font-family: var(--pc-font-label); font-size: 13px; }\n.pc-title-input { background: transparent; font-family: var(--pc-font-name); font-weight: 700; font-size: 22px; letter-spacing: 3px; padding: 0; margin: 0; }\n.pc-textarea:focus, .pc-input:focus, .pc-field input:focus, .pc-field select:focus { box-shadow: 0 0 0 2px var(--pc-ink); }\n.pc-overlay ::placeholder, .pc-modal ::placeholder { color: #7c6a5d; opacity: 1; }\n.pc-field { display: block; font-size: 12px; color: var(--pc-ink-soft); }\n.pc-field input, .pc-field select { margin-top: 2px; font-family: var(--pc-font-label); font-size: 13px; color: var(--pc-ink); }\n.pc-grid4 { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; margin-top: 6px; }\n.pc-grid2 { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px 12px; }\n.pc-grid3 { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }\n.pc-details summary { cursor: pointer; color: var(--pc-ink-soft); font-size: 13px; margin-top: 8px; }\n.pc-search { display: flex; align-items: center; gap: 8px; margin-top: 12px; height: 46px; padding: 0 16px; border: 1.5px dashed var(--pc-dash); border-radius: 999px; background: var(--pc-paper); color: var(--pc-ink); }\n.pc-search input { flex: 1; min-width: 0; border: 0; outline: none; background: transparent; font-family: var(--pc-font); font-size: 14px; color: var(--pc-ink); }\n\n.pc-switch { display: flex; align-items: center; gap: 10px; min-height: 42px; font-size: 14px; cursor: pointer; flex-wrap: wrap; }\n.pc-switch small { flex-basis: 100%; padding-left: 56px; margin-top: -6px; font-size: 11px; color: var(--pc-ink-soft); }\n.pc-switch input { position: absolute; opacity: 0; width: 1px; height: 1px; }\n.pc-switch > span { flex-shrink: 0; position: relative; width: 46px; height: 26px; border-radius: 999px; background: rgba(58, 42, 34, .18); }\n.pc-switch > span::after { content: \"\"; position: absolute; top: 3px; left: 3px; width: 20px; height: 20px; border-radius: 50%; background: var(--pc-wax); transition: left .15s; }\n.pc-switch input:checked + span { background: var(--pc-ink); }\n.pc-switch input:checked + span::after { left: 23px; }\n.pc-switch input:focus-visible + span { box-shadow: 0 0 0 2px var(--pc-gold); }\n\n.pc-slider { display: grid; grid-template-columns: 56px 1fr 40px; align-items: center; gap: 8px; font-size: 12px; color: var(--pc-ink-soft); }\n.pc-slider b { font-family: var(--pc-font-label); font-weight: 400; color: var(--pc-ink); }\n.pc-slider input { -webkit-appearance: none; appearance: none; width: 100%; height: 8px; border-radius: 999px; background: rgba(58, 42, 34, .14); outline: none; }\n.pc-slider input::-webkit-slider-thumb { -webkit-appearance: none; width: 22px; height: 22px; border-radius: 50%; background: var(--pc-wax); cursor: pointer; }\n.pc-slider input::-moz-range-thumb { width: 22px; height: 22px; border: 0; border-radius: 50%; background: var(--pc-gold); cursor: pointer; }\n\n.pc-chips { display: flex; gap: 6px; overflow-x: auto; margin-top: 10px; padding-bottom: 2px; }\n.pc-chips.wrap { flex-wrap: wrap; overflow: visible; margin-top: 6px; }\n.pc-chips.tiny { margin-top: 4px; }\n.pc-tagchip { font-size: 11px; padding: 1px 8px; border-radius: 999px; border: 1px dashed var(--pc-dash); }\n.pc-tagchip.nsfw { border-color: var(--pc-danger); color: #7a3a32; font-family: var(--pc-font-label); }\n.pc-quote { margin: 6px 0 0; padding: 10px 12px; border-radius: 12px; background: rgba(201, 138, 62, .16); font-size: 14px; line-height: 1.7; word-break: break-word; }\n.pc-quote.small { font-size: 12px; background: rgba(58, 42, 34, .07); color: var(--pc-ink-soft); }\n.pc-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 12px; }\n.pc-actions.wrap { flex-wrap: wrap; justify-content: flex-start; }\n.pc-seg { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); padding: 4px; border-radius: 999px; background: rgba(244, 239, 228, .6); }\n.pc-seg button { min-height: 36px; border: 1.5px solid transparent; border-radius: 999px; background: transparent; font-size: 14px; }\n.pc-seg button.on { border-color: var(--pc-ink); background: var(--pc-paper); font-weight: 700; }\n.pc-empty { padding: 26px 16px; text-align: center; border: 1.5px dashed var(--pc-dash); border-radius: 16px; background: rgba(244, 239, 228, .6); display: flex; flex-direction: column; gap: 4px; }\n.pc-empty span { font-size: 13px; color: var(--pc-ink-soft); }\n\n/* 底部常驻按钮条，下面淡出到雾青底 */\n.pc-bottom-bar {\n    position: fixed; left: 0; right: 0; bottom: 0; z-index: 2; display: flex; gap: 8px; justify-content: center;\n    padding: 40px max(12px, calc(50vw - 298px)) max(18px, env(safe-area-inset-bottom));\n    background: linear-gradient(to bottom, rgba(126, 162, 156, 0), var(--pc-mist) 55%); pointer-events: none;\n}\n.pc-bottom-bar > * { pointer-events: auto; flex: 1; max-width: 320px; }\n\n/* ───────── 票卡（画师 / 画师组） ───────── */\n.pc-ticket { position: relative; min-width: 0; background: var(--pc-paper); border: 1.5px solid var(--pc-ink); border-radius: 16px; box-shadow: var(--pc-shadow); cursor: pointer; }\n.pc-ticket.active { box-shadow: 0 0 0 3px var(--pc-gold), var(--pc-shadow); }\n.pc-ticket-img { height: 120px; border-radius: 14.5px 14.5px 0 0; overflow: hidden; background: #cdbfa8; -webkit-mask-image: linear-gradient(#000 72%, transparent); mask-image: linear-gradient(#000 72%, transparent); display: flex; align-items: center; justify-content: center; }\n.pc-ticket-img img { width: 100%; height: 100%; object-fit: cover; }\n.pc-ticket-img span { font-size: 12px; color: var(--pc-ink-soft); }\n.pc-ticket .pc-notch { margin: 4px 0 0; }\n.pc-ticket-text { padding: 12px 12px 12px; display: flex; flex-direction: column; gap: 3px; min-width: 0; }\n.pc-ticket-text b { font-family: var(--pc-font-name); font-size: 16px; overflow-wrap: anywhere; }\n.pc-ticket-text small { font-size: 12px; line-height: 1.5; color: var(--pc-ink-soft); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; word-break: break-all; }\n.pc-ticket-text em { font-style: normal; font-size: 11px; color: var(--pc-ink-soft); }\n\n.pc-thumbs { display: flex; gap: 8px; overflow-x: auto; margin-top: 10px; padding: 2px; }\n.pc-thumb-wrap { position: relative; flex-shrink: 0; }\n.pc-thumb { position: relative; flex-shrink: 0; width: 92px; height: 120px; border-radius: 12px; border: 1.5px solid var(--pc-ink); overflow: hidden; background: #cdbfa8; cursor: zoom-in; display: flex; align-items: center; justify-content: center; }\n.pc-thumbs.small .pc-thumb { width: 64px; height: 84px; border-radius: 10px; }\n.pc-thumb img { width: 100%; height: 100%; object-fit: cover; }\n.pc-thumb-add { border-style: dashed; border-color: var(--pc-dash); background: transparent; cursor: pointer; font-size: 12px; text-align: center; line-height: 1.4; color: var(--pc-ink); font-family: var(--pc-font); }\n.pc-thumb-empty { cursor: default; }\n.pc-tag-mini { position: absolute; left: 5px; bottom: 5px; padding: 0 6px; border-radius: 999px; background: rgba(244, 239, 228, .92); font-family: var(--pc-font-label); font-size: 9px; color: var(--pc-ink); }\n.pc-nsfw-hide { border-style: dashed; border-color: var(--pc-danger); background: rgba(244, 239, 228, .6); }\n.pc-nsfw-note { font-size: 11px; color: #7a3a32; text-align: center; padding: 4px; }\n.pc-thumb-del { position: absolute; right: -6px; top: -6px; width: 24px; height: 24px; border-radius: 50%; border: 1.5px solid var(--pc-ink); background: var(--pc-paper); color: var(--pc-ink); font-size: 13px; line-height: 1; cursor: pointer; }\n.pc-stepper { display: flex; align-items: center; gap: 2px; border: 1px dashed var(--pc-dash); border-radius: 999px; padding: 2px; flex-shrink: 0; }\n.pc-stepper button { width: 30px; height: 30px; border: 0; border-radius: 50%; background: transparent; font-size: 16px; }\n.pc-stepper span { min-width: 34px; text-align: center; font-family: var(--pc-font-label); font-size: 13px; }\n\n.pc-ticket-row { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin: 8px 0 4px; }\n.pc-stub-chip { display: inline-flex; align-items: center; gap: 6px; min-height: 34px; padding: 0 4px 0 6px; border-radius: 999px; background: rgba(201, 138, 62, .2); font-size: 14px; }\n.pc-x { width: 26px; height: 26px; border: 0; border-radius: 50%; background: transparent; color: var(--pc-ink-soft); font-size: 16px; cursor: pointer; }\n.pc-result img { display: block; width: 100%; border-radius: 16.5px 16.5px 0 0; cursor: zoom-in; }\n.pc-result .pc-actions { padding: 0 12px 12px; flex-wrap: wrap; }\n\n/* 批量 */\n.pc-batch-cell { position: relative; height: 150px; border-radius: 12px; border: 1.5px dashed var(--pc-dash); background: rgba(244, 239, 228, .6); overflow: hidden; display: flex; align-items: center; justify-content: center; font-size: 12px; color: var(--pc-ink-soft); }\n.pc-batch-cell.done { border-style: solid; border-color: var(--pc-ink); }\n.pc-batch-cell.error { border-color: var(--pc-danger); color: #7a3a32; }\n.pc-batch-cell img { width: 100%; height: 100%; object-fit: cover; }\n.pc-batch-name { position: absolute; left: 5px; right: 5px; bottom: 5px; display: flex; align-items: center; gap: 4px; padding: 2px 8px; border-radius: 999px; background: rgba(244, 239, 228, .94); font-family: var(--pc-font-label); font-size: 10px; color: var(--pc-ink); white-space: nowrap; overflow: hidden; }\n\n/* 氛围 */\n.pc-hscroll { display: flex; gap: 10px; overflow-x: auto; padding: 4px 2px 8px; margin-top: 10px; }\n.pc-vibe-set { flex-shrink: 0; width: 120px; padding: 8px 8px 10px; border-radius: 14px; background: var(--pc-paper); border: 1.5px dashed var(--pc-dash); display: flex; flex-direction: column; gap: 3px; text-align: left; cursor: pointer; color: var(--pc-ink); font-family: var(--pc-font); }\n.pc-vibe-set.on { border: 1.5px solid var(--pc-ink); box-shadow: var(--pc-shadow); }\n.pc-vibe-set.add { align-items: center; justify-content: center; text-align: center; min-height: 130px; background: rgba(244, 239, 228, .6); }\n.pc-vibe-set small { font-family: var(--pc-font-label); font-size: 10px; color: var(--pc-ink-soft); }\n.pc-mosaic { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 3px; height: 72px; }\n.pc-mosaic i { border-radius: 6px; background: #b8b0a2 center/cover no-repeat; }\n.pc-vibe-row { display: flex; gap: 12px; align-items: center; }\n.pc-vibe-row .pc-thumb { width: 64px; height: 64px; border-radius: 10px; }\n\n/* 大堂：票根横版 */\n.pc-list { display: flex; flex-direction: column; gap: 12px; }\n.pc-lobby-card { position: relative; display: flex; min-height: 136px; background: var(--pc-paper); border: 1.5px solid var(--pc-ink); border-radius: 16px; box-shadow: var(--pc-shadow); }\n.pc-lobby-img { position: relative; width: 104px; flex-shrink: 0; border-radius: 14.5px 0 0 14.5px; overflow: hidden; background: #cdbfa8; display: flex; align-items: center; justify-content: center; cursor: zoom-in; }\n.pc-lobby-img img { width: 100%; height: 100%; object-fit: cover; }\n.pc-lobby-img span { font-size: 12px; color: var(--pc-ink-soft); }\n.pc-lobby-img em { position: absolute; right: 6px; bottom: 6px; font-style: normal; font-family: var(--pc-font-label); font-size: 10px; padding: 0 6px; border-radius: 999px; background: rgba(244, 239, 228, .9); color: var(--pc-ink); }\n.pc-lobby-perf { position: relative; width: 0; border-left: 1.5px dashed rgba(58, 42, 34, .45); }\n.pc-lobby-perf::before, .pc-lobby-perf::after { content: \"\"; position: absolute; left: -9.5px; width: 16px; height: 16px; border-radius: 50%; background: var(--pc-mist); border: 1.5px solid var(--pc-ink); }\n.pc-lobby-perf::before { top: -10px; clip-path: inset(50% 0 0 0); }\n.pc-lobby-perf::after { bottom: -10px; clip-path: inset(0 0 50% 0); }\n.pc-lobby-text { flex: 1; min-width: 0; padding: 8px 12px 10px 14px; display: flex; flex-direction: column; gap: 3px; }\n.pc-lobby-text b { font-family: var(--pc-font-name); font-size: 16px; }\n.pc-lobby-text small { font-size: 12px; color: var(--pc-ink-soft); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; word-break: break-all; }\n\n/* ───────── 输入框上方的「当前票」 ───────── */\n#pc-chip {\n    display: inline-flex; align-items: center; gap: 8px; max-width: calc(100% - 16px); margin: 0 8px 6px; height: 34px; padding: 0 12px 0 6px;\n    border: 1.5px solid var(--pc-ink); border-radius: 999px; background: var(--pc-paper); box-shadow: 0 3px 0 rgba(26, 22, 18, .2);\n    font-size: 13px; align-self: flex-start;\n}\n#pc-chip span:not(.pc-seal) { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }\n#pc-chip b { font-weight: 400; color: var(--pc-ink-soft); }\n.pc-menu-seal { display: inline-block; width: 14px; height: 14px; border-radius: 50%; background: var(--pc-wax); }\n\n/* ───────── 换票抽屉 / 弹窗 / 看大图 ───────── */\n.pc-sheet-backdrop, .pc-modal-backdrop { position: fixed; inset: 0; z-index: 2147480010; background: rgba(28, 34, 38, .4); display: flex; color: var(--pc-ink); font-family: var(--pc-font); }\n.pc-sheet-backdrop { align-items: flex-end; justify-content: center; }\n.pc-sheet {\n    width: 100%; max-width: 620px; max-height: 88vh; overflow-y: auto; padding: 8px 18px max(20px, env(safe-area-inset-bottom));\n    background: var(--pc-paper); border: 1.5px solid var(--pc-ink); border-bottom: 0; border-radius: 24px 24px 0 0;\n    display: flex; flex-direction: column; gap: 6px; animation: none;\n}\n@keyframes pc-up { from { transform: translateY(30px); opacity: .4; } }\n.pc-sheet-grip { width: 44px; height: 5px; border-radius: 3px; background: rgba(58, 42, 34, .3); margin: 2px auto 6px; }\n.pc-current { display: flex; align-items: center; gap: 10px; padding: 10px 12px; border-radius: 14px; background: rgba(201, 138, 62, .18); }\n.pc-current b { display: block; font-family: var(--pc-font-name); }\n.pc-current small { display: block; font-size: 12px; color: var(--pc-ink-soft); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }\n.pc-mini-stub { flex-shrink: 0; width: 112px; padding: 0; border-radius: 14px; background: var(--pc-paper); border: 1.5px dashed var(--pc-dash); display: flex; flex-direction: column; overflow: hidden; cursor: pointer; text-align: left; color: var(--pc-ink); font-family: var(--pc-font); }\n.pc-mini-stub.active { border: 1.5px solid var(--pc-ink); }\n.pc-mini-stub.picked { border: 2.5px solid var(--pc-gold); box-shadow: 0 4px 0 rgba(201, 138, 62, .4); }\n.pc-mini-img { display: block; height: 96px; background: #cdbfa8; }\n.pc-mini-img img { width: 100%; height: 100%; object-fit: cover; }\n.pc-mini-stub b { font-family: var(--pc-font-name); font-size: 13px; padding: 6px 8px 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }\n.pc-mini-stub small { font-family: var(--pc-font-label); font-size: 10px; color: var(--pc-ink-soft); padding: 0 8px 8px; }\n\n.pc-modal-backdrop { align-items: center; justify-content: center; padding: 16px; }\n.pc-modal { width: 100%; max-width: 480px; max-height: 90vh; overflow-y: auto; padding: 16px 18px; background: var(--pc-paper); border: 1.5px solid var(--pc-ink); border-radius: 18px; box-shadow: var(--pc-shadow); }\n.pc-confirm { margin: 0; font-size: 15px; line-height: 1.7; }\n.pc-choose { display: flex; flex-direction: column; gap: 8px; }\n.pc-viewer { position: fixed; inset: 0; z-index: 2147480020; background: rgba(20, 18, 16, .88); display: flex; align-items: center; justify-content: center; padding: 12px; cursor: zoom-out; }\n.pc-viewer img { max-width: 100%; max-height: calc(100% - 70px); object-fit: contain; border-radius: 12px; border: 1.5px solid var(--pc-paper); cursor: default; }\n.pc-viewer-x { position: absolute; top: 14px; right: 14px; width: 42px; height: 42px; border-radius: 50%; border: 1.5px solid var(--pc-paper) !important; background: rgba(20,18,16,.6) !important; color: var(--pc-paper) !important; display: grid; place-items: center; cursor: pointer; }\n.pc-viewer-nav { position: absolute; top: 50%; transform: translateY(-50%); width: 40px; height: 56px; border-radius: 20px; border: 0 !important; background: rgba(243,238,226,.18) !important; color: var(--pc-paper) !important; font-size: 26px; cursor: pointer; }\n.pc-viewer-nav.l { left: 8px; } .pc-viewer-nav.r { right: 8px; }\n.pc-viewer-n { position: absolute; bottom: 22px; left: 20px; color: var(--pc-paper); font-size: 13px; letter-spacing: .1em; }\n.pc-viewer-dl { position: absolute; bottom: 14px; right: 16px; padding: 8px 18px; border-radius: 999px; border: 1.5px solid var(--pc-paper); color: var(--pc-paper) !important; text-decoration: none; font-size: 13px; }\n\n@media (max-width: 420px) {\n    .pc-grid4 { grid-template-columns: repeat(2, minmax(0, 1fr)); }\n    .pc-grid3 { grid-template-columns: repeat(2, minmax(0, 1fr)); }\n    .pc-head-ticket span:not(.pc-seal) { max-width: 30vw; }\n    .pc-title { font-size: 21px; letter-spacing: 2px; }\n}\n\n/* ═════════ 智绘姬原有设置面板：换成票卡样子 ═════════ */\n#st-chatu8-settings .st-chatu8-modal-backdrop {\n    background-color: var(--pc-mist) !important;\n    background-image: radial-gradient(rgba(28, 34, 38, .22) 1px, transparent 1.5px) !important;\n    background-size: 7px 7px !important;\n}\n#st-chatu8-settings .st-chatu8-modal-content {\n    background: var(--pc-paper) !important; border: 1.5px solid var(--pc-ink) !important; border-radius: 18px !important;\n    box-shadow: var(--pc-shadow) !important; font-family: var(--pc-font); color: var(--pc-ink);\n}\n#st-chatu8-settings .st-chatu8-modal-header h2 { font-family: var(--pc-font-name); letter-spacing: 3px; color: var(--pc-ink) !important; }\n#st-chatu8-settings .st-chatu8-ai-heart-icon,\n#st-chatu8-ai-trigger { display: none !important; }\n#st-chatu8-settings .st-chatu8-nav-link { border-radius: 999px !important; border: 1.5px dashed var(--pc-dash); font-family: var(--pc-font); }\n#st-chatu8-settings .st-chatu8-nav-link.active { background: var(--pc-ink) !important; color: var(--pc-paper) !important; border-style: solid; border-color: var(--pc-ink); }\n#st-chatu8-settings .st-chatu8-settings-section {\n    background: var(--pc-paper) !important; border: 1.5px solid var(--pc-ink) !important; border-radius: 16px !important; box-shadow: var(--pc-shadow) !important;\n}\n#st-chatu8-settings .st-chatu8-settings-section h3 { font-family: var(--pc-font-name); letter-spacing: 2px; border-bottom: 1.5px dashed rgba(58, 42, 34, .45) !important; }\n#st-chatu8-settings .st-chatu8-btn, #st-chatu8-settings .st-chatu8-sidebar-btn {\n    border-radius: 999px !important; border: 1.5px solid var(--pc-ink) !important; background: var(--pc-paper) !important; color: var(--pc-ink) !important;\n    box-shadow: 0 3px 0 rgba(26, 22, 18, .2) !important; font-family: var(--pc-font);\n}\n#st-chatu8-settings .st-chatu8-text-input, #st-chatu8-settings .st-chatu8-select, #st-chatu8-settings textarea {\n    border-radius: 12px !important; border: 0 !important; background: var(--pc-paper-2) !important; color: var(--pc-ink) !important; font-family: var(--pc-font);\n}\n#st-chatu8-settings .st-chatu8-slider { background: rgba(58, 42, 34, .18) !important; }\n#st-chatu8-settings input:checked + .st-chatu8-slider { background: var(--pc-ink) !important; }\n#st-chatu8-settings .st-chatu8-slider::before { background: var(--pc-paper) !important; }\n#st-chatu8-settings input:checked + .st-chatu8-slider::before { background: var(--pc-gold) !important; }\n#st-chatu8-settings ::-webkit-scrollbar { display: none; }\n#st-chatu8-settings * { scrollbar-width: none; }\n\n/* ───────── 界面上的小票根（入口） ───────── */\n#pc-stub {\n    position: fixed; right: 0; z-index: 3000; display: flex; flex-direction: column; align-items: center; gap: 2px;\n    width: 46px; padding: 10px 4px 10px 8px; border: 1.5px solid var(--pc-ink); border-right: 0; border-radius: 12px 0 0 12px;\n    background: var(--pc-paper); color: var(--pc-ink); font-family: var(--pc-font); box-shadow: -2px 3px 0 rgba(26, 22, 18, .2);\n    touch-action: none; cursor: pointer; -webkit-tap-highlight-color: transparent;\n}\n#pc-stub::before {\n    content: \"\"; position: absolute; left: 4px; top: 8px; bottom: 8px; border-left: 1.5px dashed rgba(58, 42, 34, .45);\n}\n#pc-stub .pc-stub-label { font-size: 10px; color: var(--pc-ink-soft); writing-mode: vertical-rl; letter-spacing: 2px; }\n#pc-stub b { font-family: var(--pc-font-name); font-size: 13px; writing-mode: vertical-rl; max-height: 7.5em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; letter-spacing: 1px; }\n#pc-stub em { font-style: normal; font-size: 10px; padding: 1px 4px; border-radius: 4px; background: var(--pc-gold); color: #fbf8f0; }\n\n/* 直接放在雾青底上的说明文字要深一点，才看得清 */\n.pc-body > .pc-hint, .pc-body > .pc-chips .pc-dim, .pc-body > .pc-dim { color: #1f2d28; }\n\n.pc-sent { background: #fbf8f0; box-shadow: inset 0 0 0 1.5px var(--pc-ink); }\n.pc-warn { margin-top: 8px; padding: 8px 10px; border-radius: 10px; background: rgba(155, 79, 69, .12); color: #7a3a32; font-size: 13px; line-height: 1.6; }\n\n/* 输入框的占位文字统一颜色（酒馆主题可能会改成别的颜色） */\n.pc-overlay input::placeholder, .pc-overlay textarea::placeholder, .pc-modal input::placeholder, .pc-modal textarea::placeholder { color: #8a7a6d !important; opacity: 1; }\n.pc-field select, .pc-field input { font-family: var(--pc-font) !important; }\n.pc-field input[data-trans=\"url\"], .pc-field input[data-trans=\"key\"], .pc-field select[data-trans=\"model\"], .pc-field input[data-trans=\"model\"] { font-family: var(--pc-font-label) !important; }\n\n/* 酒馆主题会改 textarea / input 的底色、边框和字体，这里锁住 */\n.pc-overlay textarea, .pc-overlay input:not([type=\"checkbox\"]):not([type=\"range\"]):not([type=\"file\"]), .pc-overlay select,\n.pc-sheet-backdrop textarea, .pc-sheet-backdrop input:not([type=\"checkbox\"]):not([type=\"range\"]):not([type=\"file\"]), .pc-sheet-backdrop select,\n.pc-inpaint textarea, .pc-inpaint input:not([type=\"checkbox\"]):not([type=\"range\"]):not([type=\"file\"]),\n.pc-modal textarea, .pc-modal input:not([type=\"checkbox\"]):not([type=\"range\"]):not([type=\"file\"]), .pc-modal select {\n    background: var(--pc-paper-2) !important; color: var(--pc-ink) !important; border: 0 !important; outline: none !important;\n    box-shadow: none !important; font-family: var(--pc-font) !important; -webkit-text-fill-color: var(--pc-ink);\n}\n.pc-overlay .pc-search input:not([type=\"checkbox\"]):not([type=\"range\"]):not([type=\"file\"]) { background: transparent !important; }\n.pc-overlay .pc-dhead input.pc-dtitle:not([type=\"checkbox\"]):not([type=\"range\"]):not([type=\"file\"]) { background: transparent !important; color: var(--pc-paper) !important; -webkit-text-fill-color: var(--pc-paper); font-family: var(--pc-font-name) !important; padding: 0; }\n.pc-sheet-backdrop textarea:focus { box-shadow: 0 0 0 2px var(--pc-ink) !important; }\n.pc-overlay textarea:focus, .pc-overlay input:focus, .pc-overlay select:focus,\n.pc-modal textarea:focus, .pc-modal input:focus { box-shadow: 0 0 0 2px var(--pc-ink) !important; }\n.pc-overlay .pc-sent { background: #fbf8f0 !important; box-shadow: inset 0 0 0 1.5px var(--pc-ink) !important; }\n.pc-overlay .mono, .pc-overlay textarea.mono, .pc-modal textarea.mono { font-family: var(--pc-font-label) !important; font-size: 13px; }\n.pc-sent-box { padding: 0 12px 12px; }\n.pc-sent-box summary { padding: 4px 0; }\n\n/* ───────── 生图页（新版） ───────── */\n.pc-artline { display: flex; align-items: center; gap: 10px; margin-top: 6px; padding: 10px 12px; border-radius: 14px; background: rgba(201, 138, 62, .16); }\n.pc-artline .pc-seal { width: 28px; height: 28px; }\n.pc-artcover { width: 46px; height: 46px; border-radius: 12px; object-fit: cover; object-position: top; border: 1.5px solid var(--pc-ink); flex-shrink: 0; cursor: zoom-in; }\n.pc-artline b { display: block; font-size: 15px; }\n.pc-artline small { display: block; font-size: 11px; color: var(--pc-ink-soft); }\n.pc-artline .pc-pill { min-height: 34px; padding: 0 14px; flex-shrink: 0; }\n.pc-grow { flex: 1; min-width: 0; }\n.pc-textarea.big { min-height: 180px; }\n.pc-cfg { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--pc-ink-soft); }\n.pc-overlay .pc-cfg input { width: 64px !important; margin: 0; border: 0; border-radius: 10px; padding: 7px 8px; background: var(--pc-paper-2) !important; font-family: var(--pc-font-label) !important; }\n.pc-fold { margin-top: 10px; border-radius: 16px; background: var(--pc-paper); border: 1.5px solid var(--pc-ink); box-shadow: var(--pc-shadow); }\n.pc-fold > summary { list-style: none; display: flex; align-items: center; gap: 10px; padding: 12px 16px; cursor: pointer; }\n.pc-fold > summary::-webkit-details-marker { display: none; }\n.pc-fold > summary b { font-size: 15px; white-space: nowrap; }\n.pc-fold > summary i { font-style: normal; flex: 1; min-width: 0; font-size: 12px; color: var(--pc-ink-soft); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; text-align: right; }\n.pc-fold > summary::after { content: \"›\"; font-size: 20px; color: var(--pc-ink-soft); transition: transform .15s; }\n.pc-fold[open] > summary::after { transform: rotate(90deg); }\n.pc-fold-in { padding: 0 16px 14px; }\n.pc-field.span4 { grid-column: 1 / -1; } @media (max-width: 420px) { .pc-grid4 > .pc-field.span2 { grid-column: span 1; } }\n.pc-field.span2 { grid-column: span 2; }\n.pc-seg.three { grid-template-columns: repeat(3, minmax(0, 1fr)); margin-top: 6px; }\n.pc-seg.three button { font-size: 13px; padding: 0 4px; }\n.pc-keyrow { display: flex; gap: 8px; align-items: center; }\n.pc-keyrow input { flex: 1; min-width: 0; }\n.pc-keyrow .pc-pill { min-height: 38px; flex-shrink: 0; }\n.pc-warn-card { background: #f6e3cf; }\n.pc-warn-text { color: var(--pc-danger); }\n.pc-card .pc-seg { background: var(--pc-paper-2); }\n\n/* ───────── 画师库（新版） ───────── */\n.pc-toprow { display: flex; gap: 8px; align-items: center; }\n.pc-toprow .pc-search { flex: 1; margin: 0; min-width: 0; }\n.pc-vt { display: flex; flex-shrink: 0; padding: 3px; border-radius: 999px; background: var(--pc-paper); border: 1.5px solid var(--pc-ink); box-shadow: var(--pc-shadow); }\n.pc-vt button { width: 36px; height: 36px; border: 0; border-radius: 50%; background: transparent; color: var(--pc-ink); display: flex; align-items: center; justify-content: center; cursor: pointer; }\n.pc-vt button svg { width: 17px; height: 17px; }\n.pc-vt button.on { background: var(--pc-ink); color: var(--pc-paper); }\n.pc-add { flex-shrink: 0; width: 46px; height: 46px; border-radius: 50%; border: 0; background: var(--pc-ink); color: var(--pc-paper); font-size: 24px; box-shadow: var(--pc-shadow); cursor: pointer; }\n.pc-use { position: absolute; right: 8px; top: 8px; z-index: 2; width: 34px; height: 34px; border-radius: 50%; border: 1.5px solid var(--pc-ink); background: var(--pc-paper); color: var(--pc-ink); display: flex; align-items: center; justify-content: center; padding: 0; cursor: pointer; }\n.pc-use svg { width: 16px; height: 16px; }\n.pc-use.on { background: var(--pc-gold); border-color: var(--pc-gold); color: #fff; }\n.pc-li .pc-use, .pc-dhead .pc-use { position: static; flex-shrink: 0; }\n.pc-dhead .pc-use { width: 44px; height: 44px; }\n.pc-tip { font-size: 11px; color: var(--pc-paper); opacity: .9; margin-top: 6px; }\n.pc-center { text-align: center; }\n.pc-pill.tiny { min-height: 30px; padding: 0 12px; font-size: 12px; }\n.pc-pill.danger { color: var(--pc-danger); border-color: var(--pc-danger); }\n.pc-ticket .pc-ticket-img { height: 150px; }\n.pc-ticket-text small { -webkit-line-clamp: 1; }\n.pc-li { position: relative; margin-top: 12px; padding: 12px 14px; background: var(--pc-paper); border: 1.5px solid var(--pc-ink); border-radius: 16px; box-shadow: var(--pc-shadow); }\n.pc-li.active { box-shadow: 0 0 0 3px var(--pc-gold), var(--pc-shadow); }\n.pc-li-name { border: 0; background: none; padding: 0; font-family: var(--pc-font-name); font-weight: 700; font-size: 17px; color: var(--pc-ink); cursor: pointer; text-align: left; }\n.pc-li-str { font-size: 12px; color: var(--pc-ink-soft); margin-top: 2px; word-break: break-all; }\n.pc-li-imgs { display: flex; gap: 6px; margin-top: 10px; overflow-x: auto; scrollbar-width: none; }\n.pc-li-imgs::-webkit-scrollbar { display: none; }\n.pc-li-imgs img { width: 64px; height: 88px; object-fit: cover; border-radius: 10px; flex-shrink: 0; cursor: pointer; }\n.pc-textarea.tiny { min-height: 40px; font-size: 13px; padding: 8px 10px; margin-top: 8px; }\n.pc-sheet-img { width: 86px; height: 120px; object-fit: cover; border-radius: 12px; flex-shrink: 0; }\n.pc-sheet-img.add { border: 1.5px dashed var(--pc-dash); background: transparent; font-family: var(--pc-font); font-size: 12px; color: var(--pc-ink); cursor: pointer; }\n.pc-gallery { display: flex; gap: 10px; overflow-x: auto; margin-top: 12px; scrollbar-width: none; }\n.pc-gallery::-webkit-scrollbar { display: none; }\n.pc-gal-item { position: relative; flex-shrink: 0; }\n.pc-gal-item .pc-thumb { width: 150px; height: 220px; border-radius: 14px; }\n.pc-gal-add { flex-shrink: 0; width: 110px; height: 220px; border-radius: 14px; border: 1.5px dashed var(--pc-paper); background: rgba(244, 239, 228, .55); display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px; font-family: var(--pc-font); font-size: 13px; color: var(--pc-ink); cursor: pointer; }\n.pc-gal-add b { font-size: 26px; font-weight: 400; }\n.pc-tplrow { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-top: 10px; font-size: 12px; color: var(--pc-paper); }\n.pc-tplrow .pc-pill { min-height: 30px; padding: 0 12px; font-size: 12px; }\n.pc-dhead { display: flex; align-items: center; gap: 10px; }\n.pc-round { width: 40px; height: 40px; flex-shrink: 0; border-radius: 50%; border: 1.5px solid var(--pc-ink); background: var(--pc-paper); color: var(--pc-ink); font-size: 20px; display: flex; align-items: center; justify-content: center; cursor: pointer; padding: 0; }\n.pc-round.dashed { border-style: dashed; border-color: var(--pc-dash); background: transparent; }\n.pc-round svg { width: 17px; height: 17px; }\n.pc-dtitle { flex: 1; min-width: 0; margin: 0; font-family: var(--pc-font-name); font-weight: 700; font-size: 22px; letter-spacing: 2px; color: var(--pc-paper); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\n.pc-overlay input.pc-dtitle { background: transparent !important; color: var(--pc-paper) !important; border: 0 !important; padding: 0; font-family: var(--pc-font-name) !important; }\n.pc-strrow { display: flex; gap: 8px; align-items: flex-start; }\n.pc-strrow p { flex: 1; margin: 6px 0 0; }\n.pc-block { display: block; }\n.pc-mem { display: flex; align-items: center; gap: 10px; padding: 10px 0; }\n.pc-mem + .pc-mem { border-top: 1.5px dashed rgba(58, 42, 34, .16); }\n.pc-mem-av { width: 44px; height: 44px; flex-shrink: 0; border-radius: 12px; overflow: hidden; border: 0; padding: 0; background: #cdbfa8; cursor: pointer; }\n.pc-mem-av img { width: 100%; height: 100%; object-fit: cover; }\n.pc-mem-name { flex: 1; min-width: 0; border: 0; background: none; padding: 0; text-align: left; color: var(--pc-ink); cursor: pointer; }\n.pc-mem-name b { display: block; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\n.pc-mem-name small { font-size: 11px; color: var(--pc-ink-soft); }\n.pc-icon-btn.on { background: var(--pc-ink); color: var(--pc-paper); }\n.pc-icon-btn svg { width: 18px; height: 18px; }\n.pc-gal-item .pc-thumb-del { right: 6px; top: 6px; }\n.pc-kind { position: absolute; left: 8px; top: 8px; z-index: 2; font-size: 11px; padding: 2px 9px; border-radius: 999px; background: rgba(244, 239, 228, .92); }\n.pc-use.dark.on { background: var(--pc-ink); border-color: var(--pc-ink); }\n.pc-use.static { position: static; }\n.pc-meta { font-size: 11px; color: var(--pc-ink-soft); margin-top: 2px; }\n.pc-pill.blocked { text-decoration: line-through; color: var(--pc-danger); border: 1.5px dashed var(--pc-danger); background: rgba(244, 239, 228, .7); }\n.pc-sort { display: flex; gap: 16px; margin-top: 10px; }\n.pc-sort button { border: 0; background: none; padding: 0; font-family: var(--pc-font); font-size: 13px; color: var(--pc-paper); opacity: .75; cursor: pointer; }\n.pc-sort button.on { opacity: 1; font-weight: 700; }\n.pc-sort button:last-child { margin-left: auto; }\n\n/* ───────── 角色 ───────── */\n.pc-grouplbl { font-size: 12px; font-weight: 700; color: var(--pc-ink-soft); margin-top: 12px; }\n.pc-who { display: flex; align-items: center; gap: 10px; padding: 8px 0; }\n.pc-who + .pc-who { border-top: 1.5px dashed rgba(58, 42, 34, .16); }\n.pc-who-main { flex: 1; min-width: 0; display: flex; align-items: center; gap: 10px; border: 0; background: none; padding: 0; text-align: left; color: var(--pc-ink); font-family: var(--pc-font); cursor: pointer; }\n.pc-who-main b { display: block; font-size: 15px; }\n.pc-who-main small { display: block; font-size: 12px; color: var(--pc-ink-soft); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }\n.pc-av { width: 46px; height: 46px; flex-shrink: 0; border-radius: 50%; overflow: hidden; background: #cdbfa8; display: inline-block; }\n.pc-av img { width: 100%; height: 100%; object-fit: cover; }\n.pc-av.big { width: 56px; height: 56px; border: 1.5px solid var(--pc-ink); }\n.pc-badge-s { font-style: normal; font-weight: 400; font-size: 11px; padding: 1px 8px; margin-left: 6px; border-radius: 999px; background: rgba(201, 138, 62, .22); }\n.pc-switch.only { min-height: 0; gap: 0; flex-shrink: 0; }\n.pc-state { display: inline-block; margin-top: 4px; font-size: 11px; padding: 2px 9px; border-radius: 999px; background: rgba(58, 42, 34, .08); color: var(--pc-ink-soft); font-style: normal; }\n.pc-state.todo { background: rgba(201, 138, 62, .24); color: #7a4a1a; }\n.pc-pairs { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }\n.pc-pair { display: inline-flex; align-items: center; border-radius: 999px; background: var(--pc-paper-2); }\n.pc-pair button { border: 0; background: none; color: var(--pc-ink); cursor: pointer; font-family: var(--pc-font); }\n.pc-pair button:first-child { padding: 6px 4px 6px 12px; font-size: 13px; }\n.pc-pair em { font-style: normal; font-size: 11px; color: var(--pc-ink-soft); margin-left: 6px; }\n.pc-pair-x { width: 26px; height: 26px; font-size: 14px; color: var(--pc-ink-soft) !important; }\n.pc-addrow { display: flex; gap: 8px; margin-top: 10px; }\n.pc-overlay .pc-addrow input { flex: 1; min-width: 0; border: 0 !important; border-radius: 999px; padding: 9px 14px; background: var(--pc-paper-2) !important; font-size: 14px; }\n.pc-addrow .pc-btn { flex: 0 0 auto; min-height: 40px; padding: 0 18px; }\n.pc-chat-img { max-width: 100%; border-radius: 10px; }\n.pc-mes-gen { cursor: pointer; }\n\n/* ───────── 氛围 ───────── */\n.pc-big { font-family: var(--pc-font-name); font-size: 17px; }\n.pc-mosaic4 { display: grid; grid-template-columns: 1fr 1fr; grid-template-rows: 75px 75px; gap: 2px; border-radius: 14.5px 14.5px 0 0; overflow: hidden; background: #cdbfa8; -webkit-mask-image: linear-gradient(#000 78%, transparent); mask-image: linear-gradient(#000 78%, transparent); }\n.pc-mosaic4 i { display: block; background: rgba(58, 42, 34, .12); }\n.pc-mosaic4 img { width: 100%; height: 100%; object-fit: cover; display: block; }\n.pc-vrow { display: flex; gap: 12px; align-items: center; padding: 10px 0; }\n.pc-vrow + .pc-vrow { border-top: 1.5px dashed rgba(58, 42, 34, .16); }\n.pc-vthumb { width: 56px; height: 56px; flex-shrink: 0; border-radius: 12px; overflow: hidden; background: #cdbfa8; }\n.pc-vthumb img { width: 100%; height: 100%; object-fit: cover; }\n.pc-slider input[type=range] { accent-color: var(--pc-gold); }\n.pc-prog { height: 12px; border-radius: 999px; background: var(--pc-paper-2); overflow: hidden; margin-top: 10px; }\n.pc-prog i { display: block; height: 100%; background: var(--pc-gold); border-radius: 999px; transition: width .3s; }\n.pc-bcell { position: relative; border-radius: 12px; overflow: hidden; background: var(--pc-paper); border: 1.5px solid var(--pc-ink); cursor: default; }\n.pc-bcell.done { cursor: pointer; }\n.pc-bcell img, .pc-bcell > span { display: flex; width: 100%; height: 130px; object-fit: cover; align-items: center; justify-content: center; font-size: 12px; color: var(--pc-ink-soft); }\n.pc-bcell.run > span { background: var(--pc-paper-2); }\n.pc-bcell.error > span { color: var(--pc-danger); }\n.pc-bcell b { display: block; font-size: 11px; padding: 5px 7px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }\n.pc-bpick { position: absolute; right: 6px; top: 6px; width: 24px; height: 24px; border-radius: 50%; border: 1.5px solid #fff; background: rgba(0, 0, 0, .18); color: #fff; font-style: normal; font-size: 13px; display: flex; align-items: center; justify-content: center; }\n.pc-bcell.on { box-shadow: 0 0 0 3px var(--pc-gold); }\n.pc-bcell.on .pc-bpick { background: var(--pc-gold); border-color: var(--pc-gold); }\n.pc-overlay input[type=\"range\"], .pc-sheet-backdrop input[type=\"range\"] { background: transparent !important; border: 0 !important; box-shadow: none !important; accent-color: var(--pc-gold); }\n\n/* ───────── 局部重绘 ───────── */\n.pc-inpaint { z-index: 2147480050; }\n.pc-ip { width: min(560px, 94vw); max-height: 94vh; overflow-y: auto; scrollbar-width: none; background: var(--pc-paper); border: 1.5px solid var(--pc-ink); border-radius: 20px; padding: 16px; color: var(--pc-ink); font-family: var(--pc-font); }\n.pc-ip::-webkit-scrollbar { display: none; }\n.pc-ip-stage { position: relative; margin-top: 10px; border-radius: 12px; overflow: hidden; background: #cdbfa8; }\n.pc-ip-stage canvas { display: block; width: 100%; height: auto; }\n.pc-ip-mask { position: absolute; inset: 0; touch-action: none; cursor: crosshair; }\n.pc-ip-tools { display: flex; align-items: center; gap: 10px; margin-top: 10px; }\n.pc-inpaint { align-items: center; justify-content: center; }\n.pc-overlay select.pc-mini-select { width: auto !important; padding: 4px 10px !important; border-radius: 999px; font-size: 12px !important; margin: 0; }\n\n.pc-inpaint input[type=\"range\"] { background: transparent !important; border: 0 !important; accent-color: var(--pc-gold); }\n.pc-ip * { box-sizing: border-box; }\n\n/* 例图按构图显示：头像 1:1、胸像 3:4、立绘 9:16 */\n.pc-gal-item.shot-head .pc-thumb { width: 160px; height: 160px; }\n.pc-gal-item.shot-bust .pc-thumb { width: 150px; height: 200px; }\n.pc-gal-item.shot-full .pc-thumb { width: 124px; height: 220px; }\n.pc-gallery { align-items: flex-end; }\n.pc-shot { position: absolute; left: 6px; bottom: 6px; font-size: 11px; padding: 1px 8px; border-radius: 999px; background: rgba(244, 239, 228, .92); color: var(--pc-ink); }\n.pc-gal-item .pc-tag-mini { display: none; }\n.pc-sample-box .pc-chips { margin-top: 6px; }\n.pc-overlay .pc-use, .pc-sheet-backdrop .pc-use { background: var(--pc-paper) !important; border: 1.5px solid var(--pc-ink) !important; color: var(--pc-ink) !important; opacity: 1 !important; box-shadow: none !important; }\n.pc-overlay .pc-use.on { background: var(--pc-gold) !important; border-color: var(--pc-gold) !important; color: #fff !important; }\n.pc-overlay .pc-use.dark.on { background: var(--pc-ink) !important; border-color: var(--pc-ink) !important; }\n.pc-overlay .pc-use svg { display: block !important; width: 16px !important; height: 16px !important; stroke: currentColor !important; fill: none !important; }\n.pc-overlay .pc-dtitle { font-size: 22px !important; }\n/* 批量结果按构图显示 */\n.pc-bgrid { align-items: start; }\n.pc-bcell img, .pc-bcell > span { height: auto !important; aspect-ratio: 3 / 4; }\n.pc-bcell.shot-head img, .pc-bcell.shot-head > span { aspect-ratio: 1 / 1; }\n.pc-bcell.shot-full img, .pc-bcell.shot-full > span { aspect-ratio: 9 / 16; }\n\n/* ───────── 画师黑名单 ───────── */\nmark.pc-ban { background: rgba(155, 79, 69, .18); color: var(--pc-danger); font-weight: 700; border-radius: 4px; padding: 0 2px; text-decoration: line-through; text-decoration-thickness: 1px; }\n.pc-banwarn { margin-top: 6px; padding: 8px 12px; border-radius: 12px; background: rgba(155, 79, 69, .14); color: var(--pc-danger); font-size: 13px; }\n.pc-banwarn b { font-family: var(--pc-font-label); }\n.pc-ticket.banned { box-shadow: 0 0 0 3px var(--pc-danger), var(--pc-shadow); }\n.pc-banbadge { position: absolute; left: 8px; top: 8px; z-index: 2; font-size: 11px; padding: 2px 9px; border-radius: 999px; background: var(--pc-danger); color: #fbf8f0; }\n.pc-mem.banned .pc-mem-name b, .pc-mem.banned .pc-mem-name small { color: var(--pc-danger); }\n.pc-mem.banned .pc-mem-name b { text-decoration: line-through; }\n.pc-ban-card { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; background: #f3dcd6; color: var(--pc-danger); }\n.pc-ban-card .pc-pill { margin-left: auto; }\n.pc-banrow { display: flex; align-items: center; gap: 8px; padding: 8px 0; }\n.pc-banrow + .pc-banrow { border-top: 1.5px dashed rgba(58, 42, 34, .16); }\n.pc-banrow b { color: var(--pc-danger); font-size: 13px; }\n.pc-banrow-note { flex: 1; min-width: 0; text-align: left; border: 0; background: none; padding: 0; font-family: var(--pc-font); font-size: 12px; color: var(--pc-ink-soft); cursor: pointer; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\n/* 多选 */\n.pc-selbar { position: sticky; top: 0; z-index: 3; display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-top: 8px; padding: 8px 12px; border-radius: 14px; background: var(--pc-paper); border: 1.5px solid var(--pc-ink); box-shadow: var(--pc-shadow); font-size: 13px; }\n.pc-selbar span { margin-right: auto; font-weight: 700; }\n.pc-selbar .pc-pill[disabled] { opacity: .45; }\n.pc-pill.danger-solid { background: var(--pc-danger); border-color: var(--pc-danger); color: #fbf8f0; }\n.pc-selbox { position: absolute; right: 8px; top: 8px; z-index: 3; width: 30px; height: 30px; border-radius: 50%; border: 2px solid #fff; background: rgba(0, 0, 0, .22); color: #fff; display: flex; align-items: center; justify-content: center; font-size: 15px; }\n.pc-selbox.on { background: var(--pc-gold); border-color: var(--pc-gold); }\n.pc-selbox.static { position: static; flex-shrink: 0; margin-right: 8px; border-color: var(--pc-ink); background: transparent; color: #fff; cursor: pointer; }\n.pc-selbox.static.on { background: var(--pc-gold); border-color: var(--pc-gold); }\n.pc-btn.danger { color: var(--pc-danger); border-color: var(--pc-danger); }\n.pc-ticket-img img.pc-blur { filter: blur(14px) saturate(.8); transform: scale(1.1); }\n.pc-nsfw-cover { position: absolute; left: 50%; top: 60px; transform: translateX(-50%); font-style: normal; font-family: var(--pc-font-label); font-size: 12px; padding: 2px 10px; border-radius: 999px; background: var(--pc-danger); color: #fbf8f0; }\n.pc-ticket-img { position: relative; }\n.pc-pagetitle { margin: 2px 4px 0; font-family: var(--pc-font-name); font-size: 22px; letter-spacing: 3px; color: var(--pc-paper); }\n.pc-linkdanger { border: 0; background: none; color: var(--pc-danger); font-family: var(--pc-font); font-size: 13px; text-decoration: underline; text-underline-offset: 3px; cursor: pointer; margin-left: auto; }\n.pc-sp-shots { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-top: 6px; }\n.pc-sp-shots button { display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 12px 4px 10px; border: 1.5px solid var(--pc-ink); border-radius: 14px; background: var(--pc-paper); color: var(--pc-ink); font-family: var(--pc-font); font-size: 14px; cursor: pointer; }\n.pc-sp-shots button i { display: block; border-radius: 4px; background: #cdbfa8; }\n.pc-sp-shots button small { font-size: 11px; color: var(--pc-ink-soft); }\n.pc-sp-shots button.on { background: var(--pc-ink); color: var(--pc-paper); }\n.pc-sp-shots button.on i { background: var(--pc-gold); }\n.pc-sp-shots button.on small { color: rgba(244, 239, 228, .7); }\n.pc-sp-back { z-index: 2147480020; }\n\n/* ───────── 反馈动作 ───────── */\n.pc-btn, .pc-ticket, .pc-gal-add, .pc-add, .pc-round, .pc-li, .pc-pill, .pc-use, .pc-icon-btn, .pc-vt button, .pc-seg button, .pc-sp-shots button, .pc-who-main, .pc-mem-name {\n    transition: transform .12s ease, box-shadow .12s ease, background-color .18s, color .18s; -webkit-tap-highlight-color: transparent;\n}\n.pc-btn:active:not([disabled]), .pc-ticket:active, .pc-gal-add:active, .pc-add:active, .pc-round:active, .pc-li:active { transform: translateY(3px); box-shadow: 0 1px 0 rgba(26, 22, 18, .22); }\n.pc-pill:active, .pc-use:active, .pc-icon-btn:active, .pc-vt button:active, .pc-seg button:active, .pc-sp-shots button:active, .pc-pair button:active { transform: scale(.92); }\n.pc-btn[disabled] { opacity: .55; }\n@keyframes pc-stamp { 0% { transform: scale(1.9) rotate(-14deg); opacity: 0; } 60% { transform: scale(.88) rotate(3deg); opacity: 1; } 100% { transform: scale(1) rotate(0); } }\n.pc-overlay .pc-use.stamp { animation: pc-stamp .36s cubic-bezier(.3, 1.4, .5, 1); }\n/* 导航：深色底块滑动 */\n.pc-nav { position: relative; }\n.pc-nav-ind { position: absolute; top: 0; bottom: 0; left: 0; width: 0; border-radius: 999px; background: var(--pc-ink); transition: left .3s cubic-bezier(.3, 1.25, .45, 1), width .3s, opacity .2s; z-index: 0; pointer-events: none; }\n.pc-nav .pc-pill { position: relative; z-index: 1; }\n.pc-nav .pc-pill.on { background: transparent !important; border-color: var(--pc-ink); }\n/* 换页 */\n.pc-page.from-right { animation: pc-in-r .26s cubic-bezier(.2, .8, .3, 1) both; }\n.pc-page.from-left { animation: pc-in-l .26s cubic-bezier(.2, .8, .3, 1) both; }\n.pc-page.push { animation: pc-push .3s cubic-bezier(.2, .8, .3, 1) both; }\n.pc-page.pop { animation: pc-pop .26s cubic-bezier(.2, .8, .3, 1) both; }\n@keyframes pc-in-r { from { opacity: 0; transform: translateX(26px); } }\n@keyframes pc-in-l { from { opacity: 0; transform: translateX(-26px); } }\n@keyframes pc-push { from { opacity: 0; transform: translateX(60px) scale(.98); } }\n@keyframes pc-pop { from { opacity: 0; transform: translateX(-40px); } }\n.pc-body { overflow-x: hidden; }\n/* 底部面板滑上来 */\n.pc-sheet-backdrop.fresh .pc-sheet { animation: pc-sheet-up .28s cubic-bezier(.2, .9, .3, 1); }\n@keyframes pc-sheet-up { from { transform: translateY(40%); opacity: .4; } }\n.pc-modal { animation: pc-pop-in .22s cubic-bezier(.3, 1.3, .5, 1); }\n@keyframes pc-pop-in { from { transform: scale(.94); opacity: 0; } }\n/* 生成中：点点会动 */\n.pc-busy::after { content: ''; display: inline-block; width: 1.2em; text-align: left; animation: pc-dots 1s steps(1) infinite; }\n@keyframes pc-dots { 0% { content: '·'; } 33% { content: '··'; } 66% { content: '···'; } }\n.pc-gal-add[disabled] { background: linear-gradient(90deg, rgba(244, 239, 228, .45) 0, rgba(255, 255, 255, .85) 50%, rgba(244, 239, 228, .45) 100%); background-size: 300px 100%; animation: pc-shimmer 1.1s linear infinite; }\n@keyframes pc-shimmer { from { background-position: -150px 0; } to { background-position: 150px 0; } }\n@media (prefers-reduced-motion: reduce) { .pc-page, .pc-sheet, .pc-modal, .pc-use.stamp { animation: none !important; } }\n.pc-outmake { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }\n.pc-outmake .pc-btn { flex: 1 1 auto; min-height: 40px; font-size: 14px; }\n.pc-outbox { margin-top: 12px; padding: 12px; border-radius: 14px; background: rgba(201, 138, 62, .1); }\n.pc-outimg { display: block; width: 60%; margin: 10px auto 0; border-radius: 12px; border: 1.5px solid var(--pc-ink); cursor: zoom-in; }\n.pc-od-back { z-index: 2147480030; }\n.pc-odres { margin-top: 12px; padding: 12px; border-radius: 14px; background: rgba(201, 138, 62, .1); }\n.pc-odres .pc-actions .pc-btn { min-height: 38px; font-size: 13px; }\n.pc-subtitle { font-size: 11px; color: var(--pc-ink-soft); letter-spacing: 1px; margin-top: 2px; }\n/* 衣柜 */\n.pc-outhero { position: relative; margin-top: 12px; height: 320px; border-radius: 16px; overflow: hidden; background: #cdbfa8; border: 1.5px solid var(--pc-ink); display: flex; align-items: center; justify-content: center; color: var(--pc-ink-soft); font-size: 13px; }\n.pc-outhero img { width: 100%; height: 100%; object-fit: contain; background: #f6f1e6; cursor: zoom-in; }\n.pc-outhero-btn { position: absolute; right: 10px; bottom: 10px; font-size: 12px; padding: 4px 12px; border-radius: 999px; background: rgba(244, 239, 228, .94); color: var(--pc-ink); cursor: pointer; }\n.pc-outhero-busy { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; background: rgba(28, 34, 38, .45); color: #fff; font-style: normal; font-size: 15px; }\n.pc-outmake label.pc-btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; }\n.pc-btn.wide { width: 100%; }\n";
    style.textContent += `
.pc-li-str.clamp { display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.pc-strtoggle { display: inline-block; margin: 6px 0 2px; padding: 3px 12px; border: 1.5px dashed var(--pc-dash); border-radius: 999px; background: transparent; color: var(--pc-ink-soft); font: 12px var(--pc-font); cursor: pointer; }
.pc-addrow { align-items: flex-end; }
.pc-addrow textarea { flex: 1; min-width: 0; border: 0; border-radius: 20px; padding: 9px 14px; background: var(--pc-paper-2); color: var(--pc-ink); font: 14px/1.5 var(--pc-font); resize: none; min-height: 40px; max-height: 160px; field-sizing: content; outline: none; box-sizing: border-box; }
.pc-addrow textarea:focus { box-shadow: 0 0 0 2px var(--pc-ink); }
.pc-share-pick { display: inline-flex; align-items: center; margin-top: 6px; cursor: pointer; }
[data-share-meta]:empty { display: none; }
.pc-outsec { margin-top: 12px; padding: 12px; border-radius: 14px; background: rgba(255, 255, 255, .45); background: color-mix(in srgb, var(--pc-ink) 7%, transparent); }
.pc-outsec .pc-dim, .pc-outsec-h small { color: var(--pc-ink-soft) !important; opacity: 1 !important; }
.pc-dhead .pc-dtitle, .pc-dhead .pc-dtitle:not([type="checkbox"]) { color: var(--pc-ink) !important; -webkit-text-fill-color: var(--pc-ink) !important; }
.pc-dhead .pc-dtitle::placeholder { color: var(--pc-ink-soft) !important; -webkit-text-fill-color: var(--pc-ink-soft) !important; opacity: 1; }
.pc-outfold { display: block; width: 100%; margin-top: 10px; padding: 10px 12px; border-radius: 12px; border: 1.5px dashed var(--pc-dash); background: transparent; color: var(--pc-ink); text-align: left; line-height: 1.6; cursor: pointer; font: inherit; }
.pc-outfold em { display: block; font-style: normal; font-size: 12px; color: var(--pc-ink-soft); margin-top: 4px; }
.pc-outsteps { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 10px; }
.pc-outsteps span { flex: 1 1 30%; min-width: 92px; padding: 8px 10px; border-radius: 12px; border: 1.5px dashed var(--pc-dash); font-size: 12px; line-height: 1.5; color: var(--pc-ink); }
.pc-outsteps span.done { border-style: solid; border-color: var(--pc-ink); }
.pc-outsteps b { display: block; font-size: 11px; letter-spacing: .15em; color: var(--pc-ink-soft); }
.pc-outsec-h { display: flex; align-items: baseline; gap: 8px; }
.pc-outsec-h small { color: var(--pc-ink-soft); font-size: 12px; }
.pc-outsec .pc-pairs { margin-top: 6px; }
.pc-om-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; padding: 6px 0; border-bottom: 1.5px dashed rgba(58, 42, 34, .2); }
.pc-om-row .pc-switch { flex: 1 1 160px; min-width: 0; }
.pc-om-row .pc-mini-select { max-width: 55%; min-width: 0; }
.pc-modal { box-sizing: border-box; overflow-x: hidden; }
#pc-root.pc-overlay, .pc-sheet-backdrop, .pc-modal-backdrop { position: fixed !important; top: 0 !important; left: 0 !important; right: 0 !important; bottom: 0 !important; width: 100vw !important; height: 100vh !important; height: 100dvh !important; max-width: none !important; max-height: none !important; margin: 0 !important; box-sizing: border-box !important; transform: none !important; filter: none !important; opacity: 1 !important; }
#pc-root.pc-overlay { background-color: #7ea29c !important; background-image: radial-gradient(rgba(28, 34, 38, .22) 1px, transparent 1.5px), linear-gradient(var(--pc-mist), var(--pc-mist)) !important; background-size: 7px 7px, auto !important; }
#pc-root.pc-overlay:not(.open) { display: none !important; }
#pc-root.pc-overlay.open { display: block !important; }
#toast-container { z-index: 2147483600 !important; }
`;
    DOC.head.appendChild(style);
    cleanups.push(() => style.remove());
}

// 聊天里每一楼加一个「生图」小按钮
function addMesButtons() {
    __mod_marker.decorateAll();
    DOC.querySelectorAll('#chat .mes').forEach(mes => {
        const box = mes.querySelector('.extraMesButtons') || mes.querySelector('.mes_buttons');
        if (!box || box.querySelector('.pc-mes-gen')) return;
        const cm = DOC.createElement('div');
        cm.className = 'mes_button pc-mes-comic fa-solid fa-book-open interactable';
        cm.title = '智库：把这一楼画成漫画';
        cm.tabIndex = 0;
        box.prepend(cm);
        const o = DOC.createElement('div');
        o.className = 'mes_button pc-mes-outfit fa-solid fa-shirt interactable';
        o.title = '智库：按这一楼的剧情设计服装';
        o.tabIndex = 0;
        box.prepend(o);
        const b = DOC.createElement('div');
        b.className = 'mes_button pc-mes-gen fa-solid fa-image interactable';
        b.title = '智库：请在对应提示词旁点击生成';
        b.tabIndex = 0;
        box.prepend(b);
    });
}
const genning = new Set();
async function genFor(mesId) { await __mod_marker.process(mesId, { manual: true }); }

function onChatClick(ev) {
    const o = ev.target.closest?.('.pc-mes-outfit');
    if (o) {
        ev.stopPropagation();
        const id = Number(o.closest('.mes')?.getAttribute('mesid'));
        if (Number.isFinite(id)) UI.openOutfitDesigner({ mesId: id });
        return;
    }
    const cm = ev.target.closest?.('.pc-mes-comic');
    if (cm) {
        ev.stopPropagation();
        const id = Number(cm.closest('.mes')?.getAttribute('mesid'));
        if (!Number.isFinite(id)) return;
        if (!N.isReady()) { toastr.warning('先到智库设置里填 NovelAI key', '智库 · 漫画'); return; }
        void globalThis.__zhikuComic?.adapt(id);
        return;
    }
    const b = ev.target.closest?.('.pc-mes-gen');
    if (!b) return;
    ev.stopPropagation();
    const id = Number(b.closest('.mes')?.getAttribute('mesid'));
    if (Number.isFinite(id)) genFor(id);
}

function addMenuButton() {
    DOC.getElementById('pc-menu-btn')?.remove();
    const menu = DOC.getElementById('extensionsMenu');
    if (!menu) return;
    const item = DOC.createElement('div');
    item.id = 'pc-menu-btn';
    item.className = 'list-group-item flex-container flexGap5 interactable';
    item.tabIndex = 0;
    item.innerHTML = '<i class="fa-solid fa-image fa-fw" aria-hidden="true"></i><span>智库</span>';
    item.addEventListener('click', () => UI.openWindow());
    menu.appendChild(item);
    cleanups.push(() => item.remove());
}

async function start() {
    // 上一次脚本留下的东西先清掉（重载脚本时）
    // 已经有一份在运行（比如脚本被导入了两次），先让旧的退出
    P.__piaoceCleanup?.();
    for (const id of ['pc-root', 'pc-stub', 'pc-chip', 'pc-menu-btn']) DOC.getElementById(id)?.remove();

    injectCss();
    const compactStyle=DOC.createElement('style');compactStyle.id='pc-compact-image-style';compactStyle.textContent=".mes_text .pc-marker-slot{display:flex;gap:8px;margin:6px 0;padding:4px 8px;border-radius:6px;width:fit-content;max-width:100%;font-size:12px;line-height:1.5}.mes_text .pc-marker-slot summary,.mes_text .pc-image-actions summary{font-size:12px;cursor:pointer}.mes_text .pc-marker-generate,.mes_text .pc-image-actions button{font-size:12px;line-height:1.5;padding:3px 8px;min-height:28px;width:auto;margin:0}.mes_text .pc-marker-slot pre,.mes_text .pc-image-actions pre{font:12px/1.5 sans-serif;white-space:pre-wrap;overflow-wrap:anywhere;max-height:140px;overflow:auto;scrollbar-width:none}.mes_text .pc-image-actions pre::-webkit-scrollbar{display:none}.mes_text .pc-chat-img{display:block;max-width:min(100%,360px);max-height:480px;object-fit:contain;cursor:zoom-in}.pc-image-actions{display:flex;align-items:start;gap:8px;flex-wrap:wrap;margin:4px 0 8px}.pc-image-actions details{max-width:100%}.pc-image-preview{position:fixed;inset:0;z-index:40000;background:rgba(0,0,0,.85);display:flex;align-items:center;justify-content:center}.pc-image-preview img{max-width:95vw;max-height:90vh;object-fit:contain}.pc-image-preview button{position:absolute;right:16px;top:16px;padding:8px 16px}";DOC.head.append(compactStyle);cleanups.push(()=>compactStyle.remove());
    const markerStyle=DOC.createElement('style');markerStyle.id='pc-marker-ui-style';
    markerStyle.textContent='.pc-marker-slot{display:flex;align-items:flex-start;gap:10px;flex-wrap:wrap;margin:10px 0;padding:12px;border-radius:12px;background:var(--SmartThemeBlurTintColor,rgba(0,0,0,.15));border:1px solid var(--SmartThemeBorderColor,rgba(128,128,128,.35))}.pc-marker-slot details{flex:1;min-width:120px}.pc-marker-slot summary{cursor:pointer;font-size:14px}.pc-marker-slot pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:220px;overflow:auto;font-size:13px;margin:10px 0 0;scrollbar-width:none}.pc-marker-slot pre::-webkit-scrollbar{display:none}.pc-marker-generate{cursor:pointer;padding:6px 12px;border-radius:8px;color:inherit;background:var(--SmartThemeBlurTintColor,transparent);border:1px solid var(--SmartThemeBorderColor,#888);font:inherit}.pc-marker-generate:disabled{opacity:.6;cursor:wait}#pc-menu-btn .pc-menu-picture{display:inline-flex;align-items:center;justify-content:center;font-size:22px;width:26px;line-height:1}';
    /* reference-marker-ui */ markerStyle.textContent += "/* Button styles adapted from st-chatu8/styles/send_data.css; original attribution retained in README. */\r\n.mes_text .pc-marker-slot .pc-marker-generate {\r\n    display: inline-block;\r\n    padding: 6px 12px;\r\n    background-color: var(--st-chatu8-accent-primary, #4a90d9);\r\n    color: var(--st-chatu8-text-highlight, white);\r\n    border: 1px solid var(--st-chatu8-border-color, transparent);\r\n    border-radius: 4px;\r\n    cursor: pointer;\r\n    font-size: 14px;\r\n    margin-left: 0;\r\n    font-family: inherit;\r\n    line-height: 1.4;\r\n    text-decoration: none;\r\n    box-sizing: border-box;\r\n    transition: all 0.3s ease;\r\n}\r\n\r\n.mes_text .pc-marker-slot .pc-marker-generate:hover {\r\n    background-color: var(--st-chatu8-accent-secondary, #357abd);\r\n}\r\n\r\n\r\n\r\n.mes_text .pc-marker-slot{display:flex;align-items:center;gap:6px;flex-wrap:wrap;width:auto;padding:0;border:0;background:transparent;margin:8px 0}\r\n.mes_text .pc-marker-slot>details:not(.pc-result-collapse){flex:0 1 auto;min-width:0;max-width:100%}\r\n.mes_text .pc-marker-slot summary{font-size:13px;line-height:1.4}\r\n.mes_text .pc-marker-slot pre{font:13px/1.5 sans-serif;max-height:140px;overflow:auto;white-space:pre-wrap;scrollbar-width:none}\r\n.mes_text .pc-marker-slot pre::-webkit-scrollbar{display:none}\r\n.mes_text .pc-marker-slot .pc-result-collapse{flex-basis:100%;margin:8px 0;border-radius:8px;background:transparent;border:none}\r\n.mes_text .pc-result-collapse>summary{display:flex;align-items:center;gap:8px;padding:8px 12px;cursor:pointer;user-select:none;background:linear-gradient(135deg,rgba(74,144,226,.15),rgba(74,144,226,.08));font-size:13px;color:#a8c8f0;border-radius:8px}\r\n.mes_text .pc-result-collapse>summary:before{content:'▸'}\r\n.mes_text .pc-result-collapse[open]>summary:before{content:'▾'}\r\n.mes_text .pc-result-image{display:block;max-width:100%;max-height:520px;object-fit:contain;cursor:zoom-in;touch-action:pan-y}\r\n.pc-image-preview{position:fixed;inset:0;z-index:40000;background:rgba(0,0,0,.95);display:flex;align-items:center;justify-content:center}\r\n.pc-image-dialog{display:flex;flex-wrap:wrap;gap:10px;align-items:center;justify-content:center;width:min(96vw,850px);max-height:96vh;overflow:auto;background:#1a1a2e;color:#fff;padding:12px;border-radius:8px;scrollbar-width:none}\r\n.pc-image-dialog::-webkit-scrollbar{display:none}\r\n.pc-image-dialog img{flex-basis:100%;max-width:100%;max-height:75vh;object-fit:contain}\r\n.pc-image-dialog textarea{flex-basis:100%;width:100%;min-height:160px;font:14px/1.5 sans-serif;scrollbar-width:none}\r\n.pc-image-dialog button{position:static;padding:6px 12px;min-height:32px;width:auto;font-size:14px}\r\n";
    DOC.head.appendChild(markerStyle);cleanups.push(()=>markerStyle.remove());
    await loadData();
    if (getData().options.markerAuto === undefined) getData().options.markerAuto = true;
    if (getData().options.charAutoBlocks === undefined) getData().options.charAutoBlocks = true;
    if (getData().options.charBlockToast === undefined) getData().options.charBlockToast = true;
    if (getData().options.markerResultExpand === undefined) getData().options.markerResultExpand = true;
    if (getData().options.markerStream === undefined) getData().options.markerStream = true;
    __mod_chars.invalidateCharState();
    setTimeout(() => { try { __mod_chars.applyAllCharacterBlocks(); } catch (e) { console.warn("[智库] 角色块回填", e); } }, 400);
    const charMacro = installCharMacro(SillyTavern.getContext(), {
        text: () => __mod_chars.characterMacroText(),
        log: message => console.warn(message),
    });
    cleanups.push(() => charMacro.uninstall());
    __mod_marker.syncRegex();
    setTimeout(() => __mod_marker.refresh(), 0);
    setTimeout(() => __mod_marker.refresh(), 0);
    cleanups.push(() => {__mod_marker.stop();__mod_nai.stopQueue();});
    // 夜间模式：几套深色配色。样式表里用到浅色的地方，统一换成 --pcn-* 变量，每套配色只定义变量
    const NIGHT_THEMES = {
        // 小红书色卡「简｜黑与白」：#131112 #494849 #8A8A8A #C3C3C3 #E6E6E6
        mono: { name: '黑与白', mist: '#131112', dot: 'rgba(230,230,230,.045)', paper: '#1d1b1c', paper2: '#2a2829', user: '#242223', sunk: '#494849', ink: '#e6e6e6', soft: '#8a8a8a', gold: '#c3c3c3', strong: '#e6e6e6', onStrong: '#131112', line: 'rgba(230,230,230,.16)', danger: '#e08a80', warn: '#eaa49b', paperRgb: '29, 27, 28', inkRgb: '230, 230, 230' },
        // 色卡「黑蓝深海」：#101828 #001F3F #1E3A5F #34568B，亮蓝取色卡里那颗浅色圆
        sea: { name: '黑蓝深海', mist: '#101828', dot: 'rgba(143,176,220,.06)', paper: '#0b2140', paper2: '#1e3a5f', user: '#132c4c', sunk: '#34568b', ink: '#e4ecf7', soft: '#8ea5c4', gold: '#8fb0dc', strong: '#8fb0dc', onStrong: '#0a1424', line: 'rgba(143,176,220,.2)', danger: '#f0938c', warn: '#f6b2ab', paperRgb: '11, 33, 64', inkRgb: '228, 236, 247' },
    };
    const themeVars = t => `--pc-mist:${t.mist};--pc-ink:${t.ink};--pc-ink-soft:${t.soft};--pc-paper:${t.paper};--pc-paper-2:${t.paper2};--pc-paper-user:${t.user};--pc-gold:${t.gold};--pc-wax:${t.gold};--pc-danger:${t.danger};--pc-dash:${t.line};--pc-shadow:0 4px 14px rgba(0,0,0,.35);--pcn-dot:${t.dot};--pcn-sunk:${t.sunk};--pcn-strong:${t.strong};--pcn-on-strong:${t.onStrong};--pcn-line:${t.line};--pcn-warn:${t.warn};--pcn-paper-rgb:${t.paperRgb};--pcn-ink-rgb:${t.inkRgb};`;
    /** 浅色主题里的写法 → 夜间变量。浏览器读回来是 rgb() 写法，十六进制和 rgb() 都认 */
    const nightColor = (value, prop) => {
        const bg = /background|shadow|outline/.test(prop), border = /^border/.test(prop);
        let v = value
            .replace(/rgba\(28, 34, 38, 0?\.22\)/g, 'var(--pcn-dot)')
            .replace(/#7ea29c|rgb\(126, 162, 156\)/gi, 'var(--pc-mist)')
            .replace(/#cdbfa8|rgb\(205, 191, 168\)/gi, 'var(--pcn-sunk)')
            .replace(/#fbf8f0|rgb\(251, 248, 240\)/gi, bg ? 'var(--pc-paper)' : 'var(--pcn-on-strong)')
            .replace(/#7a3a32|rgb\(122, 58, 50\)/gi, 'var(--pcn-warn)')
            .replace(/rgba\(\s*24[34],\s*23[89],\s*22[68],/g, 'rgba(var(--pcn-paper-rgb),')
            .replace(/rgba\(\s*58,\s*42,\s*34,/g, 'rgba(var(--pcn-ink-rgb),')
            .replace(/rgba\(\s*255,\s*255,\s*255,\s*0?\.85\)/g, 'rgba(var(--pcn-paper-rgb), .85)');
        // 深色按钮（墨色底）夜里换成主题色，墨色描边换成柔和的线
        if (/background/.test(prop)) v = v.replace(/var\(--pc-ink\)/g, 'var(--pcn-strong)');
        if (border) v = v.replace(/var\(--pc-ink\)/g, 'var(--pcn-line)');
        if (prop === 'color') v = v.replace(/^var\(--pc-paper\)$/, 'var(--pcn-on-strong)');
        return v;
    };
    const nightStyle = DOC.createElement('style');
    nightStyle.id = 'pc-night-style';
    const buildNight = () => {
        // :where() 不加优先级：夜间覆盖只顶替原来那条规则，不会盖过更具体的规则
        const out = Object.entries(NIGHT_THEMES).map(([k, t]) => `html.pc-night.pc-nt-${k}{${themeVars(t)}}`);
        out.push(':where(html.pc-night) .pc-overlay, :where(html.pc-night) .pc-sheet, :where(html.pc-night) .pc-modal{color-scheme:dark;}');
        const sheet = DOC.getElementById('pc-css')?.sheet;
        const walk = rules => {
            for (const r of rules || []) {
                if (r.cssRules && !r.selectorText) { // @media 之类
                    const keep = out.length;
                    walk(r.cssRules);
                    const inner = out.splice(keep);
                    if (inner.length && r.conditionText) out.push(`@media ${r.conditionText}{${inner.join('')}}`);
                    continue;
                }
                if (!r.selectorText || /^:root$/.test(r.selectorText.trim())) continue;
                const decl = [];
                // 简写里用了 var() 时，浏览器读不出拆开的各项，只能按简写读
                const props = new Set(['background', 'border', 'border-top', 'border-right', 'border-bottom', 'border-left', 'border-color', 'outline']);
                for (let i = 0; i < r.style.length; i++) props.add(r.style[i]);
                for (const prop of props) {
                    const val = r.style.getPropertyValue(prop);
                    if (!val) continue;
                    const night = nightColor(val, prop);
                    if (night !== val) decl.push(`${prop}:${night}${r.style.getPropertyPriority(prop) ? ' !important' : ''}`);
                }
                if (decl.length) out.push(`${r.selectorText.split(',').map(x => ':where(html.pc-night) ' + x.trim().replace(/^html(?=[.#:\[\s]|$)/, '')).join(', ')}{${decl.join(';')}}`);
            }
        };
        try { walk(sheet?.cssRules); } catch (e) { console.warn('[智库] 夜间样式', e); }
        // 写在底色上的页面标题、卡片的阴影
        out.push(':where(html.pc-night) .pc-pagetitle{color:var(--pc-ink)}');
        // 开关：打开时轨道是主题色，圆点换成深色，不然和轨道一个颜色看不见
        out.push(':where(html.pc-night) .pc-switch input:checked + span::after{background:var(--pcn-on-strong)}');
        out.push(':where(html.pc-night) .pc-overlay .pc-card, :where(html.pc-night) .pc-overlay .pc-fold, :where(html.pc-night) .pc-head-card{border-color:var(--pcn-line)}');
        nightStyle.textContent = out.join('\n');
    };
    buildNight();
    DOC.head.appendChild(nightStyle);
    cleanups.push(() => { nightStyle.remove(); DOC.documentElement.classList.remove('pc-night', ...Object.keys(NIGHT_THEMES).map(k => 'pc-nt-' + k)); });
    /** 酒馆现在是不是深色：看酒馆正文文字是不是浅色 */
    const tavernDark = () => {
        const m = String(P.getComputedStyle(DOC.body).getPropertyValue('--SmartThemeBodyColor') || P.getComputedStyle(DOC.body).color).match(/\d+(\.\d+)?/g);
        if (!m || m.length < 3) return !!P.matchMedia?.('(prefers-color-scheme: dark)').matches;
        const [r, g, b] = m.map(Number);
        return 0.2126 * r + 0.7152 * g + 0.0722 * b > 140;
    };
    const applyNight = () => {
        const o = getData().options, mode = o.nightMode || 'day';
        const theme = NIGHT_THEMES[o.nightTheme] ? o.nightTheme : 'mono';
        const html = DOC.documentElement;
        html.classList.toggle('pc-night', mode === 'night' || (mode === 'auto' && tavernDark()));
        for (const k of Object.keys(NIGHT_THEMES)) html.classList.toggle('pc-nt-' + k, k === theme);
    };
    applyNight();
    cleanups.push(onChange(applyNight));
    // 跟随酒馆时，换了酒馆主题也跟上：每次打开智库窗口前再看一次
    const nightOnOpen = ev => { if (ev.target?.closest?.('#pc-stub, #pc-chip, #pc-menu-btn, [data-zhiku="open"]')) setTimeout(applyNight, 0); };
    DOC.addEventListener('click', nightOnOpen, true);
    cleanups.push(() => DOC.removeEventListener('click', nightOnOpen, true));
    // 第一次用：装过智绘姬的话，把 NovelAI key 和画师搬过来
    const ns = N.settings();
    if (!ns.__imported) {
        ns.__imported = true;
        if (!N.isReady() && N.importFromZhihuiji()) toastr.info('已从智绘姬搬来 NovelAI key 和生图设置', '智库');
        N.save();
    }
    addMenuButton();
    UI.renderChip();
    UI.renderStub();
    cleanups.push(onChange(() => { UI.renderChip(); UI.renderStub(); }));
    // 画师串绑定的模型：正文画师串换了就跟着换模型，换到没绑的串就换回原来的
    let lastModelKey = null;
    const modelName = v => (N.MODELS.find(m => m[0] === v) || [v, v])[1];
    const syncModel = () => {
        const d = getData(), s = N.settings();
        const t = d.active ? __mod_model.resolveTicket(d, d.active) : null;
        const want = t?.item?.model || '';
        const key = (d.active ? d.active.type + ':' + d.active.id : '') + '|' + want;
        if (key === lastModelKey) return;
        const first = lastModelKey === null;
        lastModelKey = key;
        if (want) {
            if (s.novelaimode === want) return;
            if (!s.zkModelBefore) s.zkModelBefore = s.novelaimode;
            s.novelaimode = want; N.save();
            if (!first) toastr.info(`画师串「${t.item.name || t.item.tag || ''}」绑定了 ${modelName(want)}，已切过去`, '智库', { timeOut: 2500 });
        } else if (s.zkModelBefore) {
            const back = s.zkModelBefore;
            delete s.zkModelBefore;
            if (s.novelaimode !== back) { s.novelaimode = back; N.save(); if (!first) toastr.info('换回原来的模型 ' + modelName(back), '智库', { timeOut: 2500 }); }
            else N.save();
        }
    };
    syncModel();
    cleanups.push(onChange(syncModel));

    const onChat = () => { selectedImages.reset(); __mod_chars.invalidateCharState(); return setTimeout(() => { void __mod_chars.applyAllCharacterBlocks(); globalThis.__zhikuComic?.renderAll({ chatChanged: true }); UI.renderChip(); UI.renderStub(); E.applyBindingOnChatChange(); addMesButtons(); }, 300); };
    DOC.addEventListener('click', onChatClick, true);
    cleanups.push(() => { DOC.removeEventListener('click', onChatClick, true); DOC.querySelectorAll('.pc-mes-gen, .pc-mes-outfit, .pc-mes-comic').forEach(n => n.remove()); });
    const onRendered = id => { setTimeout(addMesButtons, 50); };
    const onUserRendered = id => { onRendered(id); };
    const onEdited = id => { onRendered(id); __mod_chars.invalidateCharState(); void __mod_chars.applyCharacterBlocks(Number(id)); };
    const onSwiped = id => { __mod_chars.invalidateCharState(); void __mod_chars.applyCharacterBlocks(Number(id)); };
    const onDeleted = () => { __mod_chars.invalidateCharState(); };
    // 正文自动插图
    const illustrationPlanner = createIllustrationPlanner({
        getContext: () => SillyTavern.getContext(), getData, settings: () => __mod_marker.settings(), roster: () => C.currentCast(),
        askLLM: (s, u, o) => __mod_translate.askLLM(s, u, { ...o, fn: 'ill' }), pickJson: text => __mod_translate.pickJson(text),
        warn: message => toastr.warning(message, '智库 · 自动插图', {timeOut:6000}),
        onRequest: request => { illustrationLastRequest = request; },
        afterSave: async (id, selection = {}) => { addMesButtons(); return __mod_marker.process(id, selection.manual ? {manual:true,tokenIndices:selection.tokenIndices} : {}); },
    });
    const selectedImages = createSelectedImageController({document:DOC,getContext:()=>SillyTavern.getContext(),settings:()=>__mod_marker.settings(),generate:shot=>illustrationPlanner.selected(shot),notify:message=>toastr.info(message,'智库 · 选段生图')});
    cleanups.push(() => selectedImages.stop());
    const syncIllust = type => illustrationPlanner.sync(type);
    const illustAfter = id => illustrationPlanner.after(id);
    syncIllust();
    cleanups.push(onChange(syncIllust));
    if (event_types.GENERATION_STARTED) { eventSource.on(event_types.GENERATION_STARTED, syncIllust); cleanups.push(() => eventSource.removeListener?.(event_types.GENERATION_STARTED, syncIllust)); }
    cleanups.push(() => { illustrationPlanner.stop(); illustrationLastRequest = null; });
    const comic = createComicController({
        document: DOC, getContext: () => SillyTavern.getContext(), getData, commit: () => __mod_store.commit({ silent: true }), model: __mod_model,
        generatePage: req => N.generate({ ...req, comic: true }), storeImage: pcStoreImage, resolveUrl: u => pcLocal.url(u), dropImage: pcDropImage,
        recordImage: shot => pcRecordImage(shot), askLLM: (s, u, o) => __mod_translate.askLLM(s, u, { ...o, fn: 'comic' }),
        castText: () => __mod_chars.currentCast().filter(x => x.on || (x.char.appearance || []).length).map(x => `${x.char.name}：${__mod_chars.fixedTags(x.char) || '（还没写外貌，按正文描写画）'}`).join('\n'),
        notify: m => toastr.info(m, '智库 · 漫画', { timeOut: 1500 }), notifyError: m => toastr.error(m, '智库 · 漫画', { timeOut: 9000 }), naiMode: () => N.settings().naiMode, modal: UI.modal, esc: UI.esc,
    });
    globalThis.__zhikuComic = comic;
    cleanups.push(() => { comic.stop(); if (globalThis.__zhikuComic === comic) globalThis.__zhikuComic = null; });
    cleanups.push(onChange(() => comic.renderAll()));
    {
        const menu = DOC.getElementById('extensionsMenu');
        DOC.getElementById('pc-comic-menu')?.remove();
        if (menu) {
            const item = DOC.createElement('div');
            item.id = 'pc-comic-menu';
            item.className = 'list-group-item flex-container flexGap5 interactable';
            item.tabIndex = 0;
            item.innerHTML = '<i class="fa-solid fa-book-open fa-fw" aria-hidden="true"></i><span>漫画</span>';
            item.addEventListener('click', () => comic.openBook());
            menu.appendChild(item);
            cleanups.push(() => item.remove());
        }
    }
    for (const [ev, fn] of [[event_types.MESSAGE_SWIPED, id => setTimeout(() => comic.render(Number(id)), 60)], [event_types.MESSAGE_UPDATED, id => setTimeout(() => comic.render(Number(id)), 60)], [event_types.MORE_MESSAGES_LOADED, () => setTimeout(() => comic.renderAll(), 60)]]) {
        if (!ev) continue;
        eventSource.on(ev, fn);
        cleanups.push(() => eventSource.removeListener?.(ev, fn));
    }
    setTimeout(() => comic.renderAll({ chatChanged: true }), 300);
    const onCharMsg = id => {
        setTimeout(() => { comic.render(Number(id)); void comic.process(Number(id)); }, 0);
        setTimeout(addMesButtons, 50);
        // 先收角色块再生图：这一楼刚建档的角色，这张图就能用上
        setTimeout(() => { void __mod_chars.applyCharacterBlocks(Number(id)); void __mod_marker.process(Number(id)); }, 0);
        setTimeout(() => { void illustAfter(Number(id)).catch(e => console.warn('[智库] 自动插图', e)); }, 0);
    };
    for (const [ev, fn] of [[event_types.USER_MESSAGE_RENDERED, onUserRendered], [event_types.CHARACTER_MESSAGE_RENDERED, onCharMsg], [event_types.MORE_MESSAGES_LOADED, onRendered], [event_types.MESSAGE_UPDATED, onEdited], [event_types.MESSAGE_SWIPED, onSwiped], [event_types.MESSAGE_DELETED, onDeleted]]) {
        if (!ev) continue;
        eventSource.on(ev, fn);
        cleanups.push(() => eventSource.removeListener?.(ev, fn));
    }
    addMesButtons();
    if (event_types.GENERATION_STARTED) {
        const onGenerationStarted = () => __mod_marker.pregenReset?.();
        eventSource.on(event_types.GENERATION_STARTED, onGenerationStarted);
        cleanups.push(() => eventSource.removeListener?.(event_types.GENERATION_STARTED, onGenerationStarted));
    }
    if (event_types.STREAM_TOKEN_RECEIVED) {
        // 有流式事件：节流 250ms 扫一遍流式缓冲，标记一闭合就先生图
        let streamTimer = null, streamBusy = false;
        const onStreamToken = () => {
            if (streamTimer !== null) return;
            streamTimer = setTimeout(() => {
                streamTimer = null;
                if (streamBusy) return;
                streamBusy = true;
                Promise.resolve(__mod_marker.pregenSweep?.())
                    .catch(e => console.warn("[智库] 流式预生成", e))
                    .finally(() => { streamBusy = false; });
            }, 250);
        };
        eventSource.on(event_types.STREAM_TOKEN_RECEIVED, onStreamToken);
        cleanups.push(() => { if (streamTimer !== null) clearTimeout(streamTimer); eventSource.removeListener?.(event_types.STREAM_TOKEN_RECEIVED, onStreamToken); });
    } else {
        // 宿主没有流式事件：退化成轮询（只在生成中用得上，其余时候什么都不做）
        const poll = setInterval(() => {
            try {
                const c = SillyTavern.getContext();
                if (c.is_send_press || c.generating || c.streamingProcessor?.isStreaming) void __mod_marker.pregenSweep?.();
            } catch (e) { /* 宿主没这些字段就跳过 */ }
        }, 400);
        cleanups.push(() => clearInterval(poll));
    }
    eventSource.on(event_types.CHAT_CHANGED, onChat);
    cleanups.push(() => eventSource.removeListener?.(event_types.CHAT_CHANGED, onChat));
    E.applyBindingOnChatChange();

    cleanups.push(() => {
        for (const id of ['pc-root', 'pc-stub', 'pc-chip']) DOC.getElementById(id)?.remove();
        DOC.querySelectorAll('.pc-sheet-backdrop, .pc-modal-backdrop, .pc-viewer').forEach(n => n.remove());
        DOC.body.classList.remove('pc-lock');
    });
    const myCleanup = () => {
        while (cleanups.length) { try { cleanups.pop()?.(); } catch { /* 忽略 */ } }
        if (P.__piaoceCleanup === myCleanup) P.__piaoceCleanup = null;
    };
    ownCleanup = myCleanup;
    P.__piaoceCleanup = myCleanup;

    // Native settings entry; no Tavern Helper globals.
    const settingsRoot = DOC.getElementById('extensions_settings2') || DOC.getElementById('extensions_settings');
    if (settingsRoot) {
        DOC.getElementById('zhiku-extension-settings')?.remove();
        const panel = DOC.createElement('div');
        panel.id = 'zhiku-extension-settings';
        panel.innerHTML = '<div class="inline-drawer"><div class="inline-drawer-toggle inline-drawer-header"><b>智库</b><div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div><label class="checkbox_label" style="display:flex;padding:12px 0;font-weight:600"><input type="checkbox" data-zhiku="auto"><span>开启标记自动生图</span></label><div class="inline-drawer-content"><p>画师库、生图与共享上传</p><div class="flex-container flexGap5"><button type="button" class="menu_button" data-zhiku="open">打开智库</button><button type="button" class="menu_button" data-zhiku="switch">切换画师串</button></div></div></div>';
        panel.querySelector('[data-zhiku="open"]').addEventListener('click', () => UI.openWindow());
        panel.querySelector('[data-zhiku="switch"]').addEventListener('click', () => UI.openSwitcher());
        const autoToggle=panel.querySelector('[data-zhiku="auto"]');
        const syncAuto=()=>{autoToggle.checked=getData().options.markerAuto !== false;};
        syncAuto();
        autoToggle.addEventListener('change',()=>{getData().options.markerAuto=autoToggle.checked;__mod_store.commit({silent:true});});
        cleanups.push(onChange(syncAuto));
        settingsRoot.appendChild(panel);
        cleanups.push(() => panel.remove());
    }

    if (N.isReady()) toastr.success('打开方式：扩展设置里的「打开智库」、魔棒菜单里的「智库」、界面右边的小票根。', '智库已加载', { timeOut: 6000 });
    else toastr.info('第一次用：打开智库 → 设置，填 NovelAI key。', '智库已加载', { timeOut: 8000 });
    console.log('[智库] 脚本已加载');
}

let ownCleanup = null;
return {
    start,
    async stop() {
        if (globalThis.__zhikuDl) { DOC.removeEventListener('click', globalThis.__zhikuDl, true); delete globalThis.__zhikuDl; }
        await __mod_store.flush();
        ownCleanup?.();
        while (cleanups.length) { try { cleanups.pop()?.(); } catch {} }
    }
};
})();
return {
    start: () => __mod_script_entry.start(),
    async stop() {
        try { await __mod_script_entry.stop(); }
        finally { globalThis.__zhikuInputCleanup?.(); delete globalThis.__zhikuInputCleanup; DOC.getElementById('pc-comfy-css')?.remove(); DOC.getElementById('pc-toasts')?.remove(); for (const id of timers) window.clearTimeout(id); timers.clear(); stopped = true; __mod_translate.stopFetch(); }
    }
};

}
