// 角色外观库补丁（0.8.36 · 路线 B）：
//   ① 角色多两个字段 aliases / nl；
//   ② 回复里的 <人物> / <外貌变化> 自动建档，按楼层 + 按位置重放；
//   ③ 本聊天库 + 全局库两层，空字段回落到同名全局角色；
//   ④ rosterAt：把本聊天档案并进上游原生的 $名字$ / JSON 角色标记；
//   ⑤ 世界书宏 {{zhiku_characters}}；
//   ⑥ 流式预生成（标记一闭合就先发生图请求）；
//   ⑦ 生成后自动展开这次新出的图；
//   ⑧ 设置开关 + 「本聊天角色」管理页。
// 由 build-extension.mjs 最后一步调用：此时 applyMarkers / applyImageCharacters / applyIllustrationPlans 都已应用。
import fs from 'node:fs';
import assert from 'node:assert/strict';

function moduleSource(name) {
    return fs.readFileSync(new URL('../src/' + name, import.meta.url), 'utf8')
        .replace(/\r\n/g, '\n')
        .replace(/^export /gm, '');
}

const STREAM_EVENTS = [
    '    if (event_types.GENERATION_STARTED) {',
    '        const onGenerationStarted = () => __mod_marker.pregenReset?.();',
    '        eventSource.on(event_types.GENERATION_STARTED, onGenerationStarted);',
    '        cleanups.push(() => eventSource.removeListener?.(event_types.GENERATION_STARTED, onGenerationStarted));',
    '    }',
    '    if (event_types.STREAM_TOKEN_RECEIVED) {',
    '        // 有流式事件：节流 250ms 扫一遍流式缓冲，标记一闭合就先生图',
    '        let streamTimer = null, streamBusy = false;',
    '        const onStreamToken = () => {',
    '            if (streamTimer !== null) return;',
    '            streamTimer = setTimeout(() => {',
    '                streamTimer = null;',
    '                if (streamBusy) return;',
    '                streamBusy = true;',
    '                Promise.resolve(__mod_marker.pregenSweep?.())',
    '                    .catch(e => console.warn("[智库] 流式预生成", e))',
    '                    .finally(() => { streamBusy = false; });',
    '            }, 250);',
    '        };',
    '        eventSource.on(event_types.STREAM_TOKEN_RECEIVED, onStreamToken);',
    '        cleanups.push(() => { if (streamTimer !== null) clearTimeout(streamTimer); eventSource.removeListener?.(event_types.STREAM_TOKEN_RECEIVED, onStreamToken); });',
    '    } else {',
    '        // 宿主没有流式事件：退化成轮询（只在生成中用得上，其余时候什么都不做）',
    '        const poll = setInterval(() => {',
    '            try {',
    '                const c = SillyTavern.getContext();',
    '                if (c.is_send_press || c.generating || c.streamingProcessor?.isStreaming) void __mod_marker.pregenSweep?.();',
    '            } catch (e) { /* 宿主没这些字段就跳过 */ }',
    '        }, 400);',
    '        cleanups.push(() => clearInterval(poll));',
    '    }',
    '    eventSource.on(event_types.CHAT_CHANGED, onChat);',
].join('\n');

// 别名归一化：normalizeData 跑在 model 模块里，够不到 chars 模块的 ensureAliases，所以这里写一份等价的内联版
const ALIAS_NORMALIZE = [
    '    for (const character of Object.values(d.characters || {})) {',
    "        const list = Array.isArray(character.aliases) ? character.aliases.join(',') : String(character.aliases || '');",
    "        character.aliases = list.split(/[,，、;；|\\s]+/).map(x => x.trim()).filter(x => x && x !== character.name).join('，');",
    "        if (typeof character.nl !== 'string') character.nl = '';",
    '    }',
].join('\n');

