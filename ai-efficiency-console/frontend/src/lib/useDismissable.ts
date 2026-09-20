import { useEffect, useRef, useState } from 'react'

/**
 * 弹出层（下拉 / 菜单 / 气泡卡片）的收起行为。
 *
 * 为什么需要它：只靠「点触发按钮切换」是不够的 —— 用户点开之后往往会去点别处（换个筛选项、
 * 看图表），此时面板必须自己收起来，否则它会一直压在内容上。这是弹层最基本的可预期行为，
 * 容易在只用 `useState` 手写时被漏掉。
 *
 * 收起触发：
 *   1. 点击 / 触摸面板与触发器之外的区域；
 *   2. 按 Esc；
 *   3. 调用方显式 `close()`（例如执行完某个动作后）。
 *
 * 返回的 `ref` 必须挂到**同时包含触发器与面板**的最外层元素上，
 * 否则点触发器会被判定为「外部点击」，先收起再被 onClick 打开，表现为点了没反应。
 */
export function useDismissable<T extends HTMLElement = HTMLDivElement>(initialOpen = false) {
  const [open, setOpen] = useState(initialOpen)
  const ref = useRef<T | null>(null)

  useEffect(() => {
    if (!open) return

    const isOutside = (target: EventTarget | null) => {
      const node = ref.current
      return Boolean(node && target instanceof Node && !node.contains(target))
    }

    // 同时监听 pointerdown 与 mousedown：
    // - pointerdown 在触屏上更及时（无 300ms 延迟）；
    // - mousedown 作为兜底，覆盖只派发鼠标事件的环境（部分自动化/旧浏览器）。
    // 用 once 标记避免同一次点击被处理两次（真实浏览器两者都会派发）。
    let handled = false
    const onPointerLike = (event: Event) => {
      if (handled) return
      handled = true
      // 同一宏任务里的第二个事件忽略；下一帧复位
      setTimeout(() => {
        handled = false
      }, 0)
      if (isOutside(event.target)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }

    document.addEventListener('pointerdown', onPointerLike as EventListener)
    document.addEventListener('mousedown', onPointerLike)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerLike as EventListener)
      document.removeEventListener('mousedown', onPointerLike)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  return {
    open,
    ref,
    toggle: () => setOpen((value) => !value),
    close: () => setOpen(false),
    setOpen,
  }
}
