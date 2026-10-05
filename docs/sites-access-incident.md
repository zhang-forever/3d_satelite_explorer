# 公开站点的访问拦截

日期：2026-09-30，时区 Asia/Shanghai。

## 已确认的现象

用户提供的中国大陆访客截图在页面加载前显示 `Sorry, you have been blocked` 和 `You are unable to access chatgpt.site`。用户未提供 Ray ID，要求按中国 IP 被托管入口拦截处理。

本次查询 Sites：项目仍为 `active`，访问范围为 `public`，未被 workspace admin 或 OpenAI 停用，发布版本状态为 `succeeded`。当前海外网络请求首页返回 HTTP 200，并包含正常 Orbital Field 页面。近期应用日志可见成功的数据请求，来源国家标签为 JP、US、NL；报告范围内未见应用失败。

## 结论和边界

问题位于托管平台入口安全层，不能通过改动卫星传播算法、数据缓存或 React 页面解决。现有 Sites 工具不提供 `chatgpt.site` 域名的 WAF、IP 或地区规则管理。重新发布相同代码、反复切换公开权限均没有已验证的修复依据。

截图没有具体拦截代码，应用日志也不是 WAF 安全事件日志。因此不能断言所有中国大陆 IP 均被禁止，或确定是某一条国家、IP、ASN、浏览器规则。按用户要求，后续发布方案以避开该托管入口限制为目标，不再索要该访客的 Ray ID 或 IP。

OpenAI 公共问题追踪存在同类未解决报告：[外部访客被安全服务拦截](https://github.com/openai/codex/issues/42950)、[默认域名与自定义域名都出现拦截](https://github.com/openai/codex/issues/34954)。这些是同类报告，不是对本次具体规则的确认。Cloudflare 官方区分了多种[安全阻断页](https://developers.cloudflare.com/rules/custom-errors/reference/error-page-types/)。

## 处理方向

保留原完整 Sites 版本，另外准备 GitHub Pages 的独立静态分享版本，不让访客请求 `chatgpt.site`。数据采用明确提供的 Active 和 Stations 快照，保留抓取时间和来源；可另行配置独立更新与发布流程，使网站不依赖开发电脑常开。静态版本不能凭点击新增尚未发布的数据目录，也不能声称刷新按钮立即重新下载源站。

GitHub Pages 首次启用需要现有仓库管理者在 Settings → Pages 选择 GitHub Actions，当前可用连接器没有这项管理接口。新网址的中国大陆可访问性必须在访客实际网络验收；本地构建或海外 HTTP 200 不作为国内可用的证明。

## 2026-10-05 合并范围

本次仅整合功能、静态构建工具和测试；自动 Pages 发布工作流已排除，Pages 设置保持未启用。定时数据更新、部署权限与新网址发布留待以后单独确认。
