#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const DEFAULT_LIMIT = 10;
const DEFAULT_MAX_PREVIEW = 220;
const PROJECT_ROOT = resolveProjectRoot(__dirname);

const STOP_WORDS = new Set([
  "一个", "一种", "这个", "那个", "这些", "那些", "我们", "你们", "他们", "她们", "它们",
  "自己", "什么", "为什么", "怎么", "可以", "没有", "不是", "但是", "因为", "所以",
  "如果", "只是", "还是", "以及", "或者", "进行", "时候", "现在", "这样", "那样",
  "the", "a", "an", "and", "or", "but", "if", "then", "else", "of", "to",
  "in", "on", "for", "with", "as", "by", "is", "are", "was", "were",
  "be", "been", "being", "this", "that", "these", "those", "it", "its",
  "from", "at", "not",
]);

function parseArgs(argv) {
  const args = {
    bookId: null,
    all: false,
    query: null,
    stateDir: null,
    limit: DEFAULT_LIMIT,
    maxPreview: DEFAULT_MAX_PREVIEW,
    json: false,
    includeText: false,
    exact: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (!name.startsWith("--")) {
      throw new Error(`Unexpected argument: ${name}`);
    }

    if (name === "--all") {
      args.all = true;
      continue;
    }

    if (name === "--json") {
      args.json = true;
      continue;
    }

    if (name === "--include-text") {
      args.includeText = true;
      continue;
    }

    if (name === "--exact") {
      args.exact = true;
      continue;
    }

    const key = toCamelCase(name.slice(2));
    if (!Object.prototype.hasOwnProperty.call(args, key)) {
      throw new Error(`Unknown argument: ${name}`);
    }

    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for ${name}`);
    }

    args[key] = value;
    index += 1;
  }

  if (!args.query) {
    throw new Error("Missing required argument: --query <text>");
  }

  if ((args.bookId && args.all) || (!args.bookId && !args.all)) {
    throw new Error("Use exactly one of --book-id <bookId> or --all");
  }

  args.limit = Number(args.limit || DEFAULT_LIMIT);
  if (!Number.isInteger(args.limit) || args.limit < 1) {
    throw new Error("--limit must be a positive integer");
  }

  args.maxPreview = Number(args.maxPreview || DEFAULT_MAX_PREVIEW);
  if (!Number.isInteger(args.maxPreview) || args.maxPreview < 80) {
    throw new Error("--max-preview must be an integer greater than or equal to 80");
  }

  return args;
}

function toCamelCase(value) {
  return String(value).replace(/-([a-z])/g, (_, char) => char.toUpperCase());
}

function resolveProjectRoot(scriptDir) {
  const directRoot = path.resolve(scriptDir, "..");
  if (path.basename(directRoot).toLowerCase() === "xiaoye") {
    return path.resolve(scriptDir, "../..");
  }

  return directRoot;
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

function cleanInlineText(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function tokenizeQuery(query) {
  const tokens = new Set();
  const text = cleanText(query);

  const asciiPattern = /[A-Za-z0-9]+(?:[-'][A-Za-z0-9]+)?/g;
  let asciiMatch = null;
  while ((asciiMatch = asciiPattern.exec(text)) !== null) {
    const token = asciiMatch[0].toLowerCase();
    if (!STOP_WORDS.has(token)) {
      tokens.add(token);
    }
  }

  const hanPattern = /[\p{Script=Han}]+/gu;
  let hanMatch = null;
  while ((hanMatch = hanPattern.exec(text)) !== null) {
    const segment = hanMatch[0];
    if (segment.length === 2 || segment.length === 3) {
      if (!STOP_WORDS.has(segment)) {
        tokens.add(segment);
      }
    }

    for (let index = 0; index <= segment.length - 2; index += 1) {
      const token = segment.slice(index, index + 2);
      if (!STOP_WORDS.has(token)) {
        tokens.add(token);
      }
    }
  }

  if (!tokens.size) {
    const fallback = cleanInlineText(query);
    if (fallback) {
      tokens.add(fallback);
    }
  }

  return Array.from(tokens);
}

function searchReadingBooks(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  return searchReadingBooksWithArgs(args);
}

function searchReadingBooksWithArgs(args) {
  const stateDir = resolveStateDir(args.stateDir);
  if (!fs.existsSync(stateDir)) {
    throw new Error(`stateDir does not exist: ${normalizePath(stateDir)}`);
  }

  const booksDir = path.join(stateDir, "reading", "books");
  if (!fs.existsSync(booksDir)) {
    throw new Error(`reading/books does not exist: ${normalizePath(booksDir)}`);
  }

  const tokens = tokenizeQuery(args.query);
  if (args.all) {
    return searchAllBooks(booksDir, args, tokens);
  }

  return searchSingleBook(booksDir, args.bookId, args, tokens);
}

function searchSingleBook(booksDir, bookId, args, tokens) {
  const result = searchBookIndex(path.join(booksDir, bookId), args.query, {
    ...args,
    tokens,
  });

  return {
    query: args.query,
    tokens,
    resultCount: result.results.length,
    results: result.results,
    warnings: result.warnings,
  };
}

function searchAllBooks(booksDir, args, tokens) {
  const warnings = [];
  const results = [];
  const bookDirs = fs.readdirSync(booksDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  for (const bookId of bookDirs) {
    const bookDir = path.join(booksDir, bookId);
    if (!args.exact && !fs.existsSync(path.join(bookDir, "search-index.json"))) {
      continue;
    }

    if (args.exact && !fs.existsSync(path.join(bookDir, "manifest.json"))) {
      warnings.push(`${bookId}: manifest.json does not exist`);
      continue;
    }

    try {
      const result = searchBookIndex(bookDir, args.query, {
        ...args,
        tokens,
      });
      warnings.push(...result.warnings);
      results.push(...result.results);
    } catch (error) {
      warnings.push(`${bookId}: ${error.message}`);
    }
  }

  const sorted = sortResults(results).slice(0, args.limit);
  return {
    query: args.query,
    tokens,
    resultCount: sorted.length,
    results: sorted,
    warnings,
  };
}

function searchBookIndex(bookDir, query, options) {
  if (!fs.existsSync(bookDir)) {
    throw new Error(`bookId does not exist: ${path.basename(bookDir)}`);
  }

  const manifestPath = path.join(bookDir, "manifest.json");
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`manifest.json does not exist: ${normalizePath(manifestPath)}`);
  }

  const manifest = readJsonFile(manifestPath, "manifest");
  const warnings = [];
  const tokens = options.tokens || tokenizeQuery(query);

  if (options.exact) {
    const results = scanChunksExact(bookDir, manifest, query, options, warnings)
      .slice(0, options.limit)
      .map((candidate) => formatSearchResult(candidate, manifest, {}, options));

    if (!results.length) {
      warnings.push(`${path.basename(bookDir)}: no exact chunk matches`);
    }

    return { results, warnings };
  }

  const indexPath = path.join(bookDir, "search-index.json");
  if (!fs.existsSync(indexPath)) {
    throw new Error("search-index.json does not exist; run build-reading-search-index.js first");
  }

  const index = readJsonFile(indexPath, "search-index");
  if (manifest?.index?.status !== "built") {
    warnings.push(`${path.basename(bookDir)}: manifest index status is not built`);
  }

  const chunkById = buildChunkMap(manifest, index);
  const hitMap = collectIndexedHits(index, tokens, chunkById);
  let candidates = Array.from(hitMap.values());

  if (!candidates.length) {
    candidates = scanChunksFallback(bookDir, manifest, query, tokens, options.maxPreview, warnings);
  } else {
    const candidatesToRead = sortResults(candidates.slice()).slice(0, Math.max(options.limit * 5, 20));
    enrichIndexedCandidates(bookDir, query, tokens, chunkById, candidatesToRead, options);
  }

  const results = sortResults(candidates)
    .slice(0, options.limit)
    .map((candidate) => formatSearchResult(candidate, manifest, index, options));

  return { results, warnings };
}

function readJsonFile(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`${label} JSON parse failed: ${normalizePath(filePath)}: ${error.message}`);
  }
}

function buildChunkMap(manifest, index) {
  const manifestMap = new Map((manifest.chunks || []).map((chunk) => [chunk.id, chunk]));
  const indexMap = new Map((index.chunks || []).map((chunk) => [chunk.chunkId, chunk]));
  const chunkIds = new Set([...manifestMap.keys(), ...indexMap.keys()]);
  const result = new Map();

  for (const chunkId of chunkIds) {
    const manifestChunk = manifestMap.get(chunkId) || {};
    const indexChunk = indexMap.get(chunkId) || {};
    result.set(chunkId, {
      chunkId,
      chunkTitle: indexChunk.title || manifestChunk.title || chunkId,
      sectionTitle: indexChunk.sectionTitle || manifestChunk.sectionTitle || null,
      path: indexChunk.path || manifestChunk.path || null,
      charCount: indexChunk.charCount || manifestChunk.charCount || 0,
      order: typeof manifestChunk.order === "number" ? manifestChunk.order : Number.MAX_SAFE_INTEGER,
      preview: indexChunk.preview || manifestChunk.preview || "",
    });
  }

  return result;
}

function collectIndexedHits(index, tokens, chunkById) {
  const hits = new Map();

  for (const token of tokens) {
    const entries = normalizeTermEntries(index.terms?.[token]);
    if (!entries.length) continue;

    for (const entry of entries) {
      const chunkMeta = chunkById.get(entry.chunkId);
      if (!chunkMeta) continue;

      if (!hits.has(entry.chunkId)) {
        hits.set(entry.chunkId, {
          ...chunkMeta,
          score: 0,
          matchedTerms: new Set(),
        });
      }

      const hit = hits.get(entry.chunkId);
      hit.score += entry.count * getTokenWeight(token);
      hit.matchedTerms.add(token);
    }
  }

  return hits;
}

function normalizeTermEntries(entries) {
  if (!Array.isArray(entries)) return [];

  return entries
    .map((entry) => {
      if (Array.isArray(entry) && entry.length >= 2) {
        return { chunkId: entry[0], count: Number(entry[1]) || 0 };
      }

      if (entry && typeof entry === "object") {
        return { chunkId: entry.chunkId, count: Number(entry.count) || 0 };
      }

      return null;
    })
    .filter((entry) => entry && entry.chunkId && entry.count > 0);
}

function getTokenWeight(token) {
  if (/[A-Za-z]/.test(token)) return 2;
  if (String(token).length >= 3) return 2;
  return 1;
}

function enrichIndexedCandidates(bookDir, query, tokens, chunkById, candidates, options) {
  for (const candidate of candidates) {
    const fileText = readChunkBody(bookDir, candidate.path);
    if (!fileText) {
      candidate.preview = candidate.preview || buildSearchPreview("", query, Array.from(candidate.matchedTerms), options.maxPreview);
      if (options.includeText) {
        candidate.textPreview = candidate.preview;
      }
      continue;
    }

    if (fileText.includes(query)) {
      candidate.score += 4;
    }

    candidate.preview = buildSearchPreview(fileText, query, Array.from(candidate.matchedTerms), options.maxPreview) ||
      candidate.preview ||
      buildSearchPreview("", query, Array.from(candidate.matchedTerms), options.maxPreview);

    if (options.includeText) {
      candidate.textPreview = buildSearchPreview(
        fileText,
        query,
        Array.from(candidate.matchedTerms),
        Math.max(options.maxPreview * 2, 400)
      );
    }
  }
}

function scanChunksFallback(bookDir, manifest, query, tokens, maxPreview, warnings) {
  const matches = [];

  for (const chunk of manifest.chunks || []) {
    const text = readChunkBody(bookDir, chunk.path);
    if (!text) continue;

    const matchedTerms = tokens.filter((token) => text.includes(token));
    if (!text.includes(query) && !matchedTerms.length) {
      continue;
    }

    const score = (text.includes(query) ? 4 : 0) +
      matchedTerms.reduce((sum, token) => sum + getTokenWeight(token), 0);

    matches.push({
      chunkId: chunk.id,
      chunkTitle: chunk.title,
      sectionTitle: chunk.sectionTitle,
      path: chunk.path,
      charCount: chunk.charCount || text.length,
      order: typeof chunk.order === "number" ? chunk.order : Number.MAX_SAFE_INTEGER,
      score,
      matchedTerms: new Set(matchedTerms.length ? matchedTerms : [query]),
      preview: buildSearchPreview(text, query, matchedTerms, maxPreview),
      fallback: true,
    });
  }

  if (!matches.length) {
    warnings.push(`${path.basename(bookDir)}: no indexed terms or fallback chunk matches`);
  }

  return matches;
}

function scanChunksExact(bookDir, manifest, query, options, warnings) {
  const matches = [];
  const normalizedQuery = cleanInlineText(query);

  for (const chunk of manifest.chunks || []) {
    const chunkPath = path.join(bookDir, chunk.path || "");
    if (!chunk.path || !fs.existsSync(chunkPath)) {
      warnings.push(`${path.basename(bookDir)}: missing chunk file ${chunk.path || chunk.id}`);
      continue;
    }

    const text = stripChunkFileTitle(fs.readFileSync(chunkPath, "utf8"));
    const normalizedText = cleanInlineText(text);
    if (!normalizedQuery || !normalizedText.includes(normalizedQuery)) {
      continue;
    }

    const count = countOccurrences(normalizedText, normalizedQuery);
    matches.push({
      chunkId: chunk.id,
      chunkTitle: chunk.title,
      sectionTitle: chunk.sectionTitle,
      path: chunk.path,
      charCount: chunk.charCount || text.length,
      order: typeof chunk.order === "number" ? chunk.order : Number.MAX_SAFE_INTEGER,
      score: 100 + count * 5,
      matchedTerms: new Set([query]),
      preview: buildSearchPreview(text, query, [query], options.maxPreview),
      textPreview: options.includeText
        ? buildSearchPreview(text, query, [query], Math.max(options.maxPreview * 2, 400))
        : undefined,
      exact: true,
    });
  }

  return matches;
}

function readChunkBody(bookDir, relativePath) {
  if (!relativePath) return "";
  const chunkPath = path.join(bookDir, relativePath);
  if (!fs.existsSync(chunkPath)) return "";
  return stripChunkFileTitle(fs.readFileSync(chunkPath, "utf8"));
}

function stripChunkFileTitle(text) {
  const cleaned = cleanText(text);
  const lines = cleaned.split("\n");
  if (!/^#\s+.+$/u.test(lines[0] || "")) {
    return cleaned;
  }

  let index = 1;
  while (index < lines.length && !lines[index].trim()) {
    index += 1;
  }

  return cleanText(lines.slice(index).join("\n"));
}

function buildSearchPreview(text, query, matchedTerms, maxPreview) {
  const source = cleanInlineText(text);
  if (!source) return "";

  let position = source.indexOf(cleanInlineText(query));
  if (position < 0) {
    for (const term of matchedTerms) {
      position = source.indexOf(term);
      if (position >= 0) break;
    }
  }

  if (position < 0) {
    return source.slice(0, maxPreview);
  }

  const half = Math.floor(maxPreview / 2);
  const start = Math.max(0, position - half);
  const end = Math.min(source.length, start + maxPreview);
  const preview = source.slice(start, end);
  const prefix = start > 0 ? "……" : "";
  const suffix = end < source.length ? "……" : "";

  return `${prefix}${preview}${suffix}`;
}

function countOccurrences(text, query) {
  let count = 0;
  let start = 0;

  while (start >= 0) {
    const index = text.indexOf(query, start);
    if (index < 0) break;
    count += 1;
    start = index + query.length;
  }

  return count;
}

function sortResults(results) {
  return results.sort((left, right) => {
    return right.score - left.score ||
      right.matchedTerms.size - left.matchedTerms.size ||
      left.order - right.order;
  });
}

function formatSearchResult(candidate, manifest, index, options) {
  return {
    bookId: index.bookId || manifest.bookId,
    title: index.title || manifest.title || manifest.bookId,
    author: index.author || manifest.author || null,
    chunkId: candidate.chunkId,
    chunkTitle: candidate.chunkTitle,
    sectionTitle: candidate.sectionTitle,
    path: candidate.path,
    score: candidate.score,
    matchedTerms: Array.from(candidate.matchedTerms),
    preview: candidate.preview || candidate.path,
    charCount: candidate.charCount,
    ...(candidate.exact ? { exact: true } : {}),
    ...(options.includeText ? { textPreview: candidate.textPreview || candidate.preview || "" } : {}),
  };
}

function printTextResult(result) {
  if (!result.results.length) {
    console.log("No reading search results.");
    console.log("");
    console.log(`Query: ${result.query}`);
    console.log("Tip: If this book was recently imported, run build-reading-search-index.js first.");
    return;
  }

  console.log("Search reading books successfully.");
  console.log("");
  console.log(`Query: ${result.query}`);
  console.log(`Results: ${result.results.length}`);
  console.log("");

  result.results.forEach((item, index) => {
    console.log(`[${index + 1}] ${formatBookLabel(item)} / ${item.chunkId} / ${item.chunkTitle}`);
    console.log(`Score: ${item.score}`);
    console.log(`Matched: ${item.matchedTerms.join(", ")}`);
    console.log(`Path: ${item.path}`);
    console.log(`Preview: ${item.preview}`);
    if (item.textPreview) {
      console.log(`Text preview: ${item.textPreview}`);
    }
    console.log("");
  });

  for (const warning of result.warnings) {
    console.log(`Warning: ${warning}`);
  }
}

function formatBookLabel(item) {
  if (!item.bookId || item.bookId === item.title) {
    return item.title;
  }

  return `${item.bookId} / ${item.title}`;
}

function runCli(argv = process.argv.slice(2)) {
  try {
    const args = parseArgs(argv);
    const result = searchReadingBooksWithArgs(args);
    if (args.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    printTextResult(result);
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
  normalizePath,
  resolveProjectRoot,
  resolveStateDir,
  cleanText,
  cleanInlineText,
  tokenizeQuery,
  searchReadingBooks,
  searchReadingBooksWithArgs,
  searchBookIndex,
  buildSearchPreview,
  runCli,
};
