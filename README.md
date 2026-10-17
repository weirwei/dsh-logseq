# dsh-logseq-sync

DeepSeek Harness（dsh）插件：把你的 Logseq 图谱同步到 dsh 所在的机器，让 agent 能直接查询和编辑你的笔记。

- 支持 Logseq 2.0 的 DB 图谱，包括 E2EE 加密图谱。加解密都在本机完成。
- 适合自建同步服务器（例如 `https://logseq-sync.example.com`），账号用 Logseq 官方账号。
- agent 写入的内容会自动同步回服务器，你在桌面端和手机上都能看到。
- 不用改 docker-compose，也不用换镜像。运行时、数据、凭据都放在 dsh 数据目录下的 `logseq/` 里（容器里是 `/root/.dsh/logseq`）。

## 需要什么

- dsh web **0.2.x** 或更新的版本。设置页要用到 0.2 的界面接口，旧版本只能手写配置文件（见文末“不用设置页”）。
- 一个 Logseq 账号，以及同步服务器地址。
- 加密图谱需要 E2EE 密码。
- 机器能访问 GitHub：第一次使用要下载约 180MB 的 Logseq 官方发行包，之后不用再下。访问不了也有办法，见“常见问题”。

## 安装

dsh 镜像里没有 git，要用 tarball 地址安装，不能写 `github:`。把 `<commit>` 换成要装的提交号：

```bash
dsh plugin --profile web add https://codeload.github.com/weirwei/dsh-logseq/tar.gz/<commit>
```

装完重启 dsh。

用 Docker 部署、通过 `DSH_PLUGINS` 管理插件的话，把地址加进去。`DSH_PLUGINS` 会覆盖默认列表，原来的插件也要写上：

```bash
DSH_PLUGINS=dshmarket @vectorize-io/hindsight-coding-agents https://codeload.github.com/weirwei/dsh-logseq/tar.gz/<commit>
```

升级时把 `<commit>` 换成新的提交号，再装一遍。

## 设置

打开 dsh web 的 **设置 → Logseq**：

1. **运行时**：第一次打开时会在后台自动下载，页面顶部显示进度。下载失败会显示原因和“重试”按钮。
2. **Logseq 账号**：填邮箱和密码。密码只用来换登录凭据，不会保存。登录后只显示当前账号和“退出登录”按钮。
3. **同步服务器**：填你的同步服务器地址。
4. **E2EE 密码**：加密图谱必须填。保存过之后，留空表示沿用原来的密码。
5. 点 **保存**，不用重启 dsh。页面下方会显示每个图谱的同步状态，状态是“已同步”就说明好了。

图谱不用选，插件会同步你账号在服务器上的全部图谱。服务器上新建的图谱，大约一分钟内会自动加入。

## 在 agent 里使用

直接跟 agent 说就行，例如：

- “在 Daily 里搜一下上周关于部署的笔记”
- “把这次的结论记到 Miki 的『项目复盘』页面”
- “列出我所有没完成的任务”

agent 会调用插件提供的工具。不指定图谱时，默认用第一个图谱。

| 工具 | 用途 |
|---|---|
| `logseq_graphs` | 查看有哪些图谱，以及各自的同步状态 |
| `logseq_search` / `logseq_show` / `logseq_list` / `logseq_query` | 搜索、查看页面和块、按类型列出、用 Datalog 查询 |
| `logseq_upsert_block` / `logseq_upsert_page` / `logseq_upsert_task` | 新建或修改块、页面、任务 |
| `logseq_upsert_tag` / `logseq_upsert_property` | 新建标签和属性 |
| `logseq_remove` | 删除（只在你明确要求删除时使用） |

只想让 agent 读、不让它写，在配置里设 `"readOnly": true`（见“配置项”）。

## 常见问题

| 现象 | 处理 |
|---|---|
| 设置里没有 Logseq 这一栏 | dsh 版本低于 0.2，或者装完插件没有重启 dsh |
| 运行时一直下载不完，或者下载失败 | 机器访问 GitHub 慢。从装了 Logseq 桌面端的电脑上拷一个 `app.asar` 过来（macOS 在 `/Applications/Logseq.app/Contents/Resources/app.asar`，Linux 发行包在 `resources/app.asar`，不分系统和 CPU 架构），放到 `logseq/app.asar`，再在 `config.json` 里加一行 `"runtimeAsar": "/root/.dsh/logseq/app.asar"` |
| 登录提示 `password-auth-rejected` | 邮箱或密码不对 |
| 同步状态显示 `invalid-e2ee-password` | E2EE 密码不对，在设置页重新填写并保存 |
| 同步状态显示 `auth-refresh-failed` | 登录过期了，在设置页退出登录后重新登录 |
| 同步状态显示 `remote graph not found` | `config.json` 里手写的图谱名在服务器上不存在（注意大小写），点设置页的“改为同步全部” |
| 同步状态显示 `not linked to a remote graph` | 本机有一个同名但从没和服务器关联过的图谱，插件不会去动它。删掉 `logseq/logseq/graphs/<图谱名>` 后重启 dsh |

