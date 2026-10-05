#!/usr/bin/env node
/**
 * 服务入口 —— 对应 Python `server.py` 的 `main()`。
 *
 * 用法
 * ----
 *   node backend/src/server.ts                        # 默认 :8000，托管 frontend/dist
 *   node backend/src/server.ts --port 8001
 *   node backend/src/server.ts --dataset /path/to.json
 *   node backend/src/server.ts --selftest              # 跑一遍自检后退出
 *
 * 零依赖：只用 node:http，不引入任何 npm 运行时包。
 */

import { createServer } from 'node:http';
import process from 'node:process';

import { DataSource, DatasetMissingError, DEFAULT_DATASET_PATH } from './datasource.ts';
import { createHandler } from './http/server.ts';
import { selftest } from './selftest.ts';

interface Args {
  port: number;
  host: string;
  dataset: string;
  selftest: boolean;
}

/** 手写参数解析（零依赖，不引 commander/yargs）。 */
function parseArgs(argv: string[]): Args {
  const args: Args = {
    port: Number(process.env.PORT ?? 8000),
    host: '127.0.0.1',
    dataset: DEFAULT_DATASET_PATH,
    selftest: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    switch (flag) {
      case '--port':
        args.port = Number(argv[++i]);
        break;
      case '--host':
        args.host = argv[++i] ?? args.host;
        break;
      case '--dataset':
        args.dataset = argv[++i] ?? args.dataset;
        break;
      case '--selftest':
        args.selftest = true;
        break;
      default:
        if (flag?.startsWith('--')) {
          console.error(`未知参数：${flag}`);
          process.exit(2);
        }
    }
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  let ds: DataSource;
  try {
    ds = new DataSource(args.dataset);
  } catch (exc) {
    if (exc instanceof DatasetMissingError) {
      console.error(exc.message);
      process.exit(1);
    }
    throw exc;
  }

  if (args.selftest) {
    process.exit(await selftest(ds));
  }

  const server = createServer(createHandler(ds));
  server.listen(args.port, args.host, () => {
    const shown = args.host === '127.0.0.1' ? '127.0.0.1' : args.host;
    console.log(`AI 效能运营台 Mock API  ->  http://${shown}:${args.port}`);
    console.log(`  数据集: ${args.dataset}`);
    console.log(
      `  企业: ${ds.enterpriseId} / 成员 ${ds.members.length} / 日记录 ${ds.dataset.series.length}`,
    );
    console.log(`  自检: npm run selftest`);
  });

  server.on('error', (exc: NodeJS.ErrnoException) => {
    if (exc.code === 'EADDRINUSE') {
      console.error(
        `端口 ${args.port} 已被占用。换个端口（--port 8001），` +
          `或先停掉占用该端口的进程（原 Python 版默认也用 8000）。`,
      );
      process.exit(1);
    }
    throw exc;
  });

  const shutdown = (): void => {
    console.log('\n已停止');
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((exc: unknown) => {
  console.error(exc instanceof Error ? exc.message : String(exc));
  process.exit(1);
});
