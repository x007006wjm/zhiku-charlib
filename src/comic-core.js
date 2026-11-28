// 漫画核心版纯逻辑模块：分镜解析、冲突负面过滤、提示词组装、格位估算与前端叠字气泡生成

export const COMIC_DEFAULT_NEGATIVE = 'lowres, artistic error, worst quality, bad quality, jpeg artifacts, very displeasing, watermark, signature, logo, bad anatomy, bad hands';

const COMIC_NEG_FORBIDDEN = [
    'comic', 'comic panel', 'panels', 'multiple views', 'multiple scenes', '4koma', '2koma', 'sequence', 'full page comic', 'cut-in',
    'border', 'white border', 'black border', 'frame', 'outline', 'margins', 'negative space',
    'screentone', 'halftone', 'monochrome', 'greyscale', 'grayscale',
];

const bareComicTag = t => String(t || '').trim().replace(/^-?\d+(?:\.\d+)?::/, '').replace(/::$/, '').replace(/[{}\[\]]/g, '').replace(/_/g, ' ').trim().toLowerCase();
const splitComicTags = s => String(s || '').split(/[,\n]/).map(t => t.trim()).filter(Boolean);

/** 去掉会破坏分格/留白/黑白网点的负面词；插件叠字时自动屏蔽 NAI 自己画字 */
export function buildComicNegative(baseNeg, { monochrome = true, overlayText = true } = {}) {
    const drop = new Set(COMIC_NEG_FORBIDDEN.filter(t => monochrome || !['screentone', 'halftone', 'monochrome', 'greyscale', 'grayscale'].includes(t)));
    const kept = splitComicTags(baseNeg || COMIC_DEFAULT_NEGATIVE).filter(t => !drop.has(bareComicTag(t)));
    const extra = [];
    if (monochrome) extra.push('color', 'colorful', 'full color');
    if (overlayText) extra.push('text', 'speech bubble', 'thought bubble', 'sound effects', 'english text', 'chinese text', 'japanese text');
    const seen = new Set(kept.map(bareComicTag));
    for (const tag of extra) {
        const k = bareComicTag(tag);
        if (!seen.has(k)) { seen.add(k); kept.push(tag); }
    }
    return kept.join(', ');
}

/** 单句对白类型判定：说话 / 心里话 / 拟声 / 旁白 */
export function comicLineKind(line) {
    const t = String(line || '').trim();
    if (!t) return null;
    if (/^[「『“"][\s\S]*[」』”"]$/.test(t)) return { kind: 'speech', text: t.replace(/^[「『“"]|[」』”"]$/g, '').trim() };
    if (/^[（(][\s\S]*[）)]$/.test(t)) return { kind: 'thought', text: t.replace(/^[（(]|[）)]$/g, '').trim() };
    const bare = t.replace(/[!！?？~～…ー\s]/g, '');
    if (bare && bare.length <= 6 && (/^[゠-ヿ぀-ゟ]+$/.test(bare) || /^[A-Z]+$/.test(bare) || (/[!！]+$/.test(t) && bare.length <= 4 && !/[，。,.]/.test(t)))) {
        return { kind: 'sfx', text: t };
    }
    return { kind: 'narr', text: t };
}

/** 根据格数估算每格区域（日漫从右上往左下阅读顺序） */
export function panelBoxesFor(count) {
    const n = Math.max(1, Math.min(8, Number(count) || 1));
    if (n === 1) return [{ x: 0.02, y: 0.02, w: 0.96, h: 0.96 }];
    if (n === 2) return [{ x: 0.02, y: 0.02, w: 0.96, h: 0.47 }, { x: 0.02, y: 0.51, w: 0.96, h: 0.47 }];
    if (n === 3) return [
        { x: 0.02, y: 0.02, w: 0.96, h: 0.31 },
        { x: 0.02, y: 0.35, w: 0.96, h: 0.31 },
        { x: 0.02, y: 0.68, w: 0.96, h: 0.30 },
    ];
    if (n === 4) return [
        { x: 0.51, y: 0.02, w: 0.47, h: 0.47 },
        { x: 0.02, y: 0.02, w: 0.47, h: 0.47 },
        { x: 0.51, y: 0.51, w: 0.47, h: 0.47 },
        { x: 0.02, y: 0.51, w: 0.47, h: 0.47 },
    ];
    const rows = Math.ceil(n / 2);
    const h = 0.94 / rows;
    const boxes = [];
    for (let i = 0; i < n; i++) {
        const r = Math.floor(i / 2);
        const col = i % 2; // 右先左后
        const isLastSingle = i === n - 1 && n % 2 === 1;
        boxes.push({
            x: isLastSingle ? 0.02 : (col === 0 ? 0.51 : 0.02),
            y: 0.02 + r * (h + 0.015),
            w: isLastSingle ? 0.96 : 0.47,
            h,
        });
    }
    return boxes;
}

