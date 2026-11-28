import assert from 'node:assert/strict';

/**
 * v1.0.0 第一批上游高价值移植：
 * 1) 流式返回/多图 ZIP 按尺寸挑最终图，仅收到预览图时报错重试（防噪点）
 * 2) mergeTags 整组权重原样保留，避免大权重拆散（防噪点）
 * 3) 画师串 / 单个画师独立出图参数（模型/采样器/噪声表/步数/CFG/Rescale）
 * 4) V5 直接看中文（生图页正面/固定提示词免强转英文标签）
 * 5) 改楼层防滚动回底
 * 6) 画师库日常体验：切串搜索、分页防卡、多选局部刷新与选没例图、7 天回收站与 9 秒撤销删除
 */
export function applyV1Upgrades(s) {
    const patch = (a, b) => {
        assert.equal(s.split(a).length, 2, 'applyV1Upgrades anchor mismatch: ' + a.slice(0, 90));
        s = s.replace(a, () => b);
    };

    // ── 1. 防噪点：权重组原样保留（tokenize 记录 grp + mergeTags 整组输出）
    patch(
`    while ((m = re.exec(src))) {
        pushPlain(src.slice(last, m.index));
        pushPlain(m[2], Number(m[1]));
        last = re.lastIndex;
    }`,
`    let gid = 0;
    while ((m = re.exec(src))) {
        pushPlain(src.slice(last, m.index));
        const before = tokens.length;
        pushPlain(m[2], Number(m[1]));
        const grp = { id: ++gid, raw: m[0], n: tokens.length - before };
        for (let i = before; i < tokens.length; i++) Object.defineProperty(tokens[i], 'grp', { value: grp, enumerable: false });
        last = re.lastIndex;
    }`
    );
    patch(
`function mergeTags(...texts) {
    const seen = new Set();
    const out = [];
    for (const t of tokenize(texts.filter(Boolean).join(', '))) {
        const k = tokKey(t);
        if (seen.has(k)) continue;
        seen.add(k);
        out.push(tokenToText(t));
    }
    return out.join(', ');
}`,
`function mergeTags(...texts) {
    const seen = new Set();
    const out = [];
    const toks = tokenize(texts.filter(Boolean).join(', '));
    for (let i = 0; i < toks.length; i++) {
        const t = toks[i];
        if (t.grp && t.grp.n > 1) {
            const members = toks.slice(i, i + t.grp.n).filter(x => x.grp === t.grp);
            const keys = members.map(tokKey);
            if (members.length === t.grp.n && keys.every(k => !seen.has(k))) {
                keys.forEach(k => seen.add(k));
                out.push(guardWeightSpacing(t.grp.raw.trim()));
                i += members.length - 1;
                continue;
            }
        }
        const k = tokKey(t);
        if (seen.has(k)) continue;
        seen.add(k);
        out.push(tokenToText(t));
    }
    return out.join(', ');
}`
    );

    // ── 2. 防噪点：流式返回 / 多图 ZIP 按像素尺寸挑最终图，预览图触发重试
    patch(
        `    return { image: await imageFromResponse(buf), sent };`,
        `    return { image: await imageFromResponse(buf, { w: params.width, h: params.height }), sent };`
    );
    patch(
`async function imageFromResponse(u8) {
    const isZip = u8[0] === 0x50 && u8[1] === 0x4b;
    const isPng = u8[0] === 0x89 && u8[1] === 0x50;
    if (isPng) return 'data:image/png;base64,' + toB64(u8);
    if (!isZip) {
        const t = new TextDecoder().decode(u8.slice(0, 2000)).trim();
        if (t.startsWith('{')) { try { const j = JSON.parse(t); if (j.images?.[0]) return toDataUrl(j.images[0]); throw new Error(j.message || j.error || t.slice(0, 150)); } catch (e) { throw e; } }
        if (t.startsWith('iVBOR')) return toDataUrl(t);
        if (/^<|<html/i.test(t)) throw new Error('站点返回的是网页，不是图片。检查一下地址对不对');
        throw new Error('返回的不是图片：' + t.slice(0, 120));
    }
    const file = await unzipFirstImage(u8);
    return 'data:image/png;base64,' + toB64(file);
}`,
`async function imageFromResponse(u8, want = null) {
    const isZip = u8[0] === 0x50 && u8[1] === 0x4b;
    const isPng = u8[0] === 0x89 && u8[1] === 0x50;
    if (isPng) {
        const frames = extractPngFrames(u8);
        const picked = pickFinalImageFrame(frames.length ? frames : [u8], want);
        return 'data:image/png;base64,' + toB64(picked);
    }
    if (!isZip) {
        const frames = extractPngFrames(u8);
        if (frames.length) {
            const picked = pickFinalImageFrame(frames, want);
            return 'data:image/png;base64,' + toB64(picked);
        }
        const t = new TextDecoder().decode(u8.slice(0, 2000)).trim();
        if (t.startsWith('{')) {
            const j = JSON.parse(t);
            if (Array.isArray(j.images) && j.images.length) return toDataUrl(j.images[j.images.length - 1]);
            if (j.image) return toDataUrl(j.image);
            throw new Error(j.message || j.error || t.slice(0, 150));
        }
        if (t.startsWith('iVBOR')) return toDataUrl(t);
        if (/^<|<html/i.test(t)) throw new Error('站点返回的是网页，不是图片。检查一下地址对不对');
        throw new Error('返回的不是图片：' + t.slice(0, 120));
    }
    const files = await unzipAllImages(u8);
    const picked = pickFinalImageFrame(files, want);
    return 'data:image/png;base64,' + toB64(picked);
}`
    );
    patch(
`async function unzipFirstImage(u8) {
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
        if (!/\\.(png|jpe?g|webp)$/.test(name)) continue;
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
}`,
`async function unzipAllImages(u8) {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    let eocd = -1;
    for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new Error('图片压缩包坏了');
    const count = dv.getUint16(eocd + 10, true);
    let p = dv.getUint32(eocd + 16, true);
    const outList = [];
    for (let n = 0; n < count; n++) {
        if (dv.getUint32(p, true) !== 0x02014b50) break;
        const method = dv.getUint16(p + 10, true);
        const csize = dv.getUint32(p + 20, true);
        const nameLen = dv.getUint16(p + 28, true), extraLen = dv.getUint16(p + 30, true), commentLen = dv.getUint16(p + 32, true);
        const local = dv.getUint32(p + 42, true);
        const name = new TextDecoder().decode(u8.subarray(p + 46, p + 46 + nameLen)).toLowerCase();
        p += 46 + nameLen + extraLen + commentLen;
        if (!/\\.(png|jpe?g|webp)$/.test(name)) continue;
        const lName = dv.getUint16(local + 26, true), lExtra = dv.getUint16(local + 28, true);
        const start = local + 30 + lName + lExtra;
        const data = u8.subarray(start, start + csize);
        if (method === 0) outList.push(data);
        else if (method === 8) {
            const ds = new DecompressionStream('deflate-raw');
            const out = await new Response(new Blob([data]).stream().pipeThrough(ds)).arrayBuffer();
            outList.push(new Uint8Array(out));
        } else {
            throw new Error('不认识的压缩方式 ' + method);
        }
    }
    if (!outList.length) throw new Error('压缩包里没有图片');
    return outList;
}
async function unzipFirstImage(u8) {
    return pickFinalImageFrame(await unzipAllImages(u8));
}`
    );

    // ── 3. 画师串 / 单个画师独立出图参数
    patch(
`function buildParameters({ positive, negative, width, height, seed, chars = [], refs = null, director = null }) {
    positive = guardWeightSpacing(positive);
    negative = guardWeightSpacing(negative);
    chars = (chars || []).map(c => ({ ...c, prompt: guardWeightSpacing(c.prompt), uc: guardWeightSpacing(c.uc || '') }));
    const s = settings();`,
`function pcWithTicketParams(baseSettings, positive) {
    try {
        const it = findTicketParamsFor(__mod_store.getData(), positive, __mod_model);
        return it ? applyItemParams(baseSettings, it) : baseSettings;
    } catch { return baseSettings; }
}
function buildParameters({ positive, negative, width, height, seed, chars = [], refs = null, director = null }) {
    const rawPos = positive;
    positive = guardWeightSpacing(positive);
    negative = guardWeightSpacing(negative);
    chars = (chars || []).map(c => ({ ...c, prompt: guardWeightSpacing(c.prompt), uc: guardWeightSpacing(c.uc || '') }));
    const s = pcWithTicketParams(settings(), rawPos);`
    );
    patch(
`async function generateRequest(opts) {
    const s = settings();
    const model = s.novelaimode;`,
`async function generateRequest(opts) {
    const s = pcWithTicketParams(settings(), opts?.positive);
    const model = s.novelaimode;`
    );
    // 详情页 UI：画师组 & 单个画师「出图参数」折叠卡
    patch(
`function viewArtist(d) {`,
`function pcParamCard(ref, it) {
    const s = N.settings(), at = \`data-tparam="\${ref.type}:\${ref.id}"\`, v = k => esc(String(it[k] ?? ''));
    const nameOf = (list, x) => (list.find(m => m[0] === x) || [x, x])[1];
    const set = [
        it.model && nameOf(N.MODELS, it.model),
        it.sampler && nameOf(N.SAMPLERS, it.sampler),
        String(it.steps ?? '').trim() && it.steps + ' 步',
        String(it.cfg ?? '').trim() && 'CFG ' + it.cfg,
        String(it.rescale ?? '').trim() && 'Rescale ' + it.rescale,
        it.schedule,
    ].filter(Boolean);
    return \`<section class="pc-card pc-pad pc-mt"><details class="pc-fold" \${set.length ? 'open' : ''}><summary><b>出图参数</b><i>\${esc(set.length ? set.join(' · ') : '跟设置走')}</i></summary><div class="pc-fold-in">
      <div class="pc-hint" style="margin-top:0">用这串出图时自动套用这些参数（正文插图、例图、生图页都算），不改全局设置。留空则跟全局设置走。</div>
      <label class="pc-field pc-mt-s"><span>模型</span><select class="pc-input" \${at} data-field="model"><option value="">跟设置（\${esc(nameOf(N.MODELS, s.novelaimode))}）</option>\${N.MODELS.map(([m, t]) => \`<option value="\${m}" \${it.model === m ? 'selected' : ''}>\${esc(t)}</option>\`).join('')}</select></label>
      <div class="pc-grid2 pc-mt-s" style="gap:8px">
        <label class="pc-field"><span>采样器</span><select class="pc-input" \${at} data-field="sampler"><option value="">跟设置（\${esc(nameOf(N.SAMPLERS, s.novelai_sampler))}）</option>\${N.SAMPLERS.map(([m, t]) => \`<option value="\${m}" \${it.sampler === m ? 'selected' : ''}>\${esc(t)}</option>\`).join('')}</select></label>
        <label class="pc-field"><span>噪声表</span><select class="pc-input" \${at} data-field="schedule"><option value="">跟设置（\${esc(s.Schedule || 'karras')}）</option>\${N.SCHEDULES.map(([m, t]) => \`<option value="\${m}" \${it.schedule === m ? 'selected' : ''}>\${esc(t)}</option>\`).join('')}</select></label>
        <label class="pc-field"><span>步数</span><input class="pc-input" type="number" min="1" max="50" \${at} data-field="steps" value="\${v('steps')}" placeholder="\${esc(String(s.novelai_steps))}"></label>
        <label class="pc-field"><span>CFG</span><input class="pc-input" type="number" min="0" max="30" step="0.1" \${at} data-field="cfg" value="\${v('cfg')}" placeholder="\${esc(String(s.nai3Scale))}"></label>
        <label class="pc-field"><span>Rescale</span><input class="pc-input" type="number" min="0" max="1" step="0.02" \${at} data-field="rescale" value="\${v('rescale')}" placeholder="\${esc(String(s.cfg_rescale))}"></label>
      </div>
      <div class="pc-actions wrap pc-mt-s"><button class="pc-pill dashed tiny" data-act="tparamnow" data-tp="\${ref.type}:\${ref.id}">填入当前设置</button>\${set.length ? \`<button class="pc-pill dashed tiny" data-act="tparamclear" data-tp="\${ref.type}:\${ref.id}">全部清空</button>\` : ''}</div>
    </div></details></section>\`;
}
function viewArtist(d) {`
    );
    patch(
`      <textarea class="pc-textarea small" data-bind-artist="\${a.id}" placeholder="适合什么题材、权重心得…">\${esc(a.note)}</textarea>
    </section>`,
`      <textarea class="pc-textarea small" data-bind-artist="\${a.id}" placeholder="适合什么题材、权重心得…">\${esc(a.note)}</textarea>
    </section>
    \${pcParamCard(ref, a)}`
    );
    patch(
`      <textarea class="pc-textarea small" data-bind-group="\${g.id}" data-field="note" placeholder="适合什么题材、配哪个氛围…">\${esc(g.note)}</textarea>
    </section>`,
`      <textarea class="pc-textarea small" data-bind-group="\${g.id}" data-field="note" placeholder="适合什么题材、配哪个氛围…">\${esc(g.note)}</textarea>
    </section>
    \${pcParamCard(ref, g)}`
    );
    patch(
`    if (el.dataset.bindGroup) { d.groups[el.dataset.bindGroup][el.dataset.field] = el.value; commit({ silent: true }); return; }`,
`    if (el.dataset.tparam) {
        const [t, id] = el.dataset.tparam.split(':'), it = (t === 'group' ? d.groups : d.artists)[id], k = el.dataset.field;
        if (it && k) { const val = String(el.value ?? '').trim(); if (val === '') delete it[k]; else it[k] = val; commit({ silent: el.tagName !== 'SELECT' }); }
        return;
    }
    if (el.dataset.bindGroup) { d.groups[el.dataset.bindGroup][el.dataset.field] = el.value; commit({ silent: true }); return; }`
    );
    patch(
`    if (el.dataset.bindGroup || el.dataset.bindArtist) { commit(); return; }`,
`    if (el.dataset.bindGroup || el.dataset.bindArtist || el.dataset.tparam) { commit(); return; }`
    );
    patch(
`            case 'refreshquota': void refreshQuota(true); break;`,
`            case 'refreshquota': void refreshQuota(true); break;
            case 'tparamnow': case 'tparamclear': {
                const [t, id] = String(el.dataset.tp || '').split(':'), it = (t === 'group' ? d.groups : d.artists)[id];
                if (!it) break;
                if (act === 'tparamclear') {
                    for (const k of [...TICKET_PARAM_KEYS, 'model']) delete it[k];
                    commit(); toastr.info('已清空，这串出图跟设置走', '智库', { timeOut: 2000 });
                    break;
                }
                const s = N.settings();
                const put = (k, val) => { if (val != null && String(val).trim() !== '') it[k] = String(val); };
                if (s.novelaimode && N.MODELS.some(m => m[0] === s.novelaimode)) it.model = s.novelaimode;
                if (N.SAMPLERS.some(m => m[0] === s.novelai_sampler)) put('sampler', s.novelai_sampler);
                if (N.SCHEDULES.some(m => m[0] === s.Schedule)) put('schedule', s.Schedule);
                put('steps', s.novelai_steps); put('cfg', s.nai3Scale); if (s.cfg_rescale != null) put('rescale', s.cfg_rescale);
                commit(); toastr.success('已填入当前设置，可以继续微调', '智库', { timeOut: 2000 });
                break;
            }`
    );

    // ── 4. V5 直接看中文（生图页正面 / 固定提示词）
    patch(
        `function sceneZh() { return T.hasChinese(ui.studio.scene || ''); }`,
        `function pcV5Zh() { try { const n = N.settings(); return String(n.novelaimode || '').includes('nai-diffusion-5') && String(n.v5Chinese) !== 'false'; } catch { return false; } }\nfunction sceneZh() { return !pcV5Zh() && T.hasChinese(ui.studio.scene || ''); }`
    );
    patch(
        `    if (T.hasChinese(st.pos.replace(/（[^（）]*）/g, ''))) {`,
        `    if (!pcV5Zh() && T.hasChinese(st.pos.replace(/（[^（）]*）/g, ''))) {`
    );
    patch(
        `      <label class="pc-switch"><input type="checkbox" data-scene-on \${st.sceneOn !== false ? 'checked' : ''}><span></span>每次生成都带上`,
        `      \${String(N.settings().novelaimode || '').includes('nai-diffusion-5') ? \`<label class="pc-switch"><input type="checkbox" data-st-check="v5Chinese" \${String(N.settings().v5Chinese) !== 'false' ? 'checked' : ''}><span></span>V5 直接看中文<small>V5 能直接理解中文，正面和固定提示词里的中文原样发过去，不再调用翻译 AI；关掉就照旧先转成英文标签</small></label>\` : ''}\n      <label class="pc-switch"><input type="checkbox" data-scene-on \${st.sceneOn !== false ? 'checked' : ''}><span></span>每次生成都带上`
    );
    patch(
        `    if (el.dataset.stCheck) {\n        N.settings()[el.dataset.stCheck] = el.checked ? 'true' : 'false';\n        N.save();\n        return;\n    }`,
        `    if (el.dataset.stCheck) {\n        N.settings()[el.dataset.stCheck] = el.checked ? 'true' : 'false';\n        N.save();\n        if (el.dataset.stCheck === 'v5Chinese') render();\n        return;\n    }`
    );

    // ── 5. 改楼层防滚动跳底（补齐 insertIntoLastMessage 中的 updateMessageBlock）
    s = s.replace(/\bc\.updateMessageBlock\(/g, '(guardChatScroll(DOC), c).updateMessageBlock(');

    // ── 6A. 切换画师串搜索（openSwitcher）
    patch(
`    const charName = E.currentCharacterName();
    const draw = () => {
        let refs = [];`,
`    const charName = E.currentCharacterName();
    let query = '';
    const refsNow = () => {
        const q = query.trim().toLowerCase();
        if (q) {
            const all = [
                ...Object.values(d.groups).sort((a, b) => (b.usedAt || b.createdAt || 0) - (a.usedAt || a.createdAt || 0)).map(g => ({ type: 'group', id: g.id })),
                ...Object.values(d.artists).map(a => ({ type: 'artist', id: a.id })),
            ];
            return all.filter(r => {
                try { return (M.ticketName(d, r) + '\\n' + M.ticketString(d, r)).toLowerCase().replace(/_/g, ' ').includes(q.replace(/_/g, ' ')); }
                catch { return false; }
            }).slice(0, 200);
        }
        let refs = [];`
    );
    patch(
`        else refs = Object.values(d.groups).filter(g => g.collections.includes(sheetFilter)).map(g => ({ type: 'group', id: g.id }));
        const bound = E.boundTicketForCurrent();`,
`        else refs = Object.values(d.groups).filter(g => g.collections.includes(sheetFilter)).map(g => ({ type: 'group', id: g.id }));
        return refs;
    };
    const listHtml = refs => \`<div class="pc-hscroll">\${refs.map(r => { const c = M.ticketCover(d, r); return \`<button class="pc-mini-stub \${M.sameRef(r, picked) ? 'picked' : ''} \${M.sameRef(r, d.active) ? 'active' : ''}" data-s="pick" \${refAttr(r)}>
              <span class="pc-mini-img">\${c ? \`<img src="\${esc(imgUrl(c))}" alt="">\` : ''}</span>
              <b>\${esc(M.ticketName(d, r))}</b><small>\${r.type === 'group' ? \`\${d.groups[r.id].members.length} 位画师\` : '单个画师'}</small></button>\`; }).join('') || \`<div class="pc-dim">\${query.trim() ? '没搜到，换个词试试' : '这里还没有画师串'}</div>\`}</div>\`;
    const draw = () => {
        const refs = refsNow();
        const bound = E.boundTicketForCurrent();`
    );
    patch(
`          <div class="pc-hscroll">\${refs.map(r => { const c = M.ticketCover(d, r); return \`<button class="pc-mini-stub \${M.sameRef(r, picked) ? 'picked' : ''} \${M.sameRef(r, d.active) ? 'active' : ''}" data-s="pick" \${refAttr(r)}>
              <span class="pc-mini-img">\${c ? \`<img src="\${esc(imgUrl(c))}" alt="">\` : ''}</span>
              <b>\${esc(M.ticketName(d, r))}</b><small>\${r.type === 'group' ? \`\${d.groups[r.id].members.length} 位画师\` : '单个画师'}</small></button>\`; }).join('') || '<div class="pc-dim">这里还没有画师串</div>'}</div>`,
`          <input class="pc-input" data-s-q value="\${esc(query)}" placeholder="搜画师串名字或画师" style="margin-top:10px;width:100%" autocomplete="off">
          \${listHtml(refs)}`
    );
    patch(
`    back.addEventListener('change', ev => {
        const c = ev.target.dataset.sCheck;`,
`    const relist = () => {
        const old = back.querySelector('.pc-hscroll');
        if (!old) return;
        const left = old.scrollLeft, top = old.scrollTop;
        old.outerHTML = listHtml(refsNow());
        const n = back.querySelector('.pc-hscroll');
        if (n) { n.scrollLeft = left; n.scrollTop = top; }
    };
    back.addEventListener('input', ev => { if (!ev.target.matches?.('[data-s-q]')) return; query = ev.target.value; if (!ev.isComposing) relist(); });
    back.addEventListener('compositionend', ev => { if (ev.target.matches?.('[data-s-q]')) { query = ev.target.value; relist(); } });
    back.addEventListener('change', ev => {
        const c = ev.target.dataset.sCheck;`
    );
    patch(
        `        if (s === 'pick') { picked = refFrom(el); draw(); }`,
        `        if (s === 'pick') { picked = refFrom(el); const box = back.querySelector('.pc-hscroll'), left = box?.scrollLeft || 0, top = box?.scrollTop || 0; draw(); const nb = back.querySelector('.pc-hscroll'); if (nb) { nb.scrollLeft = left; nb.scrollTop = top; } }`
    );
    patch(
        `        if (s === 'filter') { sheetFilter = el.dataset.f; draw(); }`,
        `        if (s === 'filter') { sheetFilter = el.dataset.f; query = ''; draw(); }`
    );

    // ── 6B. 画师库分页防卡 + 多选局部更新 + 选没例图的
    patch(
`    \${view === 'grid' ? \`<div class="pc-grid2 pc-mt-s">\${refs.map(r => ticketCard(d, r)).join('') || emptyTxt}</div>\`
        : \`<div class="pc-mt-s">\${refs.map(r => listCard(d, r)).join('') || emptyTxt}</div>\`}`,
`    \${(() => {
        const n = Math.max(40, Number(ui.bookShow) || 40), shown = refs.slice(0, n);
        return (view === 'grid' ? \`<div class="pc-grid2 pc-mt-s">\${shown.map(r => ticketCard(d, r)).join('') || emptyTxt}</div>\`
            : \`<div class="pc-mt-s">\${shown.map(r => listCard(d, r)).join('') || emptyTxt}</div>\`)
            + (refs.length > n ? \`<div class="pc-center pc-mt-s"><button class="pc-pill dashed" id="pc-bookmore" data-act="bookmore">再显示 \${Math.min(40, refs.length - n)} 个 · 共 \${refs.length} 个</button></div>\`
                : (refs.length > 40 ? \`<div class="pc-dim small pc-center pc-mt-s">全部 \${refs.length} 个都在这里了</div>\` : ''));
    })()}`
    );
    patch(
`            case 'booktab': ui.bookTab = el.dataset.tab; ui.picked.clear(); render(); break;
            case 'bookfilter': ui.bookFilter = el.dataset.f; render(); break;`,
`            case 'booktab': ui.bookTab = el.dataset.tab; ui.picked.clear(); ui.bookShow = 40; render(); break;
            case 'bookfilter': ui.bookFilter = el.dataset.f; ui.bookShow = 40; render(); break;
            case 'bookmore': ui.bookShow = Math.max(40, Number(ui.bookShow) || 40) + 40; render(); break;
            case 'selempty': { bookList(d).forEach(r => { if (!(itemOf(d, r)?.images || []).length) ui.picked.add(r.id); }); render(); break; }`
    );
    patch(
        `            case 'selpick': { const id = el.dataset.id; if (ui.picked.has(id)) ui.picked.delete(id); else ui.picked.add(id); render(); break; }`,
`            case 'selpick': {
                const id = el.dataset.id;
                if (ui.picked.has(id)) ui.picked.delete(id); else ui.picked.add(id);
                const on = ui.picked.has(id);
                root.querySelectorAll('.pc-selbox').forEach(b => { if ((b.dataset.id || b.closest('[data-id]')?.dataset.id) === id) { b.classList.toggle('on', on); b.textContent = on ? '✓' : ''; } });
                const bar = root.querySelector('.pc-selbar');
                if (bar) {
                    const sp = bar.querySelector('span');
                    if (sp) sp.textContent = \`已选 \${ui.picked.size} 个\`;
                    bar.querySelectorAll('[data-act="seltag"],[data-act="selban"],[data-act="seldel"]').forEach(x => { x.disabled = !ui.picked.size; });
                }
                break;
            }`
    );
    patch(
        `<button class="pc-pill dashed tiny" data-act="selall">全选</button>`,
        `<button class="pc-pill dashed tiny" data-act="selall">全选</button><button class="pc-pill dashed tiny" data-act="selempty">选没例图的</button>`
    );
    patch(
        `if (el.dataset.bind === 'search') { clearTimeout(onInput.t);`,
        `if (el.dataset.bind === 'search') { ui.bookShow = 40; clearTimeout(onInput.t);`
    );

    // ── 6C. 回收站（7 天保留）+ 底部 9 秒撤销删除条
    patch(
`function viewBook(d) {`,
`const PC_TRASH_DAYS = 7;
function pcTrash(d) { return Array.isArray(d.options.trash) ? d.options.trash : (d.options.trash = []); }
function pcTrashPut(d, refs) {
    const out = [];
    for (const r of refs) {
        const it = r.type === 'group' ? d.groups[r.id] : d.artists[r.id];
        if (!it) continue;
        const groups = r.type === 'artist'
            ? Object.values(d.groups).flatMap(g => (g.members || []).filter(m => m.artistId === r.id).map(m => ({ gid: g.id, weight: m.weight ?? 1 })))
            : [];
        const e = { tid: M.uid('tr_'), type: r.type, item: structuredClone(it), groups, at: Date.now() };
        pcTrash(d).unshift(e);
        out.push(e.tid);
    }
    return out;
}
function pcTrashRestore(d, tids) {
    const list = pcTrash(d);
    let n = 0;
    for (const tid of tids) {
        const i = list.findIndex(e => e.tid === tid);
        if (i < 0) continue;
        const e = list[i];
        list.splice(i, 1);
        if (e.type === 'artist') {
            const exist = M.findArtistByTag(d, e.item.tag);
            let id;
            if (exist) {
                id = exist.id;
                const have = new Set((exist.images || []).map(x => x.path));
                for (const im of e.item.images || []) if (!have.has(im.path)) (exist.images ||= []).push(im);
                if (!exist.note && e.item.note) exist.note = e.item.note;
            } else {
                id = M.uid('a_');
                d.artists[id] = { ...structuredClone(e.item), id };
            }
            for (const g of e.groups || []) {
                const grp = d.groups[g.gid];
                if (grp && !grp.members.some(m => m.artistId === id)) grp.members.push({ artistId: id, weight: g.weight ?? 1 });
            }
        } else {
            const id = M.uid('g_'), g = { ...structuredClone(e.item), id };
            g.members = (g.members || []).filter(m => d.artists[m.artistId]);
            d.groups[id] = g;
        }
        n++;
    }
    return n;
}
function pcTrashPurge(d, only = null) {
    const list = pcTrash(d), cut = Date.now() - PC_TRASH_DAYS * 864e5;
    const drop = list.filter(e => only ? only.includes(e.tid) : e.at < cut);
    if (!drop.length) return 0;
    d.options.trash = list.filter(e => !drop.includes(e));
    const live = new Set([...Object.values(d.artists), ...Object.values(d.groups), ...d.options.trash.map(e => e.item)].flatMap(x => (x.images || []).map(i => i.path)));
    for (const e of drop) for (const i of e.item.images || []) if (i.path && !live.has(i.path)) deleteImageFile(i.path);
    return drop.length;
}
function pcUndoBar(text, onUndo) {
    DOC.getElementById('pc-undobar')?.remove();
    const el = DOC.createElement('div');
    el.id = 'pc-undobar';
    el.setAttribute('style', 'position:fixed;left:12px;right:12px;bottom:max(18px,env(safe-area-inset-bottom));z-index:2147483646;display:flex;align-items:center;gap:10px;max-width:520px;margin:0 auto;padding:10px 14px;border-radius:14px;background:#3a2e26;color:#f4efe4;font-size:14px;box-shadow:0 6px 20px rgba(0,0,0,.25);box-sizing:border-box');
    el.innerHTML = \`<span style="flex:1">\${esc(text)}</span><button type="button" style="font:inherit;border:0;border-radius:999px;padding:4px 14px;background:#f4efe4;color:#3a2e26;cursor:pointer">撤销</button>\`;
    el.querySelector('button').addEventListener('click', ev => { ev.stopPropagation(); el.remove(); onUndo(); });
    pcMount(el);
    setTimeout(() => el.remove(), 9000);
}
function pcUndoDelete(tids, what) {
    pcUndoBar(\`删掉了 \${what} · 回收站里 \${PC_TRASH_DAYS} 天内能放回\`, () => {
        const n = pcTrashRestore(getData(), tids);
        commit(); render();
        toastr.success(\`放回了 \${n} 个\`, '智库', { timeOut: 1800 });
    });
}
function pcBookSeg(d) {
    const n = pcTrash(d).length;
    const bs = n ? ' style="flex:1;min-width:0;white-space:nowrap;padding-left:4px;padding-right:4px"' : '';
    return \`<div class="pc-seg pc-mt-s"\${n ? ' style="display:flex;flex-wrap:nowrap"' : ''}>
      <button\${bs} class="\${ui.bookTab === 'groups' ? 'on' : ''}" data-act="booktab" data-tab="groups">画师组 · \${Object.keys(d.groups).length}</button>
      <button\${bs} class="\${ui.bookTab === 'artists' ? 'on' : ''}" data-act="booktab" data-tab="artists">单个画师 · \${Object.keys(d.artists).length}</button>
      \${n || ui.bookTab === 'trash' ? \`<button\${bs || ' style="flex:1;min-width:0;white-space:nowrap;padding-left:4px;padding-right:4px"'} class="\${ui.bookTab === 'trash' ? 'on' : ''}" data-act="booktab" data-tab="trash">回收站 · \${n}</button>\` : ''}
    </div>\`;
}
function pcTrashView(d) {
    if (pcTrashPurge(d)) commit({ silent: true });
    const list = pcTrash(d);
    const fmt = t => { const x = new Date(t); return \`\${x.getMonth() + 1}/\${x.getDate()} \${String(x.getHours()).padStart(2, '0')}:\${String(x.getMinutes()).padStart(2, '0')}\`; };
    const left = e => Math.max(1, Math.ceil((e.at + PC_TRASH_DAYS * 864e5 - Date.now()) / 864e5));
    const row = e => {
        const name = e.type === 'group' ? e.item.name || '没起名的画师组' : String(e.item.tag || '').replace(/^artist:/, '');
        const n = (e.item.images || []).length;
        return \`<div class="pc-li" style="display:flex;gap:10px;align-items:center">
          <div class="pc-grow" style="min-width:0"><b class="mono" style="word-break:break-all">\${esc(name)}</b>
            <div class="pc-dim small">\${e.type === 'group' ? '画师组' : '画师'} · 删于 \${fmt(e.at)} · 还剩 \${left(e)} 天\${n ? \` · \${n} 张例图\` : ''}</div></div>
          <button class="pc-pill tiny on" data-act="trashrestore" data-t="\${esc(e.tid)}">放回</button>
          <button class="pc-pill tiny dashed danger" data-act="trashpurge" data-t="\${esc(e.tid)}">彻底删</button></div>\`;
    };
    return \`\${pcBookSeg(d)}
    <section class="pc-card pc-pad pc-mt-s"><div class="pc-dim small" style="margin:0">删掉的画师和画师组先放在这里，例图也先留着，\${PC_TRASH_DAYS} 天后自动清掉。放回后会回到原来的画师组里。</div>
    \${list.length ? \`<div class="pc-actions wrap pc-mt-s"><button class="pc-pill dashed tiny" data-act="trashrestoreall">全部放回</button><button class="pc-pill tiny danger" data-act="trashempty">清空回收站</button></div>\` : ''}</section>
    <div class="pc-mt-s">\${list.map(row).join('') || empty('回收站是空的', '删掉的画师和画师组会先放在这里。')}</div>
    <div style="height:24px"></div>\`;
}
function viewBook(d) {
    if (ui.bookTab === 'trash') return pcTrashView(d);`
    );
    patch(
`    <div class="pc-seg pc-mt-s">
      <button class="\${ui.bookTab === 'groups' ? 'on' : ''}" data-act="booktab" data-tab="groups">画师组 · \${Object.keys(d.groups).length}</button>
      <button class="\${ui.bookTab === 'artists' ? 'on' : ''}" data-act="booktab" data-tab="artists">单个画师 · \${Object.keys(d.artists).length}</button>
    </div>`,
`    \${pcBookSeg(d)}`
    );
    patch(
`                const t = M.resolveTicket(d, r);
                const imgs = t.item.images.slice();
                if (r.type === 'group') M.deleteGroup(d, r.id); else M.deleteArtist(d, r.id);
                if (['artist', 'group'].includes(ui.view)) ui.view = 'book';
                DOC.querySelector('.pc-sheet-backdrop')?.remove();
                commit();
                imgs.forEach(i => deleteImageFile(i.path));
                break;`,
`                const pcTids = pcTrashPut(d, [r]);
                if (r.type === 'group') M.deleteGroup(d, r.id); else M.deleteArtist(d, r.id);
                if (['artist', 'group'].includes(ui.view)) ui.view = 'book';
                DOC.querySelector('.pc-sheet-backdrop')?.remove();
                commit();
                pcUndoDelete(pcTids, \`「\${name}」\`);
                break;`
    );
    patch(
`                const imgs = ids.flatMap(id => itemOf(d, { type, id }).images.map(i => i.path));
                for (const id of ids) { if (type === 'group') M.deleteGroup(d, id); else M.deleteArtist(d, id); }
                ui.picked.clear(); ui.selecting = false;
                commit();
                imgs.forEach(p => deleteImageFile(p));
                toastr.success(\`删掉了 \${ids.length} 个\`, '智库');`,
`                const pcTids = pcTrashPut(d, ids.map(id => ({ type, id })));
                for (const id of ids) { if (type === 'group') M.deleteGroup(d, id); else M.deleteArtist(d, id); }
                ui.picked.clear(); ui.selecting = false;
                commit();
                pcUndoDelete(pcTids, \`\${ids.length} 个\`);`
    );
    patch(
`            case 'selmode': ui.selecting = !ui.selecting; ui.picked.clear(); render(); break;`,
`            case 'trashrestore': case 'trashrestoreall': {
                const tids = act === 'trashrestoreall' ? pcTrash(d).map(e => e.tid) : [el.dataset.t];
                const n = pcTrashRestore(d, tids);
                if (!pcTrash(d).length) ui.bookTab = 'artists';
                commit(); render();
                toastr.success(\`放回了 \${n} 个\`, '智库', { timeOut: 1800 });
                break;
            }
            case 'trashpurge': case 'trashempty': {
                const tids = act === 'trashempty' ? pcTrash(d).map(e => e.tid) : [el.dataset.t];
                if (!tids.length) break;
                if (!(await confirmBox(act === 'trashempty' ? \`清空回收站？\${tids.length} 个会彻底删掉，例图也一起删，不能再放回。\` : '彻底删掉？例图也一起删，不能再放回。', { ok: '彻底删', cancel: '算了' }))) break;
                pcTrashPurge(d, tids);
                if (!pcTrash(d).length) ui.bookTab = 'artists';
                commit(); render();
                break;
            }
            case 'selmode': ui.selecting = !ui.selecting; ui.picked.clear(); render(); break;`
    );

    return s;
}
