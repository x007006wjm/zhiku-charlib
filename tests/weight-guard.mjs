import assert from 'node:assert/strict';
import { guardWeightSpacing, formatWeightTag } from '../src/weight-guard.js';

// 1. 末尾为数字的画师 / 年份标签：自动补齐保护空格
assert.equal(guardWeightSpacing('0.5::artist:bm94199::'), '0.5::artist:bm94199 ::');
assert.equal(guardWeightSpacing('1.2::year 2024::'), '1.2::year 2024 ::');
assert.equal(guardWeightSpacing('1.2::artist:abc, artist:bm94199::'), '1.2::artist:abc, artist:bm94199 ::');
assert.equal(guardWeightSpacing('0.5::123::'), '0.5::123 ::');

// 2. 已经有保护空格的：保持原样，不重复加空格
assert.equal(guardWeightSpacing('0.5::artist:bm94199 ::'), '0.5::artist:bm94199 ::');

// 3. 末尾为字母的普通权重块：不乱加空格，且不跨块误匹配
assert.equal(guardWeightSpacing('0.8::artist:foo::, 0.5::artist:bm94199::, -0.8::feet::'), '0.8::artist:foo::, 0.5::artist:bm94199 ::, -0.8::feet::');
assert.equal(guardWeightSpacing('0::ai-generated::'), '0::ai-generated::');
assert.equal(guardWeightSpacing('1girl, solo, sunset'), '1girl, solo, sunset');

// 4. formatWeightTag
assert.equal(formatWeightTag('0.5', 'artist:bm94199'), '0.5::artist:bm94199 ::');
assert.equal(formatWeightTag('1.2', 'artist:abc'), '1.2::artist:abc::');
assert.equal(formatWeightTag('0.8', 'artist:foo123'), '0.8::artist:foo123 ::');

console.log('PASS: NovelAI numeric weight trailing-space guard.');
