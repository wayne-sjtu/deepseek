/**
 * 路由分派 —— 对应 Python `server.py` 的 `route(method, path, query, body)`。
 *
 * 分派顺序与 Python 严格一致（顺序会影响重载路径的归属）：
 *   1. `/api` 前缀剥离；
 *   2. `enterprises/{eid}/...` → 企业域（eid 不匹配直接 403）；
 *   3. `v1/efficiency/...`   → 本方案扩展的效能域；
 *   4. 其余 → 404 `40400`。
 *
 * 与 Python 的差异（有意）：`ds` 由调用方显式传入，而不是模块级全局 `DS`。
 * 显式传参能让「这份响应属于哪个数据源」在签名上就可见，也避免测试之间互相污染。
 */

import type { DataSource } from './datasource.ts';
import { ok, err } from './http/envelope.ts';
import type { ParsedQuery } from './http/query.ts';
import { qRange, qList, qMemberFilter, memberData, type Row } from './routes/shared.ts';
import { efficiencyOverview, quotaList, memberDetail } from './routes/efficiency.ts';
import { routeEnterprise } from './routes/enterprise.ts';

/**
 * 路由入口，返回 `[status, payload]`。
 *
 * `query` 是已解析的查询串（`Record<string, string[]>`，等价 Python `parse_qs` 的结果，
 * 空值已被丢弃）；`body` 是已解析的 JSON body（解析失败时为空对象）。
 */
export function route(
  ds: DataSource,
  method: string,
  path: string,
  query: ParsedQuery,
  body: Row,
): [number, unknown] {
  let parts = path.split('/').filter((p) => p);
  if (parts.length && parts[0] === 'api') parts = parts.slice(1);

  // /enterprises/{eid}/...
  if (parts.length >= 2 && parts[0] === 'enterprises') {
    const eid = parts[1];
    if (eid !== ds.enterpriseId) {
      return [403, err(40301, `企业不存在或无权访问: ${eid}`)];
    }
    return routeEnterprise(ds, method, parts.slice(2), query, body);
  }

  if (parts[0] === 'v1' && parts[1] === 'efficiency') {
    const tail = parts.slice(2);

    if (method === 'GET' && tail[0] === 'overview') {
      return [
        200,
        ok(
          efficiencyOverview(ds, {
            timeRange: qRange(query),
            departmentIds: qList(query, 'departmentIds'),
            memberFilter: qMemberFilter(query),
          }),
        ),
      ];
    }

    if (method === 'GET' && tail[0] === 'members') {
      return [
        200,
        ok(
          memberData(ds, {
            timeRange: qRange(query),
            departmentIds: qList(query, 'departmentIds'),
            memberFilter: qMemberFilter(query),
            pagination: {
              page: Number(query['page']?.[0] ?? '1'),
              pageSize: Number(query['pageSize']?.[0] ?? '20'),
            },
            memberOptions: {
              sortBy: query['sortBy']?.[0] ?? 'totalNewCodeLines',
              sortOrder: query['sortOrder']?.[0] ?? 'desc',
              searchKeyword: query['keyword']?.[0] ?? '',
            },
          }),
        ),
      ];
    }

    if (method === 'GET' && tail[0] === 'member' && tail.length >= 2) {
      return memberDetail(ds, tail[1], qRange(query));
    }

    if (method === 'GET' && tail[0] === 'departments') {
      return [200, ok(ds.dataset.departments)];
    }

    if (method === 'GET' && tail[0] === 'quota') {
      return [200, ok(quotaList(ds, query))];
    }

    if (method === 'GET' && tail[0] === 'meta') {
      return [
        200,
        ok({
          meta: ds.dataset.meta,
          quotaCycle: ds.dataset.quotaCycle,
          defaultQuota: ds.defaultQuota,
          // Python 的 `DS.audit[-20:]`：只回传最近 20 条
          audit: ds.audit.slice(-20),
        }),
      ];
    }
  }

  return [404, err(40400, `未实现的接口: ${method} ${path}`)];
}
