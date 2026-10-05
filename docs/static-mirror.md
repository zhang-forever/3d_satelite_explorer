# 免费静态镜像

此构建模式可为无法访问 `chatgpt.site` 平台的访客准备独立静态文件。页面、贴图、浏览器计算 Worker 和轨道快照可由静态托管提供，访客不需要请求原站的数据接口。构建成功不代表已经发布。

原 Sites 版本保留原有完整功能。静态镜像先维护 `active` 和 `stations` 两个真实目录；其他目录没有快照时明确显示不可用，不将 Active 数组冒充其他目录。

## 发布状态

2026-10-05 的合并范围仅包含功能、构建工具与测试。自动发布工作流已从本次改动中排除；仓库没有在本次合并中启用 Pages、申请部署/OIDC 权限或创建定时发布任务。代码推送和本地构建都不会发布这个静态镜像。

如果以后决定发布，需要单独确认托管目标、访问范围、数据更新方式和所需权限，再配置发布流程。当前没有已验证的 Pages 网址；未来实际网址与中国大陆网络连通性均须在部署后另行验收。

## 数据更新

当前仓库提供手动更新脚本，没有自动调度。脚本只维护选中的两个目录，正常缓存有效期为 4 小时，不预取其他分组。以后如需定时更新，运行频率和发布权限须另行确认。

`scripts/update-static-data.mjs` 将记录和请求状态保存在本地 `.cache/static-data/<group>.json`，包含拒绝访问标记。迁移到其他执行环境时，需要保留这些状态；本次未配置云端缓存恢复或自动发布。

- 成功下载须为非空且每条记录有效的 OMM 数组，才可替换上次数据。
- 网络、无效 JSON、空数组和服务失败保留原记录、`fetchedAt` 与错误信息，至少冷却 2 小时。
- `403`、`404` 保留阻断状态，不自动重新下载；维护者核查源站和出口后再处理该状态。
- 条件请求得到 `304` 时保留原下载时间，仅更新 `checkedAt`，表示校验时间。
- 没有任何有效快照时更新命令失败，不生成伪造或空目录；脚本本身不执行网站部署。
- 清理状态目录会丢失冷却与阻断记录，应避免以删缓存代替排查。页面根据实际查看时间重新判断快照是否过期，暂停模拟也不会冻结数据年龄。

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

## 后续发布参考

是否使用 Pages、GitHub Actions 或其他平台将在需要发布时单独决定。启用前应核对当时适用的权限、额度、站点体积与流量限制；本次合并没有创建服务或部署。

资料：[configure-pages 的权限](https://github.com/actions/configure-pages/blob/v5/action.yml)、[GitHub Pages 工作流](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)、[Pages 限制](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits)、[定时任务限制](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)、[CelesTrak 数据使用说明](https://celestrak.org/NORAD/documentation/gp-data-formats.php)。
