import assert from 'node:assert/strict';

const COMIC_CSS = `
.pc-comic-wrap{margin:12px 0;padding:10px;border-radius:12px;background:var(--SmartThemeBlurTintColor,rgba(128,128,128,.12));text-shadow:none!important}
.pc-comic-head{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;margin-bottom:8px;font-size:13px}
.pc-comic-head b{font-weight:600}
.pc-comic-btns{display:flex;gap:6px;flex-wrap:wrap}
.pc-comic-btns button{padding:3px 10px;border-radius:999px;border:1px solid rgba(128,128,128,.35);background:rgba(128,128,128,.12);color:inherit;font-size:12px;cursor:pointer}
.pc-comic-btns button.danger{color:#d9897e;border-color:rgba(217,137,126,.45)}
.pc-comic-pages{display:flex;flex-direction:column;gap:12px;align-items:center}
.pc-comic-page{position:relative;width:fit-content;max-width:100%;border-radius:8px;overflow:hidden;line-height:0;background:#111;box-shadow:0 4px 16px rgba(0,0,0,.22)}
.pc-comic-page img{display:block;max-width:100%;max-height:640px;width:auto;height:auto;object-fit:contain;cursor:pointer}
.pc-comic-bar{display:flex;justify-content:center;gap:6px;flex-wrap:wrap;padding:6px;background:rgba(0,0,0,.62);line-height:1.4}
.pc-comic-bar button{padding:3px 10px;border-radius:999px;border:1px solid rgba(255,255,255,.28);background:rgba(255,255,255,.12);color:#fff;font-size:12px;cursor:pointer}
.pc-comic-fold{display:inline-flex;align-items:center;gap:6px;padding:6px 14px;border-radius:8px;border:0;background:rgba(128,128,128,.16);color:inherit;font-size:13px;cursor:pointer}
.pc-comic-err{padding:8px 12px;border-radius:8px;border:1px solid rgba(220,90,80,.55);background:rgba(220,90,80,.12);font-size:12.5px;line-height:1.6}
.pc-cb2{position:absolute;z-index:2;pointer-events:none;box-sizing:border-box;padding:5px 8px;color:#1d1612!important;text-shadow:none!important;word-break:break-word}
.pc-cb2.speech{background:rgba(255,255,255,.92);border:1.5px solid #222;border-radius:14px;transform:translate(-50%,0);box-shadow:0 2px 6px rgba(0,0,0,.18)}
.pc-cb2.thought{background:rgba(255,255,255,.88);border:1.5px dashed #444;border-radius:18px;transform:translate(-50%,0)}
.pc-cb2.narr{background:rgba(250,245,234,.92);border:1px solid #333;border-radius:3px}
.pc-cb2.sfx{background:transparent;border:0;color:#fff!important;font-weight:800!important;text-shadow:-1px -1px 0 #111,1px -1px 0 #111,-1px 1px 0 #111,1px 1px 0 #111!important;transform:translate(-50%,-50%)}
.pc-cbook{position:fixed;inset:0;z-index:41000;background:rgba(12,12,16,.95);color:#f4efe4;display:flex;flex-direction:column;text-shadow:none!important}
.pc-cbook-top{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:10px 14px;border-bottom:1px solid rgba(255,255,255,.12);font-size:13.5px}
.pc-cbook-top button{padding:5px 12px;border-radius:999px;border:1px solid rgba(255,255,255,.25);background:rgba(255,255,255,.1);color:#fff;font-size:12.5px;cursor:pointer}
.pc-cbook-stage{flex:1;overflow:auto;display:flex;align-items:center;justify-content:center;padding:12px}
.pc-cbook-foot{display:flex;align-items:center;justify-content:center;gap:12px;padding:10px 14px;border-top:1px solid rgba(255,255,255,.12)}
.pc-cbook-foot button{padding:6px 16px;border-radius:999px;border:1px solid rgba(255,255,255,.28);background:rgba(255,255,255,.12);color:#fff;font-size:13px;cursor:pointer}
.pc-cbook-toc{max-width:560px;width:100%;max-height:76vh;overflow:auto;display:flex;flex-direction:column;gap:8px}
.pc-cbook-row{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 12px;border-radius:10px;background:rgba(255,255,255,.08)}
`;

