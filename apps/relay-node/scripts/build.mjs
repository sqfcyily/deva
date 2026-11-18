import { build } from 'esbuild'
import { cpSync, existsSync, rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 打包成可直接部署的 dist/：
 *   relay.cjs           中转程序（已把 ws 打包进去，服务器上不需要 npm install）
 *   public/             手机网页（apps/desktop 构建出的 out/mobile）
 *   deva-relay.service  systemd 服务（node 路径由 install.sh 填入）
 *   relay.env           默认配置（首次安装时复制到 /etc/deva-relay/）
 *   install.sh          在服务器上安装或升级（pnpm relay-node:deploy 会自动上传并执行）
 * 先在 apps/desktop 跑 `pnpm build:mobile`（根目录的 `pnpm relay-node:build` 会一起做）。
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dist = resolve(root, 'dist')
const page = resolve(root, '../desktop/out/mobile')

if (!existsSync(resolve(page, 'index.html'))) {
  console.error(`没有找到手机网页构建产物：${page}\n请先在 apps/desktop 执行 pnpm build:mobile，或在项目根目录执行 pnpm relay-node:build`)
  process.exit(1)
}

rmSync(dist, { recursive: true, force: true })
await build({
  entryPoints: [resolve(root, 'src/index.ts')],
  outfile: resolve(dist, 'relay.cjs'),
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  // ws 的可选加速模块：没装时 ws 自动改用纯 JS 实现。
  external: ['bufferutil', 'utf-8-validate'],
  legalComments: 'none',
  logLevel: 'warning'
})
cpSync(page, resolve(dist, 'public'), { recursive: true })
for (const f of ['deva-relay.service', 'relay.env', 'install.sh']) cpSync(resolve(root, 'deploy', f), resolve(dist, f))
console.log(`已构建到 ${dist}`)
