import fs from 'node:fs';
import assert from 'node:assert/strict';
export function applyMarkers(source) {
    function presentation(s) {
        // 标记生图：出场角色绑定的角色参考优先；生成后处理「只用一次 / 每张换一个」
        s=s.replace("generate:prompt=>{const d=__mod_store.getData();return __mod_engine.generate({pos:__mod_model.mergeTags(d.active?__mod_model.ticketString(d,d.active):'',prompt),neg:[d.active?__mod_model.ticketNeg(d,d.active):'',d.options.chatNegative||''].filter(Boolean).join(', ')});},",()=>"generate:async prompt=>{const d=__mod_store.getData();const {positive,negative}=__mod_engine.composeStudio({pos:__mod_model.mergeTags(d.active?__mod_model.ticketString(d,d.active):'',prompt),neg:[d.active?__mod_model.ticketNeg(d,d.active):'',d.options.chatNegative||''].filter(Boolean).join(', ')});const bound=[...new Set(__mod_chars.currentCast().filter(x=>x.on).map(x=>x.char.charRef).filter(id=>id&&d.charRefGroups?.[id]))];const image=await __mod_engine.generateFull({positive,negative,director:bound.length?await __mod_engine.charRefs(bound):undefined});__mod_engine.afterChatImage();return image;},");
        if(!s.includes('const __naiGate=')){
            const gate=fs.readFileSync(new URL('../src/nai-gate.js',import.meta.url),'utf8').replace(/\r\n/g,'\n').replace(/^export /gm,'');
            s=s.replace('async function generate(opts) {',gate+"\nconst __naiGate=createNaiGate({notice:message=>toastr.info(message,'智库 · 生图排队')});\nfunction generate(opts){return __naiGate.run(()=>generateRequest(opts));}\nasync function generateRequest(opts) {");
            s=s.replace('throw new Error(explain(r.status, text, true))',"throw Object.assign(new Error(explain(r.status, text, true)),{status:r.status,retryAfter:r.headers?.get('Retry-After')})");
            s=s.replace('throw new Error(explain(r.status, new TextDecoder().decode(buf)))',"throw Object.assign(new Error(explain(r.status, new TextDecoder().decode(buf))),{status:r.status,retryAfter:r.headers?.get('Retry-After')})");
            s=s.replace('async function inpaint({ image, mask, prompt, negative, width, height, strength = 0.7 }) {','function inpaint(opts){return __naiGate.run(()=>inpaintRequest(opts));}\nasync function inpaintRequest({ image, mask, prompt, negative, width, height, strength = 0.7 }) {');
            s=s.replace('return { MODELS, SAMPLERS,', 'return { stopQueue:()=>__naiGate.stop(), MODELS, SAMPLERS,');
            s=s.replace('    cleanups.push(() => __mod_marker.stop());','    cleanups.push(() => {__mod_marker.stop();__mod_nai.stopQueue();});');
        }
        s=s.replace("b.title = '智库：识别这一楼的文生图标记';", "b.title = '智库：请在对应提示词旁点击生成';");
        s=s.replace('const onUserRendered = id => { onRendered(id); setTimeout(() => { void __mod_marker.process(Number(id)); }, 0); };','const onUserRendered = id => { onRendered(id); };');
        s=s.replace('const onEdited = id => { onRendered(id); setTimeout(() => { void __mod_marker.process(Number(id)); }, 0); };','const onEdited = id => { onRendered(id); };');
        s=s.replace(', [event_types.GENERATION_ENDED, () => { const id=SillyTavern.getContext().chat.length-1; setTimeout(() => { void __mod_marker.process(id); }, 0); }]','');

        s=s.replace(/context:\(\)=>SillyTavern\.getContext\(\),getData:__mod_store\.getData,(?:document:DOC,)*/, 'context:()=>SillyTavern.getContext(),getData:__mod_store.getData,document:DOC,');
        s=s.replace('    setTimeout(() => __mod_marker.refresh(), 0);\n    setTimeout(() => __mod_marker.refresh(), 0);','    setTimeout(() => __mod_marker.refresh(), 0);');
        s=s.replace('<span class="pc-menu-picture" aria-hidden="true">🖼️</span>', '<i class="fa-solid fa-image fa-fw" aria-hidden="true"></i>');
        s=s.replaceAll('🖼️ 开启标记自动生图','开启标记自动生图');
        s=s.replace("      ${sw('markerAuto', '识别完整标记后自动生图', '直接使用标记内的提示词，不额外调用聊天 AI')}\n", '');
        s=s.replace("<h2 class=\"pc-pagetitle\">设置</h2>${nai}${ai}${tpl}${chat}", "<h2 class=\"pc-pagetitle\">设置</h2><div class=\"pc-marker-primary\" style=\"padding:16px;margin-bottom:16px;border-radius:14px;background:var(--SmartThemeBlurTintColor,rgba(128,128,128,.12))\">${sw('markerAuto', '开启标记自动生图', '默认开启 · 回复出现完整生图标记时自动生成，提示词默认折叠')}</div>${chat}${nai}${ai}${tpl}");

        if(!s.includes('__mod_marker.decorateAll();'))s=s.replace('function addMesButtons() {','function addMesButtons() {\n    __mod_marker.decorateAll();');
        if(!s.includes('__mod_marker.refresh();'))s=s.replace('    __mod_marker.syncRegex();','    __mod_marker.syncRegex();\n    setTimeout(() => __mod_marker.refresh(), 0);');
        s=s.replace('<span class="pc-menu-seal"></span><span>智库</span>', '<i class="fa-solid fa-image fa-fw" aria-hidden="true"></i><span>智库</span>');
        if(!s.includes('pc-marker-ui-style'))s=s.replace('    injectCss();',`    injectCss();
    const markerStyle=DOC.createElement('style');markerStyle.id='pc-marker-ui-style';
    markerStyle.textContent='.pc-marker-slot{display:flex;align-items:flex-start;gap:10px;flex-wrap:wrap;margin:10px 0;padding:12px;border-radius:12px;background:var(--SmartThemeBlurTintColor,rgba(0,0,0,.15));border:1px solid var(--SmartThemeBorderColor,rgba(128,128,128,.35))}.pc-marker-slot details{flex:1;min-width:120px}.pc-marker-slot summary{cursor:pointer;font-size:14px}.pc-marker-slot pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:220px;overflow:auto;font-size:13px;margin:10px 0 0;scrollbar-width:none}.pc-marker-slot pre::-webkit-scrollbar{display:none}.pc-marker-generate{cursor:pointer;padding:6px 12px;border-radius:8px;color:inherit;background:var(--SmartThemeBlurTintColor,transparent);border:1px solid var(--SmartThemeBorderColor,#888);font:inherit}.pc-marker-generate:disabled{opacity:.6;cursor:wait}#pc-menu-btn .pc-menu-picture{display:inline-flex;align-items:center;justify-content:center;font-size:22px;width:26px;line-height:1}';
    DOC.head.appendChild(markerStyle);cleanups.push(()=>markerStyle.remove());`);
        if(!s.includes('pc-compact-image-style'))s=s.replace('    injectCss();', "    injectCss();\n    const compactStyle=DOC.createElement('style');compactStyle.id='pc-compact-image-style';compactStyle.textContent=\".mes_text .pc-marker-slot{display:flex;gap:8px;margin:6px 0;padding:4px 8px;border-radius:6px;width:fit-content;max-width:100%;font-size:12px;line-height:1.5}.mes_text .pc-marker-slot summary,.mes_text .pc-image-actions summary{font-size:12px;cursor:pointer}.mes_text .pc-marker-generate,.mes_text .pc-image-actions button{font-size:12px;line-height:1.5;padding:3px 8px;min-height:28px;width:auto;margin:0}.mes_text .pc-marker-slot pre,.mes_text .pc-image-actions pre{font:12px/1.5 sans-serif;white-space:pre-wrap;overflow-wrap:anywhere;max-height:140px;overflow:auto;scrollbar-width:none}.mes_text .pc-image-actions pre::-webkit-scrollbar{display:none}.mes_text .pc-chat-img{display:block;max-width:min(100%,360px);max-height:480px;object-fit:contain;cursor:zoom-in}.pc-image-actions{display:flex;align-items:start;gap:8px;flex-wrap:wrap;margin:4px 0 8px}.pc-image-actions details{max-width:100%}.pc-image-preview{position:fixed;inset:0;z-index:40000;background:rgba(0,0,0,.85);display:flex;align-items:center;justify-content:center}.pc-image-preview img{max-width:95vw;max-height:90vh;object-fit:contain}.pc-image-preview button{position:absolute;right:16px;top:16px;padding:8px 16px}\";DOC.head.append(compactStyle);cleanups.push(()=>compactStyle.remove());");
        const referenceCss=fs.readFileSync(new URL('../src/marker-ui.css',import.meta.url),'utf8').replace(/\r\n/g,'\n');
        if(!s.includes('/* reference-marker-ui */'))s=s.replace('    DOC.head.appendChild(markerStyle);', '    /* reference-marker-ui */ markerStyle.textContent += '+JSON.stringify(referenceCss)+';\n    DOC.head.appendChild(markerStyle);');
        return s;
    }
    const logic=fs.readFileSync(new URL('../src/marker-generation.js',import.meta.url),'utf8').replace(/\r\n/g,'\n').replace(/^export /gm,'');
    if(source.includes('const MARKER_REGEX_ID =')) {
        const start=source.indexOf('// Marker-triggered generation');
        const end=source.indexOf('const __mod_marker=',start);
        assert(start>=0&&end>start);
        return presentation(source.slice(0,start)+logic+'\n'+source.slice(end));
    }
    let s=source;
    function patch(a,b){assert.equal(s.split(a).length,2,a.slice(0,90));s=s.replace(a,()=>b);}
    patch('const __mod_ui = (() => {',logic+`\nconst __mod_marker=createMarkerController({
        context:()=>SillyTavern.getContext(),getData:__mod_store.getData,
        generate:async prompt=>{
            const d=__mod_store.getData();
            const {positive,negative}=__mod_engine.composeStudio({pos:__mod_model.mergeTags(d.active?__mod_model.ticketString(d,d.active):'',prompt),neg:[d.active?__mod_model.ticketNeg(d,d.active):'',d.options.chatNegative||''].filter(Boolean).join(', ')});
            // 出场角色绑定的角色参考优先；没有就用全局在用的那组
            const bound=[...new Set(__mod_chars.currentCast().filter(x=>x.on).map(x=>x.char.charRef).filter(id=>id&&d.charRefGroups?.[id]))];
            const image=await __mod_engine.generateFull({positive,negative,director:bound.length?await __mod_engine.charRefs(bound):undefined});
            __mod_engine.afterChatImage();
            return image;
        },
        upload:__mod_store.uploadImage,notify:(message,level)=>toastr[level]?.(message,'智库 · 标记生图')
    });\nconst __mod_ui = (() => {`);
    const start=s.indexOf("    const chat = setFold('chat', '聊天里生图'");
    const end=s.indexOf("    const entry = setFold('entry'",start);
    assert(start>0&&end>start);
    patch(s.slice(start,end),`    const marker=__mod_marker.settings();
    const chat = setFold('chat', '文生图标记', marker.auto ? '识别标记后自动生成' : '手动识别标记', \`
      <div class="pc-hint" style="margin-top:0">用开始与结束标记包住提示词，例如 <code>\${esc(marker.start)}1boy, solo, sunset\${esc(marker.end)}</code>。只生成标记里的画面，图片放在原位置；没有标记的回复不生图。</div>
      \${sw('markerAuto', '识别完整标记后自动生图', '直接使用标记内的提示词，不额外调用聊天 AI')}
      <label class="pc-field"><span>开始标记（前缀）</span><input data-optstr="imageStartTag" value="\${esc(marker.start)}" placeholder="image###"></label>
      <label class="pc-field"><span>结束标记</span><input data-optstr="imageEndTag" value="\${esc(marker.end)}" placeholder="###"></label>
      <div class="pc-hint">已内置「智库 · 生图标记不发送」正则：过滤发送给聊天模型的生图标记，不影响生图读取。修改标记时自动同步。</div>
      <label class="pc-field"><span>标记生图额外负面词</span><input data-optstr="chatNegative" value="\${esc(d.options.chatNegative || '')}"></label>\`);

`);
    patch("if (el.dataset.optstr) { d.options[el.dataset.optstr] = el.value.trim(); commit({ silent: true }); return; }", "if (el.dataset.optstr) { d.options[el.dataset.optstr] = el.value.trim(); if (['imageStartTag','imageEndTag'].includes(el.dataset.optstr)) __mod_marker.syncRegex(); commit({ silent: true }); return; }");
    // Migrate only the trigger preference; never infer per-floor generation from legacy autoChatGen.
    patch('    await loadData();','    await loadData();\n    if (getData().options.markerAuto === undefined) getData().options.markerAuto = true;\n    __mod_marker.syncRegex();\n    cleanups.push(() => __mod_marker.stop());');
    const genStart=s.indexOf('async function genFor(mesId) {');
    const genEnd=s.indexOf('\nfunction onChatClick',genStart);
    patch(s.slice(genStart,genEnd),'async function genFor(mesId) { await __mod_marker.process(mesId, { manual: true }); }\n');
    patch("b.title = '智库：给这一楼生图';", "b.title = '智库：识别这一楼的文生图标记';");
    patch('        if (getData().options.autoChatGen) setTimeout(() => genFor(Number(id)), 300);','        setTimeout(() => { void __mod_marker.process(Number(id)); }, 0);');
    patch('    const onRendered = id => { setTimeout(addMesButtons, 50); };', '    const onRendered = id => { setTimeout(addMesButtons, 50); };\n    const onUserRendered = id => { onRendered(id); setTimeout(() => { void __mod_marker.process(Number(id)); }, 0); };\n    const onEdited = id => { onRendered(id); setTimeout(() => { void __mod_marker.process(Number(id)); }, 0); };');
    patch('[event_types.USER_MESSAGE_RENDERED, onRendered]', '[event_types.USER_MESSAGE_RENDERED, onUserRendered]');
    patch('[event_types.MESSAGE_UPDATED, onRendered]', '[event_types.MESSAGE_UPDATED, onEdited]');
    patch('[event_types.MORE_MESSAGES_LOADED, onRendered]', '[event_types.MORE_MESSAGES_LOADED, onRendered], [event_types.GENERATION_ENDED, () => { const id=SillyTavern.getContext().chat.length-1; setTimeout(() => { void __mod_marker.process(id); }, 0); }]');
    return presentation(s);
}
