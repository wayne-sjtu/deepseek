/**
 * 自检 —— 对应 Python `server.py` 的 `selftest()` + `selftest_http()`。
 *
 * 两道闸门，缺一不可：
 *   1. **接口层**：22 个用例逐个走 `route()`，校验状态码与错误码语义；
 *   2. **HTTP 层**：真的起一个 server 发请求，校验静态入口 / SPA 深链 / 静态资源 /
 *      405 语义。原项目当年正是因为只在接口层自检，漏掉了「`/` 被误判为接口路径」
 *      这个 bug —— 路由分类是 HTTP 层行为，必须在这一层验证。
 *
 * 最后附一道**口径一致性**断言：部门汇总 == 成员汇总 == 公司总量。
 */

import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { DataSource, DIST_DIR } from './datasource.ts';
import { createHandler } from './http/server.ts';
import { err, ok } from './http/envelope.ts';
import { parseQuery } from './http/query.ts';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pyRound } from './pyround.ts';
import { route } from './routes.ts';

type Case = [string, string, unknown?, number?];

const EID = '1234567890';
const T = { startTime: '2026-08-22', endTime: '2026-09-20' };

/** 与 Python `SELFTEST_CASES` 逐条对应（含两条错误分支）。 */
export const SELFTEST_CASES: Case[] = [
  ['GET', '/api/v1/efficiency/meta'],
  ['GET', '/api/v1/efficiency/overview?startTime=2026-08-22&endTime=2026-09-20'],
  ['GET', '/api/v1/efficiency/members?pageSize=5&sortBy=totalNewCodeLines'],
  ['GET', '/api/v1/efficiency/departments'],
  ['GET', `/api/enterprises/${EID}/info`],
  ['GET', `/api/enterprises/${EID}/openapi/members?pageSize=3`],
  ['GET', `/api/enterprises/${EID}/openapi/usage/quota-cycle`],
  ['GET', `/api/enterprises/${EID}/openapi/usage/default-quota`],
  ['GET', `/api/enterprises/${EID}/openapi/resources/overview`],
  [
    'GET',
    `/api/enterprises/${EID}/metrics?queries=activeUserNum,lineIncreaseNum,completionAcceptLineRate` +
      `&range.start=2026-09-01&range.end=2026-09-20&range.step=86400`,
  ],
  [
    'POST',
    `/api/enterprises/${EID}/dashboard/member/data`,
    {
      timeRange: T,
      memberFilter: { type: 'all' },
      pagination: { page: 1, pageSize: 5 },
      memberOptions: { sortBy: 'aiGenerateCodeLines', sortOrder: 'desc' },
    },
  ],
  [
    'POST',
    `/api/enterprises/${EID}/dashboard/analytics/activity`,
    { timeRange: T, memberFilter: { type: 'all' }, viewType: 'metrics' },
  ],
  [
    'POST',
    `/api/enterprises/${EID}/dashboard/analytics/dialog`,
    { timeRange: T, memberFilter: { type: 'all' }, viewType: 'trends' },
  ],
  [
    'POST',
    `/api/enterprises/${EID}/dashboard/analytics/completion`,
    { timeRange: T, memberFilter: { type: 'all' }, viewType: 'metrics' },
  ],
  [
    'POST',
    `/api/enterprises/${EID}/dashboard/analytics/generation`,
    { timeRange: T, memberFilter: { type: 'all' }, viewType: 'metrics' },
  ],
  [
    'POST',
    `/api/enterprises/${EID}/openapi/observability/metric-summary/query`,
    {
      range: { start: 1755792000, end: 1758297600 },
      metrics: ['genai_request_count', 'token_usage', 'credit', 'ttft_p95', 'tool_error_rate'],
    },
  ],
  [
    'POST',
    `/api/enterprises/${EID}/openapi/observability/metric-trend/query`,
    {
      range: { start: 1755792000, end: 1758297600 },
      metrics: ['credit', 'token_usage'],
      groupBy: 'department',
    },
  ],
  [
    'POST',
    `/api/enterprises/${EID}/openapi/observability/metric-records/query`,
    {
      range: { start: 1758211200, end: 1758297600 },
      metrics: ['credit', 'token_usage'],
      pageSize: 3,
    },
  ],
  ['POST', `/api/enterprises/${EID}/openapi/usage/members/query`, { userNames: ['张伟'], pageSize: 3 }],
  [
    'POST',
    `/api/enterprises/${EID}/openapi/observability/metric-summary/query`,
    { range: { start: 1755792000, end: 1758297600 }, metrics: ['not_a_metric'] },
    400,
  ],
  ['GET', '/api/enterprises/wrong-id/info', undefined, 403],
];

/** 从 Slice 的分组容器里取出各分组的 totals（兼容 Map / 普通对象两种实现）。 */
function groupValues(container: unknown): Array<Record<string, number>> {
  if (container instanceof Map) return [...container.values()] as Array<Record<string, number>>;
  if (container && typeof container === 'object') {
    return Object.values(container as Record<string, Record<string, number>>);
  }
  return [];
}

function sumCredit(container: unknown): number {
  return groupValues(container).reduce((acc, t) => acc + Number(t.credit ?? 0), 0);
}

