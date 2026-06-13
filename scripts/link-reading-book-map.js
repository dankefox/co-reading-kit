#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const MAP_VERSION = 1;
const DEFAULT_LINK_THRESHOLD = 0.88;
const SHORT_TITLE_LINK_THRESHOLD = 0.93;
const DEFAULT_PENDING_THRESHOLD = 0.65;
const PROJECT_ROOT = resolveProjectRoot(__dirname);

function parseArgs(argv) {
  const args = {
    wereadBookId: null,
    wereadTitle: null,
    wereadAuthor: null,
    localBookId: null,
    confirm: false,
    listPending: false,
    stateDir: null,
    json: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (!name.startsWith("--")) {
      throw new Error(`Unexpected argument: ${name}`);
    }

    if (name === "--confirm") {
      args.confirm = true;
      continue;
    }

    if (name === "--list-pending") {
      args.listPending = true;
      continue;
    }

    if (name === "--json") {
      args.json = true;
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

  if (args.listPending) {
    if (
      args.wereadBookId ||
      args.wereadTitle ||
      args.wereadAuthor ||
      args.localBookId ||
      args.confirm
    ) {
      throw new Error("--list-pending cannot be combined with other matching arguments");
    }
    return args;
  }

  if (!args.wereadTitle && !args.wereadBookId && !args.confirm) {
    throw new Error("Missing required argument: --weread-title <title> or --weread-book-id <id>");
  }

  if (args.confirm && !args.localBookId) {
    throw new Error("--confirm requires --local-book-id <bookId>");
  }
  if (args.confirm && !args.wereadTitle && !args.wereadBookId) {
    throw new Error("--confirm requires --weread-title or --weread-book-id");
  }

  return args;
}

function toCamelCase(value) {
  return String(value).replace(/-([a-z])/g, (_, char) => char.toUpperCase());
}

function normalizePath(value) {
  return path.resolve(String(value)).replace(/\\/g, "/");
}

function resolveProjectRoot(scriptDir) {
  const directRoot = path.resolve(scriptDir, "..");
  if (path.basename(directRoot).toLowerCase() === "xiaoye") {
    return path.resolve(scriptDir, "../..");
  }

  return directRoot;
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

function normalizeBookTitle(title) {
  let value = String(title || "").normalize("NFKC");

  value = value
    .replace(/[《》]/gu, " ")
    .replace(/\.(?:epub|txt|md)\b/giu, " ")
    .replace(/\b(?:epub|txt|md)\b/giu, " ")
    .replace(/\b(?:全集|完本|校对版|校對版|出版版|番外|精校版|精修版|实体书版|實體書版)\b/gu, " ");

  value = value.replace(/[\[(（【][^\])）】]{0,30}[\])）】]/gu, (segment) => {
    const inner = segment.slice(1, -1);
    return isDisposableBookTitleShell(inner) ? " " : inner;
  });

  value = value
    .replace(/作者[:：]/gu, " ")
    .replace(/[\u3000\s]+/gu, "")
    .replace(/[^\p{Script=Han}A-Za-z0-9]+/gu, "")
    .toLowerCase();

  return value;
}

function isDisposableBookTitleShell(value) {
  const inner = String(value || "")
    .normalize("NFKC")
    .replace(/[\u3000\s]+/gu, "")
    .toLowerCase();

  if (!inner) {
    return true;
  }

  if (/^(?:无限|完本|全集|校对版|校對版|出版版|epub|txt|md|番外|精校版|精修版)+$/u.test(inner)) {
    return true;
  }

  return false;
}

function normalizeAuthorName(author) {
  return String(author || "")
    .normalize("NFKC")
    .replace(/作者[:：]/gu, " ")
    .replace(/[\u3000\s]+/gu, "")
    .replace(/[^\p{Script=Han}A-Za-z0-9]+/gu, "")
    .toLowerCase();
}

function loadLocalBooks(stateDir) {
  if (!fs.existsSync(stateDir)) {
    throw new Error(`stateDir does not exist: ${normalizePath(stateDir)}`);
  }

  const booksDir = path.join(stateDir, "reading", "books");
  if (!fs.existsSync(booksDir)) {
    throw new Error(`reading/books does not exist: ${normalizePath(booksDir)}`);
  }

  const entries = fs.readdirSync(booksDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right, "zh-Hans-CN"));

  const books = [];

  for (const entry of entries) {
    const manifestPath = path.join(booksDir, entry, "manifest.json");
    if (!fs.existsSync(manifestPath)) {
      continue;
    }

    let manifest = null;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    } catch (error) {
      throw new Error(`manifest JSON parse failed: ${normalizePath(manifestPath)}: ${error.message}`);
    }

    const localBookId = String(manifest.bookId || entry).trim() || entry;
    const title = String(manifest.title || localBookId).trim() || localBookId;
    const author = String(manifest.author || "").trim();

    books.push({
      bookId: localBookId,
      title,
      author,
      sourceType: manifest.sourceType || "",
      sourcePath: manifest.sourcePath || "",
      normalizedTitle: normalizeBookTitle(title),
      normalizedAuthor: normalizeAuthorName(author),
      normalizedBookId: normalizeBookTitle(localBookId),
      manifestPath,
    });
  }

  if (!books.length) {
    throw new Error(`No local reading books found: ${normalizePath(booksDir)}`);
  }

  return books;
}

