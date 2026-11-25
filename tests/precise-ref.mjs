import assert from 'node:assert/strict';
import {
    isPreciseRefModel, directorBaseCaption, clampDirectorStrength, buildDirectorParams, pickDirectorBucket,
} from '../src/precise-ref.js';

// 1. 模型支持判定：4.5 与 5 全系支持，V3 / V4 不支持
assert.equal(isPreciseRefModel('nai-diffusion-4-5-full'), true);
assert.equal(isPreciseRefModel('nai-diffusion-4-5-curated'), true);
assert.equal(isPreciseRefModel('nai-diffusion-5-full'), true);
assert.equal(isPreciseRefModel('nai-diffusion-5-full-medium'), true);
assert.equal(isPreciseRefModel('nai-diffusion-5-curated'), true);
assert.equal(isPreciseRefModel('nai-diffusion-4-full'), false);
assert.equal(isPreciseRefModel('nai-diffusion-3'), false);

// 2. base_caption 映射：V5 严格使用官方 4 种（character / style / outfit / character&style），旧组合值安全映射
assert.equal(directorBaseCaption('character', true), 'character');
assert.equal(directorBaseCaption('both', true), 'character&style');
assert.equal(directorBaseCaption('style', true), 'style');
assert.equal(directorBaseCaption('outfit', true), 'outfit');
assert.equal(directorBaseCaption('character_outfit', true), 'character');
assert.equal(directorBaseCaption('both_outfit', true), 'character&style');
assert.equal(directorBaseCaption('outfit', false), 'character');
assert.equal(directorBaseCaption('character_outfit', false), 'character');
assert.equal(directorBaseCaption('both_outfit', false), 'character&style');

// 3. 强度范围：V5 支持 0~5.0，V4.5 限制 0~1.0
assert.equal(clampDirectorStrength(2.5, true), 2.5);
assert.equal(clampDirectorStrength(6.2, true), 5);
assert.equal(clampDirectorStrength(2.5, false), 1);
assert.equal(clampDirectorStrength(-0.5, true), 0);

// 4. V5 参数：secondary_strength 全为 0，支持多参考混搭（长相 + 服装）
const v5Params = buildDirectorParams([
    { key: 'k1', data: 'img1', type: 'character', strength: 1.2 },
    { key: 'k2', data: 'img2', type: 'outfit', strength: 2.0 },
], true);
assert.deepEqual(v5Params.director_reference_descriptions.map(d => d.caption.base_caption), ['character', 'outfit']);
assert.deepEqual(v5Params.director_reference_strength_values, [1.2, 2]);
assert.deepEqual(v5Params.director_reference_secondary_strength_values, [0, 0]);

// 5. V4.5 参数：保持 1 - strength
const v45Params = buildDirectorParams([
    { key: 'k1', data: 'img1', type: 'both', strength: 0.6 },
], false);
assert.deepEqual(v45Params.director_reference_descriptions.map(d => d.caption.base_caption), ['character&style']);
assert.deepEqual(v45Params.director_reference_strength_values, [0.6]);
assert.deepEqual(v45Params.director_reference_secondary_strength_values, [0.4]);

// 6. 分桶尺寸选择：V5 约 1MP 分桶（832×1216 / 1024×1024 / 1216×832），V4.5 保持原分桶
assert.deepEqual(pickDirectorBucket(1024, 1536, true), [832, 1216]);
assert.deepEqual(pickDirectorBucket(1472, 1472, true), [1024, 1024]);
assert.deepEqual(pickDirectorBucket(1536, 1024, true), [1216, 832]);
assert.deepEqual(pickDirectorBucket(832, 1216, false), [1024, 1536]);
assert.deepEqual(pickDirectorBucket(1024, 1024, false), [1472, 1472]);
assert.deepEqual(pickDirectorBucket(1216, 832, false), [1536, 1024]);

console.log('PASS: NovelAI V5 & V4.5 Precise Reference (model check, outfit/same-outfit captions, 0..5 strength, V5 fidelity=0, V5 1MP buckets).');