插件日志在 `logseq/plugin.log`。Docker 部署可以这样看：

```bash
docker exec <容器名> tail -f /root/.dsh/logseq/plugin.log
```

## 停用和卸载

- 暂停同步：在 `config.json` 里设 `"sync": false`，再重启 dsh。agent 仍然可以读写本地副本，但不会再和服务器同步。
- 卸载：`dsh plugin --profile web remove dsh-logseq-sync`。用了 `DSH_PLUGINS` 的话，也要从里面删掉。本地数据还留在 `logseq/` 目录里，不需要就手动删除。

## 注意事项

- **安全**：能打开 dsh web 的人，就能在设置页登录 Logseq 账号、修改同步设置。dsh 暴露在公网时，一定要开着 dsh 自带的登录。另外 agent 能执行命令，它可以读到存在本机的 E2EE 密码和登录凭据。介意的话，就别在这台机器上配置。
- **内存**：每个同步中的图谱会占一个后台进程，实测约 190MB。小内存机器上图谱多的话，可以在 `config.json` 里用 `graphs` 只同步其中几个。
- 用 agent 修改已有块的文字时，会丢掉这个块原有的 `[[引用]]`。需要保留引用时，让 agent 新增一个块，不要改原来的。

## 配置项

设置页保存的内容会写进 `logseq/config.json`。下面这些高级项需要手动编辑这个文件，改完重启 dsh 生效。

| 键 | 默认值 | 说明 |
|---|---|---|
| `server` | — | 同步服务器地址。不填就不同步 |
| `graphs` | 全部 | 只同步这些图谱，第一个是 agent 的默认图谱。不填就同步服务器上的全部图谱 |
| `e2eePassword` | — | E2EE 密码 |
| `readOnly` | `false` | 只给 agent 读的工具 |
| `sync` | 填了 `server` 就是 `true` | 设成 `false` 暂停同步 |
| `runtimeAsar` | — | 使用本地的 `app.asar`，不从网上下载 |
| `runtimeUrl` | GitHub 官方地址 | 发行包的镜像下载地址 |
| `logseqVersion` | `2.0.2` | 从哪个 Logseq 版本里提取运行时 |
| `wsUrl` | `wss://<server>/sync/%s` | 同步 websocket 地址，一般不用改 |
| `oauthTokenEndpoint` | Logseq 官方 | 登录续期地址，一般不用改 |
| `statusIntervalMs` | `60000` | 同步健康检查间隔，单位毫秒 |
| `timeoutMs` | `60000` | 单条命令的超时，单位毫秒 |

环境变量可以覆盖对应的配置：`DSH_LOGSEQ_SERVER`、`DSH_LOGSEQ_GRAPHS`（逗号分隔）、`DSH_LOGSEQ_E2EE_PASSWORD`、`DSH_LOGSEQ_HOME`（数据目录）。用环境变量设置的项，在设置页里改不了，页面上会提示。

## 不用设置页（dsh 0.1.x 或无界面部署）

不用设置页的话，手动放两个文件到 `logseq/` 目录，然后重启 dsh：

1. `auth.json`：从已登录 Logseq 桌面端的电脑上拷 `~/logseq/auth.json`。
2. `config.json`：

   ```json
   {
     "server": "https://logseq-sync.example.com",
     "e2eePassword": "<E2EE 密码>"
   }
   ```

可以先用 `LOGSEQ_SERVER=<同步服务器地址> scripts/verify-e2ee-password.sh` 确认 E2EE 密码对不对。这个脚本只下载、尝试解开加密私钥，不上传任何东西。放好文件后执行 `chmod 600 logseq/*.json`，防止其他用户读到。

## 工作原理

插件从 Logseq 官方发行包里提取命令行工具（纯 JS，不依赖系统和 CPU 架构），每个图谱启动一个后台进程，把数据存在本地数据库里，通过 websocket 和同步服务器保持同步。agent 的读写都作用在本地副本上，再由后台进程推送到服务器。插件每 60 秒检查一次连接，断开就自动重连，失败时会逐渐拉长重试间隔，最长 15 分钟。

## 许可证

AGPL-3.0-or-later。运行时提取自 Logseq（AGPL-3.0）。
