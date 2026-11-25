import fs from 'node:fs';
import assert from 'node:assert/strict';
import {applyMarkers} from './apply-markers.mjs';
import {applyUxFixes} from './ux-fixes.mjs';
import {applyCharLibrary} from './apply-char-lib.mjs';
import {fileURLToPath} from 'node:url';
process.chdir(fileURLToPath(new URL('../', import.meta.url)));
const dir='.';
const VERSION='0.8.16';
let s=applyMarkers(JSON.parse(fs.readFileSync('zhiku.script.json','utf8')).content);
function patch(a,b){assert.equal(s.split(a).length,2,a.slice(0,80));s=s.replace(a,()=>b);}
patch("globalThis.__PC_VERSION = '0.6.3';", `globalThis.__PC_VERSION = '${VERSION}';`);
patch('智库 · 酒馆助手脚本版 v0.6.3',`智库 · 原生扩展版 v${VERSION}`);
patch('    const run = () => {\n        saving = saving.then(writeNow)', '    const run = () => {\n        saveTimer = null;\n        saving = saving.then(writeNow)');
patch('return { getData, onChange, loadData, commit, replaceData, uploadImage, deleteImageFile, imgUrl, fileToDataUrl, urlToDataUrl, shrinkDataUrl };', 'return { getData, onChange, loadData, commit, replaceData, uploadImage, deleteImageFile, imgUrl, fileToDataUrl, urlToDataUrl, shrinkDataUrl, flush: () => saveTimer !== null ? commit({ immediate: true, silent: true }) : saving };');
// 所有 NovelAI 出错都带上状态码，429 才能被队列认出来重试
s=s.replaceAll("throw new Error(explain(r.status, new TextDecoder().decode(buf)));","throw Object.assign(new Error(explain(r.status, new TextDecoder().decode(buf))),{status:r.status,retryAfter:r.headers?.get('Retry-After')});");
// 用酒馆里的 key 时，酒馆把 NovelAI 的 429 也报成 500：当成可重试
patch("{status:r.status,retryAfter:r.headers?.get('Retry-After')});\n        let b64","{status:r.status,retryAfter:r.headers?.get('Retry-After'),retryable:r.status===500});\n        let b64");
patch("if (status >= 500) return 'NovelAI 服务器出错了，过一会再试（' + status + '）';","if (status >= 500) return 'NovelAI 服务器出错了，过一会再试（' + status + '）' + (viaTavern ? '。用酒馆里的 key 时，请求太快也会显示成这个' : '');");
// 编码氛围也走同一个队列
patch('async function encodeVibe(imageB64, infoExtracted = 1, model = settings().novelaimode) {','function encodeVibe(...args){return __naiGate.run(()=>encodeVibeRequest(...args));}\nasync function encodeVibeRequest(imageB64, infoExtracted = 1, model = settings().novelaimode) {');
// NovelAI V5 适配补齐：补充 V5 Full (Medium)、tag_hint_qt 随质量词开关联动、局部重绘 V5 参数清理
patch("    ['nai-diffusion-5-full', 'NAI Diffusion 5 Full'],\n    ['nai-diffusion-5-curated', 'NAI Diffusion 5 Curated'],",
      "    ['nai-diffusion-5-full', 'NAI Diffusion 5 Full'],\n    ['nai-diffusion-5-full-medium', 'NAI Diffusion 5 Full (Medium)'],\n    ['nai-diffusion-5-curated', 'NAI Diffusion 5 Curated'],");
patch('        p.tag_hint_qt = 1;', '        p.tag_hint_qt = s.AQT_novelai ? 1 : 0;');
patch("        if (model.includes('nai-diffusion-5')) { body.tag_hint_uc_preset = params.tag_hint_uc_preset; body.tag_hint_qt = 1; delete body.scheduler; }",
      "        if (model.includes('nai-diffusion-5')) { body.tag_hint_uc_preset = params.tag_hint_uc_preset; body.tag_hint_qt = params.tag_hint_qt; delete body.scheduler; }");
patch('    if (isV5) delete parameters.noise_schedule;',
      "    if (isV5) {\n        const k = ucpValue(s).toLowerCase();\n        parameters.tag_hint_uc_preset = { heavy: 1, furryfocus: 2, light: 3, humanfocus: 4 }[k] ?? 0;\n        parameters.tag_hint_qt = s.AQT_novelai ? 1 : 0;\n        delete parameters.noise_schedule;\n        delete parameters.skip_cfg_above_sigma;\n    }");
