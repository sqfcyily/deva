import { useRef } from 'react'

let seq = 0

/**
 * 输入框上方胶囊排（.cf-dock）里的先后：胶囊每次出现时领一个递增序号当 CSS order，新出现的排在最右——
 * 用户的目光先落在一排的末尾。已在的胶囊不挪位，某枚消失也不影响其余几枚的相对先后。
 * 换了会话（key 变）时整排重新领号，同一次渲染里一起出现的按 .cf-dock 里的书写顺序。
 * 只改 order 不动 DOM：胶囊的面板、焦点不受影响，也不会先按书写顺序画一帧再跳位。
 */
export function useDockOrder(visible: boolean, key: string | null): number | undefined {
  const slot = useRef<{ key: string | null; n: number } | null>(null)
  if (!visible) slot.current = null
  else if (!slot.current || slot.current.key !== key) slot.current = { key, n: ++seq }
  return slot.current?.n
}
