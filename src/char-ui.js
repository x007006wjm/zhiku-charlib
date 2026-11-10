function viewChatLib() {
    const d = getData();
    const merged = C.mergedChatEntries();
    const locked = C.chatLockedNames();
    const srcTag = (sources, key) => sources[key] === 'global' ? '（来自全局）' : sources[key] === 'union' ? '（合并）' : '';
    const rows = merged.map(({ entry, sources }) => `<div class="pc-who">
      <div class="pc-grow"><b>${esc(entry.name)}</b><small>${entry.source === 'ai' ? 'AI 建档' : '手动'} · ${esc(C.tagText(entry.appearance)) || '（没有外貌）'}${entry.outfitMode === 'fixed' ? ` · 固定衣服${srcTag(sources, 'outfit')}` : ''}${entry.nl ? ` · 描述${srcTag(sources, 'nl')}` : ''}${sources.aliases === 'union' ? ' · 别名（合并）' : ''}</small></div>
      <div class="pc-chips wrap">
        <button class="pc-pill dashed tiny" data-act="chatlibedit" data-name="${esc(entry.name)}">编辑</button>
        <button class="pc-pill dashed tiny" data-act="chatlibhist" data-name="${esc(entry.name)}">历史</button>
        <button class="pc-pill dashed tiny" data-act="chatlibpromote" data-name="${esc(entry.name)}">提升为全局</button>
        <button class="pc-pill dashed tiny danger" data-act="chatlibdel" data-name="${esc(entry.name)}">删除</button>
      </div></div>`).join('');
    const lockedRows = Object.values(d.characters || {}).filter(c => locked.has(c.name)).map(c => `<div class="pc-who">
      <div class="pc-grow"><b>${esc(c.name)}</b><small>全局库 · 固定，不可改${c.nl ? ' · 有描述' : ''}</small></div>
      <button class="pc-pill dashed tiny" data-act="chatlibcopy" data-key="${esc(c.key || '')}">复制到本聊天</button></div>`).join('');
    return `<div class="pc-dhead"><button class="pc-round" data-act="nav" data-view="cast" aria-label="返回">‹</button><div class="pc-grow"><h2 class="pc-dtitle">本聊天角色</h2><div class="pc-tip" style="margin:0">按楼层重放：改档只影响它之后的楼层；空字段回落到同名全局角色。</div></div></div>
    <section class="pc-card pc-pad pc-mt"><div class="pc-row-between"><b>本聊天档案</b><button class="pc-pill dashed tiny" data-act="chatlibnew">＋ 新建</button></div>
    ${rows || '<div class="pc-dim small">还没有本聊天角色。AI 回复里写 &lt;人物&gt; 就会自动建档。</div>'}</section>
    <section class="pc-card pc-pad pc-mt"><b>全局角色（固定）</b><div class="pc-dim small">AI 不会改全局角色；想要它在本聊天可改，就复制一份到本聊天。</div>${lockedRows || '<div class="pc-dim small">没有全局角色</div>'}</section>
    <div style="height:24px"></div>`;
}

function viewChatHist() {
    const entry = C.chatLatest().find(e => e.name === ui.chatHistName) || C.chatBaseEntries().find(e => e.name === ui.chatHistName);
    const history = entry?.history || [];
    const FIELD = { new: '建档', appearance: '外貌', outfit: '服装', nl: '描述', manual: '手动' };
    const rows = history.map((h, i) => `<div class="pc-who">
      <div class="pc-grow"><b>${h.floor >= 0 ? `第 ${h.floor + 1} 楼` : '手动'} · ${esc(h.reason || '变化')} · ${FIELD[h.field] || esc(h.field)}</b><small>${esc(h.from || '（无）')} → ${esc(h.to || '（无）')}</small></div>
      <button class="pc-pill dashed tiny" data-act="chatlibrollback" data-name="${esc(entry?.name || ui.chatHistName)}" data-index="${i}">回到这里</button></div>`).join('');
    return `<div class="pc-dhead"><button class="pc-round" data-act="nav" data-view="chatlib" aria-label="返回">‹</button><div class="pc-grow"><h2 class="pc-dtitle">${esc(ui.chatHistName || '')} · 档案历史</h2></div></div>
    <section class="pc-card pc-pad pc-mt">${rows || '<div class="pc-dim small">还没有记录。</div>'}</section>
    <div class="pc-hint">「回到这里」会把当时的字段写成手动值（手动值优先，AI 之后的改动仍会记在历史里）。</div>`;
}