function loadBookMap(stateDir) {
  const mapPath = path.join(stateDir, "reading", "book-map.json");
  if (!fs.existsSync(mapPath)) {
    return createEmptyBookMap();
  }

  let parsed = null;
  try {
    parsed = JSON.parse(fs.readFileSync(mapPath, "utf8"));
  } catch (error) {
    throw new Error(`book-map JSON parse failed: ${normalizePath(mapPath)}: ${error.message}`);
  }

  return {
    version: Number(parsed.version) || MAP_VERSION,
    updatedAt: parsed.updatedAt || "",
    links: Array.isArray(parsed.links) ? parsed.links : [],
    pending: Array.isArray(parsed.pending) ? parsed.pending : [],
  };
}

function saveBookMap(stateDir, bookMap) {
  const readingDir = path.join(stateDir, "reading");
  const mapPath = path.join(readingDir, "book-map.json");

  fs.mkdirSync(readingDir, { recursive: true });
  const nextBookMap = {
    version: MAP_VERSION,
    updatedAt: new Date().toISOString(),
    links: Array.isArray(bookMap.links) ? bookMap.links : [],
    pending: Array.isArray(bookMap.pending) ? bookMap.pending : [],
  };
  fs.writeFileSync(mapPath, JSON.stringify(nextBookMap, null, 2) + "\n", "utf8");

  return mapPath;
}

function createEmptyBookMap() {
  return {
    version: MAP_VERSION,
    updatedAt: "",
    links: [],
    pending: [],
  };
}

function scoreBookMatch(input, localBook) {
  const wereadTitle = String(input.wereadTitle || "");
  const wereadAuthor = String(input.wereadAuthor || "");
  const normalizedWereadTitle = normalizeBookTitle(wereadTitle);
  const normalizedWereadAuthor = normalizeAuthorName(wereadAuthor);
  const matchedBy = [];
  let score = 0;

  if (!normalizedWereadTitle) {
    return {
      localBookId: localBook.bookId,
      localTitle: localBook.title,
      localAuthor: localBook.author,
      score: 0,
      matchedBy,
    };
  }

  if (normalizedWereadTitle === localBook.normalizedTitle) {
    score = Math.max(score, 0.9);
    matchedBy.push("normalizedTitle");
  } else if (
    normalizedWereadTitle.includes(localBook.normalizedTitle) ||
    localBook.normalizedTitle.includes(normalizedWereadTitle)
  ) {
    score = Math.max(score, 0.75);
    matchedBy.push("titleIncludes");
  }

  if (normalizedWereadAuthor && localBook.normalizedAuthor && normalizedWereadAuthor === localBook.normalizedAuthor) {
    score += 0.08;
    matchedBy.push("normalizedAuthor");
  }

  if (normalizedWereadTitle === localBook.normalizedBookId) {
    score += 0.05;
    matchedBy.push("localBookId");
  }

  score = Number(Math.min(0.99, score).toFixed(2));

  return {
    localBookId: localBook.bookId,
    localTitle: localBook.title,
    localAuthor: localBook.author,
    score,
    matchedBy,
  };
}