// 关于：名片样式
{
  const a=s.indexOf("    const about = setFold('about', '关于'");
  const b=s.indexOf("\n\n",a);
  assert(a>0&&b>a);
  patch(s.slice(a,b),`    const about = setFold('about', '关于', '智库 v' + (globalThis.__PC_VERSION || ''), \`
      <style>.pc-about-card{text-align:center;padding:22px 10px 10px;border-radius:16px;background:radial-gradient(circle at 50% 0,rgba(201,138,62,.22),transparent 70%)}.pc-about-name{font-family:var(--pc-font-name);font-size:34px;font-weight:800;letter-spacing:.3em;padding-left:.3em;color:var(--pc-ink)}.pc-about-card .pc-subtitle{font-size:13px;margin-top:4px}.pc-about-ver{display:block;margin-top:12px;font:11px var(--pc-font-label);letter-spacing:.25em;color:var(--pc-ink-soft);text-transform:uppercase}.pc-about-card .pc-actions{justify-content:center;margin-top:14px}.pc-about-note{text-align:center;font-size:12px;color:var(--pc-ink-soft);margin-top:12px;line-height:1.7}</style>
      <div class="pc-about-card"><div class="pc-about-name">智库</div><div class="pc-subtitle">二改自从前佬的智绘姬 · 角色外观库版</div>
        <span class="pc-about-ver">v\${esc(globalThis.__PC_VERSION || '')} · if love</span>
        <div class="pc-actions wrap"><a class="pc-btn dark" href="https://github.com/x007006wjm/zhiku-charlib" target="_blank" rel="noopener">仓库 / 更新</a><a class="pc-btn" href="https://github.com/damoshen123/st-chatu8" target="_blank" rel="noopener">智绘姬原仓库</a></div></div>
      <div class="pc-about-note">看图提取需要能识图的模型 · 原脚本 AFPL v9，署名保留</div>\`);`);
}
// 只用一次 / 每张换一个：聊天里出一张图之后才生效（以前没接上）
patch(`function setActive(ref, { oneShot = false } = {}) {`,`/** 聊天里生成一张后：「只用一次」换回原来的；「每生成一张就换一个」换下一个 */
function afterChatImage() {
    const d = getData();
    if (d.oneShot) {
        const back = d.previousActive && M.resolveTicket(d, d.previousActive) ? d.previousActive : null;
        setActive(back);
        toastr.info(back ? \`只用一次：已换回「\${M.ticketName(d, back)}」\` : '只用一次：已取消画师串', '智库', { timeOut: 2000 });
        return;
    }
    if (d.rotate && d.rotate !== 'off') {
        const next = M.nextInRotation(d);
        if (next) setActive(next);
    }
}

function setActive(ref, { oneShot = false } = {}) {`);
patch('return { runtime, stSettings, extras, composeStudio,','return { afterChatImage, runtime, stSettings, extras, composeStudio,');
// 绑定：离开绑定的角色卡时换回原来的画师串（以前会一直留着上一个角色的）
patch('        previousActive: null,','        previousActive: null,\n        bindingActive: false,\n        beforeBinding: null,');
{
  const a=s.indexOf('function bindCurrentCharacter(ref) {');
  const b=s.indexOf('\n\n\nconst ctx = () => SillyTavern.getContext();',a);
  assert(a>0&&b>a);
  patch(s.slice(a,b),`function bindCurrentCharacter(ref) {
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
            toastr.info(\`这个角色卡绑定了画师串「\${M.ticketName(d, ref)}」，已自动切换\`, '智库', { timeOut: 2500 });
        } else commit({ silent: true });
        return;
    }
    if (d.bindingActive) {
        const back = d.beforeBinding && M.resolveTicket(d, d.beforeBinding) ? d.beforeBinding : null;
        d.bindingActive = false;
        d.beforeBinding = null;
        if (!(back ? M.sameRef(back, d.active) : !d.active)) {
            setActive(back);
            toastr.info(back ? \`离开绑定的角色卡，换回「\${M.ticketName(d, back)}」\` : '离开绑定的角色卡，已取消画师串', '智库', { timeOut: 2500 });
        } else commit({ silent: true });
    }
}`);
}
// 画师名没写 artist: 时：认出来，一键补上
patch('function viewStudio(d) {',`/** 没写 artist: 的画师名：开头一串名字（遇到普通词就停），加上画师库里已有的名字 */
function guessBareArtists(d, text) {
    const GENERAL = /^(\\d+(boy|girl|other)s?|solo|male|female|nsfw|sfw|rating:.*|year \\d{4}|\\d{4}|newest|oldest|recent|early|mid|late|masterpiece|absurdres|highres|lowres|very aesthetic|aesthetic|no text|artist collaboration|.*quality.*|ultra[ -_]?detailed)$/i;
    const nameLike = t => !/\\s/.test(t) || /^[^\\s()]+ \\((?!medium|style)[^()]+\\)$/i.test(t);
    const out = [];
    let lead = true;
    for (const t of M.tokenize(text)) {
        if (t.isArtist) continue;
        const name = t.text.trim();
        const known = !!M.findArtistByTag(d, 'artist:' + name);
        if (lead && (GENERAL.test(name) || !nameLike(name))) lead = false;
        if ((lead || known) && !GENERAL.test(name) && !out.includes(name)) out.push(name);
    }
    return out;
}
function addArtistPrefix(text, names) {
    let s = String(text || '');
    for (const n of names) {
        const e = n.replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&');
        s = s.replace(new RegExp('(^|[,{\\\\[]|::)(\\\\s*)(' + e + ')(?=\\\\s*(?:,|::|[}\\\\]]|$))', 'g'), '$1$2artist:$3');
    }
    return s;
}

function viewStudio(d) {`);
patch(`        <button class="pc-pill dashed" data-act="pickartist">换画师</button>
      </div>
      <textarea id="pc-pos"`,`        <button class="pc-pill dashed" data-act="pickartist">换画师</button>
      </div>
      \${(() => { const bare = guessBareArtists(d, st.pos); return bare.length ? \`<div class="pc-bare" style="margin-top:8px"><div class="pc-row-between"><span class="pc-dim small">没写 artist: 的画师名 · 点名字单个补</span><button class="pc-pill tiny on" data-act="addprefix">全部补上</button></div><div class="pc-chips wrap">\${bare.map(n => \`<button class="pc-pill dashed tiny" data-act="addprefix" data-name="\${esc(n)}">\${esc(n)}</button>\`).join('')}</div></div>\` : ''; })()}
      <textarea id="pc-pos"`);
