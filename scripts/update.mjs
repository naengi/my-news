// 뉴스 수집 → 본문 추출 → Claude로 요약·번역 → public/data/*.json 저장
// 원문은 요약에만 쓰고 저장하지 않음 (사이트에는 요약과 기사 링크만 올라감)
// 실행: ANTHROPIC_API_KEY=... node scripts/update.mjs
import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Parser from "rss-parser";
import { JSDOM, VirtualConsole } from "jsdom";
import { Readability } from "@mozilla/readability";
import Anthropic from "@anthropic-ai/sdk";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = path.join(ROOT, "public", "data");
const config = JSON.parse(await fs.readFile(path.join(ROOT, "feeds.json"), "utf8"));

const MODEL = process.env.NEWS_MODEL || "claude-haiku-5-5";
const MAX_NEW = Number(process.env.MAX_NEW_ARTICLES || 120); // 한 번 실행에 새로 요약할 최대 기사 수
const MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000; // 3일 지난 기사는 정리
const CONCURRENCY = 4;
// 거절 시 다른 모델로 다시 시도하는 기능 (Haiku는 지원하지 않음)
const FALLBACK = MODEL.includes("haiku") ? {} : { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" };
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

const client = new Anthropic();
const parser = new Parser({ timeout: 15000, headers: { "User-Agent": UA } });
const langOf = Object.fromEntries(config.countries.map((c) => [c.id, c.lang]));

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}

function cleanText(s = "") {
  return s.replace(/\r/g, "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

async function extractBody(url, fallback) {
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    const dom = new JSDOM(html, { url, virtualConsole: new VirtualConsole() });
    const article = new Readability(dom.window.document).parse();
    const text = cleanText(article?.textContent);
    // 본문이 너무 짧으면(페이월 등) RSS 설명으로 대체
    if (text.length > Math.max(200, fallback.length)) return text;
  } catch (err) {
    console.warn(`  본문 추출 실패: ${url} (${err.message})`);
  }
  return fallback;
}

const SCHEMA = {
  type: "object",
  properties: {
    title_ko: { type: "string", description: "한국어 제목" },
    summary: { type: "array", items: { type: "string" }, description: "핵심 요약 3~4개, 한국어" },
  },
  required: ["title_ko", "summary"],
  additionalProperties: false,
};

async function summarize({ title, body, lang, source }) {
  const foreign = lang !== "ko";
  const prompt = [
    `언론사: ${source}`,
    `제목: ${title}`,
    "",
    "본문:",
    body,
    "",
    foreign
      ? "이 외국 기사의 제목을 자연스러운 한국어로 번역해 title_ko에 넣고, 기사 내용의 핵심을 한국어로 3~4개 문장으로 요약해 summary에 넣어줘."
      : "title_ko에는 원래 제목을 그대로 넣고, 기사 내용의 핵심을 3~4개 문장으로 요약해 summary에 넣어줘.",
    "요약은 기사에 있는 사실만 담고, 누가·무엇을·왜가 드러나게 써줘. 각 문장은 80자 이내로.",
  ].join("\n");

  const res = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 4000,
    ...FALLBACK,
    output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMA } },
    system: "너는 한국어 뉴스 편집자야. 기사를 정확하고 간결하게 요약하고, 외국 기사는 자연스러운 한국어로 옮겨.",
    messages: [{ role: "user", content: prompt }],
  });
  if (res.stop_reason === "refusal") throw new Error("요약 거절됨");
  const text = res.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  const out = JSON.parse(text);
  return { titleKo: foreign ? out.title_ko : title, summary: out.summary };
}

