// 本聊天角色页的按钮动作：手动建档 / 编辑 / 历史回滚 / 提升为全局 / 删除 / 复制。
// 由 tools/apply-char-lib.mjs 内联进 UI 模块（在 charAction 之前），因此可直接用
// C / getData / toastr / render / ui / esc / promptText / confirmBox 这些同模块的东西。

// 保存一条本聊天档案：先把这个名字在各楼层的历史收成字段级记录，再写基线并清掉旧 ops。
function saveManualChatEntry(input, oldName, previous) {
    const name = String(input.name || '').trim();
    if (!name) return false;
    const tags = pairsFromTags(input.appearance || '');
    const outfitTags = pairsFromTags(input.outfit || '');
    const id = 'o_manual_' + Date.now();
    // 衣服没改就保持「是否显式」的原状态（空字段继续沿用同名全局角色）；改了才算显式覆盖。
    const previousOutfit = previous && previous.outfitMode === 'fixed'
        ? tagsText(C.currentOutfit(previous)?.tags)
        : '';
    const outfitChanged = tagsText(outfitTags) !== previousOutfit;
    const aliases = input.aliases === undefined
        ? (previous ? (previous.aliases || []).join('，') : '')
        : String(input.aliases || '');
    const ok = C.saveChatEntry({
        name,
        aliases,
        appearance: tags,
        nl: String(input.nl || '').trim(),
        outfitMode: outfitTags.length ? 'fixed' : 'story',
        outfitModeExplicit: outfitChanged ? true : previous ? previous.outfitModeExplicit === true : false,
        outfits: outfitTags.length ? [{ id, name: '固定着装', tags: outfitTags }] : [],
        outfitId: outfitTags.length ? id : '',
    }, oldName || name);
    if (ok) toastr.success('已保存 ' + name, '角色档案');
    else toastr.warning('保存失败：名字不能为空', '角色档案');
    return ok;
}

async function chatCharAction(act, el) {
    const name = el?.dataset?.name || '';
    switch (act) {
        case 'openchatlib':
            ui.view = 'chatlib'; render(); root.querySelector('.pc-body')?.scrollTo(0, 0); return true;
        case 'chatlibhist':
            ui.chatHistName = name; ui.view = 'charhist'; render(); return true;
        case 'chatlibnew': {
            const newName = await promptText('新角色叫什么？', '');
            if (!newName) return true;
            const appearance = await promptText('外貌标签（英文逗号分隔；留空 = 沿用同名全局角色）', '', true);
            const nl = await promptText('描述（英文自然语言，可留空）', '', true);
            const outfit = await promptText('固定衣服（留空 = 跟剧情 / 沿用全局）', '', true);
            saveManualChatEntry({ name: newName, appearance, nl, outfit }, newName, null);
            ui.view = 'chatlib'; render();
            return true;
        }
        case 'chatlibedit': {
            const entry = C.chatLatest().find(item => item.name === name)
                || C.chatBaseEntries().find(item => item.name === name);
            if (!entry) return true;
            const nextName = await promptText('名字', entry.name);
            if (!nextName) return true;
            const aliases = await promptText('别名（逗号分隔）', (entry.aliases || []).join('，'));
            const appearance = await promptText('外貌标签（英文逗号分隔；留空 = 沿用同名全局角色）', C.tagText(entry.appearance), true);
            const nl = await promptText('描述（英文自然语言；留空 = 沿用同名全局角色）', entry.nl || '', true);
            const outfit = await promptText('固定衣服（留空 = 跟剧情 / 沿用全局）', entry.outfitMode === 'fixed' ? C.tagText(C.currentOutfit(entry)?.tags) : '', true);
            saveManualChatEntry({ name: nextName, aliases, appearance, nl, outfit }, entry.name, entry);
            ui.view = 'chatlib'; render();
            return true;
        }
        case 'chatlibrollback': {
            if (C.chatEntryRollback(name, Number(el.dataset.index))) {
                toastr.success('已回到所选档案', '角色档案');
                ui.view = 'chatlib'; render();
            }
            return true;
        }
        case 'chatlibdel': {
            if (!(await confirmBox('删除本聊天角色「' + name + '」？会连带清掉这个名字早先楼层记下的变化。'))) return true;
            if (C.deleteChatEntry(name)) { toastr.success('已删除', '角色档案'); render(); }
            return true;
        }
        case 'chatlibpromote': {
            if (!(await confirmBox('把「' + name + '」提升为全局角色？之后所有聊天都能用，AI 不再修改它。'))) return true;
            if (C.promoteChatEntry(name)) { toastr.success('已提升为全局角色', '角色档案'); render(); }
            return true;
        }
        case 'chatlibcopy': {
            if (C.copyGlobalToChat(el.dataset.key || '')) { toastr.success('已复制到本聊天，AI 可以改它了', '角色档案'); render(); }
            return true;
        }
        default:
            return false;
    }
}
