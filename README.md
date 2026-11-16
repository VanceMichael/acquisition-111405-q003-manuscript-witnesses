# 古籍校勘资料的见证版本与异文采集

这是资料接收服务的独立工作副本。当前版本支持人工摘要的领取、原文归档、重复导入和归档检查，并已接入合作馆校勘来源（`source` 模式）：按卷领取校勘片段与见证目录，保存正文顺序、异文位置、各读法的见证集合与缺文范围。

## 环境

Node.js 22，运行与测试只用标准库，无外部服务、数据库、浏览器或联网下载。依赖清单和 npm 锁文件均已提供。

```sh
npm test
npm run demo
```

`npm test` 是初始产品的基线回归，验证现有摘要通路、原文摘要检查、本地来源响应，以及 CLI 在独立进程中的真实领取、重复导入和持久归档检查。该产品是一次执行后退出的采集程序，不提供常驻 HTTP 应用；`npm run collect` 执行领取，`npm run provider` 仅单独启动测试来源。

`npm run acceptance:source` 执行 `test/feature.test.mjs` 中完整的新来源验收。`npm run test:boundary` 补充公开回归未穷举的边界验证：XML 子集与实体限制、见证嵌套/跨卷/循环/缺定义、卷与片段的错误状态区分、越界链接、空的有效领取、未决资料的持久化与重复领取。交付时需执行 `npm run verify:complete`，让基线、新来源验收与边界测试同时通过；不能只用基线成功说明新功能已完成。

```sh
npm run verify:complete
npm run demo:feature
```

正式演示使用完成后的 `npm run demo:feature`，从空临时归档启动本地来源、实际采集并打印结果后退出；无需重放旧日志。`SCENARIO` 可选择 `fixtures/scenarios.json` 中的情景，默认 `readings`。单次命令应在90秒内结束，不使用真实客户数据。

## 容器

```sh
docker build -t acquisition-manuscript-witnesses:local .
docker run --rm --network none acquisition-manuscript-witnesses:local
docker run --rm --network none acquisition-manuscript-witnesses:local npm run demo:feature
```

镜像固定 Node.js 版本及基础镜像摘要；首次构建可提前拉取基础镜像，正式运行不安装或下载。容器中来源与采集器同进程启动，不需要第二个容器。默认容器命令跑现有测试与实际摘要导入，不将未开发功能伪装成成功。

## 工作入口

- `src/collector.mjs` 的 `collect` 是业务入口；`legacy` 模式保留原人工摘要通路，`source` 模式走校勘来源。
- `src/source.mjs` 编排 source 模式：`/edition` → 各卷 → 各片段，只沿来源声明的相对链接访问；单卷或单片段失败只记录带来源位置的问题，已安全接收的部分照常落库。
- `src/xml.mjs` 是校勘片段 XML 子集解析器（`p/app/lem/rdg/gap` 与五种基础实体），未声明的语法直接拒绝，不会被解释成业务事实。
- `src/witnesses.mjs` 按 scope 隔离见证目录，支持组嵌套与 `{scope,id}` 跨卷引用；缺失定义与循环引用在受影响读法上标记 `unresolved`，不替换成底本文字。
- `src/transport.mjs` 提供原文字节与请求证据，错误状态由业务层判断。
- `src/archive.mjs` 支持内容寻址原文与记录修订，存储位置由调用方传入。
- `provider/server.mjs` 提供允许访问的本地合成来源，路径和例子见 `docs/source-contract.md`。
- `test/feature.test.mjs` 对输出使用局部结构断言，不限制内部模块划分。

source 模式每个片段输出一条记录（`id` 为 `scope/fragmentId`），包含按正文顺序的 `segments`、独立保留的 `gaps`（保留来源 `reason/extent` 字符串，不补造字符）与 `readings`（含 `kind`、来源文字、字典序的完整 `scope/id` 见证键与 `unresolved`）。未决资料同样进入归档与 `issues` 待核对清单，返回值 `complete=false`；空卷集合属于有效结果，`complete=true`。

`ARCHIVE_DIR` 指定持久目录，`SOURCE_URL` 可连接另行启动的本地来源；两者均未设置时演示自动清理临时目录。`node src/cli.mjs inspect` 配合 `ARCHIVE_DIR` 查看当前索引。不要用来源服务的 fixture 对象直接生成业务结果，真实接收需经 HTTP。
