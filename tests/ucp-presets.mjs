import assert from 'node:assert/strict';
import {
    UCP_PRESET_PREFIX, normalizeUcpPresets, ucpPresetIdOf, findUcpPreset,
    resolveUcpText, createUcpPreset, updateUcpPresetText, renameUcpPreset, deleteUcpPreset,
} from '../src/ucp-presets.js';

// 1. 创建与查找
const c1 = createUcpPreset([], { name: 'V5 清透', text: 'lowres, bad hands', id: 'p1' });
assert.equal(c1.value, `${UCP_PRESET_PREFIX}p1`);
assert.equal(ucpPresetIdOf(c1.value), 'p1');
assert.equal(ucpPresetIdOf('custom'), '');
assert.equal(findUcpPreset(c1.presets, c1.value)?.name, 'V5 清透');

const c2 = createUcpPreset(c1.presets, { name: '', text: 'watermark, text', id: 'p2' });
assert.equal(c2.preset.name, '预设 2');
assert.equal(c2.presets.length, 2);

// 2. resolveUcpText：custom / preset / 内置回落
assert.equal(resolveUcpText({ UCP_novelai: 'custom', UCP_custom: ' custom neg ', UCP_presets: c2.presets }, 'fallback'), 'custom neg');
assert.equal(resolveUcpText({ UCP_novelai: 'preset:p1', UCP_custom: 'ignored', UCP_presets: c2.presets }, 'fallback'), 'lowres, bad hands');
assert.equal(resolveUcpText({ UCP_novelai: 'Heavy', UCP_presets: c2.presets }, 'heavy builtin'), 'heavy builtin');
assert.equal(resolveUcpText({ UCP_novelai: 'preset:missing', UCP_presets: c2.presets }, 'fallback'), 'fallback');

// 3. 更新文本、改名、删除
const updated = updateUcpPresetText(c2.presets, 'p1', 'lowres, bad hands, blurry');
assert.equal(findUcpPreset(updated, 'preset:p1')?.text, 'lowres, bad hands, blurry');

const renamed = renameUcpPreset(updated, 'p1', 'V5 日常');
assert.equal(findUcpPreset(renamed, 'preset:p1')?.name, 'V5 日常');
assert.equal(findUcpPreset(renameUcpPreset(renamed, 'p1', '   '), 'preset:p1')?.name, 'V5 日常');

const deleted = deleteUcpPreset(renamed, 'p1');
assert.equal(deleted.length, 1);
assert.equal(findUcpPreset(deleted, 'preset:p1'), null);

// 4. 脏数据规范化
assert.equal(normalizeUcpPresets(null).length, 0);
assert.equal(normalizeUcpPresets([{ id: 'a', name: 'A', text: 'x' }, { id: 'a', name: 'dup' }, { id: '', name: 'bad' }]).length, 1);

console.log('PASS: UCP custom negative presets (create, resolve, update, rename, delete, normalize).');
