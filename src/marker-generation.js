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
// Preserve identities when new markers are inserted before existing, possibly identical markers.
export function shiftImageRecords(records, tokens, swipe, shifts) {
    if(!records)return records;
    const next={...records},prefix=String(swipe??0)+':',used=new Set(),moves=[];
    for(const token of tokens){
        const exact=prefix+token.index+':'+token.raw;
        const candidates=Object.keys(records).filter(k=>k.startsWith(prefix)&&k.endsWith(':'+token.raw)&&/^\d+$/.test(k.slice(prefix.length,k.length-token.raw.length-1))).sort((a,b)=>parseInt(a.slice(prefix.length))-parseInt(b.slice(prefix.length)));
        const old=records[exact]&&!used.has(exact)?exact:candidates.find(k=>!used.has(k));
        if(!old)continue;used.add(old);
        const index=token.index+shifts.filter(s=>s.at<=token.index).reduce((sum,s)=>sum+s.length,0);
        moves.push([old,prefix+index+':'+token.raw]);
    }
    for(const [old]of moves)delete next[old];
    for(const [old,key]of moves)next[key]=records[old];
    return next;
}
export function createMarkerController({context,getData,generate,upload,notify,expandPrompt,getStreamingText,document:doc=globalThis.document,resolveUrl=u=>u}) {
    // 图存在本地浏览器时地址是 idb:xxx，要先换成能显示的地址；换不出来（存在别的设备上）就是空的
    function showUrl(url,apply,missing){Promise.resolve(resolveUrl(url)).then(u=>{if(u)apply(u);else missing?.();},()=>missing?.());}
    let queue=Promise.resolve(), stopped=false;
    const pending=new WeakMap(), failed=new WeakMap();
    const imageBindings=new WeakSet(), overlays=new Set(), holds=new Set(), inflight=new Set(), keepOpen=new Set();
    // 这次刚生成出来的记录：只自动展开一次，重新打开聊天时仍按收起显示
    const freshResults=new Set();
    // 流式预生成：chat|floor|swipe:index:raw -> {state,job,token,image,prompt,error,floor,chat}
    const pregen=new Map();
    function settings() {
        const opts=getData().options;
        const old=context().extensionSettings['st-chatu8'] || {};
        return {
            start: String(opts.imageStartTag ?? old.startTag ?? 'image###'),
            end: String(opts.imageEndTag ?? old.endTag ?? '###'),
            auto: opts.markerAuto !== false,
            imageExpanded: opts.imageExpanded !== false,
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
        // 角色档案块（<人物> / <外貌变化>）既不发给聊天模型，也在正文里折起来
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
            const record=findRecord(msg,token);
            const ready=token.raw+'|'+(record?.url||'');
            if(slot.dataset.pcReady===ready) { const b=slot.querySelector('button');if(b){b.disabled=!!state(msg,token);b.textContent=label(msg,token,record);}return; }
            slot.dataset.pcReady=ready;
            slot.replaceChildren();
            const details=doc.createElement('details'),summary=doc.createElement('summary'),pre=doc.createElement('pre'),button=doc.createElement('button');
            const effectivePrompt=record?.prompt??token.prompt;
            const plan=effectivePrompt===token.prompt?msg.extra?.zhikuIllustrations?.find(item=>item.raw===token.raw)?.plan:undefined;
            summary.textContent=plan?.title?'画面方案 · '+plan.title:'图片提示词';
            pre.textContent=(plan?`瞬间：${plan.moment}\n原句：${plan.source}\n分级：${plan.rating}\n\n`:'')+effectivePrompt;
            details.append(summary,pre);button.type='button';button.className='pc-marker-generate';button.title='点击生成，长按编辑提示词';
            button.disabled=!!state(msg,token);button.textContent=label(msg,token,record);
            button.addEventListener('click',ev=>{ev.preventDefault();ev.stopPropagation();if(button._pcHeld)return;void process(Number(id),{manual:true,tokenIndex:index});});
            slot.append(details,button);
            const edit=()=>editPrompt(id,msg,token,index);
            bindHold(button,edit);
            if(record?.url){
                const wrapper=doc.createElement('details');wrapper.className='pc-result-collapse';
                wrapper.open=cfg.imageExpanded;
                // 「生成后自动展开」：只对这次刚生成的那张生效，历史图片仍按默认显示
                const fresh=freshResults.delete(recordKey(msg,token));
                if(cfg.expand&&fresh)wrapper.open=true;
                const header=doc.createElement('summary');
                let imageTitle='图片',imageMissing=false;
                const syncTitle=()=>{if(!imageMissing)header.textContent=imageTitle+(wrapper.open?' · 点击折叠':' · 点击展开');};
                wrapper.addEventListener('toggle',syncTitle);
                const img=doc.createElement('img');img.className='pc-result-image';img.alt='生成图片';
                showUrl(record.url,u=>{img.src=u;},()=>{imageMissing=true;header.textContent='这张图存在别的设备 / 浏览器里，这里看不到，可以点「重新生成」';img.remove();});
                wrapper.append(header,img);slot.append(wrapper);
                const vs=Array.isArray(record.versions)?record.versions:[];
                if(vs.length>1){
                    const cur=Math.max(0,vs.findIndex(v=>v.url===record.url));
                    imageTitle=`图片 · 第 ${cur+1}/${vs.length} 版`;
                    const nav=doc.createElement('div');nav.className='pc-version-nav';
                    const step=(text,to)=>{const b=doc.createElement('button');b.type='button';b.textContent=text;b.disabled=!vs[to];
                        b.addEventListener('click',ev=>{ev.preventDefault();ev.stopPropagation();void switchVersion(id,msg,token,to);});return b;};
                    const n=doc.createElement('span');n.textContent=`${cur+1} / ${vs.length}`;
                    nav.append(step('‹ 上一版',cur-1),n,step('下一版 ›',cur+1));wrapper.append(nav);
                }
                if(keepOpen.delete(id+'|'+token.index))wrapper.open=true;
                syncTitle();
                img.addEventListener('click',ev=>{ev.preventDefault();ev.stopPropagation();if(!img._pcHeld)preview(id,msg,token,index,record);});
                bindHold(img,edit);
                button.textContent=label(msg,token,record);
            }

        });
    }
    function recordKey(msg,token){return String(msg.swipe_id??0)+':'+token.index+':'+token.raw;}
    // ───────── 流式预生成 ─────────
    // 回复还在流的时候标记就已经完整出现，这里先把这张图生成掉；
    // 等消息真正落地时 process() 发现这条记录已经在手上，就直接复用，不再等。
    // 按「聊天|楼层|标记」存，不按消息对象：宿主落地时可能换掉那个对象，按对象存会对不上、白生成一次。
    function pregenSlot(chat,floor,msg,token){return chat+'|'+floor+'|'+recordKey(msg,token);}
    /** 流式文本里已经闭合的标记（没闭合的不管：那时提示词还没写完） */
    function closedMarkers(text,cfg){return parseImageMarkers(text,cfg.start,cfg.end);}
    function streamBuffer(){return typeof getStreamingText==='function'?String(getStreamingText()||''):'';}
    function pregenReset(){pregen.clear();}
    /** 没人来取（被打断、消息没落地）的结果不会一直堆着：超过 8 条就丢掉已经跑完的那些，在跑的留着 */
    function pregenPrune(){
        if(pregen.size<=8)return;
        for(const [slot,entry] of pregen){
            if(pregen.size<=8)break;
            if(!entry.job)pregen.delete(slot);
        }
    }
    /** 把这一楼所有生图标记从正文里删掉，给结构化分镜当原句证据（算法与 process 里一致） */
    function storyOf(source,all){
        let story=source;
        for(const marker of [...all].reverse())story=story.slice(0,marker.index)+story.slice(marker.index+marker.raw.length);
        return story;
    }
    /** 提示词展开：expandPrompt 可以返回字符串，也可以返回 { text, record }（record 是可读版本，存进记录） */
    function resolvePrompt(rawPrompt,meta){
        const resolved=typeof expandPrompt==='function'?expandPrompt(rawPrompt,meta):rawPrompt;
        const prompt=resolved&&typeof resolved==='object'&&resolved.text!==undefined?String(resolved.text):String(resolved??rawPrompt);
        const record=resolved&&typeof resolved==='object'&&resolved.record!==undefined?String(resolved.record):prompt;
        return {prompt,record};
    }
    async function pregenSweep(){
        if(stopped)return 0;
        const cfg=settings();
        if(!cfg.auto||!cfg.stream)return 0;
        const text=streamBuffer();
        if(!text.includes(cfg.start))return 0;
        const c=context(),chat=c.chat||[];
        // 流式阶段这条助手消息有时还没进 chat：它会落在 chat.length 这个位置，先按占位对象算好键，
        // 等它真正出现时记录键（swipe 0 + 标记下标 + 标记原文）与楼层都对得上，这张图就不会白生成。
        let floor=chat.length-1,msg=chat[floor];
        if(msg&&msg.is_system)return 0;
        if(!msg||msg.is_user){
            const generating=c.is_send_press||c.generating||c.streamingProcessor?.isStreaming;
            if(!generating)return 0;
            floor=chat.length;msg={swipe_id:0,mes:''};
        }
        const tokens=closedMarkers(text,cfg);
        if(!tokens.length)return 0;
        const chatId=chatKey(c);
        const story=storyOf(text,tokens);
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
                const meta={msgId:floor,floor,key,swipe:msg.swipe_id,pos:token.index};
                const resolved=resolvePrompt(token.prompt,meta);
                entry.prompt=resolved.record;
                entry.image=await generate(resolved.prompt,{...meta,story});
                return 1;
            }).catch(error=>{entry.error=error?.message||String(error);return 0;})
              .finally(()=>{entry.job=null;});
            queue=entry.job.catch(()=>{});
            pregenPrune();
            fired++;
        }
        return fired;
    }
    /**
     * 取出流式阶段的成果并删掉它（只能取一次）。
     * 先按「聊天|楼层|记录键」精确找；流式文本与落地文本偶尔有细微出入（多一个空格、标记位置挪了），
     * 这时退一步按标记原文找同一楼的那条，别让已经生成好的图白扔。
     */
    function takePregen(id,msg,token){
        if(!pregen.size)return null;
        const chatId=chatKey(context()),floor=Number(id),slot=pregenSlot(chatId,floor,msg,token);
        let hit=pregen.has(slot)?slot:null;
        if(!hit){
            for(const [k,entry] of pregen){
                if(entry.floor===floor&&entry.chat===chatId&&entry.raw===token.raw){hit=k;break;}
            }
        }
        if(!hit)return null;
        const entry=pregen.get(hit);
        pregen.delete(hit);
        return entry;
    }
    // 已经存的结果按「swipe + 标记原文」找：标记前面的文字被别的脚本改过、位置挪了，也认得出是同一张，不会再生成一次
    function findRecordKey(msg,token){
        const recs=msg.extra?.zhikuImages;if(!recs)return '';
        const exact=recordKey(msg,token);if(recs[exact])return exact;
        const pre=String(msg.swipe_id??0)+':',suf=':'+token.raw;
        const keys=Object.keys(recs).filter(k=>k.startsWith(pre)&&k.endsWith(suf)&&/^\d+$/.test(k.slice(pre.length,k.length-suf.length)))
            .sort((a,b)=>parseInt(a.slice(pre.length))-parseInt(b.slice(pre.length)));
        if(!keys.length)return '';
        // 同一段标记出现好几次时，按第几次出现对上
        const same=parseImageMarkers(String(msg.mes||''),settings().start,settings().end).filter(t=>t.raw===token.raw);
        return keys[Math.max(0,same.findIndex(t=>t.index===token.index))]||keys[0];
    }
    function findRecord(msg,token){const k=findRecordKey(msg,token);return k?msg.extra.zhikuImages[k]:undefined;}
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
        const records=msg.extra?.zhikuImages,key=findRecordKey(msg,token)||recordKey(msg,token),old=records?.[key];
        if(!old)return;
        // 有别的版本就只删当前这张，换到剩下的最后一张
        const rest=(old.versions||[]).filter(v=>v.url!==old.url);
        records[key]=rest.length?{...old,url:rest[rest.length-1].url,prompt:rest[rest.length-1].prompt,versions:rest}:{deleted:true};
        try{await context().saveChat();}catch(e){records[key]=old;throw e;}
        decorate(id);
    }
    async function switchVersion(id,msg,token,to){
        if(context().chat?.[id]!==msg)return;
        const k=findRecordKey(msg,token),rec=k?msg.extra.zhikuImages[k]:null,v=rec?.versions?.[to];
        if(!v)return;
        const was={url:rec.url,prompt:rec.prompt};rec.url=v.url;rec.prompt=v.prompt;keepOpen.add(id+'|'+token.index);
        try{await context().saveChat();}catch(e){Object.assign(rec,was);notify(e.message||String(e),'error');}
        decorate(id);
    }
    function preview(id,msg,token,index,record){
        const {box,dismiss}=dialog(),img=doc.createElement('img'),download=doc.createElement('a'),edit=doc.createElement('button'),remove=doc.createElement('button');
        showUrl(record.url,u=>{img.src=u;download.href=u;});download.download='image.png';download.textContent='下载';edit.type=remove.type='button';edit.textContent='编辑 / 重新生成';remove.textContent='删除当前图片';
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
        const record=findRecord(msg,token);if(record?.prompt)input.value=record.prompt;
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
    function applyImageDefault() {
        if(!doc || stopped)return;
        const open=settings().imageExpanded;
        for(const el of doc.querySelectorAll('.mes_text .pc-marker-slot .pc-result-collapse'))el.open=open;
    }
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
    async function process(id,{manual=false,tokenIndex=null,tokenIndices=null,promptOverride=null}={}) {
        const c=context(),msg=c.chat?.[id],cfg=settings();
        if(stopped||!msg||msg.is_system||(!manual&&(!cfg.auto||msg.is_user)))return 0;
        const source=String(msg.mes||''),swipe=msg.swipe_id,chat=chatKey(c),all=parseImageMarkers(source,cfg.start,cfg.end);
        if(manual&&tokenIndex===null&&!Array.isArray(tokenIndices)&&all.length>1){notify('请点击具体提示词旁的生成按钮，一次只生成所选图片','info');decorate(id);return 0;}
        const selected=Array.isArray(tokenIndices)?all.filter((_,i)=>tokenIndices.includes(i)):tokenIndex===null?all:all.filter((_,i)=>i===tokenIndex);
        if(!selected.length){if(manual)notify('没有完整生图标记','info');return 0;}
        const jobs=selected.map(token=>{
            const key=recordKey(msg,token);let map=pending.get(msg);
            if(map?.has(key))return map.get(key).job;
            if(!manual&&(findRecord(msg,token)||failed.get(msg)?.has(key)))return Promise.resolve(0);
            // 酒馆把这一楼换成了新对象（重新加载、别的脚本改楼层）时，上面按对象记的排队查不到：再按楼层记一份，同一张不会同时生成两次
            const flight=chat+'|'+id+'|'+swipe+'|'+token.index+'|'+token.raw;
            if(inflight.has(flight))return Promise.resolve(0);
            // 流式阶段可能已经先生成好了这张图：取出来直接用，不再排一次队
            const ready=takePregen(id,msg,token);
            if(!map){map=new Map();pending.set(msg,map);}
            const entry={state:'排队中…',job:null};map.set(key,entry);inflight.add(flight);
            // 别的脚本改了这一楼其他地方（状态栏、正则）不算变：只要这个标记还在原位置，结果照样存
            const current=()=>!stopped&&chatKey(context())===chat&&context().chat?.[id]===msg&&msg.swipe_id===swipe&&String(msg.mes||'').slice(token.index,token.index+token.raw.length)===token.raw;
            // 预生成已出图 / 正在生成 / 报过错，都不用再排队；只有都没有时才从队尾开始
            const wait=ready?Promise.resolve(0):queue;
            const job=wait.then(async()=>{
                if(!current())return 0;
                entry.state=ready?.image!==undefined?'保存中…':'生成中…';decorate(id);
                try {
                    const rawPrompt=promptOverride??findRecord(msg,token)?.prompt??token.prompt;
                    const meta={msgId:Number(id),floor:Number(id),key,swipe,pos:token.index};
                    const resolved=resolvePrompt(rawPrompt,meta);
                    const prompt=resolved.prompt,recordPrompt=resolved.record;
                    // Story is only evidence for a structured shot's source quote, never a cast lookup.
                    let story=source;
                    for(const marker of [...all].reverse())story=story.slice(0,marker.index)+story.slice(marker.index+marker.raw.length);
                    if(ready?.job)await ready.job.catch(()=>{});
                    if(!current())return 0;
                    // 预生成已经给了图就直接用；只有用户在编辑框里改了提示词才重新生成
                    const reuse=ready?.image!==undefined&&!promptOverride;
                    const image=reuse?ready.image:await generate(prompt,{...meta,story});
                    if(!current())return 0;
                    entry.state='保存中…';decorate(id);
                    const {url}=await upload(image,'marker_'+Date.now());if(!current())return 0;
                    if(!url)throw new Error('图片上传未返回地址');
                    const hadExtra=!!msg.extra;msg.extra ||= {};const hadRecords=!!msg.extra.zhikuImages,records=msg.extra.zhikuImages ||= {},old=records[key];
                    // 重新生成不覆盖：以前的版本留着，可以翻回去（最多 10 个）
                    const prevKey=findRecordKey(msg,token),prev=prevKey&&records[prevKey]?.url?records[prevKey]:null;
                    const versions=[...(prev?.versions||(prev?[{url:prev.url,prompt:prev.prompt}]:[])),{url:String(url),prompt:recordPrompt}].slice(-10);
                    records[key]={url:String(url),prompt:recordPrompt,versions};
                    try{await c.saveChat();}catch(e){if(old)records[key]=old;else delete records[key];if(!hadRecords&&!Object.keys(records).length)delete msg.extra.zhikuImages;if(!hadExtra&&!Object.keys(msg.extra).length)delete msg.extra;throw e;}
                    failed.get(msg)?.delete(key);
                    freshResults.add(key);return 1;
                }catch(e){let errors=failed.get(msg);if(!errors){errors=new Set();failed.set(msg,errors);}errors.add(key);notify(e.message||String(e),'error');return 0;}
            }).finally(()=>{inflight.delete(flight);map.delete(key);if(!map.size)pending.delete(msg);if(!stopped&&chatKey(context())===chat)decorate(id);});
            entry.job=job;queue=job.catch(()=>{});return job;
        });
        decorate(id);return (await Promise.all(jobs)).reduce((a,b)=>a+b,0);
    }
    return {settings,syncRegex,process,decorate,decorateAll,refresh,applyImageDefault,pregenSweep,pregenReset,stop(){stopped=true;freshResults.clear();pregenReset();for(const timer of holds)clearTimeout(timer);holds.clear();for(const el of overlays)el.remove();overlays.clear();if(doc)doc.querySelectorAll('.pc-image-actions').forEach(el=>el.remove());},idle(){return queue;}};
}