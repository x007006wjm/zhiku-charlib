// NovelAI Precise Reference (V4.5 & V5) 参数构造与类型映射。
// V5 (2026-11-24) 正式支持精确参考，新增「服装参考（outfit）」与「优先同服装」，
// 废除忠实度滑条（secondary_strength 固定为 0），强度上限提升至 5.0。

export const PRECISE_REF_TYPES_V45 = [
    ['character', '只参考长相'],
    ['both', '长相和画风'],
    ['style', '只参考画风'],
];

export const PRECISE_REF_TYPES_V5 = [
    ['character', '只参考长相'],
    ['both', '长相和画风'],
    ['outfit', '服装参考（V5）'],
    ['style', '只参考画风'],
];

export const DIRECTOR_BUCKETS_V45 = [
    [1024, 1536],
    [1472, 1472],
    [1536, 1024],
];

// V5 PR 使用官方约 1MP 分桶尺寸（不能沿用 V4.5 的 1024×1536 / 1472×1472 / 1536×1024）
export const DIRECTOR_BUCKETS_V5 = [
    [832, 1216],
    [1024, 1024],
    [1216, 832],
];

export function pickDirectorBucket(width, height, isV5 = false) {
    const buckets = isV5 ? DIRECTOR_BUCKETS_V5 : DIRECTOR_BUCKETS_V45;
    const w = Number(width), h = Number(height);
    if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return buckets[1];
    const ratio = w / h;
    return buckets.reduce((a, b) => (Math.abs(b[0] / b[1] - ratio) < Math.abs(a[0] / a[1] - ratio) ? b : a));
}

export function isPreciseRefModel(model) {
    const m = String(model || '');
    return m.includes('4-5') || m.includes('nai-diffusion-5');
}

export function directorBaseCaption(type, isV5 = false) {
    switch (type) {
        case 'both':
        case 'character&style':
        case 'both_outfit':
        case 'character&style&outfit':
            return 'character&style';
        case 'style':
            return 'style';
        case 'outfit':
            return isV5 ? 'outfit' : 'character';
        case 'character':
        case 'character_outfit':
        case 'character&outfit':
        default:
            return 'character';
    }
}

export function clampDirectorStrength(value, isV5 = false) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0.6;
    const max = isV5 ? 5 : 1;
    return Math.round(Math.min(max, Math.max(0, n)) * 1000) / 1000;
}

export function buildDirectorParams(director, isV5 = false) {
    const list = Array.isArray(director) ? director : [];
    const strengths = list.map(r => clampDirectorStrength(r.strength, isV5));
    return {
        director_reference_images_cached: list.map(r => ({ cache_secret_key: r.key, data: r.data })),
        director_reference_descriptions: list.map(r => ({
            caption: { base_caption: directorBaseCaption(r.type, isV5), char_captions: [] },
            legacy_uc: false,
        })),
        director_reference_information_extracted: list.map(() => 1),
        director_reference_strength_values: strengths,
        // V5 废除了忠实度（Fidelity），统一填 0；V4.5 保持原有 1 - strength 计算
        director_reference_secondary_strength_values: isV5
            ? list.map(() => 0)
            : strengths.map(v => Math.round((1 - v) * 1000) / 1000),
    };
}
