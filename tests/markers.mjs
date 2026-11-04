import assert from 'node:assert/strict';
import {createMarkerController,parseImageMarkers,MARKER_REGEX_ID,CHAR_BLOCK_DISPLAY_ID} from '../src/marker-generation.js';
assert.equal(parseImageMarkers('plain','image###','###').length,0);
assert.equal(parseImageMarkers('image###partial','image###','###').length,0);
assert.equal(parseImageMarkers('image###a\nb### image###b###','image###','###').length,2);
assert.equal(parseImageMarkers('<img>a.b</img>','<img>','</img>')[0].prompt,'a.b');
let count=0,active=0,peak=0,saves=0,block=null,fail=false;
const notices=[],data={options:{}};
const msg={mes:'before image###sunset### middle image###sea### after',swipe_id:0,swipes:[]};msg.swipes=[msg.mes];
const c={chat:[msg],chatId:'one',extensionSettings:{'st-chatu8':{startTag:'image###',endTag:'###'},regex:[{id:'unrelated'}]},saveSettingsDebounced(){},async saveChat(){saves++;},updateMessageBlock(){}};
const controller=createMarkerController({context:()=>c,getData:()=>data,generate:async prompt=>{count++;active++;peak=Math.max(peak,active);try{if(block)await block;if(fail)throw Error('test backend failure');return 'data:image/png;base64,test';}finally{active--;}},upload:async()=>({url:'/user/images/test.png'}),notify:(...a)=>notices.push(a)});
controller.syncRegex();controller.syncRegex();
assert.equal(c.extensionSettings.regex.length,4);
let rule=c.extensionSettings.regex.find(r=>r.id===MARKER_REGEX_ID);
assert(rule.promptOnly&&!rule.markdownOnly&&!rule.runOnEdit);assert.deepEqual(rule.placement,[1,2]);
assert(rule.findRegex.includes('<(?:人物|外貌变化)>'),'不发送规则要含角色块');
const blockRule=c.extensionSettings.regex.find(r=>r.id===CHAR_BLOCK_DISPLAY_ID);
assert(blockRule&&blockRule.markdownOnly&&!blockRule.promptOnly,'角色块折叠规则');
assert.equal('x <人物>\n名字: 甲\n</人物> y <外貌变化>\n名字: 甲\n</外貌变化> z'.replace(new RegExp(rule.findRegex.slice(1,-2),'g'),''),'x  y  z');
const regex=()=>new RegExp(rule.findRegex.slice(1,-2),'g');
assert.equal(msg.mes.replace(regex(),''),'before  middle  after');
assert(msg.mes.includes('image###'),'filter must not mutate message');
assert.equal('a <img src="/u/x.png" alt="画师库生成" class="pc-chat-img"> b <img src="/u/y.png" alt="画师库生成"> c <img src="keep.png">'.replace(regex(),''),'a  b  c <img src="keep.png">');
await Promise.all([controller.process(0),controller.process(0)]);
assert.equal(count,2);assert.equal(peak,1);assert.equal(saves,2);assert.equal(msg.swipes[0],msg.mes);
assert.equal(Object.keys(msg.extra.zhikuImages).length,2);assert.equal(msg.mes,'before image###sunset### middle image###sea### after');
await controller.process(0);assert.equal(count,2);
msg.mes='image###retry###';fail=true;await controller.process(0);await controller.process(0);assert.equal(count,3);
fail=false;await controller.process(0,{manual:true});assert.equal(count,4);
msg.mes='image###switch###';let release;block=new Promise(r=>release=r);
const pending=controller.process(0);await Promise.resolve();c.chatId='two';release();await pending;assert.equal(msg.mes,'image###switch###');block=null;
data.options.imageStartTag='[draw:';data.options.imageEndTag=']';controller.syncRegex();rule=c.extensionSettings.regex.find(r=>r.id===MARKER_REGEX_ID);
assert.equal('text [draw:sunset] tail'.replace(regex(),''),'text  tail');
data.options.markerAuto=false;msg.mes='[draw:off]';const before=count;await controller.process(0);assert.equal(count,before);
await controller.process(0,{manual:true});assert.equal(count,before+1);
const priorSave=c.saveChat;c.saveChat=async()=>{throw Error('save failed');};msg.mes='[draw:save-failure]';
const oldRecords=JSON.stringify(msg.extra.zhikuImages);await controller.process(0,{manual:true});
assert.equal(JSON.stringify(msg.extra.zhikuImages),oldRecords);assert.equal(msg.mes,'[draw:save-failure]');c.saveChat=priorSave;
const countBeforeStop=count;
controller.stop();msg.mes='[draw:stopped]';await controller.process(0,{manual:true});assert.equal(count,countBeforeStop);
console.log('PASS: exact/custom/multiline markers, prompt-only filter, deduplication, serial queue, separate image records, preserved message/swipe text, failure retry, chat switch protection, auto toggle and stop.');

// ───────── 角色外观库：$名字$ 展开 / 别名 / 宏 ─────────
import {CHAR_ALIAS_SPLIT,splitAliases,charAliasText,characterNames,fixedTagsOf,expandCharacterRefs,charactersMacroText} from '../src/char-expand.js';
import {installCharMacro,CHAR_MACRO_NAME} from '../src/char-macro.js';

