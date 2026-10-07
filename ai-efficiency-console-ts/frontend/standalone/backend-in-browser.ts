/**
 * 单文件版：把后端跑在浏览器里。
 *
 * 做法是**拦截 `window.fetch`**，把 `/api/**` 与 `/healthz` 的请求交给后端路由函数
 * 直接处理，其余请求原样透传。这样带来两个好处：
 *   1. 前端源码**一行都不用改**（它照旧 fetch 相对路径）；
 *   2. 打包进来的就是 `backend/src` 的真实实现，单文件版的数字与起服务时**同源**，
 *      不存在"为了做静态页另写一套算法"导致的口径分叉。
 *
 * 数据集由 `node:fs` 垫片提供（见 scripts/build-standalone.mjs），
 * 因此 `DataSource` 那句 `readFileSync` 读到的就是内嵌的数据。
 */

import { DataSource } from '../../backend/src/datasource.ts';
import { route } from '../../backend/src/routes.ts';
import { parseQuery } from '../../backend/src/http/query.ts';
import { ok } from '../../backend/src/http/envelope.ts';

export interface InstalledBackend {
  /** 数据集窗口的最后一天，供页面提示用。 */
  lastDay: string;
}

export function installBackend(): InstalledBackend {
  // 路径只是占位：node:fs 垫片会忽略它，直接返回内嵌数据集
  const ds = new DataSource('/data/mock_dataset.json');
  const originalFetch = window.fetch.bind(window);

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const raw =
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    // 用 location.href 兜底，保证相对路径也能解析
    const parsed = new URL(raw, window.location.href);

    if (!parsed.pathname.startsWith('/api/') && parsed.pathname !== '/healthz') {
      return originalFetch(input as RequestInfo, init);
    }

    const method =
      init?.method ?? (typeof input === 'object' && 'method' in input ? input.method : 'GET');
    let body: Record<string, unknown> = {};
    if (typeof init?.body === 'string' && init.body) {
      try {
        body = JSON.parse(init.body) as Record<string, unknown>;
      } catch {
        body = {}; // 与后端一致：非法 JSON 视为空 body，由下游校验给 400
      }
    }

    let status = 200;
    let payload: unknown;
    try {
      if (parsed.pathname === '/healthz') {
        payload = ok({ status: 'ok', dataset: ds.dataset.meta });
      } else {
        [status, payload] = route(
          ds,
          method.toUpperCase(),
          parsed.pathname,
          parseQuery(parsed.search),
          body,
        );
      }
    } catch (exc) {
      status = 500;
      payload = { code: 50000, msg: `前端内置后端异常: ${(exc as Error).message}` };
    }

    return new Response(JSON.stringify(payload), {
      status,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    });
  };

  return { lastDay: ds.lastDay };
}