function linkReadingBook(argv = process.argv.slice(2)) {
  const args = Array.isArray(argv) ? parseArgs(argv) : argv;
  const stateDir = resolveStateDir(args.stateDir);
  const bookMap = loadBookMap(stateDir);

  if (args.listPending) {
    return {
      action: "list-pending",
      stateDir,
      mapPath: path.join(stateDir, "reading", "book-map.json"),
      pending: dedupePendingEntries(bookMap.pending),
    };
  }

  const books = loadLocalBooks(stateDir);

  const wereadTitle = String(args.wereadTitle || "").trim();
  const wereadAuthor = String(args.wereadAuthor || "").trim();
  const normalizedWereadTitle = normalizeBookTitle(wereadTitle);
  const normalizedWereadAuthor = normalizeAuthorName(wereadAuthor);
  const dedupeKey = buildPendingKey({
    wereadBookId: args.wereadBookId,
    wereadTitle,
    wereadAuthor,
  });

  const existingLinked = findExistingLink(bookMap.links, {
    wereadBookId: args.wereadBookId,
    normalizedWereadTitle,
    normalizedWereadAuthor,
  });
  if (existingLinked && !args.confirm) {
    return {
      action: "linked",
      stateDir,
      mapPath: path.join(stateDir, "reading", "book-map.json"),
      link: existingLinked,
      candidates: [],
      reused: true,
    };
  }

  if (args.confirm) {
    const targetBook = books.find((book) => book.bookId === args.localBookId);
    if (!targetBook) {
      throw new Error(`localBookId does not exist: ${args.localBookId}`);
    }

    const matchedBy = ["manualConfirm"];
    if (normalizedWereadTitle && normalizedWereadTitle === targetBook.normalizedTitle) {
      matchedBy.push("normalizedTitle");
    }
    if (normalizedWereadAuthor && targetBook.normalizedAuthor && normalizedWereadAuthor === targetBook.normalizedAuthor) {
      matchedBy.push("normalizedAuthor");
    }

    const link = createLinkRecord({
      wereadBookId: args.wereadBookId,
      wereadTitle,
      wereadAuthor,
      localBook: targetBook,
      score: 1,
      matchedBy,
    });

    upsertLink(bookMap, link);
    removePendingByKey(bookMap, dedupeKey);
    const mapPath = saveBookMap(stateDir, bookMap);

    return {
      action: "linked",
      stateDir,
      mapPath,
      link,
      candidates: [],
      reused: false,
    };
  }

  const scoredCandidates = books
    .map((book) => scoreBookMatch({ wereadTitle, wereadAuthor }, book))
    .filter((candidate) => candidate.score > 0)
    .sort(compareCandidates);

  const best = scoredCandidates[0] || null;
  const linkThreshold = normalizedWereadTitle.length <= 2
    ? SHORT_TITLE_LINK_THRESHOLD
    : DEFAULT_LINK_THRESHOLD;

  if (best && best.score >= linkThreshold) {
    const targetBook = books.find((book) => book.bookId === best.localBookId);
    const link = createLinkRecord({
      wereadBookId: args.wereadBookId,
      wereadTitle,
      wereadAuthor,
      localBook: targetBook,
      score: best.score,
      matchedBy: best.matchedBy,
    });

    upsertLink(bookMap, link);
    removePendingByKey(bookMap, dedupeKey);
    const mapPath = saveBookMap(stateDir, bookMap);

    return {
      action: "linked",
      stateDir,
      mapPath,
      link,
      candidates: scoredCandidates,
      reused: false,
    };
  }

  const pendingCandidates = scoredCandidates.filter((candidate) => candidate.score >= DEFAULT_PENDING_THRESHOLD);
  if (pendingCandidates.length) {
    const pending = {
      wereadBookId: args.wereadBookId || "",
      wereadTitle,
      wereadAuthor,
      status: "pending",
      candidates: pendingCandidates.slice(0, 5).map((candidate) => ({
        localBookId: candidate.localBookId,
        localTitle: candidate.localTitle,
        localAuthor: candidate.localAuthor,
        score: candidate.score,
        matchedBy: candidate.matchedBy,
      })),
      updatedAt: new Date().toISOString(),
    };

    upsertPending(bookMap, pending);
    const mapPath = saveBookMap(stateDir, bookMap);

    return {
      action: "pending",
      stateDir,
      mapPath,
      pending,
      candidates: pending.candidates,
    };
  }

  removePendingByKey(bookMap, dedupeKey);
  const mapPath = saveBookMap(stateDir, bookMap);
  return {
    action: "no-match",
    stateDir,
    mapPath,
    candidates: scoredCandidates.slice(0, 5),
    weread: {
      wereadBookId: args.wereadBookId || "",
      wereadTitle,
      wereadAuthor,
    },
  };
}

function findExistingLink(links, query) {
  if (query.wereadBookId) {
    const exact = links.find((link) => String(link.wereadBookId || "") === String(query.wereadBookId));
    if (exact) {
      return exact;
    }
  }

  return links.find((link) => {
    return buildPendingKey(link) === buildPendingKey({
      wereadBookId: query.wereadBookId,
      wereadTitle: query.normalizedWereadTitle,
      wereadAuthor: query.normalizedWereadAuthor,
      alreadyNormalized: true,
    });
  }) || null;
}

