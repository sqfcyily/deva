import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 一条命令部署到自己的服务器：把 dist/ 经 scp 传到服务器的临时目录，再经 ssh 执行其中的 install.sh
 * （首次安装或升级、重启并做健康检查，见 deploy/install.sh）。先构建（根目录的 `pnpm relay-node:deploy` 会一起做）。
 *
 * 服务器按以下顺序取，填 ssh 能认的写法即可（user@host，或 ~/.ssh/config 里的 Host 别名）：
 *   1. 命令行参数：pnpm relay-node:deploy root@1.2.3.4
 *   2. 环境变量 RELAY_SSH（端口用 RELAY_SSH_PORT）
 *   3. apps/relay-node/deploy.json：{ "ssh": "root@1.2.3.4", "port": 22 }（已加入 .gitignore）
 * 登录用户不是 root 时需要 sudo 权限，install.sh 会自动改用 sudo（必要时在终端里输入密码）。
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dist = resolve(root, 'dist')

function readConfig() {
  const file = resolve(root, 'deploy.json')
  if (!existsSync(file)) return {}
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch (e) {
    console.error(`deploy.json 格式不对：${e.message}`)
    process.exit(1)
  }
}

const cfg = readConfig()
const target = process.argv[2] || process.env.RELAY_SSH || cfg.ssh
const port = process.env.RELAY_SSH_PORT || cfg.port
if (!target) {
  console.error(
    [
      '没有指定服务器。任选一种：',
      '  pnpm relay-node:deploy root@1.2.3.4',
      '  设置环境变量 RELAY_SSH=root@1.2.3.4（端口 RELAY_SSH_PORT）',
      '  在 apps/relay-node/deploy.json 写 { "ssh": "root@1.2.3.4", "port": 22 }'
    ].join('\n')
  )
  process.exit(1)
}
if (!existsSync(resolve(dist, 'relay.cjs')) || !existsSync(resolve(dist, 'install.sh'))) {
  console.error('dist/ 不完整，请在项目根目录执行 pnpm relay-node:deploy（会先构建）')
  process.exit(1)
}

function run(cmd, args) {
  const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit' })
  if (r.error) {
    console.error(`无法运行 ${cmd}：${r.error.message}（需要 OpenSSH 客户端）`)
    process.exit(1)
  }
  if (r.status !== 0) process.exit(r.status ?? 1)
}

const remote = `/tmp/deva-relay-${Date.now().toString(36)}`
console.log(`上传到 ${target}:${remote} …`)
// 用相对路径 dist：Windows 上 D:\… 里的冒号会被 scp 当成主机名分隔符。
run('scp', [...(port ? ['-P', String(port)] : []), '-q', '-r', 'dist', `${target}:${remote}`])
console.log('在服务器上安装 …')
// 有终端时分配 tty，sudo 才能提示输入密码。
run('ssh', [
  ...(port ? ['-p', String(port)] : []),
  ...(process.stdin.isTTY ? ['-t'] : []),
  target,
  `bash ${remote}/install.sh`
])
