# Workflow

如果你是第一次安装，可以先运行 `npm run test:smoke` 验证本地环境。

## 1. 导入并开始读一本新书

1. 调用 `reading_import_book`
2. 如果希望马上可搜索，设置 `buildIndex=true`
3. 调用 `reading_list_books` 确认书已进入本地书库
4. 调用 `reading_get_manifest` 查看 chunk 结构
5. 从 `ch000` 开始时，调用 `reading_get_chunk`
6. 讨论后调用 `reading_update_note`
7. 再调用 `reading_update_progress`

## 2. 搜索某个主题

1. 先确认 `bookId`
2. 调用 `reading_search`
3. 根据命中的 `chunkId` 调用 `reading_get_chunk`
4. 讨论后调用 `reading_update_note`
5. 如有推进，再调用 `reading_update_progress`

## 3. 根据一条原文或划线精确定位上下文

1. 调用 `reading_search_exact`
2. 找到命中的 `chunkId`
3. 调用 `reading_get_chunk`
4. 如果需要结构背景，可补充调用 `reading_get_manifest`
5. 讨论后写入 `reading_update_note`

## 4. 继续上次阅读

```text
reading_resume_book
→ 根据返回的 note.sections 和 chunk.text 开始共读
→ 讨论后 reading_update_note
→ reading_update_progress
```

## 5. 根据微信读书划线继续共读

```text
微信读书 Skill 获取 markText / wereadTitle / wereadBookId
→ reading_link_weread_book 建立映射
→ reading_find_weread_context 定位本地 chunk
→ 根据 chunk.text 讨论
→ reading_update_note 写入“摘录与想法”
→ reading_update_progress 更新进度
```

## 6. 笔记区块写入规则

### `摘录与想法`

- 当内容来自微信读书 `markText`、用户明确引用的原文，或 `reading_find_weread_context` 返回的划线定位结果时，必须写入这里。
- 这里用于记录：微信读书划线、用户手动指出的一句话、围绕某句/某段原文展开的讨论，以及 `quoteText` / `wereadMarkText` / 本地 `chunkId` / 用户想法 / AI 理解。

### `段落共读记录`

- 这里用于记录：读完某个 chunk 后的整体讨论、没有明确摘录句子的段落理解、某个情节/人物关系/主题的整体分析。

### `交叉关联`

- 这里仅用于记录：跨书关联、作者背景关联、主题互文、后续可以回看的简短关联线索。
- 不要把微信读书划线分析、具体摘录分析、大段正文讨论写进这里。

### 其他约束

- 只搜索但没有展开讨论时，不写入 notes。
- 不要把整段 chunk 原文完整写入 notes。
