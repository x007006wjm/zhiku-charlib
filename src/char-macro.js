// 世界书宏 {{zhiku_characters}} 的注册与注销。
// 宿主用 SillyTavern.getContext() 暴露的 registerMacro / unregisterMacro（1.14 的扩展接口）；
// 老版本或没有这个接口时只写一条 warn，不影响其它功能。
// 构建时由 tools/apply-char-lib.mjs 去掉 export 后内联进 runtime.js。

export const CHAR_MACRO_NAME = 'zhiku_characters';

/**
 * 注册宏；返回 { supported, uninstall }。
 * text 是一个函数，每次展开宏时现算（角色开关、聊天切换都能立刻反映）。
 */
export function installCharMacro(ctx, { text, log = () => {} } = {}) {
    const api = ctx || {};
    const read = typeof text === 'function' ? text : () => '';
    let active = true;
    const handler = () => (active ? String(read() ?? '') : '');
    const register = api.registerMacro;
    if (typeof register !== 'function') {
        log('[智库] 宿主没有 registerMacro，{{zhiku_characters}} 宏不可用');
        return { supported: false, uninstall() { active = false; } };
    }
    // 不同版本的 registerMacro 签名不一样：先试 (name, handler)，再试 (name, description, handler)。
    const attempts = register.length >= 3
        ? [[CHAR_MACRO_NAME, '智库：本聊天出场角色的 $名字$ 清单', handler], [CHAR_MACRO_NAME, handler]]
        : [[CHAR_MACRO_NAME, handler], [CHAR_MACRO_NAME, '', handler]];
    let registered = false;
    for (const args of attempts) {
        try {
            register.apply(api, args);
            registered = true;
            break;
        } catch (error) {
            // 换一种签名再试；都不行会在下面报 warn。
        }
    }
    if (!registered) {
        log('[智库] 注册 {{zhiku_characters}} 宏失败');
        return { supported: false, uninstall() { active = false; } };
    }
    return {
        supported: true,
        uninstall() {
            active = false;
            const unregister = api.unregisterMacro;
            if (typeof unregister === 'function') {
                try {
                    unregister.call(api, CHAR_MACRO_NAME);
                } catch (error) {
                    log('[智库] 注销 {{zhiku_characters}} 宏失败');
                }
            }
        },
    };
}
