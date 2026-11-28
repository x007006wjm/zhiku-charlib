import assert from 'node:assert/strict';
import { quotaUrlForSite, parseQuotaResponse, parseV5Usage } from '../src/quota.js';

// 1. 第三方站点 URL 推导
assert.equal(quotaUrlForSite('https://proxy.example.com'), 'https://proxy.example.com/user/subscription');
assert.equal(quotaUrlForSite('https://proxy.example.com/'), 'https://proxy.example.com/user/subscription');
assert.equal(quotaUrlForSite('https://proxy.example.com/ai/generate-image'), 'https://proxy.example.com/user/subscription');
assert.equal(quotaUrlForSite('https://proxy.example.com/v1/ai/generate-image'), 'https://proxy.example.com/v1/user/subscription');
assert.equal(quotaUrlForSite(''), '');

// 2. NovelAI 官方 / 酒馆响应（纯点数 + V5 滚动额度同时展示）
const p1 = parseQuotaResponse({ trainingStepsLeft: { fixedTrainingStepsLeft: 10000, purchasedTrainingSteps: 250 } });
assert.equal(p1.amount, 10250);
assert.equal(p1.label, '剩 10,250 点');

const p2 = parseQuotaResponse({
    trainingStepsLeft: { fixedTrainingStepsLeft: 500, purchasedTrainingSteps: 0 },
    usage: { percent: 84, purchasedPercent: 0, isNegative: false, timeUntilNextPercent: 900 },
});
assert.equal(p2.label, '剩 500 点 · V5 84%');
assert.equal(p2.detail, '约 15 分钟后 +1%');

const p3 = parseV5Usage({ usage: { percent: 12, purchasedPercent: 50, isNegative: false } });
assert.equal(p3.label, 'V5 12%+50%');

const p4 = parseV5Usage({ usage: { percent: 5, isNegative: true } });
assert.equal(p4.label, 'V5 -5%');

// 3. 常见第三方中转站响应
assert.equal(parseQuotaResponse({ balance: 123.45 }).label, '剩 123.45 点');
assert.equal(parseQuotaResponse({ data: { quota: 800 } }).label, '剩 800 点');
assert.equal(parseQuotaResponse({ anlas: '420' }).label, '剩 420 点');
assert.equal(parseQuotaResponse({ ok: true }), null);
assert.equal(parseQuotaResponse(null), null);

console.log('PASS: Quota URL derivation, Anlas/proxy balance, and V5 rolling usage parsing.');
