// 角色外观库：标记里的 $名字$ 展开。
// 纯函数，不碰 DOM，也不发请求；构建时由 tools/apply-char-lib.mjs 去掉 export 后内联进 runtime.js。
// 设计说明见 README「角色外观库」一节：
// - 只展开 `$…$`，原文与消息里的标记保持不变，展开结果只用于发给 NovelAI 的提示词。
// - 名字与别名按「本聊天出场角色优先，其次所有已保存角色」匹配，trim + 忽略大小写。
// - 匹配不到时去掉 $ 保留原文，并写一行调试日志，不弹提示。

/** 名字 / 别名的分隔符：| 或中英文逗号、顿号、分号、换行。 */
export const CHAR_ALIAS_SPLIT = /[|,，、;；\n]+/;

/** 把 aliases 字段（数组或 "a|b" / "a,b" 字符串）整理成去重后的名字数组。 */
export function splitAliases(value) {
    const raw = Array.isArray(value) ? value : String(value ?? '').split(CHAR_ALIAS_SPLIT);
    const out = [];
    for (const item of raw) {
        const name = String(item ?? '').trim();
        if (name && !out.includes(name)) out.push(name);
    }
    return out;
}

/** 原地补齐 aliases 与 nl（旧数据没有这些字段时补空值），返回同一个对象，方便直接存回。 */
export function ensureAliases(character) {
    if (!character || typeof character !== 'object') return character;
    const name = String(character.name ?? '').trim();
    const aliases = splitAliases(character.aliases).filter(alias => alias !== name);
    character.aliases = aliases;
    character.nl = typeof character.nl === 'string' ? character.nl.trim() : '';
    return character;
}

/** 名字 + 别名，去重、去空，第一个永远是正名。 */
export function characterNames(character) {
    const name = String(character?.name ?? '').trim();
    const list = [name, ...splitAliases(character?.aliases)];
    const out = [];
    for (const item of list) {
        const value = String(item ?? '').trim();
        if (value && !out.includes(value)) out.push(value);
    }
    return out;
}

/** 别名输入框里显示的内容：用 | 连起来（正名重复出现时剔除）。 */
export function charAliasText(character) {
    const name = String(character?.name ?? '').trim();
    return splitAliases(character?.aliases).filter(alias => alias !== name).join('|');
}

function normName(value) {
    return String(value ?? '').trim().toLowerCase();
}

/** appearance / outfit.tags 这类 [{en,zh}] 列表 → 逗号分隔的英文标签串。 */
export function tagText(list) {
    return (Array.isArray(list) ? list : [])
        .map(item => String(item?.en ?? item ?? '').trim())
        .filter(Boolean)
        .join(', ');
}

export function currentOutfitOf(character) {
    const list = Array.isArray(character?.outfits) ? character.outfits : [];
    return list.find(outfit => outfit?.id === character?.outfitId) || list[0] || null;
}

/** 这个角色固定会发的标签：外貌 + 固定衣服（outfitMode === 'fixed' 时）。 */
export function fixedTagsOf(character) {
    const parts = [tagText(character?.appearance)];
    if (character?.outfitMode === 'fixed') parts.push(tagText(currentOutfitOf(character)?.tags));
    return parts.filter(Boolean).join(', ');
}

/**
 * 名字 → 角色。顺序即优先级：先本聊天库（按楼层派生出来的那一份），
 * 再本聊天 on 着的全局角色，最后其余全局角色；同一个名字/别名只保留最先出现的那个。
 */
export function buildCharacterIndex(cast = [], characters = [], chatEntries = []) {
    const index = new Map();
    const add = character => {
        if (!character) return;
        for (const name of characterNames(character)) {
            const key = normName(name);
            if (key && !index.has(key)) index.set(key, character);
        }
    };
    (Array.isArray(chatEntries) ? chatEntries : []).forEach(add);
    (Array.isArray(cast) ? cast : []).forEach(item => {
        if (item && item.on && item.char) add(item.char);
    });
    (Array.isArray(characters) ? characters : []).forEach(add);
    return index;
}

/**
 * 展开一段提示词里的 `$名字$`。
 * options.chatEntries 本聊天库在该楼层的派生结果（优先）
 * options.cast      当前聊天的 [{ key, char, on, group }]
 * options.characters 所有已保存角色
 * options.enabled   false 时原样返回（对应设置里的开关）
 * options.log       匹配不到时的调试日志回调
 */
export function expandCharacterRefs(text, { chatEntries = [], cast = [], characters = [], enabled = true, log = () => {} } = {}) {
    const source = String(text ?? '');
    if (!enabled || !source.includes('$')) return source;
    const index = buildCharacterIndex(cast, characters, chatEntries);
    return source.replace(/\$([^$\n]+)\$/g, (match, rawName) => {
        const inner = String(rawName ?? '').trim();
        if (!inner) return match;
        const character = index.get(normName(inner));
        if (!character) {
            log(`[智库] 标记里的 $${inner}$ 没有对应角色，按普通文本发送`);
            return inner;
        }
        // 角色存在但没写外貌时也退回原文，避免发出空片段。
        return fixedTagsOf(character) || inner;
    });
}

/**
 * 世界书宏 {{zhiku_characters}} 的内容：一行一个本聊天开着的角色。
 * 只给名字/别名与后缀标记（固定服装 / 全局锁定），不写「写 $名字$」——用法由世界书解释。
 */
export function charactersMacroText(cast = [], { locked } = {}) {
    const rows = [];
    const seen = new Set();
    for (const item of Array.isArray(cast) ? cast : []) {
        if (!item || !item.on || !item.char) continue;
        const names = characterNames(item.char);
        const primary = names[0] || String(item.char?.name ?? '').trim();
        if (!primary || seen.has(primary)) continue;
        seen.add(primary);
        const aliases = names.slice(1);
        rows.push(`- ${primary}${aliases.length ? `（别名：${aliases.join('、')}）` : ''}${item.char.outfitMode === 'fixed' ? '[固定服装]' : ''}${locked && locked.has(primary) ? '[固定，不可改]' : ''}`);
    }
    return rows.join('\n');
}
