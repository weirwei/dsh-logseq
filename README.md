# dsh-logseq-sync

DeepSeek Harness (dsh) 插件：在 dsh 容器里无头运行 Logseq 2.0 CLI，把 DB 图谱（含 E2EE 加密图谱）和 Logseq 同步服务器保持同步，并给 agent 提供读写工具。

不需要改 docker-compose，也不需要换镜像：运行时、数据、凭据全部放在 dsh-home 卷里的 `~/.dsh/logseq/`。

## 工作方式

```
agent ──logseq_* 工具──> logseq CLI ──> db-worker-node（每个图谱一个常驻进程）
                                              │  本地 db.sqlite（读写）
                                              └─ websocket ──> 同步服务器（E2EE 在本地加解密）
```

- 首次加载时下载官方 Linux 发行包（约 180MB，只下载一次），从 `app.asar` 里取出 `js/logseq-cli.js` 和 `js/db-worker-node.js` 两个纯 JS 文件，放到 `~/.dsh/logseq/runtime/<版本>/`。原生模块一个都不用：`keytar` 换成文件实现的桩，`ws` 用插件自带的依赖。
- 同步守护：图谱本地没有就 `sync download`，然后 `sync start`；之后每 60s 检查一次 `sync status`，websocket 没连上就重启，失败时指数退避（最长 15 分钟）。
- 工具写的是本地副本，由同一个 worker 推送到服务器。

## 安装

1. 在 `.env.prod` 的 `DSH_PLUGINS` 里加上 `dsh-logseq-sync`，或者在 Web UI 的插件市场里安装。
2. 在服务器上准备 `${DATA_DIR}/dsh-home/logseq/`（容器内路径是 `/root/.dsh/logseq/`）：

   `config.json`：

   ```json
   {
     "server": "https://logseq-sync.example.com",
     "graphs": ["Miki", "Daily"],
     "e2eePassword": "<E2EE 密码>"
   }
   ```

   `auth.json`：从已登录的桌面端复制 `~/logseq/auth.json`。插件会把它拷进 CLI 的根目录，之后 CLI 会自己用 refresh token 续期。

   ```bash
   chmod 600 config.json auth.json
   ```

   不确定 E2EE 密码时，先在本机运行 `LOGSEQ_SERVER=<同步服务器地址> scripts/verify-e2ee-password.sh` 检查。它只下载并尝试解开服务器上的加密私钥，不上传任何东西。

3. 重启 dsh：`docker restart dsh-prod`。查看进度：`tail -f ${DATA_DIR}/dsh-home/logseq/plugin.log`。

## 配置项（config.json）

| 键 | 默认值 | 说明 |
|---|---|---|
| `server` | — | 同步服务器地址；不填就不同步，工具只操作本地图谱 |
| `wsUrl` | `wss://<server>/sync/%s` | websocket 地址模板 |
| `graphs` | `[]` | 要同步的图谱；第一个是工具的默认图谱 |
| `e2eePassword` | — | 加密图谱的密码 |
| `oauthTokenEndpoint` | Logseq 官方 Cognito | 续期 token 的地址。插件会把它写进 CLI 的 `cli.edn`，否则 CLI 会去请求 `<server>/oauth2/token`，自建服务器上是 404 |
| `readOnly` | `false` | 只注册读工具 |
| `logseqVersion` | `2.0.2` | 从哪个 Logseq release 里提取运行时 |
| `runtimeUrl` / `runtimeAsar` | — | 发行包的镜像下载地址，或者直接指定本地 `app.asar` |
| `statusIntervalMs` | `60000` | 同步健康检查的间隔 |
| `timeoutMs` | `60000` | 单条 CLI 命令的超时 |

环境变量可以覆盖对应的配置：`DSH_LOGSEQ_HOME`、`DSH_LOGSEQ_SERVER`、`DSH_LOGSEQ_GRAPHS`（逗号分隔）、`DSH_LOGSEQ_E2EE_PASSWORD`。

## 工具

`logseq_graphs`（本地图谱和同步状态）、`logseq_search`、`logseq_show`、`logseq_list`、`logseq_query`（Datalog 查询）、`logseq_upsert_block`、`logseq_upsert_page`、`logseq_upsert_task`、`logseq_upsert_tag`、`logseq_upsert_property`、`logseq_remove`。

## 注意事项

- 安全：dsh 能执行任意命令，所以 agent 读得到 `config.json` 里的 E2EE 密码和 `auth.json`。如果不能接受，就设 `readOnly`，或者不要在这台机器上放凭据。
- 内存：每个同步图谱一个 worker，实测约 175MB（图谱 1.8MB 时）。2GB 内存的机器上，同步的图谱数要控制住。
- 本地已有、但从没关联过远端的同名图谱，插件不会同步，以免把它当新图谱上传。
- CLI 用法上的坑：属性必须先用 `logseq_upsert_property` 建好才能赋值；`blocks` 里写的 `#标签` 必须是已存在的标签；用 `id` 改写块内容会丢掉这个块原有的 `[[引用]]`。
- 许可证：AGPL-3.0-or-later。运行时提取自 Logseq（AGPL-3.0）。
