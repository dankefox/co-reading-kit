#!/usr/bin/env node
/*
本地阅读书籍存储在以下路径：
CYBERBOSS_STATE_DIR/reading/books/<book-id>/

代理应先读取 manifest.json 文件，然后读取各个分块文件。
除非明确要求进行调试，否则代理不应读取 original.md 文件。
阅读进度应在以下文件中进行跟踪：
CYBERBOSS_STATE_DIR/reading/progress.json
*/

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const AdmZip = require("adm-zip");
const { XMLParser } = require("fast-xml-parser");
const { htmlToText } = require("html-to-text");

const DEFAULT_MAX_CHARS = 4000;
const PROJECT_ROOT = resolveProjectRoot(__dirname);

function resolveProjectRoot(scriptDir) {
  const directRoot = path.resolve(scriptDir, "..");
  if (path.basename(directRoot).toLowerCase() === "xiaoye") {
    return path.resolve(scriptDir, "../..");
  }

  return directRoot;
}

function parseArgs(argv) {
  const args = {
    input: null,
    title: null,
    author: null,
    bookId: null,
    maxChars: DEFAULT_MAX_CHARS,
    minChars: null,
    stateDir: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (!name.startsWith("--")) {
      throw new Error(`Unexpected argument: ${name}`);
    }

    const key = name.slice(2);
    if (!Object.prototype.hasOwnProperty.call(args, toCamelCase(key))) {
      throw new Error(`Unknown argument: ${name}`);
    }

    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for ${name}`);
    }

    args[toCamelCase(key)] = value;
    index += 1;
  }

  if (!args.input) {
    throw new Error("Missing required argument: --input <file>");
  }

  args.maxChars = Number(args.maxChars || DEFAULT_MAX_CHARS);
  if (!Number.isInteger(args.maxChars) || args.maxChars < 500) {
    throw new Error("--max-chars must be an integer greater than or equal to 500");
  }

  args.minChars = args.minChars === null
    ? Math.floor(args.maxChars * 0.35)
    : Number(args.minChars);
  if (!Number.isInteger(args.minChars)) {
    throw new Error("--min-chars must be an integer");
  }
  args.minChars = Math.max(300, args.minChars);

  return args;
}

function toCamelCase(value) {
  return String(value).replace(/-([a-z])/g, (_, char) => char.toUpperCase());
}

function normalizePath(value) {
  return path.resolve(String(value)).replace(/\\/g, "/");
}

function resolveStateDir(explicitStateDir) {
  if (explicitStateDir) {
    return path.resolve(explicitStateDir);
  }

  if (process.env.CYBERBOSS_STATE_DIR) {
    return path.resolve(process.env.CYBERBOSS_STATE_DIR);
  }

  return path.resolve(PROJECT_ROOT, "..", ".cyberboss");
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function createSafeBookId(title) {
  const normalized = String(title || "untitled")
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, " ")
    .replace(/[_\s]+/g, "-")
    .replace(/[^\p{L}\p{N}-]+/gu, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  return normalized || `book-${Date.now()}`;
}

function readTextSource(inputPath) {
  return decodeTextBuffer(fs.readFileSync(inputPath));
}

function decodeTextBuffer(buffer) {
  if (buffer.length >= 3 &&
    buffer[0] === 0xef &&
    buffer[1] === 0xbb &&
    buffer[2] === 0xbf) {
    return decodeBuffer(buffer.subarray(3), "utf-8", true);
  }

  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return decodeBuffer(buffer.subarray(2), "utf-16le", false);
  }

  const utf8 = tryDecodeBuffer(buffer, "utf-8", true);
  if (utf8 !== null && !looksMisdecoded(utf8)) {
    return utf8;
  }

  const candidates = ["gb18030", "gbk", "utf-16le"]
    .map((encoding) => ({
      encoding,
      text: tryDecodeBuffer(buffer, encoding, false),
    }))
    .filter((candidate) => candidate.text !== null)
    .sort((left, right) => scoreDecodedText(left.text) - scoreDecodedText(right.text));

  if (candidates.length) {
    return candidates[0].text;
  }

  return decodeBuffer(buffer, "utf-8", false);
}

function tryDecodeBuffer(buffer, encoding, fatal) {
  try {
    return decodeBuffer(buffer, encoding, fatal);
  } catch {
    return null;
  }
}

function decodeBuffer(buffer, encoding, fatal) {
  return new TextDecoder(encoding, { fatal }).decode(buffer);
}

function looksMisdecoded(text) {
  return scoreDecodedText(text) >= 20;
}

function scoreDecodedText(text) {
  const value = String(text || "");
  if (!value) return 1000;

  const replacementCount = (value.match(/\uFFFD/gu) || []).length;
  const nullCount = (value.match(/\u0000/gu) || []).length;
  const controlCount = (value.match(/[\x01-\x08\x0B\x0C\x0E-\x1F]/g) || []).length;
  const mojibakeCount = (value.match(/[锟斤拷ÃÂÐÑÊÖÎ]/gu) || []).length;

  return (
    replacementCount * 30 +
    nullCount * 20 +
    controlCount * 10 +
    mojibakeCount * 2
  );
}

function cleanText(text) {
  return String(text || "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function parseEpubSource(inputPath) {
  const zip = new AdmZip(inputPath);
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "",
    trimValues: true,
  });

  const containerXml = readZipText(zip, "META-INF/container.xml");
  if (!containerXml) {
    throw new Error("EPUB is missing META-INF/container.xml");
  }

  const container = parser.parse(containerXml);
  const rootFiles = asArray(container?.container?.rootfiles?.rootfile);
  const opfPath = rootFiles[0]?.["full-path"];
  if (!opfPath) {
    throw new Error("EPUB container.xml does not point to an OPF file");
  }

  const opfXml = readZipText(zip, opfPath);
  if (!opfXml) {
    throw new Error(`EPUB is missing OPF file: ${opfPath}`);
  }

  const opf = parser.parse(opfXml);
  const pkg = opf?.package;
  const manifestItems = asArray(pkg?.manifest?.item);
  const spineItems = asArray(pkg?.spine?.itemref);
  if (!spineItems.length) {
    throw new Error("EPUB spine is empty");
  }

  const metadata = readEpubMetadata(pkg);
  const opfDir = path.posix.dirname(opfPath.replace(/\\/g, "/"));
  const itemById = new Map(manifestItems.map((item) => [item.id, item]));
  const sections = [];

  for (const spineItem of spineItems) {
    const item = itemById.get(spineItem.idref);
    if (!item || shouldSkipEpubItem(item)) continue;

    const href = String(item.href || "").replace(/\\/g, "/");
    const entryPath = opfDir === "." ? href : `${opfDir}/${href}`;
    const html = readZipText(zip, entryPath);
    if (!html) continue;

    const title = extractHtmlHeading(html) || fileStem(href);
    const text = cleanText(htmlToText(html, {
      wordwrap: false,
      selectors: [
        { selector: "img", format: "skip" },
        { selector: "script", format: "skip" },
        { selector: "style", format: "skip" },
      ],
    }));

    if (text) {
      sections.push({ title: normalizeTitle(title), text });
    }
  }

  if (!sections.length) {
    throw new Error("EPUB parsing result is empty after filtering spine items");
  }

  return { metadata, sections };
}

function readZipText(zip, entryPath) {
  const normalized = entryPath.replace(/\\/g, "/");
  const entry = zip.getEntry(normalized);
  return entry ? entry.getData().toString("utf8") : "";
}

function readEpubMetadata(pkg) {
  const metadata = pkg?.metadata || {};
  return {
    title: readXmlText(metadata["dc:title"]),
    author: readXmlText(metadata["dc:creator"]),
  };
}

function readXmlText(value) {
  if (Array.isArray(value)) {
    return readXmlText(value[0]);
  }

  if (value && typeof value === "object") {
    return String(value["#text"] || "").trim();
  }

  return String(value || "").trim();
}

function shouldSkipEpubItem(item) {
  if (!isHtmlLikeEpubItem(item)) return true;

  const properties = getEpubItemProperties(item);
  if (/\bnav\b/iu.test(properties)) return true;

  const id = String(item.id || "").toLowerCase();
  const hrefBase = getEpubItemHrefBase(item);

  return isSkippableEpubItemName(id) ||
    isSkippableEpubItemName(hrefBase);
}

function getEpubItemHrefBase(item) {
  const href = String(item?.href || "").replace(/\\/g, "/");
  const basename = path.posix.basename(href);
  return basename.replace(/\.[^.]*$/u, "").toLowerCase();
}

function getEpubItemProperties(item) {
  return String(item?.properties || "").toLowerCase();
}

function isHtmlLikeEpubItem(item) {
  const mediaType = String(item?.["media-type"] || "").toLowerCase();
  if (!mediaType) return true;

  return mediaType.includes("application/xhtml+xml") ||
    mediaType.includes("text/html");
}

function isSkippableEpubItemName(value) {
  const name = String(value || "").toLowerCase();
  if (!name) return false;
  if (/(目录|封面|版权)/u.test(name)) return true;

  return /^(cover|nav|toc|titlepage|copyright|contents)$/iu.test(name) ||
    /^(cover|nav|toc|titlepage|copyright|contents)[-_]?\d*$/iu.test(name) ||
    /(^|[-_])(cover|nav|toc|titlepage|copyright|contents)([-_]|$)/iu.test(name);
}

function extractHtmlHeading(html) {
  const match = String(html).match(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/iu);
  if (!match) return "";

  return cleanText(htmlToText(match[1], { wordwrap: false }));
}

function splitTextIntoSections(text) {
  const lines = cleanText(text).split("\n");
  const sections = [];
  let current = null;
  let fallback = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (isChapterTitle(trimmed)) {
      if (current) {
        sections.push(finalizeSection(current));
      } else if (fallback.join("").trim()) {
        sections.push(finalizeSection({
          title: "片段 1",
          lines: fallback,
        }));
        fallback = [];
      }

      current = { title: normalizeTitle(trimmed), lines: [] };
      continue;
    }

    if (current) {
      current.lines.push(line);
    } else {
      fallback.push(line);
    }
  }

  if (current) {
    sections.push(finalizeSection(current));
  } else if (fallback.join("").trim()) {
    sections.push(finalizeSection({ title: "片段 1", lines: fallback }));
  }

  return sections.filter((section) => section.text);
}

function finalizeSection(section) {
  return {
    title: normalizeTitle(section.title),
    text: cleanText(section.lines.join("\n")),
  };
}

function isChapterTitle(line) {
  if (!line || line.length < 2 || line.length > 80) return false;
  if (/[。；;]/.test(line)) return false;

  return [
    /^#{1,3}\s+.+$/u,
    /^第[一二三四五六七八九十百千万零〇0-9]+[章节回篇卷部](?:\s*[:：]\s*.+|\s+.+|.*)?$/u,
    /^[一二三四五六七八九十百千万零〇0-9]+[、.．]\s*.+$/u,
    /^Chapter\s+[0-9IVXLCDM]+(?:\s*[:：]\s*.+|\s+.+)?$/iu,
  ].some((pattern) => pattern.test(line));
}

function splitSectionsIntoChunks(sections, maxChars) {
  const chunks = [];

  for (const section of sections) {
    const parts = splitLongText(section.text, maxChars);

    parts.forEach((part, partIndex) => {
      const id = `ch${String(chunks.length).padStart(3, "0")}`;
      const sectionTitle = section.title || `片段 ${chunks.length + 1}`;
      const title = parts.length > 1
        ? `${sectionTitle} Part ${partIndex + 1}`
        : sectionTitle;
      const body = cleanText(part);

      chunks.push({
        id,
        title,
        sectionTitle,
        order: chunks.length,
        path: `chunks/${id}.md`,
        body,
        charCount: body.length,
        wordCount: countWords(body),
        preview: buildPreview(body),
        chunkHash: sha256(body),
        keywords: [],
        summary: null,
        prevId: null,
        nextId: null,
      });
    });
  }

  chunks.forEach((chunk, index) => {
    chunk.prevId = chunks[index - 1]?.id || null;
    chunk.nextId = chunks[index + 1]?.id || null;
  });

  return chunks;
}

function getChunkStats(chunks) {
  if (!chunks.length) {
    return {
      averageChars: 0,
      minChunkChars: 0,
      maxChunkChars: 0,
    };
  }

  const charCounts = chunks.map((chunk) => chunk.charCount);
  const totalChars = charCounts.reduce((sum, count) => sum + count, 0);

  return {
    averageChars: Math.round(totalChars / chunks.length),
    minChunkChars: Math.min(...charCounts),
    maxChunkChars: Math.max(...charCounts),
  };
}

function mergeTinyChunks(chunks, maxChars, minChars) {
  const tinyLimit = Math.max(120, Math.floor(minChars * 0.5));
  const merged = chunks.map((chunk) => ({ ...chunk }));

  for (let index = 0; index < merged.length; index += 1) {
    const chunk = merged[index];
    const currentLength = cleanText(chunk.body).length;
    if (currentLength >= tinyLimit) continue;

    const previous = merged[index - 1];
    if (previous) {
      const combinedBody = combineChunkBodies(previous, chunk);
      if (combinedBody.length <= maxChars) {
        previous.body = combinedBody;
        merged.splice(index, 1);
        index -= 1;
        continue;
      }
    }

    const next = merged[index + 1];
    if (next) {
      const combinedBody = combineChunkBodies(chunk, next);
      if (combinedBody.length <= maxChars) {
        merged[index + 1] = {
          ...next,
          title: chunk.title,
          sectionTitle: chunk.sectionTitle,
          body: combinedBody,
        };
        merged.splice(index, 1);
        index -= 1;
      }
    }
  }

  return rebuildChunkMetadata(merged);
}

function rebuildChunkMetadata(chunks) {
  const rebuilt = chunks.map((chunk, index) => {
    const id = `ch${String(index).padStart(3, "0")}`;
    const body = cleanText(chunk.body);

    return {
      id,
      title: chunk.title,
      sectionTitle: chunk.sectionTitle,
      order: index,
      path: `chunks/${id}.md`,
      body,
      charCount: body.length,
      wordCount: countWords(body),
      preview: buildPreview(body),
      chunkHash: sha256(body),
      keywords: [],
      summary: null,
      prevId: null,
      nextId: null,
    };
  });

  rebuilt.forEach((chunk, index) => {
    chunk.prevId = rebuilt[index - 1]?.id || null;
    chunk.nextId = rebuilt[index + 1]?.id || null;
  });

  return rebuilt;
}

function combineChunkBodies(left, right) {
  return cleanText(`${left.body}\n\n${buildChunkBodyWithTitle(right)}`);
}

function buildChunkBodyWithTitle(chunk) {
  return cleanText(`## ${chunk.title}\n\n${chunk.body}`);
}

function splitLongText(text, maxChars) {
  const cleaned = cleanText(text);
  if (cleaned.length <= maxChars) return [cleaned];

  const paragraphs = cleaned.split(/\n{2,}/u).map((part) => part.trim()).filter(Boolean);
  const chunks = [];
  let current = "";

  for (const paragraph of paragraphs) {
    if (paragraph.length > maxChars) {
      if (current) {
        chunks.push(current);
        current = "";
      }

      chunks.push(...splitOversizedParagraph(paragraph, maxChars));
      continue;
    }

    const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
    if (candidate.length <= maxChars) {
      current = candidate;
    } else {
      if (current) chunks.push(current);
      current = paragraph;
    }
  }

  if (current) chunks.push(current);

  return chunks.flatMap((chunk) => {
    if (chunk.length <= maxChars) return [chunk];
    return splitOversizedParagraph(chunk, maxChars);
  });
}

function splitOversizedParagraph(paragraph, maxChars) {
  const sentences = paragraph
    .split(/(?<=[。！？!?；;])\s*/u)
    .map((part) => part.trim())
    .filter(Boolean);

  if (sentences.length <= 1) {
    return hardSplit(paragraph, maxChars);
  }

  const chunks = [];
  let current = "";

  for (const sentence of sentences) {
    if (sentence.length > maxChars) {
      if (current) {
        chunks.push(current);
        current = "";
      }
      chunks.push(...hardSplit(sentence, maxChars));
      continue;
    }

    const candidate = current ? `${current}${sentence}` : sentence;
    if (candidate.length <= maxChars) {
      current = candidate;
    } else {
      if (current) chunks.push(current);
      current = sentence;
    }
  }

  if (current) chunks.push(current);
  return chunks;
}

function hardSplit(text, maxChars) {
  const chunks = [];
  for (let start = 0; start < text.length; start += maxChars) {
    chunks.push(text.slice(start, start + maxChars).trim());
  }
  return chunks.filter(Boolean);
}

function countWords(text) {
  const asciiWords = text.match(/[A-Za-z0-9]+(?:[-'][A-Za-z0-9]+)?/g) || [];
  const cjkChars = text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu) || [];
  return asciiWords.length + cjkChars.length;
}

function buildPreview(text) {
  return text.replace(/\s+/g, " ").trim().slice(0, 120);
}

function normalizeTitle(title) {
  return String(title || "").replace(/^#{1,3}\s+/u, "").trim() || "片段";
}

function fileStem(filePath) {
  return path.basename(filePath, path.extname(filePath));
}

function asArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function inferTextMetadata(text, inputPath) {
  const lines = cleanText(text)
    .split("\n")
    .slice(0, 30)
    .map((line) => line.trim());
  const metadata = {
    title: null,
    author: null,
  };

  readFrontmatterMetadata(lines, metadata);

  for (const line of lines) {
    if (!line || line === "---") continue;

    const title = matchTitleMetadata(line);
    if (!metadata.title && title) {
      metadata.title = title;
      continue;
    }

    const author = matchAuthorMetadata(line);
    if (!metadata.author && author) {
      metadata.author = author;
    }
  }

  return {
    title: metadata.title || fileStem(inputPath),
    author: metadata.author || null,
  };
}

function readFrontmatterMetadata(lines, metadata) {
  if (lines[0] !== "---") return;

  const endIndex = lines.findIndex((line, index) => index > 0 && line === "---");
  if (endIndex <= 1) return;

  for (const line of lines.slice(1, endIndex)) {
    const title = line.match(/^title\s*:\s*(.+)$/iu);
    if (!metadata.title && title) {
      metadata.title = cleanMetadataValue(title[1]);
      continue;
    }

    const author = line.match(/^author\s*:\s*(.+)$/iu);
    if (!metadata.author && author) {
      metadata.author = cleanMetadataValue(author[1]);
    }
  }
}

function matchTitleMetadata(line) {
  const match = line.match(/^(?:书名|标题)\s*[:：]\s*(.+)$/u) ||
    line.match(/^Title\s*:\s*(.+)$/iu);

  if (!match) return null;

  return cleanMetadataValue(match[1]);
}

function matchAuthorMetadata(line) {
  const match = line.match(/^(?:作者|著者)\s*[:：]\s*(.+)$/u) ||
    line.match(/^Author\s*:\s*(.+)$/iu) ||
    line.match(/^By\s+(.+)$/iu);

  if (!match) return null;

  const value = cleanMetadataValue(match[1]);
  if (!isValidAuthorMetadata(value)) return null;

  return value;
}

function cleanMetadataValue(value) {
  const cleaned = String(value || "")
    .trim()
    .replace(/^["'“‘《]+/u, "")
    .replace(/["'”’》]+$/u, "")
    .trim();

  if (!cleaned || cleaned.length > 120) return null;
  return cleaned;
}

function isValidAuthorMetadata(value) {
  if (!value || value.length > 80) return false;
  if (isChapterTitle(value)) return false;
  if (/^(?:第[一二三四五六七八九十百千万零〇0-9]+[章节回篇卷部]|Chapter\s+)/iu.test(value)) {
    return false;
  }
  return true;
}

function stripFrontmatter(text) {
  const cleaned = cleanText(text);
  const lines = cleaned.split("\n");
  if (lines[0]?.trim() !== "---") {
    return cleaned;
  }

  const endIndex = lines
    .slice(1, 50)
    .findIndex((line) => line.trim() === "---");
  if (endIndex < 0) {
    return cleaned;
  }

  return cleanText(lines.slice(endIndex + 2).join("\n"));
}

function mergeSmallSections(sections, maxChars, minChars) {
  const normalized = sections
    .map((section) => ({
      title: normalizeTitle(section.title),
      text: cleanText(section.text),
    }))
    .filter((section) => section.text);

  const merged = [];

  for (const section of normalized) {
    const last = merged[merged.length - 1];
    const sectionWithTitle = `## ${section.title}\n\n${section.text}`;

    if (
      last &&
      last.text.length < minChars &&
      last.text.length + sectionWithTitle.length + 2 <= maxChars
    ) {
      last.text = cleanText(`${last.text}\n\n${sectionWithTitle}`);
      continue;
    }

    merged.push({ ...section });
  }

  const secondPass = [];
  let buffer = null;

  for (const section of merged) {
    if (!buffer) {
      buffer = { ...section };
      continue;
    }

    const sectionWithTitle = `## ${section.title}\n\n${section.text}`;
    if (
      buffer.text.length < minChars &&
      buffer.text.length + sectionWithTitle.length + 2 <= maxChars
    ) {
      buffer.text = cleanText(`${buffer.text}\n\n${sectionWithTitle}`);
      continue;
    }

    secondPass.push(buffer);
    buffer = { ...section };
  }

  if (buffer) secondPass.push(buffer);
  return secondPass;
}

function loadSource(inputPath, cliTitle, cliAuthor) {
  const ext = path.extname(inputPath).toLowerCase();
  const sourceType = ext.replace(".", "");

  if (!["txt", "md", "epub"].includes(sourceType)) {
    throw new Error(`Unsupported input format: ${ext || "(none)"}`);
  }

  if (sourceType === "epub") {
    const epub = parseEpubSource(inputPath);
    return {
      sourceType,
      title: cliTitle || epub.metadata.title,
      author: cliAuthor || epub.metadata.author || null,
      sections: epub.sections,
      originalText: cleanText(epub.sections.map((section) => {
        return `# ${section.title}\n\n${section.text}`;
      }).join("\n\n")),
    };
  }

  const rawText = cleanText(readTextSource(inputPath));
  const metadata = inferTextMetadata(rawText, inputPath);
  const text = stripFrontmatter(rawText);
  return {
    sourceType,
    title: cliTitle || metadata.title,
    author: cliAuthor || metadata.author || null,
    sections: splitTextIntoSections(text),
    originalText: text,
  };
}

function writeBookOutput(options) {
  const readingDir = path.join(options.stateDir, "reading");
  const booksDir = path.join(readingDir, "books");
  const outputDir = path.join(booksDir, options.bookId);
  const chunksDir = path.join(outputDir, "chunks");
  const progressFile = path.join(readingDir, "progress.json");
  const searchIndexPath = path.join(outputDir, "search-index.json");
  let searchIndexReset = false;

  try {
    fs.mkdirSync(outputDir, { recursive: true });
    if (fs.existsSync(chunksDir)) {
      fs.rmSync(chunksDir, { recursive: true, force: true });
    }
    if (fs.existsSync(searchIndexPath)) {
      fs.rmSync(searchIndexPath, { force: true });
      searchIndexReset = true;
    }
    fs.mkdirSync(chunksDir, { recursive: true });
    if (!fs.existsSync(progressFile)) {
      fs.mkdirSync(readingDir, { recursive: true });
      fs.writeFileSync(progressFile, "{}\n", "utf8");
    }

    fs.writeFileSync(path.join(outputDir, "original.md"), `${options.originalText}\n`, "utf8");
    for (const chunk of options.chunks) {
      fs.writeFileSync(
        path.join(outputDir, chunk.path),
        `# ${chunk.title}\n\n${chunk.body}\n`,
        "utf8"
      );
    }

    const manifestChunks = options.chunks.map(({ body, ...chunk }) => chunk);
    const manifest = {
      bookId: options.bookId,
      title: options.title,
      author: options.author,
      sourceType: options.sourceType,
      sourcePath: normalizePath(options.inputPath),
      sourceHash: options.sourceHash,
      importedAt: new Date().toISOString(),
      maxChars: options.maxChars,
      minChars: options.minChars,
      rawSectionCount: options.rawSectionCount,
      sectionCount: options.sectionCount,
      totalChars: options.originalText.length,
      initialChunkCount: options.initialChunkCount,
      chunkCount: options.chunks.length,
      chunkStats: options.chunkStats,
      index: {
        status: "not_built",
        version: 1,
        path: "search-index.json",
        updatedAt: null,
      },
      chunks: manifestChunks,
    };

    const manifestPath = path.join(outputDir, "manifest.json");
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");

    return { outputDir, manifestPath, progressFile, manifest, searchIndexReset };
  } catch (error) {
    throw new Error(`Unable to write output directory: ${error.message}`);
  }
}

function importBook(argv) {
  const args = parseArgs(argv);
  const inputPath = path.resolve(args.input);

  if (!fs.existsSync(inputPath)) {
    throw new Error(`Input file does not exist: ${normalizePath(inputPath)}`);
  }

  const sourceBuffer = fs.readFileSync(inputPath);
  const source = loadSource(inputPath, args.title, args.author);
  const title = source.title || fileStem(inputPath);
  const bookId = args.bookId || createSafeBookId(title);
  const stateDir = resolveStateDir(args.stateDir);
  const rawSections = source.sections.length
    ? source.sections
    : splitTextIntoSections(source.originalText);
  const sections = mergeSmallSections(rawSections, args.maxChars, args.minChars);

  if (!source.originalText || !sections.length) {
    throw new Error("Parsing result is empty");
  }

  const initialChunks = splitSectionsIntoChunks(sections, args.maxChars);
  const chunks = mergeTinyChunks(initialChunks, args.maxChars, args.minChars);
  if (!chunks.length) {
    throw new Error("Chunk result is empty");
  }
  const chunkStats = getChunkStats(chunks);

  const output = writeBookOutput({
    inputPath,
    bookId,
    title,
    author: source.author,
    sourceType: source.sourceType,
    sourceHash: sha256(sourceBuffer),
    originalText: source.originalText,
    chunks,
    maxChars: args.maxChars,
    minChars: args.minChars,
    rawSectionCount: rawSections.length,
    sectionCount: sections.length,
    initialChunkCount: initialChunks.length,
    chunkStats,
    stateDir,
  });

  return {
    title,
    author: source.author,
    sourceType: source.sourceType,
    totalChars: source.originalText.length,
    chunkCount: chunks.length,
    maxChars: args.maxChars,
    minChars: args.minChars,
    rawSectionCount: rawSections.length,
    sectionCount: sections.length,
    initialChunkCount: initialChunks.length,
    averageChunkChars: chunkStats.averageChars,
    minChunkChars: chunkStats.minChunkChars,
    maxChunkChars: chunkStats.maxChunkChars,
    tinyChunksMerged: initialChunks.length - chunks.length,
    shortChunks: chunks.filter((chunk) => chunk.charCount < args.minChars).length,
    searchIndexReset: output.searchIndexReset,
    outputDir: output.outputDir,
    manifestPath: output.manifestPath,
  };
}

function printReport(report) {
  console.log("Imported reading book successfully.");
  console.log("");
  console.log(`Title: ${report.title}`);
  console.log(`Author: ${report.author || ""}`);
  console.log(`Source type: ${report.sourceType}`);
  console.log(`Total chars: ${report.totalChars}`);
  console.log(`Chunks: ${report.chunkCount}`);
  console.log(`Max chars: ${report.maxChars}`);
  console.log(`Min chars: ${report.minChars}`);
  console.log(`Raw sections: ${report.rawSectionCount}`);
  console.log(`Sections after merge: ${report.sectionCount}`);
  console.log(`Initial chunks: ${report.initialChunkCount}`);
  console.log(`Chunks after tiny merge: ${report.chunkCount}`);
  console.log(`Tiny chunks merged: ${report.tinyChunksMerged}`);
  console.log(`Short chunks: ${report.shortChunks}`);
  console.log(`Average chunk chars: ${report.averageChunkChars}`);
  console.log(`Min chunk chars: ${report.minChunkChars}`);
  console.log(`Max chunk chars: ${report.maxChunkChars}`);
  console.log(`Search index reset: ${report.searchIndexReset ? "yes" : "no"}`);
  console.log(`Output: ${normalizePath(report.outputDir)}`);
  console.log(`Manifest: ${normalizePath(report.manifestPath)}`);
}

function runCli(argv = process.argv.slice(2)) {
  try {
    const report = importBook(argv);
    printReport(report);
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  runCli();
}

module.exports = {
  parseArgs,
  resolveStateDir,
  normalizePath,
  sha256,
  createSafeBookId,
  readTextSource,
  parseEpubSource,
  cleanText,
  inferTextMetadata,
  getChunkStats,
  isHtmlLikeEpubItem,
  isSkippableEpubItemName,
  getEpubItemHrefBase,
  getEpubItemProperties,
  mergeSmallSections,
  mergeTinyChunks,
  rebuildChunkMetadata,
  combineChunkBodies,
  buildChunkBodyWithTitle,
  stripFrontmatter,
  splitTextIntoSections,
  splitSectionsIntoChunks,
  writeBookOutput,
  printReport,
  importBook,
  runCli,
};
