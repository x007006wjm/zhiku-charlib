// NovelAI 数值权重语法防护：
// 当权重块 `w::内容::` 的内容以数字（或 . : -）结尾时（如 `0.5::artist:bm94199::`、`1.2::year 2024::`），
// 若 `::` 前没有空格，NovelAI 解析器会把末尾数字与 `::` 误判为嵌套权重导致权重爆炸。
// 本模块保证这类标签在拼接、格式化和最终发送前一律保留/补齐 `::` 前的保护空格。

const WEIGHT_TAIL_RE = /(-?\d+(?:\.\d+)?::(?:(?!::)[\s\S])*?[\d.:\-])(::)/g;

/** 给文本中所有以数字/符号结尾的 `w::...::` 权重块补齐 `::` 前的保护空格（已有空格则不重复加）。 */
export function guardWeightSpacing(text) {
    const src = String(text ?? '');
    if (!src.includes('::')) return src;
    return src.replace(WEIGHT_TAIL_RE, '$1 $2');
}

/** 格式化单个权重标签：权重为 1 返回原文，否则按需在 `::` 前保留保护空格。 */
export function formatWeightTag(weightStr, text) {
    const body = String(text ?? '');
    const pad = /[\d.:\-]$/.test(body) ? ' ' : '';
    return `${weightStr}::${body}${pad}::`;
}
