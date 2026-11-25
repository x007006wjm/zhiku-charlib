// 智库 UI extension. Runtime is bundled locally; Tavern Helper is not required.
let runtime = null;
let pending = null;
let enabled = true;
let bootTimer = null;
const ctx = globalThis.SillyTavern?.getContext?.();

function checkHost() {
    const c = globalThis.SillyTavern?.getContext?.();
    const missing = [];
    if (!c) missing.push('SillyTavern.getContext');
    for (const key of ['getRequestHeaders', 'saveSettingsDebounced']) if (typeof c?.[key] !== 'function') missing.push(key);
    if (!c?.extensionSettings) missing.push('extensionSettings');
    if (!c?.eventSource?.on || !c?.eventSource?.removeListener || !c?.eventTypes?.APP_READY) missing.push('eventSource / APP_READY');
    if (missing.length) throw new Error('酒馆缺少接口：' + missing.join(', '));
    return c;
}

async function startExtension() {
    if (!enabled || runtime) return;
    if (pending) return pending;
    pending = (async () => {
        checkHost();
        const { createRuntime } = await import('./runtime.js?v=0.8.15');
        if (!enabled) return;
        const candidate = createRuntime();
        try {
            await candidate.start();
            if (!enabled) await candidate.stop();
            else runtime = candidate;
        } catch (error) { await candidate.stop(); throw error; }
    })();
    try { await pending; }
    catch (error) { console.error('[智库扩展]', error); globalThis.toastr?.error(error.message, '智库启动失败'); }
    finally { pending = null; }
}

function scheduleStart() {
    clearTimeout(bootTimer);
    bootTimer = setTimeout(() => { bootTimer = null; void startExtension(); }, 0);
}

export function onEnable() { enabled = true; scheduleStart(); }
export async function onDisable() {
    enabled = false;
    clearTimeout(bootTimer);
    ctx?.eventSource?.removeListener(ctx.eventTypes.APP_READY, scheduleStart);
    await pending?.catch(() => {});
    const active = runtime;
    runtime = null;
    if (active) await active.stop();
}
export async function onDelete() { await onDisable(); }

if (ctx?.eventSource && ctx?.eventTypes?.APP_READY) {
    ctx.eventSource.on(ctx.eventTypes.APP_READY, scheduleStart);
} else {
    globalThis.toastr?.error('当前酒馆缺少扩展启动接口，请升级 SillyTavern。', '智库');
}
window.addEventListener('pagehide', () => { void onDisable(); }, { once: true });
