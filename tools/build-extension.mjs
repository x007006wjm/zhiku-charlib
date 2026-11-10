import {applyImg2imgCompatibility} from './img2img-compat.mjs';
import {applyTauriFetchCompatibility} from './tauri-fetch-compat.mjs';
import {applyPoseInputCompatibility} from './pose-input-compat.mjs';
import {applySharingWardrobeCompatibility} from './sharing-wardrobe-compat.mjs';
import {applyComfyCompatibility} from './comfy-compat.mjs';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {applyMarkers} from './apply-markers.mjs';
import {applyUxFixes} from './ux-fixes.mjs';
import {applyStudioUx} from './studio-ux.mjs';
import {applyImageCharacters} from './image-characters.mjs';
import {applyIllustrationPlans} from './illustration-plans.mjs';
import {applyComic} from './comic.mjs';
import {applyCharLibrary} from './apply-char-lib.mjs';
import {fileURLToPath} from 'node:url';
process.chdir(fileURLToPath(new URL('../', import.meta.url)));
const dir='.';
let s=applyMarkers(JSON.parse(fs.readFileSync('zhiku.script.json','utf8')).content);
function patch(a,b){assert.equal(s.split(a).length,2,a.slice(0,80));s=s.replace(a,()=>b);}
patch("globalThis.__PC_VERSION = '0.6.3';", "globalThis.__PC_VERSION = '0.8.36';");
patch('智库 · 酒馆助手脚本版 v0.6.3','智库 · 原生扩展版 v0.8.36');
patch('    const run = () => {\n        saving = saving.then(writeNow)', '    const run = () => {\n        saveTimer = null;\n        saving = saving.then(writeNow)');
patch('return { getData, onChange, loadData, commit, replaceData, uploadImage, deleteImageFile, imgUrl, fileToDataUrl, urlToDataUrl, shrinkDataUrl };', 'return { getData, onChange, loadData, commit, replaceData, uploadImage, deleteImageFile, imgUrl, fileToDataUrl, urlToDataUrl, shrinkDataUrl, flush: () => saveTimer !== null ? commit({ immediate: true, silent: true }) : saving };');
// Preserve nested API error messages and object details in both response paths.
patch('msg = j.message || j.error || text;', "msg = j.message || j.error?.message || (typeof j.error === 'string' ? j.error : JSON.stringify(j.error)) || text;");
patch('throw new Error(j.message || j.error || t.slice(0, 150));', "throw new Error(j.message || j.error?.message || (typeof j.error === 'string' ? j.error : JSON.stringify(j.error)) || t.slice(0, 150));");
// 所有 NovelAI 出错都带上状态码，429 才能被队列认出来重试
s=s.replaceAll("throw new Error(explain(r.status, new TextDecoder().decode(buf)));","throw Object.assign(new Error(explain(r.status, new TextDecoder().decode(buf))),{status:r.status,retryAfter:r.headers?.get('Retry-After')});");
// 用酒馆里的 key 时，酒馆把 NovelAI 的 429 也报成 500：当成可重试
patch("{status:r.status,retryAfter:r.headers?.get('Retry-After')});\n        let b64","{status:r.status,retryAfter:r.headers?.get('Retry-After'),retryable:r.status===500});\n        let b64");
patch("if (status >= 500) return 'NovelAI 服务器出错了，过一会再试（' + status + '）';","if (status >= 500) return 'NovelAI 服务器出错了，过一会再试（' + status + '）' + (viaTavern ? '。用酒馆里的 key 时，请求太快也会显示成这个' : '');");
// 编码氛围也走同一个队列
patch('async function encodeVibe(imageB64, infoExtracted = 1, model = settings().novelaimode) {','function encodeVibe(...args){return __naiGate.run(()=>encodeVibeRequest(...args));}\nasync function encodeVibeRequest(imageB64, infoExtracted = 1, model = settings().novelaimode) {');
// 关于：名片样式
{
  const a=s.indexOf("    const about = setFold('about', '关于'");
  const b=s.indexOf("\n\n",a);
  assert(a>0&&b>a);
  patch(s.slice(a,b),`    const about = setFold('about', '关于', '智库 v' + (globalThis.__PC_VERSION || ''), \`
      <style>.pc-about-card{text-align:center;padding:22px 10px 10px;border-radius:16px;background:radial-gradient(circle at 50% 0,rgba(201,138,62,.22),transparent 70%)}.pc-about-name{font-family:var(--pc-font-name);font-size:34px;font-weight:800;letter-spacing:.3em;padding-left:.3em;color:var(--pc-ink)}.pc-about-card .pc-subtitle{font-size:13px;margin-top:4px}.pc-about-ver{display:block;margin-top:12px;font:11px var(--pc-font-label);letter-spacing:.25em;color:var(--pc-ink-soft);text-transform:uppercase}.pc-about-card .pc-actions{justify-content:center;margin-top:14px}.pc-about-note{text-align:center;font-size:12px;color:var(--pc-ink-soft);margin-top:12px;line-height:1.7}</style>
      <div class="pc-about-card"><div class="pc-about-name">智库</div><div class="pc-subtitle">二改自从前佬的智绘姬</div>
        <span class="pc-about-ver">v\${esc(globalThis.__PC_VERSION || '')} · if love</span>
        <div class="pc-actions wrap"><a class="pc-btn dark" href="https://github.com/ruoege49-ship-it/zhiku-tavern-helper" target="_blank" rel="noopener">仓库 / 更新</a><a class="pc-btn" href="https://github.com/damoshen123/st-chatu8" target="_blank" rel="noopener">智绘姬原仓库</a></div></div>
      <div class="pc-about-note">看图提取需要能识图的模型 · 原脚本 AFPL v9，署名保留</div>
      <div class="pc-about-note">漫画模式的页面协议和玩法来自「漫画台」预设 · 作者 小鸟游星野（Discord：__takanashi_hoshino__）</div>\`);`);
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
    const GENERAL = /^(\\d+(boy|girl|other)s?|solo|male|female|nsfw|sfw|rating:.*|year \\d{4}|\\d{4}|newest|oldest|recent|early|mid|late|masterpiece|absurdres|highres|lowres|very aesthetic|aesthetic|no[ _]text|artist[ _]collaboration|uncensored|censored|.*quality.*|ultra[ -_]?detailed)$/i;
    const nameLike = t => !/\\s/.test(t) || /^[^\\s()]+ \\((?!medium|style)[^()]+\\)$/i.test(t);
    const out = [];
    let lead = true;
    for (const t of M.tokenize(text)) {
        if (t.isArtist) continue;
        const name = t.text.trim();
        const known = !!M.findArtistByTag(d, 'artist:' + name);
        if (lead && (GENERAL.test(name) || !nameLike(name))) lead = false;
        if ((lead || known) && !GENERAL.test(name) && !name.includes(":") && /[\\p{L}\\p{N}]/u.test(name) && !out.includes(name)) out.push(name);
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
// 队列早就编进了脚本 JSON，src/nai-gate.js 的改动不会再注入：在这里同步「酒馆 key 的 500 也重试」
if(!s.includes('!e.retryable'))patch('catch(e){if(e.status!==429||attempt>=2)throw e;','catch(e){if((e.status!==429&&!e.retryable)||attempt>=2)throw e;');
// 导入场外脚本做的「画师串包」（带例图），只往画师库里加，不替换
patch(`function batchBanWarn(d, text) {`,`/** 导入 zhiku-artist-pack.mjs 打出来的画师串包；同一串、同一张图重复导入会跳过 */
async function importPacks(files) {
    const d = getData();
    let strings = 0, images = 0, skipped = 0, failed = 0;
    const say = msg => toastr.info(msg, '智库 · 导入画师串包', { timeOut: 1500 });
    for (const f of files) {
        let pack;
        try { pack = JSON.parse(await f.text()); } catch { toastr.error(\`\${f.name} 不是画师串包\`, '智库'); continue; }
        if (pack?.app !== 'zhiku-pack' || !Array.isArray(pack.items)) { toastr.error(\`\${f.name} 不是画师串包\`, '智库'); continue; }
        say(\`正在导入 \${f.name}（\${pack.items.length} 串）\`);
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
                const key = \`\${it.key || ''}:\${im.template}:\${im.seed}\`;
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
    toastr.success(\`新增 \${strings} 串、\${images} 张例图\${skipped ? \`，\${skipped} 张以前导过、跳过了\` : ''}\${failed ? \`，\${failed} 张没存上\` : ''}\`, '智库 · 导入画师串包', { timeOut: 6000 });
}
function batchBanWarn(d, text) {`);
patch(`        <label class="pc-btn">导入<input type="file" accept=".json,application/json" data-importdata hidden></label>
      </div>\`);`,`        <label class="pc-btn">导入<input type="file" accept=".json,application/json" data-importdata hidden></label>
        <label class="pc-btn">导入画师串包<input type="file" accept=".json,application/json" multiple data-importpack hidden></label>
      </div>
      <div class="pc-hint">「导入画师串包」用来导入场外脚本 zhiku-artist-pack 生成的画师串和例图，只往画师库里加，不会替换现有的；可以一次选多个文件。</div>\`);`);
patch(`    if (el.matches('[data-importdata]')) {`,`    if (el.matches('[data-importpack]')) {
        const fs = [...el.files];
        el.value = '';
        if (fs.length) await importPacks(fs).catch(e => toastr.error('导入失败：' + e.message, '智库'));
        return;
    }
    if (el.matches('[data-importdata]')) {`);
// 画师串的封面只用它自己的例图，不拿组里单个画师的图顶上
patch(`    const own = pick(t.item.images);
    if (own) return own;
    if (t.type === 'group') {
        for (const m of t.item.members) {
            const a = data.artists[m.artistId];
            const img = a && pick(a.images);
            if (img) return img;
        }
    }
    return null;`,`    return pick(t.item.images) || null;`);
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
        finally { DOC.getElementById('pc-toasts')?.remove(); for (const id of timers) window.clearTimeout(id); timers.clear(); stopped = true; }
    }
};
`);
s=applyUxFixes(s);
s=applyStudioUx(s);
s=applyImageCharacters(s);
s=applyIllustrationPlans(s);
// 生图页的「固定提示词」只出现在预览里，真正生成时被漏掉了：engine.generate 没把 scene 传下去
patch(`async function generate({ pos, neg, width, height }) {
    const { positive, negative } = composeStudio({ pos, neg });`,`async function generate({ pos, neg, scene = '', width, height }) {
    const { positive, negative } = composeStudio({ pos, neg, scene });`);
// 实际发送里写明有没有带氛围 / 角色参考（它们不在提示词里，但会大大改变画面）
patch(`        const r = await N.generate(opts);
        runtime.lastSent = r.sent;`,`        const r = await N.generate(opts);
        const vg = getData().vibeGroups?.[getData().vibeActive];
        runtime.lastSent = { ...r.sent, vibes: opts.refs?.images?.length ? { name: vg?.name || '', n: opts.refs.images.length } : null, director: opts.director?.length || 0 };`);
patch(`        <div class="pc-label">负面</div><p class="pc-quote small mono">\${esc(st.sent.negative)}</p></details>\` : ''}`,`        <div class="pc-label">负面</div><p class="pc-quote small mono">\${esc(st.sent.negative)}</p>
        \${st.sent.vibes ? \`<div class="pc-banwarn">还带了氛围「\${esc(st.sent.vibes.name)}」\${st.sent.vibes.n} 张参考图：画面会往这几张图的色调、构图、质感靠。不想要就到「氛围」选「不用氛围」。</div>\` : ''}
        \${st.sent.director ? \`<div class="pc-banwarn">还带了角色参考 \${st.sent.director} 张：人物长相会往参考图靠。</div>\` : ''}</details>\` : ''}`);
patch(`      <div class="pc-label" style="margin-top:0">正面</div><p class="pc-quote small mono" id="pc-pv-pos">\${pv.pos || '（空）'}</p>`,`      \${d.vibeGroups?.[d.vibeActive]?.vibes?.length && N.vibeSupported() ? \`<div class="pc-banwarn" style="margin-top:0">生成时还会带上氛围「\${esc(d.vibeGroups[d.vibeActive].name)}」\${d.vibeGroups[d.vibeActive].vibes.length} 张参考图，画面会往它们靠。</div>\` : ''}
      <div class="pc-label" style="margin-top:0">正面</div><p class="pc-quote small mono" id="pc-pv-pos">\${pv.pos || '（空）'}</p>`);
// 选图片：手机切出去选图时智库界面可能被重画，原来的文件框没了，选的图就丢了。改成在页面最外层临时放一个文件框
patch(`        root.addEventListener('change', onChangeEv);`,`        root.addEventListener('change', onChangeEv);
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
        }, true);`);
// 加氛围图：先存下来、马上显示，再在后台编码；加几张就提示进度
patch(`                const v = { id: M.uid('vb_'), name: f.name.replace(/\\.\\w+$/, ''), path, strength: 0.6, info: 1, encodings: {} };
                if (N.vibeSupported() && N.isReady()) {`,`                const v = { id: M.uid('vb_'), name: f.name.replace(/\\.\\w+$/, ''), path, strength: 0.6, info: 1, encodings: {} };
                g.vibes.push(v); commit();
                toastr.success(\`已加上「\${v.name}」\${files.length > 1 ? \`（\${files.indexOf(f) + 1}/\${files.length}）\` : ''}\`, '氛围', { timeOut: 1500 });
                if (N.vibeSupported() && N.isReady()) {`);
patch(`                    catch (e) { toastr.warning('先存下了，编码失败：' + e.message + '。生图时会再试。', '氛围'); }
                }
                g.vibes.push(v);`,`                    catch (e) { toastr.warning('先存下了，编码失败：' + e.message + '。生图时会再试。', '氛围'); }
                }`);
// 「批量生成例图」挪到画师库顶部那排按钮里，画师多了不用滑到底
patch(`      <button class="pc-pill \${ui.selecting ? 'on' : 'dashed'}" data-act="selmode">\${ui.selecting ? '退出多选' : '多选'}</button>
      \${ui.selecting ? '' : '<button class="pc-pill dashed" data-act="randstring">随机画师串</button>'}
    </div>`,`    </div>
    <div class="pc-chips wrap pc-book-acts">
      <button class="pc-pill \${ui.selecting ? 'on' : 'dashed'}" data-act="selmode">\${ui.selecting ? '退出多选' : '多选'}</button>
      \${ui.selecting ? '' : '<button class="pc-pill dashed" data-act="nav" data-view="batch">批量生成例图</button><button class="pc-pill dashed" data-act="randstring">随机画师串</button>'}
    </div>`);
patch(`    <div class="pc-center pc-mt"><button class="pc-pill dashed" data-act="nav" data-view="batch">批量生成例图</button></div>`,``);
// 例图模板：统一成正脸、正对镜头的证件照式构图，不同画师之间好比较；旧的默认模板没改过的自动换新
{
  const a=s.indexOf("const BASE = '1boy, solo, male focus, adult';");
  const b=s.indexOf("for (const t of Object.values(DEFAULT_TEMPLATES)) { t.width",a);
  assert(a>0&&b>a);
  const oldBlock=s.slice(a,b);
  patch(oldBlock,`const BASE = '1boy, solo, male focus, adult';
const NEG = '1girl, female, multiple boys, child, text, watermark, signature';
const BG = 'simple background, white background';
// 正脸、正对镜头、居中：每位画师的例图构图一样，只比画风
const FRONT = 'front view, facing viewer, looking at viewer, straight-on, centered, symmetrical composition';
const NOT_FRONT = 'profile, from side, from above, from below, dutch angle, tilted head, head tilt, looking away, looking to the side, three-quarter view, extreme close-up, close-up of eye, cropped head, head out of frame, multiple views';
const DEFAULT_TEMPLATES = {
    sfw_head: { id: 'sfw_head', name: 'SFW 头像', nsfw: false, shot: 'head', positive: \`\${BASE}, portrait, headshot, head and shoulders, \${FRONT}, neutral expression, closed mouth, \${BG}\`, negative: \`\${NEG}, \${NOT_FRONT}, hands\` },
    sfw_bust: { id: 'sfw_bust', name: 'SFW 胸像', nsfw: false, shot: 'bust', positive: \`\${BASE}, upper body, \${FRONT}, standing straight, arms at sides, neutral expression, \${BG}\`, negative: \`\${NEG}, \${NOT_FRONT}\` },
    sfw_full: { id: 'sfw_full', name: 'SFW 立绘', nsfw: false, shot: 'full', positive: \`\${BASE}, full body, standing, \${FRONT}, arms at sides, feet apart, \${BG}\`, negative: \`\${NEG}, \${NOT_FRONT}, cropped\` },
    nsfw_head: { id: 'nsfw_head', name: 'NSFW 头像', nsfw: true, shot: 'head', positive: \`nsfw, \${BASE}, portrait, headshot, head and shoulders, \${FRONT}, blush, sweat, parted lips, half-closed eyes, \${BG}\`, negative: \`\${NEG}, \${NOT_FRONT}, hands\` },
    nsfw_bust: { id: 'nsfw_bust', name: 'NSFW 胸像', nsfw: true, shot: 'bust', positive: \`nsfw, \${BASE}, upper body, \${FRONT}, shirtless, pectorals, nipples, sweat, \${BG}\`, negative: \`\${NEG}, \${NOT_FRONT}\` },
    nsfw_full: { id: 'nsfw_full', name: 'NSFW 立绘', nsfw: true, shot: 'full', positive: \`nsfw, \${BASE}, full body, standing, \${FRONT}, completely nude, penis, \${BG}\`, negative: \`\${NEG}, \${NOT_FRONT}, cropped\` },
};
/** 上一版的默认模板（没改过的会换成上面的新版） */
const OLD_TEMPLATE_TEXT = (() => {
    ${oldBlock.replace(/const DEFAULT_TEMPLATES =/, 'const T =').replace(/^const (BASE|NEG|BG) =/gm, 'const $1 =')}
    return T;
})();
`);
}
patch("    for (const t of Object.values(rawT)) t.shot ||= 'bust';","    for (const [k, old] of Object.entries(OLD_TEMPLATE_TEXT)) if (rawT[k] && rawT[k].positive === old.positive && rawT[k].negative === old.negative) delete rawT[k];\n    for (const t of Object.values(rawT)) t.shot ||= 'bust';");
// 例图用同一个种子：不同画师同一张脸、同一个姿势，只比画风
patch(`    return run({ noVibe: true, positive, negative, width: Number(template.width) || undefined, height: Number(template.height) || undefined });`,
`    const o = getData().options;
    const seed = o.sampleSameSeed === false ? undefined : (Number(o.sampleSeed) > 0 ? Number(o.sampleSeed) : (o.sampleSeed = Math.floor(Math.random() * 4294967294) + 1));
    return run({ noVibe: true, positive, negative, width: Number(template.width) || undefined, height: Number(template.height) || undefined, seed });`);
patch(`      <label class="pc-switch"><input type="checkbox" data-bind-check="batch.skipExisting" \${b.skipExisting ? 'checked' : ''}><span></span>已经有这种例图的画师跳过</label>`,
`      <label class="pc-switch"><input type="checkbox" data-bind-check="batch.skipExisting" \${b.skipExisting ? 'checked' : ''}><span></span>已经有这种例图的画师跳过</label>
      <label class="pc-switch"><input type="checkbox" data-opt="sampleSameSeed" \${d.options.sampleSameSeed !== false ? 'checked' : ''}><span></span>所有画师用同一个种子<small>同一张脸、同一个姿势，只比画风\${Number(d.options.sampleSeed) > 0 ? \` · 种子 \${d.options.sampleSeed}\` : ''}</small></label>
      \${d.options.sampleSameSeed !== false && Number(d.options.sampleSeed) > 0 ? '<button class="pc-pill dashed tiny" data-act="newsampleseed">换一个种子</button>' : ''}`);
patch("            case 'imgstore':","            case 'newsampleseed': getData().options.sampleSeed = Math.floor(Math.random() * 4294967294) + 1; commit(); render(); break;\n            case 'imgstore':");
patch("    const fake = a => a && NOT_ARTIST.test(a.tag.replace(/^artist:/i, '').trim());","    const fake = a => a && (NOT_ARTIST.test(a.tag.replace(/^artist:/i, '').trim()) || /[<>]/.test(a.tag));");
// 批量：<artist>…</artist><style>…</style> 这种写法、一行里混着画风词的，都不再把每个词当成画师
{
  const a=s.indexOf('function parseBatchLines(text) {');
  const b=s.indexOf('// ───────────── 增删查 ─────────────',a);
  assert(a>0&&b>a);
  patch(s.slice(a,b),`/** 普通词（画风、质量、构图），不是画师名 */
const BATCH_GENERAL = /^(?:\\d+(?:boy|girl|other)s?|solo|male|female|nsfw|sfw|rating:.*|year \\d{4}|\\d{4}|newest|oldest|recent|masterpiece|absurdres|highres|lowres|very aesthetic|aesthetic|no text|uncensored|.*quality.*)$/i;
const BATCH_STYLE_WORD = /\\b(?:background|lighting|light|lights|detailed|details?|emphasis|style|shading|colou?rs?|composition|focus|texture|fabric|depth of field|illustration|anime|realistic|photorealistic|sketch|painting|watercolor|lineart|cinematic|atmosphere|scenery|portrait)\\b/i;
const batchNameLike = t => !/[<>:]/.test(t) && t.split(/\\s+/).length <= 3 && !BATCH_GENERAL.test(t) && !BATCH_STYLE_WORD.test(t);
/** 一个词加上 artist:（保留前面的权重） */
const batchWithArtist = raw => /artist\\s*:/i.test(raw) ? raw : raw.replace(/^(\\s*(?:-?\\d+(?:\\.\\d+)?::)?\\s*[{\\[(]*\\s*)/, '$1artist:');
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
    const SEC = /<([a-z_][\\w-]*)[^>]*>([\\s\\S]*?)<\\/\\1\\s*>/gi;
    if ([...src.matchAll(SEC)].some(m => /artist/i.test(m[1]))) {
        let cur = null, pre = [];
        for (const m of src.matchAll(SEC)) {
            const words = m[2].split(/[,\\n]/).map(t => t.trim()).filter(t => t && !/^<\\/?[\\w-]+>$/.test(t));
            if (/artist/i.test(m[1])) { if (cur) push(batchUnit(cur)); cur = [...words.map(batchWithArtist), ...pre]; }
            else if (cur) cur.push(...words); else pre.push(...words);
        }
        if (cur) push(batchUnit(cur));
        return out;
    }
    for (const line of src.split(/\\n+/).map(x => x.replace(/<\\/?[\\w-]+[^>]*>/g, ' ').trim()).filter(Boolean)) {
        const toks = splitTop(line).map(t => t.trim()).filter(Boolean);
        const bare = t => t.replace(/^\\s*-?\\d+(?:\\.\\d+)?::/, '').replace(/::\\s*$/, '').replace(/[{}\\[\\]]/g, '').trim();
        if (tokenize(line).some(t => t.isArtist)) push(batchUnit([line]));
        else if (!toks.every(t => batchNameLike(bare(t)))) {
            push(batchUnit(toks.map(t => batchNameLike(bare(t)) ? batchWithArtist(t) : t)));
        } else {
            for (const m of parseArtistList(line)) push({ ...m, key: artistKey(m.tag) });
        }
    }
    return out;
}

`);
}
s=applyComic(s);
// 历史生图存进数据文件：emptyData 里没有 history，重开酒馆读数据时被 normalizeData 丢掉了
patch(`        studio: null,
    };`,`        studio: null,
        history: [],      // 历史生图：[{ id, url, thumb, raw, sent, from, at }]
    };`);
patch(`    d.recent = Array.isArray(d.recent) ? d.recent : [];
    return d;`,`    d.recent = Array.isArray(d.recent) ? d.recent : [];
    d.history = Array.isArray(d.history) ? d.history : [];
    return d;`);
// ───── 生图页「入画角色」：从角色库选 user / char / 配角，一个人或几个人（分角色）一起画 ─────
patch(`return { namesOf, castIn, markerPrompt,`,`/** 生图页选的入画角色 → 提示词。cast：[{ key, pos: 'L'|'C'|'R', outfit?: 衣服 id，'' = 不穿固定衣服 }] */
const CAST_X = { L: 0.3, C: 0.5, R: 0.7 };
function studioCastPick(e) {
    const ch = getChar(e.key);
    if (!ch) return null;
    const out = e.outfit === '' ? null : (ch.outfits.find(o => o.id === e.outfit) || currentOutfit(ch));
    return { char: ch, pos: CAST_X[e.pos] ? e.pos : 'C', tags: [tagText(ch.appearance), tagText(out?.tags)].filter(Boolean).join(', '), x: CAST_X[e.pos] ?? 0.5 };
}
function studioCastPrompt({ pos = '', neg = '', scene = '' }, cast) {
    const picks = (cast || []).map(studioCastPick).filter(Boolean);
    if (!picks.length) return { ...E.composeStudio({ pos, neg, scene }), chars: [], picks };
    const chars = picks.map(p => p.char);
    const hasCount = /\\b(?:\\d+(?:boys?|girls?|others?)|no humans)\\b/i.test(pos);
    const negAll = [neg, ...chars.map(c => c.negative)].filter(Boolean).join(', ');
    if (picks.length === 1 || !canSplit()) {
        const lead = picks.length === 1 ? 'solo' : (hasCount ? '' : countTags(chars));
        return { ...E.composeStudio({ pos: M.mergeTags(pos, lead, ...picks.map(p => p.tags)), neg: negAll, scene }), chars: [], picks };
    }
    const r = E.composeStudio({ pos: M.mergeTags(hasCount ? '' : countTags(chars), pos), neg, scene });
    return { ...r, chars: picks.map(p => ({ prompt: soloize(p.tags), uc: p.char.negative || '', center: { x: p.x, y: 0.5 } })), picks };
}
/** 入画角色绑的长相参考组 */
function studioCastRefs(picks) {
    const d = getData();
    return [...new Set((picks || []).map(p => p.char.charRef).filter(id => id && d.charRefGroups?.[id]))];
}

return { studioCastPrompt, studioCastRefs, namesOf, castIn, markerPrompt,`);
patch(`    st.sceneExpand = !!saved.sceneExpand;
    st.loaded = true;`,`    st.sceneExpand = !!saved.sceneExpand;
    st.cast = Array.isArray(saved.cast) ? saved.cast : [];
    st.castByChat = saved.castByChat && typeof saved.castByChat === 'object' ? saved.castByChat : {};
    st.castMemo = saved.castMemo !== false;
    st.loaded = true;`);
patch(`sceneSrc: st.sceneSrc || '', sceneExpand: !!st.sceneExpand };`,`sceneSrc: st.sceneSrc || '', sceneExpand: !!st.sceneExpand, cast: st.cast || [], castByChat: st.castByChat || {}, castMemo: st.castMemo !== false };`);
patch(`function studioParts() {`,`const CAST_POS = { L: '左', C: '中', R: '右' };
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
    return u ? \`<img class="\${cls}" src="\${esc(u)}" alt="" onerror="this.outerHTML='<span class=&quot;\${cls}&quot;>\${letter}</span>'">\` : \`<span class="\${cls}">\${letter}</span>\`;
}
const CAST_CSS = \`<style>
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
</style>\`;
function castFold() {
    const d = getData();
    const list = studioCast().map(e => ({ e, c: C.getChar(e.key) }));
    const n = list.length, split = C.canSplit();
    const mode = n === 0 ? '<b>不选人：</b>就按上面的提示词画，跟以前一样。'
        : n === 1 ? '<b>单人：</b>把这个人的外貌、衣服接在提示词后面（加 solo）。'
        : split ? \`<b>\${n} 人：</b>每个人的外貌单独发给 NAI（分角色），发色瞳色不会串到别人身上；人数词自动补上。\`
        : \`<b>\${n} 人：</b>现在的模型或通道（V3 / 酒馆里的 key）不能分角色，几个人的外貌会按顺序接在一起，容易串色。\`;
    const rows = list.map(({ e, c }) => {
        const look = C.tagText(c.appearance);
        const ref = c.charRef && d.charRefGroups?.[c.charRef];
        const fitOn = id => e.outfit === undefined ? C.currentOutfit(c)?.id === id : e.outfit === id;
        const k = esc(e.key);
        return \`<div class="pc-castrow"><div class="pc-castrow-top">\${castAv(c)}<b>\${esc(c.name)}</b>
            \${n > 1 && split ? \`<span class="pc-seg pc-castseg">\${['L', 'C', 'R'].map(v => \`<button class="\${(e.pos || 'C') === v ? 'on' : ''}" data-act="castpos" data-key="\${k}" data-v="\${v}">\${CAST_POS[v]}</button>\`).join('')}</span>\` : ''}
            <button class="pc-x" data-act="castrm" data-key="\${k}" aria-label="不画\${esc(c.name)}">×</button></div>
          <div class="pc-casttags mono">\${look ? esc(look) : '这个角色还没写外貌：去「角色」页写一下，或者在提示词里自己写'}</div>
          \${c.outfits.length ? \`<div class="pc-chips wrap">\${c.outfits.map(o => \`<button class="pc-pill tiny \${fitOn(o.id) ? 'on' : 'dashed'}" data-act="castfit" data-key="\${k}" data-id="\${esc(o.id)}">\${esc(o.name)}</button>\`).join('')}<button class="pc-pill tiny \${e.outfit === '' ? 'on' : 'dashed'}" data-act="castfit" data-key="\${k}" data-id="">不穿固定衣服</button></div>\` : ''}
          \${ref ? \`<div class="pc-dim small" style="margin-top:6px">带上长相参考「\${esc(ref.name)}」\${N.charRefSupported() ? '' : '（现在的模型用不了，这次不带）'}</div>\` : ''}</div>\`;
    }).join('');
    return CAST_CSS + fold('cast', '入画角色', n ? list.map(x => x.c.name).join('、') : '不画指定的人', \`
      <div class="pc-castmode">\${mode}</div>\${rows}
      <button class="pc-castadd" data-act="castopen">＋ 从角色库里选人</button>
      <label class="pc-switch"><input type="checkbox" data-cast-memo \${castMemoOn() ? 'checked' : ''}><span></span>记住这次聊天选的人<small>下次打开同一个聊天，自动选好</small></label>\`);
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
        return \`<button class="pc-castpick \${i >= 0 ? 'on' : ''}" data-key="\${esc(c.key)}">\${i >= 0 ? \`<span class="pc-castnum">\${i + 1}</span>\` : ''}\${castAv(c, 'pc-castbig')}<b>\${esc(c.name)}</b><small class="\${look ? '' : 'warn'}">\${look ? KIND[c.kind] || '角色' : '没写外貌'}</small>\${ref ? '<small class="ref">参考图</small>' : ''}</button>\`;
    };
    const close = () => { back.remove(); render(); };
    const draw = () => {
        back.innerHTML = CAST_CSS + \`<section class="pc-sheet" role="dialog" aria-label="选入画角色"><div class="pc-sheet-grip" aria-hidden="true"></div>
          <div class="pc-row-between"><h3 class="pc-h3" style="margin:0">选入画角色</h3><button class="pc-icon-btn" data-c="close" aria-label="关闭">\${ICON.close}</button></div>
          <div class="pc-dim small">点头像选上 / 取消，数字是入画顺序。可以只选一个人，也可以选几个人。</div>
          <div class="pc-castsec">这次聊天</div><div class="pc-castgrid">\${here.map(card).join('') || '<div class="pc-dim small">这次聊天里没有角色</div>'}</div>
          \${others.length ? \`<div class="pc-castsec">角色库里的其他人</div><div class="pc-castgrid">\${others.map(card).join('')}</div>\` : ''}
          <button class="pc-btn dark big pc-mt" data-c="close">好了</button></section>\`;
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
function studioParts() {`);
// 生图页里放进「入画角色」折叠
patch(`      <textarea id="pc-neg" class="pc-textarea small mono" data-bind="studio.neg" placeholder="不想出现的东西，比如 1girl, text">\${esc(st.neg)}</textarea>`,`      <textarea id="pc-neg" class="pc-textarea small mono" data-bind="studio.neg" placeholder="不想出现的东西，比如 1girl, text">\${esc(st.neg)}</textarea>
      <div class="pc-mt-s">\${castFold()}</div>`);
// 预览带上入画角色
patch(`function previewHtml(s) {
    const c = E.composeStudio(studioParts(), s);`,`function previewHtml(s) {
    const cast = studioCast();
    const c = cast.length ? C.studioCastPrompt(studioParts(), cast) : E.composeStudio(studioParts(), s);
    const charLines = (c.chars || []).map((x, i) => \`<br><b>角色\${i + 1}（\${CAST_POS[c.picks[i].pos]}）</b>：\${esc(x.prompt)}\`).join('');`);
patch(`    return { pos: esc(c.positive) + (wait ?`,`    return { pos: esc(c.positive) + charLines + (wait ?`);
// 生成：选了人就按分角色发，带上他们的长相参考
patch(`        st.result = await E.generate(studioParts());
        st.sent = E.runtime.lastSent;`,`        const cast = studioCast();
        if (cast.length) {
            const p = C.studioCastPrompt(studioParts(), cast);
            const ids = C.studioCastRefs(p.picks);
            st.result = await E.generateFull({ ...studioParts(), positive: p.positive, negative: p.negative, chars: p.chars, director: ids.length ? await E.charRefs(ids) : null });
        } else st.result = await E.generate(studioParts());
        st.sent = E.runtime.lastSent;`);
patch(`            case 'generate': await doGenerate(); break;`,`            case 'generate': await doGenerate(); break;
            case 'castopen': openCastPicker(); break;
            case 'castrm': setStudioCast(studioCast().filter(e => e.key !== el.dataset.key)); render(); break;
            case 'castpos': setStudioCast(studioCast().map(e => e.key === el.dataset.key ? { ...e, pos: el.dataset.v } : e)); render(); break;
            case 'castfit': setStudioCast(studioCast().map(e => e.key === el.dataset.key ? { ...e, outfit: el.dataset.id } : e)); render(); break;`);
patch(`    if (el.dataset.sceneOn !== undefined) {`,`    if (el.dataset.castMemo !== undefined) {
        const st = ui.studio, list = studioCast();
        st.castMemo = el.checked;
        if (el.checked) st.castByChat[C.chatId()] = list; else st.cast = list;
        saveStudio(); render(); return;
    }
    if (el.dataset.sceneOn !== undefined) {`);
patch(`    if (!st.pos.trim()) { toastr.warning('正面提示词是空的', '生成图片'); return; }`,`    if (!st.pos.trim() && !studioCast().length) { toastr.warning('正面提示词是空的', '生成图片'); return; }`);
// 中转站兼容：有的第三方站点不认分角色（char_captions / 坐标）和角色参考，聊天里出图变成满屏噪点。打开后合成一段发
patch(`async function generateRequest(opts) {
    const s = settings();`,`async function generateRequest(opts) {
    const s = settings();
    if (!opts.comic && s.naiMode === 'site' && String(s.naiSiteSimple) === 'true') {
        const cs = opts.chars || [];
        opts = {
            ...opts, chars: [], director: null,
            positive: cs.length ? [opts.positive, ...cs.map(c => c.prompt)].filter(Boolean).join(', ') : opts.positive,
            negative: cs.length ? [opts.negative, ...cs.map(c => c.uc)].filter(Boolean).join(', ') : opts.negative,
        };
    }`);
patch(`      <label class="pc-field"><span>站点给的 key</span><input data-st="naiSiteKey" type="password" value="\${esc(n.naiSiteKey)}"></label>\` : ''}`,`      <label class="pc-field"><span>站点给的 key</span><input data-st="naiSiteKey" type="password" value="\${esc(n.naiSiteKey)}"></label>
      <label class="pc-switch"><input type="checkbox" data-st-check="naiSiteSimple" \${String(n.naiSiteSimple) === 'true' ? 'checked' : ''}><span></span>中转站兼容模式<small>生图页正常、聊天里出图却是满屏噪点 / 乱码图时打开：几个人的外貌合成一段发，不带长相参考图（有些中转站不支持分角色和角色参考）。漫画不受影响。</small></label>\` : ''}`);
// ───── 固定提示词可以存多段：起名存下、最近用过自动记，点一下换上 ─────
patch(`    st.castMemo = saved.castMemo !== false;
    st.loaded = true;`,`    st.castMemo = saved.castMemo !== false;
    st.scenes = Array.isArray(saved.scenes) ? saved.scenes : [];
    st.recentScenes = Array.isArray(saved.recentScenes) ? saved.recentScenes : [];
    st.loaded = true;`);
patch(`castMemo: st.castMemo !== false };`,`castMemo: st.castMemo !== false, scenes: st.scenes || [], recentScenes: st.recentScenes || [] };`);
patch(`function studioParts() {`,`/** 现在的固定提示词 */
function sceneSnapshot() {
    const st = ui.studio;
    return { scene: String(st.scene || '').trim(), sceneEn: st.sceneEn || '', sceneSrc: st.sceneSrc || '', at: Date.now() };
}
const sceneSig = p => String(p.scene || '').toLowerCase().replace(/[\\s，,]+/g, ',');
const sceneName = text => String(text || '').split(/[,，\\n]/).map(s => s.trim()).filter(s => s && !/quality|masterpiece|highres|absurdres|detailed/i.test(s)).slice(0, 3).join(', ').slice(0, 24);
function rememberScene() {
    const st = ui.studio, p = sceneSnapshot();
    if (st.sceneOn === false || !p.scene) return;
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
function sceneRow(p, i, kind) {
    const cur = sceneSig(p) === sceneSig(sceneSnapshot());
    const title = kind === 'saved' ? p.name || '没起名' : new Date(p.at).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
    return \`<div class="pc-promptrow \${cur ? 'cur' : ''}">
      <div class="pc-grow"><b>\${esc(title)}\${cur ? ' <em>在用</em>' : ''}</b><small class="mono">\${esc(p.scene)}</small></div>
      <div class="pc-promptacts">\${cur ? '' : \`<button class="pc-pill tiny on" data-act="sceneuse" data-kind="\${kind}" data-i="\${i}">换上</button>\`}
        \${kind === 'recent' ? \`<button class="pc-pill tiny dashed" data-act="scenekeep" data-i="\${i}">存下</button>\` : \`<button class="pc-pill tiny dashed" data-act="scenerename" data-i="\${i}">改名</button>\`}
        <button class="pc-x" data-act="scenedel" data-kind="\${kind}" data-i="\${i}" aria-label="删掉">×</button></div></div>\`;
}
function sceneLibrary() {
    const st = ui.studio;
    const saved = st.scenes || [], recent = st.recentScenes || [];
    return \`<style>
.pc-promptrow{display:flex;gap:8px;align-items:flex-start;background:var(--pc-paper-2);border-radius:14px;padding:9px 10px;margin-top:7px}
.pc-promptrow.cur{box-shadow:inset 0 0 0 1.5px var(--pc-ink)}
.pc-promptrow b{display:block;font-size:14px}
.pc-promptrow b em{font-style:normal;font-size:11px;font-weight:400;color:var(--pc-ink-soft);margin-left:4px}
.pc-promptrow small{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;font-size:11.5px;line-height:1.5;color:var(--pc-ink-soft);word-break:break-word}
.pc-promptacts{display:flex;flex-wrap:wrap;gap:4px;justify-content:flex-end;align-items:center;max-width:132px}
.pc-promptsec{font-size:11px;letter-spacing:.3em;color:var(--pc-ink-soft);margin:12px 0 0}
.pc-recent-scenes>summary{cursor:pointer;font-size:12px;color:var(--pc-ink-soft);margin-top:12px;list-style:none}
.pc-recent-scenes>summary::-webkit-details-marker{display:none}
</style>
      <div class="pc-actions wrap" style="margin-top:8px"><button class="pc-pill dashed" data-act="scenesave">＋ 存下这段</button></div>
      \${saved.length ? '<div class="pc-promptsec">存下的固定提示词</div>' + saved.map((p, i) => sceneRow(p, i, 'saved')).join('') : ''}
      \${recent.length ? \`<details class="pc-recent-scenes" \${ui.studio.open.recentScenes ? 'open' : ''} data-fold="recentScenes"><summary>最近用过 \${recent.length} 条（生成时自动记）▸</summary>\${recent.map((p, i) => sceneRow(p, i, 'recent')).join('')}<div class="pc-actions" style="margin-top:6px"><button class="pc-pill tiny dashed" data-act="sceneclear">清空最近</button></div></details>\` : ''}\`;
}
function studioParts() {`);
patch(`placeholder="中文英文都行。比如：坐在窗边喝咖啡，外面下雨 / 1boy, sitting, window, rain">\${esc(st.scene || '')}</textarea>`,`placeholder="中文英文都行。比如：坐在窗边喝咖啡，外面下雨 / 1boy, sitting, window, rain">\${esc(st.scene || '')}</textarea>
      \${sceneLibrary()}`);
patch(`        } else st.result = await E.generate(studioParts());
        st.sent = E.runtime.lastSent;`,`        } else st.result = await E.generate(studioParts());
        st.sent = E.runtime.lastSent;
        rememberScene();`);
patch(`            case 'castopen': openCastPicker(); break;`,`            case 'castopen': openCastPicker(); break;
            case 'scenesave': {
                const p = sceneSnapshot();
                if (!p.scene) { toastr.info('固定提示词还是空的', '固定提示词'); break; }
                if ((ui.studio.scenes || []).some(x => sceneSig(x) === sceneSig(p))) { toastr.info('这段已经存过了', '固定提示词'); break; }
                const name = await promptText('给这段固定提示词起个名字', sceneName(p.scene));
                if (name == null) break;
                ui.studio.scenes = [{ ...p, name: name.trim() || '没起名' }, ...(ui.studio.scenes || [])];
                ui.studio.recentScenes = (ui.studio.recentScenes || []).filter(x => sceneSig(x) !== sceneSig(p));
                saveStudio(); toastr.success('存好了', '固定提示词', { timeOut: 1500 }); render(); break;
            }
            case 'sceneuse': {
                const p = (el.dataset.kind === 'saved' ? ui.studio.scenes : ui.studio.recentScenes)?.[Number(el.dataset.i)];
                if (!p) break;
                const cur = sceneSnapshot();
                // 现在这段没存过，换掉前先记进「最近用过」，免得丢
                if (cur.scene && ![...(ui.studio.scenes || []), ...(ui.studio.recentScenes || [])].some(x => sceneSig(x) === sceneSig(cur))) ui.studio.recentScenes = [cur, ...(ui.studio.recentScenes || [])].slice(0, 20);
                applyScene(p);
                toastr.info(\`固定提示词换成了\${p.name ? '「' + p.name + '」' : '这一段'}\`, '固定提示词', { timeOut: 1800 }); render(); break;
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
                if (el.dataset.kind === 'saved' && gone && !(await confirmBox(\`删掉「\${gone.name || '没起名'}」？现在框里的固定提示词不受影响。\`, { ok: '删除', cancel: '算了' }))) break;
                ui.studio[key] = list; saveStudio(); render(); break;
            }
            case 'sceneclear': {
                if (!(await confirmBox('清空最近用过的固定提示词？存下的不受影响。', { ok: '清空', cancel: '算了' }))) break;
                ui.studio.recentScenes = []; saveStudio(); render(); break;
            }`);
// 漫画：楼层按钮「画成漫画」——没用漫画台预设也能把已有的楼层改编成漫画
patch(`recordImage: shot => pcRecordImage(shot), askLLM: (...a) => __mod_translate.askLLM(...a),`,`recordImage: shot => pcRecordImage(shot), askLLM: (...a) => __mod_translate.askLLM(...a),
        castText: () => __mod_chars.currentCast().filter(x => x.on || (x.char.appearance || []).length).map(x => \`\${x.char.name}：\${__mod_chars.fixedTags(x.char) || '（还没写外貌，按正文描写画）'}\`).join('\\n'),`);
patch(`        if (!box || box.querySelector('.pc-mes-gen')) return;`,`        if (!box || box.querySelector('.pc-mes-gen')) return;
        const cm = DOC.createElement('div');
        cm.className = 'mes_button pc-mes-comic fa-solid fa-book-open interactable';
        cm.title = '智库：把这一楼画成漫画';
        cm.tabIndex = 0;
        box.prepend(cm);`);
patch(`    const b = ev.target.closest?.('.pc-mes-gen');`,`    const cm = ev.target.closest?.('.pc-mes-comic');
    if (cm) {
        ev.stopPropagation();
        const id = Number(cm.closest('.mes')?.getAttribute('mesid'));
        if (!Number.isFinite(id)) return;
        if (!N.isReady()) { toastr.warning('先到智库设置里填 NovelAI key', '智库 · 漫画'); return; }
        void globalThis.__zhikuComic?.adapt(id);
        return;
    }
    const b = ev.target.closest?.('.pc-mes-gen');`);
// 画师库里混进来的「year 2025」「detailed」这类不是画师的条目：没例图的自动清掉
patch("    const fake = a => a && (NOT_ARTIST.test(a.tag.replace(/^artist:/i, '').trim()) || /[<>]/.test(a.tag));","    const fake = a => a && (NOT_ARTIST.test(a.tag.replace(/^artist:/i, '').trim()) || /^(?:(?:ultra|very|highly|extremely|hyper)[ _-]?)?detailed$|^(?:illustration|anime(?: style)?|best|quality)$/i.test(a.tag.replace(/^artist:/i, '').trim()) || /[<>]/.test(a.tag));");
patch(`    d.history = Array.isArray(d.history) ? d.history : [];
    return d;`,`    d.history = Array.isArray(d.history) ? d.history : [];
    // 一位画师都没有、也没有例图的画师串（批量时把画风词误当成一串）删掉
    for (const g of Object.values(d.groups)) {
        if (g.members.length || g.images.length) continue;
        delete d.groups[g.id];
        if (d.active?.type === 'group' && d.active.id === g.id) d.active = null;
    }
    d.recent = d.recent.filter(r => r.type !== 'group' || d.groups[r.id]);
    return d;`);
// 角色页：英文标签一键翻成中文（外貌 + 这个角色所有衣服），新加的英文标签也自动补上中文
patch(`return { extractCast, hasChinese,`,`/** 英文标签 → 简短中文。返回 { 小写英文: 中文 } */
async function zhForTags(ens) {
    const list = [...new Set((ens || []).map(s => String(s || '').trim()).filter(Boolean))];
    const out = {};
    for (let i = 0; i < list.length; i += 60) {
        const part = list.slice(i, i + 60);
        const j = pickJson(await askLLM('把 NovelAI / Danbooru 英文标签翻成简短自然的中文（一般 2–6 个字），照原意翻，不要解释，每一个都要翻。只输出 JSON：{"zh": {"英文标签": "中文", ...}}', part.join('\\n'), { maxTokens: Math.min(3000, 200 + part.length * 40) }));
        if (Array.isArray(j.zh)) j.zh.forEach((z, k) => { const en = part[k]; const v = String(z?.zh ?? z ?? '').trim(); if (en && v) out[en.toLowerCase()] = v; });
        else if (j.zh && typeof j.zh === 'object') for (const [en, z] of Object.entries(j.zh)) { const v = String(z || '').trim(); if (v) out[en.trim().toLowerCase()] = v; }
    }
    return out;
}
return { zhForTags, extractCast, hasChinese,`);
patch(`      <div class="pc-pairs">\${pairChips(c.appearance, 'app') || '<span class="pc-dim small">还没有</span>'}</div>`,`      \${(() => { const n = charPairs(c).filter(t => !t.zh).length; return n ? \`<div class="pc-chips wrap"><button class="pc-pill dashed tiny" data-act="zhtags" \${busy ? 'disabled' : ''}>\${busy === 'zh' ? '<span class="pc-busy">翻译中</span>' : \`译成中文 · \${n} 个没有中文\`}</button></div>\` : ''; })()}
      <div class="pc-pairs">\${pairChips(c.appearance, 'app') || '<span class="pc-dim small">还没有</span>'}</div>`);
patch(`function pairChips(list, where) {`,`/** 一个角色的全部标签：外貌 + 每一套衣服 */
const charPairs = c => [...(c.appearance || []), ...(c.outfits || []).flatMap(o => o.tags || [])];
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
function pairChips(list, where) {`);
patch(`            ui.charBusy = ''; save();
            return true;
        }
        case 'editpair': {`,`            ui.charBusy = ''; save();
            // 刚加的英文标签悄悄补上中文
            if (charPairs(c).some(t => !t.zh)) void fillZh(c, { quiet: true }).then(n => { if (n && getData().characters[c.key] === c) save(); });
            return true;
        }
        case 'zhtags': {
            ui.charBusy = 'zh'; render();
            try {
                const n = await fillZh(c);
                toastr.success(n ? \`翻好了 \${n} 个\` : 'AI 没给出中文，再点一次试试', '标签翻译', { timeOut: 1800 });
            } catch (e) { toastr.error(e.message || String(e), '翻译失败'); }
            ui.charBusy = ''; if (getData().characters[c.key] === c) save(); else render();
            return true;
        }
        case 'editpair': {`);
// 聊天生图的额外正面词（生图页的固定提示词不会带进聊天，精致度差在这里）
patch("    const base = M.mergeTags(artist, /\\b(?:\\d+(?:boys?|girls?|others?)|no humans)\\b/i.test(scene) ? '' : countTags(chars), scene);", "    const base = M.mergeTags(artist, /\\b(?:\\d+(?:boys?|girls?|others?)|no humans)\\b/i.test(scene) ? '' : countTags(chars), scene, d.options.chatPositive || '');");
patch("hit||__mod_engine.composeStudio({pos:__mod_model.mergeTags(d.active?__mod_model.ticketString(d,d.active):'',prompt),", "hit||__mod_engine.composeStudio({pos:__mod_model.mergeTags(d.active?__mod_model.ticketString(d,d.active):'',prompt,d.options.chatPositive||''),");
patch(`      <label class="pc-field"><span>标记生图额外负面词</span><input data-optstr="chatNegative" value="\${esc(d.options.chatNegative || '')}"></label>`, `      <label class="pc-field"><span>聊天生图额外正面词 · 每张都加在场景后面</span><textarea class="pc-textarea small mono" data-optstr="chatPositive" placeholder="比如 masterpiece, best quality, ultra-detailed, illustration, detailed background, cinematic lighting">\${esc(d.options.chatPositive || '')}</textarea></label>
      <div class="pc-hint">生图页的「固定提示词」只在生图页用，不会带进聊天。生图页更精致、聊天里出图更糙的话，把固定提示词里的画质、画风、光影词（不要写人物外貌和人数）复制到这里。</div>
      <label class="pc-field"><span>聊天生图额外负面词</span><input data-optstr="chatNegative" value="\${esc(d.options.chatNegative || '')}"></label>`);
// 设置：NovelAI 和 AI 放最前面，正文转生图提示词折叠起来
patch("${chat}${illustEditor}${nai}${ai}${tpl}", "${chat}${setFold('illprompt', '正文转生图提示词', d.options.illustPrompt ? '自己改过' : '默认', illustEditor)}${tpl}");
patch('<h2 class="pc-pagetitle">设置</h2><div class="pc-marker-primary"', '<h2 class="pc-pagetitle">设置</h2>${nai}${ai}<div class="pc-marker-primary"');
// 标记自动生图的开关收进「文生图标记」里（放在雾青底上看不清）；图片默认展开的开关由后面的补丁接在它后面
patch(`<div class="pc-marker-primary" style="padding:16px;margin-bottom:16px;border-radius:14px;background:var(--SmartThemeBlurTintColor,rgba(128,128,128,.12))">\${sw('markerAuto', '开启标记自动生图', '默认开启 · 回复出现完整生图标记时自动生成，提示词默认折叠')}</div>\${chat}`, '${chat}');
patch(`      <div class="pc-hint" style="margin-top:0">用开始与结束标记包住提示词`, `      \${sw('markerAuto', '开启标记自动生图', '默认开启 · 回复出现完整生图标记时自动生成，提示词默认折叠')}
      <div class="pc-hint">用开始与结束标记包住提示词`);
// 漫画单独一页：导航「生图」后面加「漫画」，页面里就是漫画设置
patch("const NAV_ORDER = ['studio', 'book',", "const NAV_ORDER = ['studio', 'comic', 'book',");
patch("const navs = [['studio', '生图'], ['book', '画师库'],", "const navs = [['studio', '生图'], ['comic', '漫画'], ['book', '画师库'],");
patch('.pc-nav { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 5px; margin-top: 10px; }', '.pc-nav { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 4px; margin-top: 10px; }\\n.pc-nav .pc-pill { font-size: 13px; padding: 0 2px; letter-spacing: 0; }');
patch("const VIEWS = { cast: viewCast,", `/** 漫画页：漫画设置直接摊开，外加翻看漫画书 */
function viewComic(d) {
    return \`<h2 class="pc-pagetitle">漫画</h2>
      <section class="pc-card pc-pad"><div class="pc-dim small">AI 读楼层的正文改编成漫画，再用 NAI 一页页画出来。楼层按钮里的 📖「画成漫画」、漫画书「目录」里都能挑一楼画。</div>
        <div class="pc-dim small" style="margin-top:6px;opacity:.8">漫画协议和玩法来自「漫画台」预设，作者 小鸟游星野（__takanashi_hoshino__）。</div>
        <div class="pc-actions wrap"><button class="pc-btn dark" data-act="comicbook">翻看这个聊天的漫画</button></div></section>
      <section class="pc-card pc-pad pc-mt"><h3 class="pc-h3">漫画设置</h3><div id="pc-comic-view"></div></section>
      <div style="height:24px"></div>\`;
}
const VIEWS = { comic: viewComic, cast: viewCast,`);
patch("    render.scrollKey = scrollKey;", "    render.scrollKey = scrollKey;\n    if (ui.view === 'comic') { const cv = root.querySelector('#pc-comic-view'); if (cv) globalThis.__zhikuComic?.openSettings(cv); }");
// 生图页：看图写提示词（NovelAI 原图直接读出提示词，普通图交给识图 AI）
patch(`return { zhForTags, extractCast, hasChinese,`,`/** 看图写成 NovelAI 标签（不写画师和质量词） */
async function imageToPrompt(imageDataUrl) {
    const sys = \`你看图，把这张图写成 NovelAI 能直接用的英文标签（Danbooru 风格，逗号隔开）。按顺序写：人数（1girl、2boys、no humans 等）→ 每个人的外貌、衣服、动作、表情、视线 → 构图和镜头（cowboy shot、from above 等）→ 背景和场景 → 光影和色调 → 画面风格特征（watercolor、thick painting 等）。不要写画师名，不要写质量词，看不见的不要编。
只输出 JSON：{"tags": "标签1, 标签2, ...", "zh": "一句话中文描述"}\`;
    const j = pickJson(await askVision(sys, '把这张图写成提示词。', imageDataUrl, { maxTokens: 1500 }));
    const tags = (Array.isArray(j.tags) ? j.tags.join(', ') : String(j.tags || '')).trim();
    if (!tags) throw new Error('AI 没写出标签，换个能识图的模型试试');
    return { positive: tags, negative: '', zh: String(j.zh || '').trim() };
}
return { imageToPrompt, zhForTags, extractCast, hasChinese,`);
patch(`<span class="pc-label" style="margin:0">正面提示词</span><span class="pc-dim small">画师串就是这一整段</span></div>`,`<span class="pc-label" style="margin:0">正面提示词</span><label class="pc-pill dashed tiny" style="cursor:pointer">\${ui.img2pBusy ? '<span class="pc-busy">看图中</span>' : '看图写提示词'}<input type="file" accept="image/*" data-img2prompt hidden \${ui.img2pBusy ? 'disabled' : ''}></label></div>`);
patch(`    if (el.dataset.lookimg !== undefined) {`,`    if (el.dataset.img2prompt !== undefined) {
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
    if (el.dataset.lookimg !== undefined) {`);
patch(`function openSharedUpload() {`,`/** 看图写出来的提示词：改一改，再选怎么填进生图页 */
function showImg2Prompt(r, from) {
    const st = ui.studio;
    const hasArtist = M.parseArtistString(r.positive).members.length > 0;
    const box = modal(\`<h3 class="pc-h3">看图写出的提示词</h3>
      <div class="pc-dim small">\${from === 'meta' ? '这是 NovelAI 原图，直接读出了当时发的提示词' : '识图 AI 看图写的（不含画师和质量词），可以先改一改'}\${r.zh ? '：' + esc(r.zh) : ''}</div>
      <label class="pc-field pc-mt-s"><span>正面</span><textarea class="pc-textarea mono" data-i2p-pos>\${esc(r.positive)}</textarea></label>
      \${r.negative ? \`<label class="pc-field pc-mt-s"><span>负面</span><textarea class="pc-textarea small mono" data-i2p-neg>\${esc(r.negative)}</textarea></label>
      <label class="pc-switch"><input type="checkbox" data-i2p-useneg checked><span></span>负面也换成这个</label>\` : ''}
      <div class="pc-actions wrap">
        <button class="pc-btn dark" data-i2p="replace">换掉正面（保留现在的画师）</button>
        <button class="pc-btn" data-i2p="append">接在正面后面</button>
        \${hasArtist ? '<button class="pc-btn" data-i2p="all">连图里的画师一起用</button>' : ''}
        <button class="pc-btn" data-i2p="copy">复制</button>
        <button class="pc-btn" data-i2p="no">算了</button>
      </div>\`);
    box.addEventListener('click', async ev => {
        const act = ev.target.closest('[data-i2p]')?.dataset.i2p;
        if (!act) return;
        const pos = box.querySelector('[data-i2p-pos]').value.trim();
        if (act === 'no') { box.closeModal(); return; }
        if (act === 'copy') { try { await navigator.clipboard.writeText(pos); toastr.success('复制好了', '看图写提示词', { timeOut: 1200 }); } catch { toastr.info('复制不了，长按文本框自己复制', '看图写提示词'); } return; }
        const keep = M.parseArtistString(st.pos || '').members.map(m => Math.abs(m.weight - 1) < 0.001 ? m.tag : \`\${M.fmtWeight(m.weight)}::\${m.tag}::\`).join(', ');
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
function openSharedUpload() {`);
// ═════ AI 预设：智库让 AI 干活时，按酒馆预设那种结构发；智库的指令放在「上下文」那一格 ═════
patch(`        history: [],      // 历史生图：[{ id, url, thumb, raw, sent, from, at }]`,`        history: [],      // 历史生图：[{ id, url, thumb, raw, sent, from, at }]
        aiPresets: { active: 'tavern:', list: {}, fn: {}, markOn: {} }, // AI 预设：active = plain / tavern:预设名（空 = 酒馆现在用的）/ 自己的预设 id`);
patch(`    d.history = Array.isArray(d.history) ? d.history : [];`,`    d.history = Array.isArray(d.history) ? d.history : [];
    if (!d.aiPresets || typeof d.aiPresets !== 'object') d.aiPresets = { active: 'tavern:', list: {}, fn: {}, markOn: {} };
    d.aiPresets.list ||= {}; d.aiPresets.fn ||= {}; d.aiPresets.markOn ||= {};
    if (typeof d.aiPresets.active !== 'string') d.aiPresets.active = 'tavern:';`);
patch(`async function askLLM(system, user, { maxTokens = 800 } = {}) {
    const api = currentApi();
    if (api.st) {
        const ctx = SillyTavern.getContext();
        if (typeof ctx.generateRaw !== 'function') throw new Error('这个版本的酒馆不支持，请到设置里改用「单独填」');
        const out = String(await ctx.generateRaw({ prompt: user, systemPrompt: system, responseLength: maxTokens }) ?? '');`,`/** 各个让 AI 干活的功能：[键, 名字, 在哪用] */
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
    const s = String(sys || ''), i = s.search(/只输出\\s*JSON|<image> 用分段文本协议/);
    return i > 0 ? [s.slice(0, i).trim(), s.slice(i).trim()] : [s.trim(), ''];
}
/** 功能指令 + 自己加的要求 */
function fnSystem(fn, sys) {
    if (!fn) return sys;
    const [main, fmt] = splitFormat(sys);
    aiSeen[fn] = { main, fmt };
    const extra = (aiCfg().fn[fn]?.extra || []).filter(e => e.on !== false && String(e.t || '').trim());
    return [main, extra.length ? '额外要求：\\n' + extra.map(e => '- ' + e.t.trim()).join('\\n') : '', fmt].filter(Boolean).join('\\n\\n');
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
async function askLLM(system, user, { maxTokens = 800, fn = '' } = {}) {
    const api = currentApi();
    const messages = await aiMessages(fn, system, user);
    let res;
    if (api.st) {
        const ctx = SillyTavern.getContext();
        if (typeof ctx.generateRaw !== 'function') throw new Error('这个版本的酒馆不支持，请到设置里改用「单独填」');
        // ST 1.14.0 generateRaw accepts ordered text messages and keeps backend settings.
        const out = String(await ctx.generateRaw({ prompt: messages, responseLength: maxTokens, trimNames: false }) ?? '');`);
patch(`    if (!api.url) throw new Error('单独填的 AI 没填地址，到设置里填');
    if (!api.model) throw new Error('单独填的 AI 没选模型');
    const messages = [{ role: 'system', content: system }, { role: 'user', content: user }];
    let res;
    if (api.bypass) {`,`    if (!res && !api.url) throw new Error('单独填的 AI 没填地址，到设置里填');
    if (!res && !api.model) throw new Error('单独填的 AI 没选模型');
    if (res) { /* 上面已经照预设发给酒馆了 */ }
    else if (api.bypass) {`);
patch(`async function askVision(system, text, imageDataUrl, { maxTokens = 800 } = {}) {
    const api = currentApi();
    const messages = [
        { role: 'system', content: system },
        { role: 'user', content: [{ type: 'text', text }, { type: 'image_url', image_url: { url: imageDataUrl } }] },
    ];`,`async function askVision(system, text, imageDataUrl, { maxTokens = 800, fn = '' } = {}) {
    const api = currentApi();
    const messages = await aiMessages(fn, system, [{ type: 'text', text }, { type: 'image_url', image_url: { url: imageDataUrl } }]);`);
patch('body: JSON.stringify({ model: api.model, messages, temperature: 0.3, stream: false }),', 'body: JSON.stringify({ model: api.model, messages, temperature: 0.3, stream: false, max_tokens: maxTokens }),');
// 每个调用点标上是哪个功能
patch("    return cleanOutput(await askLLM(expand ? EXPAND : SYSTEM, text, { maxTokens: 600 }));", "    return cleanOutput(await askLLM(expand ? EXPAND : SYSTEM, text, { maxTokens: 600, fn: 'tr' }));");
patch("只挑「${name}」的）：\\n${String(description || '').slice(0, limit)}`, { maxTokens: 8000 });", "只挑「${name}」的）：\\n${String(description || '').slice(0, limit)}`, { maxTokens: 8000, fn: 'look' });");
patch("    const j = await askShrinking(sys, limit => `卡名：${cardName}\\n设定：\\n${String(description || '').slice(0, limit)}`, { maxTokens: 8000 });", "    const j = await askShrinking(sys, limit => `卡名：${cardName}\\n设定：\\n${String(description || '').slice(0, limit)}`, { maxTokens: 8000, fn: 'look' });");
patch("zh.join('\\n'), { maxTokens: Math.min(2400, 300 + zh.length * 80) }));", "zh.join('\\n'), { maxTokens: Math.min(2400, 300 + zh.length * 80), fn: 'tr' }));");
patch("    const j = pickJson(await askLLM(sys, chatText.slice(-6000), { maxTokens: 900 }));", "    const j = pickJson(await askLLM(sys, chatText.slice(-6000), { maxTokens: 900, fn: 'scene' }));");
patch("    const j = pickJson(await askLLM(sys, user, { maxTokens: 600 }));", "    const j = pickJson(await askLLM(sys, user, { maxTokens: 600, fn: 'outfit' }));");
patch("    const j = pickJson(await askLLM(sys, chatText.slice(-6000), { maxTokens: 500 }));", "    const j = pickJson(await askLLM(sys, chatText.slice(-6000), { maxTokens: 500, fn: 'outfit' }));");
patch("    const j = pickJson(await askLLM(sys, chatText.slice(-6000) || '（没有剧情）', { maxTokens: 1500 }));", "    const j = pickJson(await askLLM(sys, chatText.slice(-6000) || '（没有剧情）', { maxTokens: 1500, fn: 'outfit' }));");
patch("    const j = pickJson(await askVision(sys, '提取这张图里的衣服。', imageDataUrl, { maxTokens: 700 }));", "    const j = pickJson(await askVision(sys, '提取这张图里的衣服。', imageDataUrl, { maxTokens: 700, fn: 'outfit' }));");
patch("    const j = pickJson(await askVision(sys, '提取这张图里人物的长相。', imageDataUrl, { maxTokens: 700 }));", "    const j = pickJson(await askVision(sys, '提取这张图里人物的长相。', imageDataUrl, { maxTokens: 700, fn: 'look' }));");
patch("    const j = pickJson(await askLLM(sys, user, { maxTokens: 900 }));", "    const j = pickJson(await askLLM(sys, user, { maxTokens: 900, fn: 'outfit' }));");
patch("part.join('\\n'), { maxTokens: Math.min(3000, 200 + part.length * 40) }));", "part.join('\\n'), { maxTokens: Math.min(3000, 200 + part.length * 40), fn: 'zh' }));");
patch("    const j = pickJson(await askVision(sys, '把这张图写成提示词。', imageDataUrl, { maxTokens: 1500 }));", "    const j = pickJson(await askVision(sys, '把这张图写成提示词。', imageDataUrl, { maxTokens: 1500, fn: 'img' }));");
patch("        askLLM: (...args) => __mod_translate.askLLM(...args), pickJson:", "        askLLM: (s, u, o) => __mod_translate.askLLM(s, u, { ...o, fn: 'ill' }), pickJson:");
patch("recordImage: shot => pcRecordImage(shot), askLLM: (...a) => __mod_translate.askLLM(...a),", "recordImage: shot => pcRecordImage(shot), askLLM: (s, u, o) => __mod_translate.askLLM(s, u, { ...o, fn: 'comic' }),");
// 看图读姿势构图
patch(`return { imageToPrompt, zhForTags,`,`/** 看图只读姿势和构图（带中文） */
async function imagePose(imageDataUrl) {
    const sys = \`你看图，只写人物的姿势和画面构图，写成 NovelAI 标签。
姿势：身体姿势（standing、sitting、leaning forward、lying on side 等）、手和手臂的动作、腿的动作、头的朝向和视线方向；多人时写互动和相对位置（hug、holding hands、back-to-back 等）；表情最多写一两个。
构图：取景范围（full body、cowboy shot、upper body、portrait、close-up 等）、镜头角度（from above、from below、from side、from behind、dutch angle 等）、人物在画面里的位置、透视和景深。
不写长相、衣服、背景、画风、画师。看不清的不要编。
\${PAIRS}
只输出 JSON：{"pose": [...], "composition": [...]}\`;
    const j = pickJson(await askVision(sys, '读这张图的姿势和构图。', imageDataUrl, { maxTokens: 1200, fn: 'pose' }));
    const pose = normPairs(j.pose), composition = normPairs(j.composition);
    if (!pose.length && !composition.length) throw new Error('AI 没读出姿势和构图，换个能识图的模型试试');
    return { pose, composition };
}
return { AI_FNS, aiSeen, aiCfg, splitFormat, stToEntries, tavernPresets, entriesFor, currentTavernPreset, imagePose, imageToPrompt, zhForTags,`);
// 生图页：看图读姿势构图（带中文）
patch(`<label class="pc-pill dashed tiny" style="cursor:pointer">\${ui.img2pBusy ? '<span class="pc-busy">看图中</span>' : '看图写提示词'}<input type="file" accept="image/*" data-img2prompt hidden \${ui.img2pBusy ? 'disabled' : ''}></label></div>`,`<span class="pc-chips" style="margin:0;flex-wrap:wrap;justify-content:flex-end"><label class="pc-pill dashed tiny" style="cursor:pointer">\${ui.img2pBusy ? '<span class="pc-busy">看图中</span>' : '看图写提示词'}<input type="file" accept="image/*" data-img2prompt hidden \${ui.img2pBusy ? 'disabled' : ''}></label><label class="pc-pill dashed tiny" style="cursor:pointer">\${ui.poseBusy ? '<span class="pc-busy">读姿势中</span>' : '看图读姿势构图'}<input type="file" accept="image/*" data-imgpose hidden \${ui.poseBusy ? 'disabled' : ''}></label></span></div>`);
patch(`    if (el.dataset.img2prompt !== undefined) {`,`    if (el.dataset.imgpose !== undefined) {
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
            else if (Array.isArray(j.prompts)) { ents = T.stToEntries(j); name = f.name.replace(/\\.json$/i, ''); }
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
    if (el.dataset.img2prompt !== undefined) {`);
patch(`function openSharedUpload() {`,`/** 看图读出的姿势和构图：挑着用，带中文 */
function showPose(r) {
    const st = ui.studio;
    const all = [...r.pose.map(p => ({ ...p, g: '姿势' })), ...r.composition.map(p => ({ ...p, g: '构图' }))];
    const picked = new Set(all.map((_, i) => i));
    const box = modal('<div data-pose></div>');
    const draw = () => {
        const grp = g => all.map((p, i) => [p, i]).filter(([p]) => p.g === g).map(([p, i]) => \`<button class="pc-pair-pick \${picked.has(i) ? 'on' : ''}" data-pi="\${i}"><span class="mono">\${esc(p.en)}</span>\${p.zh ? \`<em>\${esc(p.zh)}</em>\` : ''}</button>\`).join('') || '<span class="pc-dim small">没读出来</span>';
        box.querySelector('[data-pose]').innerHTML = \`<style>.pc-pair-pick{display:inline-flex;align-items:baseline;gap:6px;margin:0 6px 6px 0;padding:6px 11px;border-radius:999px;border:1.5px dashed var(--pc-dash);background:transparent;color:var(--pc-ink);font-family:var(--pc-font);font-size:13px;cursor:pointer}.pc-pair-pick em{font-style:normal;font-size:12px;color:var(--pc-ink-soft)}.pc-pair-pick.on{border-style:solid;border-color:var(--pc-ink);background:var(--pc-paper-2)}</style>
          <h3 class="pc-h3">图里的姿势和构图</h3><div class="pc-dim small">点标签选上 / 取消，选上的才会用。</div>
          <div class="pc-label">姿势</div><div>\${grp('姿势')}</div>
          <div class="pc-label">构图</div><div>\${grp('构图')}</div>
          <div class="pc-actions wrap">
            <button class="pc-btn dark" data-pa="pos">接在正面后面</button>
            <button class="pc-btn" data-pa="scene">放进固定提示词</button>
            <button class="pc-btn" data-pa="copy">复制</button>
            <button class="pc-btn" data-pa="no">算了</button></div>\`;
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
        else { st.scene = [String(st.scene || '').trim(), tags].filter(Boolean).join(', '); st.sceneOn = true; }
        saveStudio(); box.closeModal(); ui.view = 'studio'; render();
        toastr.success(a === 'pos' ? '接在正面后面了' : '放进固定提示词了', '姿势构图', { timeOut: 1500 });
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
    const chip = (v, t) => \`<button class="pc-pill \${act === v || (v === 'tavern:' && kind === 'tavern') ? 'on' : 'dashed'}" data-act="aipuse" data-v="\${esc(v)}">\${t}</button>\`;
    const entRow = (e, i) => {
        const moveUp = !ro && i > 0, moveDown = !ro && i < ents.length - 1;
        return \`<div class="pc-aient \${e.ctx ? 'ctx' : ''} \${e.mark && !e.on ? 'skip' : ''} \${!e.on && !e.ctx && !e.mark ? 'off' : ''}">
          <button class="pc-airole \${e.r}" data-act="aiprole" data-i="\${i}" \${ro || e.ctx ? 'disabled' : ''}>\${esc(e.r)}</button>
          <div class="pc-grow"><b>\${e.ctx ? '📌 ' : ''}\${esc(e.n)}</b><small>\${e.ctx ? '智库的指令 + 这次要处理的内容放在这里' : e.mark ? (e.on ? '酒馆自动填：' + esc(e.n) + (/worldInfo/.test(e.mark) ? '（世界书暂时带不了）' : '') : '角色卡、世界书这类，默认不发') : esc(String(e.t || '').slice(0, 80))}</small></div>
          \${e.ctx ? '' : \`<button class="pc-aisw \${e.on ? 'on' : ''}" data-act="aipsw" data-i="\${i}" \${ro && !e.mark ? 'disabled' : ''} aria-label="开关"></button>\`}
          \${moveUp ? \`<button class="pc-aiib" data-act="aipmove" data-i="\${i}" data-d="-1" aria-label="上移">↑</button>\` : ''}
          \${moveDown ? \`<button class="pc-aiib" data-act="aipmove" data-i="\${i}" data-d="1" aria-label="下移">↓</button>\` : ''}
          \${e.ctx || e.mark ? '' : \`<button class="pc-aiib" data-act="aipedit" data-i="\${i}">\${ro ? '看' : '✎'}</button>\`}</div>\`;
    };
    const fnRows = T.AI_FNS.map(([k, n, where]) => {
        const f = cfg.fn[k] || { extra: [] }, extra = f.extra || [], seen = T.aiSeen[k];
        const open = ui.aipOpen === k;
        return \`<div class="pc-aifn \${open ? 'open' : ''}"><button class="pc-aifn-h" data-act="aipfn" data-k="\${k}"><span class="pc-grow"><b>\${esc(n)}</b><small>\${esc(where)}\${extra.length ? \` · 加了 \${extra.length} 条要求\` : ''}</small></span><span>\${open ? '⌄' : '›'}</span></button>
          \${open ? \`<div class="pc-aient"><span class="pc-airole tag">内置</span><div class="pc-grow"><b>指令</b><small>\${seen ? esc(seen.main.slice(0, 80)) : '这次打开酒馆后还没用过，用一次就能看到'}</small></div>\${seen ? \`<button class="pc-aiib" data-act="aipseen" data-k="\${k}" data-w="main">看</button>\` : ''}</div>
            \${seen?.fmt ? \`<div class="pc-aient"><span class="pc-airole tag">🔒</span><div class="pc-grow"><b>输出格式</b><small>插件要按这个读 AI 的回复，只能看</small></div><button class="pc-aiib" data-act="aipseen" data-k="\${k}" data-w="fmt">看</button></div>\` : ''}
            \${extra.map((x, i) => \`<div class="pc-aient \${x.on === false ? 'off' : ''}"><span class="pc-airole tag">我的</span><div class="pc-grow"><b>\${esc(x.n || '要求 ' + (i + 1))}</b><small>\${esc(x.t)}</small></div><button class="pc-aisw \${x.on !== false ? 'on' : ''}" data-act="aipxsw" data-k="\${k}" data-i="\${i}" aria-label="开关"></button><button class="pc-aiib" data-act="aipxedit" data-k="\${k}" data-i="\${i}">✎</button></div>\`).join('')}
            <button class="pc-castadd" data-act="aipxadd" data-k="\${k}">＋ 加一条要求</button>
            <div class="pc-dim small">内置指令里会自动填角色名这类东西，所以不能直接改；想让 AI 换个写法，加一条要求就行。</div>\` : ''}</div>\`;
    }).join('');
    return \`<style>
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
        <div class="pc-chips wrap pc-mt-s">\${chip('plain', '不套预设')}\${chip('tavern:', '跟酒馆预设')}\${mine.map(p => chip(p.id, esc(p.name))).join('')}<button class="pc-pill dashed" data-act="aipnew">＋ 新建</button></div>
        \${kind === 'tavern' ? \`<select class="pc-input pc-mt-s" data-aipst><option value="">酒馆现在用的\${curST ? '（' + esc(curST) + '）' : ''}</option>\${(ui.stPresets || []).map(p => \`<option value="\${esc(p.name)}" \${act === 'tavern:' + p.name ? 'selected' : ''}>\${esc(p.name)}</option>\`).join('')}</select>
          <div class="pc-hint">\${ui.stPresetsLoading ? '正在读酒馆的预设…' : ui.stPresetsErr ? '读不到酒馆的预设列表：' + esc(ui.stPresetsErr) : '跟着酒馆的预设「' + esc(stName || '现在用的') + '」走：酒馆里改了这里跟着变，这里只能看（角色卡、世界书那几格能开关）。想自己调，点「复制一份改」。'}</div>\` : ''}
        \${kind === 'plain' ? '<div class="pc-hint">不套预设：只发智库自己的指令，跟以前一样。API 不需要破限时用。</div>' : ''}
        \${kind === 'own' ? \`<div class="pc-hint">智库自己的预设「\${esc(cfg.list[act]?.name || '')}」：条目、角色（点左边切 system / user / assistant）、开关、顺序都能改。</div>\` : ''}
        <div class="pc-actions wrap">
          \${kind === 'tavern' ? '<button class="pc-btn dark" data-act="aipcopy">复制一份改</button>' : ''}
          <label class="pc-btn" style="cursor:pointer">导入文件<input type="file" accept=".json,application/json" data-aipimport hidden></label>
          \${kind === 'own' ? '<button class="pc-btn" data-act="aipexport">导出</button><button class="pc-btn" data-act="aiprename">改名</button><button class="pc-linkdanger" data-act="aipdel">删掉这个预设</button>' : ''}
        </div>
        <div class="pc-hint">只对「翻译和 AI」里用「酒馆现在连接的 API」或「单独填」的聊天补全接口有效；酒馆连的是文本补全时，会把条目合成一段发。</div>
      </section>
      <section class="pc-card pc-pad pc-mt">
        <h3 class="pc-h3" style="margin:0">条目</h3><div class="pc-dim small">从上往下按顺序发。</div>
        \${ents ? ents.map(entRow).join('') : '<div class="pc-dim small pc-mt-s">正在读这个预设…</div>'}
        \${kind === 'own' ? '<button class="pc-castadd" data-act="aipadd">＋ 加一条</button>' : ''}
      </section>
      <section class="pc-card pc-pad pc-mt">
        <h3 class="pc-h3" style="margin:0">各个功能</h3><div class="pc-dim small">这些是放进 📌「上下文」的部分。每个功能都能加自己的要求，所有预设通用。</div>
        \${fnRows}
      </section>
      <div style="height:24px"></div>\`;
}
function openSharedUpload() {`);
patch("const VIEWS = { comic: viewComic,", "const VIEWS = { aipreset: viewAiPreset, comic: viewComic,");
patch(`            case 'castopen': openCastPicker(); break;`,`            case 'castopen': openCastPicker(); break;
            case 'aipuse': { const cfg = T.aiCfg(); cfg.active = el.dataset.v; commit(); render(); break; }
            case 'aipnew': {
                const name = await promptText('新预设的名字', '我的预设');
                if (name == null) break;
                const cfg = T.aiCfg(), id = M.uid('ap');
                cfg.list[id] = { id, name: name.trim() || '我的预设', ents: [{ id: M.uid('e'), n: '主指令', r: 'system', on: true, t: '' }, { id: 'ctx', n: '上下文', r: 'user', on: true, ctx: true }] };
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
                if (!p || !(await confirmBox(\`删掉预设「\${p.name}」？\`, { ok: '删除', cancel: '算了' }))) break;
                delete cfg.list[p.id]; cfg.active = 'tavern:'; commit(); render(); break;
            }
            case 'aipexport': {
                const cfg = T.aiCfg(), p = cfg.list[cfg.active];
                if (!p) break;
                const blob = new Blob([JSON.stringify({ app: 'zhiku-ai-preset', version: 1, name: p.name, ents: p.ents, fn: cfg.fn }, null, 2)], { type: 'application/json' });
                const a = DOC.createElement('a'); a.href = URL.createObjectURL(blob); a.download = \`zhiku_AI预设_\${p.name}.json\`; DOC.body.appendChild(a); a.click(); a.remove();
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
                if (!own) { modal(\`<h3 class="pc-h3">\${esc(e.n)}</h3><div class="pc-dim small">\${esc(e.r)} · 跟着酒馆的预设，这里只能看</div><textarea class="pc-textarea mono" readonly style="min-height:240px">\${esc(e.t || '')}</textarea>\`); break; }
                const name = await promptText('名字', e.n);
                if (name == null) break;
                const t = await promptText(\`「\${name.trim() || e.n}」的内容（留空就删掉这一条）\`, e.t || '', true);
                if (t == null) break;
                if (!t.trim() && await confirmBox('内容空了，删掉这一条？', { ok: '删除', cancel: '留着' })) own.ents.splice(i, 1);
                else { e.n = name.trim() || e.n; e.t = t; }
                commit(); render(); break;
            }
            case 'aipfn': ui.aipOpen = ui.aipOpen === el.dataset.k ? '' : el.dataset.k; render(); break;
            case 'aipseen': { const s = T.aiSeen[el.dataset.k]; if (!s) break; modal(\`<h3 class="pc-h3">\${el.dataset.w === 'fmt' ? '输出格式（只能看）' : '内置指令'}</h3><textarea class="pc-textarea mono" readonly style="min-height:260px">\${esc(el.dataset.w === 'fmt' ? s.fmt : s.main)}</textarea>\`); break; }
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
            }`);
patch(`    if (el.dataset.castMemo !== undefined) {`,`    if (el.matches?.('[data-aipst]')) { T.aiCfg().active = 'tavern:' + el.value; commit(); render(); return; }
    if (el.dataset.castMemo !== undefined) {`);
// 画师串绑定模型：切到这串时自动换模型，切到没绑的串时换回原来的
patch(`      <label class="pc-field pc-mt-s"><span>负面（选这串时一起换上，可不填）</span><textarea class="pc-textarea small mono" data-bind-group="\${g.id}" data-field="neg" placeholder="比如 1girl, text">\${esc(g.neg || '')}</textarea></label>`,`      <label class="pc-field pc-mt-s"><span>负面（选这串时一起换上，可不填）</span><textarea class="pc-textarea small mono" data-bind-group="\${g.id}" data-field="neg" placeholder="比如 1girl, text">\${esc(g.neg || '')}</textarea></label>
      <label class="pc-field pc-mt-s"><span>绑定模型（这串当正文画师串时自动换成这个模型）</span><select class="pc-input" data-bind-group="\${g.id}" data-field="model"><option value="">不绑，跟设置走</option>\${N.MODELS.map(([v, t]) => \`<option value="\${v}" \${g.model === v ? 'selected' : ''}>\${esc(t)}</option>\`).join('')}</select></label>`);
patch(`    cleanups.push(onChange(() => { UI.renderChip(); UI.renderStub(); }));`,`    cleanups.push(onChange(() => { UI.renderChip(); UI.renderStub(); }));
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
            if (!first) toastr.info(\`画师串「\${t.item.name || t.item.tag || ''}」绑定了 \${modelName(want)}，已切过去\`, '智库', { timeOut: 2500 });
        } else if (s.zkModelBefore) {
            const back = s.zkModelBefore;
            delete s.zkModelBefore;
            if (s.novelaimode !== back) { s.novelaimode = back; N.save(); if (!first) toastr.info('换回原来的模型 ' + modelName(back), '智库', { timeOut: 2500 }); }
            else N.save();
        }
    };
    syncModel();
    cleanups.push(onChange(syncModel));`);
// AI 预设：每个功能单独选用哪个 AI（接口 + 模型），不选就跟「翻译和 AI」
patch(`async function askLLM(system, user, { maxTokens = 800, fn = '' } = {}) {
    const api = currentApi();`,`/** 这个功能用哪个 AI：功能里单独选了就用它，没选跟「翻译和 AI」 */
function apiFor(fn) {
    const f = fn ? aiCfg().fn[fn] : null;
    const id = f?.api || '';
    if (!id) return currentApi();
    if (id === 'st') return { st: true, from: '酒馆现在连接的 API' };
    const p = apiProfiles().find(x => x.id === id);
    if (!p) return currentApi();
    const model = String(f.model || '').trim() || (p.model || '').trim();
    return { url: (p.url || '').trim().replace(/\\/+$/, ''), key: (p.key || '').trim(), model, bypass: !!p.bypass, from: p.name + (f.model ? ' · ' + f.model : '') };
}
async function askLLM(system, user, { maxTokens = 800, fn = '' } = {}) {
    const api = apiFor(fn);`);
patch(`async function askVision(system, text, imageDataUrl, { maxTokens = 800, fn = '' } = {}) {
    const api = currentApi();`,`async function askVision(system, text, imageDataUrl, { maxTokens = 800, fn = '' } = {}) {
    const api = apiFor(fn);`);
patch(`return { AI_FNS, aiSeen, aiCfg,`,`return { AI_FNS, apiFor, aiSeen, aiCfg,`);
patch(`        const open = ui.aipOpen === k;
        return \`<div class="pc-aifn \${open ? 'open' : ''}"><button class="pc-aifn-h" data-act="aipfn" data-k="\${k}"><span class="pc-grow"><b>\${esc(n)}</b><small>\${esc(where)}\${extra.length ? \` · 加了 \${extra.length} 条要求\` : ''}</small></span><span>\${open ? '⌄' : '›'}</span></button>
          \${open ? \``,`        const open = ui.aipOpen === k;
        const profiles = T.apiProfiles(), apiId = f.api || '', prof = profiles.find(p => p.id === apiId);
        const apiName = !apiId ? '' : apiId === 'st' ? '酒馆现在连接的' : prof ? prof.name + (f.model ? ' · ' + f.model : '') : '';
        const models = ui.aipModels?.[k] || [];
        const apiPick = \`<div class="pc-aiapi"><label class="pc-field"><span>用哪个 AI</span><select class="pc-input" data-aipapi data-k="\${k}"><option value="">跟「翻译和 AI」一样（现在：\${esc(T.currentApi().from || '')}）</option><option value="st" \${apiId === 'st' ? 'selected' : ''}>酒馆现在连接的 API</option>\${profiles.map(p => \`<option value="\${esc(p.id)}" \${apiId === p.id ? 'selected' : ''}>\${esc(p.name || p.url)}\${p.model ? ' · ' + esc(p.model) : ''}</option>\`).join('')}</select></label>
            \${prof ? \`<label class="pc-field"><span>模型（不填就用这个接口里选的\${prof.model ? '：' + esc(prof.model) : ''}）</span><span class="pc-row" style="gap:6px"><input class="pc-input" data-aipmodel data-k="\${k}" list="pc-aipm-\${k}" value="\${esc(f.model || '')}" placeholder="\${esc(prof.model || '比如 gpt-4o-mini')}"><button class="pc-btn" data-act="aipmodels" data-k="\${k}">\${ui.aipModelsBusy === k ? '…' : '拉取'}</button></span><datalist id="pc-aipm-\${k}">\${models.map(m => \`<option value="\${esc(m)}">\`).join('')}</datalist></label>\${models.length ? \`<div class="pc-chips wrap">\${models.slice(0, 30).map(m => \`<button class="pc-pill tiny \${f.model === m ? 'on' : 'dashed'}" data-act="aipmodelpick" data-k="\${k}" data-m="\${esc(m)}">\${esc(m)}</button>\`).join('')}</div>\` : ''}\` : ''}
            \${!profiles.length ? '<div class="pc-hint">想给这个功能单独配一个 API，先到「设置 → 翻译和 AI」里点「＋」加一个接口。</div>' : ''}
            \${k === 'img' || k === 'pose' ? '<div class="pc-hint">这个功能要看图，选能识图的模型（比如 GPT-4o、Claude、Gemini）。</div>' : ''}</div>\`;
        return \`<div class="pc-aifn \${open ? 'open' : ''}"><button class="pc-aifn-h" data-act="aipfn" data-k="\${k}"><span class="pc-grow"><b>\${esc(n)}</b><small>\${esc(where)}\${apiName ? ' · 用 ' + esc(apiName) : ''}\${extra.length ? \` · 加了 \${extra.length} 条要求\` : ''}</small></span><span>\${open ? '⌄' : '›'}</span></button>
          \${open ? apiPick + \``);
patch(`            case 'aipfn': ui.aipOpen = ui.aipOpen === el.dataset.k ? '' : el.dataset.k; render(); break;`,`            case 'aipfn': ui.aipOpen = ui.aipOpen === el.dataset.k ? '' : el.dataset.k; render(); break;
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
            case 'aipmodelpick': { const f = (T.aiCfg().fn[el.dataset.k] ||= { extra: [] }); f.model = f.model === el.dataset.m ? '' : el.dataset.m; commit(); render(); break; }`);
patch(`    if (el.matches?.('[data-aipst]')) { T.aiCfg().active = 'tavern:' + el.value; commit(); render(); return; }`,`    if (el.matches?.('[data-aipst]')) { T.aiCfg().active = 'tavern:' + el.value; commit(); render(); return; }
    if (el.matches?.('[data-aipapi]')) { const f = (T.aiCfg().fn[el.dataset.k] ||= { extra: [] }); if (f.api !== el.value) { f.model = ''; if (ui.aipModels) delete ui.aipModels[el.dataset.k]; (ui.aipModelSeq ||= {})[el.dataset.k] = (ui.aipModelSeq[el.dataset.k] || 0) + 1; if (ui.aipModelsBusy === el.dataset.k) ui.aipModelsBusy = ''; } f.api = el.value; commit(); render(); return; }
    if (el.matches?.('[data-aipmodel]')) { const f = (T.aiCfg().fn[el.dataset.k] ||= { extra: [] }); f.model = el.value.trim(); commit(); return; }`);
// 下载成功提醒：智库里所有下载（看大图、生图结果、历史生图、漫画、导出数据）
patch(`download.download='image.png';`,`download.download='zhiku_'+Date.now()+'.png';`);
patch(`function updateStudioPreview() {`,`/** 点了智库的下载链接后提示一下；连着下好几张的合成一条 */
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
        const json = /\\.json$/i.test(dlLast);
        const where = json ? '' : isIOS() ? '。在「文件」App 的「下载」里，不在相册；想进相册，到 设置 →「下载和水印」把「手机上点下载」改回「自动」，再从分享面板点「存储图像」' : isAndroid() ? '。存在手机的 Download 文件夹，相册里一般在「Download / 下载」相簿' : '，在浏览器的「下载」里';
        toastr.success(dlCount > 1 ? \`已发起 \${dlCount} 项下载\${where}\` : \`\${json ? '数据' : '图片'}已发起下载：\${dlLast}\${where}\`, '智库', { timeOut: json ? 2500 : 5000 });
        dlCount = 0;
    }, 700);
}
/** 水印：pos = br 右下 / bl 左下 / tr 右上 / tl 左上 / c 正中 / tile 铺满；size 是短边的百分比 */
function drawMark(ctx, w, h, o) {
    const fs = Math.max(12, Math.round(Math.min(w, h) * o.size / 100));
    ctx.save();
    ctx.globalAlpha = Math.min(1, Math.max(0.05, o.alpha));
    ctx.font = \`bold \${fs}px "PingFang SC","Microsoft YaHei",sans-serif\`;
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
    const box = modal(\`<h3 class="pc-h3">图片准备好了</h3><p class="pc-dim small">点下面的按钮打开分享面板，选「存储图像 / 保存到相册」就进相册了。</p>
      <div class="pc-actions"><button class="pc-btn" type="button" data-x="file">下载成文件</button><button class="pc-btn dark" type="button" data-x="share">存到相册 / 分享</button></div>\`);
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
    const fname = (o.strip || o.on) ? name.replace(/\\.(jpe?g|webp)$/i, '.png') : name;
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
    const img = !/\\.json$/i.test(name), o = dlOpts();
    const wantShare = img && ev.isTrusted && !!navigator.canShare && (o.mode === 'share' || (o.mode === 'auto' && isIOS()));
    if (img && (o.strip || o.on || wantShare)) { ev.preventDefault(); ev.stopPropagation(); dlImage(a.href, name, o, wantShare); return; }
    dlNote(name);
}
if (globalThis.__zhikuDl) DOC.removeEventListener('click', globalThis.__zhikuDl, true);
globalThis.__zhikuDl = onDownloadClick;
DOC.addEventListener('click', onDownloadClick, true);
function updateStudioPreview() {`);
// 氛围编码 402：说清楚是 Anlas 不够（Opus 也要扣）
patch(`    if (!r.ok) throw Object.assign(new Error(explain(r.status, new TextDecoder().decode(buf)) + (settings().naiMode === 'site'`,`    if (!r.ok) throw Object.assign(new Error((r.status === 402 ? '账号 Anlas 不够了：氛围每张图第一次用要先编码，NovelAI 每张扣约 2 点 Anlas，Opus 也要扣（编码会按模型保存，复用已保存的编码不再扣编码费）。去官网看看 Anlas 余额，或者导入官网导出的 .naiv4vibe 文件' : explain(r.status, new TextDecoder().decode(buf))) + (settings().naiMode === 'site'`);
// 智库开着时提示显示在智库里
patch(`const toastr = P.toastr || window.toastr;`,`const stToastr = P.toastr || window.toastr;
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
    dot.setAttribute('style', \`flex-shrink:0;width:12px;height:12px;margin-top:5px;border-radius:50%;background:\${color}\`);
    const body = DOC.createElement('div'); body.style.minWidth = '0';
    if (title) { const b = DOC.createElement('b'); b.textContent = title; b.setAttribute('style', \`display:block;font-size:12px;letter-spacing:.1em;color:\${color}\`); body.appendChild(b); }
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
const toastr = { success: (...a) => zkToast('success', ...a), info: (...a) => zkToast('info', ...a), warning: (...a) => zkToast('warning', ...a), error: (...a) => zkToast('error', ...a), clear: (el, ...a) => { const host = DOC.getElementById('pc-toasts'); if (el?.nodeType && host?.contains(el)) { el.remove(); return; } if (!el) host?.remove(); return stToastr?.clear?.(el, ...a); } };`);
// 氛围：NAI 5 不带氛围、失败时说清楚按哪个模型编码、每张显示已编码的模型
patch(`function vibeSupported() {
    const s = settings();
    return s.naiMode !== 'tavern' && s.novelaimode !== 'nai-diffusion-3';
}`,`function vibeSupported() {
    const s = settings();
    return s.naiMode !== 'tavern' && s.novelaimode !== 'nai-diffusion-3' && !String(s.novelaimode).includes('diffusion-5');
}`);
patch(`    if (!g?.vibes?.length || !N.vibeSupported()) return null;
    const key = N.encKey();`,`    if (!g?.vibes?.length) return null;
    if (!N.vibeSupported()) {
        const m = N.settings().novelaimode;
        if (String(m).includes('diffusion-5') && !globalThis.__zkV5VibeTold) { globalThis.__zkV5VibeTold = 1; toastr.info('NAI 5 还不支持氛围，用 5 的时候不带氛围出图（不会产生氛围编码费用）。想带氛围请换回 4.5。', '氛围', { timeOut: 6000 }); }
        return null;
    }
    const key = N.encKey();
    const modelName = (N.MODELS.find(x => x[0] === N.settings().novelaimode)?.[1] || N.settings().novelaimode).replace('NAI Diffusion ', '');
    const keyName = k => ({ 'v4-5full': '4.5 Full', 'v4-5curated': '4.5 Curated', v4full: '4 Full', v4curated: '4 Curated' })[k] || k;`);
patch(`    if (failed.length) toastr.warning(\`氛围「\${failed.join('、')}」编码失败，这张先不带\${list.length ? '它' : '氛围'}出图：\${lastErr?.message || ''}\`, '氛围', { timeOut: 8000 });`,`    if (failed.length) {
        const had = [...new Set(g.vibes.flatMap(v => Object.keys(v.encodings || {}).filter(k => v.encodings[k])))].map(keyName);
        toastr.warning(\`氛围「\${failed.join('、')}」要按 \${modelName} 编码，编码失败，这张先不带\${list.length ? '它' : '氛围'}出图。\${had.length ? \`（这组已经编码过的模型：\${had.join('、')}。换了模型就得重新编码一次）\` : '（这几张还没编码成功过）'}：\${lastErr?.message || ''}\`, '氛围', { timeOut: 9000 });
    }`);
patch(`现在的连接方式或模型用不了氛围（「用酒馆里的 key」和 NAI 3 不支持）。`,`现在的连接方式或模型用不了氛围（「用酒馆里的 key」、NAI 3、NAI 5 都不支持）。`);
patch(`<small class="pc-dim">\${esc(v.name || '参考图 ' + (i + 1))}</small>`,`<small class="pc-dim">\${esc(v.name || '参考图 ' + (i + 1))}<br><span style="font-size:10px">\${(() => { const ks = Object.keys(v.encodings || {}).filter(k => v.encodings[k]); const nm = { 'v4-5full': '4.5 Full', 'v4-5curated': '4.5 Curated', v4full: '4 Full', v4curated: '4 Curated' }; return ks.length ? '已编码：' + ks.map(k => esc(nm[k] || k)).join('、') : (v.path ? '还没编码（第一次用时扣约 2 点 Anlas）' : '官网文件，没有原图'); })()}</span></small>`);
patch('第一次用某张图时 NovelAI 会扣一点点数来编码，之后就不扣了。', '首次为当前模型编码会收取编码费；复用已保存的编码不再收取编码费。');
// 例图模板：去掉人体参考图式的词，写明穿着和上色，免得画成剪影；旧默认没改过的自动换新
patch(`// 正脸、正对镜头、居中：每位画师的例图构图一样，只比画风
const FRONT = 'front view, facing viewer, looking at viewer, straight-on, centered, symmetrical composition';
const NOT_FRONT = 'profile, from side, from above, from below, dutch angle, tilted head, head tilt, looking away, looking to the side, three-quarter view, extreme close-up, close-up of eye, cropped head, head out of frame, multiple views';
const DEFAULT_TEMPLATES = {
    sfw_head: { id: 'sfw_head', name: 'SFW 头像', nsfw: false, shot: 'head', positive: \`\${BASE}, portrait, headshot, head and shoulders, \${FRONT}, neutral expression, closed mouth, \${BG}\`, negative: \`\${NEG}, \${NOT_FRONT}, hands\` },
    sfw_bust: { id: 'sfw_bust', name: 'SFW 胸像', nsfw: false, shot: 'bust', positive: \`\${BASE}, upper body, \${FRONT}, standing straight, arms at sides, neutral expression, \${BG}\`, negative: \`\${NEG}, \${NOT_FRONT}\` },
    sfw_full: { id: 'sfw_full', name: 'SFW 立绘', nsfw: false, shot: 'full', positive: \`\${BASE}, full body, standing, \${FRONT}, arms at sides, feet apart, \${BG}\`, negative: \`\${NEG}, \${NOT_FRONT}, cropped\` },
    nsfw_head: { id: 'nsfw_head', name: 'NSFW 头像', nsfw: true, shot: 'head', positive: \`nsfw, \${BASE}, portrait, headshot, head and shoulders, \${FRONT}, blush, sweat, parted lips, half-closed eyes, \${BG}\`, negative: \`\${NEG}, \${NOT_FRONT}, hands\` },
    nsfw_bust: { id: 'nsfw_bust', name: 'NSFW 胸像', nsfw: true, shot: 'bust', positive: \`nsfw, \${BASE}, upper body, \${FRONT}, shirtless, pectorals, nipples, sweat, \${BG}\`, negative: \`\${NEG}, \${NOT_FRONT}\` },
    nsfw_full: { id: 'nsfw_full', name: 'NSFW 立绘', nsfw: true, shot: 'full', positive: \`nsfw, \${BASE}, full body, standing, \${FRONT}, completely nude, penis, \${BG}\`, negative: \`\${NEG}, \${NOT_FRONT}, cropped\` },
};
`,`// 正脸、居中：每位画师的例图构图一样，只比画风。
// 不再写 symmetrical / arms at sides / feet apart 这类「人体参考图」的词，也写明穿着和上色，免得画成剪影、人台
const FRONT = 'front view, facing viewer, looking at viewer, centered';
const NOT_FRONT = 'profile, from side, from above, from below, dutch angle, looking away, three-quarter view, extreme close-up, cropped head, head out of frame, multiple views';
const NOT_FLAT = 'silhouette, monochrome, greyscale, mannequin, faceless, reference sheet, character sheet, turnaround, anatomy chart, flat color, solid color, blank eyes';
const CLOTHED = 'detailed face, detailed eyes, casual clothes, shirt, pants, full color';
const DEFAULT_TEMPLATES = {
    sfw_head: { id: 'sfw_head', name: 'SFW 头像', nsfw: false, shot: 'head', positive: \`\${BASE}, portrait, headshot, head and shoulders, \${FRONT}, detailed face, detailed eyes, shirt, light smile, \${BG}\`, negative: \`\${NEG}, \${NOT_FRONT}, \${NOT_FLAT}, hands\` },
    sfw_bust: { id: 'sfw_bust', name: 'SFW 胸像', nsfw: false, shot: 'bust', positive: \`\${BASE}, upper body, \${FRONT}, \${CLOTHED}, \${BG}\`, negative: \`\${NEG}, \${NOT_FRONT}, \${NOT_FLAT}\` },
    sfw_full: { id: 'sfw_full', name: 'SFW 立绘', nsfw: false, shot: 'full', positive: \`\${BASE}, full body, standing, \${FRONT}, \${CLOTHED}, shoes, \${BG}\`, negative: \`\${NEG}, \${NOT_FRONT}, \${NOT_FLAT}, cropped\` },
    nsfw_head: { id: 'nsfw_head', name: 'NSFW 头像', nsfw: true, shot: 'head', positive: \`nsfw, \${BASE}, portrait, headshot, head and shoulders, \${FRONT}, detailed face, detailed eyes, blush, sweat, parted lips, half-closed eyes, \${BG}\`, negative: \`\${NEG}, \${NOT_FRONT}, \${NOT_FLAT}, hands\` },
    nsfw_bust: { id: 'nsfw_bust', name: 'NSFW 胸像', nsfw: true, shot: 'bust', positive: \`nsfw, \${BASE}, upper body, \${FRONT}, detailed face, shirtless, pectorals, nipples, sweat, \${BG}\`, negative: \`\${NEG}, \${NOT_FRONT}, \${NOT_FLAT}\` },
    nsfw_full: { id: 'nsfw_full', name: 'NSFW 立绘', nsfw: true, shot: 'full', positive: \`nsfw, \${BASE}, full body, standing, \${FRONT}, detailed face, completely nude, penis, \${BG}\`, negative: \`\${NEG}, \${NOT_FRONT}, \${NOT_FLAT}, cropped\` },
};
/** 0.8.x 的「证件照式」默认模板（没改过的换成上面的新版） */
const OLD_TEMPLATE_TEXT2 = (() => {
    // 正脸、正对镜头、居中：每位画师的例图构图一样，只比画风
    const FRONT = 'front view, facing viewer, looking at viewer, straight-on, centered, symmetrical composition';
    const NOT_FRONT = 'profile, from side, from above, from below, dutch angle, tilted head, head tilt, looking away, looking to the side, three-quarter view, extreme close-up, close-up of eye, cropped head, head out of frame, multiple views';
    const T = {
        sfw_head: { id: 'sfw_head', name: 'SFW 头像', nsfw: false, shot: 'head', positive: \`\${BASE}, portrait, headshot, head and shoulders, \${FRONT}, neutral expression, closed mouth, \${BG}\`, negative: \`\${NEG}, \${NOT_FRONT}, hands\` },
        sfw_bust: { id: 'sfw_bust', name: 'SFW 胸像', nsfw: false, shot: 'bust', positive: \`\${BASE}, upper body, \${FRONT}, standing straight, arms at sides, neutral expression, \${BG}\`, negative: \`\${NEG}, \${NOT_FRONT}\` },
        sfw_full: { id: 'sfw_full', name: 'SFW 立绘', nsfw: false, shot: 'full', positive: \`\${BASE}, full body, standing, \${FRONT}, arms at sides, feet apart, \${BG}\`, negative: \`\${NEG}, \${NOT_FRONT}, cropped\` },
        nsfw_head: { id: 'nsfw_head', name: 'NSFW 头像', nsfw: true, shot: 'head', positive: \`nsfw, \${BASE}, portrait, headshot, head and shoulders, \${FRONT}, blush, sweat, parted lips, half-closed eyes, \${BG}\`, negative: \`\${NEG}, \${NOT_FRONT}, hands\` },
        nsfw_bust: { id: 'nsfw_bust', name: 'NSFW 胸像', nsfw: true, shot: 'bust', positive: \`nsfw, \${BASE}, upper body, \${FRONT}, shirtless, pectorals, nipples, sweat, \${BG}\`, negative: \`\${NEG}, \${NOT_FRONT}\` },
        nsfw_full: { id: 'nsfw_full', name: 'NSFW 立绘', nsfw: true, shot: 'full', positive: \`nsfw, \${BASE}, full body, standing, \${FRONT}, completely nude, penis, \${BG}\`, negative: \`\${NEG}, \${NOT_FRONT}, cropped\` },
    };

    return T;
})();
`);
patch(`    for (const [k, old] of Object.entries(OLD_TEMPLATE_TEXT)) if (rawT[k] && rawT[k].positive === old.positive && rawT[k].negative === old.negative) delete rawT[k];`,`    for (const set of [OLD_TEMPLATE_TEXT, OLD_TEMPLATE_TEXT2]) for (const [k, old] of Object.entries(set)) if (rawT[k] && rawT[k].positive === old.positive && rawT[k].negative === old.negative) rawT[k] = { ...rawT[k], positive: DEFAULT_TEMPLATES[k].positive, negative: DEFAULT_TEMPLATES[k].negative };`);
// 重画时保住正在打字的输入框（手机键盘不被收掉）
patch(`function render() {
    if (!root) return;`,`/** 重画界面时记住正在打字的框，画完放回去：后台有东西触发重画时，手机键盘不会被收掉 */
let tapOutAt = 0;
DOC.addEventListener('pointerdown', ev => { if (!ev.target?.closest?.('input, textarea')) tapOutAt = Date.now(); }, true);
function keepFocus() {
    if (Date.now() - tapOutAt < 1200) return null; // 刚点了按钮之类：是自己操作引起的重画，不把键盘拉回来
    const ae = DOC.activeElement;
    if (!root || !ae || !root.contains(ae) || !/^(INPUT|TEXTAREA)$/.test(ae.tagName) || /^(checkbox|radio|range|file|button|submit|color)$/i.test(ae.type || '')) return null;
    const attrs = ['data-bind', 'data-optstr', 'data-enter', 'data-field', 'data-k', 'data-i', 'data-where', 'name', 'placeholder'];
    const q = v => String(v).replace(/["\\\\]/g, '\\\\$&');
    const sel = ae.tagName.toLowerCase() + (ae.id ? '#' + CSS.escape(ae.id) : attrs.filter(a => ae.hasAttribute(a)).map(a => \`[\${a}="\${q(ae.getAttribute(a))}"]\`).join(''));
    if (sel === ae.tagName.toLowerCase()) return null;
    return { sel, s: ae.selectionStart, e: ae.selectionEnd, top: ae.scrollTop };
}
function restoreFocus(k) {
    if (!k || !root) return;
    const n = root.querySelector(k.sel);
    if (!n || DOC.activeElement === n) return;
    try { n.focus({ preventScroll: true }); } catch { n.focus(); }
    try { const L = n.value.length; n.setSelectionRange(Math.min(k.s ?? L, L), Math.min(k.e ?? L, L)); } catch { /* 有的输入框不支持 */ }
    n.scrollTop = k.top;
}
function render() {
    const kept = keepFocus();
    renderView();
    restoreFocus(kept);
}
function renderView() {
    if (!root) return;`);
// ComfyUI：单独一页（自己的生图、连接、工作流），聊天插图可选用 ComfyUI
patch(`async function generateRequest(opts) {
    const s = settings();`,`// ───────────── ComfyUI ─────────────
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
const comfyUrl = (s = settings()) => String(s.comfyUrl || '').trim().replace(/\\/+$/, '');
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
    let src = String(text || '').replace(/\\\\?\\(/g, '\\u0004').replace(/\\\\?\\)/g, '\\u0005');
    src = src.replace(/(-?\\d+(?:\\.\\d+)?)::([\\s\\S]*?)::/g, (m, w, body) => \`\\u0001\${w}\\u0002\${body}\\u0003\`).replace(/::/g, '');
    const out = [];
    let mult = 1, buf = '', bufW = null;
    const stack = [];
    const flush = () => {
        const t = buf.trim(); buf = '';
        const w = bufW ?? mult; bufW = null;
        if (!t || w <= 0) return;
        let tag = t.replace(/\\u0004/g, '\\\\(').replace(/\\u0005/g, '\\\\)');
        if (/^artist:/i.test(tag)) { const name = tag.replace(/^artist:\\s*/i, ''); tag = artist === 'keep' ? tag : artist === 'by' ? 'by ' + name : name; }
        out.push(Math.abs(w - 1) < 0.01 ? tag : \`(\${tag}:\${Math.round(w * 100) / 100})\`);
    };
    for (let i = 0; i < src.length; i++) {
        const ch = src[i];
        if (ch === ',' || ch === '\\n' || ch === '|') { flush(); continue; }
        if (ch === '{') { mult *= 1.05; stack.push(1.05); continue; }
        if (ch === '[') { mult *= 0.95; stack.push(0.95); continue; }
        if ((ch === '}' || ch === ']') && stack.length) { mult /= stack.pop(); continue; }
        if (ch === '\\u0001') { const j = src.indexOf('\\u0002', i); const w = Number(src.slice(i + 1, j)) || 1; mult *= w; stack.push(w); i = j; continue; }
        if (ch === '\\u0003') { if (stack.length) mult /= stack.pop(); continue; }
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
async function comfyDirect(path) {
    let r;
    try { r = await fetch(comfyUrl() + path, { cache: 'no-store' }); }
    catch { throw Object.assign(new Error('浏览器读不到 ComfyUI 里的工作流：ComfyUI 启动时加上 --enable-cors-header 再重连（不加也能生图，工作流可以「从电脑选文件」）'), { cors: true }); }
    if (!r.ok) throw new Error(\`ComfyUI 返回 \${r.status}\`);
    return r;
}
/** 连接：测通、读模型/采样器/调度器；顺手读 ComfyUI 里存的工作流和节点说明（读不到不算失败） */
async function comfyConnect() {
    const url = comfyUrl();
    if (!url) throw new Error('先填 ComfyUI 地址');
    await comfyPost('ping', { url });
    const [models, samplers, schedulers] = await Promise.all(['models', 'samplers', 'schedulers'].map(p => comfyPost(p, { url }).then(r => r.json()).catch(() => [])));
    const info = { models: (models || []).map(m => typeof m === 'string' ? { value: m, text: m } : m), samplers, schedulers, workflows: null, wfError: '' };
    try {
        let list;
        try { list = await (await comfyDirect('/api/userdata?dir=workflows&recurse=true&split=false')).json(); }
        catch (e) { if (e.cors) throw e; list = await (await comfyDirect('/userdata?dir=workflows&recurse=true&split=false')).json(); }
        info.workflows = (Array.isArray(list) ? list : []).map(x => typeof x === 'string' ? x : x?.path || x?.name).filter(x => x && /\\.json$/i.test(x)).sort();
    } catch (e) { info.wfError = e.message; }
    return info;
}
let objectInfo = null;
async function comfyObjectInfo() {
    if (objectInfo) return objectInfo;
    try { objectInfo = await (await comfyDirect('/object_info')).json(); } catch { objectInfo = null; }
    return objectInfo;
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
            if (Array.isArray(t) || ['INT', 'FLOAT', 'STRING', 'BOOLEAN', 'COMBO'].includes(t)) names.push(n);
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
    if (unknown.size) throw new Error(\`读不到这几个节点的说明：\${[...unknown].join('、')}。ComfyUI 启动时加 --enable-cors-header 再重连，或者在 ComfyUI 里「导出（API）」后从电脑选文件\`);
    return api;
}
/** 往工作流里填正面、负面、尺寸、种子（有 "%prompt%" 这类占位符就按占位符填） */
function fillWorkflow(api, v, builtin) {
    let text = JSON.stringify(api);
    if (builtin || text.includes('"%prompt%"')) {
        for (const [k, val] of Object.entries(v)) text = text.replaceAll(\`"%\${k}%"\`, JSON.stringify(val));
        return text;
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
    setText(sampler.inputs.negative, v.negative_prompt);
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
    const seed = sd > 0 ? sd : Math.floor(Math.random() * 4294967294) + 1;
    const vals = { prompt: positive, negative_prompt: negative, model: String(s.comfyModel || '').trim(), width: w, height: h, seed, steps: Number(s.comfySteps) || 28, scale: Number(s.comfyCfg) || 6, sampler: s.comfySampler || 'euler_ancestral', scheduler: s.comfyScheduler || 'normal', denoise: 1, clip_skip: -2 };
    let api = COMFY_WORKFLOW;
    if (custom) {
        try { api = JSON.parse(String(s.comfyWfApi || '')); } catch { throw new Error('选的工作流没读好，到「Comfy」页重新选一次'); }
    }
    const wf = fillWorkflow(api, vals, !custom);
    const r = await comfyPost('generate', { url, prompt: \`{"prompt": \${wf}}\` });
    const { format, data } = await r.json();
    const sent = { prompt: positive, negative, size: \`\${w}×\${h}\`, chars: [], seed, model: 'ComfyUI · ' + (custom ? custom.replace(/^\\w+:/, '') : vals.model), director: 0 };
    return { image: \`data:image/\${format || 'png'};base64,\${data}\`, sent };
}
/** 选工作流：内置 / ComfyUI 里存的 / 电脑上的文件；选的时候就转好格式存下来 */
async function comfyUseWorkflow(kind, name = '', raw = null) {
    const s = settings();
    if (!kind) { s.comfyWf = ''; s.comfyWfApi = ''; save(); return; }
    const wf = raw ?? await comfyLoadWorkflow(name);
    const info = Array.isArray(wf?.nodes) ? await comfyObjectInfo() : null;
    const api = uiToApi(wf, info);
    if (!api || typeof api !== 'object' || !Object.keys(api).length) throw new Error('这个文件不像 ComfyUI 工作流');
    fillWorkflow(api, { prompt: 'x', negative_prompt: 'x', width: 832, height: 1216, seed: 1 }, false);
    s.comfyWf = kind + ':' + name; s.comfyWfApi = JSON.stringify(api); save();
}
async function generateRequest(opts) {
    const s = settings();
    if (opts.backend === 'comfy') return comfyGenerate(opts, s);`);
patch(`return { stopQueue:()=>__naiGate.stop(), MODELS,`,`return { comfyReady, chatBackend, comfyAutoConfig, comfyConnect, comfyUseWorkflow, naiToSd, uiToApi, fillWorkflow, COMFY_Q, COMFY_UC, stopQueue:()=>__naiGate.stop(), MODELS,`);
patch(`    if (!N.isReady()) throw new Error('还没填 NovelAI key，到「设置」最上面填');
    runtime.busy++;`,`    if (opts.backend === 'comfy') { if (!N.comfyReady()) throw new Error('还没连上 ComfyUI，到智库「Comfy」页看看'); opts.noVibe = true; opts.director = null; }
    else if (!N.isReady()) throw new Error('还没填 NovelAI key，到「设置」最上面填');
    runtime.busy++;`);
patch(`async function generateFull({ positive, negative, chars = [], width, height, director }) {
    return run({ positive, negative, chars, width, height, director });`,`async function generateFull({ positive, negative, chars = [], width, height, director, backend }) {
    return run({ positive, negative, chars, width, height, director, backend });`);
patch(`    if (!N.isReady()) throw new Error('还没填 NovelAI key，到画师库 → 设置填');`,`    if ((typeof __mod_nai === 'undefined' || __mod_nai.chatBackend?.() !== 'comfy') && !N.isReady()) throw new Error('还没填 NovelAI key，到画师库 → 设置填');`);
patch(`    const image = await E.generateFull({ ...prompt, director });`,`    const image = await E.generateFull({ ...prompt, director, backend: (typeof __mod_nai !== 'undefined' && __mod_nai.chatBackend?.()) || 'nai' });`);
patch(`const image=await __mod_engine.generateFull({positive,negative,...(chars?.length?{chars}:{}),director:`,`const image=await __mod_engine.generateFull({positive,negative,...(chars?.length?{chars}:{}),backend:(typeof __mod_nai!=='undefined'&&__mod_nai.chatBackend?.()||'nai'),director:`);
patch(`function viewStudio(d) {`,`// ═════════════════════ ComfyUI 页 ═════════════════════
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
    if (k.busy || (k.tried && !force)) return;
    k.busy = true; k.tried = true; k.err = '';
    N.comfyAutoConfig();
    N.comfyConnect().then(info => {
        Object.assign(k, info, { busy: false, ok: true, err: '' });
        const s = N.settings();
        if (!s.comfyModel && info.models.length) { s.comfyModel = info.models[0].value; N.save(); }
    }).catch(e => Object.assign(k, { busy: false, ok: false, err: e.message })).finally(() => { if (ui.view === 'comfy') render(); });
}
function ensureCfyCss() {
    if (!DOC.getElementById('pc-comfy-css')) {
        const st = DOC.createElement('style'); st.id = 'pc-comfy-css';
        st.textContent = \`.pc-nav{grid-template-columns:repeat(7,minmax(0,1fr))!important;gap:3px!important}\n.pc-nav .pc-pill{white-space:nowrap!important;font-size:12px!important;padding:0 1px!important;letter-spacing:0!important}
.pc-cf-conn{display:flex;align-items:center;gap:12px}.pc-cf-dot{flex:none;width:12px;height:12px;border-radius:50%;background:#9a948b}
.pc-cf-dot.ok{background:#7fae79;box-shadow:0 0 0 4px rgba(127,174,121,.18)}.pc-cf-dot.err{background:#c0675c;box-shadow:0 0 0 4px rgba(192,103,92,.18)}.pc-cf-dot.busy{background:#c9a24a;animation:pc-cf-blink 1s infinite}
@keyframes pc-cf-blink{50%{opacity:.35}}
.pc-cf-conn .pc-grow small{display:block;opacity:.7;font-size:12px;line-height:1.5;word-break:break-all}
.pc-cf-kv{display:grid;grid-template-columns:1fr 1fr;gap:8px}\`;
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
        if (!arr.length) return \`<input data-st="\${key}" value="\${esc(cur)}" placeholder="\${esc(def || '点「重连」后可以选')}">\`;
        if (cur && !arr.some(x => x.value === cur)) arr.unshift({ value: cur, text: cur + '（列表里没有）' });
        return \`<select data-st="\${key}">\${cur ? '' : '<option value="">选一个</option>'}\${arr.map(x => \`<option value="\${esc(x.value)}" \${x.value === cur ? 'selected' : ''}>\${esc(x.text)}</option>\`).join('')}</select>\`;
    };
    const wfOpts = [['', '内置：基础文生图']];
    for (const w of k.workflows || []) wfOpts.push(['cu:' + w, 'ComfyUI 里的：' + w.replace(/\\.json$/i, '')]);
    if (custom && !wfOpts.some(o => o[0] === custom)) wfOpts.push([custom, (custom.startsWith('file:') ? '电脑上的文件：' : 'ComfyUI 里的：') + custom.replace(/^\\w+:/, '').replace(/\\.json$/i, '')]);
    const [w, h] = c.size.split('x').map(Number);
    const sizeBtn = (v, t) => \`<button class="pc-pill \${c.size === v ? 'on' : ''}" data-act="cfysize" data-v="\${v}">\${t}</button>\`;
    const sum = custom ? '用工作流自己的参数' : \`\${esc(s.comfySteps || 28)} 步 · CFG \${esc(s.comfyCfg || 6)} · \${esc(s.comfySampler || 'euler_ancestral')}\`;
    return \`
    <section class="pc-card pc-pad">
      <div class="pc-label" style="margin-top:0">连接</div>
      <div class="pc-cf-conn"><i class="pc-cf-dot \${dot}"></i><div class="pc-grow"><b>\${k.busy ? '正在连接…' : k.ok ? '已连上' : k.err ? '没连上' : '还没连接'}</b>
        <small>\${esc(url)}\${k.err ? ' · ' + esc(k.err) : k.ok ? \` · \${(k.models || []).length} 个模型\` : ''}</small></div>
        <button class="pc-pill dashed" data-act="cfyconnect" \${k.busy ? 'disabled' : ''}>重连</button></div>
      <details class="pc-details pc-mt-s" \${ui.cfyUrlOpen || k.err ? 'open' : ''}><summary class="pc-dim small">改地址</summary>
        <label class="pc-field"><span>ComfyUI 地址</span><input data-st="comfyUrl" value="\${esc(s.comfyUrl || '')}" placeholder="http://127.0.0.1:8188" autocomplete="off"></label>
        <div class="pc-hint">打开这页会自动连：先用酒馆「图片生成」里填的 ComfyUI 地址，没填就用本机 127.0.0.1:8188。手机上的酒馆连电脑的 ComfyUI，填电脑的局域网地址，ComfyUI 启动时加 --listen。</div>
      </details>
      <label class="pc-field"><span>工作流</span><select data-act-change="cfywf">\${wfOpts.map(([v, t]) => \`<option value="\${esc(v)}" \${v === custom ? 'selected' : ''}>\${esc(t)}</option>\`).join('')}</select></label>
      <div class="pc-actions wrap" style="margin-top:6px"><label class="pc-pill dashed tiny" style="cursor:pointer">从电脑选文件<input type="file" accept=".json,application/json" data-cfyfile hidden></label>\${k.wfError ? \`<span class="pc-dim small">\${esc(k.wfError)}</span>\` : k.workflows ? \`<span class="pc-dim small">ComfyUI 里有 \${k.workflows.length} 个工作流</span>\` : ''}</div>
      \${custom ? '<div class="pc-hint">用自己的工作流时，模型和采样参数都按工作流里设好的；智库只填正面、负面、尺寸和种子。</div>' : \`
      <label class="pc-field"><span>模型</span>\${pick('comfyModel', k.models)}</label>\`}
      <details class="pc-details pc-mt-s"><summary class="pc-row-between"><span>采样参数</span><span class="pc-dim small">\${sum}</span></summary>
        \${custom ? '' : \`<div class="pc-cf-kv">
          <label class="pc-field"><span>步数</span><input data-st="comfySteps" inputmode="numeric" value="\${esc(s.comfySteps || '28')}"></label>
          <label class="pc-field"><span>CFG</span><input data-st="comfyCfg" inputmode="decimal" value="\${esc(s.comfyCfg || '6')}"></label>
          <label class="pc-field"><span>采样器</span>\${pick('comfySampler', k.samplers, 'euler_ancestral')}</label>
          <label class="pc-field"><span>调度器</span>\${pick('comfyScheduler', k.schedulers, 'normal')}</label></div>\`}
        <div class="pc-cf-kv">
          <label class="pc-field"><span>种子（空着随机）</span><input data-st="comfySeed" inputmode="numeric" value="\${esc(s.comfySeed || '')}" placeholder="随机"></label>
          <label class="pc-field"><span>画师名写法</span><select data-st="comfyArtist">\${[['plain', 'xxx'], ['by', 'by xxx'], ['keep', 'artist:xxx']].map(([v, t]) => \`<option value="\${v}" \${(s.comfyArtist || 'plain') === v ? 'selected' : ''}>\${t}</option>\`).join('')}</select></label></div>
        <label class="pc-field"><span>质量词（加在正面最后）</span><textarea class="pc-textarea mono small" data-st="comfyQuality" rows="2">\${esc(s.comfyQuality ?? N.COMFY_Q)}</textarea></label>
        <label class="pc-field"><span>负面预设（加在负面最前）</span><textarea class="pc-textarea mono small" data-st="comfyNeg" rows="3">\${esc(s.comfyNeg ?? N.COMFY_UC)}</textarea></label>
        <div class="pc-hint">二次元画师串推荐 Illustrious / NoobAI 系的 SDXL 模型。画师串照 NovelAI 写法就行：1.2::xxx::、{xxx}、[xxx]、artist:xxx 会自动换成 ComfyUI 写法。</div>
      </details>
    </section>
    <section class="pc-card pc-pad pc-mt">
      <div class="pc-row-between"><h2 class="pc-h2" style="margin:0">ComfyUI 生图</h2><span class="pc-dim small">\${esc(custom ? custom.replace(/^\\w+:/, '').replace(/\\.json$/i, '') : String(s.comfyModel || '还没选模型').replace(/\\.[^.]+$/, ''))}</span></div>
      <label class="pc-label" for="pc-cfy-pos">正面</label>
      <textarea id="pc-cfy-pos" class="pc-textarea mono big" data-bind="cfy.pos" placeholder="artist:xxx, 1girl, solo, white dress …">\${esc(c.pos)}</textarea>
      <div class="pc-chips" style="margin-top:6px"><button class="pc-pill dashed tiny" data-act="cfyfill" data-from="active">＋ 用正文画师串</button><button class="pc-pill dashed tiny" data-act="cfyfill" data-from="studio">＋ 用生图页的正面</button></div>
      <label class="pc-label" for="pc-cfy-neg">负面</label>
      <textarea id="pc-cfy-neg" class="pc-textarea small mono" data-bind="cfy.neg" placeholder="不想出现的东西">\${esc(c.neg)}</textarea>
      <div class="pc-chips" style="margin-top:10px">\${sizeBtn('832x1216', '竖')}\${sizeBtn('1216x832', '横')}\${sizeBtn('1024x1024', '方')}<span class="pc-dim small" style="align-self:center">\${w}×\${h}</span></div>
    </section>
    <button class="pc-btn dark big pc-mt" data-act="cfygen" \${c.busy ? 'disabled' : ''}>\${seal()}\${c.busy ? '<span class="pc-busy">生成中</span>' : '生成'}</button>
    \${c.result ? \`
    <section class="pc-card pc-mt pc-result">
      <img src="\${esc(c.result)}" alt="生成结果" data-act="viewimg" data-src="\${esc(c.result)}">
      <div class="pc-actions wrap">
        <a class="pc-btn" href="\${esc(c.result)}" download="zhiku_comfy_\${Date.now()}.png">下载</a>
        <button class="pc-btn" data-act="cfyinsert">插到聊天最后一楼</button>
        <button class="pc-btn" data-act="cfygen">再来一张</button>
        <button class="pc-btn" data-act="cfyshare">上传到共享</button>
        <button class="pc-btn danger" data-act="cfyclear">删掉</button>
      </div>
      \${c.sent ? \`<details class="pc-details pc-sent-box"><summary>实际发出去的内容（\${esc(c.sent.size)} · 种子 \${esc(c.sent.seed)}）</summary>
        <div class="pc-label">正面</div><p class="pc-quote small mono">\${esc(c.sent.prompt)}</p>
        <div class="pc-label">负面</div><p class="pc-quote small mono">\${esc(c.sent.negative)}</p></details>\` : ''}
    </section>\` : ''}
    <section class="pc-card pc-pad pc-mt">
      <div class="pc-label" style="margin-top:0">聊天里</div>
      <label class="pc-switch"><input type="checkbox" data-st-check="comfyChat" \${String(s.comfyChat) === 'true' ? 'checked' : ''}><span></span>聊天插图也用 ComfyUI<small>关着就还是 NovelAI。漫画一直用 NovelAI。NovelAI 的生图页和这页互不影响。</small></label>
    </section>\`;
}
function viewStudio(d) {`);
patch(`const VIEWS = { aipreset: viewAiPreset,`,`const VIEWS = { comfy: viewComfy, aipreset: viewAiPreset,`);
patch(`const navs = [['studio', '生图'], ['comic', '漫画'],`,`ensureCfyCss();
    const navs = [['studio', '生图'], ['comfy', 'Comfy'], ['comic', '漫画'],`);
patch(`            case 'insertresult':`,`            case 'cfyconnect': comfyConnectNow(true); render(); break;
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
                if (!N.comfyReady()) { toastr.warning('先连上 ComfyUI', 'ComfyUI'); break; }
                if (!c.pos.trim()) { toastr.warning('正面是空的', 'ComfyUI'); break; }
                saveCfy(); c.busy = true; render();
                try {
                    const [w, h] = c.size.split('x').map(Number);
                    c.result = await E.generateFull({ positive: c.pos, negative: c.neg, width: w, height: h, backend: 'comfy' });
                    c.sent = E.runtime.lastSent;
                    const shot = { dataUrl: c.result, raw: c.pos, sent: c.sent, from: 'comfy' };
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
            case 'insertresult':`);
patch(`async function onChangeEv(ev) {
    const el = ev.target;
    const d = getData();`,`async function onChangeEv(ev) {
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
    if (el.dataset?.st === 'comfyUrl') { N.settings().comfyUrl = el.value.trim(); N.save(); comfyConnectNow(true); render(); return; }`);
patch(`        if (['studio.pos', 'studio.neg', 'studio.scene', 'studio.sceneEn'].includes(el.dataset.bind)) {`,`        if (String(el.dataset.bind).startsWith('cfy.')) { clearTimeout(onInput.cf); onInput.cf = setTimeout(saveCfy, 600); }
        if (['studio.pos', 'studio.neg', 'studio.scene', 'studio.sceneEn'].includes(el.dataset.bind)) {`);
// 历史生图：存完整的正面/负面和分人物提示词，详情里都能看到
patch(`raw: cut(raw, 800), prompt: cut(sent?.prompt, 800), negative: cut(sent?.negative, 400),`,`raw: cut(raw, 4000), prompt: cut(sent?.prompt, 6000), negative: cut(sent?.negative, 6000), chars: (sent?.chars || []).slice(0, 6).map(c => typeof c === 'string' ? cut(c, 2000) : cut(c?.prompt, 2000)).filter(Boolean),`);
patch(`<div class="pc-label">负面</div><p class="pc-quote small mono">\${esc(x.negative)}</p>\` : ''}</details>\` : ''}`,`<div class="pc-label">负面</div><p class="pc-quote small mono">\${esc(x.negative)}</p>\` : ''}\${(x.chars || []).map((c, i) => \`<div class="pc-label">人物 \${i + 1}</div><p class="pc-quote small mono">\${esc(c)}</p>\`).join('')}</details>\` : ''}`);
patch(`        <div class="pc-label">负面</div><p class="pc-quote small mono">\${esc(st.sent.negative)}</p>`,`        <div class="pc-label">负面</div><p class="pc-quote small mono">\${esc(st.sent.negative)}</p>
        \${(st.sent.chars || []).map((c, i) => \`<div class="pc-label">人物 \${i + 1}</div><p class="pc-quote small mono">\${esc(typeof c === 'string' ? c : c?.prompt || '')}</p>\`).join('')}`);
// 聊天插图可以不分人物：人物描写合并进正面（开关），canSplit 的改动在后面
patch(`      <label class="pc-field"><span>聊天生图额外正面词 · 每张都加在场景后面</span>`,`      \${sw('chatNoSplit', '聊天插图不分人物', '打开：几个人的描写都合并进正面（和生图页一样），画师串和质量词作用到所有内容，画风更稳；代价是人物特征可能串（比如发色互换）。关闭：用 NovelAI 4.5 的分人物提示词，人物更不容易混，但画风可能变弱。')}
      <label class="pc-field"><span>聊天生图额外正面词 · 每张都加在场景后面</span>`);
// AI 请求用「干净的」fetch：别的插件改写了 window.fetch 并抢先读走回复时，会报 body stream already read
patch(`async function askLLM(system, user, { maxTokens = 800, fn = '' } = {}) {`,`let zkCleanFetch = null, zkFetchFrame = null, zkFetchStopped = false;
/** 从隐藏的同源空白 iframe 借 fetch，隔离父窗口的 fetch 改写。 */
function stopFetch() {
    zkFetchStopped = true;
    zkCleanFetch = null;
    zkFetchFrame?.remove();
    zkFetchFrame = null;
}
function zkFetch(...args) {
    if (zkFetchStopped) throw new Error('智库已关闭');
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
            const w = frame.contentWindow;
            if (!w?.fetch) throw new Error('no fetch');
            zkCleanFetch = w.fetch.bind(w);
            zkFetchFrame = frame;
        } catch {
            frame?.remove();
        }
    }
    // 只在隔离通道创建失败时退回；请求本身失败不能自动重发。
    return (zkCleanFetch || fetch)(...args);
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
async function askLLM(system, user, { maxTokens = 800, fn = '' } = {}) {`);
patch(`        res = await fetch(\`\${api.url}/chat/completions\`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...(api.key ? { Authorization: \`Bearer \${api.key}\` } : {}) },
            body: JSON.stringify({ model: api.model, messages, temperature: 0.3, stream: false, max_tokens: maxTokens }),`,`        res = await zkFetch(\`\${api.url}/chat/completions\`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...(api.key ? { Authorization: \`Bearer \${api.key}\` } : {}) },
            body: JSON.stringify({ model: api.model, messages, temperature: 0.3, stream: false, max_tokens: maxTokens }),`);
patch(`        res = await fetch('/api/backends/chat-completions/generate', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                chat_completion_source: 'custom',
                custom_url: api.url,`,`        res = await zkFetch('/api/backends/chat-completions/generate', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                chat_completion_source: 'custom',
                custom_url: api.url,`);
patch(`    const raw = await res.text();
    if (!res.ok) throw new Error(\`AI 请求失败（\${res.status}）：\${raw.slice(0, 160)}\`);`,`    const raw = await readBody(res);
    if (!res.ok) throw new Error(\`AI 请求失败（\${res.status}）：\${raw.slice(0, 160)}\`);`);
patch(`            const r = await fetch(\`\${api.url}/chat/completions\`, {`,`            const r = await zkFetch(\`\${api.url}/chat/completions\`, {`);
patch(`    const r = await fetch('/api/backends/chat-completions/generate', { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify(body) });`,`    const r = await zkFetch('/api/backends/chat-completions/generate', { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify(body) });`);
patch('async function readChat(r) {\n    const raw = await r.text();', 'async function readChat(r) {\n    const raw = await readBody(r);');
patch('timers.clear(); stopped = true; }', 'timers.clear(); stopped = true; __mod_translate.stopFetch(); }');
// 角色：从聊天正文读出人物和外貌（AI 回复里出现、卡里没写的人也能加进来）
patch(`async function extractCast(cardName, description) {`,`async function extractCastFromChat(cardName, chatText) {
    const sys = \`你从聊天正文里找出所有出场过、并且写到了外貌的角色（主角、配角、路人都算，{{user}} / 玩家本人不要），每人挑画图用的外貌标签。
外貌只挑不会变的：性别人数（1boy / 1girl）、年龄感、发型发色、眼睛、脸部特征、身材、肤色、明显的痣疤纹身、角尾巴翅膀等。最近一次写到的衣服另外放。正文没写到的不要编；同一个人前后写法不同时以较新的为准。
\${PAIRS}
只输出 JSON：{"people": [{"name": "正文里的名字", "aliases": ["昵称、称呼、别的叫法"], "appearance": [...], "outfit": [...]}]}\`;
    const j = await askShrinking(sys, limit => \`卡名：\${cardName}\\n聊天正文（从旧到新）：\\n\${String(chatText || '').slice(-limit)}\`, { maxTokens: 8000, fn: 'look' });
    const norm = arr => (Array.isArray(arr) ? arr : []).map(x => typeof x === 'string' ? { en: x, zh: '' } : { en: String(x?.en || '').trim(), zh: String(x?.zh || '').trim() }).filter(x => x.en && !hasChinese(x.en));
    return (Array.isArray(j.people) ? j.people : []).map(p => ({
        name: String(p?.name || '').trim().slice(0, 30),
        aliases: (Array.isArray(p?.aliases) ? p.aliases : []).map(a => String(a || '').trim()).filter(Boolean).slice(0, 6),
        appearance: norm(p?.appearance), outfit: norm(p?.outfit),
    })).filter(p => p.name && !/^\\{\\{?user\\}?\\}$|^user$/i.test(p.name) && p.appearance.length);
}
async function extractCast(cardName, description) {`);
patch(`return { AI_FNS, apiFor,`,`return { AI_FNS, extractCastFromChat, apiFor,`);
patch(`        case 'readcast': {
            const cardAvatar = c.kind === 'side' ? c.card : c.avatar;
            const main = C.getChar('char:' + cardAvatar);
            if (!cardAvatar || !main) return true;
            ui.charBusy = 'cast'; render();
            try {
                const desc = await C.descOfFull(main);
                if (!desc.trim()) { toastr.warning('描述、性格、场景、世界书里都没找到设定', '角色'); return true; }
                const people = await T.extractCast(main.name, desc);`,`        case 'readchatcast':
        case 'readcast': {
            const cardAvatar = c.kind === 'side' ? c.card : c.avatar;
            const main = C.getChar('char:' + cardAvatar);
            if (!cardAvatar || !main) return true;
            const fromChat = act === 'readchatcast';
            ui.charBusy = fromChat ? 'chatcast' : 'cast'; render();
            try {
                let people;
                if (fromChat) {
                    const ctx = SillyTavern.getContext();
                    const msgs = (ctx.chat || []).filter(m => !m.is_system && m.mes).slice(-40);
                    const text = msgs.map(m => (m.is_user ? '【' + (m.name || '用户') + '】' : '【' + (m.name || main.name) + '】') + String(m.mes).replace(/<[^>]+>/g, ' ').replace(/\\n{3,}/g, '\\n\\n')).join('\\n\\n');
                    if (!text.trim()) { toastr.warning('这个聊天还没有正文', '角色'); return true; }
                    people = await T.extractCastFromChat(main.name, text);
                    if (!people.length) { toastr.warning('AI 没在最近的正文里找到写了外貌的人', '角色'); return true; }
                } else {
                const desc = await C.descOfFull(main);
                if (!desc.trim()) { toastr.warning('描述、性格、场景、世界书里都没找到设定', '角色'); return true; }
                people = await T.extractCast(main.name, desc);
                }`);
patch(`'读出这张卡里所有人（含世界书）'}</button>\` : ''}`,`'读出这张卡里所有人（含世界书）'}</button><button class="pc-pill dashed tiny pc-mt-s" style="margin-left:6px" data-act="readchatcast" \${busy ? 'disabled' : ''}>\${busy === 'chatcast' ? '<span class="pc-busy">读取中</span>' : '从聊天正文读出人物（最近 40 楼）'}</button>\` : ''}`);
// 衣柜单套页：深色主题下看得清；新建时写清楚三步
patch(`.pc-outsec { margin-top: 12px; padding: 12px; border-radius: 14px; background: rgba(255, 255, 255, .45); }`,`.pc-outsec { margin-top: 12px; padding: 12px; border-radius: 14px; background: rgba(255, 255, 255, .45); background: color-mix(in srgb, var(--pc-ink) 7%, transparent); }
.pc-outsec .pc-dim, .pc-outsec-h small { color: var(--pc-ink-soft) !important; opacity: 1 !important; }
.pc-dhead .pc-dtitle, .pc-dhead .pc-dtitle:not([type="checkbox"]) { color: var(--pc-ink) !important; -webkit-text-fill-color: var(--pc-ink) !important; }
.pc-dhead .pc-dtitle::placeholder { color: var(--pc-ink-soft) !important; -webkit-text-fill-color: var(--pc-ink-soft) !important; opacity: 1; }
.pc-outsteps { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 10px; }
.pc-outsteps span { flex: 1 1 30%; min-width: 92px; padding: 8px 10px; border-radius: 12px; border: 1.5px dashed var(--pc-dash); font-size: 12px; line-height: 1.5; color: var(--pc-ink); }
.pc-outsteps span.done { border-style: solid; border-color: var(--pc-ink); }
.pc-outsteps b { display: block; font-size: 11px; letter-spacing: .15em; color: var(--pc-ink-soft); }`);
patch(`    <section class="pc-card pc-pad pc-mt">
      <div class="pc-row-between"><b>\${o.tags.length ? \`\${o.tags.length} 件\` : '还没有标签'}</b>`,`    \${u.draft ? \`<div class="pc-outsteps">
      <span class="\${img || o.tags.length ? 'done' : ''}"><b>第一步</b>点图片右下「换一张」放一张衣服的图，AI 会写成标签；没图就直接在下面打字加</span>
      <span class="\${o.tags.length ? 'done' : ''}"><b>第二步</b>看看下面的标签：点一下改、× 删掉、↓↑ 在整体和配饰之间挪</span>
      <span class="\${u.dest ? 'done' : ''}"><b>第三步</b>选「存到哪里」：只进衣柜，或者直接给某个人穿，再点「保存」</span></div>\` : ''}
    <section class="pc-card pc-pad pc-mt">
      <div class="pc-row-between"><b>\${o.tags.length ? \`\${o.tags.length} 件\` : '还没有标签'}</b>`);
patch(`    \${u.draft ? \`<button class="pc-btn dark big pc-mt" data-act="outsave" \${o.tags.length ? '' : 'disabled'}>\${seal()}保存</button>\` : ''}`,`    \${u.draft ? \`<button class="pc-btn dark big pc-mt" data-act="outsave" \${o.tags.length ? '' : 'disabled'}>\${seal()}保存</button>\${o.tags.length ? '' : '<div class="pc-dim small pc-center" style="margin-top:6px">至少要有一件衣服才能保存</div>'}\` : ''}`);
// 看图写提示词：分栏写，镜头语言（景别、角度、裁切、构图、透视景深）单独一栏必须写
patch(`/** 看图写成 NovelAI 标签（不写画师和质量词） */
async function imageToPrompt(imageDataUrl) {
    const sys = \`你看图，把这张图写成 NovelAI 能直接用的英文标签（Danbooru 风格，逗号隔开）。按顺序写：人数（1girl、2boys、no humans 等）→ 每个人的外貌、衣服、动作、表情、视线 → 构图和镜头（cowboy shot、from above 等）→ 背景和场景 → 光影和色调 → 画面风格特征（watercolor、thick painting 等）。不要写画师名，不要写质量词，看不见的不要编。
只输出 JSON：{"tags": "标签1, 标签2, ...", "zh": "一句话中文描述"}\`;
    const j = pickJson(await askVision(sys, '把这张图写成提示词。', imageDataUrl, { maxTokens: 1500, fn: 'img' }));
    const tags = (Array.isArray(j.tags) ? j.tags.join(', ') : String(j.tags || '')).trim();
    if (!tags) throw new Error('AI 没写出标签，换个能识图的模型试试');
    return { positive: tags, negative: '', zh: String(j.zh || '').trim() };
}
`,`/** 看图写成 NovelAI 标签（不写画师和质量词）：分栏写，镜头语言单独一栏、必须写 */
async function imageToPrompt(imageDataUrl) {
    const sys = \`你是给 NovelAI / Danbooru 打标签的专业标注员。看图，把这张图拆成英文 Danbooru 标签，按下面每一栏分别写，每栏是标签数组。看不清的不要编，但「镜头」这一栏必须写，不能空。
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
只输出 JSON：{"people":[],"outfit":[],"action":[],"expression":[],"camera":[],"background":[],"lighting":[],"zh":"一句话中文描述，带上镜头（比如：俯拍的半身特写……）"}\`;
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

`);
patch(`构图：取景范围（full body、cowboy shot、upper body、portrait、close-up 等）、镜头角度（from above、from below、from side、from behind、dutch angle 等）、人物在画面里的位置、透视和景深。`,`构图（必须写，不能空）：景别（extreme close-up、close-up、portrait、upper body、cowboy shot、full body、wide shot 选一个）、机位角度（from above、from below、from side、from behind、straight-on、dutch angle、pov）、裁切（head out of frame、cropped legs、feet out of frame、xx focus）、人物在画面里的位置（centered、off-center、rule of thirds）、透视和景深（foreshortening、fisheye、depth of field、blurry background）。`);
patch(`'识图 AI 看图写的（不含画师和质量词），可以先改一改'}\${r.zh ? '：' + esc(r.zh) : ''}</div>`,`'识图 AI 看图写的（不含画师和质量词），可以先改一改'}\${r.zh ? '：' + esc(r.zh) : ''}</div>\${r.camera ? \`<div class="pc-dim small mono" style="margin-top:4px">镜头：\${esc(r.camera)}</div>\` : ''}`);
// 角色页的衣服标签可以折叠；按钮一行放不下时换行
patch(`        <div class="pc-row-between"><b>\${esc(out.name)}</b><span class="pc-chips" style="margin:0">\${out.tags.length ?`,`        <div class="pc-row-between" style="flex-wrap:wrap;gap:6px"><b>\${esc(out.name)}</b><span class="pc-chips wrap" style="margin:0">\${out.tags.length ?`);
patch(`        \${outfitSections(out.tags, 'out', { busy: !!busy, busyKey: busy, disabled: busy ? 'disabled' : '' })}
        <button class="pc-btn pc-mt-s" data-act="outtest"`,`        \${ui.outEditOpen || !out.tags.length ? \`\${outfitSections(out.tags, 'out', { busy: !!busy, busyKey: busy, disabled: busy ? 'disabled' : '' })}\${out.tags.length ? '<button class="pc-pill dashed tiny pc-mt-s" data-act="outedittoggle">收起标签</button>' : ''}\`
          : \`<button class="pc-outfold" data-act="outedittoggle"><span class="pc-dim small">\${out.tags.length} 件：</span><span class="mono small">\${esc(C.tagText(out.tags.slice(0, 8)))}\${out.tags.length > 8 ? ' …' : ''}</span><em>展开编辑 ›</em></button>\`}
        <button class="pc-btn pc-mt-s" data-act="outtest"`);
patch(`            case 'lobbyaud':`,`            case 'outedittoggle': ui.outEditOpen = !ui.outEditOpen; render(); break;
            case 'lobbyaud':`);
patch(`.pc-outsteps { display: flex;`,`.pc-outfold { display: block; width: 100%; margin-top: 10px; padding: 10px 12px; border-radius: 12px; border: 1.5px dashed var(--pc-dash); background: transparent; color: var(--pc-ink); text-align: left; line-height: 1.6; cursor: pointer; font: inherit; }
.pc-outfold em { display: block; font-style: normal; font-size: 12px; color: var(--pc-ink-soft); margin-top: 4px; }
.pc-outsteps { display: flex;`);
// 衣柜：一套衣服给几个人穿不再复制出几张，衣柜里只显示一张，改了大家一起变
patch(`function saveChar(c) {
    const d = getData();
    d.characters[c.key] = c;`,`function saveChar(c) {
    const d = getData();
    d.characters[c.key] = c;
    try { syncOutfitsFrom(c); } catch (e) { console.warn('[智库] 同步衣服', e); }`);
patch(`/** 给角色穿：衣柜里的那件挪过去；已经在别人身上的就复制一份 */`,`// 同一套衣服给好几个人穿：每人身上各有一份（生图照旧按人读），用 sid 连起来，改一份其余跟着改；衣柜里只显示一张
const outSig = o => String(o.name || '') + '|' + (o.tags || []).map(t => String(t.en || '').toLowerCase()).sort().join(',');
/** 旧数据里名字和标签都一样的几份，认成同一套 */
function linkSameOutfits() {
    const d = getData(), rep = new Map();
    let changed = false;
    for (const c of Object.values(d.characters)) for (const o of c.outfits || []) {
        if (!(o.tags || []).length) continue;
        const k = outSig(o), r = rep.get(k);
        if (!r) { rep.set(k, o); continue; }
        if (!r.sid) { r.sid = r.id; changed = true; }
        if (o.sid !== r.sid && !o.sid) { o.sid = r.sid; changed = true; }
    }
    if (changed) commit({ silent: true });
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
/** 给角色穿：衣柜里的那件挪过去；已经在别人身上的，给他也挂一份（和原来那份连在一起） */`);
patch(`    if (!hit.owner) delete d.outfits[id];
    else if (hit.owner.key !== to.key) o = { ...structuredClone(o), id: M.uid('o_') };`,`    if (!hit.owner) delete d.outfits[id];
    else if (hit.owner.key !== to.key) {
        hit.o.sid ||= hit.o.id;
        const same = to.outfits.find(x => x.sid === hit.o.sid);
        if (same) { if (wear) { to.outfitId = same.id; to.outfitMode = 'fixed'; } saveChar(to); saveChar(hit.owner); return same; }
        o = { ...structuredClone(o), id: M.uid('o_'), sid: hit.o.sid };
        saveChar(hit.owner);
    }`);
patch(`return { studioCastPrompt,`,`return { studioCastPrompt, wardrobeGroups, outfitHolders, takeOffOutfit, deleteOutfitGroup,`);
patch(`    const all = C.wardrobe();
    const owners = [...new Map(all.filter(x => x.owner).map(x => [x.owner.key, x.owner])).values()];
    const q = ui.wardSearch.trim().toLowerCase();
    const list = all.filter(x => (ui.wardFilter === 'all' || (ui.wardFilter === 'none' ? !x.owner : x.owner?.key === ui.wardFilter))`,`    const all = C.wardrobeGroups();
    const owners = [...new Map(all.flatMap(g => g.holders).filter(x => x.owner).map(x => [x.owner.key, x.owner])).values()];
    const q = ui.wardSearch.trim().toLowerCase();
    const list = all.filter(x => (ui.wardFilter === 'all' || (ui.wardFilter === 'none' ? !x.owner : x.holders.some(h => h.owner?.key === ui.wardFilter)))`);
patch(`    <div class="pc-grid2 pc-mt-s">\${list.map(({ o, owner }) => \`<article`,`    <div class="pc-grid2 pc-mt-s">\${list.map(({ o, owner, holders }) => \`<article`);
patch(`<span class="pc-state \${owner ? '' : 'todo'}">\${owner ? '穿在：' + esc(owner.name) : '还没给谁穿'}</span></div></article>\`).join('')
        || empty('衣柜是空的'`,`<span class="pc-state \${owner ? '' : 'todo'}">\${owner ? '穿在：' + esc(holders.map(h => h.owner.name).join('、')) : '还没给谁穿'}</span></div></article>\`).join('')
        || empty('衣柜是空的'`);
patch(`    const people = [...new Map([...cast, ...Object.values(d.characters)].map(c => [c.key, c])).values()];`,`    const people = [...new Map([...cast, ...Object.values(d.characters)].map(c => [c.key, c])).values()];
    const holders = !u.draft && owner ? C.outfitHolders(o).map(x => x.owner) : [];`);
patch(`      <b>\${owner ? \`穿在：\${esc(owner.name)}\` : u.draft ? '存到哪里' : '给谁穿'}</b>`,`      <b>\${u.draft ? '存到哪里' : holders.length ? '谁在穿' : '给谁穿'}</b>
      \${holders.length ? \`<div class="pc-chips wrap">\${holders.map(h => \`<button class="pc-pill on" data-act="outtakeoff" data-v="\${esc(h.key)}" title="从\${esc(h.name)}身上拿掉">\${esc(h.name)} ×</button>\`).join('')}</div><div class="pc-dim small">点名字 × 从他身上拿掉（衣柜里还在）。下面点名字再给别人穿，几个人穿的是同一套，改了一起变。</div>\${label('再给谁穿')}\` : ''}`);
patch(`        \${people.filter(c => c.key !== owner?.key).map(c =>`,`        \${people.filter(c => c.key !== owner?.key && !holders.some(h => h.key === c.key)).map(c =>`);
patch(`      \${!u.draft ? '<div class="pc-dim small">点名字：复制一份给他，并设为他固定穿的衣服。</div>' : ''}`,`      \${!u.draft && !holders.length ? '<div class="pc-dim small">点名字：给他穿，并设为他固定穿的衣服。</div>' : ''}`);
patch(`<button class="pc-linkdanger" style="margin:0 0 0 12px" data-act="outdel">删掉这套</button>`,`<button class="pc-linkdanger" style="margin:0 0 0 12px" data-act="outdel">\${holders.length > 1 ? '删掉这套（所有人身上的都删）' : '删掉这套'}</button>`);
patch(`        case 'outdel': {
            const o = curOutfit();
            if (!o || !(await confirmBox(\`删掉「\${o.name}」？\`))) return true;
            C.deleteOutfit(ui.outfit.owner, ui.outfit.id);`,`        case 'outtakeoff': {
            const key = el.dataset.v, hit = C.findOutfit(ui.outfit.owner, ui.outfit.id);
            const mine = hit && C.outfitHolders(hit.o).find(x => x.owner.key === key);
            if (!mine) return true;
            const next = C.takeOffOutfit(key, mine.o.id);
            toastr.info(\`已从\${C.getChar(key)?.name || ''}身上拿掉\`, '衣柜', { timeOut: 1800 });
            if (ui.outfit.owner === key && next) ui.outfit = { owner: next.owner?.key || '', id: next.o.id };
            render(); return true;
        }
        case 'outdel': {
            const o = curOutfit();
            const n = ui.outfit.owner && o ? C.outfitHolders(o).length : 1;
            if (!o || !(await confirmBox(n > 1 ? \`删掉「\${o.name}」？\${n} 个人身上的都会删掉。只想从某个人身上拿掉，点他名字旁边的 ×。\` : \`删掉「\${o.name}」？\`))) return true;
            C.deleteOutfitGroup(ui.outfit.owner, ui.outfit.id);`);
patch(`            const o = C.currentOutfit(c);
            if (!o || !(await confirmBox(\`删掉「\${o.name}」这套衣服？\`))) return true;
            c.outfits = c.outfits.filter(x => x !== o); c.outfitId = c.outfits[0]?.id || ''; save();`,`            const o = C.currentOutfit(c);
            const others = o ? C.outfitHolders(o).filter(x => x.owner.key !== c.key) : [];
            if (!o || !(await confirmBox(others.length ? \`把「\${o.name}」从\${c.name}身上拿掉？\${others.map(x => x.owner.name).join('、')}还穿着这套，不受影响。\` : \`删掉「\${o.name}」这套衣服？\`))) return true;
            c.outfits = c.outfits.filter(x => x !== o); c.outfitId = c.outfits[0]?.id || ''; save();`);
// 看图读姿势：NSFW 的动作单独一栏、默认不选；放进固定提示词改成替换；改名输入框一打字就清掉旧名字
patch(`不写长相、衣服、背景、画风、画师。看不清的不要编。
\${PAIRS}
只输出 JSON：{"pose": [...], "composition": [...]}\`;`,`不写长相、衣服、背景、画风、画师。看不清的不要编。
只在 NSFW 图里才会用的标签（性行为、裸露部位、体液、明显带性暗示的姿势，比如 spread legs、presenting、sex、saliva、cum、nipples 等）不要放进 pose，单独放进 nsfw；普通图里也常见的姿势放 pose。
\${PAIRS}
只输出 JSON：{"pose": [...], "composition": [...], "nsfw": [...]}\`;`);
patch(`    const pose = normPairs(j.pose), composition = normPairs(j.composition);
    if (!pose.length && !composition.length) throw new Error('AI 没读出姿势和构图，换个能识图的模型试试');
    return { pose, composition };`,`    const NSFW_RE = /\\b(nsfw|sex|penis|vagina|pussy|nipples?|cum|ejaculation|saliva|spread legs|presenting|masturbation|fellatio|paizuri|orgasm|ahegao|nude|naked|bdsm|bondage|groping|panties aside|after sex|rape)\\b/i;
    let pose = normPairs(j.pose), composition = normPairs(j.composition), nsfw = normPairs(j.nsfw);
    // AI 偶尔还是放错栏：明显的挪到 NSFW
    const moved = pose.filter(p => NSFW_RE.test(p.en));
    if (moved.length) { pose = pose.filter(p => !moved.includes(p)); nsfw = [...nsfw, ...moved]; }
    if (!pose.length && !composition.length && !nsfw.length) throw new Error('AI 没读出姿势和构图，换个能识图的模型试试');
    return { pose, composition, nsfw };`);
patch(`    const all = [...r.pose.map(p => ({ ...p, g: '姿势' })), ...r.composition.map(p => ({ ...p, g: '构图' }))];
    const picked = new Set(all.map((_, i) => i));`,`    const all = [...r.pose.map(p => ({ ...p, g: '姿势' })), ...r.composition.map(p => ({ ...p, g: '构图' })), ...(r.nsfw || []).map(p => ({ ...p, g: 'NSFW' }))];
    const picked = new Set(all.map((_, i) => i));`);
patch(`          <div class="pc-label">构图</div><div>\${grp('构图')}</div>`,`          <div class="pc-label">构图</div><div>\${grp('构图')}</div>
          \${all.some(p => p.g === 'NSFW') ? \`<div class="pc-label">NSFW（默认选上，不要就点掉）</div><div>\${grp('NSFW')}</div>\` : ''}`);
patch(`            <button class="pc-btn" data-pa="scene">放进固定提示词</button>`,`            <button class="pc-btn" data-pa="scene">换成固定提示词</button>`);
patch(`        else { st.scene = [String(st.scene || '').trim(), tags].filter(Boolean).join(', '); st.sceneOn = true; }
        saveStudio(); box.closeModal(); ui.view = 'studio'; render();
        toastr.success(a === 'pos' ? '接在正面后面了' : '放进固定提示词了', '姿势构图', { timeOut: 1500 });`,`        else { st.scene = tags; st.sceneEn = ''; st.sceneOn = true; }
        saveStudio(); box.closeModal(); ui.view = 'studio'; render();
        toastr.success(a === 'pos' ? '接在正面后面了' : '固定提示词换成这些了', '姿势构图', { timeOut: 1500 });`);
patch(`        const done = v => { box.closeModal(); resolve(v); };
        box.addEventListener('click', ev => { const m = ev.target.closest('[data-m]')?.dataset.m; if (m === 'ok') done(box.querySelector('[data-v]').value.trim()); if (m === 'no') done(null); });`,`        const done = v => { box.closeModal(); resolve(v); };
        // 单行（取名字之类）：打开时全选，一打字就替换掉旧的
        if (!multiline) setTimeout(() => { const inp = box.querySelector('[data-v]'); try { inp.focus({ preventScroll: true }); inp.select(); } catch { } }, 60);
        box.addEventListener('click', ev => { const m = ev.target.closest('[data-m]')?.dataset.m; if (m === 'ok') done(box.querySelector('[data-v]').value.trim()); if (m === 'no') done(null); });`);
// 0.8.36：设置里单独的 AI 预设、下载和水印、先存后改名、一键上传到共享
patch(`    const ai = setFold('ai', '翻译和 AI',`,`    const ai0 = setFold('ai', '翻译和 AI',`);
patch(`    const tpl = setFold('tpl', '例图提示词',`,`    const aipFold = setFold('aip', 'AI 预设', (() => { const c = T.aiCfg(), a = c.active ?? 'tavern:'; return a === 'plain' ? '不套预设' : a.startsWith('tavern:') ? '跟酒馆预设' : esc(c.list[a]?.name || ''); })(), \`
      <div class="pc-dim small">AI 发出去的结构：系统 / 用户 / 助手条目，可以直接跟酒馆的预设走；每个功能还能单独选 API 和模型。</div>
      <div class="pc-actions wrap" style="margin-top:6px"><button class="pc-btn dark" data-act="nav" data-view="aipreset">打开 AI 预设</button></div>\`);
    const dlo = dlOpts();
    const opt = (v, t, cur) => \`<option value="\${v}" \${cur === v ? 'selected' : ''}>\${t}</option>\`;
    const dlFold = setFold('dl', '下载和水印', [dlo.strip ? '读不出画师串' : '', dlo.on ? '水印「' + esc(dlo.text) + '」' : ''].filter(Boolean).join(' · ') || '原图下载', \`
      <div class="pc-dim small">看大图、生图结果、历史生图、漫画里点「下载」都按这里来。原图在智库里不变。</div>
      <label class="pc-field"><span>手机上点下载</span><select data-optstr="dlMode">\${opt('auto', '自动：iPhone 弹分享面板，安卓存进 Download', dlo.mode)}\${opt('share', '总是弹分享面板（选「存储图像」进相册）', dlo.mode)}\${opt('file', '总是下载成文件', dlo.mode)}</select></label>
      <div class="pc-hint">iPhone 下载的文件在「文件」App 里，不进相册；要进相册得从分享面板点「存储图像」。安卓下载的在 Download 文件夹，相册一般有「Download / 下载」相簿。</div>
      \${sw('dlStrip', '下载的图读不出画师串', 'NovelAI 原图里藏着正面、负面和画师串，别人拖进读图工具就能看到。开了以后下载的图会去掉这些。')}
      \${sw('dlMark', '下载的图打水印', '填了文字才会打。打水印也会顺带去掉图里的提示词。')}
      <label class="pc-field"><span>水印文字</span><input data-optstr="dlMarkText" maxlength="60" value="\${esc(dlo.text)}" placeholder="比如 @if love"></label>
      <div class="pc-row" style="gap:8px;flex-wrap:wrap">
        <label class="pc-field" style="flex:1;min-width:120px"><span>位置</span><select data-optstr="dlMarkPos">\${opt('br', '右下', dlo.pos)}\${opt('bl', '左下', dlo.pos)}\${opt('tr', '右上', dlo.pos)}\${opt('tl', '左上', dlo.pos)}\${opt('c', '正中', dlo.pos)}\${opt('tile', '斜着铺满', dlo.pos)}</select></label>
        <label class="pc-field" style="flex:1;min-width:120px"><span>不透明度</span><input type="range" min="0.1" max="1" step="0.05" data-optstr="dlMarkAlpha" value="\${dlo.alpha}"></label>
        <label class="pc-field" style="flex:1;min-width:120px"><span>字号</span><input type="range" min="1" max="10" step="0.5" data-optstr="dlMarkSize" value="\${dlo.size}"></label>
      </div>
      <div class="pc-actions wrap"><button class="pc-btn" data-act="dlmarkpreview">看看效果</button></div>\`);
    const ai = ai0 + aipFold + dlFold;
    const tpl = setFold('tpl', '例图提示词',`);
patch(`            case 'saveresult': await saveStudioResult(); break;`,`            case 'dlmarkpreview': {
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
                const box = modal(\`<h3 class="pc-h3">水印效果</h3><img src="\${url}" alt="" style="width:100%;border-radius:10px"><div class="pc-actions"><button class="pc-btn" type="button" data-x="close">关闭</button></div>\`);
                box.addEventListener('click', ev => { if (ev.target.closest('[data-x="close"]')) box.closeModal(); });
                break;
            }
            case 'quickshare': {
                if (!L.serverBase()) { toastr.warning('先到「设置」里填共享服务器地址', '共享'); break; }
                const st = ui.studio;
                openSharedUpload({ artistString: st.pos, negative: st.neg, image: st.result });
                break;
            }
            case 'saveresult': await saveStudioResult(); break;`);
patch(`                const name = await promptText('新预设的名字', '我的预设');
                if (name == null) break;
                const cfg = T.aiCfg(), id = M.uid('ap');
                cfg.list[id] = { id, name: name.trim() || '我的预设', ents:`,`                const cfg = T.aiCfg(), id = M.uid('ap');
                let k = Object.keys(cfg.list).length + 1;
                while (Object.values(cfg.list).some(x => x.name === '我的预设 ' + k)) k++;
                const name = '我的预设 ' + k;
                toastr.success(\`新建好了「\${name}」，想换名字点「改名」\`, 'AI 预设', { timeOut: 2500 });
                cfg.list[id] = { id, name, ents:`);
patch(`                const name = await promptText('给这段固定提示词起个名字', sceneName(p.scene));
                if (name == null) break;
                ui.studio.scenes = [{ ...p, name: name.trim() || '没起名' }, ...(ui.studio.scenes || [])];
                ui.studio.recentScenes = (ui.studio.recentScenes || []).filter(x => sceneSig(x) !== sceneSig(p));
                saveStudio(); toastr.success('存好了', '固定提示词', { timeOut: 1500 }); render(); break;`,`                ui.studio.scenes = [{ ...p, name: sceneName(p.scene) || '没起名' }, ...(ui.studio.scenes || [])];
                ui.studio.recentScenes = (ui.studio.recentScenes || []).filter(x => sceneSig(x) !== sceneSig(p));
                saveStudio(); toastr.success('存好了，想换名字点它旁边的「改名」', '固定提示词', { timeOut: 2500 }); render(); break;`);
patch(`        <button class="pc-btn" data-act="saveresult">存为例图</button>`,`        <button class="pc-btn" data-act="saveresult">存为例图</button>
        <button class="pc-btn" data-act="quickshare">上传到共享</button>`);
patch(`        <a class="pc-btn" data-pc-href="\${esc(x.url)}" download="zhiku_\${x.at}.png">下载</a>`,`        <a class="pc-btn" data-pc-href="\${esc(x.url)}" download="zhiku_\${x.at}.png">下载</a>
        <button class="pc-btn" type="button" data-h="share">上传到共享</button>`);
patch(`        if (act === 'close') box.closeModal();
        if (act === 'delete') { if (!(await confirmBox('删掉这张图？图片也会删掉。'`,`        if (act === 'close') box.closeModal();
        if (act === 'share') {
            if (!L.serverBase()) { toastr.warning('先到「设置」里填共享服务器地址', '共享'); return; }
            box.closeModal();
            openSharedUpload({ artistString: x.prompt || x.raw || '', negative: x.negative || '', image: await pcLocal.url(x.url) });
        }
        if (act === 'delete') { if (!(await confirmBox('删掉这张图？图片也会删掉。'`);
patch(`function openSharedUpload() {`,`function openSharedUpload(pre = {}) {`);
patch(`required placeholder="给这串起个名字"></label>`,`required placeholder="给这串起个名字" value="\${esc(pre.title || '')}"></label>`);
patch(`required placeholder="artist:aaa, 0.8::artist:bbb::"></textarea>`,`required placeholder="artist:aaa, 0.8::artist:bbb::">\${esc(pre.artistString || '')}</textarea>`);
patch(`name="negative" maxlength="20000" placeholder="lowres, bad anatomy …"></textarea>`,`name="negative" maxlength="20000" placeholder="lowres, bad anatomy …">\${esc(pre.negative || '')}</textarea>`);
patch(`      <label class="pc-switch"><input type="checkbox" name="nsfw"><span></span>含 NSFW 内容</label>
      <p class="pc-dim small" data-share-status`,`      <label class="pc-switch"><input type="checkbox" name="nsfw"><span></span>含 NSFW 内容</label>
      \${(() => { const o = dlOpts(); return \`<label class="pc-switch"><input type="checkbox" name="mark" \${o.on ? 'checked' : ''} \${o.text ? '' : 'disabled'}><span></span>例图打上我的水印<small>\${o.text ? '「' + esc(o.text) + '」，位置和大小在 设置 →「下载和水印」' : '先到 设置 →「下载和水印」填水印文字'}</small></label>\`; })()}
      <p class="pc-dim small" data-share-status`);
patch(`    box.querySelector('[data-share-cancel]').addEventListener('click', () => { if (!busy) box.closeModal(); });`,`    box.querySelector('[data-share-cancel]').addEventListener('click', () => { if (!busy) box.closeModal(); });
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
    })();`);
patch("        if (busy) return;\n        const value = name => form.elements.namedItem(name).value.trim();", "        if (busy) return;\n        if (preLoading && !files.files.length) { say('例图正在载入，请稍等再发布。'); return; }\n        const value = name => form.elements.namedItem(name).value.trim();");
patch(`        const nsfw = form.elements.namedItem('nsfw').checked;`,`        const nsfw = form.elements.namedItem('nsfw').checked;
        const mark = !!form.elements.namedItem('mark')?.checked;`);
patch(`                const data = await shrinkDataUrl(await fileToDataUrl(selected[i]), 1024, 0.85);`,`                const src = mark ? await processImage(selected[i], { ...dlOpts(), strip: false, on: true }) : selected[i];
                const data = await shrinkDataUrl(await fileToDataUrl(src), 1024, 0.85);`);
// 共享：性向标签（男性向/女性向/全性向）+ 只能从标签表里选；只分享画师串和负面；屏蔽作者/单条；详情先看图
patch(`const AUD = ['BL', 'BG', 'GB', 'GL'];`,`const AUD = ['BL', 'BG', 'GB', 'GL'];
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
    return LOBBY_TAGS.map(([title, list, single]) => \`<div class="pc-field"><span>\${title}\${single ? '（必选一个）' : '（可多选）'}</span><div class="pc-chips wrap" data-tagset="\${title}" \${single ? 'data-single' : ''}>\${list.map(t => \`<button type="button" class="pc-pill \${on.has(t) ? 'on' : 'dashed'}" data-tagpick="\${esc(t)}">\${esc(t)}</button>\`).join('')}</div></div>\`).join('');
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
        const box = modal(\`<h3 class="pc-h3">选标签</h3>\${lobbyTagPicker(sel)}<p class="pc-dim small" data-tagerr></p>
          <div class="pc-actions"><button class="pc-btn" type="button" data-x="no">取消</button><button class="pc-btn dark" type="button" data-x="ok">好了</button></div>\`);
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
const KEEP_STYLE = /^(?:masterpiece|best quality|amazing quality|high quality|good quality|very aesthetic|aesthetic|absurdres|highres|ultra[- ]detailed|detailed|newest|recent|year \\d{4}|\\d{4}s|no text|official art|illustration|painting|sketch|lineart|flat color|watercolor.*|water color.*|oil painting.*|realistic|photorealistic|semi-realistic|anime coloring|cel shading|chiaroscuro|.*lighting|.*rendering|depth of field|bokeh|.*shading|.*texture[s]?|.*style)$/i;
function artistOnly(text) {
    const src = String(text || '');
    const parts = [];
    let cur = '', open = false;
    for (const seg of src.split(/(,|\\n)/)) {
        if ((seg === ',' || seg === '\\n') && !open) { parts.push(cur); cur = ''; continue; }
        cur += seg;
        const n = (seg.match(/::/g) || []).length;
        if (n % 2) open = !open;
    }
    parts.push(cur);
    const keep = parts.map(p => p.trim()).filter(Boolean).filter(p => {
        if (/artist:/i.test(p) || /::/.test(p)) return true;
        const bare = p.replace(/^[{[(]+|[}\\])]+$/g, '').replace(/:[\\d.]+$/, '').trim();
        return KEEP_STYLE.test(bare);
    });
    return keep.join(', ');
}
const lobbyBlock = () => { const o = getData().options; o.lobbyBlock ||= { users: [], posts: [] }; o.lobbyBlock.users ||= []; o.lobbyBlock.posts ||= []; return o.lobbyBlock; };`);
patch(`    const items = lb.items.filter(p => (p.mine || !p.tags.some(t => blocked.has(t))) && (!lb.tag2 || p.tags.includes(lb.tag2)));
    const tags = lb.tags.map(t => t.tag).filter(t => t !== 'NSFW' && !AUD.includes(t));`,`    const blk = lobbyBlock();
    const items = lb.items.filter(p => (p.mine || (!p.tags.some(t => blocked.has(t)) && !blk.users.includes(p.nickname) && !blk.posts.includes(p.id))) && (!lb.tag2 || p.tags.includes(lb.tag2)));
    const tags = lb.tags.map(t => t.tag).filter(t => t !== 'NSFW' && !AUD.includes(t) && !ORIENT.includes(t));`);
patch(`      \${AUD.map(t => \`<button class="pc-pill \${lb.tag === t ? 'on' : 'dashed'}" data-act="lobbyaud" data-tag="\${t}">\${t}</button>\`).join('')}`,`      \${[...ORIENT, ...AUD].map(t => \`<button class="pc-pill \${lb.tag === t ? 'on' : 'dashed'}" data-act="lobbyaud" data-tag="\${t}">\${t}</button>\`).join('')}`);
patch(`      \${p.content?.artistString ? \`<div class="pc-dim small mono" style="word-break:break-all">\${markStr(getData(), p.content.artistString)}</div>\${banWarn(getData(), p.content.artistString)}\` : ''}
      \${p.content?.negative ? \`<div class="pc-dim small mono" style="word-break:break-all;margin-top:6px">负面：\${esc(p.content.negative)}</div>\` : ''}
      <div class="pc-hscroll pc-mt-s">\${p.images.map(i => \`<img class="pc-sheet-img" src="\${esc(L.lobbyImgUrl(i.url))}" alt="" data-act="viewimg" data-src="\${esc(L.lobbyImgUrl(i.url))}">\`).join('')}</div>`,`      \${p.images.length ? \`<div class="pc-hscroll pc-mt-s">\${p.images.map(i => \`<img class="pc-sheet-img" src="\${esc(L.lobbyImgUrl(i.url))}" alt="" data-act="viewimg" data-src="\${esc(L.lobbyImgUrl(i.url))}">\`).join('')}</div>\` : ''}
      \${p.content?.artistString ? \`<div class="pc-label">画师串</div><div class="pc-dim small mono" style="word-break:break-all;max-height:7.5em;overflow:auto;scrollbar-width:none">\${markStr(getData(), p.content.artistString)}</div>\${banWarn(getData(), p.content.artistString)}\` : ''}
      \${p.content?.negative ? \`<details class="pc-details pc-mt-s"><summary class="pc-dim small">负面（\${p.content.negative.length} 字，点开看）</summary><div class="pc-dim small mono" style="word-break:break-all">\${esc(p.content.negative)}</div></details>\` : ''}`);
patch(`        \${p.mine ? \`<button class="pc-btn danger" data-act="lobbydel" data-id="\${p.id}">删除</button>\` : \`<button class="pc-btn" data-act="lobbyreport" data-id="\${p.id}">举报</button>\`}`,`        \${p.mine ? \`<button class="pc-btn danger" data-act="lobbydel" data-id="\${p.id}">删除</button>\` : \`<button class="pc-btn" data-act="lobbyreport" data-id="\${p.id}">举报</button><button class="pc-btn" data-act="lobbyblockpost" data-id="\${p.id}">屏蔽这条</button><button class="pc-btn" data-act="lobbyblockuser" data-nick="\${esc(p.nickname)}">屏蔽作者</button>\`}`);
patch(`            case 'lobbyaud':`,`            case 'lobbyblockpost': { const b = lobbyBlock(); if (!b.posts.includes(el.dataset.id)) b.posts.push(el.dataset.id); commit(); toastr.info('这条不再显示，可以在 设置 → 共享 里恢复', '共享', { timeOut: 2500 }); break; }
            case 'lobbyblockuser': { const n = el.dataset.nick; if (!n) break; if (!(await confirmBox(\`屏蔽「\${n}」？他分享的都不再显示（只在你这里，对方不会知道）。\`))) break; const b = lobbyBlock(); if (!b.users.includes(n)) b.users.push(n); commit(); toastr.info(\`已屏蔽「\${n}」\`, '共享', { timeOut: 2500 }); break; }
            case 'unblockuser': { const b = lobbyBlock(); b.users = b.users.filter(x => x !== el.dataset.nick); commit(); break; }
            case 'unblockposts': { lobbyBlock().posts = []; commit(); break; }
            case 'lobbyaud':`);
patch(`'<button class="pc-pill dashed" data-act="unblockall">全部取消</button>' : ''}</div>\`);`,`'<button class="pc-pill dashed" data-act="unblockall">全部取消</button>' : ''}</div>
      \${label('屏蔽的作者')}
      <div class="pc-chips wrap">\${lobbyBlock().users.map(n => \`<button class="pc-pill blocked" data-act="unblockuser" data-nick="\${esc(n)}">⊘ \${esc(n)}</button>\`).join('') || '<span class="pc-dim small">没有。在共享里点开一条，点「屏蔽作者」。</span>'}</div>
      \${lobbyBlock().posts.length ? \`<div class="pc-actions wrap"><span class="pc-dim small">屏蔽了 \${lobbyBlock().posts.length} 条分享</span><button class="pc-pill dashed" data-act="unblockposts">全部恢复</button></div>\` : ''}\`);`);
patch(`      <label class="pc-field"><span>标签（可选，逗号隔开）</span><input class="pc-input" name="tags" maxlength="800" placeholder="BL, 厚涂, 柔和"></label>`,`      \${lobbyTagPicker(pre.tags || [])}`);
patch(`required placeholder="artist:aaa, 0.8::artist:bbb::">\${esc(pre.artistString || '')}</textarea></label>`,`required placeholder="artist:aaa, 0.8::artist:bbb::">\${esc(artistOnly(pre.artistString || ''))}</textarea><small class="pc-dim" style="display:block;margin-top:4px">只分享画师串和画风、质量词；人物、动作、衣服、场景这些标签会自动去掉。</small></label>`);
patch(`        const apply = () => { pos.value = meta.positive; neg.value`,`        const apply = () => { pos.value = artistOnly(meta.positive); neg.value`);
patch(`        if (pos.value.trim() === meta.positive && neg.value.trim()`,`        if (pos.value.trim() === artistOnly(meta.positive) && neg.value.trim()`);
patch(`        const name = value('title'), nickname = value('signature'), artistString = value('artistString'), negative = value('negative');`,`        const name = value('title'), nickname = value('signature'), artistString = artistOnly(value('artistString')), negative = value('negative');`);
patch(`        const tags = value('tags').split(/[,，\\n]/).map(s => s.trim()).filter(Boolean);`,`        const tags = pickedTags(box).filter(t => LOBBY_TAG_SET.has(t));
        if (!tags.some(t => ORIENT.includes(t))) { say('先在标签里选一个性向：男性向、女性向或全性向。'); return; }`);
patch(`    const form = box.querySelector('form');
    const status = box.querySelector('[data-share-status]');`,`    const form = box.querySelector('form');
    wireTagPicker(box);
    const status = box.querySelector('[data-share-status]');`);
patch(`    const ai = await chooseBox('适合哪类？', ['BL', 'BG', 'GB', 'GL', '都适合 / 不分']);
    if (ai == null) return;
    const tagText = await promptText('再加几个标签，方便别人搜索（逗号隔开，比如：厚涂, 男性向）', '');
    if (tagText == null) return;`,`    const picked = await chooseLobbyTags();
    if (!picked) return;`);
patch(`        tags: [...(ai < 4 ? [AUD[ai]] : []), ...tagText.split(/[,，]/).map(s => s.trim()).filter(Boolean)],
        nsfw: images.some(i => i.nsfw),
        content: { artistString: M.ticketString(d, ref), members },`,`        tags: picked,
        nsfw: images.some(i => i.nsfw),
        content: { artistString: M.ticketString(d, ref), members, ...(M.ticketNeg(d, ref) ? { negative: M.ticketNeg(d, ref) } : {}) },`);
// 提示词体检：多出来的 ::、权重前面混进的下划线、没关上的权重、SD 括号权重
patch(`function banWarn(d, str) {`,`/** 找出会让 NovelAI 把后面一大段都按错权重读的写法；fixed 是能自动改好的版本 */
function lintPrompt(text) {
    const t = String(text || '');
    const issues = [], cut = [];
    let open = null;
    for (const m of t.matchAll(/(-?\\d+(?:\\.\\d+)?)?::/g)) {
        const head = t.slice(0, m.index);
        const junk = m[1] && /(^|[,\\s])_+$/.test(head);
        const isNum = m[1] && (m.index === 0 || /[\\s,{}\\[\\]()|:]/.test(head.at(-1)) || junk);
        if (junk) { const u = head.match(/_+$/)[0]; cut.push([m.index - u.length, u.length]); issues.push(\`权重 \${m[1]}:: 前面多了「\${u}」，NovelAI 认不出这个权重\`); }
        if (isNum) { open = { at: m.index, w: m[1] }; continue; }
        const at = m.index + (m[1] ? m[1].length : 0);
        if (open) { open = null; continue; }
        cut.push([at, 2]);
        const near = t.slice(Math.max(0, at - 12), at + 14).trim();
        issues.push(\`多了一个「::」（\${near}）：前面没有开头的权重，可能打乱后面词的权重\`);
    }
    if (open) issues.push(\`「\${open.w}::」没有关上，后面整段（包括画面描述）都会按 \${open.w} 倍算\`);
    const sd = (t.match(/\\([^()]*:\\s*-?\\d+(?:\\.\\d+)?\\s*\\)/g) || []).length;
    let fixed = t;
    for (const [at, len] of cut.sort((a, b) => b[0] - a[0])) fixed = fixed.slice(0, at) + fixed.slice(at + len);
    fixed = fixed.replace(/,\\s*,/g, ',').replace(/\\s{2,}/g, ' ');
    return { issues, sd, fixed, canFix: cut.length > 0 };
}
function lintHtml(text) {
    const r = lintPrompt(text);
    if (!r.issues.length && !r.sd) return '';
    return \`<div class="pc-banwarn">\${r.issues.map(x => \`<div>⚠ \${esc(x)}</div>\`).join('')}\${r.sd ? \`<div>ⓘ 有 \${r.sd} 处 SD 写法的 (词:1.3)，发送时会自动换成 1.3::词::</div>\` : ''}\${r.canFix ? '<button class="pc-pill dashed tiny" data-act="lintfix" style="margin-top:6px">一键修正</button>' : ''}</div>\`;
}
function banWarn(d, str) {`);
patch(`      <div id="pc-pos-ban">\${banWarn(d, st.pos)}</div>`,`      <div id="pc-pos-ban">\${banWarn(d, st.pos)}\${lintHtml(st.pos)}</div>`);
patch(`if (w) w.innerHTML = banWarn(getData(), el.value); }`,`if (w) w.innerHTML = banWarn(getData(), el.value) + lintHtml(el.value); }`);
patch(`            case 'clearresult':`,`            case 'lintfix': ui.studio.pos = lintPrompt(ui.studio.pos).fixed; saveStudio(); render(); toastr.success('改好了，发送前再看一眼', '智库', { timeOut: 2000 }); break;
            case 'clearresult':`);
// 从 SD / WebUI 复制来的 (tag:1.3) 权重，NovelAI 不认，发送前换成 1.3::tag::
patch(`function composeStudio({ pos = '', neg = '', scene = '' }, s = N.settings()) {`,`/** (tag:1.3) → 1.3::tag::；不带数字的括号（比如 rourou (been)）不动 */
function sdWeights(text) {
    let t = String(text || ''), prev;
    do { prev = t; t = t.replace(/\\(([^()]*?(?:\\([^()]*\\)[^()]*?)*?):\\s*(-?\\d+(?:\\.\\d+)?)\\s*\\)/g, (_, tag, w) => \`\${Number(w)}::\${tag.trim()}::\`); } while (t !== prev);
    return t;
}
function composeStudio({ pos = '', neg = '', scene = '' }, s = N.settings()) {
    pos = sdWeights(pos); neg = sdWeights(neg); scene = sdWeights(scene);`);
// 没登记的角色照样画，提示一句
patch(`    const built = buildChatPrompt(parsed.scene, parsed.picks);`,`    if (parsed.unknown?.length) toastr.info(\`「\${parsed.unknown.join('、')}」没在角色页登记（或这次聊天没开），按图里写的标签画\`, '智库', { timeOut: 4000 });
    const built = buildChatPrompt(parsed.scene, parsed.picks);`);
// 图片显示偏好：旧数据由 normalizeData 合并默认值，用户关闭后保留 false。
patch('        options: {', '        options: {\n            imageExpanded: true,');
patch("${sw('markerAuto', '开启标记自动生图', '默认开启 · 回复出现完整生图标记时自动生成，提示词默认折叠')}",
    "${sw('markerAuto', '开启标记自动生图', '默认开启 · 回复出现完整生图标记时自动生成，提示词默认折叠')}${sw('imageExpanded', '图片默认展开', '开启：默认展开；关闭：默认折叠。立即应用到当前图片，并记住选择。')}");
patch('if (el.dataset.opt) { d.options[el.dataset.opt] = el.checked; commit(); return; }',
    "if (el.dataset.opt) { d.options[el.dataset.opt] = el.checked; if (el.dataset.opt === 'imageExpanded') __mod_marker.applyImageDefault(); commit(); return; }");
// Keep compatibility preview/reference loading and lifecycle cleanup aligned with the request.
patch("function canSplit() {\n    const s = N.settings();\n    return s.naiMode !== 'tavern' && s.novelaimode !== 'nai-diffusion-3';", "function canSplit() {\n    const s = N.settings();\n    return s.naiMode !== 'tavern' && s.novelaimode !== 'nai-diffusion-3' && !(s.naiMode === 'site' && String(s.naiSiteSimple) === 'true');");
patch("function canSplit() {\n    const s = N.settings();\n    return s.naiMode","function canSplit() {\n    const s = N.settings();\n    if (getData().options.chatNoSplit) return false;\n    return s.naiMode");
patch("return s.naiMode !== 'tavern' && s.novelaimode.includes('4-5');", "return s.naiMode !== 'tavern' && s.novelaimode.includes('4-5') && !(s.naiMode === 'site' && String(s.naiSiteSimple) === 'true');");
patch("        model,\n    };", "        model,\n        director: params.director_reference_images_cached?.length || 0,\n    };");
patch("director: opts.director?.length || 0 };", "director: r.sent.director ?? (opts.director?.length || 0) };");
patch(".pc-mes-gen, .pc-mes-outfit", ".pc-mes-gen, .pc-mes-outfit, .pc-mes-comic");
s=applyComfyCompatibility(s);
s=applySharingWardrobeCompatibility(s);
patch('return { AI_FNS, extractCastFromChat, apiFor, aiSeen, aiCfg,', 'return { AI_FNS, stopFetch, extractCastFromChat, apiFor, aiSeen, aiCfg,');

// 0.8.36：角色的 NSFW 身体标签，只在 NSFW 图里加
patch(`    appearance: [], outfitMode: 'story', outfits: [], outfitId: '', negative: '', charRef: '',`,`    appearance: [], nsfwBody: [], outfitMode: 'story', outfits: [], outfitId: '', negative: '', charRef: '',`);
patch(`const charPairs = c => [...(c.appearance || []), `,`const charPairs = c => [...(c.appearance || []), ...(c.nsfwBody || []), `);
patch(`function fixedTags(c) {
    const parts = [tagText(c.appearance)];`,`function fixedTags(c, { nsfw = false } = {}) {
    const parts = [tagText(c.appearance)];
    // NSFW 身体：只有这张图是 NSFW 时才加
    if (nsfw) parts.push(tagText(c.nsfwBody));`);
patch(`function buildChatPrompt(scene, picks) {`,`function buildChatPrompt(scene, picks, { nsfw = /(?:^|[,;\\s])nsfw(?:$|[,;\\s])/i.test(String(scene || '')) } = {}) {`);
patch(`M.mergeTags(base, ...picks.map(p => [fixedTags(p.char), p.tags]`,`M.mergeTags(base, ...picks.map(p => [fixedTags(p.char, { nsfw }), p.tags]`);
patch(`soloize([fixedTags(p.char), p.tags]`,`soloize([fixedTags(p.char, { nsfw }), p.tags]`);
patch(`    const built = buildChatPrompt(parsed.scene, parsed.picks);
    const rating = plan?.rating?.toLowerCase() || (/^nsfw(?:,|$)/i.test(parsed.scene) ? 'nsfw' : undefined);`,`    const rating = plan?.rating?.toLowerCase() || (/^nsfw(?:,|$)/i.test(parsed.scene) ? 'nsfw' : undefined);
    const built = buildChatPrompt(parsed.scene, parsed.picks, { nsfw: rating === 'nsfw' });`);
patch(`function studioCastPick(e) {
    const ch = getChar(e.key);
    if (!ch) return null;
    const out = e.outfit === '' ? null : (ch.outfits.find(o => o.id === e.outfit) || currentOutfit(ch));
    return { char: ch, pos: CAST_X[e.pos] ? e.pos : 'C', tags: [tagText(ch.appearance), tagText(out?.tags)]`,`function studioCastPick(e, nsfw = false) {
    const ch = getChar(e.key);
    if (!ch) return null;
    const out = e.outfit === '' ? null : (ch.outfits.find(o => o.id === e.outfit) || currentOutfit(ch));
    return { char: ch, pos: CAST_X[e.pos] ? e.pos : 'C', tags: [tagText(ch.appearance), nsfw ? tagText(ch.nsfwBody) : '', tagText(out?.tags)]`);
patch(`    const picks = (cast || []).map(studioCastPick).filter(Boolean);`,`    const nsfw = /(?:^|[,;\\s])nsfw(?:$|[,;\\s])/i.test(String(pos || ''));
    const picks = (cast || []).map(e => studioCastPick(e, nsfw)).filter(Boolean);`);
patch(`return { character: { name: c.name, appearance: c.appearance, `,`return { character: { name: c.name, appearance: c.appearance, nsfwBody: c.nsfwBody || [], `);
patch(`? { name: src.name, appearance: src.appearance, `,`? { name: src.name, appearance: src.appearance, nsfwBody: Array.isArray(src.nsfwBody) ? src.nsfwBody : [], `);
patch(`    b.appearance = structuredClone(a.appearance);`,`    b.appearance = structuredClone(a.appearance);
    b.nsfwBody = structuredClone(a.nsfwBody || []);`);
patch(`        outfitMode: Object.keys(outfits).length ? 'fixed' : 'story',
        outfits: Object.entries(outfits).map(([n, o]) => fromZhihuijiOutfit(n, o)),`,`        // 智绘姬里带 nsfw 的字段（NSFW 身体特征）放进「NSFW 身体」
        nsfwBody: parsePairs(Object.entries(ch || {}).filter(([k, v]) => /nsfw/i.test(k) && typeof v === 'string' && v.trim() && !T.hasChinese(v.replace(/（[^（）]*）/g, ''))).map(([, v]) => v).join(', ')),
        outfitMode: Object.keys(outfits).length ? 'fixed' : 'story',
        outfits: Object.entries(outfits).map(([n, o]) => fromZhihuijiOutfit(n, o)),`);
patch(`只输出 JSON：{"appearance": [...], "outfit": [...]}。设定里没写的不要编。\`;`,`NSFW 身体单独放进 nsfw：只给明确是成年人的角色写（未成年、年龄不明、非人类幼体一律留空 []）。写脱了衣服才看得到的身体特征：乳头 / 乳晕颜色和大小、阴毛、私处、男性的阴茎等；设定写了就照写，没写的按这个人的身材和气质补 2～4 个常见的。不要写动作和姿势。
只输出 JSON：{"appearance": [...], "outfit": [...], "nsfw": [...]}。外貌和衣服设定里没写的不要编。\`;`);
patch(`    return { appearance: norm(j.appearance), outfit: norm(j.outfit) };`,`    return { appearance: norm(j.appearance), outfit: norm(j.outfit), nsfw: norm(j.nsfw) };`);
patch(`只输出 JSON：{"people": [{"name": "正文里的名字", "aliases": ["昵称、称呼、别的叫法"], "appearance": [...], "outfit": [...]}]}\`;`,`NSFW 身体单独放进 nsfw：只给明确是成年人的角色写（未成年、年龄不明、非人类幼体一律留空 []）。写脱了衣服才看得到的身体特征：乳头 / 乳晕颜色和大小、阴毛、私处、男性的阴茎等；设定写了就照写，没写的按这个人的身材和气质补 2～4 个常见的。不要写动作和姿势。
只输出 JSON：{"people": [{"name": "正文里的名字", "aliases": ["昵称、称呼、别的叫法"], "appearance": [...], "outfit": [...], "nsfw": [...]}]}\`;`);
patch(`只输出 JSON：{"people": [{"name": "设定里的名字", "aliases": ["昵称、简称、别的叫法"], "appearance": [...], "outfit": [...]}]}\`;`,`NSFW 身体单独放进 nsfw：只给明确是成年人的角色写（未成年、年龄不明、非人类幼体一律留空 []）。写脱了衣服才看得到的身体特征：乳头 / 乳晕颜色和大小、阴毛、私处、男性的阴茎等；设定写了就照写，没写的按这个人的身材和气质补 2～4 个常见的。不要写动作和姿势。
只输出 JSON：{"people": [{"name": "设定里的名字", "aliases": ["昵称、简称、别的叫法"], "appearance": [...], "outfit": [...], "nsfw": [...]}]}\`;`);
{ const a=`        appearance: norm(p?.appearance), outfit: norm(p?.outfit),`; assert(s.split(a).length===3, 'patchall '+a.slice(0,40)); s=s.split(a).join(`        appearance: norm(p?.appearance), outfit: norm(p?.outfit), nsfw: norm(p?.nsfw),`); }
patch(`                        ch.appearance = p.appearance;`,`                        ch.appearance = p.appearance;
                        if (p.nsfw?.length && !(ch.nsfwBody || []).length) ch.nsfwBody = p.nsfw;`);
patch(`                c.appearance = r.appearance;`,`                c.appearance = r.appearance;
                if (r.nsfw?.length) c.nsfwBody = r.nsfw;`);
patch(`addText: { app: '', out: '' },`,`addText: { app: '', nsfw: '', out: '' },`);
patch(`      <div class="pc-addrow"><textarea rows="1" data-bind="addText.app" placeholder="自己加，中文也行，可以一次粘贴好几个" data-enter="addpair-app">\${esc(ui.addText.app)}</textarea><button class="pc-btn dark" data-act="addpair" data-where="app" \${busy ? 'disabled' : ''}>\${busy === 'app' ? '…' : '加'}</button></div>
    </section>`,`      <div class="pc-addrow"><textarea rows="1" data-bind="addText.app" placeholder="自己加，中文也行，可以一次粘贴好几个" data-enter="addpair-app">\${esc(ui.addText.app)}</textarea><button class="pc-btn dark" data-act="addpair" data-where="app" \${busy ? 'disabled' : ''}>\${busy === 'app' ? '…' : '加'}</button></div>
    </section>

    <section class="pc-card pc-pad pc-mt">
      <div class="pc-row-between"><b>NSFW 身体</b><span class="pc-dim small">只在 NSFW 图里发</span></div>
      <div class="pc-dim small">脱了衣服才看得到的：乳头、阴毛、私处这类。只有这张图是 NSFW（标记里带 nsfw、提示词里有 nsfw）时才加进去，SFW 的图不会发。读卡时 AI 会给成年角色顺便写上。</div>
      <div class="pc-pairs">\${pairChips(c.nsfwBody || [], 'nsfw') || '<span class="pc-dim small">还没有</span>'}</div>
      <div class="pc-addrow"><textarea rows="1" data-bind="addText.nsfw" placeholder="自己加，比如 pink nipples, pubic hair，中文也行" data-enter="addpair-nsfw">\${esc(ui.addText.nsfw || '')}</textarea><button class="pc-btn dark" data-act="addpair" data-where="nsfw" \${busy ? 'disabled' : ''}>\${busy === 'nsfw' ? '…' : '加'}</button></div>
    </section>`);
patch(`                if (where === 'app') { for (const p of pairs) if (!c.appearance.some(x => x.en === p.en)) c.appearance.push(p); }`,`                if (where === 'app') { for (const p of pairs) if (!c.appearance.some(x => x.en === p.en)) c.appearance.push(p); }
                else if (where === 'nsfw') { c.nsfwBody ||= []; for (const p of pairs) if (!c.nsfwBody.some(x => x.en === p.en)) c.nsfwBody.push(p); }`);
{ const a=`            const list = el.dataset.where === 'app' ? c.appearance : C.currentOutfit(c)?.tags;`; assert(s.split(a).length===3, 'patchall '+a.slice(0,40)); s=s.split(a).join(`            const list = el.dataset.where === 'app' ? c.appearance : el.dataset.where === 'nsfw' ? (c.nsfwBody ||= []) : C.currentOutfit(c)?.tags;`); }
s=applyPoseInputCompatibility(s);
// 0.8.36：TauriTavern 里本地 /api/ 走页面的 fetch（借来的干净 fetch 拿到的是网页）
s=applyTauriFetchCompatibility(s);
{ const a=`try { json = JSON.parse(raw); } catch { throw new Error('AI 返回的不是正常格式：' + raw.slice(0, 120)); }`; assert(s.split(a).length===3,'html msg'); s=s.split(a).join(`try { json = JSON.parse(raw); } catch { throw new Error(/^\\s*<(?:!doctype|html)/i.test(raw) ? 'AI 请求拿回来的是一张网页，不是 AI 的回复：多半是请求没到后端（客户端或别的插件拦了），或者 AI 地址填成了网页地址（OpenAI 兼容的地址一般以 /v1 结尾）' : 'AI 返回的不是正常格式：' + raw.slice(0, 120)); }`); }
// 0.8.36：新建衣服的三步说明折叠起来
patch(`    \${u.draft ? \`<div class="pc-outsteps">
      <span class="\${img || o.tags.length ? 'done' : ''}"><b>第一步</b>点图片右下「换一张」放一张衣服的图，AI 会写成标签；没图就直接在下面打字加</span>
      <span class="\${o.tags.length ? 'done' : ''}"><b>第二步</b>看看下面的标签：点一下改、× 删掉、↓↑ 在整体和配饰之间挪</span>
      <span class="\${u.dest ? 'done' : ''}"><b>第三步</b>选「存到哪里」：只进衣柜，或者直接给某个人穿，再点「保存」</span></div>\` : ''}`,`    \${u.draft ? (() => { const n = [img || o.tags.length, o.tags.length, u.dest].filter(Boolean).length; return fold('outsteps', '怎么做', n ? \`三步做完 \${n} 步\` : '放图或打字 → 检查标签 → 选存到哪里', \`<div class="pc-outsteps">
      <span class="\${img || o.tags.length ? 'done' : ''}"><b>第一步</b>点图片右下「换一张」放一张衣服的图，AI 会写成标签；没图就直接在下面打字加</span>
      <span class="\${o.tags.length ? 'done' : ''}"><b>第二步</b>看看下面的标签：点一下改、× 删掉、↓↑ 在整体和配饰之间挪</span>
      <span class="\${u.dest ? 'done' : ''}"><b>第三步</b>选「存到哪里」：只进衣柜，或者直接给某个人穿，再点「保存」</span></div>\`); })() : ''}`);
// Choosing the standalone wardrobe also completes the destination step.
patch("case 'outdest': ui.outfit.dest = el.dataset.v; render(); return true;", "case 'outdest': ui.outfit.dest = el.dataset.v; ui.outfit.destChosen = true; render(); return true;");
patch("[img || o.tags.length, o.tags.length, u.dest].filter(Boolean)", "[img || o.tags.length, o.tags.length, u.destChosen || u.dest].filter(Boolean)");
patch("<span class=\"${u.dest ? 'done' : ''}\"><b>第三步</b>", "<span class=\"${u.destChosen || u.dest ? 'done' : ''}\"><b>第三步</b>");
// 0.8.36：生图页垫图（img2img）；存下的固定提示词折叠、加标签、能搜
patch(`    const params = buildParameters(opts);
    const sent = {`,`    const params = buildParameters(opts);
    // 垫图（img2img）：底图已经裁成这次的尺寸
    if (opts.i2i?.image) {
        if (s.naiMode === 'tavern') throw new Error('「用酒馆里的 key」不能垫图，到智库设置 → NovelAI 改成「填我的 key」');
        params.image = opts.i2i.image;
        params.strength = Number(opts.i2i.strength) || 0.7;
        params.noise = Number(opts.i2i.noise) || 0;
        params.extra_noise_seed = params.seed;
    }
    const sent = {`);
patch(`        director: params.director_reference_images_cached?.length || 0,
    };
    if (s.naiMode === 'tavern') {`,`        director: params.director_reference_images_cached?.length || 0,
        ...(opts.i2i?.image ? { i2i: { strength: params.strength, noise: params.noise } } : {}),
    };
    if (s.naiMode === 'tavern') {`);
patch(`body: JSON.stringify({ input: opts.positive, model, action: 'generate', parameters: params, use_new_shared_trial: true }),`,`body: JSON.stringify({ input: opts.positive, model, action: opts.i2i?.image ? 'img2img' : 'generate', parameters: params, use_new_shared_trial: true }),`);
patch(`async function generate({ pos, neg, scene = '', width, height }) {
    const { positive, negative } = composeStudio({ pos, neg, scene });
    return run({ positive, negative, width, height });`,`async function generate({ pos, neg, scene = '', width, height, i2i }) {
    const { positive, negative } = composeStudio({ pos, neg, scene });
    return run({ positive, negative, width, height, i2i });`);
patch(`async function generateFull({ positive, negative, chars = [], width, height, director, backend }) {
    return run({ positive, negative, chars, width, height, director, backend });`,`async function generateFull({ positive, negative, chars = [], width, height, director, backend, i2i }) {
    return run({ positive, negative, chars, width, height, director, backend, i2i });`);
patch(`function studioParts() { return { pos: ui.studio.pos, neg: ui.studio.neg, scene: sceneTags() }; }`,`function studioParts() { return { pos: ui.studio.pos, neg: ui.studio.neg, scene: sceneTags() }; }
/** 垫图：底图按这次的尺寸铺满裁好，返回不带前缀的 PNG base64 */
async function i2iImage(dataUrl, w, h) {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('底图读不出来，换一张试试')); i.src = dataUrl; });
    const c = DOC.createElement('canvas'); c.width = w; c.height = h;
    const k = Math.max(w / img.width, h / img.height), dw = img.width * k, dh = img.height * k;
    c.getContext('2d').drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
    return c.toDataURL('image/png').replace(/^data:image\\/png;base64,/, '');
}
/** 按底图比例算尺寸：64 的倍数，不超过 1024×1024 的像素数（Opus 免费档以内） */
function i2iFitSize(iw, ih) {
    const r = iw / ih, area = 1024 * 1024;
    let h = Math.floor(Math.sqrt(area / r) / 64) * 64, w = Math.floor(h * r / 64) * 64;
    w = Math.max(64, Math.min(w, 1600)); h = Math.max(64, Math.min(h, 1600));
    return [w, h];
}
function i2iFold(s) {
    const g = ui.studio.i2i || {};
    const w = Number(s.novelai_width) || 832, h = Number(s.novelai_height) || 1216;
    const pct = v => Math.round(v * 100) + '%';
    const strength = g.strength ?? 0.7, noise = g.noise ?? 0;
    const fit = g.image && g.iw ? i2iFitSize(g.iw, g.ih) : null;
    const body = g.image ? \`<div class="pc-i2i">
        <img src="\${esc(g.image)}" alt="底图" data-act="viewimg" data-src="\${esc(g.image)}">
        <div class="pc-grow">
          <label class="pc-field"><span>重绘强度 <b data-i2i-out="strength">\${pct(strength)}</b> · 越大越不像底图</span><input type="range" min="0.01" max="0.99" step="0.01" value="\${strength}" data-i2i="strength"></label>
          <label class="pc-field"><span>噪声 <b data-i2i-out="noise">\${pct(noise)}</b> · 加一点能多些细节</span><input type="range" min="0" max="0.99" step="0.01" value="\${noise}" data-i2i="noise"></label>
        </div></div>
      <div class="pc-chips wrap pc-mt-s"><label class="pc-pill dashed tiny" style="cursor:pointer">换一张<input type="file" accept="image/*" data-i2iimg hidden></label>
        \${fit && (fit[0] !== w || fit[1] !== h) ? \`<button class="pc-pill dashed tiny" data-act="i2ifit">尺寸改成底图比例（\${fit[0]}×\${fit[1]}）</button>\` : ''}
        <button class="pc-pill dashed tiny danger" data-act="i2ioff">不垫了</button></div>
      <div class="pc-hint">生成时底图铺满裁成现在的尺寸（\${w}×\${h}）。画师串、提示词、角色、氛围照常发。底图只留在这次打开里，刷新就没了。</div>\`
      : \`<label class="pc-pill dashed" style="cursor:pointer">放一张底图<input type="file" accept="image/*" data-i2iimg hidden></label>
      \${ui.studio.result ? '<button class="pc-pill dashed" data-act="i2iresult">用上面生成的这张</button>' : ''}
      <div class="pc-hint">按底图的构图和颜色重画（img2img）。要用自己的 NovelAI key，酒馆转发不行。</div>\`;
    return fold('i2i', '垫图', g.image ? \`开 · 强度 \${pct(strength)}\${noise ? ' · 噪声 ' + pct(noise) : ''}\` : '没放底图', body);
}`);
patch(`      <div class="pc-mt-s">\${castFold()}</div>`,`      <div class="pc-mt-s">\${castFold()}</div>
      <div class="pc-mt-s">\${i2iFold(s)}</div>`);
patch(`            const ids = C.studioCastRefs(p.picks);
            st.result = await E.generateFull({ ...studioParts(), positive: p.positive, negative: p.negative, chars: p.chars, director: ids.length ? await E.charRefs(ids) : null });
        } else st.result = await E.generate(studioParts());`,`            const ids = C.studioCastRefs(p.picks);
            st.result = await E.generateFull({ ...studioParts(), i2i, positive: p.positive, negative: p.negative, chars: p.chars, director: ids.length ? await E.charRefs(ids) : null });
        } else st.result = await E.generate({ ...studioParts(), i2i });`);
patch(`    st.busy = true; render();
    try {
        const cast = studioCast();
        if (cast.length) {`,`    st.busy = true; render();
    try {
        const g = st.i2i, ns = N.settings();
        const i2i = g?.image ? { image: await i2iImage(g.image, Number(ns.novelai_width) || 832, Number(ns.novelai_height) || 1216), strength: g.strength ?? 0.7, noise: g.noise ?? 0 } : null;
        const cast = studioCast();
        if (cast.length) {`);
patch(`        <button class="pc-btn" data-act="saveresult">存为例图</button>`,`        <button class="pc-btn" data-act="saveresult">存为例图</button>
        <button class="pc-btn" data-act="i2iresult">拿这张垫图</button>`);
patch(`            case 'studiosize': {`,`            case 'i2iresult': { const r = ui.studio.result; if (!r) break; const im = new Image(); im.onload = () => { ui.studio.i2i = { ...(ui.studio.i2i || {}), image: r, iw: im.width, ih: im.height }; ui.studio.open.i2i = true; render(); }; im.src = r; toastr.info('用这张垫图了，调一下重绘强度再生成', '垫图', { timeOut: 2000 }); break; }
            case 'i2ioff': ui.studio.i2i = { ...(ui.studio.i2i || {}), image: '' }; render(); break;
            case 'i2ifit': { const g = ui.studio.i2i; if (!g?.iw) break; const [w, h] = i2iFitSize(g.iw, g.ih); const n = N.settings(); n.novelai_width = String(w); n.novelai_height = String(h); N.save(); render(); break; }
            case 'studiosize': {`);
patch(`    if (el.dataset.wardimg !== undefined || el.dataset.outimg !== undefined) {`,`    if (el.dataset.i2iimg !== undefined) {
        const f = el.files?.[0]; el.value = ''; if (!f) return;
        try {
            const du = await shrinkDataUrl(await fileToDataUrl(f), 1600, 0.92);
            const im = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = du; });
            ui.studio.i2i = { strength: 0.7, noise: 0, ...(ui.studio.i2i || {}), image: du, iw: im.width, ih: im.height };
            ui.studio.open.i2i = true;
        } catch { toastr.error('这张图读不出来，换一张试试', '垫图'); }
        render(); return;
    }
    if (el.dataset.i2i) { const g = (ui.studio.i2i ||= {}); g[el.dataset.i2i] = Number(el.value); render(); return; }
    if (el.dataset.wardimg !== undefined || el.dataset.outimg !== undefined) {`);
patch(`    if (el.dataset.bind) {
        setPath(ui, el.dataset.bind, el.value);`,`    if (el.dataset?.i2i) { const o = root.querySelector(\`[data-i2i-out="\${el.dataset.i2i}"]\`); if (o) o.textContent = Math.round(Number(el.value) * 100) + '%'; }
    if (el.dataset.bind) {
        setPath(ui, el.dataset.bind, el.value);
        if (el.dataset.bind === 'studio.sceneQ') { clearTimeout(onInput.sq); onInput.sq = setTimeout(render, 250); }`);
patch(`.pc-recent-scenes>summary::-webkit-details-marker{display:none}`,`.pc-recent-scenes>summary::-webkit-details-marker{display:none}
.pc-saved-scenes>summary{font-size:13px;color:var(--pc-ink);letter-spacing:.05em}
.pc-scenetags{display:flex;flex-wrap:wrap;gap:4px;margin:3px 0 2px}
.pc-scenetags i{font-style:normal;font-size:11px;padding:1px 8px;border-radius:99px;border:1px solid var(--pc-dash);color:var(--pc-ink-soft)}
.pc-i2i{display:flex;gap:10px;align-items:flex-start}
.pc-i2i img{width:84px;max-height:120px;object-fit:cover;border-radius:12px;cursor:zoom-in}
.pc-i2i input[type=range]{width:100%}`);
patch(`      \${saved.length ? '<div class="pc-promptsec">存下的固定提示词</div>' + saved.map((p, i) => sceneRow(p, i, 'saved')).join('') : ''}`,`      \${saved.length ? (() => {
        const tagsOf = p => (p.tags ??= sceneAutoTags(p.scene));
        const all = [...new Set(saved.flatMap(tagsOf))];
        const f = all.includes(st.sceneTag) || st.sceneTag === '__none' ? st.sceneTag : '', q = String(st.sceneQ || '').trim().toLowerCase();
        const rows = saved.map((p, i) => [p, i]).filter(([p]) => (!f || (f === '__none' ? !tagsOf(p).length : tagsOf(p).includes(f))) && (!q || [p.name, p.scene, p.sceneSrc, ...tagsOf(p)].join(' ').toLowerCase().includes(q)));
        const curP = saved.find(p => sceneSig(p) === sceneSig(sceneSnapshot()));
        const chip = (v, t) => \`<button class="pc-pill tiny \${f === v ? 'on' : 'dashed'}" data-act="scenetag" data-v="\${esc(v)}">\${esc(t)}</button>\`;
        return \`<details class="pc-recent-scenes pc-saved-scenes" \${st.open.savedScenes ? 'open' : ''} data-fold="savedScenes"><summary>存下的固定提示词 \${saved.length} 条\${curP ? \` · 在用「\${esc(curP.name || '没起名')}」\` : ''} ▸</summary>
          \${saved.length > 0 ? \`<label class="pc-search pc-mt-s"><span class="pc-sr">搜固定提示词</span>\${ICON.search}<input data-bind="studio.sceneQ" value="\${esc(st.sceneQ || '')}" placeholder="搜名字、标签、提示词"></label>\` : ''}
          \${all.length ? \`<div class="pc-chips wrap" style="margin-top:8px">\${chip('', '全部')}\${all.map(t => chip(t, t)).join('')}\${saved.some(p => !tagsOf(p).length) ? chip('__none', '没标签') : ''}</div>\` : '<div class="pc-dim small" style="margin-top:6px">点每条的「标签」可以分类，比如 证件照、NSFW、双人</div>'}
          \${rows.map(([p, i]) => sceneRow(p, i, 'saved')).join('') || '<div class="pc-dim small" style="margin-top:8px">没有对得上的</div>'}</details>\`;
      })() : ''}`);
patch(`function sceneRow(p, i, kind) {`,`const SCENE_NSFW = /\\b(?:nsfw|nude|naked|nipples?|areolae?|penis|pussy|vagina|clitoris|sex|cum|ejaculation|masturbation|erection|anus|anal|fellatio|paizuri|handjob|cunnilingus|testicles|pubic hair|topless|bottomless|spread (?:ass|legs|pussy))\\b/i;
/** 没标过的旧条目：带明显 NSFW 词的先标上 NSFW */
const sceneAutoTags = text => SCENE_NSFW.test(String(text || '')) ? ['NSFW'] : [];
function sceneRow(p, i, kind) {`);
patch(`      <div class="pc-grow"><b>\${esc(title)}\${cur ? ' <em>在用</em>' : ''}</b><small class="mono">\${esc(p.scene)}</small></div>`,`      <div class="pc-grow"><b>\${esc(title)}\${cur ? ' <em>在用</em>' : ''}</b>\${kind === 'saved' && p.tags?.length ? \`<span class="pc-scenetags">\${p.tags.map(t => \`<i>\${esc(t)}</i>\`).join('')}</span>\` : ''}<small class="mono">\${esc(p.scene)}</small></div>`);
patch(`\`<button class="pc-pill tiny dashed" data-act="scenerename" data-i="\${i}">改名</button>\`}`,`\`<button class="pc-pill tiny dashed" data-act="scenerename" data-i="\${i}">改名</button><button class="pc-pill tiny dashed" data-act="scenetags" data-i="\${i}">标签</button>\`}`);
patch(`            case 'scenerename': {`,`            case 'scenetag': ui.studio.sceneTag = el.dataset.v || ''; render(); break;
            case 'scenetags': {
                const p = ui.studio.scenes?.[Number(el.dataset.i)];
                if (!p) break;
                const had = [...new Set((ui.studio.scenes || []).flatMap(x => x.tags || []))];
                const t = await promptText(\`「\${p.name || '没起名'}」的标签，逗号隔开\${had.length ? \`（已有：\${had.join('、')}）\` : '（比如 证件照，NSFW，双人）'}\`, (p.tags || []).join('，'));
                if (t == null) break;
                p.tags = [...new Set(t.split(/[,，、;；\\n]+/).map(x => x.trim()).filter(Boolean))].slice(0, 8);
                saveStudio(); render(); break;
            }
            case 'scenerename': {`);
// 0.8.36：生图页双人每人单独写动作；固定提示词排到衣服前面；生图页不受「聊天不分角色」影响
patch(`    return { char: ch, pos: CAST_X[e.pos] ? e.pos : 'C', tags: [tagText(ch.appearance), nsfw ? tagText(ch.nsfwBody) : '', tagText(out?.tags)].filter(Boolean).join(', '), x: CAST_X[e.pos] ?? 0.5 };
}`,`    const look = [tagText(ch.appearance), nsfw ? tagText(ch.nsfwBody) : ''].filter(Boolean).join(', ');
    const act = String(e.act || '').trim(), fit = tagText(out?.tags);
    // 分角色时：外貌 → 这个人的动作 → 衣服，动作别被一长串衣服挤到最后
    return { char: ch, pos: CAST_X[e.pos] ? e.pos : 'C', look, act, fit, tags: [look, act, fit].filter(Boolean).join(', '), x: CAST_X[e.pos] ?? 0.5 };
}`);
patch(`    if (picks.length === 1 || !canSplit()) {
        const lead = picks.length === 1 ? 'solo' : (hasCount ? '' : countTags(chars));
        return { ...E.composeStudio({ pos: M.mergeTags(pos, lead, ...picks.map(p => p.tags)), neg: negAll, scene }), chars: [], picks };
    }`,`    if (picks.length === 1 || !canSplit({ chat: false })) {
        const lead = picks.length === 1 ? 'solo' : (hasCount ? '' : countTags(chars));
        // 固定提示词（动作、镜头）放在外貌后面、衣服前面：NovelAI 越靠前越听话，原来排在一长串衣服后面容易被忽略
        return { ...E.composeStudio({ pos: M.mergeTags(pos, lead, ...picks.map(p => [p.look, p.act].filter(Boolean).join(', ')), scene, ...picks.map(p => p.fit)), neg: negAll, scene: '' }), chars: [], picks };
    }`);
patch(`    const n = list.length, split = C.canSplit();`,`    const n = list.length, split = C.canSplit({ chat: false });`);
patch(`          <div class="pc-casttags mono">\${look ? esc(look) : '这个角色还没写外貌：去「角色」页写一下，或者在提示词里自己写'}</div>`,`          <div class="pc-casttags mono">\${look ? esc(look) : '这个角色还没写外貌：去「角色」页写一下，或者在提示词里自己写'}</div>
          \${n > 1 ? \`<input class="pc-castact mono" data-castact="\${k}" value="\${esc(e.act || '')}" placeholder="\${esc(c.name)}自己的动作、表情">\` : ''}`);
patch(`      <div class="pc-castmode">\${mode}</div>\${rows}`,`      <div class="pc-castmode">\${mode}</div>\${n > 1 ? \`<div class="pc-dim small" style="margin-top:6px">\${split ? '两个人容易弄错谁在做什么：' : ''}每个人的动作、表情写在他自己那一栏，固定提示词里只放镜头、场景这类大家共用的。两人之间的动作用 NovelAI 的互动写法：做的人写 <span class="mono">source#hug</span>，被做的人写 <span class="mono">target#hug</span>，一起做写 <span class="mono">mutual#hug</span>。</div>\` : ''}\${rows}`);
patch(`    if (el.dataset.wardimg !== undefined || el.dataset.outimg !== undefined) {`,`    if (el.dataset.castact) { const k = el.dataset.castact, v = el.value.trim(); setStudioCast(studioCast().map(e => e.key === k ? { ...e, act: v } : e)); updateStudioPreview?.(); return; }
    if (el.dataset.wardimg !== undefined || el.dataset.outimg !== undefined) {`);
patch(`.pc-i2i{display:flex;gap:10px;align-items:flex-start}`,`.pc-i2i{display:flex;gap:10px;align-items:flex-start}
.pc-castact{width:100%;box-sizing:border-box;margin-top:6px;padding:7px 12px;border-radius:12px;border:1.5px dashed var(--pc-dash);background:transparent;color:var(--pc-ink);font-size:12px}`);
s=applyImg2imgCompatibility(s);
s=applyCharLibrary(s);
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
fs.writeFileSync(dir+'/runtime.js',(prefix+s+'\n}\n').replace(/\r\n/g, '\n'));
fs.copyFileSync('src/index.js',dir+'/index.js');
fs.writeFileSync(dir+'/manifest.json',JSON.stringify({display_name:'智库',loading_order:100,js:'index.js',author:'if love',version:'0.8.36',homePage:'https://github.com/ruoege49-ship-it/zhiku-tavern-helper',auto_update:true,minimum_client_version:'1.14.0',dependencies:[],hooks:{enable:'onEnable',disable:'onDisable',delete:'onDelete'}},null,2)+'\n');
fs.writeFileSync(dir+'/package.json',JSON.stringify({name:'zhiku-tavern-helper',version:'0.8.36',private:true,type:'module'},null,2)+'\n');
fs.writeFileSync(dir+'/capability-contract.json',JSON.stringify({schemaVersion:1,minimum:{sillytavern:'1.14.0',tavernHelper:null},requirements:[{id:'host-context',owner:'sillytavern',symbol:'SillyTavern.getContext',required:true,fallback:null}]},null,2));
assert(!s.includes('getButtonEvent('));
for(const key of ['piaoce_data.json','piaoce_nai','piaoce_uid','data-share-form'])assert(s.includes(key));
console.log('Extension 0.8.36 built; storage keys and shared upload preserved.');
