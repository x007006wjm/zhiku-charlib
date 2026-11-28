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

/** 解析 V5 随时间恢复的滚动额度（usage.percent / purchasedPercent / isNegative）。 */
export function parseV5Usage(json) {
    const u = json?.usage || json?.subscription?.usage || json?.data?.usage;
    if (!u || typeof u !== 'object') return null;
    const pct = finiteNumber(u.percent);
    if (pct === null) return null;
    const signed = u.isNegative && pct > 0 ? -pct : pct;
    const extra = finiteNumber(u.purchasedPercent) ?? 0;
    const pctText = Number.isInteger(signed) ? String(signed) : signed.toFixed(1).replace(/\.0$/, '');
    const extraText = extra > 0 ? `+${Math.round(extra)}%` : '';
    const label = `V5 ${pctText}%${extraText}`;
    const nextSec = finiteNumber(u.timeUntilNextPercent);
    let note = '';
    if (nextSec !== null && nextSec > 0) {
        const mins = Math.ceil(nextSec / 60);
        note = mins >= 60 ? `约 ${Math.floor(mins / 60)}h${mins % 60 ? (mins % 60) + 'm' : ''} 后 +1%` : `约 ${mins} 分钟后 +1%`;
    }
    return { percent: signed, purchasedPercent: extra, isNegative: Boolean(u.isNegative), label, note };
}

/** 从接口 JSON 中解析剩余额度（点数 + V5 随时间恢复额度），返回 { amount, usage, label, detail } 或 null。 */
export function parseQuotaResponse(json) {
    if (!json || typeof json !== 'object') return null;
    let amount = null;
    let pointsLabel = '';
    const t = json.trainingStepsLeft || json.subscription?.trainingStepsLeft || json.data?.trainingStepsLeft;
    if (t && typeof t === 'object') {
        const fixed = finiteNumber(t.fixedTrainingStepsLeft) ?? 0;
        const purchased = finiteNumber(t.purchasedTrainingSteps) ?? 0;
        amount = fixed + purchased;
        pointsLabel = `剩 ${Math.round(amount).toLocaleString()} 点`;
    } else {
        const candidates = [
            json.anlas, json.balance, json.quota, json.remaining, json.credits, json.points,
            json.data?.anlas, json.data?.balance, json.data?.quota, json.data?.remaining, json.data?.credits, json.data?.points,
            json.user?.balance, json.user?.quota, json.user?.credits,
        ];
        for (const c of candidates) {
            const n = finiteNumber(c);
            if (n !== null) {
                amount = n;
                const text = Number.isInteger(n) ? n.toLocaleString() : n.toFixed(2).replace(/\.?0+$/, '');
                pointsLabel = `剩 ${text} 点`;
                break;
            }
        }
    }
    const usage = parseV5Usage(json);
    const parts = [pointsLabel, usage?.label].filter(Boolean);
    if (!parts.length) return null;
    return { amount, usage, label: parts.join(' · '), detail: usage?.note || '' };
}