patch(`        <a class="pc-btn" href="\${esc(st.result)}" download="piaoce_\${Date.now()}.png">下载</a>
      </div>`,`        <a class="pc-btn" href="\${esc(st.result)}" download="piaoce_\${Date.now()}.png">下载</a>
        <button class="pc-btn danger" data-act="clearresult">删掉</button>
      </div>`);
patch(`            case 'saveartist': {`,`            case 'clearresult': ui.studio.result = null; ui.studio.sent = null; render(); break;
            case 'addprefix': {
                const names = el.dataset.name ? [el.dataset.name] : guessBareArtists(d, ui.studio.pos);
                ui.studio.pos = addArtistPrefix(ui.studio.pos, names);
                saveStudio(); render();
                break;
            }
            case 'saveartist': {`);
const oldButtons=s.slice(s.indexOf('    // 酒馆助手的脚本按钮（输入框下方）'),s.indexOf("    if (N.isReady()) toastr.success('打开方式：输入框下方"));
assert(oldButtons.length>100);
patch(oldButtons,`    // Native settings entry; no Tavern Helper globals.
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

`);
patch('打开方式：输入框下方的「智库」按钮、魔棒菜单里的「智库」、界面右边的小票根。','打开方式：扩展设置里的「打开智库」、魔棒菜单里的「智库」、界面右边的小票根。');
const tail=s.slice(s.indexOf('// 脚本被关掉或重载时，只收走自己挂上去的东西'));
assert(tail.includes('start().catch'));
patch(tail,`let ownCleanup = null;
return {
    start,
    async stop() {
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
        finally { for (const id of timers) window.clearTimeout(id); timers.clear(); stopped = true; }
    }
};
`);
s=applyUxFixes(s);
// 自定义负面固定词多预设（另存为预设 / 切换 / 改名 / 删除）+ NovelAI 数值权重末尾空格防护 + NovelAI V5 精确参考 / 服装参考
{
    const ucpHelper = fs.readFileSync('src/ucp-presets.js', 'utf8').replace(/^export\s+/gm, '');
    const weightHelper = fs.readFileSync('src/weight-guard.js', 'utf8').replace(/^export\s+/gm, '');
    const prHelper = fs.readFileSync('src/precise-ref.js', 'utf8').replace(/^export\s+/gm, '');
    s = prHelper + '\n' + weightHelper + '\n' + ucpHelper + '\n' + s;
    patch("function charRefSupported() {\n    const s = settings();\n    return s.naiMode !== 'tavern' && s.novelaimode.includes('4-5');\n}",
        "function charRefSupported() {\n    const s = settings();\n    return s.naiMode !== 'tavern' && isPreciseRefModel(s.novelaimode);\n}");
    patch(`    if (director?.length && model.includes('4-5')) {
        // 角色参考（只有 4.5 能用，而且不能和氛围一起用）
        p.director_reference_images_cached = director.map(r => ({ cache_secret_key: r.key, data: r.data }));
        p.director_reference_descriptions = director.map(r => ({ caption: { base_caption: r.type === 'both' ? 'character&style' : r.type === 'style' ? 'style' : 'character', char_captions: [] }, legacy_uc: false }));
        p.director_reference_information_extracted = director.map(() => 1);
        p.director_reference_strength_values = director.map(r => r.strength);
        p.director_reference_secondary_strength_values = director.map(r => Math.round((1 - r.strength) * 1000) / 1000);
        refs = null;
    }`,
    `    if (director?.length && isPreciseRefModel(model)) {
        // 精确参考（NAI 4.5 与 NAI 5 可用；V5 支持服装参考与 0~5 强度且无忠实度滑条）
        Object.assign(p, buildDirectorParams(director, isV5));
        refs = null;
    }`);
    // 发送参考图前按当前模型分桶自适应缩放（V5: 832x1216 / 1024x1024 / 1216x832；V4.5: 1024x1536 / 1472x1472 / 1536x1024），已有参考图无需重传
    patch(`async function charRefs(groupIds) {
    const d = getData();
    const groups = (groupIds || []).map(id => d.charRefGroups?.[id]).filter(g => g?.refs?.length);
    if (!groups.length || !N.charRefSupported()) return null;
    const out = [];
    for (const r of groups.flatMap(g => g.refs)) {
        r.cache ||= '';
        const data = (await urlToDataUrl('/' + r.path.replace(/^\\/+/, ''))).split(',')[1];
        out.push({ key: crypto.randomUUID?.() || M.uid('k'), data, type: r.type || 'character', strength: Number(r.strength ?? 0.6) });
    }
    return out.length ? out : null;
}`,
    `const __charRefBucketCache = new Map();
async function fitDirectorImageB64(dataUrl, isV5) {
    const img = await new Promise((ok, bad) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => bad(new Error('参考图打不开')); i.src = dataUrl; });
    const [w, h] = pickDirectorBucket(img.naturalWidth || img.width, img.naturalHeight || img.height, isV5);
    if ((img.naturalWidth || img.width) === w && (img.naturalHeight || img.height) === h) return dataUrl.split(',')[1];
    const c = DOC.createElement('canvas'); c.width = w; c.height = h;
    const ctx = c.getContext('2d'); ctx.imageSmoothingQuality = 'high';
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
    const k = Math.min(w / img.width, h / img.height), dw = img.width * k, dh = img.height * k;
    ctx.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
    return c.toDataURL('image/jpeg', 0.92).split(',')[1];
}
async function charRefs(groupIds) {
    const d = getData();
    const groups = (groupIds || []).map(id => d.charRefGroups?.[id]).filter(g => g?.refs?.length);
    if (!groups.length || !N.charRefSupported()) return null;
    const isV5 = String(N.settings().novelaimode || '').includes('nai-diffusion-5');
    const out = [];
    for (const r of groups.flatMap(g => g.refs)) {
        r.cache ||= '';
        const cacheKey = r.path + '|' + (isV5 ? 'v5' : 'v45');
        let data = __charRefBucketCache.get(cacheKey);
        if (!data) {
            const rawUrl = await urlToDataUrl('/' + r.path.replace(/^\\/+/, ''));
            data = await fitDirectorImageB64(rawUrl, isV5);
            if (__charRefBucketCache.size > 32) __charRefBucketCache.clear();
            __charRefBucketCache.set(cacheKey, data);
        }
        out.push({ key: crypto.randomUUID?.() || M.uid('k'), data, type: r.type || 'character', strength: Number(r.strength ?? 0.6) });
    }
    return out.length ? out : null;
}`);
    // 角色详情页：支持 NAI 5 精确参考 + 服装参考 + V5 强度 0~5.0
    patch(`      <b>长相参考</b>
      <div class="pc-dim small">绑一组角色参考图，聊天生图带上\${esc(c.name)}时，就照着这组图画出同一个人。只有 NAI 4.5 能用；用上时那张图不加氛围（NovelAI 不能两个一起用）。</div>
      \${!N.charRefSupported() ? '<div class="pc-warn pc-mt-s">现在用不了：要选 NAI 4.5 模型，而且不能是「用酒馆里的 key」。</div>' : ''}
      \${(() => {
        const g = c.charRef && d.charRefGroups?.[c.charRef];
        const TYPES = [['character', '只参考长相'], ['both', '长相和画风'], ['style', '只参考画风']];
        return \`<div class="pc-chips wrap"><button class="pc-pill \${!g ? 'on' : 'dashed'}" data-act="charrefpick" data-id="">不用</button>\${Object.values(d.charRefGroups || {}).map(x => \`<button class="pc-pill \${g && g.id === x.id ? 'on' : 'dashed'}" data-act="charrefpick" data-id="\${x.id}" data-lp="crgroup">\${esc(x.name)}</button>\`).join('')}
        <label class="pc-pill dashed">＋ 新的一组<input type="file" accept="image/*" data-charrefup hidden></label></div>
        \${g ? \`<div class="pc-row-between pc-mt-s"><span class="pc-dim small">「\${esc(g.name)}」· \${g.refs.length} 张</span><label class="pc-pill dashed tiny">＋ 加图<input type="file" accept="image/*" multiple data-cradd="\${g.id}" hidden></label></div>
        \${g.refs.map((r, i) => \`<div class="pc-vrow"><div class="pc-vthumb"><img src="\${esc('/' + r.path)}" alt=""></div>
          <div class="pc-grow"><div class="pc-row-between"><select class="pc-mini-select" data-crtype="\${g.id}:\${i}">\${TYPES.map(([v, t]) => \`<option value="\${v}" \${v === (r.type || 'character') ? 'selected' : ''}>\${t}</option>\`).join('')}</select><button class="pc-x" data-act="crdel" data-g="\${g.id}" data-i="\${i}" aria-label="删掉">×</button></div>
          <label class="pc-slider"><span>像不像</span><input type="range" min="0" max="1" step="0.01" value="\${Number(r.strength ?? 0.6)}" data-crstr="\${g.id}:\${i}"><b>\${Number(r.strength ?? 0.6).toFixed(2)}</b></label></div></div>\`).join('') || '<div class="pc-dim small pc-mt-s">这组还没有图，点「＋ 加图」。最好是单人、看得清脸和衣服。</div>'}
        <div class="pc-hint">「像不像」越大越像参考图，太大会不听提示词，一般 0.5 到 0.8。长按组名可以改名或删除。</div>\` : ''}\`;
      })()}`,
    `      <b>精确参考（长相 / 服装 / 画风）</b>
      <div class="pc-dim small">绑一组参考图，聊天生图带上\${esc(c.name)}时照着画（可同组混搭长相图 + 服装图）。支持 NAI 4.5 和 NAI 5；用上时那张图不加氛围。</div>
      \${!N.charRefSupported() ? '<div class="pc-warn pc-mt-s">现在用不了：要选 NAI 4.5 或 NAI 5 模型，而且不能是「用酒馆里的 key」。</div>' : ''}
      \${(() => {
        const g = c.charRef && d.charRefGroups?.[c.charRef];
        const isV5 = String(N.settings().novelaimode || '').includes('nai-diffusion-5');
        const TYPES = isV5 ? PRECISE_REF_TYPES_V5 : PRECISE_REF_TYPES_V45;
        const maxStr = isV5 ? 5 : 1, stepStr = isV5 ? 0.05 : 0.01;
        return \`<div class="pc-chips wrap"><button class="pc-pill \${!g ? 'on' : 'dashed'}" data-act="charrefpick" data-id="">不用</button>\${Object.values(d.charRefGroups || {}).map(x => \`<button class="pc-pill \${g && g.id === x.id ? 'on' : 'dashed'}" data-act="charrefpick" data-id="\${x.id}" data-lp="crgroup">\${esc(x.name)}</button>\`).join('')}
        <label class="pc-pill dashed">＋ 新的一组<input type="file" accept="image/*" data-charrefup hidden></label></div>
        \${g ? \`<div class="pc-row-between pc-mt-s"><span class="pc-dim small">「\${esc(g.name)}」· \${g.refs.length} 张</span><label class="pc-pill dashed tiny">＋ 加图<input type="file" accept="image/*" multiple data-cradd="\${g.id}" hidden></label></div>
        \${g.refs.map((r, i) => \`<div class="pc-vrow"><div class="pc-vthumb"><img src="\${esc('/' + r.path)}" alt=""></div>
          <div class="pc-grow"><div class="pc-row-between"><select class="pc-mini-select" data-crtype="\${g.id}:\${i}">\${TYPES.map(([v, t]) => \`<option value="\${v}" \${v === (r.type || 'character') ? 'selected' : ''}>\${t}</option>\`).join('')}</select><button class="pc-x" data-act="crdel" data-g="\${g.id}" data-i="\${i}" aria-label="删掉">×</button></div>
          <label class="pc-slider"><span>强度</span><input type="range" min="0" max="\${maxStr}" step="\${stepStr}" value="\${clampDirectorStrength(r.strength ?? 0.6, isV5)}" data-crstr="\${g.id}:\${i}"><b>\${clampDirectorStrength(r.strength ?? 0.6, isV5).toFixed(2)}</b></label></div></div>\`).join('') || '<div class="pc-dim small pc-mt-s">这组还没有图，点「＋ 加图」。V5 可同组添加多张图分别设为长相参考和服装参考。</div>'}
        <div class="pc-hint">\${isV5 ? 'NAI 5 支持「只参考服装」「优先同服装」，强度最高可调至 5.0（画风/服装参考不够像时可适当调高到 1.0 以上）。' : '「强度」越大越像参考图，一般 0.5 到 0.8。'}长按组名可以改名或删除。</div>\` : ''}\`;
      })()}`);
    // 独立角色参考页（兼容保留视图）同步支持 V5
    patch(`    const TYPES = [['character', '只参考长相'], ['both', '长相和画风'], ['style', '只参考画风']];`,
        `    const isV5 = String(N.settings().novelaimode || '').includes('nai-diffusion-5');
    const TYPES = isV5 ? PRECISE_REF_TYPES_V5 : PRECISE_REF_TYPES_V45;
    const maxStr = isV5 ? 5 : 1, stepStr = isV5 ? 0.05 : 0.01;`);
    patch(`<div class="pc-dim small">给一张角色图，让 NovelAI 照着画出同一个人。只有 NAI 4.5 能用；开着时氛围会暂停。</div>`,
        `<div class="pc-dim small">给参考图，让 NovelAI 照着画出同一个人或服装。支持 NAI 4.5 和 NAI 5；开着时氛围会暂停。</div>`);
    patch(`<div class="pc-card pc-pad pc-mt pc-warn-card">现在用不了：要选 NAI 4.5 模型，而且不能是「用酒馆里的 key」。</div>`,
        `<div class="pc-card pc-pad pc-mt pc-warn-card">现在用不了：要选 NAI 4.5 或 NAI 5 模型，而且不能是「用酒馆里的 key」。</div>`);
    patch(`<label class="pc-slider"><span>像不像</span><input type="range" min="0" max="1" step="0.01" value="\${Number(r.strength ?? 0.6)}" data-crstr="\${show.id}:\${i}"><b>\${Number(r.strength ?? 0.6).toFixed(2)}</b></label>`,
        `<label class="pc-slider"><span>强度</span><input type="range" min="0" max="\${maxStr}" step="\${stepStr}" value="\${clampDirectorStrength(r.strength ?? 0.6, isV5)}" data-crstr="\${show.id}:\${i}"><b>\${clampDirectorStrength(r.strength ?? 0.6, isV5).toFixed(2)}</b></label>`);
    patch("    return Math.abs(t.weight - 1) < 0.001 ? t.text : `${fmtWeight(t.weight)}::${t.text}::`;",
        "    return Math.abs(t.weight - 1) < 0.001 ? t.text : formatWeightTag(fmtWeight(t.weight), t.text);");
    patch("        .map(({ a, w }) => Math.abs(w - 1) < 0.001 ? a.tag : `${fmtWeight(w)}::${a.tag}::`);",
        "        .map(({ a, w }) => Math.abs(w - 1) < 0.001 ? a.tag : formatWeightTag(fmtWeight(w), a.tag));");
    patch("        .map(t => t.raw || (Math.abs(t.weight - 1) < 0.001 ? t.text : `${M.fmtWeight(t.weight)}::${t.text}::`)).join(', ');",
        "        .map(t => t.raw ? guardWeightSpacing(t.raw) : (Math.abs(t.weight - 1) < 0.001 ? t.text : formatWeightTag(M.fmtWeight(t.weight), t.text))).join(', ');");
    patch("function buildParameters({ positive, negative, width, height, seed, chars = [], refs = null, director = null }) {",
        "function buildParameters({ positive, negative, width, height, seed, chars = [], refs = null, director = null }) {\n    positive = guardWeightSpacing(positive);\n    negative = guardWeightSpacing(negative);\n    chars = (chars || []).map(c => ({ ...c, prompt: guardWeightSpacing(c.prompt), uc: guardWeightSpacing(c.uc || '') }));");
    patch("        body: JSON.stringify({ input: opts.positive, model, action: 'generate', parameters: params, use_new_shared_trial: true }),",
        "        body: JSON.stringify({ input: guardWeightSpacing(opts.positive), model, action: 'generate', parameters: params, use_new_shared_trial: true }),");
    patch("            prompt: opts.positive, model, sampler: params.sampler, scheduler: params.noise_schedule, steps: params.steps, scale: params.scale,\n            width: params.width, height: params.height, negative_prompt: opts.negative, decrisper: false,",
        "            prompt: guardWeightSpacing(opts.positive), model, sampler: params.sampler, scheduler: params.noise_schedule, steps: params.steps, scale: params.scale,\n            width: params.width, height: params.height, negative_prompt: guardWeightSpacing(opts.negative), decrisper: false,");
    patch("if (String(s.UCP_novelai) === 'custom') r.ucp = String(s.UCP_custom || '').trim();",
        "r.ucp = resolveUcpText(s, r.ucp);");
    patch("    const o = [['', '不加'], ['custom', '自定义'], ['Heavy', '重（Heavy）'], ['Light', '轻（Light）']];",
        "    const o = [['', '不加'], ['custom', '自定义'], ...normalizeUcpPresets(s.UCP_presets).map(p => [UCP_PRESET_PREFIX + p.id, '预设 · ' + p.name]), ['Heavy', '重（Heavy）'], ['Light', '轻（Light）']];");
    patch(
        `      \${ucpVal === 'custom' ? \`<textarea class="pc-textarea small mono" data-ucp-custom placeholder="自己写的固定负面，比如 lowres, bad hands, watermark, text">\${esc(s.UCP_custom || '')}</textarea>
      <div class="pc-hint">每次出图都加在负面最前面：生图页、聊天标记出图、例图、试穿都带上。</div>\` : pv.ucp ? \`<p class="pc-quote small mono">\${esc(pv.ucp)}</p>\` : ''}\`)}`,
        `      \${(() => {
        const up = findUcpPreset(s.UCP_presets, ucpVal);
        if (ucpVal === 'custom' || up) {
          const val = up ? up.text : (s.UCP_custom || '');
          return \`<textarea class="pc-textarea small mono" data-ucp-custom placeholder="自己写的固定负面，比如 lowres, bad hands, watermark, text">\${esc(val)}</textarea>
          <div class="pc-actions wrap pc-mt-s">
            <button class="pc-pill tiny on" data-act="ucp-saveas">\${up ? '另存为新预设' : '另存为预设'}</button>
            \${up ? '<button class="pc-pill tiny" data-act="ucp-rename">改名</button><button class="pc-pill tiny danger" data-act="ucp-del">删除预设</button>' : ''}
          </div>
          <div class="pc-hint">每次出图都加在负面最前面：生图页、聊天标记出图、例图、试穿都带上。\${up ? '修改当前预设会自动保存。' : ''}</div>\`;
        }
        return pv.ucp ? \`<p class="pc-quote small mono">\${esc(pv.ucp)}</p><div class="pc-actions wrap pc-mt-s"><button class="pc-pill tiny" data-act="ucp-saveas">另存为自定义预设</button></div>\` : '';
      })()}\`)}`
    );
    patch("if (el.dataset.ucpCustom !== undefined) { N.settings().UCP_custom = el.value; N.save(); updateStudioPreview(); return; }",
        "if (el.dataset.ucpCustom !== undefined) { const ns = N.settings(); const pid = ucpPresetIdOf(ns.UCP_novelai); if (pid) ns.UCP_presets = updateUcpPresetText(ns.UCP_presets, pid, el.value); else ns.UCP_custom = el.value; N.save(); updateStudioPreview(); return; }");
    patch("case 'clearresult': ui.studio.result = null; ui.studio.sent = null; render(); break;",
        `case 'clearresult': ui.studio.result = null; ui.studio.sent = null; render(); break;
            case 'ucp-saveas': {
                const ns = N.settings();
                const cur = findUcpPreset(ns.UCP_presets, ns.UCP_novelai);
                const text = cur ? cur.text : resolveUcpText(ns, E.extras(ns).ucp);
                if (!String(text || '').trim()) { toastr.warning('当前负面固定词是空的', '智库'); break; }
                const defName = cur ? cur.name + ' 副本' : \`负面预设 \${normalizeUcpPresets(ns.UCP_presets).length + 1}\`;
                const name = await promptText('给这个负面固定词预设起个名字', defName);
                if (name == null) break;
                const created = createUcpPreset(ns.UCP_presets, { name, text });
                ns.UCP_presets = created.presets;
                ns.UCP_novelai = created.value;
                N.save(); render();
                toastr.success(\`已保存负面预设「\${created.preset.name}」\`, '智库');
                break;
            }
            case 'ucp-rename': {
                const ns = N.settings();
                const cur = findUcpPreset(ns.UCP_presets, ns.UCP_novelai);
                if (!cur) break;
                const name = await promptText('修改负面预设名称', cur.name);
                if (name == null || !name.trim()) break;
                ns.UCP_presets = renameUcpPreset(ns.UCP_presets, cur.id, name);
                N.save(); render();
                toastr.success('已改名', '智库');
                break;
            }
            case 'ucp-del': {
                const ns = N.settings();
                const cur = findUcpPreset(ns.UCP_presets, ns.UCP_novelai);
                if (!cur) break;
                if (!await confirmBox(\`删掉负面预设「\${cur.name}」？（内容会保留到「自定义」里）\`, { ok: '删除' })) break;
                ns.UCP_custom = cur.text;
                ns.UCP_presets = deleteUcpPreset(ns.UCP_presets, cur.id);
                ns.UCP_novelai = 'custom';
                N.save(); render();
                toastr.success('已删除预设，内容已保留在自定义中', '智库');
                break;
            }`);
}
// 角色外观库：$名字$ 展开、别名、世界书宏 {{zhiku_characters}}、开关与界面提示
s=applyCharLibrary(s);
// TauriTavern / WebView 流畅度与事件逻辑优化：
// 1) 去重启动时双倍 refresh()；2) 增量单楼层 decorate + 批量防抖 addMesButtons，消除 O(N^2) DOM 风暴；
// 3) 串行化 applyCharacterBlocks -> process，避免并发 saveChat() 竞态；4) 切聊天防抖并立即清理流式预生成缓存。
{
    patch("upload:__mod_store.uploadImage,notify:(message,level)=>toastr[level]?.(message,'智库 · 标记生图')",
        "upload:__mod_store.uploadImage,notify:(message,level)=>{const t=P.toastr||window.toastr||globalThis.toastr;const lv=level||'info';console.info('[智库 · 标记生图]',lv,message);if(t&&typeof t[lv]==='function'){t[lv](message,'智库 · 标记生图',{timeOut:lv==='error'?6000:3500});}else{const el=DOC.createElement('div');el.textContent='智库 · '+message;el.style.cssText='position:fixed;top:16px;right:16px;z-index:45000;padding:10px 14px;border-radius:8px;background:rgba(20,24,34,.92);color:#fff;font-size:13px;box-shadow:0 4px 16px rgba(0,0,0,.35);pointer-events:none';pcMount(el);setTimeout(()=>el.remove(),3500);}}");
    patch('    setTimeout(() => __mod_marker.refresh(), 0);\n    setTimeout(() => __mod_marker.refresh(), 0);',
        '    setTimeout(() => __mod_marker.refresh(), 0);');
    patch(`function addMesButtons() {
    __mod_marker.decorateAll();
    DOC.querySelectorAll('#chat .mes').forEach(mes => {
        const box = mes.querySelector('.extraMesButtons') || mes.querySelector('.mes_buttons');
        if (!box || box.querySelector('.pc-mes-gen')) return;
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
}`,
    `function attachMesButton(mes) {
    if (!mes) return;
    const box = mes.querySelector('.extraMesButtons') || mes.querySelector('.mes_buttons');
    if (!box || box.querySelector('.pc-mes-gen')) return;
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
}
function addMesButtons(targetId) {
    if (Number.isInteger(targetId)) {
        const mes = DOC.querySelector(\`#chat .mes[mesid="\${targetId}"]\`);
        if (mes) { __mod_marker.decorate(targetId); attachMesButton(mes); }
        return;
    }
    __mod_marker.decorateAll();
    DOC.querySelectorAll('#chat .mes').forEach(attachMesButton);
}
let mesBtnTimer = null, mesBtnFull = false;
const mesBtnQueue = new Set();
function scheduleMesButtons(id) {
    const n = Number(id);
    if (id !== undefined && Number.isInteger(n) && n >= 0) mesBtnQueue.add(n);
    else mesBtnFull = true;
    if (mesBtnQueue.size > 6) mesBtnFull = true;
    if (mesBtnTimer !== null) return;
    mesBtnTimer = setTimeout(() => {
        mesBtnTimer = null;
        const full = mesBtnFull;
        const ids = full ? [] : [...mesBtnQueue];
        mesBtnFull = false;
        mesBtnQueue.clear();
        if (full) addMesButtons();
        else for (const mid of ids) addMesButtons(mid);
    }, 60);
}`);
    patch(`    const onChat = () => setTimeout(() => { __mod_chars.invalidateCharState(); UI.renderChip(); UI.renderStub(); E.applyBindingOnChatChange(); addMesButtons(); }, 300);
    DOC.addEventListener('click', onChatClick, true);
    cleanups.push(() => { DOC.removeEventListener('click', onChatClick, true); DOC.querySelectorAll('.pc-mes-gen, .pc-mes-outfit').forEach(n => n.remove()); });
    const onRendered = id => { setTimeout(addMesButtons, 50); };
    const onUserRendered = id => { onRendered(id); };
    const onEdited = id => { onRendered(id); __mod_chars.invalidateCharState(); void __mod_chars.applyCharacterBlocks(Number(id)); };
    const onSwiped = id => { __mod_chars.invalidateCharState(); void __mod_chars.applyCharacterBlocks(Number(id)); };
    const onDeleted = () => { __mod_chars.invalidateCharState(); };
    const onCharMsg = id => {
        setTimeout(addMesButtons, 50);
        setTimeout(() => { void __mod_chars.applyCharacterBlocks(Number(id)); }, 0);
        setTimeout(() => { void __mod_marker.process(Number(id)); }, 0);
    };`,
    `    let chatTimer = null;
    const onChat = () => {
        __mod_marker.pregenReset?.();
        if (chatTimer !== null) clearTimeout(chatTimer);
        chatTimer = setTimeout(() => { chatTimer = null; __mod_chars.invalidateCharState(); UI.renderChip(); UI.renderStub(); E.applyBindingOnChatChange(); scheduleMesButtons(); }, 250);
    };
    DOC.addEventListener('click', onChatClick, true);
    cleanups.push(() => {
        if (chatTimer !== null) clearTimeout(chatTimer);
        if (mesBtnTimer !== null) clearTimeout(mesBtnTimer);
        DOC.removeEventListener('click', onChatClick, true);
        DOC.querySelectorAll('.pc-mes-gen, .pc-mes-outfit').forEach(n => n.remove());
    });
    const onRendered = id => { scheduleMesButtons(id); };
    const onUserRendered = id => { scheduleMesButtons(id); };
    const onEdited = id => { scheduleMesButtons(id); __mod_chars.invalidateCharState(); void __mod_chars.applyCharacterBlocks(Number(id)); };
    const onSwiped = id => { scheduleMesButtons(id); __mod_chars.invalidateCharState(); void __mod_chars.applyCharacterBlocks(Number(id)); };
    const onDeleted = () => { __mod_chars.invalidateCharState(); };
    const onCharMsg = id => {
        const n = Number(id);
        scheduleMesButtons(n);
        setTimeout(async () => {
            try { await __mod_chars.applyCharacterBlocks(n); } catch (e) { console.warn('[智库] 角色块解析', e); }
            await __mod_marker.process(n);
        }, 0);
    };`);
}
const prefix=`// Generated from the full script; edit build-extension.mjs and shared-upload.js.
export function createRuntime() {
let stopped = false;
const timers = new Set();
function setTimeout(fn, delay, ...args) {
    if (stopped) return null;
    const id = window.setTimeout(() => { timers.delete(id); if (!stopped) fn(...args); }, delay);
    timers.add(id); return id;
}
function clearTimeout(id) { window.clearTimeout(id); timers.delete(id); }
`;
fs.writeFileSync(dir+'/runtime.js',prefix+s+'\n}\n');
const indexSrc = fs.readFileSync('src/index.js', 'utf8').replace("import('./runtime.js')", `import('./runtime.js?v=${VERSION}')`);
fs.writeFileSync(dir+'/index.js', indexSrc);
fs.writeFileSync(dir+'/manifest.json',JSON.stringify({display_name:'智库',loading_order:100,js:'index.js',author:'if love',version:VERSION,homePage:'https://github.com/x007006wjm/zhiku-charlib',auto_update:true,minimum_client_version:'1.14.0',dependencies:[],hooks:{enable:'onEnable',disable:'onDisable',delete:'onDelete'}},null,2)+'\n');
fs.writeFileSync(dir+'/package.json',JSON.stringify({name:'zhiku-tavern-helper',version:VERSION,private:true,type:'module'},null,2)+'\n');
fs.writeFileSync(dir+'/capability-contract.json',JSON.stringify({schemaVersion:1,minimum:{sillytavern:'1.14.0',tavernHelper:null},requirements:[{id:'host-context',owner:'sillytavern',symbol:'SillyTavern.getContext',required:true,fallback:null}]},null,2));
assert(!s.includes('getButtonEvent('));
for(const key of ['piaoce_data.json','piaoce_nai','piaoce_uid','data-share-form'])assert(s.includes(key));
console.log(`Extension ${VERSION} built; storage keys and shared upload preserved.`);