// 제목 목록을 주면 같은 사건·소식을 다룬 제목 번호끼리 묶어 돌려줌 (2개 이상인 묶음만)
async function groupSameStories(titles) {
  const res = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    ...FALLBACK,
    output_config: {
      effort: "low",
      format: {
        type: "json_schema",
        schema: {
          type: "object",
          properties: {
            groups: { type: "array", items: { type: "array", items: { type: "integer" } } },
          },
          required: ["groups"],
          additionalProperties: false,
        },
      },
    },
    messages: [
      {
        role: "user",
        content:
          "아래는 여러 언론사의 뉴스 제목이야. 같은 사건이나 같은 발표를 다룬 제목끼리 번호를 묶어서 groups에 넣어줘. " +
          "주제만 비슷하고 다른 사건이면 묶지 마. 혼자인 제목은 넣지 않아도 돼.\n\n" +
          titles.map((t, i) => `${i}. ${t}`).join("\n"),
      },
    ],
  });
  if (res.stop_reason === "refusal") throw new Error("거절됨");
  const text = res.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  return JSON.parse(text).groups.filter((g) => g.length > 1);
}

async function pool(items, n, fn) {
  const queue = [...items];
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (queue.length) await fn(queue.shift());
    }),
  );
}

// 1) 기존 데이터 불러오기 (이미 요약한 기사는 다시 요약하지 않음)
const existing = new Map();
for (const c of config.countries) {
  const data = await readJson(path.join(DATA_DIR, `${c.id}.json`), { articles: [] });
  for (const a of data.articles) existing.set(a.link, a);
}

// 중복으로 걸러낸 기사 링크 (다음 실행 때 다시 묶지 않도록)
const dupesFile = path.join(DATA_DIR, "dupes.json");
const dupes = new Map(Object.entries(await readJson(dupesFile, {})));

// 2) RSS 수집
const candidates = [];
const feedStatus = [];
for (const feed of config.feeds) {
  try {
    const parsed = await parser.parseURL(feed.url);
    const dateOf = (item) => new Date(item.isoDate || item.pubDate || 0).getTime();
    // 최신순으로 정렬하고, 3일 지난 기사는 요약하지 않음
    const items = parsed.items
      .filter((item) => Date.now() - dateOf(item) < MAX_AGE_MS)
      .sort((a, b) => dateOf(b) - dateOf(a));
    for (const item of items.slice(0, config.perFeed)) {
      const link = item.link?.trim();
      if (!link || !item.title) continue;
      if (existing.has(link) || dupes.has(link)) continue; // 이미 요약했거나 중복으로 걸러낸 기사
      candidates.push({
        country: feed.country,
        category: feed.category,
        source: feed.source,
        link,
        title: cleanText(item.title),
        snippet: cleanText(item.contentSnippet || item.content || item.summary || ""),
        publishedAt: new Date(item.isoDate || item.pubDate || Date.now()).toISOString(),
      });
    }
    console.log(`✓ ${feed.source} ${feed.country}/${feed.category}`);
    feedStatus.push({
      ...feed,
      ok: true,
      items: parsed.items.length,
      recent: items.length,
      newest: items[0] ? new Date(dateOf(items[0])).toISOString() : null,
    });
  } catch (err) {
    console.warn(`✗ ${feed.source} ${feed.url}: ${err.message}`);
    feedStatus.push({ ...feed, ok: false, error: err.message });
  }
}

// 같은 링크가 여러 피드에 있으면 하나만
const seen = new Set();
const unique = candidates.filter((c) => !seen.has(c.link) && seen.add(c.link));