export function applyCharLibrary(source) {
    let s = source;
    function patch(a, b, label) {
        const count = s.split(a).length - 1;
        assert.equal(count, 1, 'char-lib patch matched ' + count + ' times (' + label + '): ' + a.slice(0, 90));
        s = s.replace(a, () => b);
    }

    // ① 世界书宏的安装器（纯函数，放在 chars 模块外，装宏时要用）
    patch('// ───── chars.js ─────',
        moduleSource('char-macro.js') + '\n// ───── chars.js ─────',
        'inline char-macro');

    // ② 角色模型：aliases（上游本就当逗号拼接的字符串用）+ nl（英文自然语言描述）
    patch("    appearance: [], nsfwBody: [], outfitMode: 'story', outfits: [], outfitId: '', negative: '', charRef: '',",
        "    appearance: [], nsfwBody: [], outfitMode: 'story', outfits: [], outfitId: '', negative: '', charRef: '',\n"
        + "    aliases: '', nl: '',",
        'blank aliases nl');
    patch('if (d.characters[key]) return d.characters[key];',
        'if (d.characters[key]) return ensureAliases(d.characters[key]);',
        'getChar aliases');
    patch("    for (const a of Object.values(d.artists)) { a.images ||= []; a.note ||= ''; a.collections ||= []; a.tag = normalizeArtistTag(a.tag); }\n",
        "    for (const a of Object.values(d.artists)) { a.images ||= []; a.note ||= ''; a.collections ||= []; a.tag = normalizeArtistTag(a.tag); }\n"
        + ALIAS_NORMALIZE + '\n',
        'normalizeData aliases');

    // ③ 设置默认值（老用户没有这些键，start() 里还会再兜一次）
    patch('            lobbyShowNsfw: false,\n',
        '            lobbyShowNsfw: false,\n'
        + '            charAutoBlocks: true,     // 从回复里的 <人物>/<外貌变化> 自动建档\n'
        + '            charBlockToast: true,     // 建档 / 改档时给一条小提示\n'
        + '            markerResultExpand: true, // 生成完自动展开这次新出的那张图\n'
        + '            markerStream: true,       // 流式预生成：标记一写完整就先出图\n',
        'options default');

    // ④ chars 模块内：块解析 / 楼层重放 / 双层合并 / 运行时辅助
    // 放在 chars 模块**里面**（而不是模块外）：它们要用 getData / ctx / M / commit，
    // 而且上游测试是把这一整段取出来在沙箱里跑的，放在外面就取不到。
    patch('const T = __mod_translate;\nconst ctx = () => SillyTavern.getContext();',
        'const T = __mod_translate;\n'
        + moduleSource('char-blocks.js') + '\n'
        + moduleSource('char-helpers.js') + '\n'
        + 'const ctx = () => SillyTavern.getContext();',
        'chars helpers');
    patch('deleteOutfit };',
        'deleteOutfit, allChars, mergedChatEntries, rosterAt, stageStreamText, characterMacroText,'
        + ' chatBaseEntries, writeChatBase, chatStateAt, chatLatest, chatLockedNames,'
        + ' applyCharacterBlocks, applyAllCharacterBlocks, invalidateCharState,'
        + ' saveChatEntry, deleteChatEntry, chatEntryRollback, promoteChatEntry, copyGlobalToChat };',
        'chars exports');

    // ⑤ markerPrompt 用「这一楼、这一位置」的名单：$名字$ / JSON 角色 / 结构化分镜都认得本聊天档案
    patch('function markerPrompt(prompt, { story } = {}) {\n'
        + '    const plan = readIllustrationPlan(prompt);\n'
        + '    const parsed = plan ? compileIllustrationPlan(plan, currentCast(), story === undefined ? undefined : imageStoryText(story)) : resolveImageCharacters(prompt, currentCast());',
        'function markerPrompt(prompt, { story, floor, pos } = {}) {\n'
        + '    // 本聊天档案按楼层（和位置）重放后并进名单；与全局同名时覆盖全局条目，免得「匹配到多人」\n'
        + '    const roster = rosterAt(floor, pos);\n'
        + '    const plan = readIllustrationPlan(prompt);\n'
        + '    const parsed = plan ? compileIllustrationPlan(plan, roster, story === undefined ? undefined : imageStoryText(story)) : resolveImageCharacters(prompt, roster);',
        'markerPrompt roster');

    // ⑥ 流式文本：顺手喂给本聊天档案的临时重放，流式阶段的图也能带上刚建档的角色
    patch('getData:__mod_store.getData,document:DOC,',
        'getData:__mod_store.getData,'
        + 'getStreamingText:()=>{const c=SillyTavern.getContext();'
        + 'const live=c.streamingProcessor?.messageText;'
        + 'if(typeof live==="string"&&live){__mod_chars.stageStreamText(live);return live;}'
        + 'const node=[...DOC.querySelectorAll("#chat .mes[mesid]")].pop();'
        + 'const body=node?.querySelector(".mes_text");if(!body)return "";'
        + 'const clone=body.cloneNode(true);'
        + 'clone.querySelectorAll(".pc-marker-slot,.pc-image-actions").forEach(el=>el.remove());'
        + 'const text=clone.textContent||"";__mod_chars.stageStreamText(text);return text;},document:DOC,',
        'marker streaming text');

    // ⑦ 「把这个角色的外貌套到另一个」也带上描述
    patch('    b.negative = a.negative;\n',
        "    b.negative = a.negative;\n    b.nl = String(a.nl || '');\n",
        'copyLook nl');

    // ⑧ 分享 / 另存为角色卡 / 智绘姬导入：别名与描述一起走
    patch('return { character: { name: c.name, appearance: c.appearance,',
        'return { character: { name: c.name, aliases: splitAliases(c.aliases), nl: String(c.nl || "").trim(), appearance: c.appearance,',
        'characterPayload aliases');
    patch('? { name: src.name, appearance: src.appearance, nsfwBody:',
        '? { name: src.name, aliases: splitAliases(src.aliases), nl: String(src.nl || "").trim(), appearance: src.appearance, nsfwBody:',
        'saveCharacterPost aliases');
    patch("        name: ch.nameCN || ch.nameEN || '角色',\n        appearance: parsePairs(",
        "        name: ch.nameCN || ch.nameEN || '角色',\n        aliases: splitAliases(ch.nameEN),\n        appearance: parsePairs(",
        'zhihuiji import aliases');

    // ⑨ 启动：默认值 + 装世界书宏 + 先把已有楼层过一遍
    patch('    if (getData().options.markerAuto === undefined) getData().options.markerAuto = true;\n',
        '    if (getData().options.markerAuto === undefined) getData().options.markerAuto = true;\n'
        + '    if (getData().options.charAutoBlocks === undefined) getData().options.charAutoBlocks = true;\n'
        + '    if (getData().options.charBlockToast === undefined) getData().options.charBlockToast = true;\n'
        + '    if (getData().options.markerResultExpand === undefined) getData().options.markerResultExpand = true;\n'
        + '    if (getData().options.markerStream === undefined) getData().options.markerStream = true;\n'
        + '    __mod_chars.invalidateCharState();\n'
        + '    setTimeout(() => { try { __mod_chars.applyAllCharacterBlocks(); } catch (e) { console.warn("[智库] 角色块回填", e); } }, 400);\n'
        + '    const charMacro = installCharMacro(SillyTavern.getContext(), {\n'
        + '        text: () => __mod_chars.characterMacroText(),\n'
        + '        log: message => console.warn(message),\n'
        + '    });\n'
        + '    cleanups.push(() => charMacro.uninstall());\n',
        'start macro');

    // ⑩ 设置页开关
    patch("\${sw('imageExpanded', '图片默认展开', '开启：默认展开；关闭：默认折叠。立即应用到当前图片，并记住选择。')}",
        "\${sw('imageExpanded', '图片默认展开', '开启：默认展开；关闭：默认折叠。立即应用到当前图片，并记住选择。')}"
        + "\${sw('charAutoBlocks', '从回复自动建档 / 记录外貌变化', '解析回复里的 &lt;人物&gt; / &lt;外貌变化&gt;，按楼层生效；全局角色只读')}"
        + "\${sw('charBlockToast', '建档时提示', '每楼最多一条小提示')}"
        + "\${sw('markerResultExpand', '生成后自动展开图片', '默认开启 · 这次新生成的图直接展开，历史图片仍然收起')}"
        + "\${sw('markerStream', '流式预生成', '默认开启 · 回复还在流、标记一写完整就先发生图请求，正文写完时图片往往已经好了')}",
        'settings toggles');
    patch('<div class="pc-hint">逐图调用角色：在图片提示词内写 $名字-sfw-upperbody$，也支持智绘姬 JSON 角色标记。',
        '<div class="pc-hint">逐图调用角色：在图片提示词内写 $名字-sfw-upperbody$，也支持智绘姬 JSON 角色标记；名字可以是角色页登记的别名，本聊天建档的角色按楼层生效。',
        'marker hint');

    // ⑪ 角色页：描述输入（别名输入上游已有 data-charalias，别重复加）
    patch('      <label class="pc-field pc-mt-s"><span>别名（逗号隔开）· 图片角色标记可使用名字或别名</span><input data-charalias value="\${esc(c.aliases || \'\')}" placeholder="比如 小秋，秋秋"></label>\n',
        '      <label class="pc-field pc-mt-s"><span>别名（逗号隔开）· 图片角色标记可使用名字或别名</span><input data-charalias value="\${esc(c.aliases || \'\')}" placeholder="比如 小秋，秋秋"></label>\n'
        + '      <label class="pc-field"><span>描述（英文自然语言，可空）</span><textarea class="pc-textarea mono" data-charnl rows="2" placeholder="a girl with long black hair and blue eyes">\${esc(c.nl || \'\')}</textarea></label>\n'
        + '      <div class="pc-hint">描述接在这个角色的外貌标签后面，作为分角色提示词的自然语言补充（NovelAI 4.5 / v4.5 分人物时用）。</div>\n',
        'nl input');
    patch('if (el.dataset.charalias !== undefined)',
        'if (el.dataset.charnl !== undefined) { const c = C.getChar(ui.charKey); if (c) { c.nl = el.value.trim(); C.saveChar(c); } return; }\n'
        + '    if (el.dataset.charalias !== undefined)',
        'nl handler');
    patch('聊天生图时，再加上 AI 写的动作表情',
        '标记里写 $名字$ 或别名会展开成这一串（分角色时带描述）；聊天生图时，再加上 AI 写的动作表情',
        'char preview hint');

    // ⑫ 角色页入口 + 本聊天角色页 / 历史页
    patch('    <div class="pc-seg three pc-mt">',
        '    <section class="pc-card pc-pad pc-mt">\n'
        + '      <div class="pc-row-between"><b>本聊天角色</b><button class="pc-pill dashed tiny" data-act="openchatlib">管理</button></div>\n'
        + '      <div class="pc-dim small">AI 用 &lt;人物&gt; 建档、&lt;外貌变化&gt; 改档，按楼层生效；这里是最新状态。全局角色对 AI 只读。</div>\n'
        + '    </section>\n'
        + '    <div class="pc-seg three pc-mt">',
        'cast chatlib entry');
    patch('const VIEWS = { comfy: viewComfy,',
        moduleSource('char-ui.js') + '\nconst VIEWS = { comfy: viewComfy,',
        'views inline');
    patch('const VIEWS = { comfy: viewComfy,',
        'const VIEWS = { comfy: viewComfy, chatlib: viewChatLib, charhist: viewChatHist,',
        'views map');
    patch('    setOpen: {},',
        "    setOpen: {},\n    chatHistName: '',",
        'ui chatHistName');
    patch("const mainView = ['artist', 'group', 'batch'].includes(ui.view) ? 'book' : ['charedit', 'outfit'].includes(ui.view) ? 'cast' : ui.view;",
        "const mainView = ['artist', 'group', 'batch'].includes(ui.view) ? 'book' : ['charedit', 'outfit', 'chatlib', 'charhist'].includes(ui.view) ? 'cast' : ui.view;",
        'mainView');

    // ⑬ 本聊天角色页的按钮动作（内联在 charAction 之前，由 charAction 开头转发）
    patch('async function charAction(act, el) {\n    const c = C.getChar(ui.charKey);\n    const d = getData();\n    switch (act) {',
        moduleSource('char-actions.js') + '\n'
        + 'async function charAction(act, el) {\n'
        + '    const c = C.getChar(ui.charKey);\n'
        + '    const d = getData();\n'
        + '    if (typeof chatCharAction === "function" && await chatCharAction(act, el)) return true;\n'
        + '    switch (act) {',
        'charAction forward');

    // ⑭ 事件：切聊天 / 编辑 / 滑动 / 删楼 / 新回复时解析角色块
    patch('const onChat = () => { selectedImages.reset(); return setTimeout(() => { globalThis.__zhikuComic?.renderAll({ chatChanged: true }); UI.renderChip(); UI.renderStub(); E.applyBindingOnChatChange(); addMesButtons(); }, 300); };',
        'const onChat = () => { selectedImages.reset(); __mod_chars.invalidateCharState(); return setTimeout(() => { void __mod_chars.applyAllCharacterBlocks(); globalThis.__zhikuComic?.renderAll({ chatChanged: true }); UI.renderChip(); UI.renderStub(); E.applyBindingOnChatChange(); addMesButtons(); }, 300); };',
        'chat changed');
    patch('    const onEdited = id => { onRendered(id); };',
        '    const onEdited = id => { onRendered(id); __mod_chars.invalidateCharState(); void __mod_chars.applyCharacterBlocks(Number(id)); };\n'
        + '    const onSwiped = id => { __mod_chars.invalidateCharState(); void __mod_chars.applyCharacterBlocks(Number(id)); };\n'
        + '    const onDeleted = () => { __mod_chars.invalidateCharState(); };',
        'edit swipe delete');
    patch('    const onCharMsg = id => {\n'
        + '        setTimeout(() => { comic.render(Number(id)); void comic.process(Number(id)); }, 0);\n'
        + '        setTimeout(addMesButtons, 50);\n'
        + '        setTimeout(() => { void __mod_marker.process(Number(id)); }, 0);',
        '    const onCharMsg = id => {\n'
        + '        setTimeout(() => { comic.render(Number(id)); void comic.process(Number(id)); }, 0);\n'
        + '        setTimeout(addMesButtons, 50);\n'
        + '        // 先收角色块再生图：这一楼刚建档的角色，这张图就能用上\n'
        + '        setTimeout(() => { void __mod_chars.applyCharacterBlocks(Number(id)); void __mod_marker.process(Number(id)); }, 0);',
        'char msg blocks');
    patch('[event_types.MESSAGE_UPDATED, onEdited]]) {',
        '[event_types.MESSAGE_UPDATED, onEdited], [event_types.MESSAGE_SWIPED, onSwiped], [event_types.MESSAGE_DELETED, onDeleted]]) {',
        'register swipe delete');

    // ⑮ 流式预生成：文字还在流，标记一闭合就先发请求
    patch('    eventSource.on(event_types.CHAT_CHANGED, onChat);', STREAM_EVENTS, 'stream pregen');

    return s;
}
