# 联调工作台

联调工作台把测试网址、前后端仓库与分支、Chrome 标签页及其证据放在独立的本机工作区里。界面使用 React 和 Vite，本机 Node.js 服务负责 GitLab 授权和 Chrome 采集。工作台匹配现有标签页后就自动采集，复现结束后可以勾选证据保存。

## 本地运行

需要 Node.js 24.12 或更新版本、pnpm 11.9.0，以及 Chrome 144 或更新版本。

```sh
pnpm install --frozen-lockfile
pnpm start
```

在浏览器中访问 `http://127.0.0.1:4321`。`pnpm start` 会构建前端并启动本机服务。开发时可用 `pnpm dev` 在同一地址运行 Vite 热更新和本机 API。单独运行 `pnpm build` 可生成 `dist/` 中的前端资源。工作区及所选证据保存在 `data/tasks.json`，也可以通过 `WORKBENCH_DATA_FILE` 指定文件路径。

### 接入已有 Chrome

1. 在日常使用的 Chrome 中打开 `chrome://inspect/#remote-debugging`，启用远程调试。
2. 照常打开并登录测试网站。新建工作区，填写该标签页的测试网址。
3. 在工作台点击「连接 Chrome」，并在 Chrome 弹窗中点击允许。只有一个匹配的标签页时自动接入。有多个时，选一次要联调的标签页。
4. 在现有标签页操作。回到工作台，从「请求」或「控制台」中勾选需要的记录，点击「保存所选」。

工作台和采集器都由本机 Node.js 进程提供。各工作区可以同时采集绑定的标签页。切换工作区或关闭工作台页面后，后台继续采集已连接的工作区。在某个工作区点击「断开连接」只会断开该工作区。匹配时使用网址的域名、端口和路径，工作区显式填写的查询参数或片段也参与匹配。接入后可以在同源的其他路径继续操作，离开该源时解除绑定。重启本机服务后，可以在各工作区重新连接 Chrome。

浏览器连接需要 Chrome 的授权。开始时间以工作台显示的采集时间为准。临时记录在本机内存里保留最近 20 分钟，每个工作区最多 400 条。请求证据包括方法、路径、状态、耗时和失败信息。URL 查询参数、片段以及请求和响应的头与正文不保存。Console 涵盖当前标签页中符合工作区来源的日志与异常，并对常见凭据字段做脱敏。

在工作区的「Chrome 设置」中，可以检测调试端口和保存该工作区的 Chrome 用户数据目录。不同工作区可以连接同一 Chrome 实例中的不同标签页，也可以分别连接不同的 Chrome 实例。目录留空时使用本机默认目录，此前保存过的全局目录继续作为默认值。自定义目录应填写 Chrome 用户数据根目录，可通过 `chrome://version` 中的「个人资料路径」确认。启用远程调试和确认许可需要在 Chrome 中完成。 [Chrome 现有会话连接说明](https://developer.chrome.com/docs/devtools/agents/use-cases/auto-connect)

### 配置 GitLab 个人授权

1. 打开工作台的「连接设置 → GitLab」，填写 GitLab 实例地址，例如 `gitlab.example.com`。也可以直接粘贴 GitLab 的 OAuth 应用页面地址。工作台会显示回调地址，并提供应用设置的入口。
2. 在 GitLab 创建 OAuth 应用，粘贴回调地址，勾选 `read_api`。使用公开应用时，将「私密」（Confidential）留空。
3. 回到工作台填入完整的应用程序 ID。只有 GitLab 勾选了「私密」时，才需要在工作台也勾选并填写密码（Client Secret）。看到「GitLab 设置已保存，等待授权」后，点击「前往 GitLab 授权」。授权完成后，即可在编辑工作区时搜索仓库和分支。

创建工作区只需要名称和测试网址。前端和后端各可添加多个仓库，每个仓库可选多个分支。展开添加仓库或选择分支的列表后，可以按关键字搜索，列表滚动时自动加载下一页。可以先保存工作区，之后再补充仓库或分支。

GitLab 设置保存后立即生效，保存在工作区文件同目录的 `settings.json`。保密应用的 Client Secret 在 Windows 上由当前用户加密保存，在其他平台保留在本次本机服务会话中。应用使用 OAuth 授权码和 PKCE，访问令牌保存在进程内存中，服务重启后需要重新授权。工作区保存的仓库绑定包含 GitLab 实例，切换连接设置时，已有工作区保留原来的仓库和选定分支。 [GitLab OAuth 应用](https://docs.gitlab.com/integration/oauth_provider/) · [GitLab PKCE 流程](https://docs.gitlab.com/api/oauth2/#authorization-code-with-proof-key-for-code-exchange-pkce)

### 用 Claude Code 分析联调证据

在运行工作台的用户账户下安装 Claude Code，并在终端用 `claude --version` 检查安装。工作台使用 Claude Code 当前的用户级模型配置，可以复用 CC Switch 切换的供应商。使用 CC Switch 路由模式时，分析期间需保持本机路由运行。

在「请求」「控制台」或「已保存」中勾选记录，再点「AI 分析」。工作台会先保存临时记录，然后将这批证据及工作区绑定的仓库和分支交给当前模型服务。页面会显示派发建议、对应的证据和下一步排查动作。分析结果显示在当前页面，证据保存在工作区中。 [Claude Code CLI](https://code.claude.com/docs/en/cli-reference) · [CC Switch](https://github.com/farion1231/cc-switch)

## 添加模块

| 目录 | 职责 |
| --- | --- |
| `src/modules/gitlab` | 个人 GitLab 授权、仓库与分支查询 |
| `src/modules/chrome` | 发现现有 Chrome、绑定标签页、采集并标准化事件 |
| `src/modules/tasks` | 保存工作区、仓库、浏览器目录及选中的证据 |
| `src/modules/analysis` | 通过本机 Claude Code 分析证据，校验派发建议 |
| `src/modules/settings` | 读写本机连接设置，保护 OAuth 应用密钥 |
| `src/contracts.ts` | 工作区、连接状态和证据的数据格式 |
| `src/server.ts` | 本机 HTTP 入口和 API 路由 |
| `web/src` | 工作台的 React 界面和 API 客户端 |
| `vite.config.ts` | 前端构建及开发模式下的本机 API 接入 |

新增采集能力时，可以参考 `src/modules/chrome/evidence.ts` 的 `EvidenceCollector`。例如添加一种页面事件，先在 `src/contracts.ts` 定义记录类型，再将浏览器事件转换成对应记录，最后在 `web/src/EvidencePanel.tsx` 增加展示。工作区通过稳定的记录 ID 保存勾选结果。独立功能可以放到 `src/modules/<name>/`，在 `src/server.ts` 里显式挂载入口。

```sh
pnpm check
pnpm test
```

常规测试使用本机模拟 GitLab 和 CDP 接口。设置 `WORKBENCH_TEST_CHROME` 为 Chrome 可执行文件路径后，`pnpm test` 还会运行隔离的真实 Chrome 测试，验证接入已有标签页时页面保持原样，并在同源跳转后继续采集。
