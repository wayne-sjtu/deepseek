#!/usr/bin/env node
/**
 * 口径等价性测试台（Parity Harness）
 * ==================================
 *
 * 目的
 * ----
 * TS 移植版的 mock **数据集**允许与 Python 版不同（都是假数据，没人关心）。
 * 但**口径**绝不允许漂移：同一份输入数据集，两个后端必须算出**完全相同**的数字。
 * 否则移植就等于偷偷换了口径，看板上的数会静默失真 —— 这正是最难发现的一类 bug。
 *
 * 做法
 * ----
 * 让两个后端加载**同一个**数据集文件（`server.py` 与 TS 版都支持 `--dataset`），
 * 然后用同一组请求逐一轰过去，深度比对响应 JSON。
 * 数值按**精确相等**比较，不做近似；只忽略每次调用必然不同的字段（requestId 等）。
 *
 * 用法
 * ----
 *   # 终端 1：Python 后端
 *   python3 ai-efficiency-console/backend/app/server.py --dataset data/mock_dataset.json --port 8001
 *   # 终端 2：TS 后端
 *   node backend/src/server.ts --dataset data/mock_dataset.json --port 8002
 *   # 终端 3：比对
 *   node scripts/parity-api.mjs --py http://127.0.0.1:8001 --ts http://127.0.0.1:8002
 *
 * 退出码：0 = 全部一致，1 = 有差异或请求失败。
 */

import process from 'node:process';

// ---------------------------------------------------------------------------
// 每次调用必然变化的字段：比对前剔除，否则会产生无意义的噪声
// ---------------------------------------------------------------------------
const VOLATILE_KEYS = new Set(['requestId', 'generatedAt', 'serverTime', 'now']);

// ---------------------------------------------------------------------------
// 测试用例：起自 Python 版 SELFTEST_CASES，再补上跨边界与错误分支
// ---------------------------------------------------------------------------
const EID = '1234567890';
const T = { startTime: '2026-08-22', endTime: '2026-09-20' };

const CASES = [
  // —— 本方案扩展接口 ——
  ['GET', '/api/v1/efficiency/meta'],
  ['GET', '/api/v1/efficiency/overview?startTime=2026-08-22&endTime=2026-09-20'],
  ['GET', '/api/v1/efficiency/overview?startTime=2026-09-01&endTime=2026-09-20'],
  ['GET', '/api/v1/efficiency/members?pageSize=5&sortBy=totalNewCodeLines'],
  ['GET', '/api/v1/efficiency/members?pageSize=10&sortBy=credit&sortOrder=asc'],
  ['GET', '/api/v1/efficiency/departments'],
  ['GET', '/healthz'],

  // —— 企业域 ——
  [`GET`, `/api/enterprises/${EID}/info`],
  [`GET`, `/api/enterprises/${EID}/openapi/members?pageSize=3`],
  [`GET`, `/api/enterprises/${EID}/openapi/members?pageSize=50&page=2`],
  [`GET`, `/api/enterprises/${EID}/openapi/departments`],
  [`GET`, `/api/enterprises/${EID}/openapi/usage/quota-cycle`],
  [`GET`, `/api/enterprises/${EID}/openapi/usage/default-quota`],
  [`GET`, `/api/enterprises/${EID}/openapi/resources/overview`],

  // —— 旧版指标接口（含分组，覆盖 GROUP_DIMENSIONS 分支）——
  [`GET`, `/api/enterprises/${EID}/metrics?queries=activeUserNum,lineIncreaseNum,completionAcceptLineRate&range.start=2026-09-01&range.end=2026-09-20&range.step=86400`],
  [`GET`, `/api/enterprises/${EID}/metrics?queries=credit,tokenUsage&groupBy=department&range.start=2026-09-01&range.end=2026-09-20&range.step=86400`],

  // —— dashboard 域 ——
  ['POST', `/api/enterprises/${EID}/dashboard/member/data`, {
    timeRange: T, memberFilter: { type: 'all' },
    pagination: { page: 1, pageSize: 5 },
    memberOptions: { sortBy: 'aiGenerateCodeLines', sortOrder: 'desc' },
  }],
  ['POST', `/api/enterprises/${EID}/dashboard/member/data`, {
    timeRange: T, memberFilter: { type: 'all' },
    pagination: { page: 2, pageSize: 20 },
    memberOptions: { sortBy: 'credit', sortOrder: 'asc' },
  }],
  ['POST', `/api/enterprises/${EID}/dashboard/analytics/activity`, {
    timeRange: T, memberFilter: { type: 'all' }, viewType: 'metrics',
  }],
  ['POST', `/api/enterprises/${EID}/dashboard/analytics/dialog`, {
    timeRange: T, memberFilter: { type: 'all' }, viewType: 'trends',
  }],
  ['POST', `/api/enterprises/${EID}/dashboard/analytics/completion`, {
    timeRange: T, memberFilter: { type: 'all' }, viewType: 'metrics',
  }],
  ['POST', `/api/enterprises/${EID}/dashboard/analytics/generation`, {
    timeRange: T, memberFilter: { type: 'all' }, viewType: 'metrics',
  }],

  // —— 可观测域：覆盖白名单校验、分组、分页 ——
  ['POST', `/api/enterprises/${EID}/openapi/observability/metric-summary/query`, {
    range: { start: 1755792000, end: 1758297600 },
    metrics: ['genai_request_count', 'token_usage', 'credit', 'ttft_p95', 'tool_error_rate'],
  }],
  ['POST', `/api/enterprises/${EID}/openapi/observability/metric-trend/query`, {
    range: { start: 1755792000, end: 1758297600 },
    metrics: ['credit', 'token_usage'], groupBy: 'department',
  }],
  ['POST', `/api/enterprises/${EID}/openapi/observability/metric-trend/query`, {
    range: { start: 1755792000, end: 1758297600 },
    metrics: ['credit'], groupBy: 'model',
  }],
  ['POST', `/api/enterprises/${EID}/openapi/observability/metric-records/query`, {
    range: { start: 1758211200, end: 1758297600 },
    metrics: ['credit', 'token_usage'], pageSize: 3,
  }],
  ['POST', `/api/enterprises/${EID}/openapi/usage/members/query`, {
    userNames: ['张伟'], pageSize: 3,
  }],

  // —— 错误分支：状态码与错误码语义必须一致 ——
  ['POST', `/api/enterprises/${EID}/openapi/observability/metric-summary/query`, {
    range: { start: 1755792000, end: 1758297600 }, metrics: ['not_a_metric'],
  }],
  ['GET', `/api/enterprises/wrong-id/info`],
  ['GET', `/api/v1/efficiency/nope`],
];

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------
function stripVolatile(node) {
  if (Array.isArray(node)) return node.map(stripVolatile);
  if (node && typeof node === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      if (VOLATILE_KEYS.has(k)) continue;
      out[k] = stripVolatile(v);
    }
    return out;
  }
  return node;
}

