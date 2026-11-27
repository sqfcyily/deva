# Headless Web · 基础文字对话

在没有桌面的 Linux 主机上运行一个单所有者文字聊天服务。浏览器可新建会话、接收流式回复、停止生成并重开历史。使用桌面同源的样式、发送/停止控件和 OpenAI Chat Completions 适配器。运行镜像只有 Node 22 和编译产物，无 Electron、X11、VNC 或手机中转。此入口不加载桌面 Agent、工具或扩展。

## 用 Compose 运行

以下命令在仓库根目录的 Bash 中执行。示例使用一个 OpenAI 兼容模型；地址含服务商要求的 `/v1` 前缀，模型名换成账号确实可用的 ID：

```bash
export DEVA_MODEL_BASE_URL=https://api.openai.com/v1
export DEVA_MODEL=gpt-4.1-mini
read -rsp '模型 API key: ' DEVA_MODEL_API_KEY; echo; export DEVA_MODEL_API_KEY
export DEVA_WEB_TOKEN="$(openssl rand -hex 32)"
docker compose up --build -d --wait
printf '浏览器登录令牌：%s\n' "$DEVA_WEB_TOKEN"
```

打开 **http://127.0.0.1:8787**，用上面的 **Web 令牌**登录（不是模型密钥）。点击「新建」，输入文字并发送；回复过程中可点「停止」。在另一台电脑使用时，可以先运行 `ssh -L 8787:127.0.0.1:8787 user@server`，再打开相同的本地地址。页面和服务无需第三方中转。

在同一套部署环境中运行 `docker compose up -d --force-recreate --wait`，重新登录，再点之前的会话继续聊。命名卷 `deva-data` 保留历史；`docker compose down` 保留卷，`down -v` 会删除它。普通服务进程重启会使旧登录失效。停止后保留已经生成的文字，刷新或重启不会自行重发上一条消息。

[查看真实浏览器截图：服务重启并重新登录后，完整回复与已停止的回复都保留在原会话中。](../../../../docs/headless-chat.png) 图中均为本地测试对话。

## 配置与范围

- `DEVA_WEB_TOKEN` 是部署者保管的高熵登录令牌（32–128 个 base64url 字符）；`DEVA_MODEL_API_KEY` 只注入服务端，使用无密钥本地模型时留空。Compose 会把这些环境变量交给容器，Docker 管理员可读取；长期部署请用私有环境文件或部署平台管理，勿提交到 Git。浏览器登录 Cookie 为 HttpOnly、SameSite=Strict，默认 8 小时有效。
- 默认只发布到宿主 `127.0.0.1:8787`。`DEVA_PORT` 改端口，`DEVA_BIND` 改 Docker 发布地址。反代访问时设置 `DEVA_ORIGIN=https://deva.example.org` 为用户实际打开的源，反代保留其 Host、使用 TLS 并关闭流式响应缓冲。服务端校验 Host 和写请求 Origin，没有面向跨域应用的 API。`/healthz` 只检查服务存活，不请求模型。
- `DEVA_MODEL` 和 `DEVA_MODEL_BASE_URL` 由部署者指定；浏览器不能更换上游地址。远程模型使用 HTTPS。keyless 本地服务可用受信网络内的 HTTP 地址，例如同一 Docker 网络里的 `http://ollama:11434/v1`。容器里的 `127.0.0.1` 指容器自身。
- `DEVA_HOME` 对应容器内 `/data`，首次须为空且仅运行用户可访问。运行时持有单写者锁；使用此服务专用的卷，而非正在使用的桌面数据目录。只打开本入口创建的原生文字会话文件。每条输入至多 8 KiB、回复 64 KiB，每次等待最多 2 分钟；每个实例至多 64 个会话、2 个在途回复，每个会话至多 128 轮并受 256 KiB 历史预算限制。没有自动压缩、附件、文件管理或命令执行。

## 从源码验证

```bash
pnpm install --frozen-lockfile
pnpm --filter @deva/desktop build:headless
node --test apps/desktop/test/headless-chat.test.mjs
```

该测试以本地合成模型的真实 HTTP/SSE 回应验证登录、流式回复、停止、服务进程重启和继续对话，无需生产密钥。运行已构建的 Linux 服务：沿用上面的部署变量，执行 `node apps/desktop/out/headless/server.mjs`。原生入口默认监听 `127.0.0.1`，可用 `DEVA_HOST` 配置，专用数据目录默认 `~/.deva-web`。
