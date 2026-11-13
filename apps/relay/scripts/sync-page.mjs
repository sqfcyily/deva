import { cpSync, existsSync, rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 把桌面端构建出的手机网页（apps/desktop/out/mobile）复制到 public/，作为 Worker 的静态资源一起部署。
 * 先在 apps/desktop 跑 `pnpm build:mobile`。
 */
const here = dirname(fileURLToPath(import.meta.url))
const src = resolve(here, '../../desktop/out/mobile')
const dst = resolve(here, '../public')

if (!existsSync(resolve(src, 'index.html'))) {
  console.error(`没有找到手机网页构建产物：${src}\n请先在 apps/desktop 执行 pnpm build:mobile`)
  process.exit(1)
}
rmSync(dst, { recursive: true, force: true })
cpSync(src, dst, { recursive: true })
console.log(`已复制手机网页到 ${dst}`)
