/**
 * 企业域路由 —— 对应 Python `server.py` 的 `route_enterprise`、
 * `_resample`、`_apply_quota_update`。
 *
 * 覆盖路径前缀 `/api/enterprises/{eid}/...`：
 *   - 基础信息 / 成员 / 部门
 *   - 用量域（quota-cycle / default-quota / members 查询与额度调整）
 *   - 资源总览
 *   - Dashboard 域（member/data、analytics/*）
 *   - 监控指标 v1（旧看板 `/metrics`）
 *   - 可观测域（observability/*）
 */

import type { DataSource } from '../datasource.ts';
import { dailyPoints, dateRange } from '../metrics.ts';
import { pyRound, round2 } from '../pyround.ts';
import { ok, err } from '../http/envelope.ts';
import type { ParsedQuery } from '../http/query.ts';
import { memberData, memberFilter, departmentFilter, type Row } from './shared.ts';
import {
  analyticsActivity,
  analyticsDialog,
  analyticsCompletion,
  analyticsGeneration,
} from './analytics.ts';
import {
  metricSummary,
  metricTrend,
  metricRecords,
  MetricValidationError,
} from './observability.ts';

const TZ_OFFSET_SECONDS = 8 * 3600;

/** 等价 `datetime.fromisoformat(d).replace(tzinfo=TZ).timestamp()`（整秒）。 */
function dateTzToUnix(day: string): number {
  const [y, m, d] = day.split('-').map(Number);
  return Date.UTC(y, m - 1, d) / 1000 - TZ_OFFSET_SECONDS;
}

/** 等价 `datetime.now(TZ).isoformat()`：格式对齐 Python（微秒 + `+08:00`）。 */
function nowTzIso(): string {
  const shifted = new Date(Date.now() + TZ_OFFSET_SECONDS * 1000);
  return `${shifted.toISOString().slice(0, 23)}000+08:00`;
}

/**
 * 等价 `_resample(pairs, step_seconds)`：把日粒度降级为更小的步长。
 * mock 场景下做的是等值插值，仅用于兼容 `range.step` 语义。
 */
function resample(pairs: Array<[string, number]>, stepSeconds: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const divisor = Math.max(1, Math.floor(86400 / stepSeconds));
  for (const [d, v] of pairs) {
    const base = dateTzToUnix(d);
    for (let offset = 0; offset < 86400; offset += stepSeconds) {
      out.push([base + offset, v / divisor]);
    }
  }
  return out;
}

/**
 * 等价 `_apply_quota_update(body, targets, scope, dept_id=None)`。
 *
 * `limitType` 与 `newLimit` 的校验语义与 Python 一致：`newLimit` 必须是**整数**
 * 且落在 1 ~ 999999999（Python 用 `isinstance(new_limit, int)`）。
 */
function applyQuotaUpdate(
  ds: DataSource,
  body: Row,
  targets: Row[],
  scope: string,
  deptId: string | null = null,
): [number, unknown] {
  const limitType = body?.['limitType'];
  if (limitType !== 'limited' && limitType !== 'unlimited') {
    return [400, err(40001, 'limitType 必须为 limited 或 unlimited')];
  }
  const newLimit = body?.['newLimit'];
  if (
    limitType === 'limited' &&
    (!Number.isInteger(newLimit) || !(Number(newLimit) >= 1 && Number(newLimit) <= 999999999))
  ) {
    return [400, err(40001, 'newLimit 取值范围 1 ~ 999999999')];
  }
  for (const m of targets) {
    if (limitType === 'limited') {
      m['cycleLimit'] = newLimit;
      m['cycleLimitDisplay'] = String(newLimit);
    } else {
      m['cycleLimit'] = null;
      m['cycleLimitDisplay'] = '不限量';
    }
  }
  ds.audit.push({
    at: nowTzIso(),
    action: `${scope}-quota`,
    departmentId: deptId,
    limitType,
    newLimit,
    affectedCount: targets.length,
  });
  return [200, ok({ affectedCount: targets.length })];
}

