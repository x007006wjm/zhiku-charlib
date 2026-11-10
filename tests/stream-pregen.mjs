import assert from 'node:assert/strict';
import {createMarkerController} from '../src/marker-generation.js';

// 极简 DOM 替身（和 auto-expand.mjs 一样只做 decorate() 需要的那部分）
class El {
    constructor(tag) {
        this.tagName = String(tag).toUpperCase();
        this.children = [];
        this.dataset = {};
        this.attrs = {};
        this.textContent = '';
        this.className = '';
        this.open = false;
        this._ev = {};
        this.classList = {add: () => {}, remove: () => {}, contains: () => false};
    }
    append(...kids) { for (const k of kids) { k.parentNode = this; this.children.push(k); } }
    replaceChildren(...kids) { this.children = []; this.append(...kids); }
    addEventListener(type, fn) { (this._ev[type] ||= []).push(fn); }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    getAttribute(k) { return this.attrs[k] ?? null; }
    after() {}
    remove() {}
    focus() {}
    querySelector(sel) {
        const want = sel.replace(/^[^a-zA-Z]*/, '').toUpperCase();
        const walk = node => {
            for (const child of node.children) {
                if (child.tagName === want) return child;
                const hit = walk(child);
                if (hit) return hit;
            }
            return null;
        };
        return walk(this);
    }
    querySelectorAll() { return []; }
}

function makeDoc() {
    const slots = [];
    const doc = {
        body: new El('body'),
        createElement: tag => new El(tag),
        querySelectorAll(sel) {
            if (sel.includes('pc-chat-img')) return [];
            if (sel.includes('.mes[mesid=')) return slots;
            return [];
        },
    };
    doc.addSlot = () => { const slot = new El('div'); slots.push(slot); return slot; };
    doc.clearSlots = () => { slots.length = 0; };
    return doc;
}

/** 造一个"正在流"的聊天：最后一条助手消息是空的，流式缓冲由 getStreamingText 提供。 */
function setup({stream = true, reason = 'stream'} = {}) {
    const doc = makeDoc();
    const data = {options: {}};
    if (stream === false) data.options.markerStream = false;
    if (reason) data.options.markerReason = reason;
    const msg = {mes: '', swipe_id: 0, swipes: ['']};
    const chat = {
        chat: [msg], chatId: 'one', extensionSettings: {},
        saveSettingsDebounced() {}, async saveChat() {}, updateMessageBlock() {},
    };
    const state = {streaming: '', prompts: []};
    const controller = createMarkerController({
        context: () => chat,
        getData: () => data,
        generate: async (prompt) => { state.prompts.push(prompt); return 'data:image/png;base64,' + state.prompts.length; },
        upload: async () => ({url: '/user/images/x.png'}),
        notify() {},
        getStreamingText: () => state.streaming,
        document: doc,
    });
    return {doc, data, msg, chat, controller, state};
}

// 1) 标记还没写完整：不发请求
{
    const {controller, state} = setup();
    state.streaming = '正文 image###1boy, sun';
    await controller.pregenSweep();
    assert.equal(state.prompts.length, 0, '标记没闭合时不能发生图请求');
    assert.equal(controller.settings().stream, true, '流式预生成默认开启');
    controller.stop();
}

// 2) 标记一闭合：立刻生成（这时正文还没写完）
{
    const {controller, state} = setup();
    state.streaming = '正文 image###1boy, sunset### 后面还有字';
    await controller.pregenSweep();
    assert.equal(state.prompts.length, 1, '标记闭合后要先发一次生图请求');
    assert.equal(state.prompts[0], '1boy, sunset', '发给 NovelAI 的是标记里的提示词');
    // 再扫一次不能重复请求
    await controller.pregenSweep();
    assert.equal(state.prompts.length, 1, '同一标记只预生成一次');
    controller.stop();
}

// 3) 消息最终落地：复用预生成结果，不再请求第二次
{
    const {controller, state, msg} = setup();
    state.streaming = '正文 image###1boy, sunset### 后面还有字';
    await controller.pregenSweep();
    assert.equal(state.prompts.length, 1);
    await controller.idle();
    // 正文写完，消息落地（标记位置和流式时一致）
    msg.mes = '正文 image###1boy, sunset### 后面还有字';
    msg.swipes[0] = msg.mes;
    const saved = await controller.process(0);
    assert.equal(saved, 1, '消息落地后要把图写进记录');
    assert.equal(state.prompts.length, 1, '已经预生成过的不能再请求一次');
    assert.equal(msg.extra.zhikuImages[Object.keys(msg.extra.zhikuImages)[0]].url, '/user/images/x.png');
    controller.stop();
}

// 4) 关掉开关：流式阶段什么都不做，等消息落地再生成
{
    const {controller, state, msg} = setup({stream: false});
    state.streaming = '正文 image###1boy, sunset###';
    await controller.pregenSweep();
    assert.equal(state.prompts.length, 0, '关掉流式预生成后不能提前发请求');
    msg.mes = '正文 image###1boy, sunset###';
    msg.swipes[0] = msg.mes;
    await controller.process(0);
    assert.equal(state.prompts.length, 1, '关掉后按原来的时机生成');
    controller.stop();
}

// 5) 预生成结果在重新生成时作废
{
    const {controller, state, msg} = setup();
    state.streaming = 'image###a cat###';
    await controller.pregenSweep();
    assert.equal(state.prompts.length, 1);
    controller.pregenReset();
    msg.mes = 'image###a cat###';
    msg.swipes[0] = msg.mes;
    await controller.process(0);
    assert.equal(state.prompts.length, 2, '重置之后要重新请求');
    controller.stop();
}

// 6) 用户手滑改了下标记：按原文对不上就不复用
{
    const {controller, state, msg} = setup();
    state.streaming = 'image###a cat###';
    await controller.pregenSweep();
    await controller.idle();
    msg.mes = 'image###a dog###';
    msg.swipes[0] = msg.mes;
    await controller.process(0);
    assert.equal(state.prompts.length, 2, '标记内容变了要重新生成，不能拿旧图');
    assert.equal(state.prompts[1], 'a dog');
    controller.stop();
}


// 7) 流式阶段这条消息还没进 chat：照样先出图，落地时对得上
{
    const doc = makeDoc();
    const data = {options: {}};
    const chat = {chat: [], chatId: 'one', extensionSettings: {}, is_send_press: true,
        saveSettingsDebounced() {}, async saveChat() {}, updateMessageBlock() {}};
    let prompts = 0;
    const state = {text: '正文 image###1boy, sunset###'};
    const controller = createMarkerController({
        context: () => chat, getData: () => data,
        generate: async () => { prompts++; return 'data:image/png;base64,z'; },
        upload: async () => ({url: '/user/images/z.png'}), notify() {},
        getStreamingText: () => state.text, document: doc,
    });
    await controller.pregenSweep();
    assert.equal(prompts, 1, '消息还没入 chat 时也要先出图');
    await controller.idle();
    const msg = {mes: '正文 image###1boy, sunset###', swipe_id: 0, swipes: []};
    msg.swipes = [msg.mes];
    chat.chat.push(msg);
    chat.is_send_press = false;
    const saved = await controller.process(0);
    assert.equal(saved, 1, '落地后要写记录');
    assert.equal(prompts, 1, '落地不能重复请求');
    controller.stop();
}

console.log('PASS: 流式预生成（未闭合不请求、闭合即请求、落地复用、开关关闭、重置、标记变化不复用、消息未入 chat）。');
