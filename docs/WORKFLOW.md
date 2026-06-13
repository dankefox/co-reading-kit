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
