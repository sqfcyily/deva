import { renameSync, rmSync, writeFileSync } from 'fs'

/**
 * 原子写：先写同目录 `<file>.tmp` 再 rename 覆盖。进程在写到一半时被杀（强退 / 断电 / 崩溃）
 * 最多丢掉这一次的新内容，**绝不会把旧文件截成半截**——否则读的一方解析失败即当作「不存在 / 空」：
 * 对话凭空消失、config.json 回落成空配置、secrets.json 里的密钥全部丢失。
 * 仅当 rename 失败（Windows 上目标文件被杀毒 / 索引服务短暂占用时可能 EPERM）才回退为直接覆盖写
 * （与旧行为一致）并清掉残留 tmp；tmp 本身写不进（磁盘满等）则原样抛出——此时再去直写只会把
 * 旧文件也截断。`.tmp` 后缀让按扩展名扫描目录的地方（对话索引重建、角色目录）天然跳过它。
 */
export function writeFileAtomic(file: string, data: string): void {
  const tmp = `${file}.tmp`
  writeFileSync(tmp, data, 'utf8')
  try {
    renameSync(tmp, file)
  } catch {
    writeFileSync(file, data, 'utf8')
    try {
      rmSync(tmp, { force: true })
    } catch {
      /* 清理失败无害：下次写入会覆盖 */
    }
  }
}
