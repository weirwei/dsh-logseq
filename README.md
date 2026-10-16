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

以下以 `${DATA_DIR}/dsh-home` 挂载到容器 `/root/.dsh` 为例，`D=${DATA_DIR}/dsh-home/logseq`（容器内是 `/root/.dsh/logseq`）。

1. **准备凭据**（在已登录 Logseq 桌面端的机器上）

   - 先确认 E2EE 密码：`LOGSEQ_SERVER=<同步服务器地址> scripts/verify-e2ee-password.sh`。它只下载并尝试解开服务器上的加密私钥，不上传任何东西。
   - 把 `~/logseq/auth.json` 传到服务器。
   - 服务器访问 GitHub 慢的话（例如国内机房），把运行时也传上去：macOS 上是 `/Applications/Logseq.app/Contents/Resources/app.asar`，Linux 发行包里是 `resources/app.asar`。里面用到的都是纯 JS，跟操作系统和 CPU 架构无关。

2. **放配置**：把 `auth.json`（还有 `app.asar`，如果传了的话）放进 `$D`，再写 `$D/config.json`：

   ```json
   {
     "server": "https://logseq-sync.example.com",
     "graphs": ["Miki", "Daily"],
     "e2eePassword": "<E2EE 密码>",
     "runtimeAsar": "/root/.dsh/logseq/app.asar"
   }
   ```

   没传 `app.asar` 就去掉 `runtimeAsar` 这一行，插件会自己下载（约 180MB）。宿主机上没有 node 的话，可以用 `docker exec -e PW dsh-prod node -e '...'` 在容器里生成这个文件，密码通过环境变量 `PW` 传进去，不会进命令行历史。最后执行 `chmod 700 $D && chmod 600 $D/*.json`。

3. **装插件**：dsh 镜像里没有 git，所以要用 tarball 地址，不能写 `github:`。`DSH_PLUGINS` 会覆盖默认列表，原来的插件要一起写上：

   ```bash
   DSH_PLUGINS=dshmarket @vectorize-io/hindsight-coding-agents https://codeload.github.com/weirwei/dsh-logseq/tar.gz/<commit>
   ```

   然后运行 `./dsh.sh plugins`（会装插件并重启 dsh）。以后升级时，把 `<commit>` 换成新的提交号，再跑一遍就行。

4. **验证**：`sudo tail -f $D/plugin.log`，日志里应该依次出现 `Logseq runtime ready`、`downloading from server`（只在第一次出现）、`starting sync`，中间没有 WARN。再查同步状态：

   ```bash
   docker exec dsh-prod sh -c 'export HOME=/root/.dsh/logseq; node /root/.dsh/logseq/runtime/2.0.2/js/logseq-cli.js sync status --graph Miki --output json'
   ```

   `ws-state` 是 `open`、`pending-local` 是 0、本地和远端 checksum 一致，就说明同步正常。

## 排错

| 现象 | 处理 |
|---|---|
| 日志停在 `downloading ... runtime` 不动 | 下载卡住了，60 秒没数据会自动中断，之后按退避重试。可以改用 `runtimeAsar`（见安装第 1 步） |
| `missing .../auth.json` | 把 `auth.json` 放到 `$D/auth.json` |
| `auth-refresh-failed` | 在桌面端重新登录，把新的 `auth.json` 覆盖到 `$D/logseq/auth.json`。`$D/auth.json` 只在第一次启动时被复制过去，之后改它不会生效 |
| `invalid-e2ee-password` | 改 `config.json` 里的密码，然后重启 dsh |
| `not linked to a remote graph` | 本地有一个同名但从没关联过远端的图谱。删掉 `$D/logseq/graphs/<名>` 后重启 |
| zsh 里 `sudo ls $D/*` 报 no matches | `$D` 的权限是 700，通配符在 sudo 之前由当前用户展开，所以匹配不到。改用 `sudo sh -c 'ls $D/*'` |

停用：在 `config.json` 里设 `"sync": false`，工具就只操作本地副本，不再同步；或者从 `DSH_PLUGINS` 里删掉这个插件，再执行 `dsh plugin --profile web remove dsh-logseq-sync`（这条命令还没验证过）。

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
- 内存：每个同步图谱一个 worker，实测约 190MB（图谱 1.8MB 时）。2GB 内存的机器上，同步的图谱数要控制住。
- 本地已有、但从没关联过远端的同名图谱，插件不会同步，以免把它当新图谱上传。
- CLI 用法上的坑：属性必须先用 `logseq_upsert_property` 建好才能赋值；`blocks` 里写的 `#标签` 必须是已存在的标签；用 `id` 改写块内容会丢掉这个块原有的 `[[引用]]`。
- 许可证：AGPL-3.0-or-later。运行时提取自 Logseq（AGPL-3.0）。
