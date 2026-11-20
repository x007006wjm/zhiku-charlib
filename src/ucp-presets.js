// 自定义负面固定词多预设管理：纯函数，构建时内联进 runtime.js。
export const UCP_PRESET_PREFIX = 'preset:';

export function normalizeUcpPresets(raw) {
    if (!Array.isArray(raw)) return [];
    const out = [];
    const seen = new Set();
    for (const item of raw) {
        if (!item || typeof item !== 'object') continue;
        const id = String(item.id || '').trim();
        const name = String(item.name || '').trim();
        if (!id || !name || seen.has(id)) continue;
        seen.add(id);
        out.push({ id, name: name.slice(0, 32), text: String(item.text ?? '') });
    }
    return out;
}

export function ucpPresetIdOf(value) {
    const raw = String(value ?? '');
    return raw.startsWith(UCP_PRESET_PREFIX) ? raw.slice(UCP_PRESET_PREFIX.length) : '';
}

export function findUcpPreset(presets, ucpValue) {
    const id = ucpPresetIdOf(ucpValue);
    if (!id) return null;
    return normalizeUcpPresets(presets).find(p => p.id === id) || null;
}

export function resolveUcpText(settings, fallbackUcp = '') {
    const val = String(settings?.UCP_novelai ?? '');
    if (val === 'custom') return String(settings?.UCP_custom || '').trim();
    const hit = findUcpPreset(settings?.UCP_presets, val);
    if (hit) return String(hit.text || '').trim();
    return String(fallbackUcp || '');
}

export function createUcpPreset(presets, { name, text, id } = {}) {
    const list = normalizeUcpPresets(presets);
    const cleanName = String(name ?? '').trim().slice(0, 32) || `预设 ${list.length + 1}`;
    const cleanId = String(id || '').trim() || `ucp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const preset = { id: cleanId, name: cleanName, text: String(text ?? '') };
    return { presets: [...list, preset], preset, value: UCP_PRESET_PREFIX + cleanId };
}

export function updateUcpPresetText(presets, id, text) {
    const target = String(id || '').trim();
    return normalizeUcpPresets(presets).map(p => (p.id === target ? { ...p, text: String(text ?? '') } : p));
}

export function renameUcpPreset(presets, id, name) {
    const target = String(id || '').trim();
    const cleanName = String(name ?? '').trim().slice(0, 32);
    if (!cleanName) return normalizeUcpPresets(presets);
    return normalizeUcpPresets(presets).map(p => (p.id === target ? { ...p, name: cleanName } : p));
}

export function deleteUcpPreset(presets, id) {
    const target = String(id || '').trim();
    return normalizeUcpPresets(presets).filter(p => p.id !== target);
}