// 같은 소식을 다룬 기사끼리 묶고, 신뢰도가 가장 높은 언론사 기사 하나만 남김
const trustOf = (source) => config.trust?.[source] ?? 9;
const deduped = [];
for (const c of config.countries) {
  const recent = [...existing.values()].filter(
    (a) => a.country === c.id && Date.now() - new Date(a.publishedAt).getTime() < 2 * 24 * 3600e3,
  );
  const fresh = unique.filter((a) => a.country === c.id);
  if (!fresh.length) continue;
  let groups = [];
  try {
    groups = await groupSameStories([...recent, ...fresh].map((a) => a.originalTitle || a.title));
  } catch (err) {
    console.warn(`  ${c.name} 중복 묶기 실패, 그대로 진행 (${err.message})`);
  }
  const groupOf = new Map();
  groups.forEach((g, gi) => g.forEach((i) => groupOf.set(i, gi)));
  const byGroup = new Map();
  fresh.forEach((a, fi) => {
    const key = groupOf.get(recent.length + fi) ?? `solo-${fi}`;
    (byGroup.get(key) ?? byGroup.set(key, []).get(key)).push(a);
  });
  for (const [key, list] of byGroup) {
    const old = typeof key === "number" ? recent.filter((_, ri) => groupOf.get(ri) === key) : [];
    const sources = [...new Set([...old, ...list].map((a) => a.source))];
    if (old.length) {
      // 이미 올라간 소식이면 새로 요약하지 않고, 같은 소식을 실은 언론사만 기록
      for (const o of old) o.alsoIn = sources.filter((s) => s !== o.source);
      for (const a of list) dupes.set(a.link, a.publishedAt);
      continue;
    }
    list.sort((x, y) => trustOf(x.source) - trustOf(y.source) || y.snippet.length - x.snippet.length);
    const best = list[0];
    best.alsoIn = sources.filter((s) => s !== best.source);
    deduped.push(best);
    for (const a of list.slice(1)) dupes.set(a.link, a.publishedAt);
  }
  console.log(`${c.name}: 새 기사 ${fresh.length}개 → 중복 정리 후 ${deduped.filter((a) => a.country === c.id).length}개`);
}

const fresh = deduped.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt)).slice(0, MAX_NEW);
console.log(`새 기사 ${fresh.length}개 요약 시작 (모델: ${MODEL})`);

// 3) 본문 추출 + 요약·번역
let done = 0;
const failures = [];
await pool(fresh, CONCURRENCY, async (item) => {
  try {
    const body = await extractBody(item.link, item.snippet);
    const { titleKo, summary } = await summarize({
      title: item.title,
      body: body || item.title,
      lang: langOf[item.country],
      source: item.source,
    });
    existing.set(item.link, {
      id: createHash("sha1").update(item.link).digest("hex").slice(0, 12),
      country: item.country,
      category: item.category,
      source: item.source,
      alsoIn: item.alsoIn ?? [],
      link: item.link,
      publishedAt: item.publishedAt,
      title: titleKo,
      originalTitle: item.title,
      summary,
    });
    done++;
  } catch (err) {
    console.warn(`  요약 실패: ${item.link} (${err.message})`);
    failures.push(err.message);
  }
});
console.log(`요약 완료 ${done}/${fresh.length}`);

// 4) 나라별로 정리해 저장 (분야마다 최신 N개, 3일 이내)
await fs.mkdir(DATA_DIR, { recursive: true });
const now = Date.now();
for (const c of config.countries) {
  const bySection = {};
  for (const a of existing.values()) {
    if (a.country !== c.id) continue;
    if (now - new Date(a.publishedAt).getTime() > MAX_AGE_MS) continue;
    (bySection[a.category] ??= []).push(a);
  }
  const articles = Object.values(bySection)
    .flatMap((list) => list.sort((x, y) => y.publishedAt.localeCompare(x.publishedAt)).slice(0, config.keepPerSection))
    .sort((x, y) => y.publishedAt.localeCompare(x.publishedAt));
  await fs.writeFile(path.join(DATA_DIR, `${c.id}.json`), JSON.stringify({ articles }));
}
// 점검용 기록 (어떤 피드가 안 되는지, 요약이 왜 실패했는지)
await fs.writeFile(
  path.join(DATA_DIR, "status.json"),
  JSON.stringify({ at: new Date().toISOString(), model: MODEL, summarized: done, tried: fresh.length, failures: [...new Set(failures)].slice(0, 5), feeds: feedStatus }, null, 1),
);
for (const [link, at] of dupes) if (now - new Date(at).getTime() > MAX_AGE_MS) dupes.delete(link);
await fs.writeFile(dupesFile, JSON.stringify(Object.fromEntries(dupes)));
await fs.writeFile(
  path.join(DATA_DIR, "meta.json"),
  JSON.stringify({ updatedAt: new Date().toISOString(), countries: config.countries, categories: config.categories }),
);
console.log("저장 완료");
