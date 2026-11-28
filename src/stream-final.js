// NovelAI 流式返回 / 多图 ZIP 最终图挑选与防预览噪点校验

export function pngPixelArea(u8) {
    try {
        if (!(u8 instanceof Uint8Array) || u8.length < 24) return 0;
        if (u8[0] !== 0x89 || u8[1] !== 0x50 || u8[2] !== 0x4e || u8[3] !== 0x47) return 0;
        const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
        return dv.getUint32(16) * dv.getUint32(20);
    } catch {
        return 0;
    }
}

/** 从可能包含多张拼接 PNG（流式预览 + 最终图）的字节流中切出所有 PNG 帧 */
export function extractPngFrames(u8) {
    if (!(u8 instanceof Uint8Array) || u8.length < 24) return [];
    const frames = [];
    let i = 0;
    while (i + 8 <= u8.length) {
        if (u8[i] === 0x89 && u8[i + 1] === 0x50 && u8[i + 2] === 0x4e && u8[i + 3] === 0x47 &&
            u8[i + 4] === 0x0d && u8[i + 5] === 0x0a && u8[i + 6] === 0x1a && u8[i + 7] === 0x0a) {
            // 扫描 IEND 块结束位置（49 45 4E 44 AE 42 60 82）
            let end = -1;
            let p = i + 8;
            while (p + 12 <= u8.length) {
                const dv = new DataView(u8.buffer, u8.byteOffset + p, 8);
                const len = dv.getUint32(0);
                const isIend = u8[p + 4] === 0x49 && u8[p + 5] === 0x45 && u8[p + 6] === 0x4e && u8[p + 7] === 0x44;
                const next = p + 12 + len;
                if (next > u8.length) break;
                p = next;
                if (isIend) { end = p; break; }
            }
            if (end > i) {
                frames.push(u8.subarray(i, end));
                i = end;
                continue;
            }
            frames.push(u8.subarray(i));
            break;
        }
        i++;
    }
    return frames;
}

/**
 * 从候选图列表中按 PNG 像素面积挑出最终图（同最大面积取最后一张）。
 * 若已知目标尺寸 want={w,h} 且最大图面积小于目标面积的 25%，说明只收到中间预览图，抛出可重试错误。
 */
export function pickFinalImageFrame(list, want = null) {
    if (!Array.isArray(list) || !list.length) throw new Error('响应里没有图片');
    const sizes = list.map(f => (f instanceof Uint8Array ? pngPixelArea(f) : 0));
    let best = list.length - 1;
    if (sizes.some(Boolean)) {
        const max = Math.max(...sizes);
        best = sizes.lastIndexOf(max);
    }
    const wantArea = want && Number(want.w) > 0 && Number(want.h) > 0 ? Number(want.w) * Number(want.h) : 0;
    if (wantArea && sizes[best] > 1 && sizes[best] < wantArea * 0.25) {
        throw Object.assign(
            new Error('只收到生成中的预览图，最终图没传回来（多半是连接中途断了或站点超时）。重试一下；老是这样就把尺寸或步数调小，或换个连接方式'),
            { retryable: true }
        );
    }
    return list[best];
}
