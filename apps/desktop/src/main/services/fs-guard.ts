import { realpathSync } from 'fs'
import { homedir } from 'os'
import { basename, dirname, join, resolve, sep } from 'path'

/**
 * 受信根守卫（主进程共享）。
 * 「已打开的项目根目录」是被允许读写的区域——无论是 fs IPC 还是 Agent 的文件工具，
 * 都必须先经此校验，杜绝路径穿越。会话中可经用户显式授权临时新增受信根（见 chat.ts 的
 * 「项目外访问询问」）；这类授权是内存态，随重启清空。详见 docs/architecture/security.md。
 */

// 已授权的受信根集合（绝对路径，字面形式）。任何来自渲染层/模型的路径都要先经 isInsideRoot 校验。
const roots = new Set<string>()

/**
 * 解析「真实路径」：跟随符号链接，闭合「链接在根内、目标在根外」的穿越洞。
 * 目标可能尚不存在（如将新建的文件）→ 对最近的存在祖先做 realpath，再把剥下的尾段接回。
 * 任一步失败都回退字面 resolve（不因解析失败而误放行/误拦截）。
 */
function realResolve(p: string): string {
  const abs = resolve(p)
  const tail: string[] = []
  let cur = abs
  // 逐级向上寻找第一个真实存在、可 realpath 的祖先；上限防御异常路径导致的死循环。
  for (let i = 0; i < 4096; i++) {
    try {
      const real = realpathSync.native(cur)
      return tail.length ? join(real, ...tail) : real
    } catch {
      const parent = dirname(cur)
      if (parent === cur) return abs // 触底仍不可解析 → 退回字面
      tail.unshift(basename(cur))
      cur = parent
    }
  }
  return abs
}

/** 登记一个受信根（打开文件夹时，或用户在会话中显式授权项目外目录时）。 */
export function trustRoot(dir: string): void {
  roots.add(resolve(dir))
}

/** 移除一个受信根（用于「仅此次」授权：临时精确放行后撤销）。 */
export function untrustRoot(dir: string): void {
  roots.delete(resolve(dir))
}

/** 当前所有受信根（绝对路径，字面形式）。 */
export function listRoots(): string[] {
  return [...roots]
}

/**
 * target 是否落在某个受信根内。
 * 以「真实路径」比较（realResolve 跟随符号链接）：只要目标的真实路径不在任一受信根的
 * 真实路径之内即视为越界——从而堵住「根内符号链接指向根外」的穿越（旧实现仅 resolve 归一
 * `..` 但不跟随链接，存在真实穿越面）。
 */
export function isInsideRoot(target: string): boolean {
  const real = realResolve(target)
  for (const root of roots) {
    const rootReal = realResolve(root)
    if (real === rootReal || real.startsWith(rootReal + sep)) return true
  }
  return false
}

export function assertInside(target: string): void {
  if (!isInsideRoot(target)) throw new Error('拒绝访问：路径不在已打开的项目内')
}

/**
 * target 是否落在指定目录 dir 之内（含 dir 本身）。以真实路径比较（跟随符号链接）。
 * 用于区分「当前活动工作区」与「其它受信根」：acceptEdits 仅自动接受当前工作区内的写入。
 */
export function isWithinDir(target: string, dir: string | null): boolean {
  if (!dir) return false
  const real = realResolve(target)
  const dreal = realResolve(dir)
  return real === dreal || real.startsWith(dreal + sep)
}

