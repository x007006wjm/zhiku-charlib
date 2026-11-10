import assert from 'node:assert/strict';
import {createMarkerController} from '../src/marker-generation.js';

// 极简 DOM 替身：只实现 decorate() 用到的部分
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
    fire(type) { for (const fn of this._ev[type] || []) fn(); }
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
            if (sel.includes('pc-chat-img')) return [];      // decorateImages
            if (sel.includes('.mes[mesid=')) return slots;   // 本楼标记槽
            return [];
        },
    };
    doc.addSlot = () => { const slot = new El('div'); slots.push(slot); return slot; };
    doc.clearSlots = () => { slots.length = 0; };
    return doc;
}

const panel = slot => slot.children.find(c => c.className === 'pc-result-collapse');
const summaryOf = slot => panel(slot)?.children[0];

function setup({expand} = {}) {
    const doc = makeDoc();
    // 0.8.36 自带「图片默认展开」（imageExpanded），默认是开的；
    // 这里关掉它，才能看出「刚生成的那张自动展开、历史图片仍旧收起」。
    const data = {options: {imageExpanded: false}};
    if (expand !== undefined) data.options.markerResultExpand = expand;
    const msg = {mes: 'a image###sunset### b', swipe_id: 0, swipes: []};
    msg.swipes = [msg.mes];
    const chat = {chat: [msg], chatId: 'one', extensionSettings: {}, saveSettingsDebounced() {}, async saveChat() {}, updateMessageBlock() {}};
    const controller = createMarkerController({
        context: () => chat,
        getData: () => data,
        generate: async () => 'data:image/png;base64,x',
        upload: async () => ({url: '/user/images/x.png'}),
        notify() {},
        document: doc,
    });
    return {doc, data, msg, controller};
}

// 1) 默认开启：刚生成完那张自动展开，标题显示「点击收起」
{
    const {doc, controller} = setup();
    const slot = doc.addSlot();
    await controller.process(0, {manual: true});
    assert.equal(controller.settings().expand, true, '默认开启自动展开');
    assert(panel(slot), '结果面板要渲染出来');
    assert.equal(panel(slot).open, true, '刚生成的图要自动展开');
    assert.equal(summaryOf(slot).textContent, '图片 · 点击折叠');
    // 2) 重新渲染（重开聊天）仍然收起
    doc.clearSlots();
    const fresh = doc.addSlot();
    controller.decorate(0);
    assert.equal(panel(fresh).open, false, '历史图片仍按收起显示');
    assert.equal(summaryOf(fresh).textContent, '图片 · 点击展开');
    // 3) 手动点开 / 收起时标题跟着变
    panel(fresh).open = true;
    panel(fresh).fire('toggle');
    assert.equal(summaryOf(fresh).textContent, '图片 · 点击折叠');
    panel(fresh).open = false;
    panel(fresh).fire('toggle');
    assert.equal(summaryOf(fresh).textContent, '图片 · 点击展开');
    controller.stop();
}

// 4) 关掉开关：生成完也不展开
{
    const {doc, controller} = setup({expand: false});
    const slot = doc.addSlot();
    await controller.process(0, {manual: true});
    assert.equal(controller.settings().expand, false);
    assert.equal(panel(slot).open, false, '关掉后不自动展开');
    assert.equal(summaryOf(slot).textContent, '图片 · 点击展开');
    controller.stop();
}

// 5) stop 会清掉「刚生成」标记：停用后重新挂载不应该再自动展开
{
    const doc = makeDoc();
    const data = {options: {imageExpanded: false}};
    const msg = {mes: 'image###x###', swipe_id: 0, swipes: []};
    msg.swipes = [msg.mes];
    const chat = {chat: [msg], chatId: 'one', extensionSettings: {}, saveSettingsDebounced() {}, async saveChat() {}, updateMessageBlock() {}};
    const controller = createMarkerController({
        context: () => chat, getData: () => data,
        generate: async () => 'data:image/png;base64,x',
        upload: async () => ({url: '/user/images/y.png'}),
        notify() {}, document: null,
    });
    await controller.process(0, {manual: true});
    controller.stop();
    const doc2 = makeDoc();
    const slot = doc2.addSlot();
    const restored = createMarkerController({
        context: () => chat, getData: () => data,
        generate: async () => '', upload: async () => ({url: ''}),
        notify() {}, document: doc2,
    });
    restored.decorate(0);
    assert.equal(panel(slot).open, false, 'stop 之后不再残留自动展开');
    restored.stop();
}

console.log('PASS: 生成后自动展开（默认开、只展开一次、历史图片收起、开关关闭、stop 清理）。');