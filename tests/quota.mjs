import assert from 'node:assert/strict';
import { quotaUrlForSite, parseQuotaResponse } from '../src/quota.js';

// 1. 第三方站点 URL 推导
assert.equal(quotaUrlForSite('https://proxy.example.com'), 'https://proxy.example.com/user/subscription');
assert.equal(quotaUrlForSite('https://proxy.example.com/'), 'https://proxy.example.com/user/subscription');
assert.equal(quotaUrlForSite('https://proxy.example.com/ai/generate-image'), 'https://proxy.example.com/user/subscription');
assert.equal(quotaUrlForSite('https://proxy.example.com/v1/ai/generate-image'), 'https://proxy.example.com/v1/user/subscription');
assert.equal(quotaUrlForSite(''), '');

// 2. NovelAI 官方 / 酒馆响应
assert.deepEqual(
    parseQuotaResponse({ trainingStepsLeft: { fixedTrainingStepsLeft: 10000, purchasedTrainingSteps: 250 } }),
    { amount: 10250, label: '剩 10,250 点' },
);
assert.deepEqual(
    parseQuotaResponse({ subscription: { trainingStepsLeft: { fixedTrainingStepsLeft: 500, purchasedTrainingSteps: 0 } } }),
    { amount: 500, label: '剩 500 点' },
);

// 3. 常见第三方中转站响应
assert.deepEqual(parseQuotaResponse({ balance: 123.45 }), { amount: 123.45, label: '剩 123.45 点' });
assert.deepEqual(parseQuotaResponse({ data: { quota: 800 } }), { amount: 800, label: '剩 800 点' });
assert.deepEqual(parseQuotaResponse({ anlas: '420' }), { amount: 420, label: '剩 420 点' });
assert.equal(parseQuotaResponse({ ok: true }), null);
assert.equal(parseQuotaResponse(null), null);

console.log('PASS: Quota URL derivation and Anlas/proxy balance parsing.');
