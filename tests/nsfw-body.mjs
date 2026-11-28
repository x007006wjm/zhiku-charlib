import assert from 'node:assert/strict';
import { isNsfwPrompt, isNudePrompt, buildMarkerPlan } from '../src/char-marker-json.js';

assert.equal(isNsfwPrompt('1girl, sfw, classroom'), false);
assert.equal(isNsfwPrompt('1girl, nsfw, bedroom'), true);
assert.equal(isNsfwPrompt('rating:explicit, 1girl'), true);
assert.equal(isNudePrompt('1girl, school uniform'), false);
assert.equal(isNudePrompt('1girl, completely nude, steam'), true);
assert.equal(isNudePrompt('1girl, topless, bed'), true);

const lookup = () => ({
    appearanceTags: 'long silver hair, red eyes',
    outfitTags: 'black blazer, pleated skirt, white shirt',
    nsfwBody: 'medium breasts, pink nipples',
    nl: '',
    uc: '',
    charRef: '',
});

// SFW：带固定衣服，不带 NSFW 身体
const sfwPlan = buildMarkerPlan({
    tag: '1girl, classroom, sfw',
    characters: [{ name: '白雪', tag: '1girl, smiling' }],
}, { lookup });
assert.ok(sfwPlan.characters[0].tag.includes('black blazer'));
assert.ok(!sfwPlan.characters[0].tag.includes('pink nipples'));

// NSFW 但穿衣服：带 NSFW 身体 + 带固定衣服
const nsfwClothed = buildMarkerPlan({
    tag: '1girl, nsfw, bedroom',
    characters: [{ name: '白雪', tag: '1girl, blush' }],
}, { lookup });
assert.ok(nsfwClothed.characters[0].tag.includes('black blazer'));
assert.ok(nsfwClothed.characters[0].tag.includes('pink nipples'));

// NSFW 裸体：带 NSFW 身体，自动跳过固定衣服
const nsfwNude = buildMarkerPlan({
    tag: '1girl, nsfw, onsen',
    characters: [{ name: '白雪', tag: '1girl, nude, wet' }],
}, { lookup });
assert.ok(!nsfwNude.characters[0].tag.includes('black blazer'));
assert.ok(nsfwNude.characters[0].tag.includes('pink nipples'));
assert.ok(nsfwNude.characters[0].tag.includes('long silver hair'));

console.log('nsfw-body tests passed');