const onna={name:'小雪',aliases:['Shirley',' 小雪 '],appearance:[{en:'1girl'},{en:'long silver hair'}],outfitMode:'fixed',outfits:[{id:'o1',name:'白裙',tags:[{en:'white dress'}]}],outfitId:'o1'};
const adel={name:'阿黛尔',aliases:'Adele|德妹',appearance:[{en:'1girl'},{en:'blue eyes'}],outfitMode:'story',outfits:[{id:'o2',tags:[{en:'red coat'}]}],outfitId:'o2'};
const legacy={name:'老角色',appearance:[{en:'1boy'}]};
const cast=[{key:'char:x',on:true,char:onna}];

// 别名解析与正名去重
assert.deepEqual(splitAliases('a|b, c、d；e\nf'),['a','b','c','d','e','f']);
assert.deepEqual(characterNames(onna),['小雪','Shirley']);
assert.equal(charAliasText(onna),'Shirley');
assert.equal(fixedTagsOf(onna),'1girl, long silver hair, white dress');
assert.equal(fixedTagsOf(adel),'1girl, blue eyes');
assert.equal(fixedTagsOf(legacy),'1boy');

// 1) 出场角色展开；2) 大小写不敏感别名；3) 固定衣服带上、跟剧情的衣服不带；4) 未知名字变纯文本并写日志
assert.equal(expandCharacterRefs('$小雪$, cafe',{cast,characters:[onna,adel]}),'1girl, long silver hair, white dress, cafe');
assert.equal(expandCharacterRefs('$SHIRLEY$, cafe',{cast,characters:[onna,adel]}),'1girl, long silver hair, white dress, cafe');
assert.equal(expandCharacterRefs('$阿黛尔$',{cast,characters:[onna,adel]}),'1girl, blue eyes');
assert.equal(expandCharacterRefs('$Adele$',{cast,characters:[onna,adel]}),'1girl, blue eyes');
const logs=[];
assert.equal(expandCharacterRefs('a $路人甲$ b',{cast,characters:[onna],log:m=>logs.push(m)}),'a 路人甲 b');
assert.equal(logs.length,1);assert(logs[0].includes('路人甲'));
// 出场角色优先于同名的已保存角色
const dup={name:'小雪',appearance:[{en:'1girl'},{en:'short black hair'}]};
assert.equal(expandCharacterRefs('$小雪$',{cast,characters:[dup]}),'1girl, long silver hair, white dress');
// 5) 开关关闭时 $ 原样保留
assert.equal(expandCharacterRefs('$小雪$',{cast,characters:[onna],enabled:false}),'$小雪$');

// 6) 控制器：展开发生在 generate 之前，消息原文不变，记录里存展开后的 prompt
const expanded=[];
const charData={options:{markerCharExpand:true}};
const charMsg={mes:'image###$小雪$, sunset###',swipe_id:0,swipes:[]};charMsg.swipes=[charMsg.mes];
const charCtx={chat:[charMsg],chatId:'char',extensionSettings:{regex:[]},saveSettingsDebounced(){},async saveChat(){},updateMessageBlock(){}};
const expand=prompt=>expandCharacterRefs(prompt,{cast,characters:[onna,adel],enabled:charData.options.markerCharExpand!==false,log(){}});
const charCtrl=createMarkerController({context:()=>charCtx,getData:()=>charData,expandPrompt:expand,generate:async p=>{expanded.push(p);return 'data:image/png;base64,test';},upload:async()=>({url:'/user/images/char.png'}),notify(){}});
await charCtrl.process(0,{manual:true});
assert.deepEqual(expanded,['1girl, long silver hair, white dress, sunset']);
assert.equal(charMsg.mes,'image###$小雪$, sunset###');
const record=Object.values(charMsg.extra.zhikuImages)[0];
assert.equal(record.prompt,'1girl, long silver hair, white dress, sunset');
charData.options.markerCharExpand=false;charMsg.mes='image###$小雪$###';charMsg.swipes[0]=charMsg.mes;
await charCtrl.process(0,{manual:true});
assert.deepEqual(expanded[1],'$小雪$');
charCtrl.stop();

// 7) 世界书宏的内容
assert.equal(charactersMacroText(cast),'- 小雪（别名：Shirley）[固定服装]');
assert.equal(charactersMacroText([{on:false,char:onna}]),'');
assert.equal(charactersMacroText([]),'');

// 8) 宏注册 / 停止时注销（有 unregisterMacro 与没有两种宿主）
let registered=null,unregistered=null,calls=0;
const host={registerMacro(name,fn){registered=[name,fn];},unregisterMacro(name){unregistered=name;}};
const macro=installCharMacro(host,{text:()=>{calls++;return '- 小雪: 写 $小雪$';}});
assert.equal(macro.supported,true);assert.equal(registered[0],CHAR_MACRO_NAME);
assert.equal(registered[1](),'- 小雪: 写 $小雪$');assert.equal(calls,1);
macro.uninstall();
assert.equal(unregistered,CHAR_MACRO_NAME);
assert.equal(registered[1](),'','stop 后宏返回空串');
assert.equal(calls,1);
let registered2=null;
const host2={registerMacro(name,fn){registered2=fn;}};
const macro2=installCharMacro(host2,{text:()=>'X'});
assert.equal(registered2(),'X');macro2.uninstall();assert.equal(registered2(),'');
assert.equal(installCharMacro({},{text:()=>'X',log(){}}).supported,false);
console.log('PASS: character $name$ expansion (cast first, aliases case-insensitive, fixed outfit only, unknown kept as text, toggle off), stored prompt expanded, macro text and install/uninstall.');

