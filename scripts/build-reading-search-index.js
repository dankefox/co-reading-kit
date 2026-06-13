#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const INDEX_VERSION = 1;
const DEFAULT_MIN_TERM_LENGTH = 2;
const DEFAULT_MIN_TOTAL_COUNT = 2;
const DEFAULT_MAX_PREVIEW = 160;
const DEFAULT_MAX_TERM_CHUNKS = 50;
const DEFAULT_MAX_CHUNK_RATIO = 0.6;
const DEFAULT_NGRAM_SIZES = "2";
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
    stateDir: null,
    minTermLength: DEFAULT_MIN_TERM_LENGTH,
    minTotalCount: DEFAULT_MIN_TOTAL_COUNT,
    maxPreview: DEFAULT_MAX_PREVIEW,
    maxTermChunks: DEFAULT_MAX_TERM_CHUNKS,
    maxChunkRatio: DEFAULT_MAX_CHUNK_RATIO,
    ngramSizes: DEFAULT_NGRAM_SIZES,
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

  if ((args.bookId && args.all) || (!args.bookId && !args.all)) {
    throw new Error("Use exactly one of --book-id <bookId> or --all");
  }

  args.minTermLength = Number(args.minTermLength || DEFAULT_MIN_TERM_LENGTH);
  if (!Number.isInteger(args.minTermLength) || args.minTermLength < 1) {
    throw new Error("--min-term-length must be a positive integer");
  }

  args.minTotalCount = Number(args.minTotalCount || DEFAULT_MIN_TOTAL_COUNT);
  if (!Number.isInteger(args.minTotalCount) || args.minTotalCount < 1) {
    throw new Error("--min-total-count must be a positive integer");
  }

  args.maxPreview = Number(args.maxPreview || DEFAULT_MAX_PREVIEW);
  if (!Number.isInteger(args.maxPreview) || args.maxPreview < 40) {
    throw new Error("--max-preview must be an integer greater than or equal to 40");
  }

  args.maxTermChunks = Number(args.maxTermChunks || DEFAULT_MAX_TERM_CHUNKS);
  if (!Number.isInteger(args.maxTermChunks) || args.maxTermChunks < 1) {
    throw new Error("--max-term-chunks must be a positive integer");
  }

  args.maxChunkRatio = Number(args.maxChunkRatio || DEFAULT_MAX_CHUNK_RATIO);
  if (!Number.isFinite(args.maxChunkRatio) || args.maxChunkRatio <= 0 || args.maxChunkRatio > 1) {
    throw new Error("--max-chunk-ratio must be a number greater than 0 and less than or equal to 1");
  }

  args.ngramSizes = parseNgramSizes(args.ngramSizes);

  return args;
}

function parseNgramSizes(value) {
  const sizes = String(value || DEFAULT_NGRAM_SIZES)
    .split(",")
    .map((part) => Number(part.trim()))
    .filter((size) => Number.isInteger(size) && (size === 2 || size === 3));

  if (!sizes.length) {
    throw new Error("--ngram-sizes must include 2 or 3");
  }

  return Array.from(new Set(sizes)).sort((left, right) => left - right);
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

function buildReadingSearchIndex(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const stateDir = resolveStateDir(args.stateDir);
  if (!fs.existsSync(stateDir)) {
    throw new Error(`stateDir does not exist: ${normalizePath(stateDir)}`);
  }

  const booksDir = path.join(stateDir, "reading", "books");
  if (!fs.existsSync(booksDir)) {
    throw new Error(`reading/books does not exist: ${normalizePath(booksDir)}`);
  }

  if (args.all) {
    return buildAllBookIndexes(booksDir, args);
  }

  return buildOneBookIndex(booksDir, args.bookId, args);
}

function buildAllBookIndexes(booksDir, args) {
  const bookIds = fs.readdirSync(booksDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const reports = [];
  let failed = 0;
  let warnings = 0;

  for (const bookId of bookIds) {
    try {
      const report = buildOneBookIndex(booksDir, bookId, args);
      printSingleReport(report);
      reports.push(report);
      warnings += report.warningCount;
    } catch (error) {
      failed += 1;
      console.error(`Failed to build index for ${bookId}: ${error.message}`);
    }
  }

  console.log("");
  console.log(`Books processed: ${bookIds.length}`);
  console.log(`Succeeded: ${reports.length}`);
  console.log(`Failed: ${failed}`);
  console.log(`Warnings: ${warnings}`);

  return { reports, failed, warnings };
}

function buildOneBookIndex(booksDir, bookId, args) {
  const bookDir = path.join(booksDir, bookId);
  if (!fs.existsSync(bookDir)) {
    throw new Error(`bookId does not exist: ${bookId}`);
  }

  const manifestPath = path.join(bookDir, "manifest.json");
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`manifest.json does not exist: ${normalizePath(manifestPath)}`);
  }

  const manifest = readManifest(manifestPath);
  const warnings = [];
  const index = buildIndexFromManifest(bookDir, manifest, args, warnings);
  if (!index.chunks.length) {
    throw new Error("No indexable chunks found");
  }

  const indexPath = path.join(bookDir, "search-index.json");
  fs.writeFileSync(indexPath, JSON.stringify(index) + "\n", "utf8");
  const indexSizeBytes = fs.statSync(indexPath).size;
  if (indexSizeBytes > 10 * 1024 * 1024) {
    warnings.push(`Large index file: ${formatIndexSize(indexSizeBytes)}`);
  }

  const updatedAt = new Date().toISOString();
  manifest.index = {
    status: "built",
    version: INDEX_VERSION,
    path: "search-index.json",
    updatedAt,
    options: buildIndexOptions(args),
  };
  updateManifestChunkKeywords(manifest, index);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");

  return {
    title: manifest.title || bookId,
    bookId,
    chunkCount: index.chunks.length,
    termCount: index.termCount,
    indexSizeBytes,
    outputPath: indexPath,
    manifestPath,
    warningCount: warnings.length,
    warnings,
  };
}

