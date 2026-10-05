/**
 * 响应信封与展示辅助 —— 对应 Python `server.py` 的 `ok` / `err` /
 * `metric_card` / `series_point`。
 *
 * 信封形状 `{ code, msg, requestId, data }` 是前端 `lib/api.ts` 的解析契约，
 * 必须逐字段保持一致，否则前端会统一报错。
 */

import { randomUUID } from 'node:crypto';

import { round2 } from '../pyround.ts';
import type { ApiResponse } from '../types.ts';

/** 成功响应。`extra` 用于与 data 平级地附加字段（与 Python 版语义一致）。 */
export function ok<T>(data: T, extra?: Record<string, unknown>): ApiResponse<T> {
  const payload: ApiResponse<T> = {
    code: 0,
    msg: 'OK',
    requestId: randomUUID(),
    data,
  };
  if (extra) Object.assign(payload, extra);
  return payload;
}

/** 错误响应：不含 `data` 字段（与 Python 版一致）。 */
export function err(code: number, msg: string): ApiResponse {
  return { code, msg, requestId: randomUUID() };
}

/**
 * 指标记录的宽松值域（与 `metrics.ts` 的 `MetricsRecord` 一致）。
 *
 * KPI 卡的入参直接取自 `Slice.org`，其类型是 `MetricsRecord`，因此这里必须接受
 * 这个联合类型。Python 的 `metric_card` 同样是**原值透传**（只对 current/previous
 * 做环比运算），故本函数也不做归一化 —— 否则 `null` 会被悄悄变成 `0`。
 */
export type RecordValue = number | string | string[] | null;

/** KPI 卡：含环比与变化方向。`higherIsBetter=false` 用于消耗类指标。 */
export function metricCard(
  key: string,
  name: string,
  current: RecordValue,
  previous: RecordValue,
  unit = '',
  higherIsBetter = true,
): Record<string, unknown> {
  // 环比运算只在数值上成立；这两项在调用点都是数值字段（Python 里同样直接相减）
  const cur = current as number | null;
  const prev = previous as number | null;
  let growth: number;
  let change: string;
  if (prev === null || prev === undefined || prev === 0) {
    [growth, change] = cur ? [0.0, 'new'] : [0.0, 'stable'];
  } else {
    // cur 为 null 时 Python 会在相减处抛 TypeError（不产生响应）；
    // 这里退化为按 0 计算，避免为一个不可能出现的分支让整个请求崩掉
    growth = round2((((cur ?? 0) - prev) / prev) * 100);
    if (Math.abs(growth) < 0.05) change = 'stable';
    else change = growth > 0 ? 'increase' : 'decrease';
  }
  return {
    key,
    name,
    unit,
    current,
    previous,
    growthRate: growth,
    changeType: change,
    higherIsBetter,
  };
}

/** 趋势序列点。 */
export function seriesPoint(
  key: string,
  name: string,
  points: Array<[string, number]>,
  chartType = 'line',
): Record<string, unknown> {
  return {
    key,
    name,
    type: chartType,
    points: points.map(([time, value]) => ({ time, value })),
  };
}
