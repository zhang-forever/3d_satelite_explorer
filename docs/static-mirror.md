# 免费静态镜像

此镜像供无法访问 `chatgpt.site` 平台的访客使用。页面、贴图、浏览器计算 Worker 和轨道快照都由 GitHub Pages 提供，访客不会请求原站的数据接口。发布后，开发电脑可以关机。

原 Sites 版本保留原有完整功能。静态镜像先维护 `active` 和 `stations` 两个真实目录；其他目录没有快照时明确显示不可用，不将 Active 数组冒充其他目录。

## 首次启用

在现有公共仓库 `zhang-forever/3d_satelite_explorer` 的 **Settings → Pages → Build and deployment** 中，将 **Source** 选择为 **GitHub Actions**。随后运行 `Publish static mirror` 工作流。官方 `configure-pages` 的自动首次启用需要 Administration 权限的其他 token；本流程不创建 PAT，不创建新付费账户。

预期项目网址为 `https://zhang-forever.github.io/3d_satelite_explorer/`。实际网址以成功部署的输出为准。这个独立域名可以避开原平台的 WAF，国内不同运营商的连通性仍需实际验证。

## 数据更新

工作流在云端标准 Ubuntu runner 上每 4 小时运行，错开整点，并可手动触发。它只维护选中的两个目录，正常缓存有效期为 4 小时，不预取其他分组。

`scripts/update-static-data.mjs` 将记录和请求状态保存在 `.cache/static-data/<group>.json`，GitHub Actions cache 随每次运行保存并恢复最近状态，包含拒绝访问标记。

- 成功下载须为非空且每条记录有效的 OMM 数组，才可替换上次数据。
- 网络、无效 JSON、空数组和服务失败保留原记录、`fetchedAt` 与错误信息，至少冷却 2 小时。
- `403`、`404` 保留阻断状态，不自动重新下载；维护者核查源站和出口后再处理该状态。
- 条件请求得到 `304` 时保留原下载时间，仅更新 `checkedAt`，表示校验时间。
- 没有任何有效快照时更新命令失败，网站部署保留前一个成功版本，不发布伪造或空目录。
- GitHub Actions cache 可能被清理，定时任务也可能延迟；公共仓库长时间无活动时可能自动停用。页面显示真实快照时间，过期数据继续标记为旧数据。

浏览器仍使用 SGP4 计算所选时刻的位置；画面运动不表示每秒从源站下载新数据。“刷新数据”读取最近发布的快照，不能要求 GitHub Pages 立即向 CelesTrak 下载。

## 本地准备与检查

```bash
npm ci --no-audit --no-fund
node scripts/update-static-data.mjs --bootstrap-only
node scripts/build-static.mjs
node scripts/validate-static-output.mjs
```

首次准备优先读取已验证的 `.cache/celestrak`，或现有 `public/data/gp` 文件。没有本地保存的数据时，可显式指定自己公开站点的 API 作为启动来源：

```bash
node scripts/update-static-data.mjs --bootstrap-only --bootstrap-url https://YOUR-PUBLIC-SITE/
```

这个启动来源仅在准备阶段由更新脚本读取，数据会复制到镜像自己的文件中；访客不会经原站代理访问数据。启动导入保留原获取时间。常规更新直接向 CelesTrak 请求，不使用启动站点。

输出包括 `out/index.html`、`out/index.rsc`、`out/_next/static`、地球贴图、`out/data/catalogs.json` 和 `out/data/gp/<group>.json`。构建从此仓库源码运行 Next.js，使用独立 `.next-static` 目录，按 Pages 的项目子路径生成 Worker 和资源 URL，不复用旧生产包。

`scripts/validate-static-output.mjs` 检查选定目录、记录数量和真实下载时间一致，并核对 HTML 的资源、webpack public path、RSC 与图标。页面交互与实际网络访问另由浏览器检查。

## 免费额度与资料

公共仓库使用标准 GitHub 托管 runner 的运行时间免费。工作流采用一天的发布 artifact 保留期，使用默认缓存额度，不使用 larger runner。Pages 的站点体积和流量限制仍然适用。

资料：[configure-pages 的权限](https://github.com/actions/configure-pages/blob/v5/action.yml)、[GitHub Pages 工作流](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)、[Pages 限制](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits)、[定时任务限制](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)、[CelesTrak 数据使用说明](https://celestrak.org/NORAD/documentation/gp-data-formats.php)。