/** 深度比对，返回差异路径列表。数值按精确相等比较 —— 这是本测试台的立足点。 */
function diff(a, b, path = '$', out = []) {
  if (out.length >= 12) return out;
  if (a === b) return out;

  const ta = a === null ? 'null' : Array.isArray(a) ? 'array' : typeof a;
  const tb = b === null ? 'null' : Array.isArray(b) ? 'array' : typeof b;

  if (ta !== tb) {
    out.push(`${path}: 类型不同 python=${ta} ts=${tb} (${short(a)} vs ${short(b)})`);
    return out;
  }
  if (ta === 'array') {
    if (a.length !== b.length) {
      out.push(`${path}: 长度不同 python=${a.length} ts=${b.length}`);
      return out;
    }
    for (let i = 0; i < a.length; i++) diff(a[i], b[i], `${path}[${i}]`, out);
    return out;
  }
  if (ta === 'object') {
    const ka = Object.keys(a).sort();
    const kb = Object.keys(b).sort();
    const onlyA = ka.filter((k) => !kb.includes(k));
    const onlyB = kb.filter((k) => !ka.includes(k));
    if (onlyA.length) out.push(`${path}: 仅 Python 有这些键 [${onlyA.join(', ')}]`);
    if (onlyB.length) out.push(`${path}: 仅 TS 有这些键 [${onlyB.join(', ')}]`);
    for (const k of ka.filter((k) => kb.includes(k))) diff(a[k], b[k], `${path}.${k}`, out);
    return out;
  }
  // 数值 / 字符串 / 布尔差异
  const hint = typeof a === 'number' && typeof b === 'number' ? ` (差 ${b - a})` : '';
  out.push(`${path}: python=${short(a)} ts=${short(b)}${hint}`);
  return out;
}

function short(v) {
  const s = typeof v === 'string' ? JSON.stringify(v) : String(v);
  return s.length > 60 ? `${s.slice(0, 57)}...` : s;
}

async function call(base, method, path, body) {
  const init = { method, headers: {} };
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(`${base}${path}`, init);
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 非 JSON 响应（静态资源等）保留原文 */
  }
  return { status: res.status, json, text };
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
function argOf(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const PY = argOf('--py', 'http://127.0.0.1:8001');
const TS = argOf('--ts', 'http://127.0.0.1:8002');

const reachable = async (base) => {
  try {
    const r = await fetch(`${base}/healthz`);
    return r.ok;
  } catch {
    return false;
  }
};

let failures = 0;
let compared = 0;

console.log(`口径等价性测试`);
console.log(`  Python: ${PY}`);
console.log(`  TS    : ${TS}\n`);

for (const [method, path, body] of CASES) {
  const label = `${method} ${path}`;
  let py;
  let ts;
  try {
    [py, ts] = await Promise.all([call(PY, method, path, body), call(TS, method, path, body)]);
  } catch (exc) {
    failures++;
    console.log(`[FAIL] ${label}\n        请求失败: ${exc.message}`);
    continue;
  }

  if (py.status !== ts.status) {
    failures++;
    console.log(`[FAIL] ${label}\n        状态码不同 python=${py.status} ts=${ts.status}`);
    continue;
  }

  compared++;
  const a = stripVolatile(py.json ?? py.text);
  const b = stripVolatile(ts.json ?? ts.text);
  const diffs = diff(a, b);

  if (diffs.length === 0) {
    console.log(`[OK  ] ${py.status} ${label}`);
  } else {
    failures++;
    console.log(`[FAIL] ${py.status} ${label}`);
    for (const d of diffs) console.log(`        ${d}`);
  }
}

console.log(`\n比对 ${compared}/${CASES.length} 个用例，${failures === 0 ? '全部一致 ✓' : `${failures} 个不一致 ✗`}`);
process.exit(failures === 0 ? 0 : 1);
