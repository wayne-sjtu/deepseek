/**
 * 单文件版入口。
 *
 * 与 `src/main.tsx` 的唯一区别：
 *   1. 用 `HashRouter` 而不是 `BrowserRouter` —— 单文件是 `file://` 打开的，
 *      BrowserRouter 会拿文件系统路径去匹配路由，必然匹配不到；HashRouter 用
 *      `#/overview` 这种片段，`file://` 下也能正常工作和前进后退。
 *   2. 先安装浏览器内后端，再渲染 —— 否则首屏请求会打在安装之前。
 *   3. 不 import CSS：样式直接取 `dist` 里那份 Tailwind 编译产物并内联，
 *      避免在这里重跑一遍 Tailwind。
 */

import React from 'react';
import ReactDOM from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import App from '../src/App';
import { ScopeProvider } from '../src/lib/ScopeContext';
import { installBackend } from './backend-in-browser';

installBackend();

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <HashRouter>
      <ScopeProvider>
        <App />
      </ScopeProvider>
    </HashRouter>
  </React.StrictMode>,
);
