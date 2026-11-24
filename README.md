# 联调工作台

联调工作台把前后端仓库与分支、测试网址、浏览器请求和控制台日志放在同一个本机任务里。测试人员继续使用已经打开并登录的 Chrome。工作台匹配现有标签页后就自动采集，复现结束后可以勾选证据保存。

## 本地运行

需要 Node.js 24.12 或更新版本、pnpm 11.9.0，以及 Chrome 144 或更新版本。

```sh
pnpm install --frozen-lockfile
pnpm start
```

在浏览器中访问 `http://127.0.0.1:4321`。开发时可用 `pnpm dev` 自动重启服务。任务及所选证据保存在 `data/tasks.json`，也可以通过 `WORKBENCH_DATA_FILE` 指定文件路径。

### 接入已有 Chrome

1. 在日常使用的 Chrome 中打开 `chrome://inspect/#remote-debugging`，启用远程调试。
2. 照常打开并登录测试网站。新建联调任务，填写该标签页的测试网址。
3. 在工作台点击「连接 Chrome」，并在 Chrome 弹窗中点击允许。只有一个匹配的标签页时自动接入。有多个时，选一次要联调的标签页。
4. 在现有标签页操作。回到工作台，从「请求」或「控制台」中勾选需要的记录，点击「保存所选」。

工作台和采集器都由本机 Node.js 进程提供。只要进程、Chrome 连接和标签页还在，关闭工作台页面也可以继续采集。工作台同一时间采集一个任务的标签页。匹配时使用网址的域名、端口和路径，任务网址显式填写的查询参数或片段也参与匹配。接入后可以在同源的其他路径继续操作，离开该源时解除绑定。

浏览器连接需要 Chrome 的授权。开始时间以工作台显示的采集时间为准。临时记录在本机内存里保留最近 20 分钟，每个任务最多 400 条。请求证据包括方法、路径、状态、耗时和失败信息。URL 查询参数、片段以及请求和响应的头与正文不保存。Console 涵盖当前标签页中符合任务来源的日志与异常，并对常见凭据字段做脱敏。

工作台的「连接设置 → Chrome」提供设置地址复制、调试端口检测、自定义用户数据目录和连接入口。目录留空时使用系统默认位置。自定义目录应填写 Chrome 用户数据根目录，可通过 `chrome://version` 中的「个人资料路径」确认。启用远程调试和确认许可需要在 Chrome 中完成。 [Chrome 现有会话连接说明](https://developer.chrome.com/docs/devtools/agents/use-cases/auto-connect)

### 配置 GitLab 个人授权

1. 打开工作台的「连接设置 → GitLab」，填入实例地址。工作台会显示当前的回调地址，并提供 GitLab 应用设置的入口。
2. 在 GitLab 创建 OAuth 应用，粘贴回调地址，勾选 `read_api`。使用公开应用时取消勾选 Confidential。
3. 回到工作台填入 Application ID。如果应用是保密应用，勾选「使用保密应用」并填写 Client Secret。保存设置后点击「前往 GitLab 授权」。编辑任务时即可搜索仓库和选择分支。

设置保存后立即生效，保存在任务文件同目录的 `settings.json`。保密应用的 Client Secret 在 Windows 上由当前用户加密保存，在其他平台保留在本次本机服务会话中。应用使用 OAuth 授权码和 PKCE，访问令牌保存在进程内存中，服务重启后需要重新授权。任务保存的仓库绑定包含 GitLab 实例，切换连接设置时，已有任务保留原来的仓库和选定分支。 [GitLab OAuth 应用](https://docs.gitlab.com/integration/oauth_provider/) · [GitLab PKCE 流程](https://docs.gitlab.com/api/oauth2/#authorization-code-with-proof-key-for-code-exchange-pkce)

## 添加模块

| 目录 | 职责 |
| --- | --- |
| `src/modules/gitlab` | 个人 GitLab 授权、仓库与分支查询 |
| `src/modules/chrome` | 发现现有 Chrome、绑定标签页、采集并标准化事件 |
| `src/modules/tasks` | 校验、保存、读取任务及选中的证据 |
| `src/modules/settings` | 读写本机连接设置，保护 OAuth 应用密钥 |
| `src/contracts.ts` | 任务、连接状态和证据的数据格式 |
| `src/server.ts` | 本机 HTTP 入口和 API 路由 |
| `web` | 工作台界面 |

新增采集能力时，可以参考 `src/modules/chrome/evidence.ts` 的 `EvidenceCollector`。例如添加一种页面事件，先在 `src/contracts.ts` 定义记录类型，再将浏览器事件转换成对应记录，最后在 `web/app.js` 增加展示。任务存储通过稳定的记录 ID 保存勾选结果。独立功能可以放到 `src/modules/<name>/`，在 `src/server.ts` 里显式挂载入口。

```sh
pnpm check
pnpm test
```

常规测试使用本机模拟 GitLab 和 CDP 接口。设置 `WORKBENCH_TEST_CHROME` 为 Chrome 可执行文件路径后，`pnpm test` 还会运行隔离的真实 Chrome 测试，验证接入已有标签页时页面保持原样，并在同源跳转后继续采集。
