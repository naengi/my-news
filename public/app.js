// 내 뉴스: 나라 → 분야 선택, 요약 카드, 원본 보기 / 기사 링크
const state = { meta: null, country: null, category: "all", cache: {} };

const $ = (sel) => document.querySelector(sel);
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};

async function loadJson(name) {
  // 미리보기 페이지는 데이터를 페이지 안에 담아 둠
  if (window.__NEWS_DATA__) return window.__NEWS_DATA__[name];
  const res = await fetch(`data/${name}.json`, { cache: "no-cache" });
  if (!res.ok) throw new Error(res.status);
  return res.json();
}

function timeAgo(iso) {
  const diff = (Date.now() - new Date(iso).getTime()) / 60000;
  if (diff < 1) return "방금";
  if (diff < 60) return `${Math.floor(diff)}분 전`;
  if (diff < 1440) return `${Math.floor(diff / 60)}시간 전`;
  return `${Math.floor(diff / 1440)}일 전`;
}

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c != null) node.append(c);
  return node;
}

function renderBars() {
  const { countries, categories } = state.meta;
  $("#countries").replaceChildren(
    ...countries.map((c) =>
      el("button", { role: "tab", "aria-selected": String(c.id === state.country), onclick: () => selectCountry(c.id) }, c.name),
    ),
  );
  $("#cats").replaceChildren(
    ...[{ id: "all", name: "전체" }, ...categories].map((c) =>
      el("button", { role: "tab", "aria-selected": String(c.id === state.category), onclick: () => selectCategory(c.id) }, c.name),
    ),
  );
}

function card(a) {
  const foreign = state.meta.countries.find((c) => c.id === a.country)?.lang !== "ko";
  const catName = state.meta.categories.find((c) => c.id === a.category)?.name;
  const lang = state.meta.countries.find((c) => c.id === a.country)?.lang;
  return el(
    "article",
    { class: "card" },
    el(
      "div",
      { class: "meta" },
      el("span", { class: "source" }, a.source),
      el("span", {}, "·"),
      el("time", { datetime: a.publishedAt }, timeAgo(a.publishedAt)),
      state.category === "all" && catName ? el("span", { class: "cat-tag" }, catName) : null,
    ),
    el("h2", {}, a.title),
    a.alsoIn?.length ? el("p", { class: "also" }, `같은 소식 보도: ${a.alsoIn.join(", ")}`) : null,
    el("ul", { class: "summary" }, a.summary.map((s) => el("li", {}, s))),
    el(
      "div",
      { class: "foot" },
      foreign ? el("p", { class: "orig-title", lang }, a.originalTitle) : null,
      el("a", { class: "link", href: a.link, target: "_blank", rel: "noopener noreferrer" }, "기사 링크 ↗"),
    ),
  );
}

async function renderList() {
  const list = $("#list");
  let data = state.cache[state.country];
  if (!data) {
    list.replaceChildren(el("p", { class: "empty" }, "불러오는 중…"));
    try {
      data = state.cache[state.country] = await loadJson(state.country);
    } catch {
      list.replaceChildren(el("p", { class: "empty" }, "뉴스를 불러오지 못했어요. 잠시 후 다시 열어 주세요."));
      return;
    }
  }
  const items = data.articles.filter((a) => state.category === "all" || a.category === state.category);
  list.replaceChildren(...(items.length ? items.map(card) : [el("p", { class: "empty" }, "아직 이 분야 기사가 없어요.")]));
}

function selectCountry(id) {
  state.country = id;
  store.set("news.country", id);
  renderBars();
  renderList();
  window.scrollTo({ top: 0 });
}
function selectCategory(id) {
  state.category = id;
  store.set("news.category", id);
  renderBars();
  renderList();
  window.scrollTo({ top: 0 });
}

async function start() {
  state.meta = await loadJson("meta");
  const saved = store.get("news.country");
  state.country = state.meta.countries.some((c) => c.id === saved) ? saved : state.meta.countries[0].id;
  const savedCat = store.get("news.category");
  state.category = savedCat === "all" || state.meta.categories.some((c) => c.id === savedCat) ? savedCat : "all";
  const d = new Date(state.meta.updatedAt);
  $("#updated").textContent = `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")} 업데이트`;
  renderBars();
  renderList();
}

start().catch(() => {
  $("#list").replaceChildren(el("p", { class: "empty" }, "아직 수집된 뉴스가 없어요."));
});

if ("serviceWorker" in navigator && !window.__NEWS_DATA__) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
