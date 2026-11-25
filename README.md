# Moon Yarn 工作台

[网页工作台](https://yarn.moonl.cloud/) 使用 Moon SSO。启用的 Moon 账号共享脚本库。可编写、导入和下载 `.yarn`，在 Moon 保存脚本，使用 Yarn Spinner 3.2.2 编译和交互预览。选项、变量和节点跳转由 Yarn 运行时处理。游戏自定义命令会显示在预览里，可在游戏引擎中接入实际行为。

## MCP

本机 Codex 使用 SSH stdio。脚本与网页共用一份存储，保存接口用 revision 检查是否有并发修改。

```powershell
codex mcp add moon-yarn-workbench --env "PROGRAMDATA=$env:ProgramData" -- ssh.exe -T -o BatchMode=yes -o ConnectTimeout=8 moon podman exec -i moon-yarn-workbench node /app/stdio.mjs
```

工具包括 `list_scripts`、`get_script`、`create_script`、`save_script`、`check_script` 和 `preview_script`。预览工具返回选项 ID，按顺序填入 `choices` 即可走分支。公网 `/mcp` 需要工作台的登录会话。

## 运行和部署

本机在项目目录执行 `npm ci` 和 `dotnet build runner/YarnPreview.csproj -c Release`，再执行 `npm start`。Windows 默认读取 Release 目录里的运行器。本地数据默认保存在 `scripts`。

Moon 的 Podman 镜像由 `Containerfile` 构建，`moon-yarn-workbench.service` 负责重启和开机启动。应用端口仅绑定 `127.0.0.1:18849`，Caddy 入口见 `yarn.moonl.cloud.caddy`。数据目录为 `/var/lib/moon-yarn-workbench`。OAuth 回调为 `https://yarn.moonl.cloud/auth/callback`，凭据由 root 在 `/etc/moon-yarn-workbench/sso-client.env` 管理。

## 目录

| 路径 | 作用 |
| --- | --- |
| `server.mjs` | Express 服务：脚本存储、SSO 登录、`/mcp` Streamable HTTP 端点，调用预览运行器 |
| `stdio.mjs` | MCP stdio 转接，把请求转发到同一进程的 `/mcp` |
| `sso.mjs`、`login-page.mjs` | Moon SSO（OIDC）登录与登录页 |
| `demo.mjs` | 新建脚本时的示例 Yarn 对话 |
| `public/` | 网页工作台前端（无构建步骤） |
| `runner/` | .NET 10 控制台程序 `YarnPreview`，通过 stdin/stdout JSON 调用 Yarn Spinner 编译和运行对话 |

运行所需的环境变量：`MOON_SSO_ISSUER`、`MOON_SSO_CLIENT_ID`、`MOON_SSO_CLIENT_SECRET`、`YARN_PUBLIC_ORIGIN`，
可选 `PORT`（默认 18849）、`BIND_HOST`、`SCRIPT_DIR`、`YARN_RUNNER`。凭据只放在服务器的 env 文件里，不进仓库。

## CI

GitHub Actions 在每次推送和 PR 时用 pnpm 安装依赖（`pnpm-lock.yaml`；`package-lock.json` 保留给 `Containerfile` 的 `npm ci`，两份锁文件需同步更新），
并做密钥与依赖漏洞扫描。.NET 运行器在构建容器镜像时编译。

## 许可证

本仓库代码以 [MIT](LICENSE) 发布。

预览运行器通过 NuGet 引用 [Yarn Spinner](https://github.com/YarnSpinnerTool/YarnSpinner)（`YarnSpinner.Compiler` 3.2.2，MIT 许可，作者 Secret Lab Pty. Ltd. and Yarn Spinner contributors）。
仓库不包含 Yarn Spinner 源码或二进制文件；构建出的镜像里会带上它的程序集，分发时请一并遵守其 MIT 许可证。
