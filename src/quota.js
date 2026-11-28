// 剩余额度（Anlas / 中转站点数）URL 推导与响应解析。
// 支持 NovelAI 官方 /user/subscription、酒馆 /api/novelai/status，以及常见第三方中转站余额字段。

/** 从第三方站点地址推导 /user/subscription 查询地址。 */
export function quotaUrlForSite(siteUrl) {
    const raw = String(siteUrl || '').trim().replace(/\/+$/, '');
    if (!raw) return '';
    // 去掉常见的生图路径后缀，得到站点根路径
    const base = raw
        .replace(/\/ai\/generate-image(?:-stream)?$/i, '')
        .replace(/\/generate-image$/i, '')
        .replace(/\/user\/subscription$/i, '');
    return base + '/user/subscription';
}

function finiteNumber(v) {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && v.trim() !== '') {
        const n = Number(v.trim());
        if (Number.isFinite(n)) return n;
    }
    return null;
}

/** 从接口 JSON 中解析剩余额度，返回 { amount, label } 或 null。 */
export function parseQuotaResponse(json) {
    if (!json || typeof json !== 'object') return null;
    const t = json.trainingStepsLeft || json.subscription?.trainingStepsLeft || json.data?.trainingStepsLeft;
    if (t && typeof t === 'object') {
        const fixed = finiteNumber(t.fixedTrainingStepsLeft) ?? 0;
        const purchased = finiteNumber(t.purchasedTrainingSteps) ?? 0;
        const total = fixed + purchased;
        return { amount: total, label: `剩 ${Math.round(total).toLocaleString()} 点` };
    }
    const candidates = [
        json.anlas, json.balance, json.quota, json.remaining, json.credits, json.points,
        json.data?.anlas, json.data?.balance, json.data?.quota, json.data?.remaining, json.data?.credits, json.data?.points,
        json.user?.balance, json.user?.quota, json.user?.credits,
    ];
    for (const c of candidates) {
        const n = finiteNumber(c);
        if (n !== null) {
            const text = Number.isInteger(n) ? n.toLocaleString() : n.toFixed(2).replace(/\.?0+$/, '');
            return { amount: n, label: `剩 ${text} 点` };
        }
    }
    return null;
}
