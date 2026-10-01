/** 构建时由 electron.vite.config.ts 的 define 注入，值取自 apps/desktop/package.json。 */
declare const __APP_VERSION__: string

/** 静态资源（vite 构建为带哈希的 URL）。 */
declare module '*.svg' {
  const src: string
  export default src
}
