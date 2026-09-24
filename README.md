# 余量 · 医学学习与生活
医学本科生的学习与生活平衡系统模板。按周平衡，每天只推进最关键的 1–3 个行动。项目不包含特定学校的课表或个人学习记录，使用者自行填写课程、空闲时间和学习资料。

在线网页：[打开余量](https://med-balance-yawen-0923.caroljonesn4-04.chatgpt.site/)。页面可以公开访问；保存个人记录和使用资料功能需要登录，数据按登录账号隔离。

## 功能
- 根据剩余时间、精力、作业截止、考试与课程风险推荐今日行动。
- 课程管理、课堂 A/B/C 切换、课后关闭、问题池和固定周复习。
- A/B/C 作业分级、投入记录及提交状态。
- 睡眠、运动、休息、社交记录与有限并行的发展方向。
- 正常周、忙周、考试周及每周复盘。
- 服务端保存、用户隔离、版本冲突保护。
- PPT、课本原文件归档；单选题录入、JSON 导入、练习与错题回流。
- 可扩展规划 API，详见 [API 文档](docs/API.md)。

## 本地运行
需要 Node.js 22.13 或更新版本，以及 npm。建议 Node.js 24。

```sh
npm ci
npm run build
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0000_solid_shadowcat.sql
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0001_cultured_black_tarantula.sql
npm run dev
```

第一次需要应用本地数据库迁移；已应用的迁移不重复执行。打开终端显示的本地地址并点击登录，开发环境使用本地模拟身份。正式部署由 Sites 平台提供身份校验。

示例数据不写入个人记录。点击“开始我的一周”后添加自己的课程，并设置睡眠底线和可用时间。

## 检查
```sh
npx tsc --noEmit
node --experimental-strip-types --test tests/balance.test.mjs tests/library.test.mjs
npm run build
```

## 手机与部署
正式站点部署到支持 Cloudflare Worker 和 D1 的 Sites 环境，手机浏览器打开正式网址即可。电脑上的 localhost 地址不能作为外网手机地址。本项目包含服务端登录和数据 API，不能直接作为纯静态 GitHub Pages 站点运行。

GitHub 仓库用于保存与分享模板源码。GitHub Pages 不能直接运行本项目的服务端 API、登录、数据库和资料存储功能。

## 后续开发
见 [交接说明](docs/CLAUDE_HANDOFF.md)。源代码中的示例课程、日期与安排均为演示内容。真实学习记录、会话和本地数据库不属于源码发布内容。
