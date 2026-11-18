/** 交付卡（present_files）上一个文件的信息：主进程 deliverables:inspect 返回，渲染层据此绘制。 */
export interface DeliverableInfo {
  path: string
  name: string
  dir: string
  /** 字节数；null = 文件已不存在（被移走或删除）。 */
  size: number | null
  /** 是否允许用默认应用打开（可执行 / 脚本类不允许，只能在文件夹中显示）。 */
  openable: boolean
  /**
   * 文件在某个角色的默认工作区里（见 main/services/role-home.ts）：交付卡的目录一栏写「Deva 的工作区」而不是一长串路径。
   * role = 角色名，rel = 所在目录相对默认工作区的子路径（直接在里面为空串）。
   */
  home?: { role: string; rel: string }
}