/** HTTP 层自检：真的起服务发请求。返回失败数。 */
export async function selftestHttp(ds: DataSource): Promise<number> {
  const server = createServer(createHandler(ds));
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;
  const indexExists = existsSync(resolve(DIST_DIR, 'index.html'));
  console.log(`HTTP 层自检（${base}，前端产物${indexExists ? '已' : '未'}构建）：`);

  let failures = 0;
  const staticType = indexExists ? 'text/html' : 'application/json';
  const cases: Array<[string, string, number, string | null, string]> = [
    ['GET', '/', 200, staticType, '根路径：静态入口'],
    ['GET', '/overview', 200, staticType, 'SPA 深链回退'],
    ['GET', '/members/whatever-uuid', 200, staticType, '带参深链'],
    ['GET', '/favicon.svg', 200, null, '静态资源'],
    ['GET', '/healthz', 200, 'application/json', '健康检查'],
    ['GET', '/api/v1/efficiency/meta', 200, 'application/json', '扩展接口'],
    ['GET', '/api/v1/efficiency/nope', 404, 'application/json', '未实现的扩展接口'],
    ['POST', '/overview', 405, 'application/json', '静态路径不接受 POST'],
  ];

  for (const [method, path, expectStatus, expectType, label] of cases) {
    let status = 0;
    let ctype = '';
    let body = '';
    try {
      const res = await fetch(`${base}${path}`, { method });
      status = res.status;
      ctype = res.headers.get('content-type') ?? '';
      body = await res.text();
    } catch (exc) {
      body = exc instanceof Error ? exc.message : String(exc);
    }
    const typeOk = expectType === null || ctype.includes(expectType);
    const pass = status === expectStatus && typeOk;
    if (!pass) failures++;
    console.log(
      `  [${pass ? 'OK  ' : 'FAIL'}] ${status} ${method.padEnd(4)} ${path.padEnd(28)} ${label}`,
    );
    if (!pass) {
      console.log(
        `         期望 ${expectStatus} ${expectType}，实际 ${status} ${ctype}：${body.slice(0, 120)}`,
      );
    }
  }

  // 前端未构建时必须给出可执行指引，而不是无信息量的 404
  if (!indexExists) {
    const res = await fetch(`${base}/`);
    const body = await res.text();
    if (!body.includes('npm run build')) {
      failures++;
      console.log('  [FAIL] 未构建前端时的根路径缺少构建指引');
    } else {
      console.log('  [OK  ] 未构建前端时返回了构建指引');
    }
  }

  await new Promise<void>((done) => server.close(() => done()));
  return failures;
}

/** 完整自检：接口层 + 口径一致性 + HTTP 层。返回进程退出码。 */
export async function selftest(ds: DataSource): Promise<number> {
  let failures = 0;
  console.log(`数据集：${ds.path}`);
  console.log(
    `企业：${ds.enterpriseId}  成员：${ds.members.length}  记录：${ds.dataset.series.length}\n`,
  );

  for (const [method, rawPath, body, expectStatusRaw] of SELFTEST_CASES) {
    const expectStatus = expectStatusRaw ?? 200;
    const [pathname, search] = rawPath.split('?');
    let status: number;
    let payload: Record<string, unknown>;
    try {
      if (pathname === '/healthz') {
        status = 200;
        payload = ok({ status: 'ok' }) as unknown as Record<string, unknown>;
      } else {
        [status, payload] = route(
          ds,
          method,
          pathname!,
          parseQuery(search ? `?${search}` : ''),
          (body as Record<string, unknown>) ?? {},
        ) as [number, Record<string, unknown>];
      }
    } catch (exc) {
      console.error(exc);
      console.log(`[FAIL] ${method} ${rawPath} -> 异常 ${exc}`);
      failures++;
      continue;
    }

    const pass =
      expectStatus >= 400
        ? status === expectStatus && payload.code !== null && payload.code !== 0
        : status === 200 && payload.code === 0;
    if (!pass) failures++;
    const data = payload.data;
    const size = data === undefined ? 0 : JSON.stringify(data).length;
    console.log(
      `[${pass ? 'OK  ' : 'FAIL'}] ${status} ${method.padEnd(4)} ${pathname}` +
        `${search ? `?${search}` : ''}   payload=${size}B`,
    );
  }

  // 交叉校验：部门汇总之和 == 公司总量
  const [start, end] = ds.resolveRange(null, null, 30);
  const sl = ds.slice(start, end) as unknown as {
    org: Record<string, number>;
    departments: unknown;
    members: unknown;
  };
  const deptCredit = pyRound(sumCredit(sl.departments), 2);
  const orgCredit = pyRound(Number(sl.org.credit ?? 0), 2);
  const memberCredit = pyRound(sumCredit(sl.members), 2);
  console.log(`\n口径一致性校验（${start} ~ ${end}）：`);
  console.log(`  部门汇总 credits = ${deptCredit.toLocaleString('en-US', { minimumFractionDigits: 2 })}`);
  console.log(`  成员汇总 credits = ${memberCredit.toLocaleString('en-US', { minimumFractionDigits: 2 })}`);
  console.log(`  公司总量 credits = ${orgCredit.toLocaleString('en-US', { minimumFractionDigits: 2 })}`);
  if (Math.abs(deptCredit - orgCredit) > 0.01 || Math.abs(memberCredit - orgCredit) > 0.01) {
    console.log('  [FAIL] 汇总口径不一致');
    failures++;
  } else {
    console.log('  [OK  ] 汇总口径一致');
  }
  console.log();

  failures += await selftestHttp(ds);
  console.log(`\n${failures === 0 ? '全部通过' : `${failures} 个用例失败`}`);
  return failures ? 1 : 0;
}