function readManifest(manifestPath) {
  try {
    return JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(`manifest JSON parse failed: ${normalizePath(manifestPath)}: ${error.message}`);
  }
}

function buildIndexFromManifest(bookDir, manifest, args, warnings) {
  const termIndex = new Map();
  const chunkEntries = [];

  for (const chunk of Array.isArray(manifest.chunks) ? manifest.chunks : []) {
    const chunkPath = path.join(bookDir, chunk.path || "");
    if (!fs.existsSync(chunkPath)) {
      warnings.push(`Missing chunk file: ${chunk.path || chunk.id}`);
      continue;
    }

    const text = stripChunkFileTitle(fs.readFileSync(chunkPath, "utf8"));
    const terms = extractTerms(text, {
      minTermLength: args.minTermLength,
      ngramSizes: args.ngramSizes,
    });

    chunkEntries.push({
      chunk,
      terms,
      summary: {
        chunkId: chunk.id,
        title: chunk.title,
        sectionTitle: chunk.sectionTitle,
        path: chunk.path,
        charCount: text.length,
        preview: buildChunkPreview(text, args.maxPreview),
        terms: [],
        termCount: 0,
      },
    });

    for (const [term, info] of terms) {
      if (!termIndex.has(term)) {
        termIndex.set(term, []);
      }

      termIndex.get(term).push({
        chunkId: chunk.id,
        count: info.count,
      });
    }
  }

  const { terms, allowedTerms } = buildCompactTermIndex(termIndex, chunkEntries.length, args);
  const chunkSummaries = chunkEntries.map((entry) => {
    const filteredTerms = filterTermMap(entry.terms, allowedTerms);
    const topTerms = sortTermEntries(filteredTerms).slice(0, 20).map(([term]) => term);

    return {
      ...entry.summary,
      terms: topTerms,
      termCount: filteredTerms.size,
    };
  });

  return {
    bookId: manifest.bookId,
    title: manifest.title,
    author: manifest.author,
    version: INDEX_VERSION,
    builtAt: new Date().toISOString(),
    sourceHash: manifest.sourceHash,
    chunkCount: chunkSummaries.length,
    termCount: Object.keys(terms).length,
    options: buildIndexOptions(args),
    chunks: chunkSummaries,
    terms,
  };
}

function buildIndexOptions(args) {
  return {
    minTermLength: args.minTermLength,
    minTotalCount: args.minTotalCount,
    maxPreview: args.maxPreview,
    maxTermChunks: args.maxTermChunks,
    maxChunkRatio: args.maxChunkRatio,
    ngramSizes: args.ngramSizes,
  };
}

function buildCompactTermIndex(termIndex, chunkCount, args) {
  const terms = {};
  const allowedTerms = new Set();
  const maxAllowedChunks = Math.max(1, Math.floor(chunkCount * args.maxChunkRatio));

  for (const [term, entries] of Array.from(termIndex.entries()).sort(([left], [right]) => {
    return left.localeCompare(right, "zh-Hans-CN");
  })) {
    const totalCount = entries.reduce((sum, entry) => sum + entry.count, 0);
    if (totalCount < args.minTotalCount) continue;
    if (entries.length > maxAllowedChunks) continue;

    const compactEntries = entries
      .sort((left, right) => {
        return right.count - left.count || left.chunkId.localeCompare(right.chunkId);
      })
      .slice(0, args.maxTermChunks)
      .map((entry) => [entry.chunkId, entry.count]);

    if (!compactEntries.length) continue;

    terms[term] = compactEntries;
    allowedTerms.add(term);
  }

  return { terms, allowedTerms };
}

