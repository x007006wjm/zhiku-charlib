import assert from 'node:assert/strict';
import {
    canonLookTags,
    charTestFraming,
    filterCharTestTags,
    buildChatCastExcerpt,
    isContentBlockError,
    mergeExtractedPeople,
} from '../src/char-enhance.js';

// 1) 同人角色外貌合成
assert.equal(
    canonLookTags({ canonOn: false, canonTag: 'hatsune miku, vocaloid' }, '1girl, twin tails, aqua hair'),
    '1girl, twin tails, aqua hair'
);
assert.equal(
    canonLookTags({ canonOn: true, canonTag: 'hatsune miku, vocaloid', canonKeepLook: false }, '1girl, twin tails, aqua hair'),
    '1girl, hatsune miku, vocaloid'
);
assert.equal(
    canonLookTags({ canonOn: true, canonTag: 'hatsune miku, vocaloid', canonKeepLook: true }, '1girl, twin tails, aqua hair'),
    '1girl, hatsune miku, vocaloid, twin tails, aqua hair'
);

// 2) 角色生图景别过滤
assert.equal(charTestFraming('portrait').width, 832);
assert.equal(charTestFraming('portrait').height, 832);
const filteredPortrait = filterCharTestTags('artist:foo, 1girl, long hair, full body, black thighhighs, standing, red eyes', 'portrait');
assert.ok(filteredPortrait.includes('artist:foo'));
assert.ok(filteredPortrait.includes('long hair'));
assert.ok(!filteredPortrait.includes('full body'));
assert.ok(!filteredPortrait.includes('black thighhighs'));

// 3) 聊天 40 楼正文提取（跳过系统消息、思考块与生图标记）
const excerpt = buildChatCastExcerpt([
    { is_system: true, mes: 'system' },
    { name: 'Alice', mes: '<think>secret</think>你好 image###1girl### <b>世界</b>' },
]);
assert.ok(excerpt.includes('Alice'));
assert.ok(excerpt.includes('你好'));
assert.ok(!excerpt.includes('secret'));
assert.ok(!excerpt.includes('image###'));

// 4) 内容拦截识别与人物合并
assert.equal(isContentBlockError(new Error('PROHIBITED_CONTENT')), true);
assert.equal(isContentBlockError(new Error('HTTP 502 Bad Gateway')), false);

const merged = mergeExtractedPeople([
    { name: '白雪', aliases: ['雪儿'], appearance: [{ en: '1girl', zh: '女孩' }], outfit: [{ en: 'dress', zh: '裙子' }] },
    { name: '雪儿', aliases: ['白雪'], appearance: [{ en: '1girl', zh: '女孩' }, { en: 'silver hair', zh: '银发' }], canon: 'shirayuki' },
]);
assert.equal(merged.length, 1);
assert.equal(merged[0].appearance.length, 2);
assert.equal(merged[0].canon, 'shirayuki');

console.log('char-enhance tests passed');
