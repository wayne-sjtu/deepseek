/**
 * 数据源层 —— Python `server.py` 里 `DataSource` 类的对应物。
 *
 * 职责边界（对应原项目的核心约束）
 * -------------------------------
 * 本文件**不做任何指标聚合**。它只负责：
 *   1. 装载 mock 数据集并预建索引（索引构建与切片委托给 `metrics.ts`）；
 *   2. 提供时间窗口工具（默认区间、环比对照区间）；
 *   3. 持有可写的运行时状态（额度覆盖值与调整审计）。
 *
 * 二期接入真实企业 OpenAPI 时，替换的正是这一层 —— 页面与口径都不该动。
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { aggregate, buildIndexes } from './metrics.ts';
// Index / Slice 是口径的产物，归 metrics.ts 拥有；types.ts 只描述数据形状。
import type { Index, Slice } from './metrics.ts';
import type { Dataset, DefaultQuota } from './types.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
/** 仓库根 = backend/src -> backend -> <root> */
export const ROOT = resolve(HERE, '..', '..');
export const DEFAULT_DATASET_PATH = resolve(ROOT, 'data', 'mock_dataset.json');
export const DIST_DIR = resolve(ROOT, 'frontend', 'dist');

/** 数据集缺失时的可执行指引 —— 不要把 ENOENT 直接抛给上层。 */
export class DatasetMissingError extends Error {
  // 注意：这里必须显式声明字段，不能用构造函数参数属性
  // （`constructor(public readonly path: string)`）—— 那属于不可擦除语法，
  // Node 的 strip-only 模式会直接抛 ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX。
  readonly path: string;

  constructor(path: string) {
    super(
      `未找到 mock 数据集：${path}\n` +
        `数据集由生成器产出且不入库，请先执行：\n` +
        `    npm run gen:mock\n` +
        `（可用 AEC_REFERENCE_DAY=YYYY-MM-DD 钉住数据窗口终点以获得可复现的数据）`,
    );
    this.name = 'DatasetMissingError';
    this.path = path;
  }
}

// ---------------------------------------------------------------------------
// 纯日期工具：只处理 ISO 日期串（YYYY-MM-DD），统一用 UTC 避免夏令时干扰
// ---------------------------------------------------------------------------
export function parseDate(iso: string): Date {
  return new Date(`${iso}T00:00:00Z`);
}

export function toIso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function addDays(iso: string, days: number): string {
  const d = parseDate(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return toIso(d);
}

/** 两个 ISO 日期相差的天数（b - a）。 */
export function diffDays(a: string, b: string): number {
  return Math.round((parseDate(b).getTime() - parseDate(a).getTime()) / 86400000);
}

export class DataSource {
  readonly path: string;
  dataset!: Dataset;
  index!: Index;
  members!: Dataset['members'];
  memberById!: Map<string, Dataset['members'][number]>;
  memberByName!: Map<string, Dataset['members'][number]>;
  enterpriseId!: string;
  referenceDay!: string | undefined;
  /** 可写的额度覆盖值（运行时状态，不落盘） */
  defaultQuota!: DefaultQuota;
  /** 额度调整审计 */
  audit: Array<Record<string, unknown>> = [];

  constructor(path: string = DEFAULT_DATASET_PATH) {
    this.path = path;
    this.reload();
  }

  reload(): void {
    if (!existsSync(this.path)) throw new DatasetMissingError(this.path);
    this.dataset = JSON.parse(readFileSync(this.path, 'utf8')) as Dataset;
    this.index = buildIndexes(this.dataset);
    this.members = this.dataset.members;
    this.memberById = new Map(this.members.map((m) => [m.userId, m]));
    this.memberByName = new Map(this.members.map((m) => [m.userName, m]));
    this.enterpriseId = this.dataset.meta.enterpriseId;
    this.referenceDay = this.dataset.meta.referenceDay;
    this.defaultQuota = { ...this.dataset.defaultQuota };
    this.audit = [];
  }

  /** 数据窗口的最后一天。 */
  get lastDay(): string {
    return this.index.days[this.index.days.length - 1]!;
  }

  /** 解析请求区间：缺省时回落到「最后一天往前 defaultDays 天」，并保证 start <= end。 */
  resolveRange(
    start: string | null | undefined,
    end: string | null | undefined,
    defaultDays = 30,
  ): [string, string] {
    let e = (end || this.lastDay).slice(0, 10);
    let s: string;
    if (!start) {
      s = addDays(e, -(defaultDays - 1));
    } else {
      s = start.slice(0, 10);
    }
    if (s > e) [s, e] = [e, s];
    return [s, e];
  }

  /** 等长紧邻的环比对照区间。 */
  previousRange(start: string, end: string): [string, string] {
    const span = diffDays(start, end) + 1;
    const prevEnd = addDays(start, -1);
    const prevStart = addDays(prevEnd, -(span - 1));
    return [prevStart, prevEnd];
  }

  /** 按 [start, end] 闭区间聚合，可选按成员 / 部门下钻。口径实现在 metrics.ts。 */
  slice(
    start: string,
    end: string,
    userIds?: Set<string> | null,
    departmentIds?: Set<string> | null,
  ): Slice {
    return aggregate(this.dataset, this.index, start, end, userIds ?? null, departmentIds ?? null);
  }
}
