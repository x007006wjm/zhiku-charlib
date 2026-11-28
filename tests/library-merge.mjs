import assert from 'node:assert/strict';
import { recordLibraryDeletes, mergeLibraryAdditions, libraryEntryCount } from '../src/library-merge.js';

// 1) 多端合并：保留对方新增，尊重显式删除墓碑
const local = {
    artists: { a1: { id: 'a1', tag: 'artist:one' } },
    groups: {},
    collections: {},
    characters: {},
    outfits: {},
    vibeGroups: {},
    charRefGroups: {},
    blacklist: {},
    bindings: {},
    chatCast: {},
    options: { savedAt: 1000 },
};
const before = structuredClone(local);
delete local.artists.a1;
local.options.savedAt = 2000;
recordLibraryDeletes(local, before);
assert.equal(local.options.libraryDeleted.artists.a1, 2000);

const remote = {
    artists: { a1: { id: 'a1', tag: 'artist:one' }, a2: { id: 'a2', tag: 'artist:two' } },
    groups: { g1: { id: 'g1', members: [{ artistId: 'a1' }, { artistId: 'a2' }] } },
    options: { savedAt: 1500 },
};
const added = mergeLibraryAdditions(local, remote);
assert.equal(added, 2); // a2 + g1
assert.equal(local.artists.a1, undefined, '已删画师不应被旧远端复活');
assert.ok(local.artists.a2, '远端新增画师应合并进来');
assert.deepEqual(local.groups.g1.members, [{ artistId: 'a2' }], '新合入画师组应过滤掉已删画师');

// 2) 复活防死循环（原 0.9.19）：删过一次后又加回来，合并旧磁盘墓碑时不应再被删掉
const beforeRevive = structuredClone(local);
local.artists.a1 = { id: 'a1', tag: 'artist:one' };
local.options.savedAt = 3000;
recordLibraryDeletes(local, beforeRevive);
assert.equal(local.options.libraryDeleted.artists.a1, undefined);
assert.equal(local.options.libraryRevived.artists.a1, 3000);

const staleDisk = {
    artists: {},
    options: { savedAt: 2000, libraryDeleted: { artists: { a1: 2000 } } },
};
mergeLibraryAdditions(local, staleDisk);
assert.ok(local.artists.a1, '复活时间晚于旧墓碑时，重新加回的条目必须保留');
assert.equal(libraryEntryCount(local) >= 3, true);

console.log('library-merge tests passed');