/** 规范化副 AI 返回的漫画分镜 JSON */
export function normalizeComicPages(raw) {
    const arr = Array.isArray(raw) ? raw : (Array.isArray(raw?.pages) ? raw.pages : []);
    const pages = [];
    for (const item of arr) {
        if (!item || typeof item !== 'object') continue;
        const prompt = String(item.prompt || item.visual || item.tags || '').trim();
        const rawPanels = Array.isArray(item.panels) ? item.panels : [];
        const panels = rawPanels.map((p, idx) => {
            if (typeof p === 'string') return { visual: p.trim(), lines: [] };
            const visual = String(p?.visual || p?.prompt || p?.desc || '').trim();
            const rawLines = Array.isArray(p?.lines) ? p.lines : (Array.isArray(p?.dialogue) ? p.dialogue : (p?.text ? [p.text] : []));
            const lines = rawLines.flatMap(x => String(x || '').split(/\n+/)).map(s => s.trim()).filter(Boolean);
            return { id: String(p?.id || `P${idx + 1}`), visual, lines };
        }).filter(p => p.visual || p.lines.length);
        const combinedPrompt = prompt || panels.map(p => p.visual).filter(Boolean).join(', ');
        if (!combinedPrompt) continue;
        const pageLines = (Array.isArray(item.lines) ? item.lines : (item.narration ? [item.narration] : []))
            .flatMap(x => String(x || '').split(/\n+/)).map(s => s.trim()).filter(Boolean);
        pages.push({
            id: String(item.id || `pg_${pages.length + 1}`),
            title: String(item.title || `第 ${pages.length + 1} 页`).trim(),
            prompt: combinedPrompt,
            panels: panels.length ? panels : [{ id: 'P1', visual: combinedPrompt, lines: pageLines }],
            pageLines: panels.length ? pageLines : [],
        });
    }
    return pages;
}

/** 组装单页漫画生图正面词 */
export function buildComicPagePrompt(page, { stylePrompt = '', monochrome = true, expand = v => v } = {}) {
    const panelCount = Math.max(1, page?.panels?.length || 1);
    const gridTag = panelCount === 1 ? 'comic' : panelCount === 2 ? 'comic, 2koma, 2 panels' : panelCount === 4 ? 'comic, 4koma, 4 panels, 2x2 grid' : `comic, ${panelCount} panels, multiple views`;
    const bwTag = monochrome ? 'monochrome, greyscale, manga, screentone, ink lines, high contrast' : 'full color, manga style, clean lineart';
    const body = expand(String(page?.prompt || ''));
    return [stylePrompt, bwTag, gridTag, body].map(x => String(x || '').trim()).filter(Boolean).join(', ');
}

/** 生成前端叠字气泡 HTML */
export function renderComicBubblesHtml(page, { esc = s => String(s), fontSize = '12px', vertical = false, show = true } = {}) {
    if (!show || !page) return '';
    const panels = Array.isArray(page.panels) ? page.panels : [];
    const boxes = panelBoxesFor(panels.length || 1);
    const base = `font-size:${fontSize} !important;line-height:1.4 !important;font-family:'Noto Serif SC','Songti SC',serif !important;margin:0 !important;letter-spacing:0 !important;text-indent:0 !important`;
    const vert = vertical ? 'writing-mode:vertical-rl !important;text-orientation:mixed;' : '';
    const pct = v => (v * 100).toFixed(2) + '%';
    const out = [];
    const pageLines = (page.pageLines || []).map(x => String(x || '').trim()).filter(Boolean);
    if (pageLines.length) {
        out.push(`<div class="pc-cb2 narr page" style="left:6px;top:6px;max-width:72%;${base}">${pageLines.map(esc).join('<br>')}</div>`);
    }
    panels.forEach((panel, i) => {
        const lines = (panel.lines || []).map(comicLineKind).filter(Boolean);
        if (!lines.length) return;
        const b = boxes[i] || { x: 0.02, y: i / Math.max(1, panels.length), w: 0.96, h: 1 / Math.max(1, panels.length) };
        const talk = lines.filter(l => l.kind === 'speech' || l.kind === 'thought');
        const m = talk.length;
        let k = 0, narrAt = 0, sfxAt = 0;
        for (const l of lines) {
            const tx = esc(l.text).replace(/\n+/g, '<br>');
            if (l.kind === 'narr') {
                out.push(`<div class="pc-cb2 narr" style="left:calc(${pct(b.x)} + 4px);top:calc(${pct(b.y + b.h * 0.04 + narrAt * b.h * 0.16)} + 4px);max-width:calc(${pct(b.w * 0.65)});${base}">${tx}</div>`);
                narrAt++;
                continue;
            }
            if (l.kind === 'sfx') {
                out.push(`<div class="pc-cb2 sfx" style="left:${pct(b.x + b.w * (0.5 + 0.16 * (sfxAt % 2 ? -1 : 1)))};top:${pct(b.y + b.h * (0.45 + 0.12 * sfxAt))};${base};font-size:calc(${fontSize} * 1.75) !important">${tx}</div>`);
                sfxAt++;
                continue;
            }
            const cx = vertical ? b.x + b.w * Math.max(0.12, 0.84 - 0.22 * k) : b.x + b.w * (m === 1 ? 0.68 : (k % 2 === 0 ? 0.72 : 0.28));
            const cy = vertical ? b.y + b.h * (0.06 + 0.08 * (k % 2)) : b.y + b.h * (0.06 + (m > 1 ? 0.56 * k / (m - 1) : 0));
            const lim = vertical ? `max-height:${pct(b.h * 0.64)};` : `max-width:${pct(b.w * 0.6)};`;
            out.push(`<div class="pc-cb2 ${l.kind}${vertical ? ' v' : ''}" style="left:${pct(cx)};top:${pct(cy)};${lim}${vert}${base}">${tx}</div>`);
            k++;
        }
    });
    return out.join('');
}
