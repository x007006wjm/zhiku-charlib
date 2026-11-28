// 独立 IndexedDB 历史生图记录（默认最多 2000 条，完全不占画师库主存档）

export function createHistoryStore({ idb = globalThis.indexedDB, maxItems = 2000 } = {}) {
    const DB_NAME = 'zhiku_history';
    const STORE = 'entries';
    let dbp = null;
    let list = [];
    let loaded = false;
    let loading = null;
    let idbOk = !!idb;
    let queue = Promise.resolve();

    const open = () => (dbp ||= new Promise((resolve, reject) => {
        if (!idb) { reject(new Error('IndexedDB unavailable')); return; }
        const req = idb.open(DB_NAME, 1);
        req.onupgradeneeded = () => {
            if (!req.result.objectStoreNames.contains(STORE)) {
                req.result.createObjectStore(STORE, { keyPath: 'id' });
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    }).catch(e => { dbp = null; throw e; }));

    const tx = async (mode, fn) => {
        const db = await open();
        return new Promise((resolve, reject) => {
            const t = db.transaction(STORE, mode);
            let req;
            t.oncomplete = () => resolve(req?.result);
            t.onerror = t.onabort = () => reject(t.error || new Error('History tx aborted'));
            try { req = fn(t.objectStore(STORE)); } catch (e) { t.abort(); reject(e); }
        });
    };

    const serial = fn => {
        const next = queue.then(fn);
        queue = next.catch(() => {});
        return next;
    };

    const dedupeSort = rows => {
        const seen = new Set();
        return rows
            .filter(x => x && x.id && x.image)
            .sort((a, b) => (b.at || 0) - (a.at || 0))
            .filter(x => { if (seen.has(x.id)) return false; seen.add(x.id); return true; });
    };

    function load() {
        return (loading ||= (async () => {
            if (!idbOk) { loaded = true; return list; }
            try {
                const stored = (await tx('readonly', st => st.getAll())) || [];
                list = dedupeSort(stored);
            } catch (e) {
                idbOk = false;
                console.warn('[智库] 历史生图 IndexedDB 打开失败，退回内存记录', e);
            }
            loaded = true;
            return list;
        })());
    }

    function add(entry) {
        return serial(async () => {
            await load();
            if (!entry || !entry.image) return;
            const item = {
                id: entry.id || ('h_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7)),
                at: Number(entry.at) || Date.now(),
                image: String(entry.image),
                prompt: String(entry.prompt || ''),
                negative: String(entry.negative || ''),
                size: String(entry.size || ''),
                seed: entry.seed ?? '',
                source: String(entry.source || 'studio'),
            };
            const merged = dedupeSort([item, ...list]);
            const kept = merged.slice(0, maxItems);
            const dropped = merged.slice(maxItems).map(x => x.id);
            if (idbOk) {
                try {
                    await tx('readwrite', st => {
                        st.put(item);
                        for (const id of dropped) st.delete(id);
                    });
                } catch (e) {
                    idbOk = false;
                    console.warn('[智库] 历史生图写入失败', e);
                }
            }
            list = kept;
        });
    }

    function remove(id) {
        return serial(async () => {
            await load();
            list = list.filter(x => x.id !== id);
            if (idbOk) {
                try { await tx('readwrite', st => st.delete(id)); } catch {}
            }
        });
    }

    function clear() {
        return serial(async () => {
            await load();
            list = [];
            if (idbOk) {
                try { await tx('readwrite', st => st.clear()); } catch {}
            }
        });
    }

    return {
        load,
        loaded: () => loaded,
        all: () => list,
        count: () => list.length,
        add,
        remove,
        clear,
    };
}
