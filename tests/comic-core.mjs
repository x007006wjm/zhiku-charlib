import assert from 'node:assert/strict';
import {
    buildComicNegative,
    comicLineKind,
    panelBoxesFor,
    normalizeComicPages,
    buildComicPagePrompt,
    renderComicBubblesHtml,
} from '../src/comic-core.js';

// 1) 负面词清理：黑白模式去除 monochrome/greyscale，插件叠字加上 text/speech bubble
const bwNeg = buildComicNegative('lowres, monochrome, greyscale, comic, bad hands', { monochrome: true, overlayText: true });
assert.ok(!/\bmonochrome\b/i.test(bwNeg));
assert.ok(!/\bgreyscale\b/i.test(bwNeg));
assert.ok(!/\bcomic\b/i.test(bwNeg));
assert.ok(/\bcolor\b/i.test(bwNeg));
assert.ok(/\bspeech bubble\b/i.test(bwNeg));

// 2) 对白分类
assert.deepEqual(comicLineKind('「等一下！」'), { kind: 'speech', text: '等一下！' });
assert.deepEqual(comicLineKind('（她居然笑了…）'), { kind: 'thought', text: '她居然笑了…' });
assert.deepEqual(comicLineKind('咚！'), { kind: 'sfx', text: '咚！' });
assert.deepEqual(comicLineKind('雨声渐大，走廊陷入沉默。'), { kind: 'narr', text: '雨声渐大，走廊陷入沉默。' });

// 3) 分镜规范化与组装
const pages = normalizeComicPages({
    pages: [{
        title: '雨夜重逢',
        panels: [
            { visual: 'upper body, $白雪$, rain, umbrella', lines: ['「你回来了。」', '（心跳好快）'] },
            { visual: 'close-up, eyes, tear', lines: ['雨滴落在伞面。'] },
        ],
    }],
});
assert.equal(pages.length, 1);
assert.equal(pages[0].panels.length, 2);
assert.equal(panelBoxesFor(4).length, 4);

const prompt = buildComicPagePrompt(pages[0], {
    stylePrompt: 'artist:foo',
    monochrome: true,
    expand: s => s.replace('$白雪$', '1girl, silver hair'),
});
assert.ok(prompt.includes('monochrome, greyscale'));
assert.ok(prompt.includes('1girl, silver hair'));
assert.ok(prompt.includes('2koma'));

const html = renderComicBubblesHtml(pages[0], { fontSize: '12px', vertical: true, show: true });
assert.ok(html.includes('pc-cb2 speech v'));
assert.ok(html.includes('pc-cb2 thought v'));
assert.ok(html.includes('pc-cb2 narr'));
assert.equal(renderComicBubblesHtml(pages[0], { show: false }), '');

console.log('comic-core tests passed');
