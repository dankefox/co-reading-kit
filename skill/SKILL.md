# AI 使用规则

1. 不要读取 `original.md`。
2. 默认一次只读一个 chunk。
3. 有原文、划线、引用时，优先使用 `reading_search_exact`。
4. 主题词搜索使用 `reading_search`。
5. 继续阅读时，优先使用 `reading_resume_book`。
6. 需要查看本地切片地图时，使用 `reading_get_manifest`。
7. 想看“我有哪些书”或不确定 `bookId` 时，先用 `reading_list_books`。
8. 讨论后先调用 `reading_update_note`，再调用 `reading_update_progress`。
9. notes 只保存理解、想法、关联和下次入口，不要保存整段正文。
10. 不要重复记录同一条划线。
11. 如果 progress 不存在但用户想从头读，先用 `reading_get_manifest` 找 `ch000`，再用 `reading_get_chunk`。
12. 导入本地 `epub/txt/md` 时，使用 `reading_import_book`。
13. 如果导入后马上要搜索，设置 `buildIndex=true` 或调用 `reading_build_index`。
14. `reading_get_manifest` 不是正文读取工具，它不读取 `original.md`，也不读取 chunk 正文。
15. 用户提供微信读书划线时，优先使用 `reading_find_weread_context`。
16. 如果找不到 `localBookId`，先调用 `reading_link_weread_book`，或让用户提供本地 `bookId`。
17. `reading_find_weread_context` 只做 exact 定位，不做语义猜测。
18. 找到 chunk 后再共读。
19. 当内容来自微信读书 `markText`、用户明确引用的原文，或 `reading_find_weread_context` 返回的划线定位结果时，必须写入“摘录与想法”。
20. “摘录与想法”用于记录：微信读书划线、用户手动指出的一句话、围绕某句或某段原文展开的讨论，以及 `quoteText` / `wereadMarkText` / 本地 `chunkId` / 用户想法 / AI 理解。
21. “段落共读记录”只用于记录：读完某个 chunk 后的整体讨论、没有明确摘录句子的段落理解、某个情节/人物关系/主题的整体分析。
22. “交叉关联”只用于记录：跨书关联、作者背景关联、主题互文、后续可回看的简短关联线索。
23. 禁止把微信读书划线分析、具体摘录分析、大段正文讨论写进“交叉关联”。
24. 只搜索但没有展开讨论时，不写入 notes。
25. 不要把整段 chunk 原文完整写入 notes。
