/**
 * 把整个看板打包成**一个自包含的 HTML 文件**（可直接双击打开，离线可用）。
 *
 * 组成：
 *   - JS：esbuild 打包 `standalone/entry.tsx`，含 React + ECharts + 前端页面
 *         + **backend/src 的全部路由与口径实现**（见 backend-in-browser.ts 的说明）
 *   - CSS：直接取 `frontend/dist` 里那份已由 Tailwind 编译好的产物并内联
 *   - 数据：`data/mock_dataset.json` 以字符串形式内嵌，由 `node:fs` 垫片交给 DataSource
 *
 * 为什么不像 Vite 那样从头构建 CSS：Tailwind 需要 PostCSS 流水线。与其在这里
 * 重搭一套，不如复用 `npm run build` 已经产出的那份 —— 保证单文件版与正常版
 * 的样式完全一致。因此**运行本脚本前需要先构建过前端**。
 *
 * 用法：node scripts/build-standalone.mjs [输出路径]
 */

import { build } from 'esbuild';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const frontend = resolve(here, '..'); // ai-efficiency-console-ts/frontend
const project = resolve(frontend, '..'); // ai-efficiency-console-ts
const repo = resolve(frontend, '..', '..'); // 仓库根（当前文件夹）

const datasetFile = resolve(project, 'data/mock_dataset.json');
const distDir = resolve(frontend, 'dist');
const outFile = resolve(process.argv[2] ?? resolve(repo, 'ai-efficiency-console.html'));

// —— 前置检查：缺什么就明确说清怎么补 ——
if (!existsSync(datasetFile)) {
  console.error(`✗ 缺少数据集：${datasetFile}\n  请先执行：npm run gen:mock`);
  process.exit(1);
}
if (!existsSync(resolve(distDir, 'index.html'))) {
  console.error(
    `✗ 缺少前端构建产物：${distDir}\n  请先执行：cd frontend && npm run build\n` +
      `  （单文件版复用 dist 里已编译的 Tailwind 样式，所以必须先构建一次）`,
  );
  process.exit(1);
}

const cssFile = readdirSync(resolve(distDir, 'assets')).find((f) => f.endsWith('.css'));
if (!cssFile) {
  console.error(`✗ dist/assets 下找不到 CSS 产物`);
  process.exit(1);
}
const css = readFileSync(resolve(distDir, 'assets', cssFile), 'utf8');
const datasetJson = readFileSync(datasetFile, 'utf8');

// —— Node 内置模块的浏览器垫片 ——
// 后端代码原样不动，靠这些垫片在浏览器里满足它的 node: 依赖。
// 其中 node:fs 返回的就是内嵌数据集，这正是「单文件也走真实后端实现」的关键。
const NODE_SHIMS = {
  'node:fs': `
    import DATASET_JSON from 'virtual:aec-dataset';
    export const existsSync = () => true;
    export const readFileSync = () => DATASET_JSON;
    export const readdirSync = () => [];
    export const statSync = () => ({ isDirectory: () => false });
  `,
  'node:fs/promises': `
    export const readFile = async () => new Uint8Array();
    export const stat = async () => ({ isDirectory: () => false });
  `,
  'node:path': `
    export const sep = '/';
    export const resolve = (...parts) => parts.filter(Boolean).join('/').replace(/\\/+/g, '/');
    export const join = (...parts) => parts.filter(Boolean).join('/');
    export const dirname = (p) => String(p).replace(/\\/[^/]*$/, '') || '/';
    export const extname = (p) => { const m = /\\.[^./]*$/.exec(String(p)); return m ? m[0] : ''; };
  `,
  'node:url': `
    export const fileURLToPath = (u) => String(u).replace(/^file:\\/\\//, '');
  `,
  'node:crypto': `
    // randomUUID 要求安全上下文。file:// 在 Chrome 下算安全上下文，但仍留兜底，
    // 避免换浏览器或换加载方式时 requestId 直接抛错。
    export const randomUUID = () => {
      if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
        return globalThis.crypto.randomUUID();
      }
      return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        const v = c === 'x' ? r : (r & 0x3) | 0x8;
        return v.toString(16);
      });
    };
  `,
  'node:process': `
    export const env = {};
    export default { env };
  `,
};

const virtualDataset = `export default ${JSON.stringify(datasetJson)};`;

const shimPlugin = {
  name: 'aec-node-shims',
  setup(b) {
    b.onResolve({ filter: /^node:/ }, (args) => ({ path: args.path, namespace: 'node-shim' }));
    b.onResolve({ filter: /^virtual:aec-dataset$/ }, () => ({
      path: 'virtual:aec-dataset',
      namespace: 'aec-virtual',
    }));
    b.onLoad({ filter: /.*/, namespace: 'node-shim' }, (args) => {
      const src = NODE_SHIMS[args.path];
      if (src === undefined) {
        return {
          contents: `throw new Error(${JSON.stringify(`单文件版未提供 ${args.path} 的垫片`)});`,
          loader: 'js',
        };
      }
      return { contents: src, loader: 'js' };
    });
    b.onLoad({ filter: /.*/, namespace: 'aec-virtual' }, () => ({
      contents: virtualDataset,
      loader: 'js',
    }));
  },
};

const result = await build({
  entryPoints: [resolve(frontend, 'standalone/entry.tsx')],
  bundle: true,
  write: false,
  format: 'esm',
  target: ['chrome110'],
  minify: true,
  legalComments: 'none',
  jsx: 'automatic',
  loader: { '.tsx': 'tsx', '.ts': 'ts' },
  define: {
    // 这三个是 Vite 专有的注入，esbuild 不认，必须显式给出。
    // 已用 grep 确认前端源码只用到这三个键，因此不需要再兜底整个 import.meta.env
    // （esbuild 的 define 只接受实体名或合法 JSON，给不了 `({})` 这类表达式）。
    'import.meta.env.VITE_DATA_MODE': '"mock"',
    'import.meta.env.VITE_API_BASE': '""',
    'import.meta.env.VITE_ENTERPRISE_ID': '"1234567890"',
    'process.env.NODE_ENV': '"production"',
  },
  plugins: [shimPlugin],
  logLevel: 'warning',
});

const js = result.outputFiles[0].text;
// `</script` 出现在字符串里会提前闭合脚本块，必须转义
const safeJs = js.replace(/<\/script/gi, '<\\/script');

const html = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="description" content="部门级 AI 用量消耗与代码贡献占比分析看板（单文件版）" />
    <title>AI 效能运营台 · 单文件版</title>
    <style>
${css}
    </style>
  </head>
  <body>
    <div id="root"></div>
    <noscript>本页需要启用 JavaScript。</noscript>
    <script type="module">
${safeJs}
    </script>
  </body>
</html>
`;

writeFileSync(outFile, html);
const mb = (statSync(outFile).size / 1024 / 1024).toFixed(2);
console.log(`✓ 已生成单文件看板：${outFile}`);
console.log(`  体积 ${mb} MB（其中数据集 ${(datasetJson.length / 1024 / 1024).toFixed(2)} MB 内嵌）`);
console.log(`  内含 前端页面 + ECharts + 后端路由与口径实现，离线可直接双击打开`);
