#!/usr/bin/env bash
# Deva 手机版中转：在服务器上安装或升级（由 scripts/deploy.mjs 上传后执行，也可以手动执行）。
#   bash install.sh          需要 root；不是 root 时自动改用 sudo
# 首次运行：创建运行用户 deva-relay、/opt/deva-relay 与配置文件 /etc/deva-relay/relay.env，注册并启动服务。
# 之后运行：替换程序与手机网页、按本机 node 路径重写服务文件后重启；relay.env 与 data/ 不动。
set -euo pipefail
[ "$(id -u)" -eq 0 ] || exec sudo bash "$0" "$@"

SRC="$(cd "$(dirname "$0")" && pwd)"
APP=/opt/deva-relay
CONF=/etc/deva-relay
UNIT=/etc/systemd/system/deva-relay.service

# 从 /tmp 上传来的临时目录，装完即删；手动在别处执行时不删。
cleanup() { case "$SRC" in /tmp/deva-relay-*) rm -rf "$SRC" ;; esac; }
trap cleanup EXIT

NODE="$(command -v node || true)"
if [ -z "$NODE" ]; then
  echo "服务器上没有找到 Node.js（需要 20 或以上），请先安装。" >&2
  exit 1
fi
if [ "$("$NODE" -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  echo "Node.js 版本过低（$("$NODE" -v)），需要 20 或以上。" >&2
  exit 1
fi
command -v systemctl >/dev/null || { echo "服务器上没有 systemd，请按 README 手动运行 relay.cjs。" >&2; exit 1; }

first=0
[ -f "$UNIT" ] || first=1

id deva-relay >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin deva-relay
mkdir -p "$APP/data" "$CONF"
chown -R deva-relay:deva-relay "$APP/data"

# 程序与网页：先放好新文件再整体替换；data/ 不动。
cp "$SRC/relay.cjs" "$APP/relay.cjs.new"
mv -f "$APP/relay.cjs.new" "$APP/relay.cjs"
rm -rf "$APP/public.new" "$APP/public.old"
cp -r "$SRC/public" "$APP/public.new"
[ -d "$APP/public" ] && mv "$APP/public" "$APP/public.old"
mv "$APP/public.new" "$APP/public"
rm -rf "$APP/public.old"

# 配置：只在第一次写默认值，之后改端口、证书都在这个文件里，部署不覆盖。
if [ ! -f "$CONF/relay.env" ]; then
  cp "$SRC/relay.env" "$CONF/relay.env"
  echo "已写入默认配置 $CONF/relay.env（端口 8787、HTTP）。"
fi

# 服务文件：每次按本机 node 路径重写（配置都在 relay.env 里，这里不需要手改）。
sed "s#__NODE__#$NODE#" "$SRC/deva-relay.service" > "$UNIT"
systemctl daemon-reload
systemctl enable deva-relay >/dev/null 2>&1
systemctl restart deva-relay

# 健康检查：按 relay.env 里的端口、地址与是否启用 HTTPS 请求 /healthz。
val() { sed -n "s/^$1=//p" "$CONF/relay.env" | tail -n 1; }
port="$(val PORT)"; port="${port:-8787}"
host="$(val HOST)"; case "$host" in ''|0.0.0.0|::) host=127.0.0.1 ;; esac
scheme=http; [ -n "$(val TLS_CERT)" ] && scheme=https
ok=0
for _ in $(seq 1 15); do
  sleep 1
  if command -v curl >/dev/null; then
    curl -fsSk --max-time 3 "$scheme://$host:$port/healthz" >/dev/null 2>&1 && { ok=1; break; }
  elif systemctl is-active --quiet deva-relay; then
    ok=1; break
  fi
done
if [ "$ok" -ne 1 ]; then
  echo "中转没有正常启动，最近的日志：" >&2
  journalctl -u deva-relay -n 30 --no-pager >&2 || true
  exit 1
fi

if [ "$first" -eq 1 ]; then
  echo "已安装并启动：$scheme://<服务器地址>:$port（配置 $CONF/relay.env，日志 journalctl -u deva-relay -f）"
else
  echo "已升级并重启：$scheme://<服务器地址>:$port"
fi
