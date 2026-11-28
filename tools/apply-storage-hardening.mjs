import assert from 'node:assert/strict';

/**
 * v1.0.1 第 8 项：存储加固
 * 1) 画师库四重备份（酒馆数据文件 / 浏览器 IndexedDB / 酒馆扩展设置 / localStorage）+ 多端安全合并防墓碑死循环
 * 2) 设置 → 数据增加「检查画师库存档」诊断功能
 * 3) 独立 IndexedDB 历史生图记录（默认 2000 条，不占主存档），生图页可折叠浏览/复用/删除
 */
export function applyStorageHardening(s) {
    const patch = (a, b) => {
        assert.equal(s.split(a).length, 2, 'applyStorageHardening anchor mismatch: ' + a.slice(0, 90));
        s = s.replace(a, () => b);
    };

    // ── 1. __mod_store 四重备份 + 多端合并 + 诊断
    patch(
`async function loadData() {
    try {
        const res = await fetch(\`/user/files/\${DATA_FILE}?t=\${Date.now()}\`, { cache: 'no-store' });
        if (res.status === 404) {
            const backup = localStorage.getItem(LOCAL_BACKUP);
            data = normalizeData(backup ? JSON.parse(backup) : null);
            loadedFromServer = true;
        } else if (res.ok) {
            data = normalizeData(await res.json());
            loadedFromServer = true;
        } else {
            throw new Error(\`HTTP \${res.status}\`);
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
    if (!res.ok) throw new Error(\`保存失败 HTTP \${res.status}\`);
}`,
`const IDB_BACKUP_DB = 'zhiku_library_backup';
const IDB_BACKUP_STORE = 'kv';
const IDB_BACKUP_KEY = 'piaoce_data';
const MAX_INLINE_BACKUP_BYTES = 1500000;
let lastSavedSnapshot = null;
const storageDiag = { activeSource: 'none', fileOk: false, idbOk: false, extOk: false, lsOk: false, bytes: 0, times: {} };

function idbOpenBackup() {
    const idb = P.indexedDB || globalThis.indexedDB;
    if (!idb) return Promise.reject(new Error('IndexedDB unavailable'));
    return new Promise((resolve, reject) => {
        const req = idb.open(IDB_BACKUP_DB, 1);
        req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains(IDB_BACKUP_STORE)) req.result.createObjectStore(IDB_BACKUP_STORE); };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}
async function idbReadBackup() {
    try {
        const db = await idbOpenBackup();
        const val = await new Promise((resolve, reject) => {
            const t = db.transaction(IDB_BACKUP_STORE, 'readonly');
            const req = t.objectStore(IDB_BACKUP_STORE).get(IDB_BACKUP_KEY);
            req.onsuccess = () => resolve(req.result || null);
            req.onerror = () => reject(req.error);
        });
        storageDiag.idbOk = true;
        return typeof val === 'string' ? JSON.parse(val) : (val && typeof val === 'object' ? val : null);
    } catch {
        storageDiag.idbOk = false;
        return null;
    }
}
async function idbWriteBackup(json) {
    try {
        const db = await idbOpenBackup();
        await new Promise((resolve, reject) => {
            const t = db.transaction(IDB_BACKUP_STORE, 'readwrite');
            t.objectStore(IDB_BACKUP_STORE).put(json, IDB_BACKUP_KEY);
            t.oncomplete = () => resolve();
            t.onerror = t.onabort = () => reject(t.error);
        });
        storageDiag.idbOk = true;
    } catch {
        storageDiag.idbOk = false;
    }
}
function readExtBackup() {
    try {
        const raw = P.SillyTavern?.getContext?.()?.extensionSettings?.zhiku_lib_backup;
        storageDiag.extOk = true;
        return typeof raw === 'string' ? JSON.parse(raw) : (raw && typeof raw === 'object' ? raw : null);
    } catch { return null; }
}
function writeExtBackup(json) {
    try {
        if (json.length > MAX_INLINE_BACKUP_BYTES) return;
        const c = P.SillyTavern?.getContext?.();
        if (!c?.extensionSettings) return;
        c.extensionSettings.zhiku_lib_backup = json;
        c.saveSettingsDebounced?.();
        storageDiag.extOk = true;
    } catch {}
}
function readLsBackup() {
    try {
        const raw = localStorage.getItem(LOCAL_BACKUP);
        storageDiag.lsOk = true;
        return raw ? JSON.parse(raw) : null;
    } catch { return null; }
}
async function readServerFile() {
    const res = await fetch(\`/user/files/\${DATA_FILE}?t=\${Date.now()}\`, { cache: 'no-store' });
    if (res.status === 404) return { ok: true, missing: true, data: null };
    if (!res.ok) throw new Error(\`HTTP \${res.status}\`);
    return { ok: true, missing: false, data: normalizeData(await res.json()) };
}

async function loadData() {
    let server = null, serverOk = false;
    try {
        const r = await readServerFile();
        serverOk = r.ok;
        server = r.data;
    } catch (e) {
        console.warn('[票册] 从酒馆读取数据失败，尝试使用本地多份备份', e);
    }
    const idbRaw = await idbReadBackup();
    const extRaw = readExtBackup();
    const lsRaw = readLsBackup();
    const cands = [
        ['file', server],
        ['idb', idbRaw ? normalizeData(idbRaw) : null],
        ['ext', extRaw ? normalizeData(extRaw) : null],
        ['ls', lsRaw ? normalizeData(lsRaw) : null],
    ].filter(([, d]) => d);
    storageDiag.fileOk = serverOk;
    storageDiag.times = Object.fromEntries(cands.map(([k, d]) => [k, Number(d.options?.savedAt) || 0]));
    cands.sort((a, b) => ((Number(b[1].options?.savedAt) || 0) - (Number(a[1].options?.savedAt) || 0)) || (libraryEntryCount(b[1]) - libraryEntryCount(a[1])));
    const best = cands[0] || null;
    data = best ? best[1] : normalizeData(null);
    storageDiag.activeSource = best ? best[0] : 'empty';
    // 合并其他来源的新增条目，防多端覆盖
    for (const [k, other] of cands.slice(1)) {
        try { mergeLibraryAdditions(data, other); } catch {}
    }
    if (server && best?.[0] !== 'file') {
        try { mergeLibraryAdditions(data, server); } catch {}
    }
    loadedFromServer = serverOk;
    lastSavedSnapshot = structuredClone(data);
    storageDiag.bytes = JSON.stringify(data).length;
    if (!serverOk && best) {
        toastr.warning('画师库数据文件暂时没读到，已从本地备份恢复；连上酒馆后会自动同步回去。', '智库');
    } else if (serverOk && best && best[0] !== 'file') {
        // 本地备份比服务器文件新：马上补写回服务器
        commit({ immediate: true, silent: true });
    }
    emit();
    return data;
}

async function writeNow() {
    data.options ||= {};
    data.options.savedAt = Date.now();
    if (lastSavedSnapshot) recordLibraryDeletes(data, lastSavedSnapshot, data.options.savedAt);
    let target = data;
    if (loadedFromServer) {
        try {
            const remote = await readServerFile();
            if (remote.data) {
                const merged = mergeLibraryAdditions(data, remote.data);
                if (merged > 0) emit();
            }
        } catch { /* 读取远端失败不阻断本次保存 */ }
    }
    const json = JSON.stringify(target);
    storageDiag.bytes = json.length;
    await idbWriteBackup(json);
    writeExtBackup(json);
    if (json.length <= MAX_INLINE_BACKUP_BYTES) {
        try { localStorage.setItem(LOCAL_BACKUP, json); storageDiag.lsOk = true; } catch { storageDiag.lsOk = false; }
    }
    lastSavedSnapshot = structuredClone(target);
    if (!loadedFromServer) return; // 没读到服务器的数据时不覆盖，免得把服务器上的旧数据清掉
    const res = await fetch('/api/files/upload', {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ name: DATA_FILE, data: utf8ToBase64(json) }),
    });
    if (!res.ok) throw new Error(\`保存失败 HTTP \${res.status}\`);
    storageDiag.fileOk = true;
    storageDiag.times.file = data.options.savedAt;
}

function diagnoseStorage() {
    const fmt = t => t ? new Date(t).toLocaleString() : '无';
    const kb = Math.round((storageDiag.bytes || 0) / 1024);
    const names = { file: '酒馆数据文件', idb: '浏览器 IndexedDB', ext: '酒馆扩展设置', ls: '浏览器 localStorage', empty: '全新空白' };
    return [
        \`当前使用：\${names[storageDiag.activeSource] || storageDiag.activeSource}\`,
        \`存档大小：约 \${kb} KB（画师 \${Object.keys(data.artists || {}).length} · 画师组 \${Object.keys(data.groups || {}).length} · 角色 \${Object.keys(data.characters || {}).length}）\`,
        \`1. 酒馆文件（user/files/\${DATA_FILE}）：\${storageDiag.fileOk ? '可读写' : '不可用'} · \${fmt(storageDiag.times.file)}\`,
        \`2. 浏览器 IndexedDB：\${storageDiag.idbOk ? '正常' : '不可用'} · \${fmt(storageDiag.times.idb)}\`,
        \`3. 酒馆扩展设置备份：\${storageDiag.extOk ? '正常' : '未启用/超大跳过'} · \${fmt(storageDiag.times.ext)}\`,
        \`4. 浏览器 localStorage：\${storageDiag.lsOk ? '正常' : '未启用/超大跳过'} · \${fmt(storageDiag.times.ls)}\`,
        storageDiag.fileOk ? '结论：四重备份正常，数据安全。' : '结论：酒馆数据文件当前读不到，改动暂存在浏览器备份中。',
    ].join('\\n');
}`
    );
    patch(
        `return { getData, onChange, loadData, commit, replaceData, uploadImage, deleteImageFile, imgUrl, fileToDataUrl, urlToDataUrl, shrinkDataUrl, flush: () => saveTimer !== null ? commit({ immediate: true, silent: true }) : saving };`,
        `return { getData, onChange, loadData, commit, replaceData, uploadImage, deleteImageFile, imgUrl, fileToDataUrl, urlToDataUrl, shrinkDataUrl, diagnoseStorage, flush: () => saveTimer !== null ? commit({ immediate: true, silent: true }) : saving };`
    );
    // 页面切后台或关闭前立即刷盘
    patch(
        `    DOC.addEventListener('click', onChatClick, true);`,
        `    const onVisHide = () => { if (DOC.visibilityState === 'hidden') void __mod_store.flush(); };
    const onPageHide = () => { void __mod_store.flush(); };
    DOC.addEventListener('visibilitychange', onVisHide);
    P.addEventListener?.('pagehide', onPageHide);
    cleanups.push(() => { DOC.removeEventListener('visibilitychange', onVisHide); P.removeEventListener?.('pagehide', onPageHide); });
    DOC.addEventListener('click', onChatClick, true);`
    );

    // ── 2. 设置 → 数据：加入「检查画师库存档」按钮
    patch(
        `<button class="pc-btn" data-act="exportdata">导出</button>`,
        `<button class="pc-btn" data-act="diagstorage">检查画师库存档</button><button class="pc-btn" data-act="exportdata">导出</button>`
    );
    patch(
        `case 'exportdata': exportData(); break;`,
        `case 'diagstorage': await confirmBox(__mod_store.diagnoseStorage(), { ok: '知道了', cancel: '关闭' }); break;\n            case 'exportdata': exportData(); break;`
    );

    // ── 3. 独立 IndexedDB 历史生图记录（默认 2000 条，不占主存档）
    patch(
        `function render() {`,
        `const pcHist = createHistoryStore({ idb: P.indexedDB || globalThis.indexedDB, maxItems: 2000 });
void pcHist.load().then(() => { if (ui.view === 'studio' && root?.isConnected) render(); });
function render() {`
    );
    patch(
        `        st.result = await E.generate(studioParts());
        st.sent = E.runtime.lastSent;`,
        `        st.result = await E.generate(studioParts());
        st.sent = E.runtime.lastSent;
        if (st.result) void pcHist.add({ image: st.result, prompt: st.sent?.prompt || st.pos, negative: st.sent?.negative || st.neg, size: st.sent?.size || '', seed: st.sent?.seed ?? '', source: 'studio' });`
    );
    patch(
        `    \${fold('extra', '自动加的词',`,
        `    \${fold('history', '历史生图（独立本地存储）', pcHist.count() ? \`已存 \${pcHist.count()} 条 · 不占主存档\` : '还没有记录', \`
      <div class="pc-hint" style="margin-top:0">历史生图独立存在浏览器 IndexedDB 中（最多 2000 条），不会撑大画师库主存档。</div>
      \${pcHist.count() ? \`<div class="pc-actions wrap pc-mt-s"><button class="pc-pill dashed tiny danger" data-act="histclear">清空历史</button></div>
      <div class="pc-grid2 pc-mt-s">\${pcHist.all().slice(0, 30).map(h => \`<article class="pc-ticket" style="padding-bottom:8px">
        <div class="pc-ticket-img"><img src="\${esc(h.image)}" loading="lazy" alt="" data-act="viewimg" data-src="\${esc(h.image)}"></div>
        <div class="pc-ticket-text"><small>\${esc(h.size || '')}\${h.seed ? ' · ' + esc(String(h.seed)) : ''}</small></div>
        <div class="pc-actions wrap" style="padding:0 8px"><button class="pc-pill dashed tiny" data-act="histuse" data-id="\${esc(h.id)}">复用提示词</button><button class="pc-pill dashed tiny danger" data-act="histdel" data-id="\${esc(h.id)}">删</button></div>
      </article>\`).join('')}</div>\` : '<div class="pc-dim small pc-mt-s">在生图页生成图片后会自动记录在这里。</div>'}
    \`)}
    \${fold('extra', '自动加的词',`
    );
    patch(
        `case 'clearresult': ui.studio.result = null; ui.studio.sent = null; render(); break;`,
        `case 'clearresult': ui.studio.result = null; ui.studio.sent = null; render(); break;
            case 'histuse': {
                const h = pcHist.all().find(x => x.id === el.dataset.id);
                if (!h) break;
                if (h.prompt) ui.studio.pos = h.prompt;
                if (h.negative) ui.studio.neg = h.negative;
                saveStudio(); render();
                toastr.success('已填入生图页提示词', '历史生图', { timeOut: 1800 });
                break;
            }
            case 'histdel': {
                await pcHist.remove(el.dataset.id);
                render();
                break;
            }
            case 'histclear': {
                if (!(await confirmBox(\`清空全部 \${pcHist.count()} 条本地历史生图记录？\`, { ok: '清空', cancel: '算了' }))) break;
                await pcHist.clear();
                render();
                toastr.info('已清空历史生图', '智库', { timeOut: 1800 });
                break;
            }`
    );

    return s;
}
