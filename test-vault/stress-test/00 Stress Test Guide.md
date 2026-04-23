# Better Links 压力测试

这组用例专门用来测“几百条链接一起修复”的场景。

## 本次规模

- 重命名压力测试：80 个反链文件，预计同时更新 400 条链接
- 移动压力测试：80 个反链文件，预计同时更新 400 条链接

## 重命名压力测试

1. 打开 `stress-test/rename/00 Rename Source.md`。
2. 把 `## 压力父标题` 改成 `## 压力父标题-已重命名`。
3. 打开 `stress-test/rename/backlinks` 文件夹里的任意几篇笔记抽查。
4. 预期结果：
   - `[[stress-test/rename/00 Rename Source#压力父标题]]` 会更新成 `[[stress-test/rename/00 Rename Source#压力父标题-已重命名]]`
   - `[[stress-test/rename/00 Rename Source#压力父标题#压力子标题]]` 会更新成 `[[stress-test/rename/00 Rename Source#压力父标题-已重命名#压力子标题]]`
   - 多层别名链接和嵌入链接也会一起更新
   - `[[stress-test/rename/00 Rename Source#稳定对照标题]]` 保持不变

## 移动压力测试

1. 打开 `stress-test/move/00 Move Source.md`。
2. 把整个 `## 待移动父标题` 小节连同下面的 `### 待移动子标题` 一起剪切。
3. 打开 `stress-test/move/01 Move Target.md`，粘贴到 `## 目标容器` 下方。
4. 打开 `stress-test/move/backlinks` 文件夹里的任意几篇笔记抽查。
5. 预期结果：
   - `[[stress-test/move/00 Move Source#待移动父标题]]` 会更新成 `[[stress-test/move/01 Move Target#待移动父标题]]`
   - `[[stress-test/move/00 Move Source#待移动父标题#待移动子标题]]` 会更新成 `[[stress-test/move/01 Move Target#待移动父标题#待移动子标题]]`
   - 多层别名链接和嵌入链接也会一起更新
   - `[[stress-test/move/00 Move Source#保留对照标题]]` 保持不变

## 重新生成

如果你想把这套压力测试恢复成初始状态，在项目根目录运行：

```powershell
npm run stress:reset
```
