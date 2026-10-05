/**
 * HTTP 层 —— `frontend/dist` 与 API 同源托管。
 *
 * 历史教训（原注释保留在此，避免重犯）
 * ----------------------------------
 * `/` 曾被错误地归类为接口路径，于是静态入口返回 404（`未实现的接口: GET /`）。
 * 当时自检直接调用 `route()` 因而完全没发现 —— 路由分类是 **HTTP 层**行为，
 * 必须在 HTTP 层验证。因此本文件的分类逻辑是：
 *
 *     只有 `/api/**` 与 `/healthz` 走接口路由，其余一律按静态资源处理（含 SPA 回退）。
 */

import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, resolve, sep } from 'node:path';

import { DIST_DIR } from '../datasource.ts';
import type { DataSource } from '../datasource.ts';
import { route } from '../routes.ts';
import { err, ok } from './envelope.ts';
import { parseQuery } from './query.ts';

const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.htm': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json',
  '.txt': 'text/plain',
  '.wasm': 'application/wasm',
};

function mimeOf(file: string): string {
  return MIME[extname(file).toLowerCase()] ?? 'application/octet-stream';
}

/** CORS 与缓存头，与 Python 版逐条一致。 */
function applyCommonHeaders(res: ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type,Authorization,X-Enterprise-Id',
  );
  res.setHeader('Cache-Control', 'no-store');
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const raw = Buffer.from(JSON.stringify(payload), 'utf8');
  // 必须先 setHeader 再 writeHead：writeHead 会立即把响应头发出去，
  // 之后再 setHeader 会抛 ERR_HTTP_HEADERS_SENT（CORS 头也就丢了）。
  applyCommonHeaders(res);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(raw.length),
  });
  res.end(raw);
}

async function sendFile(res: ServerResponse, status: number, file: string): Promise<void> {
  const raw = await readFile(file);
  applyCommonHeaders(res);
  res.writeHead(status, {
    'Content-Type': mimeOf(file),
    'Content-Length': String(raw.length),
  });
  res.end(raw);
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return {}; // 与 Python 版一致：非法 JSON 视为空 body，由下游校验给 400
  }
}

/** 静态资源 + SPA 深链回退。 */
async function serveStatic(res: ServerResponse, pathname: string): Promise<void> {
  const indexFile = resolve(DIST_DIR, 'index.html');

  if (!existsSync(indexFile)) {
    // 前端未构建：给可执行的指引，而不是无信息量的 404
    sendJson(
      res,
      200,
      ok({
        name: 'AI 效能运营台 Mock API',
        hint:
          '前端尚未构建。执行 `cd frontend && npm install && npm run build` 后刷新本页；' +
          '开发态请访问 `npm run dev` 输出的地址（默认 http://127.0.0.1:5173）。',
        apiIndex: '/api/v1/efficiency/overview?startTime=2026-08-22&endTime=2026-09-20',
      }),
    );
    return;
  }

  const rel = pathname.replace(/^\/+/, '') || 'index.html';
  const root = resolve(DIST_DIR);
  let target = resolve(root, rel);

  // 路径穿越防护（等价 Python 的 `root not in target.parents` 判定）
  if (target !== root && !target.startsWith(root + sep)) {
    sendJson(res, 403, err(40300, '非法路径'));
    return;
  }

  try {
    const info = await stat(target);
    if (info.isDirectory()) target = resolve(target, 'index.html');
  } catch {
    /* 交给下面的 SPA 回退处理 */
  }

  if (!existsSync(target) || (await stat(target)).isDirectory()) {
    target = indexFile; // SPA 回退：/overview、/members/:id 等前端路由
  }

  await sendFile(res, 200, target);
}

export function createHandler(ds: DataSource) {
  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = (req.method ?? 'GET').toUpperCase();
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const pathname = url.pathname;

    if (method === 'OPTIONS') {
      // 同样必须先设头再 writeHead（见 sendJson 的说明）
      applyCommonHeaders(res);
      res.writeHead(204);
      res.end();
      return;
    }

    // —— 路由分类：这是 HTTP 层行为，必须在此判定 ——
    const isApi = pathname.startsWith('/api/') || pathname === '/healthz';

    if (!isApi) {
      if (method !== 'GET') {
        sendJson(res, 405, err(40500, `${method} 不支持该路径: ${pathname}`));
        return;
      }
      await serveStatic(res, pathname);
      return;
    }

    let status: number;
    let payload: unknown;
    try {
      if (pathname === '/healthz') {
        status = 200;
        payload = ok({ status: 'ok', dataset: ds.dataset.meta });
      } else {
        const body = method === 'POST' || method === 'PUT' ? await readJsonBody(req) : {};
        [status, payload] = route(
          ds,
          method,
          pathname,
          parseQuery(url.search),
          body as Record<string, unknown>,
        );
      }
    } catch (exc) {
      console.error(exc);
      const message = exc instanceof Error ? exc.message : String(exc);
      status = 500;
      payload = err(50000, `服务端异常: ${message}`);
    }
    sendJson(res, status, payload);
  };
}
