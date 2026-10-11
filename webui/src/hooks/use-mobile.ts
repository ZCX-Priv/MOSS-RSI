import * as React from "react"

const MOBILE_BREAKPOINT = 768

export function useIsMobile() {
  const [isMobile, setIsMobile] = React.useState<boolean | undefined>(undefined)

  React.useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`)
    const onChange = () => {
      setIsMobile(window.innerWidth < MOBILE_BREAKPOINT)
    }
    mql.addEventListener("change", onChange)
    setIsMobile(window.innerWidth < MOBILE_BREAKPOINT)
    return () => mql.removeEventListener("change", onChange)
  }, [])

  return !!isMobile
}

/**
 * 视口宽度（px）实时值：供「右侧面板占整窗比例」「对话区上限」等按窗口宽度换算的布局使用。
 * resize 监听驱动重渲染（仅消费方重渲染，非全局）。
 */
export function useWindowWidth(): number {
  const [width, setWidth] = React.useState<number>(() =>
    typeof window === 'undefined' ? 0 : window.innerWidth,
  )

  React.useEffect(() => {
    const onResize = () => setWidth(window.innerWidth)
    // 挂载时同步一次：初始渲染期与 effect 执行期之间窗口可能已变化
    onResize()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  return width
}
