# 发布检查记录

检查日期：2026-09-30（Asia/Shanghai）。检查对象为本次修改后的工作区，代码尚未提交，也尚未部署到云平台。

## 本地结果

| 检查 | 结果 |
|---|---|
| 完整 Vitest 测试 | 7 个文件、69 项通过 |
| TypeScript | `tsc --noEmit` 与生产构建类型检查通过 |
| ESLint | `eslint . --max-warnings 0` 通过，无错误或警告 |
| 生产依赖审计 | `npm audit --omit=dev`，0 项已知漏洞 |
| 生产构建 | Next.js 16.3.3，`npm run build` 与 postbuild 通过 |
| standalone 运行 | 页面、地球贴图、浏览器包与 Worker 均正常加载 |
| 健康接口 | HTTP 200，缓存可读写，上游错误组为 0 |
| CelesTrak 真实下载 | `active` HTTP 200，16,612 条记录，`error: null` |
| 再次访问与进程重启 | 均返回 `cacheState: hit`，记录数和 `fetchedAt` 保持一致 |
| 默认目录请求 | 初始 GP 请求只有 `active`，其余按需加载 |
| 浏览器运行检查 | `fixtureMode: false`，无页面错误或失败资源，时钟与 Worker 正常 |
| 390 px 视口 | document/body 宽度均为 390 px，无横向溢出；全部卸载后分组为 0 |
| Git 差异 | `git diff --check` 通过 |

真实数据接口的 `fetchedAt` 为 `2026-09-30T11:30:03.812Z`。重启后仍返回同一时间，验证的是本地磁盘缓存跨进程保留，不是云平台磁盘已经验收。

桌面 Chrome 冒烟测试显示 16,000 个对象，120 帧样本的帧间隔中位数 13.3 ms、P95 30.8 ms、最大值 211.3 ms。这是在当前机器与浏览器启动参数下的一次测量，没有此前版本的同条件基线，不能据此声称性能提升倍数或所有设备都保持 60 fps。

截图保存为 `output/playwright/perf-smoke.png` 和 `output/playwright/mobile-smoke.png`。390 px 检查使用桌面 Chrome 的手机视口；未在真实手机硬件上测量 GPU 性能。

## 仍需在发布平台完成

尚未创建付费服务、推送代码或公开网址。Render 配置通过 YAML 语法解析，并按官方配置文档检查；当前项目的 JSON Schema 校验器不支持官方 schema 的 Draft 2020-12，因此完整 schema 校验和平台 Blueprint 验证尚未通过运行确认。本机未安装 Docker，未执行 Linux 镜像构建；已验证其依赖的 standalone 生产包。

上线时按 [发布与数据运行](deployment.md) 检查 HTTPS、真实数据接口、云端出口访问、持久磁盘权限，并在平台重启一次确认缓存保留。采用一个 Node.js 实例，扩容前需将缓存与下载锁迁移到共享存储。
