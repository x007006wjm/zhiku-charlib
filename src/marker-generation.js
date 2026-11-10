// Marker-triggered generation and prompt-only filtering. No chat LLM request.
// 智库插进楼层的图片（<img class="pc-chat-img"> / alt="画师库生成"）也不发给聊天 AI
export const CHAT_IMG_PATTERN='<img\\b[^>]*(?:pc-chat-img|画师库生成)[^>]*>';
export const MARKER_REGEX_ID = '72c57f73-46af-46ac-a28e-bf31b131332a';
export const MARKER_DISPLAY_ID = '6ba93a8e-cabb-494c-a7e8-6c9dfcf5fb80';
export const CHAR_BLOCK_DISPLAY_ID = 'a7c1d9b4-2f5e-4c6a-9d31-8b0f4e2a5c77';
export const CHAR_BLOCK_RE_SOURCE = '<(?:人物|外貌变化)>[\\s\\S]*?<\\/(?:人物|外貌变化)>';
export function escapeMarker(value) { return value.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&'); }
export function markerPattern(start, end) { return escapeMarker(start) + '[\\s\\S]*?' + escapeMarker(end); }
export function parseImageMarkers(text, start, end) {
    if (!start || !end) return [];
    const result=[];
    const regex=new RegExp(escapeMarker(start)+'([\\s\\S]*?)'+escapeMarker(end),'g');
    for (const m of String(text || '').matchAll(regex)) {
        const prompt=m[1].trim();
        if (prompt) result.push({raw:m[0],prompt,index:m.index});
    }
    return result;
}
export function createMarkerController({context,getData,generate,upload,notify,expandPrompt,getStreamingText,document:doc=globalThis.document}) {
    let queue=Promise.resolve(), stopped=false;
    const pending=new WeakMap(), failed=new WeakMap();
    // 这次刚生成出来的记录：只自动展开一次，重新打开聊天时仍按收起显示
    const freshResults=new Set();
    const imageBindings=new WeakSet(), overlays=new Set(), holds=new Set();
    function settings() {
        const opts=getData().options;
        const old=context().extensionSettings['st-chatu8'] || {};
        return {
            start: String(opts.imageStartTag ?? old.startTag ?? 'image###'),
            end: String(opts.imageEndTag ?? old.endTag ?? '###'),
            auto: opts.markerAuto !== false,
            // 生成完自动展开结果图（关掉就退回「点一下才展开」）
            expand: opts.markerResultExpand !== false,
            // 流式预生成：回复还在流、标记一成型就先发生图请求
            stream: opts.markerStream !== false,
        };
    }
    function syncRegex() {
        const c=context(), {start,end}=settings();
        const block='(?:'+CHAR_BLOCK_RE_SOURCE+')';
        const rule={id:MARKER_REGEX_ID,scriptName:'智库 · 生图标记不发送',findRegex:'/'+(start&&end?'(?:'+markerPattern(start,end)+')|':'')+block+'|'+CHAT_IMG_PATTERN+'/g',replaceString:'',trimStrings:[],placement:[1,2],disabled:false,markdownOnly:false,promptOnly:true,runOnEdit:false,substituteRegex:0,minDepth:null,maxDepth:null};
        const rules=c.extensionSettings.regex ||= [];
        const display={...rule,id:MARKER_DISPLAY_ID,scriptName:'智库 · 生图标记折叠',findRegex:start&&end?'/'+escapeMarker(start)+'(?!\\s*'+escapeMarker(end)+')[\\s\\S]*?'+escapeMarker(end)+'/g':'/(?!)/g',markdownOnly:true,promptOnly:false,replaceString:'<div class="pc-marker-slot"><details><summary>图片提示词</summary></details><button type="button" class="pc-marker-generate">生成图片</button></div>'};
        const charBlock={...rule,id:CHAR_BLOCK_DISPLAY_ID,scriptName:'智库 · 角色档案折叠',findRegex:'/'+block+'/g',markdownOnly:true,promptOnly:false,replaceString:'<div class="pc-marker-slot pc-char-slot"><details><summary>角色档案</summary><pre>$&</pre></details></div>'};
        let changed=false;
        for(const item of [rule,display,charBlock]) {
            const index=rules.findIndex(r=>r.id===item.id);
            if(index>=0 && JSON.stringify(rules[index])===JSON.stringify(item))continue;
            if(index<0)rules.push(item);else rules[index]=item;
            changed=true;
        }
        if(changed)c.saveSettingsDebounced();
    }
    /**
     * 取出流式阶段的成果并删掉它（只能取一次）。
     * 先按「聊天|楼层|记录键」精确找；流式文本与落地文本偶尔会有细微出入（多一个空格、
     * 标记位置挪了），这时退一步按标记原文找同一楼的那条，别让已经生成好的图白扔。
     */
    function takePregen(id,msg,token){
        if(!pregen.size)return null;
        const chatId=chatKey(context()),floor=Number(id),slot=pregenSlot(chatId,floor,msg,token);
        let hitKey=pregen.has(slot)?slot:null;
        if(!hitKey){
            for(const [k,entry] of pregen){
                if(entry.floor===floor&&entry.chat===chatId&&entry.raw===token.raw){hitKey=k;break;}
            }
        }
        if(!hitKey)return null;
        const entry=pregen.get(hitKey);
        pregen.delete(hitKey);
        return entry;
    }
    function state(msg,token){return pending.get(msg)?.get(recordKey(msg,token))?.state;}
    function label(msg,token,record){return state(msg,token)|| (failed.get(msg)?.has(recordKey(msg,token))?'重试生成':record?.url?'重新生成':'生成图片');}
    function decorate(id) {
        if(!doc || stopped)return;
        const cfg=settings(),msg=context().chat?.[id];
        if(!msg)return;
        decorateImages(id,msg);
        const tokens=parseImageMarkers(msg.mes,cfg.start,cfg.end);
        const slots=doc.querySelectorAll(`.mes[mesid="${Number(id)}"] .mes_text :is(.pc-marker-slot,.custom-pc-marker-slot)`);
        slots.forEach((slot,index)=>{
            slot.classList.add('pc-marker-slot');
            const token=tokens[index];if(!token)return;
            const record=msg.extra?.zhikuImages?.[recordKey(msg,token)];
            const ready=token.raw+'|'+(record?.url||'');
            if(slot.dataset.pcReady===ready) { const b=slot.querySelector('button');if(b){b.disabled=!!state(msg,token);b.textContent=label(msg,token,record);}return; }
            slot.dataset.pcReady=ready;
            slot.replaceChildren();
            const details=doc.createElement('details'),summary=doc.createElement('summary'),pre=doc.createElement('pre'),button=doc.createElement('button');
            summary.textContent='图片提示词';pre.textContent=token.prompt;
            details.append(summary,pre);button.type='button';button.className='pc-marker-generate';button.title='点击生成，长按编辑提示词';
            button.disabled=!!state(msg,token);button.textContent=label(msg,token,record);
            button.addEventListener('click',ev=>{ev.preventDefault();ev.stopPropagation();if(button._pcHeld)return;void process(Number(id),{manual:true,tokenIndex:index});});
            slot.append(details,button);
            const edit=()=>editPrompt(id,msg,token,index);
            bindHold(button,edit);
            if(record?.url){
                const wrapper=doc.createElement('details');wrapper.className='pc-result-collapse';
                const header=doc.createElement('summary');
                const img=doc.createElement('img');img.src=record.url;img.className='pc-result-image';img.alt='生成图片';
                wrapper.append(header,img);slot.append(wrapper);
                // 「生成后自动展开」：只对这次刚生成的那张生效，历史图片仍旧收起
                const fresh=freshResults.delete(recordKey(msg,token)),autoOpen=cfg.expand&&fresh;
                const syncHeader=()=>{header.textContent=wrapper.open?'图片 · 点击收起':'图片 · 点击展开';};
                if(autoOpen)wrapper.open=true;
                syncHeader();wrapper.addEventListener('toggle',syncHeader);
                img.addEventListener('click',ev=>{ev.preventDefault();ev.stopPropagation();if(!img._pcHeld)preview(id,msg,token,index,record);});
                bindHold(img,edit);
                button.textContent=label(msg,token,record);
            }

        });
    }
    function recordKey(msg,token){return String(msg.swipe_id??0)+':'+token.index+':'+token.raw;}

    // ───────── 流式预生成 ─────────
    // 回复还在流的时候标记就已经完整出现，这里先把这张图生成掉；
    // 等消息真正落地时，process() 发现这条记录已在手上，就直接复用，不再等。
    // 按「聊天|楼层|标记」存，不按消息对象：宿主落地时可能换掉那个对象，按对象存会对不上、白生成一次。
    const pregen=new Map();          // "chat|floor|swipe:index:raw" -> {state,job,token,image,prompt,error}
    function pregenSlot(chat,floor,msg,token){return chat+'|'+floor+'|'+recordKey(msg,token);}
    /** 流式文本里已经闭合的标记（未闭合的不管：那时提示词还没写完） */
    function closedMarkers(text,cfg){return parseImageMarkers(text,cfg.start,cfg.end);}
    function streamBuffer(){return typeof getStreamingText==='function'?String(getStreamingText()||''):'';}
    function pregenReset(){pregen.clear();}
    /** 没人来取（生成被打断、消息没落地）的结果不会一直堆着：超过 8 条就丢最早的「已经跑完的」那些，在跑的留着 */
    function pregenPrune(){
        if(pregen.size<=8)return;
        for(const [slot,entry] of pregen){
            if(pregen.size<=8)break;
            if(!entry.job)pregen.delete(slot);
        }
    }
    async function pregenSweep(){
        if(stopped)return 0;
        const cfg=settings();
        if(!cfg.auto||!cfg.stream)return 0;
        const text=streamBuffer();
        if(!text.includes(cfg.start))return 0;
        const c=context(),chat=c.chat,msg=chat?.[chat.length-1];
        if(!msg||msg.is_system||msg.is_user)return 0;
        const tokens=closedMarkers(text,cfg);
        if(!tokens.length)return 0;
        const chatId=chatKey(c),floor=chat.length-1;
        let fired=0;
        for(const token of tokens){
            const key=recordKey(msg,token),slot=pregenSlot(chatId,floor,msg,token);
            if(pregen.has(slot))continue;
            if(msg.extra?.zhikuImages?.[key])continue;
            if(failed.get(msg)?.has(key))continue;
            const entry={state:'预生成中…',job:null,token,raw:token.raw,key,floor,chat:chatId};
            pregen.set(slot,entry);
            entry.job=queue.then(async()=>{
                if(stopped)return 0;
                entry.state='生成中…';
                const meta={msgId:floor,key,swipe:msg.swipe_id,pos:token.index};
                const resolved=typeof expandPrompt==='function'?expandPrompt(token.prompt,meta):token.prompt;
                const prompt=resolved&&typeof resolved==='object'&&resolved.text!==undefined?String(resolved.text):String(resolved??token.prompt);
                const recordPrompt=resolved&&typeof resolved==='object'&&resolved.record!==undefined?String(resolved.record):prompt;
                entry.prompt=recordPrompt;
                entry.image=await generate(prompt,meta);
                return 1;
            }).catch(error=>{entry.error=error?.message||String(error);return 0;})
              .finally(()=>{entry.job=null;});
            queue=entry.job.catch(()=>{});
            pregenPrune();
            fired++;
        }
        return fired;
    }
    function bindHold(el,action){
        let timer=null,start=null;
        const cancel=()=>{if(timer!==null){clearTimeout(timer);holds.delete(timer);timer=null;}};
        el.addEventListener('pointerdown',ev=>{if(ev.button!=null&&ev.button!==0)return;cancel();el._pcHeld=false;start=[ev.clientX,ev.clientY];timer=setTimeout(()=>{holds.delete(timer);timer=null;el._pcHeld=true;if(!stopped)action();},500);holds.add(timer);});
        el.addEventListener('pointermove',ev=>{if(start&&Math.hypot(ev.clientX-start[0],ev.clientY-start[1])>10)cancel();});
        for(const name of ['pointerup','pointercancel','pointerleave'])el.addEventListener(name,cancel);
        el.addEventListener('contextmenu',ev=>{ev.preventDefault();ev.stopPropagation();cancel();el._pcHeld=true;action();});
    }
    function dialog(){const back=doc.createElement('div'),box=doc.createElement('div'),close=doc.createElement('button');back.className='pc-image-preview';box.className='pc-image-dialog';close.type='button';close.textContent='关闭';box.append(close);back.append(box);doc.body.append(back);overlays.add(back);const dismiss=()=>{back.remove();overlays.delete(back);};close.onclick=dismiss;back.onclick=e=>{if(e.target===back)dismiss();};return {box,dismiss};}
    async function deleteResult(id,msg,token){
        if(pending.has(msg))throw new Error('请等本楼生成结束');
        if(context().chat?.[id]!==msg)throw new Error('聊天已变化，请重新操作');
        const records=msg.extra?.zhikuImages,key=recordKey(msg,token),old=records?.[key];
        if(!old)return;
        records[key]={deleted:true};
        try{await context().saveChat();}catch(e){records[key]=old;throw e;}
        decorate(id);
    }
    function preview(id,msg,token,index,record){
        const {box,dismiss}=dialog(),img=doc.createElement('img'),download=doc.createElement('a'),edit=doc.createElement('button'),remove=doc.createElement('button');
        img.src=record.url;download.href=record.url;download.download='image.png';download.textContent='下载';edit.type=remove.type='button';edit.textContent='编辑 / 重新生成';remove.textContent='删除当前图片';
        edit.onclick=()=>{dismiss();editPrompt(id,msg,token,index);};
        remove.onclick=async()=>{try{await deleteResult(id,msg,token);dismiss();}catch(e){notify(e.message,'error');}};
        box.append(img,download,edit,remove);
    }
    function editPrompt(id,msg,token,index){
        const source=msg.mes,swipe=msg.swipe_id,{box,dismiss}=dialog(),input=doc.createElement('textarea'),send=doc.createElement('button'),remove=doc.createElement('button');
        input.value=token.prompt;input.rows=6;send.type=remove.type='button';send.textContent='生成图片';remove.textContent='删除当前图片';
        send.onclick=async()=>{
            if(pending.has(msg))return;
            if(context().chat?.[id]!==msg||msg.mes!==source||msg.swipe_id!==swipe){notify('消息已变化，请重新打开编辑','info');return;}
            const prompt=input.value.trim();if(!prompt)return;
            // Keep the original marker and attach the edited prompt to the generated result.
            dismiss();await process(id,{manual:true,tokenIndex:index,promptOverride:prompt});
        };
        const record=msg.extra?.zhikuImages?.[recordKey(msg,token)];if(record?.prompt)input.value=record.prompt;
        remove.disabled=!record;
        remove.onclick=async()=>{try{await deleteResult(id,msg,token);dismiss();}catch(e){notify(e.message,'error');}};
        box.append(input,send,remove);
    }
    function decorateImages(id,msg) {
        for(const img of doc.querySelectorAll(`.mes[mesid="${Number(id)}"] .mes_text img:is(.pc-chat-img,.custom-pc-chat-img)`)) {
            img.classList.add('pc-chat-img');
            if(imageBindings.has(img))continue;
            imageBindings.add(img);
            const bar=doc.createElement('div');bar.className='pc-image-actions';
            const view=doc.createElement('button'),remove=doc.createElement('button');
            view.type=remove.type='button';view.textContent='查看';remove.textContent='删除图片';
            const open=()=>{
                const overlay=doc.createElement('div');overlay.className='pc-image-preview';
                const picture=doc.createElement('img'),close=doc.createElement('button');
                picture.src=img.src;close.type='button';close.textContent='关闭';
                overlay.append(picture,close);doc.body.append(overlay);overlays.add(overlay);
                const dismiss=()=>{overlay.remove();overlays.delete(overlay);};
                close.onclick=dismiss;overlay.onclick=e=>{if(e.target===overlay)dismiss();};
            };
            view.onclick=open;img.addEventListener('click',e=>{e.preventDefault();e.stopPropagation();open();});
            remove.onclick=async()=>{
                if(pending.has(msg)){notify('请等本楼生成结束后再删除图片','info');return;}
                if(context().chat?.[id]!==msg)return;
                const source=String(msg.mes),swipe=msg.swipe_id;
                const tags=[...source.matchAll(/<img\b[^>]*>/g)];
                const tag=tags.find(m=>{const holder=doc.createElement('div');holder.innerHTML=m[0];const el=holder.firstElementChild;return el?.getAttribute('src')===img.getAttribute('src') && /(?:^| )pc-chat-img(?: |$)/.test(el.className);});
                if(!tag)return;
                let raw='';try{raw=decodeURIComponent(img.getAttribute('data-pc-marker')||'');}catch{}
                const next=source.slice(0,tag.index)+raw+source.slice(tag.index+tag[0].length);
                const swipes=Array.isArray(msg.swipes)&&Number.isInteger(swipe)?msg.swipes:null,oldSwipe=swipes?.[swipe];
                msg.mes=next;if(swipes)swipes[swipe]=next;
                try {await context().saveChat();context().updateMessageBlock(id,msg);decorate(id);}
                catch(e){msg.mes=source;if(swipes)swipes[swipe]=oldSwipe;notify(e.message||String(e),'error');}
            };
            img.addEventListener('contextmenu',e=>{e.preventDefault();bar.hidden=false;remove.focus();});
            bar.append(view,remove);
            let raw='';try{raw=decodeURIComponent(img.getAttribute('data-pc-marker')||'');}catch{}
            if(raw){const details=doc.createElement('details'),summary=doc.createElement('summary'),pre=doc.createElement('pre');summary.textContent='图片提示词';pre.textContent=parseImageMarkers(raw,settings().start,settings().end)[0]?.prompt||raw;details.append(summary,pre);bar.prepend(details);}
            img.after(bar);
        }
    }
    function decorateAll() { if(doc)for(const el of doc.querySelectorAll('.mes[mesid]'))decorate(Number(el.getAttribute('mesid'))); }
    function refresh() {
        if(!doc || stopped)return;
        const cfg=settings();
        for(const el of doc.querySelectorAll('.mes[mesid]')) {
            const id=Number(el.getAttribute('mesid')),msg=context().chat?.[id];
            if(msg && parseImageMarkers(msg.mes,cfg.start,cfg.end).length)context().updateMessageBlock(id,msg);
        }
        decorateAll();
    }
    const chatKey=c=>String(c.getCurrentChatId?.() ?? c.chatId ?? '')+'|'+String(c.characterId ?? '')+'|'+String(c.groupId ?? '');
    async function process(id,{manual=false,tokenIndex=null,promptOverride=null}={}) {
        const c=context(),msg=c.chat?.[id],cfg=settings();
        if(stopped||!msg||msg.is_system||(!manual&&(!cfg.auto||msg.is_user)))return 0;
        const source=String(msg.mes||''),swipe=msg.swipe_id,chat=chatKey(c),all=parseImageMarkers(source,cfg.start,cfg.end);
        if(manual&&tokenIndex===null&&all.length>1){notify('请点击具体提示词旁的生成按钮，一次只生成所选图片','info');decorate(id);return 0;}
        const selected=tokenIndex===null?all:all.filter((_,i)=>i===tokenIndex);
        if(!selected.length){if(manual)notify('没有完整生图标记','info');return 0;}
        const jobs=selected.map(token=>{
            const key=recordKey(msg,token);let map=pending.get(msg);
            if(map?.has(key))return map.get(key).job;
            if(!manual&&(msg.extra?.zhikuImages?.[key]||failed.get(msg)?.has(key)))return Promise.resolve(0);
            if(!map){map=new Map();pending.set(msg,map);}
            const entry={state:'排队中…',job:null};map.set(key,entry);
            const current=()=>!stopped&&chatKey(context())===chat&&context().chat?.[id]===msg&&msg.swipe_id===swipe&&String(msg.mes||'')===source;
            // 流式阶段已经生成过的：等它落地就直接上传写记录，省掉整段等待。
            const ready=takePregen(id,msg,token);
            const job=(ready?.job||ready?.image||ready?.error?Promise.resolve(0):queue).then(async()=>{
                if(!current())return 0;
                entry.state=ready?'保存中…':'生成中…';decorate(id);
                try {
                    // $名字$ / JSON 标记在发给 NovelAI 之前处理（带上本楼楼层号与本标记在消息里的起始位置：本聊天库按楼层重放，<外貌变化> 按位置生效）；消息原文不动。
                    // expandPrompt 可以返回字符串，也可以返回 { text, record }（JSON 标记用：text 是原 JSON，record 是可读提示词）。
                    const rawPrompt=promptOverride??msg.extra?.zhikuImages?.[key]?.prompt??token.prompt;
                    const markerMeta={msgId:Number(id),key,swipe,pos:token.index};
                    const resolved=typeof expandPrompt==='function'?expandPrompt(rawPrompt,markerMeta):rawPrompt;
                    const prompt=resolved&&typeof resolved==='object'&&resolved.text!==undefined?String(resolved.text):String(resolved??rawPrompt);
                    const recordPrompt=resolved&&typeof resolved==='object'&&resolved.record!==undefined?String(resolved.record):prompt;
                    let image;
                    if(ready?.image!==undefined&&!promptOverride){image=ready.image;}
                    else {
                        if(ready?.job)await ready.job.catch(()=>{});
                        if(ready?.image!==undefined&&!promptOverride){image=ready.image;}
                        else {image=await generate(prompt,markerMeta);}
                    }
                    if(!current())return 0;
                    entry.state='保存中…';decorate(id);
                    const {url}=await upload(image,'marker_'+Date.now());if(!current())return 0;
                    if(!url)throw new Error('图片上传未返回地址');
                    const hadExtra=!!msg.extra;msg.extra ||= {};const hadRecords=!!msg.extra.zhikuImages,records=msg.extra.zhikuImages ||= {},old=records[key];records[key]={url:String(url),prompt:recordPrompt};
                    try{await c.saveChat();}catch(e){if(old)records[key]=old;else delete records[key];if(!hadRecords&&!Object.keys(records).length)delete msg.extra.zhikuImages;if(!hadExtra&&!Object.keys(msg.extra).length)delete msg.extra;throw e;}
                    failed.get(msg)?.delete(key);freshResults.add(key);return 1;
                }catch(e){let errors=failed.get(msg);if(!errors){errors=new Set();failed.set(msg,errors);}errors.add(key);notify(e.message||String(e),'error');return 0;}
            }).finally(()=>{map.delete(key);if(!map.size)pending.delete(msg);if(current())decorate(id);});
            entry.job=job;queue=job.catch(()=>{});return job;
        });
        decorate(id);return (await Promise.all(jobs)).reduce((a,b)=>a+b,0);
    }
    return {settings,syncRegex,process,decorate,decorateAll,refresh,pregenSweep,pregenReset,
        stop(){stopped=true;freshResults.clear();pregenReset();for(const timer of holds)clearTimeout(timer);holds.clear();for(const el of overlays)el.remove();overlays.clear();if(doc)doc.querySelectorAll('.pc-image-actions').forEach(el=>el.remove());},
        idle(){return queue;}};
}
