# Dockwisp 项目约定

与用户交流使用中文。涉及重大代码变更或重要配置更改时，先说明计划并等待确认，不要直接改。

## 构建与产物

- 最终打包只输出到 `release/`，始终只保留一个；禁止新建 `release-*`、`release-xxx` 之类的目录。
- 临时验证、中间产物统一放到 `temp/`，不要散落在项目根目录。
- `dist/`、`dist-test/` 是固定的编译/测试输出目录，不要另建。
- 使用 `npm run dist` 覆盖 `release/`；交付路径固定为 `release/Dockwisp-<version>-x64.exe`。
- 如果 `release/` 被占用而无法清理，报告并等待，或改用 `temp/` 做临时验证；不要用新的 `release-*` 目录绕过。
- 构建完成后确认 `release/` 中只有一个安装包，并在回复中给出该路径。

## Git 与二进制

- 仓库只提交源码、文档和配置；不提交 exe、dll、lib、安装包或其他构建产物。
- 已忽略：`release*/`、`dist/`、`dist-test/`、`temp/*`（README 除外）、`node_modules/`、`native/bin/`、`native/obj/`、`*.exe`、`*.dll`、`*.lib` 等。
- 第三方 Everything SDK 和便携版二进制按 `native/sdk/README.md`、`native/portable/README.md` 在本地放置，不提交。

## Git 提交

- 只有用户明确要求时才执行 `git commit`；不要自动提交。
- `push`、打 tag、改写历史同样先确认。
- 提交前先展示 `git status` / `git diff` 摘要。

## 运行

- 不要自动启动、重启或关闭 Dockwisp；由用户决定。
- 修改后报告安装包路径，以及需要用户手动执行的步骤。
