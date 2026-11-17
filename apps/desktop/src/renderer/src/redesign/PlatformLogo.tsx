import { Bot } from 'lucide-react'
import devaPhoneLogo from '../assets/platforms/deva-phone.svg'
import feishuLogo from '../assets/platforms/feishu.svg'
import telegramLogo from '../assets/platforms/telegram.svg'

/** 平台标志（「手机」面板：Deva 手机版 / 飞书 / Telegram）。原图自带配色，深浅色下不变。 */
const PLATFORM_ICONS: Record<string, string> = { web: devaPhoneLogo, feishu: feishuLogo, telegram: telegramLogo }

/** 有内置标志的用标志，其余用通用机器人图标。 */
export function PlatformLogo({ platform, size }: { platform: string; size: number }): React.JSX.Element {
  const icon = PLATFORM_ICONS[platform]
  if (icon)
    return <img className="bots-logo bots-logo--img" src={icon} width={size} height={size} alt="" aria-hidden />
  return (
    <span className={`bots-logo bots-logo--${platform}`} style={{ width: size, height: size }} aria-hidden>
      <Bot size={size * 0.55} />
    </span>
  )
}