function buildPendingKey(input) {
  const alreadyNormalized = Boolean(input.alreadyNormalized);
  const wereadBookId = String(input.wereadBookId || "").trim();
  const wereadTitle = alreadyNormalized
    ? String(input.wereadTitle || "")
    : normalizeBookTitle(input.wereadTitle || "");
  const wereadAuthor = alreadyNormalized
    ? String(input.wereadAuthor || "")
    : normalizeAuthorName(input.wereadAuthor || "");

  if (wereadBookId) {
    return `id:${wereadBookId}`;
  }

  return `title:${wereadTitle}::author:${wereadAuthor}`;
}

function createLinkRecord(input) {
  return {
    wereadBookId: String(input.wereadBookId || ""),
    wereadTitle: String(input.wereadTitle || ""),
    wereadAuthor: String(input.wereadAuthor || ""),
    localBookId: input.localBook.bookId,
    localTitle: input.localBook.title,
    localAuthor: input.localBook.author || "",
    score: Number(input.score.toFixed(2)),
    status: "linked",
    matchedBy: Array.from(new Set(input.matchedBy || [])),
    updatedAt: new Date().toISOString(),
  };
}

function upsertLink(bookMap, link) {
  const key = buildPendingKey(link);
  const nextLinks = [];
  let inserted = false;

  for (const item of Array.isArray(bookMap.links) ? bookMap.links : []) {
    if (buildPendingKey(item) === key) {
      nextLinks.push(link);
      inserted = true;
      continue;
    }

    nextLinks.push(item);
  }

  if (!inserted) {
    nextLinks.push(link);
  }

  bookMap.links = dedupeLinks(nextLinks);
}

function upsertPending(bookMap, pending) {
  const key = buildPendingKey(pending);
  const nextPending = [];
  let inserted = false;

  for (const item of Array.isArray(bookMap.pending) ? bookMap.pending : []) {
    if (buildPendingKey(item) === key) {
      nextPending.push(pending);
      inserted = true;
      continue;
    }

    nextPending.push(item);
  }

  if (!inserted) {
    nextPending.push(pending);
  }

  bookMap.pending = dedupePendingEntries(nextPending);
}

function removePendingByKey(bookMap, key) {
  bookMap.pending = (Array.isArray(bookMap.pending) ? bookMap.pending : [])
    .filter((item) => buildPendingKey(item) !== key);
}

function dedupeLinks(links) {
  const map = new Map();
  for (const link of links) {
    map.set(buildPendingKey(link), link);
  }
  return Array.from(map.values());
}

function dedupePendingEntries(pending) {
  const map = new Map();
  for (const item of Array.isArray(pending) ? pending : []) {
    map.set(buildPendingKey(item), item);
  }
  return Array.from(map.values());
}

function compareCandidates(left, right) {
  return right.score - left.score ||
    left.localTitle.localeCompare(right.localTitle, "zh-Hans-CN");
}

function formatResultText(result) {
  if (result.action === "list-pending") {
    const lines = ["Pending reading book links."];
    if (!result.pending.length) {
      lines.push("Pending: 0");
    } else {
      lines.push(`Pending: ${result.pending.length}`);
      result.pending.forEach((item, index) => {
        lines.push("");
        lines.push(`[${index + 1}] ${item.wereadTitle}`);
        if (item.wereadAuthor) {
          lines.push(`Author: ${item.wereadAuthor}`);
        }
        item.candidates.forEach((candidate, candidateIndex) => {
          lines.push(`  (${candidateIndex + 1}) ${candidate.localBookId} score=${candidate.score}`);
        });
      });
    }
    lines.push(`Map: ${normalizePath(result.mapPath)}`);
    return lines.join("\n");
  }

  if (result.action === "linked") {
    return [
      "Linked reading book successfully.",
      `Weread: ${result.link.wereadTitle}`,
      `Local: ${result.link.localBookId}`,
      `Score: ${result.link.score}`,
      `Status: ${result.link.status}`,
      `Map: ${normalizePath(result.mapPath)}`,
    ].join("\n");
  }

  if (result.action === "pending") {
    const lines = [
      "Reading book link pending confirmation.",
      `Weread: ${result.pending.wereadTitle}`,
      "Candidates:",
    ];
    result.pending.candidates.forEach((candidate, index) => {
      lines.push(`[${index + 1}] ${candidate.localBookId} score=${candidate.score}`);
    });
    return lines.join("\n");
  }

  return [
    "No reading book link candidates met the threshold.",
    `Weread: ${result.weread.wereadTitle}`,
    `Map: ${normalizePath(result.mapPath)}`,
  ].join("\n");
}

function runCli(argv = process.argv.slice(2)) {
  try {
    const args = parseArgs(argv);
    const result = linkReadingBook(args);
    if (args.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    console.log(formatResultText(result));
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
  normalizeBookTitle,
  loadLocalBooks,
  loadBookMap,
  saveBookMap,
  scoreBookMatch,
  linkReadingBook,
  runCli,
};
