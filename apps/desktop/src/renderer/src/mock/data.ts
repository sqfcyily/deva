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