/**
 * v1.0.3 漫画核心版：
 * 1) 顶部导航新增「漫画」页（彩色/黑白网点、页数、格数、对白叠字与字号、独立画风、AI 额外要求、打开漫画书）
 * 2) 每楼按钮栏新增 📖「画成漫画」手动触发按钮（不碰酒馆预设，结果独立存在 msg.extra.zhikuComic）
 * 3) 楼层底部渲染漫画页 + 前端本地叠字气泡（说话/心声/旁白/拟声，黑白漫默认竖排）+ 单页重画/编辑/收起/删除
 * 4) 全屏「漫画书阅读器」（翻看全聊天漫画页 + 目录补画未画楼层）
 */
export function applyComicCore(s) {
    const patch = (a, b) => {
        assert.equal(s.split(a).length, 2, 'applyComicCore anchor mismatch: ' + a.slice(0, 90));
        s = s.replace(a, () => b);
    };

    // ── 1. 顶部导航栏增加「漫画」
    patch(
        `const navs = [['studio', '生图'], ['book', '画师库'], ['vibe', '氛围'], ['cast', '角色'], ['lobby', '共享']];`,
        `const navs = [['studio', '生图'], ['comic', '漫画'], ['book', '画师库'], ['vibe', '氛围'], ['cast', '角色'], ['lobby', '共享']];`
    );
    patch(
        `const VIEWS = { cast: viewCast, chatlib: viewChatLib, charhist: viewChatHist, charedit: viewCharEdit, outfit: viewOutfit, studio: viewStudio,`,
        `const VIEWS = { cast: viewCast, chatlib: viewChatLib, charhist: viewChatHist, charedit: viewCharEdit, outfit: viewOutfit, studio: viewStudio, comic: viewComic,`
    );

    // ── 2. 漫画设置读写 + 漫画页 UI + 核心改编/生图/楼层渲染/漫画书阅读器
    patch(
        `function viewStudio(d) {`,
`const ctx = () => P.SillyTavern?.getContext?.() || {};
const COMIC_FONT_SIZES = { xs: '10px', sm: '12px', md: '14px', lg: '16px', off: '' };
function comicOpts(d = getData()) {
    const o = d.options.comic ||= {};
    return {
        monochrome: o.monochrome !== false,
        pages: String(o.pages || 'auto'),
        panels: String(o.panels || '3-4'),
        bubble: String(o.bubble || 'overlay'),
        fontSize: String(o.fontSize || 'sm'),
        styleRef: String(o.styleRef || ''),
        extraReq: String(o.extraReq || ''),
    };
}
function comicStyleOptions(d) {
    const groups = Object.values(d.groups || {}).map(g => ({ val: 'group:' + g.id, name: g.name || '未命名画师组', kind: '画师组' }));
    const artists = Object.values(d.artists || {}).map(a => ({ val: 'artist:' + a.id, name: String(a.tag || '').replace(/^artist:/, ''), kind: '单画师' }));
    return { groups, artists };
}
function resolveComicStyle(d, co) {
    if (co.styleRef) {
        const [type, id] = co.styleRef.split(':');
        if (type && id && M.resolveTicket(d, { type, id })) {
            return { str: M.ticketString(d, { type, id }), neg: M.ticketNeg(d, { type, id }) };
        }
    }
    return { str: d.active ? M.ticketString(d, d.active) : '', neg: d.active ? M.ticketNeg(d, d.active) : '' };
}
function viewComic(d) {
    const co = comicOpts(d);
    const { groups, artists } = comicStyleOptions(d);
    const chat = ctx()?.chat || [];
    const drawnFloors = chat.filter(m => m?.extra?.zhikuComic?.pages?.length).length;
    return \`
    <section class="pc-card pc-pad">
      <div class="pc-row-between"><h2 class="pc-h2" style="margin:0">漫画（核心版）</h2><button class="pc-btn dark" data-act="opencomicbook">📖 翻看本聊天漫画书\${drawnFloors ? \`（\${drawnFloors} 楼）\` : ''}</button></div>
      <div class="pc-dim small pc-mt-s">在聊天任意一楼点右上角 📖「画成漫画」，AI 会结合角色库外貌把该楼剧情改编成分镜并逐页画出来；不修改正文原文，不注入酒馆预设。</div>
    </section>
    <section class="pc-card pc-pad pc-mt">
      <b>漫画画面与分镜设置</b>
      <div class="pc-seg pc-mt-s">
        <button class="\${co.monochrome ? 'on' : ''}" data-act="comicopt" data-k="monochrome" data-v="1">黑白网点日漫</button>
        <button class="\${!co.monochrome ? 'on' : ''}" data-act="comicopt" data-k="monochrome" data-v="0">彩色漫画</button>
      </div>
      <div class="pc-grid2 pc-mt-s" style="gap:8px">
        <label class="pc-field"><span>每楼画几页</span><select class="pc-input" data-comicopt="pages">
          \${[['auto', '自动（按剧情长短 1~4 页）'], ['1', '1 页'], ['2', '2 页'], ['3', '3 页'], ['4', '4 页'], ['6', '6 页'], ['8', '8 页']].map(([v, t]) => \`<option value="\${v}" \${co.pages === v ? 'selected' : ''}>\${t}</option>\`).join('')}
        </select></label>
        <label class="pc-field"><span>每页几格</span><select class="pc-input" data-comicopt="panels">
          \${[['1-2', '1–2 格（大格精细）'], ['3-4', '3–4 格（推荐）'], ['5-6', '5–6 格（紧凑）']].map(([v, t]) => \`<option value="\${v}" \${co.panels === v ? 'selected' : ''}>\${t}</option>\`).join('')}
        </select></label>
        <label class="pc-field"><span>对白显示</span><select class="pc-input" data-comicopt="bubble">
          \${[['overlay', '插件本地叠字（推荐，无乱码）'], ['off', '不要对白（纯画面）']].map(([v, t]) => \`<option value="\${v}" \${co.bubble === v ? 'selected' : ''}>\${t}</option>\`).join('')}
        </select></label>
        <label class="pc-field"><span>叠字字号</span><select class="pc-input" data-comicopt="fontSize">
          \${[['xs', '特小'], ['sm', '小（默认）'], ['md', '中'], ['lg', '大']].map(([v, t]) => \`<option value="\${v}" \${co.fontSize === v ? 'selected' : ''}>\${t}</option>\`).join('')}
        </select></label>
      </div>
      <label class="pc-field pc-mt-s"><span>漫画画风（默认跟正文画师串）</span><select class="pc-input" data-comicopt="styleRef">
        <option value="">跟正文画师串走</option>
        \${groups.length ? \`<optgroup label="画师组">\${groups.map(g => \`<option value="\${esc(g.val)}" \${co.styleRef === g.val ? 'selected' : ''}>\${esc(g.name)}</option>\`).join('')}</optgroup>\` : ''}
        \${artists.length ? \`<optgroup label="单个画师">\${artists.map(a => \`<option value="\${esc(a.val)}" \${co.styleRef === a.val ? 'selected' : ''}>\${esc(a.name)}</option>\`).join('')}</optgroup>\` : ''}
      </select></label>
      <label class="pc-field pc-mt-s"><span>给 AI 的额外改编要求（可空）</span><textarea class="pc-textarea small" data-comicopt="extraReq" placeholder="比如：多用人物面部特写、情感细腻、留白多一点…">\${esc(co.extraReq)}</textarea></label>
    </section>
    <div style="height:24px"></div>\`;
}

const comicBusyFloors = new Set();
async function adaptFloorToComic(mesId, { onlyPageIdx = null } = {}) {
    const c = ctx(), msg = c?.chat?.[mesId];
    if (!msg || msg.is_system) { toastr.warning('这一楼不能画成漫画', '漫画'); return; }
    if (!N.isReady()) { toastr.warning('先到设置里填 NovelAI key', '漫画'); return; }
    if (comicBusyFloors.has(mesId)) { toastr.info('这一楼正在生成漫画，请稍等', '漫画'); return; }
    const d = getData(), co = comicOpts(d);
    comicBusyFloors.add(mesId);
    renderFloorComic(mesId, '改编分镜中…');
    try {
        let store = msg.extra?.zhikuComic;
        if (onlyPageIdx == null || !store?.pages?.[onlyPageIdx]) {
            const cleanText = buildChatCastExcerpt([msg], 1, 12000);
            if (!cleanText.trim()) throw new Error('这一楼没有可用的正文内容');
            const castInfo = C.previewCast().map(p => \`- \${p.name}（在提示词里写 $\${p.name}$ 即可）\`).join('\\n');
            const pageRule = co.pages === 'auto' ? '按剧情长短安排 1~4 页' : \`安排 \${co.pages} 页\`;
            const sys = \`你是资深日漫分镜师。请把下面这段剧情改编成漫画分镜 JSON。
要求：
1. \${pageRule}，每页 \${co.panels} 格。
2. 每页写英文 Danbooru 画面提示词（prompt）与每格对白（panels）。出场角色用 $角色名$ 占位，不要重复编造长相。
3. 对白用中文：说话用「…」，心里话用（…），拟声词如「咚！」，旁白不加引号。每格最多 2 句精炼对白。
4. 只输出严格 JSON：{"pages":[{"title":"本页标题","prompt":"整页画面英文标签","panels":[{"visual":"该格画面英文标签","lines":["「台词」"]}]}]}。\${co.extraReq ? '\\n额外要求：' + co.extraReq : ''}\`;
            const userMsg = (castInfo ? \`已登记角色：\\n\${castInfo}\\n\\n\` : '') + \`剧情正文：\\n\${cleanText}\`;
            toastr.info('正在让 AI 改编漫画分镜…', '智库 · 漫画', { timeOut: 3000 });
            const raw = await T.askLLM(sys, userMsg, { maxTokens: 4500 });
            const pages = normalizeComicPages(T.pickJson(raw));
            if (!pages.length) throw new Error('AI 未能输出有效的漫画分镜，请重试');
            msg.extra ||= {};
            store = msg.extra.zhikuComic = {
                pages: pages.map(p => ({ ...p, url: '', monochrome: co.monochrome })),
                collapsed: false,
                hideText: false,
                at: Date.now(),
            };
            await c.saveChat();
        }
        const style = resolveComicStyle(d, co);
        const indices = onlyPageIdx != null ? [onlyPageIdx] : store.pages.map((_, i) => i);
        for (const idx of indices) {
            const pg = store.pages[idx];
            if (!pg) continue;
            renderFloorComic(mesId, \`正在绘制第 \${idx + 1} / \${store.pages.length} 页…\`);
            const mono = pg.monochrome ?? co.monochrome;
            const expandFn = text => C.expandMarkerPrompt(text, { msgId: mesId });
            const posRaw = buildComicPagePrompt(pg, { stylePrompt: style.str, monochrome: mono, expand: t => { const r = expandFn(t); return typeof r === 'string' ? r : (r?.text || t); } });
            const negRaw = buildComicNegative([style.neg, d.options.chatNegative || ''].filter(Boolean).join(', '), { monochrome: mono, overlayText: co.bubble !== 'off' });
            const { positive, negative } = E.composeStudio({ pos: posRaw, neg: negRaw });
            const imgData = await E.generateFull({ positive, negative, width: 832, height: 1216 });
            const { url } = await __mod_store.uploadImage(imgData, \`comic_\${mesId}_\${idx}_\${Date.now()}\`);
            pg.url = url;
            pg.monochrome = mono;
            await c.saveChat();
            renderFloorComic(mesId);
        }
        toastr.success(\`漫画绘制完成（\${indices.length} 页）\`, '智库 · 漫画', { timeOut: 2500 });
    } catch (e) {
        toastr.error(e?.message || String(e), '画成漫画失败', { timeOut: 7000 });
        renderFloorComic(mesId, '', e?.message || String(e));
    } finally {
        comicBusyFloors.delete(mesId);
        renderFloorComic(mesId);
    }
}

function renderFloorComic(mesId, statusText = '', errorText = '') {
    const mes = DOC.querySelector(\`#chat .mes[mesid="\${Number(mesId)}"] .mes_text\`);
    const msg = ctx()?.chat?.[mesId];
    if (!mes || !msg) return;
    let host = mes.querySelector('.pc-comic-host');
    const store = msg.extra?.zhikuComic;
    if (!store?.pages?.length && !statusText && !errorText) { host?.remove(); return; }
    if (!host) { host = DOC.createElement('div'); host.className = 'pc-comic-host'; mes.appendChild(host); }
    const co = comicOpts();
    if (errorText && !store?.pages?.length) {
        host.innerHTML = \`<div class="pc-comic-wrap"><div class="pc-comic-err">漫画改编失败：\${esc(errorText)}<div class="pc-comic-btns" style="margin-top:6px"><button type="button" data-cm="retry">再试一次</button><button type="button" data-cm="dismiss">关闭</button></div></div></div>\`;
        host.onclick = ev => {
            const act = ev.target.closest('[data-cm]')?.dataset.cm;
            if (act === 'retry') void adaptFloorToComic(mesId);
            if (act === 'dismiss') host.remove();
        };
        return;
    }
    if (store?.collapsed && !statusText) {
        host.innerHTML = \`<div class="pc-comic-wrap" style="padding:6px 10px"><button type="button" class="pc-comic-fold" data-cm="expand">📖 漫画 · \${store.pages.length} 页（点开）</button></div>\`;
        host.onclick = async ev => {
            if (!ev.target.closest('[data-cm="expand"]')) return;
            store.collapsed = false;
            await ctx().saveChat();
            renderFloorComic(mesId);
        };
        return;
    }
    const pages = store?.pages || [];
    const showBubble = co.bubble !== 'off' && !store?.hideText;
    const fs = COMIC_FONT_SIZES[co.fontSize] || '12px';
    host.innerHTML = \`<div class="pc-comic-wrap">
      <div class="pc-comic-head"><b>📖 漫画\${pages.length ? \` · \${pages.length} 页\` : ''}\${statusText ? \` · \${esc(statusText)}\` : ''}</b>
        <div class="pc-comic-btns">
          <button type="button" data-cm="book">漫画书</button>
          <button type="button" data-cm="toggletext">\${store?.hideText ? '显示对白' : '隐藏对白'}</button>
          <button type="button" data-cm="readapt" \${comicBusyFloors.has(mesId) ? 'disabled' : ''}>重编这楼</button>
          <button type="button" data-cm="collapse">收起</button>
          <button type="button" class="danger" data-cm="del">删掉漫画</button>
        </div>
      </div>
      \${errorText ? \`<div class="pc-comic-err" style="margin-bottom:8px">\${esc(errorText)}</div>\` : ''}
      <div class="pc-comic-pages">\${pages.map((pg, i) => \`<div class="pc-comic-page" data-cpg="\${i}">
        \${pg.url ? \`<img src="\${esc(pg.url)}" loading="lazy" alt="第 \${i + 1} 页">\${renderComicBubblesHtml(pg, { esc, fontSize: fs, vertical: !!(pg.monochrome ?? co.monochrome), show: showBubble })}\`
            : \`<div style="padding:36px 24px;color:#ccc;font-size:13px">第 \${i + 1} 页等待绘制…</div>\`}
        <div class="pc-comic-bar" hidden>
          <button type="button" data-cm="redraw" data-pi="\${i}">重画这页</button>
          <button type="button" data-cm="editpg" data-pi="\${i}">编辑本页</button>
          \${pg.url ? \`<button type="button" data-cm="zoom" data-pi="\${i}">放大看</button>\` : ''}
        </div>
      </div>\`).join('')}</div>
    </div>\`;
    host.onclick = async ev => {
        const btn = ev.target.closest('[data-cm]');
        if (btn) {
            ev.stopPropagation();
            const act = btn.dataset.cm, pi = Number(btn.dataset.pi);
            if (act === 'book') openComicBook(mesId);
            else if (act === 'toggletext' && store) { store.hideText = !store.hideText; await ctx().saveChat(); renderFloorComic(mesId); }
            else if (act === 'collapse' && store) { store.collapsed = true; await ctx().saveChat(); renderFloorComic(mesId); }
            else if (act === 'readapt') { if (await confirmBox('重新让 AI 改编并绘制这一楼的漫画？')) void adaptFloorToComic(mesId); }
            else if (act === 'del') { if (await confirmBox('删掉这一楼的漫画？')) { delete msg.extra.zhikuComic; await ctx().saveChat(); renderFloorComic(mesId); } }
            else if (act === 'redraw') void adaptFloorToComic(mesId, { onlyPageIdx: pi });
            else if (act === 'zoom' && store?.pages?.[pi]?.url) openViewer(store.pages[pi].url, store.pages.map(p => p.url).filter(Boolean));
            else if (act === 'editpg' && store?.pages?.[pi]) {
                const pg = store.pages[pi];
                const next = await promptText(\`编辑第 \${pi + 1} 页画面提示词（英文标签）\`, pg.prompt || '', true);
                if (next != null && next.trim()) {
                    pg.prompt = next.trim();
                    await ctx().saveChat();
                    if (await confirmBox('已保存提示词，现在重画这一页吗？', { ok: '重画', cancel: '先不' })) void adaptFloorToComic(mesId, { onlyPageIdx: pi });
                }
            }
            return;
        }
        const pgBox = ev.target.closest('.pc-comic-page');
        if (pgBox) {
            const bar = pgBox.querySelector('.pc-comic-bar');
            if (bar) bar.hidden = !bar.hidden;
        }
    };
}

function openComicBook(startFloor = null) {
    DOC.getElementById('pc-cbook')?.remove();
    const chat = ctx()?.chat || [];
    const co = comicOpts();
    const fs = COMIC_FONT_SIZES[co.fontSize] || '12px';
    let showToc = false, hideText = false;
    const collect = () => {
        const list = [];
        chat.forEach((m, fid) => {
            if (!m?.extra?.zhikuComic?.pages?.length) return;
            m.extra.zhikuComic.pages.forEach((pg, pidx) => {
                if (pg.url) list.push({ fid, pidx, pg, name: m.name || ('第 ' + (fid + 1) + ' 楼') });
            });
        });
        return list;
    };
    let items = collect();
    let cur = startFloor != null ? Math.max(0, items.findIndex(x => x.fid === startFloor)) : 0;
    if (!items.length) showToc = true;
    const el = DOC.createElement('div');
    el.id = 'pc-cbook';
    el.className = 'pc-cbook';
    const draw = () => {
        items = collect();
        if (cur >= items.length) cur = Math.max(0, items.length - 1);
        const now = items[cur];
        el.innerHTML = \`
          <div class="pc-cbook-top">
            <b>📖 漫画书\${now && !showToc ? \` · 第 \${now.fid + 1} 楼 P\${now.pidx + 1}（\${cur + 1}/\${items.length}）\` : ''}</b>
            <div style="display:flex;gap:6px">
              <button type="button" data-cb="toc">\${showToc ? '回正文' : '目录'}</button>
              \${!showToc && now ? \`<button type="button" data-cb="text">\${hideText ? '显对白' : '藏对白'}</button><button type="button" data-cb="zoom">放大</button>\` : ''}
              <button type="button" data-cb="close">关闭</button>
            </div>
          </div>
          <div class="pc-cbook-stage">
            \${showToc ? \`<div class="pc-cbook-toc">\${chat.map((m, fid) => {
                if (!m || m.is_system || m.is_user) return '';
                const cnt = m.extra?.zhikuComic?.pages?.filter(p => p.url).length || 0;
                const snippet = String(m.mes || '').replace(/<[^>]+>/g, '').slice(0, 38);
                return \`<div class="pc-cbook-row">
                  <div style="min-width:0;flex:1"><b>第 \${fid + 1} 楼 · \${esc(m.name || '')}</b><div style="font-size:12px;opacity:.7;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">\${esc(snippet)}</div></div>
                  \${cnt ? \`<button type="button" data-cb="jump" data-fid="\${fid}">翻看（\${cnt} 页）</button>\` : \`<button type="button" data-cb="drawfloor" data-fid="\${fid}">画成漫画</button>\`}
                </div>\`;
            }).join('') || '<div style="opacity:.7">当前聊天还没有角色回复</div>'}</div>\`
            : now ? \`<div class="pc-comic-page" style="max-height:80vh"><img src="\${esc(now.pg.url)}" style="max-height:78vh">\${renderComicBubblesHtml(now.pg, { esc, fontSize: fs, vertical: !!(now.pg.monochrome ?? co.monochrome), show: co.bubble !== 'off' && !hideText })}</div>\`
            : '<div style="opacity:.7">还没有画好的漫画页，点右上角「目录」挑一楼来画吧。</div>'}
          </div>
          \${!showToc && items.length > 1 ? \`<div class="pc-cbook-foot"><button type="button" data-cb="prev" \${cur <= 0 ? 'disabled' : ''}>‹ 上一页</button><span>\${cur + 1} / \${items.length}</span><button type="button" data-cb="next" \${cur >= items.length - 1 ? 'disabled' : ''}>下一页 ›</button></div>\` : ''}\`;
    };
    el.addEventListener('click', ev => {
        const b = ev.target.closest('[data-cb]');
        if (!b) return;
        const act = b.dataset.cb;
        if (act === 'close') { el.remove(); return; }
        if (act === 'toc') { showToc = !showToc; draw(); return; }
        if (act === 'text') { hideText = !hideText; draw(); return; }
        if (act === 'prev' && cur > 0) { cur--; draw(); return; }
        if (act === 'next' && cur < items.length - 1) { cur++; draw(); return; }
        if (act === 'zoom' && items[cur]) { openViewer(items[cur].pg.url, items.map(x => x.pg.url)); return; }
        if (act === 'jump') {
            const fid = Number(b.dataset.fid);
            const idx = items.findIndex(x => x.fid === fid);
            if (idx >= 0) cur = idx;
            showToc = false; draw(); return;
        }
        if (act === 'drawfloor') {
            const fid = Number(b.dataset.fid);
            el.remove();
            void adaptFloorToComic(fid);
        }
    });
    pcMount(el);
    draw();
}

function viewStudio(d) {`
    );

    // ── 3. 漫画页事件与选项保存
    patch(
        `            case 'refreshquota': void refreshQuota(true); break;`,
        `            case 'refreshquota': void refreshQuota(true); break;
            case 'opencomicbook': openComicBook(); break;
            case 'comicopt': {
                const co = d.options.comic ||= {};
                co[el.dataset.k] = el.dataset.k === 'monochrome' ? el.dataset.v === '1' : el.dataset.v;
                commit(); render();
                break;
            }`
    );
    patch(
        `    if (el.dataset.pickwi !== undefined) { d.options.pickWi = el.checked; commit({ silent: true }); return; }`,
        `    if (el.dataset.pickwi !== undefined) { d.options.pickWi = el.checked; commit({ silent: true }); return; }
    if (el.dataset.comicopt) { const co = d.options.comic ||= {}; co[el.dataset.comicopt] = el.value; commit({ silent: true }); return; }`
    );
    patch(
        `    if (el.dataset.charcanonTag !== undefined)`,
        `    if (el.dataset.comicopt) { const co = d.options.comic ||= {}; co[el.dataset.comicopt] = el.value; commit({ silent: true }); return; }
    if (el.dataset.charcanonTag !== undefined)`
    );

    // ── 4. 样式注入 + 楼层 📖「画成漫画」按钮 + 楼层漫画自动渲染 + 导出给入口调用
    patch(
        `    DOC.head.appendChild(style);`,
        `    style.textContent += ${JSON.stringify(COMIC_CSS)};\n    DOC.head.appendChild(style);`
    );
    patch(
        `return { openWindow, closeWindow, openInpaintEditor, openOutfitDesigner, openSwitcher, renderChip, importArtistsFromPresets, exportData, renderStub };`,
        `return { openWindow, closeWindow, openInpaintEditor, openOutfitDesigner, openSwitcher, renderChip, importArtistsFromPresets, exportData, renderStub, adaptFloorToComic, renderFloorComic, openComicBook };`
    );
    patch(
        `    const o = DOC.createElement('div');
    o.className = 'mes_button pc-mes-outfit fa-solid fa-shirt interactable';`,
        `    const cm = DOC.createElement('div');
    cm.className = 'mes_button pc-mes-comic fa-solid fa-book-open interactable';
    cm.title = '智库：把这一楼画成漫画';
    cm.tabIndex = 0;
    box.prepend(cm);
    const o = DOC.createElement('div');
    o.className = 'mes_button pc-mes-outfit fa-solid fa-shirt interactable';`
    );
    patch(
        `        if (mes) { __mod_marker.decorate(targetId); attachMesButton(mes); }`,
        `        if (mes) { __mod_marker.decorate(targetId); attachMesButton(mes); UI.renderFloorComic(targetId); }`
    );
    patch(
        `    DOC.querySelectorAll('#chat .mes').forEach(attachMesButton);`,
        `    DOC.querySelectorAll('#chat .mes').forEach(m => { attachMesButton(m); const mid = Number(m.getAttribute('mesid')); if (Number.isFinite(mid)) UI.renderFloorComic(mid); });`
    );
    patch(
        `function onChatClick(ev) {
    const o = ev.target.closest?.('.pc-mes-outfit');`,
        `function onChatClick(ev) {
    const cm = ev.target.closest?.('.pc-mes-comic');
    if (cm) {
        ev.stopPropagation();
        const id = Number(cm.closest('.mes')?.getAttribute('mesid'));
        if (Number.isFinite(id)) void UI.adaptFloorToComic(id);
        return;
    }
    const o = ev.target.closest?.('.pc-mes-outfit');`
    );
    patch(
        `DOC.querySelectorAll('.pc-mes-gen, .pc-mes-outfit').forEach(n => n.remove());`,
        `DOC.querySelectorAll('.pc-mes-gen, .pc-mes-outfit, .pc-mes-comic, .pc-comic-host').forEach(n => n.remove()); DOC.getElementById('pc-cbook')?.remove();`
    );

    return s;
}
