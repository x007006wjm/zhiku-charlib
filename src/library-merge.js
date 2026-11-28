// 画师库多端合并与墓碑/复活时间管理（防删过又加回来的死循环）

export const LIBRARY_MAPS = [
    'artists', 'groups', 'collections', 'characters', 'outfits',
    'vibeGroups', 'charRefGroups', 'blacklist', 'bindings', 'chatCast',
];

export function recordLibraryDeletes(data, before, now = Date.now()) {
    if (!data || typeof data !== 'object') return;
    data.options ||= {};
    const ts = Number(data.options.savedAt) || now;
    const deleted = (data.options.libraryDeleted ||= {});
    const revived = (data.options.libraryRevived ||= {});
    for (const key of LIBRARY_MAPS) {
        const cur = data[key] || {};
        const prev = before?.[key] || {};
        for (const id of Object.keys(prev)) {
            if (!Object.hasOwn(cur, id)) {
                (deleted[key] ||= {})[id] = ts;
            }
        }
        for (const id of Object.keys(cur)) {
            if (deleted[key]?.[id]) {
                delete deleted[key][id];
                (revived[key] ||= {})[id] = ts;
            }
        }
    }
}

export function mergeLibraryAdditions(data, other) {
    if (!data || !other || typeof other !== 'object') return 0;
    data.options ||= {};
    const deleted = (data.options.libraryDeleted ||= {});
    const revived = (data.options.libraryRevived ||= {});
    let added = 0;

    for (const key of LIBRARY_MAPS) {
        const target = (data[key] ||= {});
        const revMap = (revived[key] ||= {});
        const delMap = (deleted[key] ||= {});

        // 1) 合并两边复活时间（取较大值）
        for (const [id, at] of Object.entries(other.options?.libraryRevived?.[key] || {})) {
            const t = Number(at);
            if (Number.isFinite(t) && t > 0) revMap[id] = Math.max(Number(revMap[id]) || 0, t);
        }
        // 2) 合并两边删除墓碑（取较大值），但若复活时间 >= 删除时间则墓碑作废
        for (const [id, at] of Object.entries(other.options?.libraryDeleted?.[key] || {})) {
            const t = Number(at);
            if (Number.isFinite(t) && t > 0) delMap[id] = Math.max(Number(delMap[id]) || 0, t);
        }
        for (const id of Object.keys(delMap)) {
            if ((Number(revMap[id]) || 0) >= (Number(delMap[id]) || 0)) {
                delete delMap[id];
            }
        }
        // 3) 清理有效墓碑对应条目
        for (const id of Object.keys(delMap)) {
            delete target[id];
        }
        // 4) 合入对方新增且未被有效墓碑删除的条目
        for (const [id, item] of Object.entries(other[key] || {})) {
            if (['__proto__', 'prototype', 'constructor'].includes(id)) continue;
            if (delMap[id] || Object.hasOwn(target, id)) continue;
            target[id] = structuredClone(item);
            added++;
        }
    }

    // 合入的新画师组不能引用已被显式删除的画师
    for (const group of Object.values(data.groups || {})) {
        if (Array.isArray(group.members)) {
            group.members = group.members.filter(m => data.artists[m.artistId]);
        }
    }
    return added;
}

export function libraryEntryCount(d) {
    if (!d || typeof d !== 'object') return 0;
    return LIBRARY_MAPS.reduce((sum, k) => sum + Object.keys(d[k] || {}).length, 0);
}
