import type { ITheme } from '@xterm/xterm'

/**
 * xterm 明/暗两套配色，贴合应用主题 token。由 TerminalInstance（终端本体）与
 * BottomPanel（面板底色对齐，消除 FitAddon 取整后的异色边）共用。
 * 暗色主背景与应用暗色底 #1e1e20 对齐。
 */
export const DARK_THEME: ITheme = {
  background: '#1e1e20',
  foreground: '#e4e4e7',
  cursor: '#e4e4e7',
  cursorAccent: '#1e1e20',
  selectionBackground: '#3a3d41',
  black: '#1e1e20',
  red: '#f14c4c',
  green: '#23d18b',
  yellow: '#f5f543',
  blue: '#3b8eea',
  magenta: '#d670d6',
  cyan: '#29b8db',
  white: '#e5e5e5',
  brightBlack: '#7a7a7a',
  brightRed: '#f14c4c',
  brightGreen: '#23d18b',
  brightYellow: '#f5f543',
  brightBlue: '#3b8eea',
  brightMagenta: '#d670d6',
  brightCyan: '#29b8db',
  brightWhite: '#ffffff'
}

export const LIGHT_THEME: ITheme = {
  background: '#ffffff',
  foreground: '#1e1e20',
  cursor: '#1e1e20',
  cursorAccent: '#ffffff',
  selectionBackground: '#c8dcf5',
  black: '#000000',
  red: '#cd3131',
  green: '#00bc00',
  yellow: '#949800',
  blue: '#0451a5',
  magenta: '#bc05bc',
  cyan: '#0598bc',
  white: '#555555',
  brightBlack: '#666666',
  brightRed: '#cd3131',
  brightGreen: '#14ce14',
  brightYellow: '#b5ba00',
  brightBlue: '#0451a5',
  brightMagenta: '#bc05bc',
  brightCyan: '#0598bc',
  brightWhite: '#000000'
}

/** 便捷取背景色（面板底色对齐用）。 */
export function xtermBg(resolved: 'light' | 'dark'): string {
  return resolved === 'dark' ? (DARK_THEME.background as string) : (LIGHT_THEME.background as string)
}
