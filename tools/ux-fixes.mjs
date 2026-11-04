// 0.8.7 体验修正：固定提示词、画师串折叠、角色参考并进角色页、共享读图片提示词、衣柜整套粘贴
// 改动写在 ux-fixes.patch.txt 里，每块「@@@ OLD」原文必须在脚本里只出现一次。
import fs from 'node:fs';
import assert from 'node:assert/strict';

export function applyUxFixes(s) {
    const raw = fs.readFileSync(new URL('./ux-fixes.patch.txt', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    const blocks = raw.split(/^@@@ OLD.*\n/m).slice(1);
    assert(blocks.length > 10, 'ux-fixes.patch.txt 没读到补丁');
    for (const b of blocks) {
        const [oldPart, rest] = b.split(/^@@@ NEW.*\n/m);
        assert(rest !== undefined, '缺 @@@ NEW：' + oldPart.slice(0, 60));
        const newPart = rest.split(/^@@@ END.*\n?/m)[0];
        const a = oldPart.replace(/\n$/, ''), n = newPart.replace(/\n$/, '');
        assert.equal(s.split(a).length, 2, '补丁原文不唯一或找不到：' + a.slice(0, 80));
        s = s.replace(a, () => n);
    }
    // 0.8.7：手机美化兼容。有的美化给 body 加 transform / filter，窗口就只剩一截、还透出聊天；
    // 所以窗口和弹窗挂到 <html> 上，层级抬到最高，背景不再依赖美化的颜色变量。
    s = s.replace('const DOC = P.document;', 'const DOC = P.document;\nconst pcMount = el => (DOC.documentElement || DOC.body).appendChild(el);');
    assert(s.includes('const pcMount'), '没找到 DOC 定义');
    s = s.replaceAll('DOC.body.appendChild(', 'pcMount(');
    for (const [a, b] of [['30000', '2147480000'], ['30010', '2147480010'], ['30020', '2147480020'], ['30030', '2147480030'], ['30050', '2147480050']]) {
        assert(s.includes('z-index: ' + a), 'z-index ' + a);
        s = s.replaceAll('z-index: ' + a, 'z-index: ' + b);
    }
    return s;
}