/**
 * Tier-2 受保护目录：仅 `.git`。命中的「写入/编辑」一律静默拒绝；「读取」不受限。
 * 以真实路径的「路径段精确匹配」判定——`.gitignore`、`.github` 不会误命中，只有恰好名为
 * `.git` 的段才算。
 *
 * 为何只剩 `.git`：`.claude` / `.vscode` 已于 2026-09-23 移出——它们是工作区内的**项目配置**
 * （CLAUDE.md、launch.json、tasks.json），让 Agent 代改是高频正当需求，且改动落在 git diff
 * 里用户可见；它们即便被写坏也只影响 Claude Code / VS Code，不提权 Deva 自身。
 *
 * `.git` 则相反，放开成本高、收益近零：
 *  · `.git/hooks/` 写入 = 任意代码执行，而 Deva 自己就在调系统 git（Phase 4）——提权的是自己；
 *  · `.git/config` 的 core.pager / core.editor / core.fsmonitor / alias.* 同样能塞命令；
 *  · `.git/objects`、`.git/refs` 写坏 = 仓库损坏且不可逆；
 *  · Agent 操作 git 走 run_command 或 git IPC 即可，从不需要直接写 `.git/` 下的文件。
 * 刻意不细分到 hooks/config：正当写需求既然为零，精细化只会引入新的判断面与出错面。
 */
const PROTECTED_SEGMENTS = new Set(['.git'])
export function isProtectedPath(target: string): boolean {
  const real = realResolve(target)
  return real.split(/[\\/]+/).some((seg) => PROTECTED_SEGMENTS.has(seg))
}

/**
 * Tier-1 敏感路径硬底：**只剩私钥/凭据目录与本应用自身的配置库**。
 * 命中的路径一律拒绝读写，即便用户在「项目外访问」询问里点了允许——防止把授权流程变成
 * 读 ~/.ssh、~/.deva（本应用密钥库）的后门。以真实路径比较（跟随符号链接），覆盖整个子树。
 *
 * **为何不再含系统目录**（/etc、/proc、/sys、/dev、Windows 目录已于 2026-09-23 移出）：
 * Deva 的定位是「默认开启 auto 模式的 Claude Code」，代改配置文件（nginx、hosts、systemd）
 * 是真实且高频的需求，Claude Code 本身也不设这类硬名单。何况写系统目录本就要 root/管理员——
 * **OS 权限才是那层真正的地板**；在它之上再叠一层，挡掉的主要是无害的「读」，却挡不住真有
 * 风险的场景（以 root 跑时 OS 地板消失，而 exec 通道本就不查本函数）。方向是反的，故移除。
 *
 * 留下的两类是**同质**的——整块放开没有正当收益，不像系统目录那样良莠混杂：
 *  · ~/.ssh、~/.aws、~/.gnupg —— 目录里全是私钥/凭据，Agent 从无正当理由读写；
 *  · ~/.deva —— 本应用的配置与密钥库（secrets.json）。要改这里的配置应走受控接口
 *    （create_skill / create_mcp / propose_agent / create_task 已各自开口），而非直接写文件。
 *
 * ⚠️ 作用范围仅限**文件工具通道**（read_file / glob / grep / write_file / edit_file）。
 * `run_command` 的子进程不经过本函数，shell 可直接 `cat ~/.ssh/id_rsa`——exec 侧另由
 * exec-policy.touchesSensitivePath 按命令文本兜一层启发式，但那不是密封边界（可变形绕过）。
 * 换言之：本函数挡的是路径穿越，不等于「~/.ssh 绝不可被 Agent 访问」。要做到后者需把 exec
 * 沙箱化（容器 / 受限用户）。别在别处依赖「Tier-1 已密封」这个并不成立的前提。
 */
export function isSensitivePath(target: string): boolean {
  const real = realResolve(target)
  for (const d of sensitiveDirs()) {
    if (real === d || real.startsWith(d + sep)) return true
  }
  return false
}

/** 敏感目录清单（真实路径，模块级缓存）。已与平台无关：系统目录不再入列，理由见 isSensitivePath。 */
let SENSITIVE_CACHE: string[] | null = null
function sensitiveDirs(): string[] {
  if (SENSITIVE_CACHE) return SENSITIVE_CACHE
  const home = homedir()
  SENSITIVE_CACHE = [
    join(home, '.ssh'),
    join(home, '.aws'),
    join(home, '.gnupg'),
    join(home, '.deva') // 本应用的配置/密钥库；改配置走 create_* 等受控接口，不直接写文件
  ].map((d) => realResolve(d))
  return SENSITIVE_CACHE
}
