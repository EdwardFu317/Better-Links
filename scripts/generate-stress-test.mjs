import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const vaultRoot = path.join(repoRoot, "test-vault");
const stressRoot = path.join(vaultRoot, "stress-test");

const RENAME_BACKLINK_FILES = 80;
const MOVE_BACKLINK_FILES = 80;
const LINKS_CHANGED_PER_RENAME_FILE = 5;
const LINKS_CHANGED_PER_MOVE_FILE = 5;

const renameSourceLink = "stress-test/rename/00 Rename Source";
const moveSourceLink = "stress-test/move/00 Move Source";
const moveTargetLink = "stress-test/move/01 Move Target";

async function main() {
  await rm(stressRoot, { recursive: true, force: true });

  await mkdir(path.join(stressRoot, "rename", "backlinks"), { recursive: true });
  await mkdir(path.join(stressRoot, "move", "backlinks"), { recursive: true });

  await writeFile(
    path.join(stressRoot, "00 Stress Test Guide.md"),
    createGuideNote(),
    "utf8"
  );

  await writeFile(
    path.join(stressRoot, "rename", "00 Rename Source.md"),
    createRenameSourceNote(),
    "utf8"
  );

  await writeFile(
    path.join(stressRoot, "move", "00 Move Source.md"),
    createMoveSourceNote(),
    "utf8"
  );

  await writeFile(
    path.join(stressRoot, "move", "01 Move Target.md"),
    createMoveTargetNote(),
    "utf8"
  );

  for (let index = 1; index <= RENAME_BACKLINK_FILES; index += 1) {
    await writeFile(
      path.join(
        stressRoot,
        "rename",
        "backlinks",
        `Rename Backlinks ${pad(index)}.md`
      ),
      createRenameBacklinkNote(index),
      "utf8"
    );
  }

  for (let index = 1; index <= MOVE_BACKLINK_FILES; index += 1) {
    await writeFile(
      path.join(
        stressRoot,
        "move",
        "backlinks",
        `Move Backlinks ${pad(index)}.md`
      ),
      createMoveBacklinkNote(index),
      "utf8"
    );
  }

  process.stdout.write(
    [
      `Generated stress test vault content in ${stressRoot}`,
      `Rename scenario: ${RENAME_BACKLINK_FILES} files, ${
        RENAME_BACKLINK_FILES * LINKS_CHANGED_PER_RENAME_FILE
      } links expected to update`,
      `Move scenario: ${MOVE_BACKLINK_FILES} files, ${
        MOVE_BACKLINK_FILES * LINKS_CHANGED_PER_MOVE_FILE
      } links expected to update`,
    ].join("\n")
  );
}

function createGuideNote() {
  const renameChangedLinks =
    RENAME_BACKLINK_FILES * LINKS_CHANGED_PER_RENAME_FILE;
  const moveChangedLinks = MOVE_BACKLINK_FILES * LINKS_CHANGED_PER_MOVE_FILE;

  return `# Better Heading Links 压力测试

这组用例专门用来测“几百条链接一起修复”的场景。

## 本次规模

- 重命名压力测试：${RENAME_BACKLINK_FILES} 个反链文件，预计同时更新 ${renameChangedLinks} 条链接
- 移动压力测试：${MOVE_BACKLINK_FILES} 个反链文件，预计同时更新 ${moveChangedLinks} 条链接

## 重命名压力测试

1. 打开 \`stress-test/rename/00 Rename Source.md\`。
2. 把 \`## 压力父标题\` 改成 \`## 压力父标题-已重命名\`。
3. 打开 \`stress-test/rename/backlinks\` 文件夹里的任意几篇笔记抽查。
4. 预期结果：
   - \`[[${renameSourceLink}#压力父标题]]\` 会更新成 \`[[${renameSourceLink}#压力父标题-已重命名]]\`
   - \`[[${renameSourceLink}#压力父标题#压力子标题]]\` 会更新成 \`[[${renameSourceLink}#压力父标题-已重命名#压力子标题]]\`
   - 多层别名链接和嵌入链接也会一起更新
   - \`[[${renameSourceLink}#稳定对照标题]]\` 保持不变

## 移动压力测试

1. 打开 \`stress-test/move/00 Move Source.md\`。
2. 把整个 \`## 待移动父标题\` 小节连同下面的 \`### 待移动子标题\` 一起剪切。
3. 打开 \`stress-test/move/01 Move Target.md\`，粘贴到 \`## 目标容器\` 下方。
4. 打开 \`stress-test/move/backlinks\` 文件夹里的任意几篇笔记抽查。
5. 预期结果：
   - \`[[${moveSourceLink}#待移动父标题]]\` 会更新成 \`[[${moveTargetLink}#待移动父标题]]\`
   - \`[[${moveSourceLink}#待移动父标题#待移动子标题]]\` 会更新成 \`[[${moveTargetLink}#待移动父标题#待移动子标题]]\`
   - 多层别名链接和嵌入链接也会一起更新
   - \`[[${moveSourceLink}#保留对照标题]]\` 保持不变

## 重新生成

如果你想把这套压力测试恢复成初始状态，在项目根目录运行：

\`\`\`powershell
npm run stress:reset
\`\`\`
`;
}

function createRenameSourceNote() {
  return `# 压力测试重命名源

## 压力父标题

这个标题会被重命名，用来触发批量修链。

### 压力子标题

这个子标题用来测试 \`[[文件#父标题#子标题]]\` 这种多层路径。

## 稳定对照标题

这个标题不应该被改动。
`;
}

function createMoveSourceNote() {
  return `# 压力测试移动源

## 待移动父标题

这个标题会被整段剪切到另一篇笔记。

### 待移动子标题

这个子标题用来验证多层路径在移动后的批量修复。

## 保留对照标题

这个标题会继续留在原文件里，作为对照项。
`;
}

function createMoveTargetNote() {
  return `# 压力测试移动目标

## 目标容器

把剪切出来的整段内容粘贴到这里下方。

说明：
- 当前被移动的小节本身是 \`##\`
- 目标容器也是 \`##\`
- 所以按当前规则，不会额外生成 \`目标容器#待移动父标题\` 这种层级路径
`;
}

function createRenameBacklinkNote(index) {
  const id = pad(index);
  return `# 重命名压力反链 ${id}

- 父标题普通链接：[[${renameSourceLink}#压力父标题]]
- 父标题别名链接：[[${renameSourceLink}#压力父标题|父标题别名 ${id}]]
- 多层普通链接：[[${renameSourceLink}#压力父标题#压力子标题]]
- 多层别名链接：[[${renameSourceLink}#压力父标题#压力子标题|多层别名 ${id}]]
- 多层嵌入链接：![[${renameSourceLink}#压力父标题#压力子标题]]
- 对照链接：[[${renameSourceLink}#稳定对照标题]]
`;
}

function createMoveBacklinkNote(index) {
  const id = pad(index);
  return `# 移动压力反链 ${id}

- 父标题普通链接：[[${moveSourceLink}#待移动父标题]]
- 父标题别名链接：[[${moveSourceLink}#待移动父标题|移动父标题别名 ${id}]]
- 多层普通链接：[[${moveSourceLink}#待移动父标题#待移动子标题]]
- 多层别名链接：[[${moveSourceLink}#待移动父标题#待移动子标题|移动多层别名 ${id}]]
- 多层嵌入链接：![[${moveSourceLink}#待移动父标题#待移动子标题]]
- 对照链接：[[${moveSourceLink}#保留对照标题]]
`;
}

function pad(value) {
  return String(value).padStart(3, "0");
}

await main();
