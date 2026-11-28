import assert from 'node:assert/strict';
import { pngPixelArea, extractPngFrames, pickFinalImageFrame } from '../src/stream-final.js';

function fakePng(w, h) {
    // Minimal PNG header + IHDR (13 bytes) + IEND (0 bytes)
    const buf = new Uint8Array(8 + 25 + 12);
    buf.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    const dv = new DataView(buf.buffer);
    dv.setUint32(8, 13);
    buf.set([0x49, 0x48, 0x44, 0x52], 12); // IHDR
    dv.setUint32(16, w);
    dv.setUint32(20, h);
    // IEND at offset 33
    dv.setUint32(33, 0);
    buf.set([0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82], 37);
    return buf;
}

const preview = fakePng(208, 304);
const finalImg = fakePng(832, 1216);

assert.equal(pngPixelArea(preview), 208 * 304);
assert.equal(pngPixelArea(finalImg), 832 * 1216);

// Multi-frame stream: preview + final -> picks final
const combined = new Uint8Array(preview.length + finalImg.length);
combined.set(preview, 0);
combined.set(finalImg, preview.length);
const frames = extractPngFrames(combined);
assert.equal(frames.length, 2);
const picked = pickFinalImageFrame(frames, { w: 832, h: 1216 });
assert.equal(pngPixelArea(picked), 832 * 1216);

// Only preview frame -> throws retryable error
assert.throws(
    () => pickFinalImageFrame([preview], { w: 832, h: 1216 }),
    err => err.retryable === true && /只收到生成中的预览图/.test(err.message)
);

console.log('stream-final tests passed');
