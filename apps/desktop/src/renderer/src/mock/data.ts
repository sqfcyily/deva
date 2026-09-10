/**
 * 外观阶段的演示数据。集中管理，供侧边导航与中央内容视图共享，
 * 后续接入真实 IPC / 服务时整体替换此文件即可。
 */

/* ---------------- 项目（顶部可切换、可多开） ---------------- */
export interface Project {
  id: string
  name: string
  path: string
  branch: string
}

export const projects: Project[] = [
  { id: 'deva', name: 'deva', path: 'D:/project/sqf/space1/deva', branch: 'main' },
  { id: 'user-service', name: 'user-service', path: 'D:/work/user-service', branch: 'feat/login' },
  { id: 'web-admin', name: 'web-admin', path: 'D:/work/web-admin', branch: 'develop' }
]

/* ---------------- 资源管理器：文件树 + 文件内容 ---------------- */
export interface FileNode {
  id: string
  name: string
  type: 'dir' | 'file'
  depth: number
  open?: boolean
  lang?: string
}

export const fileTree: FileNode[] = [
  { id: 'src', name: 'src', type: 'dir', depth: 0, open: true },
  { id: 'src/main', name: 'main', type: 'dir', depth: 1, open: true },
  { id: 'src/main/UserService.java', name: 'UserService.java', type: 'file', depth: 2, lang: 'java' },
  { id: 'src/main/UserController.java', name: 'UserController.java', type: 'file', depth: 2, lang: 'java' },
  { id: 'src/main/application.yml', name: 'application.yml', type: 'file', depth: 2, lang: 'yaml' },
  { id: 'src/test', name: 'test', type: 'dir', depth: 1, open: false },
  { id: 'pom.xml', name: 'pom.xml', type: 'file', depth: 0, lang: 'xml' },
  { id: 'README.md', name: 'README.md', type: 'file', depth: 0, lang: 'markdown' }
]

export interface FileContent {
  lang: string
  lines: string[]
}

export const fileContents: Record<string, FileContent> = {
  'src/main/UserService.java': {
    lang: 'java',
    lines: [
      'package com.sqfcy.user.service;',
      '',
      'import com.sqfcy.user.domain.User;',
      'import com.sqfcy.user.repo.UserRepository;',
      'import org.springframework.stereotype.Service;',
      'import java.util.Optional;',
      '',
      '@Service',
      'public class UserService {',
      '',
      '    private final UserRepository userRepository;',
      '',
      '    public UserService(UserRepository userRepository) {',
      '        this.userRepository = userRepository;',
      '    }',
      '',
      '    public Optional<User> findByEmail(String email) {',
      '        return userRepository.findByEmail(email);',
      '    }',
      '}'
    ]
  },
  'src/main/application.yml': {
    lang: 'yaml',
    lines: [
      'server:',
      '  port: 8080',
      'spring:',
      '  datasource:',
      '    url: jdbc:mysql://localhost:3306/app',
      '    username: root',
      '  redis:',
      '    host: localhost',
      '    port: 6379'
    ]
  },
  'README.md': {
    lang: 'markdown',
    lines: [
      '# user-service',
      '',
      '用户中心微服务，提供注册、登录、鉴权能力。',
      '',
      '## 快速开始',
      '',
      '```bash',
      'mvn spring-boot:run',
      '```'
    ]
  }
}

/* ---------------- 数据库：连接 / 表 / 结构 / 数据 ---------------- */
export interface DbColumn {
  name: string
  type: string
  nullable: boolean
  key: string
}
export interface DbTable {
  id: string
  name: string
  columns: DbColumn[]
  rows: Record<string, string>[]
}
export interface DbConnection {
  id: string
  name: string
  kind: 'mysql' | 'redis'
  open: boolean
  tables: DbTable[]
}

export const dbConnections: DbConnection[] = [
  {
    id: 'mysql-local',
    name: 'localhost:3306 · mysql',
    kind: 'mysql',
    open: true,
    tables: [
      {
        id: 'users',
        name: 'users',
        columns: [
          { name: 'id', type: 'bigint', nullable: false, key: 'PK' },
          { name: 'email', type: 'varchar(128)', nullable: false, key: 'UNI' },
          { name: 'nickname', type: 'varchar(64)', nullable: true, key: '' },
          { name: 'status', type: 'tinyint', nullable: false, key: '' },
          { name: 'created_at', type: 'datetime', nullable: false, key: '' }
        ],
        rows: [
          { id: '1', email: 'alice@sqfcy.dev', nickname: 'Alice', status: '1', created_at: '2026-08-01 09:12' },
          { id: '2', email: 'bob@sqfcy.dev', nickname: 'Bob', status: '1', created_at: '2026-08-03 14:20' },
          { id: '3', email: 'carol@sqfcy.dev', nickname: 'Carol', status: '0', created_at: '2026-08-09 21:05' }
        ]
      },
      {
        id: 'orders',
        name: 'orders',
        columns: [
          { name: 'id', type: 'bigint', nullable: false, key: 'PK' },
          { name: 'user_id', type: 'bigint', nullable: false, key: 'MUL' },
          { name: 'amount', type: 'decimal(10,2)', nullable: false, key: '' },
          { name: 'paid', type: 'tinyint', nullable: false, key: '' }
        ],
        rows: [
          { id: '1001', user_id: '1', amount: '199.00', paid: '1' },
          { id: '1002', user_id: '2', amount: '59.90', paid: '0' }
        ]
      }
    ]
  },
  { id: 'redis-local', name: 'localhost:6379 · redis', kind: 'redis', open: false, tables: [] }
]

/* ---------------- SSH 主机 ---------------- */
export interface SshHost {
  id: string
  name: string
  addr: string
  user: string
  online: boolean
}

export const sshHosts: SshHost[] = [
  { id: 'prod-web-01', name: 'prod-web-01', addr: '10.0.1.12', user: 'deploy', online: true },
  { id: 'staging-db', name: 'staging-db', addr: '10.0.2.30', user: 'root', online: true },
  { id: 'build-runner', name: 'build-runner', addr: '192.168.1.50', user: 'ci', online: false }
]