/** 等价 `route_enterprise(method, rest, query, body)`。 */
export function routeEnterprise(
  ds: DataSource,
  method: string,
  rest: string[],
  query: ParsedQuery,
  body: Row,
): [number, unknown] {
  const eq = (a: string[], b: string[]): boolean =>
    a.length === b.length && a.every((v, i) => v === b[i]);

  // —— 基础信息 / 成员 / 部门 ——
  if (method === 'GET' && eq(rest, ['info'])) {
    return [
      200,
      ok({
        enterpriseId: ds.enterpriseId,
        enterpriseName: ds.dataset.meta.enterpriseName,
        memberCount: ds.members.length,
        departmentCount: ds.dataset.departments.length - 1,
      }),
    ];
  }

  if (method === 'GET' && eq(rest, ['openapi', 'members'])) {
    const page = Number(query['pageNum']?.[0] ?? '1');
    // 注意 Python 这里是 `min(200, ...)`，**没有** max(1, ...) 下限；
    // 负数 size 会让切片按 Python 的负索引语义截尾，JS 的 slice 行为一致
    const size = Math.min(200, Number(query['pageSize']?.[0] ?? '20'));
    const keyword = (query['keyword']?.[0] ?? '').toLowerCase();
    let items = ds.members as unknown as Row[];
    if (keyword) {
      items = items.filter(
        (m) =>
          String(m['userName']).toLowerCase().includes(keyword) ||
          String(m['email'] ?? '').toLowerCase().includes(keyword),
      );
    }
    const total = items.length;
    return [
      200,
      ok({
        items: items.slice((page - 1) * size, page * size).map((m) => ({
          userId: m['userId'],
          userName: m['userName'],
          email: m['email'],
          departmentIds: m['departmentIds'],
          departmentName: m['primaryDepartmentName'],
          joinedAt: m['joinedAt'],
          enabled: true,
        })),
        totalCount: total,
        pageNum: page,
        pageSize: size,
      }),
    ];
  }

  if (method === 'GET' && eq(rest, ['openapi', 'departments'])) {
    return [
      200,
      ok({
        items: ds.dataset.departments,
        totalCount: ds.dataset.departments.length,
      }),
    ];
  }

  // —— 用量域 ——
  if (method === 'GET' && eq(rest, ['openapi', 'usage', 'quota-cycle'])) {
    return [200, ok(ds.dataset.quotaCycle)];
  }
  if (method === 'GET' && eq(rest, ['openapi', 'usage', 'default-quota'])) {
    return [200, ok(ds.defaultQuota)];
  }

  if (method === 'POST' && eq(rest, ['openapi', 'usage', 'default-quota', 'update'])) {
    const limitType = body?.['limitType'];
    if (limitType !== 'limited' && limitType !== 'unlimited') {
      return [400, err(40001, 'limitType 必须为 limited 或 unlimited')];
    }
    if (limitType === 'limited') {
      const newLimit = body?.['newLimit'];
      if (!Number.isInteger(newLimit) || !(Number(newLimit) >= 1 && Number(newLimit) <= 999999999)) {
        return [400, err(40001, 'newLimit 取值范围 1 ~ 999999999')];
      }
      ds.defaultQuota.cycleLimit = Number(newLimit);
    } else {
      ds.defaultQuota.cycleLimit = -1;
    }
    const affected = ds.members.filter((m) => m.cycleLimit === null || m.cycleLimit === undefined).length;
    ds.audit.push({
      at: nowTzIso(),
      action: 'default-quota',
      limitType,
      newLimit: body?.['newLimit'] ?? null,
      affectedCount: affected,
    });
    return [200, ok({ affectedCount: affected })];
  }

  if (method === 'POST' && eq(rest, ['openapi', 'usage', 'members', 'query'])) {
    const userIds = new Set<string>(body?.['userIds'] ?? []);
    const userNames = new Set<string>(body?.['userNames'] ?? []);
    if (!userIds.size && !userNames.size) {
      return [400, err(40001, 'userIds 与 userNames 至少提供一个')];
    }
    const targets = (ds.members as unknown as Row[]).filter(
      (m) => userIds.has(String(m['userId'])) || userNames.has(String(m['userName'])),
    );
    const [start, end] = ds.resolveRange(body?.['startTime'] ?? null, body?.['endTime'] ?? null);
    const cur = ds.slice(start, end, new Set(targets.map((m) => String(m['userId']))));
    const page = Math.max(1, Number(body?.['pageNum'] || 1));
    const size = Math.max(1, Math.min(500, Number(body?.['pageSize'] || 20)));
    const items: Row[] = [];
    for (const m of targets) {
      const row = cur.members[String(m['userId'])];
      const used = row ? Number(row['credit']) : 0.0;
      const limit = m['cycleLimit'] ?? null;
      items.push({
        userId: m['userId'],
        userName: m['userName'],
        cycleLimit: limit,
        cycleLimitDisplay: m['cycleLimitDisplay'] ?? '不限量',
        totalUsed: round2(used),
        __quotaUsageRate: limit ? round2((used / Number(limit)) * 100) : null,
      });
    }
    items.sort((a, b) => Number(b['totalUsed']) - Number(a['totalUsed']));
    const invalidNames = [...userNames].filter((n) => !ds.memberByName.has(n));
    const invalidIds = [...userIds].filter((i) => !ds.memberById.has(i));
    return [
      200,
      ok({
        items: items.slice((page - 1) * size, page * size),
        totalCount: items.length,
        pageNum: page,
        pageSize: size,
        invalidUserIds: invalidIds,
        invalidUserNames: invalidNames,
        range: { start, end },
      }),
    ];
  }

  if (method === 'POST' && eq(rest, ['openapi', 'usage', 'members', 'limit-query'])) {
    const userIds = new Set<string>(body?.['userIds'] ?? []);
    const userNames = new Set<string>(body?.['userNames'] ?? []);
    const targets = (ds.members as unknown as Row[]).filter(
      (m) => userIds.has(String(m['userId'])) || userNames.has(String(m['userName'])),
    );
    return [
      200,
      ok({
        items: targets.map((m) => ({
          userId: m['userId'],
          userName: m['userName'],
          cycleLimit: m['cycleLimit'] ?? null,
          cycleLimitDisplay: m['cycleLimitDisplay'] ?? '不限量',
          operator: 'mock-admin',
          operatedAt: ds.dataset.meta.generatedAt,
        })),
        totalCount: targets.length,
      }),
    ];
  }

  if (method === 'POST' && eq(rest, ['openapi', 'usage', 'members', 'quota', 'update'])) {
    const userIds = new Set<string>(body?.['userIds'] ?? []);
    const userNames = new Set<string>(body?.['userNames'] ?? []);
    const targets = (ds.members as unknown as Row[]).filter(
      (m) => userIds.has(String(m['userId'])) || userNames.has(String(m['userName'])),
    );
    return applyQuotaUpdate(ds, body, targets, 'members');
  }

  // 路径: openapi/usage/departments/{departmentId}/quota/update
  if (
    method === 'POST' &&
    rest.length === 6 &&
    eq(rest.slice(0, 3), ['openapi', 'usage', 'departments']) &&
    eq(rest.slice(4), ['quota', 'update'])
  ) {
    const deptId = rest[3];
    const targets = (ds.members as unknown as Row[]).filter(
      (m) => m['primaryDepartmentId'] === deptId,
    );
    return applyQuotaUpdate(ds, body, targets, 'department', deptId);
  }

  if (method === 'GET' && eq(rest, ['openapi', 'resources', 'overview'])) {
    return [200, ok(ds.dataset.resources)];
  }

  // —— Dashboard 域 ——
  if (method === 'POST' && eq(rest.slice(0, 3), ['dashboard', 'member', 'data'])) {
    return [200, ok(memberData(ds, body))];
  }

  if (method === 'POST' && eq(rest.slice(0, 2), ['dashboard', 'analytics']) && rest.length === 3) {
    const kind = rest[2];
    const tr = body?.['timeRange'] ?? {};
    const [start, end] = ds.resolveRange(tr['startTime'] ?? null, tr['endTime'] ?? null);
    const userIds = memberFilter(body);
    const deptIds = departmentFilter(body);
    const handlers: Record<string, (s: string, e: string, u: Set<string> | null, d: Set<string> | null) => Row> = {
      activity: (s, e, u, d) => analyticsActivity(ds, s, e, u, d),
      dialog: (s, e, u, d) => analyticsDialog(ds, s, e, u, d),
      completion: (s, e, u, d) => analyticsCompletion(ds, s, e, u, d),
      generation: (s, e, u, d) => analyticsGeneration(ds, s, e, u, d),
    };
    const handler = handlers[kind];
    if (!handler) return [404, err(40400, `未知分析类型: ${kind}`)];
    return [200, ok(handler(start, end, userIds, deptIds))];
  }

  // —— 监控指标 v1（旧看板）——
  if (method === 'GET' && eq(rest, ['metrics'])) {
    const queries = (query['queries']?.[0] ?? '').split(',').filter((q) => q);
    const startRaw = query['range.start']?.[0] ?? '';
    const endRaw = query['range.end']?.[0] ?? '';
    const step = Number(query['range.step']?.[0] ?? '86400');
    const FIELD_OF: Record<string, string> = {
      activeUserNum: '__active__',
      completionActiveUserNum: '__comp_active__',
      chatActiveUserNum: '__chat_active__',
      chatNum: 'dc',
      completionAcceptNum: 'ca',
      completionAcceptLineNum: 'cal',
      completionAcceptCharacterNum: 'cac',
      lineIncreaseNum: 'tnl',
      characterIncreaseNum: 'tnc',
      completionNum: 'cg',
      completionLineNum: 'cgl',
      completionCharacterNum: 'cgc',
      completionAcceptRate: '__accept_rate__',
      completionAcceptLineRate: '__accept_line_rate__',
      completionAcceptCharacterRate: '__accept_char_rate__',
      completionGenerateLineRate: '__gen_line_rate__',
      completionGenerateCharacterRate: '__gen_char_rate__',
    };
    const unknown = queries.filter((q) => !(q in FIELD_OF));
    if (unknown.length) return [400, err(40001, `不支持的指标: ${unknown.join(',')}`)];
    if (!startRaw || !endRaw) return [400, err(40001, 'range.start 与 range.end 必填')];

    const start = startRaw.slice(0, 10);
    const end = endRaw.slice(0, 10);
    const cur = ds.slice(start, end);

    const data: Row = {};
    for (const q of queries) {
      const fieldName = FIELD_OF[q];
      if (fieldName.startsWith('__')) {
        data[q] = [[], []];
        continue;
      }
      const pairs = dailyPoints(ds.index, start, end, fieldName, null, null)['__total__'] ?? [];
      if (step >= 86400) {
        data[q] = [
          pairs.map(([d]) => dateTzToUnix(d) * 1000),
          pairs.map(([, v]) => pyRound(v, 4)),
        ];
      } else {
        const points = resample(pairs, step);
        data[q] = [points.map(([t]) => t * 1000), points.map(([, v]) => pyRound(v, 4))];
      }
    }

    if (!('activeUserNum' in data)) data['activeUserNum'] = [];
    if (queries.includes('activeUserNum')) {
      const active: Array<[string, number]> = [];
      for (const [d] of dailyPoints(ds.index, start, end, 'cr', null, null)['__total__'] ?? []) {
        const users = new Set((ds.index.byDay.get(d) ?? []).map((r) => r.u));
        active.push([d, users.size]);
      }
      data['activeUserNum'] = [
        active.map(([d]) => dateTzToUnix(d) * 1000),
        active.map(([, v]) => v),
      ];
    }

    const DERIVED_RATES: Record<string, string> = {
      completionAcceptRate: 'completionAcceptRateByCount',
      completionAcceptLineRate: 'completionAcceptRateByLines',
      completionAcceptCharacterRate: 'completionAcceptRateByChars',
      completionGenerateLineRate: 'codeGenerateRateByLines',
      completionGenerateCharacterRate: 'codeGenerateRateByChars',
    };
    for (const [q, orgKey] of Object.entries(DERIVED_RATES)) {
      if (queries.includes(q)) {
        data[q] = [
          [dateTzToUnix(end) * 1000],
          [(cur.org as unknown as Row)[orgKey] || 0],
        ];
      }
    }
    return [200, ok(data)];
  }

  // —— 可观测域 ——
  const observability: Record<string, (ds: DataSource, b: Row) => Row> = {
    'metric-summary': metricSummary,
    'metric-trend': metricTrend,
    'metric-records': metricRecords,
  };
  if (
    method === 'POST' &&
    rest.length === 4 &&
    eq(rest.slice(0, 2), ['openapi', 'observability']) &&
    rest[3] === 'query'
  ) {
    const handler = observability[rest[2]];
    if (handler) {
      try {
        return [200, ok(handler(ds, body))];
      } catch (exc) {
        if (exc instanceof MetricValidationError) return [400, err(40001, exc.message)];
        throw exc;
      }
    }
  }

  return [404, err(40400, `未实现的接口: ${method} /${rest.join('/')}`)];
}