function filterTermMap(terms, allowedTerms) {
  const filtered = new Map();
  for (const [term, info] of terms) {
    if (allowedTerms.has(term)) {
      filtered.set(term, info);
    }
  }
  return filtered;
}

function extractTerms(text, options = {}) {
  const minTermLength = Number(options.minTermLength || DEFAULT_MIN_TERM_LENGTH);
  const ngramSizes = Array.isArray(options.ngramSizes)
    ? options.ngramSizes
    : parseNgramSizes(options.ngramSizes || DEFAULT_NGRAM_SIZES);
  const terms = new Map();
  const value = String(text || "");

  addRegexTerms(value, /[A-Za-z0-9]+(?:[-'][A-Za-z0-9]+)?/g, minTermLength, terms, (term) => {
    return term.toLowerCase();
  });

  const hanPattern = /[\p{Script=Han}]+/gu;
  let match = null;
  while ((match = hanPattern.exec(value)) !== null) {
    const segment = match[0];
    for (const size of ngramSizes) {
      if (size < minTermLength) continue;
      for (let index = 0; index <= segment.length - size; index += 1) {
        addTerm(terms, segment.slice(index, index + size), match.index + index, minTermLength);
      }
    }
  }

  return terms;
}

function addRegexTerms(text, pattern, minTermLength, terms, normalize) {
  let match = null;
  while ((match = pattern.exec(text)) !== null) {
    addTerm(terms, normalize(match[0]), match.index, minTermLength);
  }
}

function addTerm(terms, term, position, minTermLength) {
  if (!term || term.length < minTermLength || term.length > 30) return;
  if (STOP_WORDS.has(term)) return;

  if (!terms.has(term)) {
    terms.set(term, {
      count: 0,
    });
  }

  const entry = terms.get(term);
  entry.count += 1;
}

function sortTermEntries(terms) {
  return Array.from(terms.entries()).sort(([leftTerm, left], [rightTerm, right]) => {
    return right.count - left.count || leftTerm.localeCompare(rightTerm, "zh-Hans-CN");
  });
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

function buildChunkPreview(text, maxPreview) {
  return cleanInlineText(text).slice(0, maxPreview);
}

function cleanInlineText(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function formatIndexSize(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function updateManifestChunkKeywords(manifest, index) {
  const keywordsByChunkId = new Map(index.chunks.map((chunk) => {
    return [chunk.chunkId, chunk.terms.slice(0, 10)];
  }));

  if (!Array.isArray(manifest.chunks)) return;

  for (const chunk of manifest.chunks) {
    if (keywordsByChunkId.has(chunk.id)) {
      chunk.keywords = keywordsByChunkId.get(chunk.id);
    } else {
      chunk.keywords = [];
    }
  }
}

function printSingleReport(report) {
  console.log("Built reading search index successfully.");
  console.log("");
  console.log(`Book: ${report.title}`);
  console.log(`Book ID: ${report.bookId}`);
  console.log(`Chunks indexed: ${report.chunkCount}`);
  console.log(`Terms: ${report.termCount}`);
  console.log(`Index size: ${formatIndexSize(report.indexSizeBytes)}`);
  console.log(`Output: ${normalizePath(report.outputPath)}`);
  console.log(`Manifest updated: ${normalizePath(report.manifestPath)}`);
  console.log(`Warnings: ${report.warningCount}`);
  for (const warning of report.warnings) {
    console.log(`Warning: ${warning}`);
  }
}

function runCli(argv = process.argv.slice(2)) {
  try {
    const result = buildReadingSearchIndex(argv);
    if (result?.reports) return;

    printSingleReport(result);
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
  parseNgramSizes,
  normalizePath,
  resolveProjectRoot,
  resolveStateDir,
  cleanText,
  buildReadingSearchIndex,
  buildOneBookIndex,
  buildAllBookIndexes,
  buildIndexFromManifest,
  buildIndexOptions,
  buildCompactTermIndex,
  filterTermMap,
  extractTerms,
  stripChunkFileTitle,
  formatIndexSize,
  updateManifestChunkKeywords,
  runCli,
};
