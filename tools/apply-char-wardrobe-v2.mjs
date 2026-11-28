import assert from 'node:assert/strict';

/**
 * v1.0.2 角色库 & 衣柜深化全量移植：
 * 1) 同人角色开关（Danbooru 原作名 + 外貌也一起发 + AI 认是谁）+ 缺失中文一键翻译
 * 2) 角色生图（SFW/NSFW、头像/半身/全身、白底本地抠图 + 画背景/选图换背景）+ 相册 + 设为头像 + 加参考图
 * 3) 读卡/读人增强（读前挑世界书条目、User 读当前卡世界书、最近 40 楼正文读人、内容拦截自动分段回退）
 * 4) 衣柜深化（多图批量导入、配饰搭配、卡片裁切/完整切换、展示图换模特、多角色同步）
 */
export function applyCharWardrobeV2(s) {
    const patch = (a, b) => {
        assert.equal(s.split(a).length, 2, 'applyCharWardrobeV2 anchor mismatch: ' + a.slice(0, 90));
        s = s.replace(a, () => b);
    };

    // ── 1. __mod_trans 新增：缺失中文翻译、AI 认同人角色、正文/卡安全分段读人
    patch(
        `return { hasChinese, apiProfiles, activeApiId, currentApi, askLLM, translateToTags, pickJson, extractAppearance, textToPairs, sceneFromChat, listModels, designOutfit, outfitFromStory, designOutfitsFromChat, askVision, outfitFromImage, lookFromImage, outfitFromText };`,
`async function translatePairLabels(enList) {
    const list = [...new Set((Array.isArray(enList) ? enList : []).map(x => String(x || '').trim()).filter(x => x && !hasChinese(x)))];
    if (!list.length) return {};
    const j = pickJson(await askLLM(
        '把下面 Danbooru 英文标签逐个翻译成简短自然的简体中文。只输出 JSON 对象：{"英文原标签": "中文"}。',
        list.join('\\n'),
        { maxTokens: Math.min(3000, 300 + list.length * 40) }
    ));
    const out = {};
    for (const [k, v] of Object.entries(j || {})) {
        const zh = String(v || '').trim();
        if (k && zh) out[k.trim().toLowerCase()] = zh;
    }
    return out;
}

async function identifyCanon(name, aliases = '', desc = '') {
    const sys = '判断角色是否为动漫/游戏/轻小说等知名原作同人角色。若是，给出 Danbooru 上常用的英文角色名标签（如 hatsune miku, vocaloid）；若不是原创/冷门不确定则 canon 留空。只输出 JSON：{"canon": "", "reason": ""}。';
    const user = \`角色名：\${name}\\n别名：\${aliases || '无'}\\n设定：\${String(desc || '').slice(0, 3000)}\`;
    const j = pickJson(await askLLM(sys, user, { maxTokens: 400 }));
    return { canon: String(j?.canon || '').trim(), reason: String(j?.reason || '').trim() };
}

async function extractCastFromText(cardName, label, text, fromEnd = false) {
    const src = String(text || '').trim();
    if (!src) return { people: [] };
    const sys = \`你从设定或剧情中提取出场人物的固定外貌、当前衣服与别名。
\${PAIRS}
如果某位角色是知名动漫/游戏原作同人角色，在 canon 字段填写 Danbooru 角色名标签（否则留空）。
如果设定里明确描写了成年角色的私密身体特征，放进 nsfw 数组（未成年或未提及则留空数组）。
只输出 JSON：{"people":[{"name":"名字","aliases":[],"canon":"","appearance":[...],"outfit":[...],"nsfw":[...]}]}。\`;
    const normPairs = arr => (Array.isArray(arr) ? arr : [])
        .map(x => typeof x === 'string' ? { en: x.trim(), zh: '' } : { en: String(x?.en || '').trim(), zh: String(x?.zh || '').trim() })
        .filter(x => x.en && !hasChinese(x.en));
    const normPeople = list => (Array.isArray(list) ? list : []).filter(p => p && typeof p === 'object' && String(p.name || '').trim()).map(p => ({
        name: String(p.name || '').trim(),
        aliases: (Array.isArray(p.aliases) ? p.aliases : []).map(x => String(x || '').trim()).filter(Boolean),
        canon: String(p.canon || '').trim(),
        appearance: normPairs(p.appearance),
        outfit: normPairs(p.outfit),
        nsfw: normPairs(p.nsfw),
    }));
    const slice = fromEnd ? src.slice(-24000) : src.slice(0, 24000);
    try {
        const j = pickJson(await askLLM(sys, \`卡名：\${cardName}\\n\${label}：\\n\${slice}\`, { maxTokens: 4000 }));
        return { people: mergeExtractedPeople(normPeople(j?.people || j?.characters)) };
    } catch (e) {
        if (!isContentBlockError(e)) throw e;
        // 内容拦截时：去掉 NSFW 身体要求，分段读取并合并
        const sysSafe = sys.replace(/如果设定里明确描写了成年角色的私密身体特征[^\\n]*/, 'nsfw 一律写 []。');
        const chunks = [];
        const body = fromEnd ? src.slice(-48000) : src.slice(0, 48000);
        for (let i = 0; i < body.length; i += 5500) chunks.push(body.slice(i, i + 5500));
        const selected = (fromEnd ? chunks.slice(-8) : chunks.slice(0, 8));
        const collected = [];
        let okCount = 0, blockedCount = 0;
        for (const ch of selected) {
            try {
                const j = pickJson(await askLLM(sysSafe, \`卡名：\${cardName}\\n\${label}（片段）：\\n\${ch}\`, { maxTokens: 2500 }));
                collected.push(...normPeople(j?.people || j?.characters).map(p => ({ ...p, nsfw: [] })));
                okCount++;
            } catch (err) {
                if (isContentBlockError(err)) blockedCount++;
                else throw err;
            }
        }
        if (!okCount) throw new Error(\`分段读取 \${selected.length} 段均被模型内容限制拦截，请更换模型或精简世界书条目\`);
        if (blockedCount) toastr.warning(\`分段读取完成：\${okCount} 段成功，\${blockedCount} 段被拦截（仅提取普通外貌）\`, '角色', { timeOut: 6000 });
        return { people: mergeExtractedPeople(collected) };
    }
}

return { hasChinese, apiProfiles, activeApiId, currentApi, askLLM, translateToTags, pickJson, extractAppearance, textToPairs, sceneFromChat, listModels, designOutfit, outfitFromStory, designOutfitsFromChat, askVision, outfitFromImage, lookFromImage, outfitFromText, translatePairLabels, identifyCanon, extractCastFromText };`
    );

    // ── 2. __mod_chars 新增：avatarUrl 优先本地头像 c.photo、lookTags、descOfFull（含世界书与 User 读卡世界书）
    patch(
`function avatarUrl(c) {
    if (c.kind === 'user') return \`/thumbnail?type=persona&file=\${encodeURIComponent(c.avatar)}\`;
    if (c.kind === 'free') return c.image || '';
    const file = c.kind === 'side' ? c.card : c.avatar;
    return file ? \`/thumbnail?type=avatar&file=\${encodeURIComponent(file)}\` : '';
}`,
`function avatarUrl(c) {
    if (c?.photo) return c.photo.startsWith('data:') ? c.photo : '/' + String(c.photo).replace(/^\\/+/, '');
    if (c.kind === 'user') return \`/thumbnail?type=persona&file=\${encodeURIComponent(c.avatar)}\`;
    if (c.kind === 'free') return c.image || '';
    const file = c.kind === 'side' ? c.card : c.avatar;
    return file ? \`/thumbnail?type=avatar&file=\${encodeURIComponent(file)}\` : '';
}
function lookTags(c) {
    return canonLookTags(c, tagText(c?.appearance));
}`
    );
    patch(
`function descOf(c) {
    if (c.kind === 'side') return '';
    return [...stCards(), ...stPersonas()].find(x => x.key === c.key)?.desc || '';
}`,
`function descOf(c) {
    if (c.kind === 'side') return '';
    return [...stCards(), ...stPersonas()].find(x => x.key === c.key)?.desc || '';
}
async function loadWorldbookEntries(name) {
    if (!name) return [];
    try {
        const res = await fetch('/api/worldinfo/get', {
            method: 'POST',
            headers: ctx().getRequestHeaders?.() || { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name }),
        });
        if (!res.ok) return [];
        const j = await res.json();
        return Array.isArray(j?.entries) ? j.entries : Object.values(j?.entries || {});
    } catch { return []; }
}
async function descOfFull(c, { all = false, choose = null } = {}) {
    const cx = ctx();
    const parts = [];
    const cands = [];
    const add = (label, text) => { const t = String(text || '').trim(); if (t) parts.push(\`【\${label}】\\n\${t}\`); };
    const collectBook = (title, entries, matcher) => {
        const list = (Array.isArray(entries) ? entries : Object.values(entries || {}))
            .filter(e => e && !e.disable && e.enabled !== false && String(e.content || '').trim());
        for (const e of list) cands.push({ title, e, auto: all || !matcher || matcher(e) });
    };
    const flushBooks = async () => {
        if (!cands.length) return;
        let use = cands.filter(x => x.auto);
        if (typeof choose === 'function') {
            const sel = await choose(cands.map(x => ({
                title: x.title,
                name: x.e.comment || (x.e.key || x.e.keys || []).join('、') || '条目',
                content: String(x.e.content || ''),
                auto: x.auto,
            })), c);
            if (!sel) throw Object.assign(new Error('已取消'), { name: 'AbortError' });
            use = cands.filter((_, i) => sel.has(i));
        }
        for (const x of use) add(\`\${x.title}：\${x.e.comment || (x.e.key || x.e.keys || []).join('、') || '条目'}\`, x.e.content);
        cands.length = 0;
    };
    const pu = cx.powerUserSettings || {};
    const nowCard = cx.characterId != null ? cx.characters?.[cx.characterId] : null;
    if (c.kind === 'user') {
        const pd = pu.persona_descriptions?.[c.avatar] || {};
        add('人设描述', pd.description || descOf(c));
        const userish = e => [e.comment, ...(e.key || e.keys || [])].some(t => {
            const s = String(t || '');
            return /\\{\\{user\\}\\}|<user>|\\buser\\b|用户|玩家|主角/i.test(s) || (!!c.name && s.includes(c.name));
        });
        if (pd.lorebook) collectBook('人设世界书', await loadWorldbookEntries(pd.lorebook), userish);
        if (nowCard) {
            const dd = nowCard.data || {};
            if (dd.character_book?.entries) collectBook(\`「\${nowCard.name}」卡内世界书\`, dd.character_book.entries, userish);
            const names = new Set();
            if (dd.extensions?.world) names.add(dd.extensions.world);
            if (cx.chatMetadata?.world_info) names.add(cx.chatMetadata.world_info);
            try { for (const o of DOC.querySelectorAll('#world_info option:checked')) if (o.textContent.trim()) names.add(o.textContent.trim()); } catch {}
            if (pd.lorebook) names.delete(pd.lorebook);
            for (const n of names) collectBook(\`世界书「\${n}」\`, await loadWorldbookEntries(n), userish);
        }
        await flushBooks();
        return parts.join('\\n\\n').slice(0, 60000);
    }
    const cardAvatar = c.kind === 'side' ? c.card : c.avatar;
    const card = (cx.characters || []).find(x => x?.avatar === cardAvatar) || nowCard;
    if (card) {
        const dd = card.data || {};
        add('角色卡描述', card.description || dd.description);
        if (card.personality || dd.personality) add('性格设定', card.personality || dd.personality);
        if (card.scenario || dd.scenario) add('场景背景', card.scenario || dd.scenario);
        const nameMatch = c.kind === 'side' ? (e => [e.comment, e.content, ...(e.key || e.keys || [])].some(x => String(x || '').includes(c.name))) : null;
        if (dd.character_book?.entries) collectBook('卡内世界书', dd.character_book.entries, nameMatch);
        const names = new Set();
        if (dd.extensions?.world) names.add(dd.extensions.world);
        if (cx.chatMetadata?.world_info) names.add(cx.chatMetadata.world_info);
        try { for (const o of DOC.querySelectorAll('#world_info option:checked')) if (o.textContent.trim()) names.add(o.textContent.trim()); } catch {}
        for (const n of names) collectBook(\`世界书「\${n}」\`, await loadWorldbookEntries(n), nameMatch);
        await flushBooks();
    } else {
        add('角色描述', descOf(c));
    }
    return parts.join('\\n\\n').slice(0, 60000);
}`
    );
    patch(
        `return { avatarUrl, stCards, allChars,`,
        `return { avatarUrl, lookTags, descOfFull, stCards, allChars,`
    );

    // ── 3. 本地白底抠图 + 换背景辅助 + 世界书条目挑选弹窗 + 配饰搭配弹窗
    patch(
        `function viewCharEdit(d) {`,
`function zkLoadImg(src) {
    return new Promise((resolve, reject) => {
        const im = new Image();
        im.crossOrigin = 'anonymous';
        im.onload = () => resolve(im);
        im.onerror = () => reject(new Error('图片加载失败'));
        im.src = src;
    });
}
/** 浏览器本地四角泛洪抠白底（0 点数消耗） */
async function cutWhiteBg(src, tol = 34) {
    const im = await zkLoadImg(src);
    const w = im.naturalWidth || im.width, h = im.naturalHeight || im.height;
    const cv = DOC.createElement('canvas'); cv.width = w; cv.height = h;
    const g = cv.getContext('2d'); g.drawImage(im, 0, 0);
    const id = g.getImageData(0, 0, w, h), d = id.data;
    const vis = new Uint8Array(w * h);
    const isBg = idx => {
        const r = d[idx], gr = d[idx + 1], b = d[idx + 2];
        return r >= 255 - tol && gr >= 255 - tol && b >= 255 - tol && Math.max(r, gr, b) - Math.min(r, gr, b) <= 24;
    };
    const q = [];
    for (let x = 0; x < w; x++) { q.push(x, (h - 1) * w + x); }
    for (let y = 0; y < h; y++) { q.push(y * w, y * w + (w - 1)); }
    for (let head = 0; head < q.length; head++) {
        const p = q[head];
        if (vis[p]) continue;
        vis[p] = 1;
        if (!isBg(p * 4)) continue;
        d[p * 4 + 3] = 0;
        const x = p % w, y = (p - x) / w;
        if (x > 0 && !vis[p - 1]) q.push(p - 1);
        if (x + 1 < w && !vis[p + 1]) q.push(p + 1);
        if (y > 0 && !vis[p - w]) q.push(p - w);
        if (y + 1 < h && !vis[p + w]) q.push(p + w);
    }
    g.putImageData(id, 0, 0);
    return cv.toDataURL('image/png');
}
async function putOnBg(fgSrc, bgSrc) {
    const [fg, bg] = await Promise.all([zkLoadImg(fgSrc), zkLoadImg(bgSrc)]);
    const w = fg.naturalWidth || fg.width, h = fg.naturalHeight || fg.height;
    const cv = DOC.createElement('canvas'); cv.width = w; cv.height = h;
    const g = cv.getContext('2d');
    const br = (bg.naturalWidth || bg.width) / (bg.naturalHeight || bg.height || 1), tr = w / (h || 1);
    let sx = 0, sy = 0, sw = bg.naturalWidth || bg.width, sh = bg.naturalHeight || bg.height;
    if (br > tr) { sw = sh * tr; sx = ((bg.naturalWidth || bg.width) - sw) / 2; }
    else { sh = sw / tr; sy = ((bg.naturalHeight || bg.height) - sh) / 2; }
    g.drawImage(bg, sx, sy, sw, sh, 0, 0, w, h);
    g.drawImage(fg, 0, 0, w, h);
    return cv.toDataURL('image/png');
}
function pickWiEntries(list, c) {
    return new Promise(resolve => {
        const sel = new Set(list.map((x, i) => x.auto ? i : -1).filter(i => i >= 0));
        let q = '';
        const box = modal(\`<h3 class="pc-h3">挑要发给 AI 的世界书条目</h3>
          <div class="pc-dim small">读「\${esc(c?.name || '')}」的设定。默认已勾选相关条目，可自由增减。</div>
          <label class="pc-search pc-mt-s"><span class="pc-sr">搜条目</span>\${ICON.search}<input data-wq placeholder="搜条目名或内容"></label>
          <div class="pc-chips wrap" style="margin-top:6px"><button class="pc-pill dashed tiny" data-wa="all">全选</button><button class="pc-pill dashed tiny" data-wa="none">全不选</button><button class="pc-pill dashed tiny" data-wa="auto">恢复默认</button></div>
          <div data-wl style="max-height:48vh;overflow:auto;margin-top:8px"></div>
          <div class="pc-dim small" data-wc style="margin-top:6px"></div>
          <div class="pc-actions"><button class="pc-btn" data-wa="no">取消</button><button class="pc-btn dark" data-wa="ok">用这些读</button></div>\`);
        const shown = () => list.map((x, i) => i).filter(i => !q || (list[i].title + list[i].name + list[i].content).toLowerCase().includes(q));
        const draw = () => {
            let last = '';
            box.querySelector('[data-wl]').innerHTML = shown().map(i => {
                const x = list[i];
                const head = x.title !== last ? \`<div class="pc-label" style="margin:10px 0 4px">\${esc(x.title)}</div>\` : '';
                last = x.title;
                return head + \`<label style="display:flex;gap:8px;align-items:flex-start;padding:6px 2px;border-bottom:1px dashed var(--pc-dash);cursor:pointer"><input type="checkbox" data-wi="\${i}" \${sel.has(i) ? 'checked' : ''} style="margin-top:3px"><span class="pc-grow"><b style="font-size:13.5px">\${esc(x.name)}</b>\${x.auto ? ' <small class="pc-dim">· 推荐</small>' : ''}<small class="pc-dim" style="display:block;line-height:1.5">\${esc(x.content.slice(0, 70))}\${x.content.length > 70 ? '…' : ''}（\${x.content.length} 字）</small></span></label>\`;
            }).join('') || '<div class="pc-dim small">没有搜到</div>';
            const chars = [...sel].reduce((n, i) => n + list[i].content.length, 0);
            box.querySelector('[data-wc]').textContent = \`已选 \${sel.size} / \${list.length} 条，约 \${chars} 字\`;
        };
        box.addEventListener('input', ev => { if (ev.target.matches('[data-wq]')) { q = ev.target.value.trim().toLowerCase(); draw(); } });
        box.addEventListener('change', ev => { const i = ev.target.dataset?.wi; if (i == null) return; ev.target.checked ? sel.add(Number(i)) : sel.delete(Number(i)); draw(); });
        box.addEventListener('click', ev => {
            const a = ev.target.closest('[data-wa]')?.dataset.wa; if (!a) return;
            if (a === 'no') { box.closeModal(); resolve(null); return; }
            if (a === 'ok') { box.closeModal(); resolve(sel); return; }
            if (a === 'all') list.forEach((_, i) => sel.add(i));
            if (a === 'none') sel.clear();
            if (a === 'auto') { sel.clear(); list.forEach((x, i) => x.auto && sel.add(i)); }
            draw();
        });
        draw();
    });
}
function openAccessoryMix() {
    const all = C.wardrobe();
    if (!all.length) { toastr.info('衣柜里还没有衣服', '配饰搭配'); return; }
    let baseIdx = 0;
    const accPool = [];
    const seen = new Set();
    for (const { o } of all) {
        for (const t of o.tags || []) {
            if (!isAcc(t)) continue;
            const k = String(t.en || '').trim().toLowerCase();
            if (k && !seen.has(k)) { seen.add(k); accPool.push({ en: t.en, zh: t.zh || '', acc: true }); }
        }
    }
    const picked = new Set();
    const box = modal(\`<h3 class="pc-h3">配饰搭配</h3>
      <div class="pc-dim small">先选一套衣服当底（只取整体），再自由勾选衣柜里的配饰，合成一套新衣服。</div>
      <label class="pc-field pc-mt-s"><span>基底衣服</span><select class="pc-input" data-mixbase>\${all.map((x, i) => \`<option value="\${i}">\${esc(x.o.name)}\${x.owner ? '（' + esc(x.owner.name) + '）' : ''}</option>\`).join('')}</select></label>
      <div class="pc-label pc-mt-s">可选配饰（\${accPool.length} 件）</div>
      <div class="pc-chips wrap" data-mixacc style="max-height:28vh;overflow:auto"></div>
      <div class="pc-label pc-mt-s">合成预览</div>
      <p class="pc-quote small mono" data-mixprev></p>
      <div class="pc-actions"><button class="pc-btn" data-mixact="no">取消</button><button class="pc-btn dark" data-mixact="ok">存成新的一套</button></div>\`);
    const mergedTags = () => {
        const base = (all[baseIdx]?.o?.tags || []).filter(t => !isAcc(t)).map(t => ({ ...t }));
        const extra = [...picked].map(i => ({ ...accPool[i], acc: true }));
        return [...base, ...extra];
    };
    const draw = () => {
        box.querySelector('[data-mixacc]').innerHTML = accPool.length
            ? accPool.map((t, i) => \`<button class="pc-pill tiny \${picked.has(i) ? 'on' : 'dashed'}" data-mixi="\${i}">\${esc(t.zh || t.en)}</button>\`).join('')
            : '<span class="pc-dim small">衣柜里暂无配饰标签（可在单套衣服里把标签挪到配饰栏）</span>';
        box.querySelector('[data-mixprev]').textContent = C.tagText(mergedTags()) || '（空）';
    };
    box.addEventListener('change', ev => { if (ev.target.matches('[data-mixbase]')) { baseIdx = Number(ev.target.value) || 0; draw(); } });
    box.addEventListener('click', ev => {
        const mi = ev.target.closest('[data-mixi]');
        if (mi) { const idx = Number(mi.dataset.mixi); picked.has(idx) ? picked.delete(idx) : picked.add(idx); draw(); return; }
        const act = ev.target.closest('[data-mixact]')?.dataset.mixact;
        if (act === 'no') box.closeModal();
        if (act === 'ok') {
            const tags = mergedTags();
            const baseName = all[baseIdx]?.o?.name || '搭配';
            box.closeModal();
            ui.outfit = { draft: true, name: (baseName + ' · 搭配').slice(0, 20), tags, image: '', dest: '' };
            ui.view = 'outfit';
            render();
        }
    });
    draw();
}
function viewCharEdit(d) {`
    );

    // ── 4. 角色编辑页 UI：缺失中文一键译 + 同人角色开关 + 角色生图与相册（白底抠图换背景）
    patch(
        `      <div class="pc-pairs">\${pairChips(c.appearance, 'app') || '<span class="pc-dim small">还没有</span>'}</div>`,
        `      \${(() => { const miss = [...(c.appearance || []), ...(c.outfits || []).flatMap(o => o.tags || [])].filter(t => t?.en && !String(t.zh || '').trim()).length; return miss ? \`<div class="pc-actions wrap pc-mt-s"><button class="pc-pill dashed tiny" data-act="transpairs" \${busy ? 'disabled' : ''}>\${busy === 'trans' ? '<span class="pc-busy">翻译中</span>' : \`译成中文 · \${miss} 个没有中文\`}</button></div>\` : ''; })()}
      <div class="pc-pairs">\${pairChips(c.appearance, 'app') || '<span class="pc-dim small">还没有</span>'}</div>
      <div class="pc-mt-s" style="padding-top:8px;border-top:1px dashed var(--pc-dash)">
        <label class="pc-switch"><input type="checkbox" data-charcanon-on \${c.canonOn ? 'checked' : ''}><span></span>同人角色（按 Danbooru 原作名画）<small>知名动漫/游戏角色可打开，直接让 NAI 照原作画</small></label>
        \${c.canonOn ? \`<div class="pc-addrow pc-mt-s"><input class="pc-input" data-charcanon-tag value="\${esc(c.canonTag || '')}" placeholder="如 hatsune miku, vocaloid"><button class="pc-pill dashed tiny" data-act="canonai" \${busy ? 'disabled' : ''}>\${busy === 'canon' ? '识别中…' : '✦ AI 认是谁'}</button></div>
        <label class="pc-switch pc-mt-s"><input type="checkbox" data-charcanon-keep \${c.canonKeepLook ? 'checked' : ''}><span></span>外貌标签也一起发<small>冷门角色 NAI 认不准时勾选，把上面固定外貌一起发</small></label>\` : ''}
      </div>`
    );
    patch(
        `    <section class="pc-card pc-pad pc-mt">
      <b>精确参考（长相 / 服装 / 画风）</b>`,
        `    <section class="pc-card pc-pad pc-mt">
      <b>生成这个角色的图 & 相册</b>
      <div class="pc-dim small">生成结果可存进相册、设为智库头像，或直接加进精确参考图。</div>
      <div class="pc-chips wrap pc-mt-s">
        \${[['sfw', 'SFW'], ['nsfw', 'NSFW']].map(([k, t]) => \`<button class="pc-pill tiny \${(ui.charTestRating || 'sfw') === k ? 'on' : 'dashed'}" data-act="chartestopt" data-k="rating" data-v="\${k}">\${t}</button>\`).join('')}
        \${[['portrait', '头像'], ['upper', '半身'], ['full', '全身']].map(([k, t]) => \`<button class="pc-pill tiny \${(ui.charTestShot || 'upper') === k ? 'on' : 'dashed'}" data-act="chartestopt" data-k="shot" data-v="\${k}">\${t}</button>\`).join('')}
        \${[['white', '白底抠图'], ['scene', '直接画背景']].map(([k, t]) => \`<button class="pc-pill tiny \${(ui.charTestBg || 'white') === k ? 'on' : 'dashed'}" data-act="chartestopt" data-k="bg" data-v="\${k}">\${t}</button>\`).join('')}
      </div>
      <div class="pc-addrow pc-mt-s">
        <input class="pc-input" data-bind="charTestExtra" value="\${esc(ui.charTestExtra || '')}" placeholder="可选动作/表情，如 smiling, sitting">
        <button class="pc-btn dark" data-act="chartest" \${busy ? 'disabled' : ''}>\${busy === 'test' ? '<span class="pc-busy">生成中</span>' : '生成'}</button>
      </div>
      \${ui.charTestImg && ui.charTestKey === c.key ? \`<div class="pc-result pc-mt-s">
        <img src="\${esc(ui.charTestImg)}" alt="" data-act="viewimg" data-src="\${esc(ui.charTestImg)}" style="background:repeating-conic-gradient(#d8d2c5 0% 25%,#f4efe4 0% 50%) 50%/16px 16px">
        <div class="pc-actions wrap pc-mt-s">
          <button class="pc-pill tiny on" data-act="charkeep" data-w="photo" \${busy ? 'disabled' : ''}>存进相册</button>
          <button class="pc-pill tiny dashed" data-act="charkeep" data-w="avatar" \${busy ? 'disabled' : ''}>设为头像</button>
          <button class="pc-pill tiny dashed" data-act="charkeep" data-w="ref" \${busy ? 'disabled' : ''}>加进参考图</button>
        </div>
        \${ui.charTestCut ? \`<div class="pc-addrow pc-mt-s">
          <input class="pc-input" data-bind="charBgQ" value="\${esc(ui.charBgQ || '')}" placeholder="换背景描述，如 sunset classroom, sakura">
          <button class="pc-pill dashed tiny" data-act="charbg" data-w="gen" \${busy ? 'disabled' : ''}>\${busy === 'bg' ? '画背景中…' : '画背景贴上'}</button>
          <label class="pc-pill dashed tiny">选图当背景<input type="file" accept="image/*" data-charbgfile hidden></label>
          <button class="pc-pill dashed tiny" data-act="charbg" data-w="cut">透明底</button>
          \${ui.charTestOrig ? '<button class="pc-pill dashed tiny" data-act="charbg" data-w="orig">原白底</button>' : ''}
        </div>\` : ''}
      </div>\` : ''}
      \${(c.photos || []).length ? \`<div class="pc-label pc-mt-s">相册（\${c.photos.length} 张）</div>
      <div class="pc-grid2 pc-mt-s">\${c.photos.map((ph, i) => { const u = ph.path.startsWith('data:') ? ph.path : '/' + ph.path.replace(/^\\/+/, ''); return \`<article class="pc-ticket" style="padding-bottom:6px">
        <div class="pc-ticket-img"><img src="\${esc(u)}" loading="lazy" alt="" data-act="viewimg" data-src="\${esc(u)}"></div>
        <div class="pc-actions wrap" style="padding:6px 6px 0"><button class="pc-pill tiny \${c.photo === ph.path ? 'on' : 'dashed'}" data-act="charphotoavatar" data-i="\${i}">\${c.photo === ph.path ? '当前头像' : '设头像'}</button><button class="pc-pill tiny dashed danger" data-act="charphotodel" data-i="\${i}">删</button></div>
      </article>\`; }).join('')}</div>\` : ''}
    </section>

    <section class="pc-card pc-pad pc-mt">
      <b>精确参考（长相 / 服装 / 画风）</b>`
    );

    // ── 5. 角色页「这次聊天」区新增：最近 40 楼读人 + 读前挑世界书开关
    patch(
        `      <div class="pc-actions wrap">
        \${chars.length ? \`<button class="pc-pill dashed tiny" data-act="addside">＋ 加配角</button>\` : ''}
        <button class="pc-pill dashed tiny" data-act="castpreview">看会发送的内容</button>
      </div>`,
        `      <div class="pc-actions wrap">
        \${chars.length ? \`<button class="pc-pill dashed tiny" data-act="addside">＋ 加配角</button>\` : ''}
        <button class="pc-pill dashed tiny" data-act="readchatcast" \${ui.charBusy ? 'disabled' : ''}>\${ui.charBusy === 'chatcast' ? '<span class="pc-busy">读取中</span>' : '从聊天正文读出人物（近 40 楼）'}</button>
        <button class="pc-pill dashed tiny" data-act="castpreview">看会发送的内容</button>
      </div>
      <label class="pc-switch pc-mt-s"><input type="checkbox" data-pickwi \${d.options.pickWi ? 'checked' : ''}><span></span>读卡 / 读人设前自己挑世界书条目<small>开启后，点「从角色卡读 / 从人设和世界书读」会先弹出世界书条目勾选框</small></label>`
    );

    // ── 6. 衣柜深化：多图批量导入 + 配饰搭配 + 卡片裁切/整张切换 + 展示图换模特
    patch(
        `<label class="pc-btn dark">\${IMG_ICON} 图片<input type="file" accept="image/*" data-wardimg hidden></label>
      <button class="pc-btn" data-act="wardai">✦ AI 设计</button>
      <button class="pc-btn" data-act="wardnew">＋ 自己写</button>`,
        `<label class="pc-btn dark">\${IMG_ICON} 图片（可多选）<input type="file" accept="image/*" multiple data-wardimg hidden></label>
      <button class="pc-btn" data-act="wardmix">✦ 配饰搭配</button>
      <button class="pc-btn" data-act="wardai">✦ AI 设计</button>
      <button class="pc-btn" data-act="wardnew">＋ 自己写</button>`
    );
    patch(
        `    <div class="pc-chips">\${[['all', '全部'], ...owners.map(c => [c.key, c.name]), ['none', '没给谁穿']].map(([k, t]) => \`<button class="pc-pill \${ui.wardFilter === k ? 'on' : 'dashed'}" data-act="wardfilter" data-v="\${esc(k)}">\${esc(t)}</button>\`).join('')}</div>
    <div class="pc-grid2 pc-mt-s">\${list.map(({ o, owner }) => \`<article class="pc-ticket" data-act="openoutfit" data-owner="\${esc(owner?.key || '')}" data-id="\${esc(o.id)}">
        <div class="pc-ticket-img">\${o.image ? \`<img src="\${esc(o.image.startsWith('data:') ? o.image : '/' + o.image.replace(/^\\/+/, ''))}" loading="lazy" alt="">\` : '<span>还没有图</span>'}</div>`,
        `    \${ui.wardBatch ? \`<div class="pc-card pc-pad pc-mt-s pc-row-between"><span class="pc-dim small">批量读图：\${ui.wardBatch.done} / \${ui.wardBatch.total} · 已存 \${ui.wardBatch.saved} 套</span><button class="pc-pill tiny danger" data-act="wardbatchstop">\${ui.wardBatch.stop ? '当前张完就停' : '停止'}</button></div>\` : ''}
    <div class="pc-row-between pc-mt-s">
      <div class="pc-chips" style="margin:0">\${[['all', '全部'], ...owners.map(c => [c.key, c.name]), ['none', '没给谁穿']].map(([k, t]) => \`<button class="pc-pill \${ui.wardFilter === k ? 'on' : 'dashed'}" data-act="wardfilter" data-v="\${esc(k)}">\${esc(t)}</button>\`).join('')}</div>
      <button class="pc-pill dashed tiny" data-act="wardfit">\${d.options.wardFit === 'contain' ? '展示整张' : '裁成一样高'}</button>
    </div>
    <div class="pc-grid2 pc-mt-s">\${list.map(({ o, owner }) => \`<article class="pc-ticket" data-act="openoutfit" data-owner="\${esc(owner?.key || '')}" data-id="\${esc(o.id)}">
        <div class="pc-ticket-img" \${d.options.wardFit === 'contain' ? 'style="aspect-ratio:auto;min-height:120px"' : ''}>\${o.image ? \`<img src="\${esc(o.image.startsWith('data:') ? o.image : '/' + o.image.replace(/^\\/+/, ''))}" loading="lazy" alt="" style="\${d.options.wardFit === 'contain' ? 'height:auto;object-fit:contain' : 'object-position:top'}">\` : '<span>还没有图</span>'}</div>`
    );
    patch(
        `    <button class="pc-btn pc-mt-s wide" data-act="outimggen" \${u.busy ? 'disabled' : ''}>\${u.busy === 'gen' ? '<span class="pc-busy">生成中</span>' : u.draft ? '先生成一张看看' : '生成展示图'}</button>`,
        `    <label class="pc-field pc-mt-s"><span>展示图模特</span><select class="pc-input" data-outfitmodel>
      <option value="owner" \${(d.options.outfitModel || 'owner') === 'owner' ? 'selected' : ''}>跟穿的人一样</option>
      <option value="female" \${d.options.outfitModel === 'female' ? 'selected' : ''}>通用女模特</option>
      <option value="male" \${d.options.outfitModel === 'male' ? 'selected' : ''}>通用男模特</option>
      \${people.map(c => \`<option value="\${esc(c.key)}" \${d.options.outfitModel === c.key ? 'selected' : ''}>指定角色：\${esc(c.name)}</option>\`).join('')}
    </select></label>
    <button class="pc-btn pc-mt-s wide" data-act="outimggen" \${u.busy ? 'disabled' : ''}>\${u.busy === 'gen' ? '<span class="pc-busy">生成中</span>' : u.draft ? '先生成一张看看' : '生成展示图'}</button>`
    );

    // ── 7. 展示图生成改用选定模特 + lookTags；readcard 走 descOfFull；新增所有新 action 处理器
    patch(
        `            const owner = ui.outfit.draft ? C.getChar(ui.outfit.dest) : C.findOutfit(ui.outfit.owner, ui.outfit.id)?.owner;
            ui.outfit.busy = 'gen'; render();
            try {
                const pos = M.mergeTags(d.active ? M.ticketString(d, d.active) : '', owner ? C.tagText(owner.appearance) : '1boy, solo, male focus, adult', C.tagText(o.tags), 'solo, full body, standing, looking at viewer, simple background, white background');`,
        `            const owner0 = ui.outfit.draft ? C.getChar(ui.outfit.dest) : C.findOutfit(ui.outfit.owner, ui.outfit.id)?.owner;
            const mk = d.options.outfitModel || 'owner';
            const owner = mk === 'owner' ? owner0 : (mk === 'female' || mk === 'male') ? null : C.getChar(mk);
            const modelLook = mk === 'female' ? '1girl, solo, adult' : mk === 'male' ? '1boy, solo, male focus, adult' : (owner ? C.lookTags(owner) : '1girl, solo, adult');
            ui.outfit.busy = 'gen'; render();
            try {
                const pos = M.mergeTags(d.active ? M.ticketString(d, d.active) : '', modelLook, C.tagText(o.tags), 'solo, full body, standing, looking at viewer, simple background, white background');`
    );
    patch(
        `        case 'readcard': {
            const desc = C.descOf(c);
            if (!desc.trim()) { toastr.warning('这张卡 / 人设里没有描述', '角色'); return true; }
            if (c.appearance.length && !(await confirmBox('用读到的外貌替换现在的？', { ok: '替换', cancel: '算了' }))) return true;
            ui.charBusy = 'read'; render();
            try {
                const r = await T.extractAppearance(c.name, desc);
                c.appearance = r.appearance;
                if (r.outfit.length && !c.outfits.length) { const o = { id: M.uid('o_'), name: '默认', tags: r.outfit }; c.outfits.push(o); c.outfitId = o.id; }
                toastr.success(\`读到 \${r.appearance.length} 个外貌标签\${r.outfit.length ? \`，\${r.outfit.length} 个衣服标签（存在「默认」这套里）\` : ''}\`, '角色');
            } catch (e) { toastr.error(e.message, '读取失败'); }
            ui.charBusy = ''; save();
            return true;
        }`,
        `        case 'readcard': {
            if (c.appearance.length && !(await confirmBox('用读到的外貌替换现在的？', { ok: '替换', cancel: '算了' }))) return true;
            ui.charBusy = 'read'; render();
            try {
                const desc = await C.descOfFull(c, { choose: d.options.pickWi ? pickWiEntries : null }).catch(e => { if (e?.name === 'AbortError') return null; throw e; });
                if (desc === null) { ui.charBusy = ''; render(); return true; }
                if (!desc.trim()) { toastr.warning('这张卡 / 人设和世界书里没有描述', '角色'); ui.charBusy = ''; render(); return true; }
                const r = await T.extractAppearance(c.name, desc);
                c.appearance = r.appearance;
                if (r.outfit.length && !c.outfits.length) { const o = { id: M.uid('o_'), name: c.name + '的衣服', tags: r.outfit }; c.outfits.push(o); c.outfitId = o.id; }
                toastr.success(\`读到 \${r.appearance.length} 个外貌标签\${r.outfit.length ? \`，\${r.outfit.length} 个衣服标签\` : ''}\`, '角色');
            } catch (e) { toastr.error(e.message, '读取失败'); }
            ui.charBusy = ''; save();
            return true;
        }
        case 'readchatcast': {
            if (ui.charBusy) return true;
            const excerpt = buildChatCastExcerpt(ctx()?.chat || [], 40);
            if (!excerpt.trim()) { toastr.warning('最近聊天里还没有正文内容', '角色'); return true; }
            ui.charBusy = 'chatcast'; render();
            try {
                const cardAvatar = ctx()?.characters?.[ctx()?.characterId]?.avatar || '';
                const res = await T.extractCastFromText(ctx()?.characters?.[ctx()?.characterId]?.name || '当前聊天', '最近 40 楼聊天正文', excerpt, true);
                const people = res?.people || [];
                let added = 0, updated = 0;
                for (const p of people) {
                    const exist = Object.values(d.characters || {}).find(x => x.name === p.name || (x.aliases || []).includes(p.name));
                    if (exist) {
                        const al = new Set([...(exist.aliases || []), ...(p.aliases || [])].filter(a => a && a !== exist.name));
                        exist.aliases = [...al];
                        if (!exist.appearance?.length && p.appearance?.length) exist.appearance = p.appearance;
                        if (!exist.nsfwBody && p.nsfw?.length) exist.nsfwBody = C.tagText(p.nsfw);
                        if (!exist.canonTag && p.canon) { exist.canonTag = p.canon; exist.canonOn = true; }
                        C.saveChar(exist);
                        updated++;
                    } else if (p.appearance?.length) {
                        const ch = cardAvatar ? C.addSideKick(cardAvatar, p.name) : (() => { const key = 'free:' + M.uid(''); const item = { key, kind: 'free', name: p.name, avatar: '', card: '', appearance: [], aliases: [], nl: '', nsfwBody: '', canonOn: false, canonTag: '', canonKeepLook: false, photos: [], outfitMode: 'story', outfits: [], outfitId: '', negative: '', charRef: '' }; d.characters[key] = item; return item; })();
                        ch.aliases = (p.aliases || []).filter(a => a && a !== ch.name);
                        ch.appearance = p.appearance;
                        if (p.nsfw?.length) ch.nsfwBody = C.tagText(p.nsfw);
                        if (p.canon) { ch.canonTag = p.canon; ch.canonOn = true; }
                        if (p.outfit?.length) { const o = { id: M.uid('o_'), name: p.name + '的衣服', tags: p.outfit }; ch.outfits.push(o); ch.outfitId = o.id; }
                        C.saveChar(ch);
                        added++;
                    }
                }
                toastr.success(people.length ? \`从正文读到 \${people.length} 人：新增 \${added} 位，补充 \${updated} 位\` : '正文里没提取到明确外貌的人物', '角色', { timeOut: 4000 });
            } catch (e) { toastr.error(e.message, '读取失败', { timeOut: 7000 }); }
            ui.charBusy = ''; render();
            return true;
        }
        case 'transpairs': {
            if (ui.charBusy || !c) return true;
            const targets = [...(c.appearance || []), ...(c.outfits || []).flatMap(o => o.tags || [])].filter(t => t?.en && !String(t.zh || '').trim());
            if (!targets.length) return true;
            ui.charBusy = 'trans'; render();
            try {
                const map = await T.translatePairLabels(targets.map(t => t.en));
                let n = 0;
                for (const t of targets) { const zh = map[t.en.trim().toLowerCase()]; if (zh) { t.zh = zh; n++; } }
                C.saveChar(c);
                toastr.success(\`补齐了 \${n} 个中文翻译\`, '角色', { timeOut: 2000 });
            } catch (e) { toastr.error(e.message, '翻译失败'); }
            ui.charBusy = ''; render();
            return true;
        }
        case 'canonai': {
            if (ui.charBusy || !c) return true;
            ui.charBusy = 'canon'; render();
            try {
                const desc = C.descOf(c) || C.tagText(c.appearance);
                const r = await T.identifyCanon(c.name, (c.aliases || []).join('|'), desc);
                if (r.canon) { c.canonTag = r.canon; c.canonOn = true; C.saveChar(c); toastr.success('识别为：' + r.canon, '同人角色'); }
                else toastr.info(r.reason || '未识别到明确的原作同人标签', '同人角色');
            } catch (e) { toastr.error(e.message, '识别失败'); }
            ui.charBusy = ''; render();
            return true;
        }
        case 'chartestopt': {
            if (el.dataset.k === 'rating') ui.charTestRating = el.dataset.v;
            if (el.dataset.k === 'shot') ui.charTestShot = el.dataset.v;
            if (el.dataset.k === 'bg') ui.charTestBg = el.dataset.v;
            render(); return true;
        }
        case 'chartest': {
            if (ui.charBusy || !c) return true;
            if (!N.isReady()) { toastr.warning('先到设置里填 NovelAI key', '角色'); return true; }
            const nsfw = ui.charTestRating === 'nsfw';
            const shot = ui.charTestShot || 'upper';
            const white = (ui.charTestBg || 'white') === 'white';
            const framing = charTestFraming(shot);
            const o = C.currentOutfit(c);
            const look = C.lookTags(c);
            const extra = String(ui.charTestExtra || '').trim();
            const bgTags = white ? 'simple background, white background' : '';
            const nsfwTags = nsfw ? ['nsfw, adult', c.nsfwBody || ''].filter(Boolean).join(', ') : '';
            const outfitTags = nsfw && isNudePrompt(extra) ? '' : C.tagText(o?.tags);
            const rawPos = M.mergeTags(d.active ? M.ticketString(d, d.active) : '', look, nsfwTags, outfitTags, framing.shotTags, extra, bgTags);
            const pos = filterCharTestTags(rawPos, shot);
            ui.charBusy = 'test'; render();
            try {
                const { positive, negative } = E.composeStudio({ pos, neg: c.negative || '' });
                const img = await E.generateFull({ positive, negative, width: framing.width, height: framing.height, director: c.charRef ? await E.charRefs([c.charRef]) : undefined });
                let cut = null;
                if (white) { try { cut = await cutWhiteBg(img); } catch {} }
                ui.charTestKey = c.key;
                ui.charTestNsfw = nsfw;
                ui.charTestOrig = white ? img : null;
                ui.charTestCut = cut;
                ui.charTestImg = cut || img;
            } catch (e) { toastr.error(e.message, '生成失败'); }
            ui.charBusy = ''; render();
            return true;
        }
        case 'charbg': {
            if (ui.charBusy || !ui.charTestImg) return true;
            const w = el.dataset.w;
            if (w === 'orig' && ui.charTestOrig) { ui.charTestImg = ui.charTestOrig; render(); return true; }
            if (w === 'cut' && ui.charTestCut) { ui.charTestImg = ui.charTestCut; render(); return true; }
            if (w === 'gen' && ui.charTestCut) {
                if (!N.isReady()) { toastr.warning('先到设置里填 NovelAI key', '角色'); return true; }
                ui.charBusy = 'bg'; render();
                try {
                    const im = await zkLoadImg(ui.charTestCut);
                    const artist = d.active ? M.ticketString(d, d.active) : '';
                    const { positive, negative } = E.composeStudio({ pos: M.mergeTags(artist, 'no humans, scenery', String(ui.charBgQ || '').trim() || 'indoors') });
                    const bg = await E.generateFull({ positive, negative, width: im.naturalWidth || 832, height: im.naturalHeight || 1024, director: null });
                    ui.charTestImg = await putOnBg(ui.charTestCut, bg);
                } catch (e) { toastr.error(e.message, '换背景失败'); }
                ui.charBusy = ''; render();
            }
            return true;
        }
        case 'charkeep': {
            if (!c || !ui.charTestImg || ui.charTestKey !== c.key || ui.charBusy) return true;
            const mode = el.dataset.w;
            ui.charBusy = 'save'; render();
            try {
                const img = mode === 'ref' ? await fitCharRef(ui.charTestImg) : ui.charTestImg;
                const { path } = await uploadImage(img, \`\${mode === 'ref' ? 'charref' : 'charphoto'}_\${M.uid('')}\`);
                if (mode === 'ref') {
                    const ref = { id: M.uid('cr_'), path, type: 'character', strength: 0.6 };
                    const grp = c.charRef && d.charRefGroups?.[c.charRef];
                    if (grp) (grp.refs ||= []).push(ref);
                    else { const id = M.uid('r_'); (d.charRefGroups ||= {})[id] = { id, name: c.name.slice(0, 20), refs: [ref] }; c.charRef = id; }
                } else {
                    (c.photos ||= []).unshift({ path, nsfw: !!ui.charTestNsfw, at: Date.now() });
                    if (mode === 'avatar') c.photo = path;
                }
                C.saveChar(c);
                toastr.success(mode === 'ref' ? '已加进精确参考图' : mode === 'avatar' ? '已设为头像并存入相册' : '已存进相册', '角色');
            } catch (e) { toastr.error(e.message, '保存失败'); }
            ui.charBusy = ''; render();
            return true;
        }
        case 'charphotoavatar': {
            const ph = c?.photos?.[Number(el.dataset.i)];
            if (ph) { c.photo = ph.path; C.saveChar(c); render(); toastr.success('已设为头像', '角色', { timeOut: 1600 }); }
            return true;
        }
        case 'charphotodel': {
            const i = Number(el.dataset.i), ph = c?.photos?.[i];
            if (!ph || !(await confirmBox('从相册删掉这张？'))) return true;
            c.photos.splice(i, 1);
            if (c.photo === ph.path) delete c.photo;
            C.saveChar(c); render();
            return true;
        }
        case 'wardmix': openAccessoryMix(); return true;
        case 'wardfit': d.options.wardFit = d.options.wardFit === 'contain' ? 'cover' : 'contain'; commit(); render(); return true;
        case 'wardbatchstop': if (ui.wardBatch) { ui.wardBatch.stop = true; render(); } return true;`
    );

    // ── 8. 输入与变更事件：同人角色字段、pickwi、outfitModel、换背景选图、衣柜多图批量导入
    patch(
        `    if (el.dataset.charnsfwbody !== undefined) { const c = C.getChar(ui.charKey); if (c) { c.nsfwBody = el.value.trim(); C.saveChar(c); } return; }`,
        `    if (el.dataset.charnsfwbody !== undefined) { const c = C.getChar(ui.charKey); if (c) { c.nsfwBody = el.value.trim(); C.saveChar(c); } return; }
    if (el.dataset.charcanonTag !== undefined) { const c = C.getChar(ui.charKey); if (c) { c.canonTag = el.value.trim(); C.saveChar(c); } return; }`
    );
    patch(
        `    if (el.dataset.cast) { C.setCastOn(el.dataset.cast, el.checked); render(); return; }`,
        `    if (el.dataset.cast) { C.setCastOn(el.dataset.cast, el.checked); render(); return; }
    if (el.dataset.pickwi !== undefined) { d.options.pickWi = el.checked; commit({ silent: true }); return; }
    if (el.dataset.outfitmodel !== undefined) { d.options.outfitModel = el.value; commit({ silent: true }); return; }
    if (el.dataset.charcanonOn !== undefined) { const c = C.getChar(ui.charKey); if (c) { c.canonOn = el.checked; C.saveChar(c); render(); } return; }
    if (el.dataset.charcanonKeep !== undefined) { const c = C.getChar(ui.charKey); if (c) { c.canonKeepLook = el.checked; C.saveChar(c); } return; }
    if (el.dataset.charbgfile !== undefined) {
        const f = el.files?.[0]; el.value = '';
        if (f && ui.charTestCut) {
            ui.charBusy = 'bg'; render();
            try { ui.charTestImg = await putOnBg(ui.charTestCut, await shrinkDataUrl(await fileToDataUrl(f), 2048, 0.92)); }
            catch (e) { toastr.error(e.message, '换背景失败'); }
            ui.charBusy = ''; render();
        }
        return;
    }
    if (el.dataset.wardimg !== undefined && el.files?.length > 1) {
        const files = [...el.files]; el.value = '';
        if (ui.wardBatch) { toastr.info('上一批还在导入', '衣柜'); return; }
        const b = ui.wardBatch = { total: files.length, done: 0, saved: 0, fail: 0, stop: false };
        render();
        try {
            for (const f of files) {
                if (b.stop) break;
                let tags = [], name = f.name.replace(/\\.[^.]+$/, '').slice(0, 20), image = '';
                try {
                    const du = await shrinkDataUrl(await fileToDataUrl(f), 1024, 0.88);
                    try { const r = await T.outfitFromImage(du); tags = Array.isArray(r.tags) ? r.tags : []; if (r.name) name = String(r.name).slice(0, 20); } catch {}
                    try { image = (await uploadImage(await shrinkDataUrl(du, 768), 'outfit_' + M.uid(''))).path || ''; } catch {}
                } catch {}
                if (tags.length || image) {
                    const o = { id: M.uid('o_'), name: name || '导入的衣服', tags, ...(image ? { image } : {}) };
                    (d.outfits ||= {})[o.id] = o;
                    b.saved++; if (!tags.length) b.fail++;
                    commit({ silent: true });
                }
                b.done++; render();
            }
            commit();
            toastr[b.fail ? 'warning' : 'success'](\`批量导入完成：存下 \${b.saved} 套\${b.fail ? \`（\${b.fail} 套未识别出标签）\` : ''}\`, '衣柜', { timeOut: 4000 });
        } finally { if (ui.wardBatch === b) ui.wardBatch = null; render(); }
        return;
    }`
    );

    return s;
}
