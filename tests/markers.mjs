import assert from 'node:assert/strict';
import {createMarkerController,parseImageMarkers,MARKER_REGEX_ID} from '../src/marker-generation.js';
assert.equal(parseImageMarkers('plain','image###','###').length,0);
assert.equal(parseImageMarkers('image###partial','image###','###').length,0);
assert.equal(parseImageMarkers('image###a\nb### image###b###','image###','###').length,2);
assert.equal(parseImageMarkers('<img>a.b</img>','<img>','</img>')[0].prompt,'a.b');
let uploads=0,count=0,active=0,peak=0,saves=0,block=null,fail=false;
const notices=[],data={options:{}};
const msg={mes:'before image###sunset### middle image###sea### after',swipe_id:0,swipes:[]};msg.swipes=[msg.mes];
const c={chat:[msg],chatId:'one',extensionSettings:{'st-chatu8':{startTag:'image###',endTag:'###'},regex:[{id:'unrelated'}]},saveSettingsDebounced(){},async saveChat(){saves++;},updateMessageBlock(){}};
const controller=createMarkerController({context:()=>c,getData:()=>data,generate:async prompt=>{count++;active++;peak=Math.max(peak,active);try{if(block)await block;if(fail)throw Error('test backend failure');return 'data:image/png;base64,test';}finally{active--;}},upload:async()=>({url:'/user/images/test'+(++uploads)+'.png'}),notify:(...a)=>notices.push(a)});
controller.syncRegex();controller.syncRegex();
assert.equal(controller.settings().imageExpanded,true,'older data defaults to expanded images');
data.options.imageExpanded=false;
assert.equal(controller.settings().imageExpanded,false,'explicit collapsed preference survives');
data.options=JSON.parse(JSON.stringify(data.options));
assert.equal(controller.settings().imageExpanded,false,'collapsed preference survives serialization');
data.options.imageExpanded=true;
assert.equal(controller.settings().imageExpanded,true);
assert.equal(c.extensionSettings.regex.length,4,'3 marker rules plus the character-block fold rule');
let rule=c.extensionSettings.regex.find(r=>r.id===MARKER_REGEX_ID);
assert(rule.promptOnly&&!rule.markdownOnly&&!rule.runOnEdit);assert.deepEqual(rule.placement,[1,2]);
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
// 生成途中别的脚本在这一楼末尾加了状态栏：标记还在原位置，结果照样存
{const before=count;msg.mes='image###tail###';let go;block=new Promise(r=>go=r);
const job=controller.process(0);await Promise.resolve();msg.mes+='\n<status>HP 10</status>';go();await job;block=null;
assert.equal(count,before+1);assert(Object.keys(msg.extra.zhikuImages).some(k=>k.endsWith(':0:image###tail###')),'tail edit must keep the result');
// 标记前面被改、标记挪了位置：不存
msg.mes='image###moved###';block=new Promise(r=>go=r);const recs=Object.keys(msg.extra.zhikuImages).length;
const job2=controller.process(0);await Promise.resolve();msg.mes='new intro '+msg.mes;go();await job2;block=null;
assert.equal(Object.keys(msg.extra.zhikuImages).length,recs,'moved marker must not be saved');}
// 生成完以后，别的脚本在标记前面加了字（位置变了）：认得出已经生成过，不再请求
{const before=count;msg.mes='image###once###';await controller.process(0);assert.equal(count,before+1);
msg.mes='<status>开头加了状态栏</status>\n'+msg.mes;await controller.process(0);assert.equal(count,before+1,'shifted marker must not regenerate');
// 酒馆在生成途中把这一楼换成了新对象：同一张不会同时请求两次
msg.mes='image###twin###';let go;block=new Promise(r=>go=r);const first=controller.process(0);await Promise.resolve();
const clone={...msg,extra:{...msg.extra}};c.chat[0]=clone;const second=controller.process(0);go();await Promise.all([first,second]);block=null;
assert.equal(count,before+2,'replaced message object must not start a second request');c.chat[0]=msg;}
// 重新生成保留旧版本；删除只删当前这一版
{msg.mes='image###ver###';await controller.process(0);const k=()=>Object.keys(msg.extra.zhikuImages).find(x=>x.endsWith(':image###ver###'));
const firstUrl=msg.extra.zhikuImages[k()].url;await controller.process(0,{manual:true});const rec=msg.extra.zhikuImages[k()];
assert.equal(rec.versions.length,2,'regenerate must keep the old version');assert.equal(rec.versions[0].url,firstUrl);assert.notEqual(rec.url,firstUrl);
await controller.process(0,{manual:true});assert.equal(msg.extra.zhikuImages[k()].versions.length,3);}
data.options.imageStartTag='[draw:';data.options.imageEndTag=']';controller.syncRegex();rule=c.extensionSettings.regex.find(r=>r.id===MARKER_REGEX_ID);
assert.equal('text [draw:sunset] tail'.replace(regex(),''),'text  tail');
data.options.markerAuto=false;msg.mes='[draw:off]';const before=count;await controller.process(0);assert.equal(count,before);
await controller.process(0,{manual:true});assert.equal(count,before+1);
const priorSave=c.saveChat;c.saveChat=async()=>{throw Error('save failed');};msg.mes='[draw:save-failure]';
const oldRecords=JSON.stringify(msg.extra.zhikuImages);await controller.process(0,{manual:true});
assert.equal(JSON.stringify(msg.extra.zhikuImages),oldRecords);assert.equal(msg.mes,'[draw:save-failure]');c.saveChat=priorSave;
const countBeforeStop=count;
controller.stop();msg.mes='[draw:stopped]';await controller.process(0,{manual:true});assert.equal(count,countBeforeStop);
console.log('PASS: exact/custom/multiline markers, prompt-only filter, deduplication, serial queue, separate image records, preserved message/swipe text, edits after the marker keep results, no regeneration after shifts or object swaps, versions kept on regenerate, failure retry, chat switch protection, auto toggle and stop.');
