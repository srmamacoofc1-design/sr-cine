"use strict";

const DATA_ROOT = "./data/";
const PAGE_SIZE = 36;
const byId = id => document.getElementById(id);
const dialog = byId("film-dialog");
const player = byId("player");
const queryInput = byId("query");
const collator = new Intl.Collator("pt-BR", { sensitivity: "base", numeric: true });
const normalize = value => String(value || "").normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const formatNumber = value => value.toLocaleString("pt-BR");
const indexes = new Map();
const indexRequests = new Map();
const detailRequests = new Map();
let manifest;
let view = "movie";
let pageNumber = 1;
let activeFilm;
let featured = [];
let featuredIndex = 0;
let installPrompt;
let loadingTimeout;
let searchTimer;
let navigationVersion = 0;

function readState(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}
function persist(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
}
const storedList = readState("sr-cine:lista", []);
const saved = new Set(Array.isArray(storedList) ? storedList : []);
const metadata = film => [
  film.kind === "tv" ? "Série" : "Filme",
  film.rating ? `★ ${film.rating.toFixed(1)}` : "",
  film.year,
  film.kind === "tv" && film.seasons ? `${film.seasons} temporada${film.seasons === 1 ? "" : "s"}` : film.duration
].filter(Boolean).join(" · ");

async function fetchJson(path) {
  const response = await fetch(`${DATA_ROOT}${path}?v=catalog-4`);
  if (!response.ok) throw new Error("Catálogo indisponível");
  return response.json();
}

async function loadIndex(kind) {
  if (indexes.has(kind)) return indexes.get(kind);
  if (!indexRequests.has(kind)) {
    const request = fetchJson(manifest.files[kind]).then(items => {
      for (const film of items) {
        film.searchTitles = (film.aliases || [film.title]).map(normalize);
        film.searchText = film.searchTitles.join(" ");
      }
      indexes.set(kind, items);
      return items;
    }).catch(error => {
      indexRequests.delete(kind);
      throw error;
    });
    indexRequests.set(kind, request);
  }
  return indexRequests.get(kind);
}

function getItems() {
  if (view === "saved") return [...indexes.values()].flat().filter(film => saved.has(film.id));
  return indexes.get(view) || [];
}

function saveLabel(film) {
  return saved.has(film.id) ? "Remover da minha lista" : "Adicionar à minha lista";
}

function updateDialogSave() {
  byId("film-save").textContent = saved.has(activeFilm.id) ? "✓ Na minha lista" : "＋ Minha lista";
  byId("film-save").setAttribute("aria-pressed", String(saved.has(activeFilm.id)));
  byId("film-save").setAttribute("aria-label", saveLabel(activeFilm));
}

function toggleSave(film) {
  saved.has(film.id) ? saved.delete(film.id) : saved.add(film.id);
  persist("sr-cine:lista", [...saved]);
  render();
  if (dialog.open && activeFilm?.id === film.id) updateDialogSave();
}

function createCard(film) {
  const card = document.createElement("article");
  card.className = "card";
  const open = document.createElement("button");
  open.type = "button";
  open.className = "open";
  open.setAttribute("aria-label", `Assistir ${film.title}`);
  const cover = document.createElement("span");
  cover.className = "cover";
  if (film.poster) {
    const image = document.createElement("img");
    image.src = film.poster;
    image.alt = "";
    image.loading = "lazy";
    image.decoding = "async";
    image.addEventListener("error", () => image.remove(), { once: true });
    cover.append(image);
  }
  const copy = document.createElement("span");
  copy.className = "card-copy";
  const title = document.createElement("strong");
  title.textContent = film.title;
  const meta = document.createElement("small");
  meta.textContent = metadata(film);
  copy.append(title, meta);
  open.append(cover, copy);
  open.addEventListener("click", () => openFilm(film, true));
  const favorite = document.createElement("button");
  favorite.className = "outline save";
  favorite.textContent = saved.has(film.id) ? "✓" : "+";
  favorite.dataset.saveId = film.id;
  favorite.setAttribute("aria-label", `${saveLabel(film)}: ${film.title}`);
  favorite.setAttribute("aria-pressed", String(saved.has(film.id)));
  favorite.addEventListener("click", () => {
    toggleSave(film);
    (document.querySelector(`[data-save-id="${CSS.escape(film.id)}"]`) || queryInput).focus();
  });
  card.append(open, favorite);
  return card;
}

function matchesPeriod(film) {
  const period = byId("period").value;
  if (!period) return true;
  const year = Number(film.year);
  if (!year) return false;
  if (period === "classic") return year < 1980;
  const start = Number(period);
  return year >= start && (period === "2020" || year < start + 10);
}

function searchRank(film, term) {
  if (film.searchTitles.includes(term)) return 0;
  if (film.searchTitles.some(title => title.startsWith(term))) return 1;
  return 2;
}

function compareItems(left, right, term, order) {
  if (term) {
    const difference = searchRank(left, term) - searchRank(right, term);
    if (difference) return difference;
  }
  if (order === "title") return collator.compare(left.title, right.title);
  if (order === "newest") return Number(right.year) - Number(left.year) || right.popularity - left.popularity;
  if (order === "oldest") return (Number(left.year) || 9999) - (Number(right.year) || 9999) || right.popularity - left.popularity;
  if (order === "rating") return right.rating - left.rating || right.votes - left.votes;
  return right.popularity - left.popularity || right.votes - left.votes || collator.compare(left.title, right.title);
}

function goToPage(number) {
  pageNumber = number;
  render();
  byId("pagination-top").querySelector("input")?.focus({ preventScroll: true });
  byId("library").scrollIntoView({ block: "start", behavior: "instant" });
}

function pagerButton(text, label, destination, disabled) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "outline";
  button.textContent = text;
  button.setAttribute("aria-label", label);
  button.disabled = disabled;
  button.addEventListener("click", () => goToPage(destination));
  return button;
}

function renderPagination(container, totalPages, hasResults) {
  container.hidden = !hasResults;
  container.replaceChildren();
  if (!hasResults) return;
  const first = pagerButton("«", "Primeira página", 1, pageNumber === 1);
  const previous = pagerButton("‹", "Página anterior", pageNumber - 1, pageNumber === 1);
  const next = pagerButton("›", "Próxima página", pageNumber + 1, pageNumber === totalPages);
  const last = pagerButton("»", "Última página", totalPages, pageNumber === totalPages);
  const form = document.createElement("form");
  form.className = "page-jump";
  const label = document.createElement("label");
  label.textContent = "Página ";
  const input = document.createElement("input");
  input.type = "number";
  input.inputMode = "numeric";
  input.min = "1";
  input.max = String(totalPages);
  input.required = true;
  input.value = String(pageNumber);
  input.setAttribute("aria-label", "Ir para a página");
  const count = document.createElement("span");
  count.textContent = ` de ${formatNumber(totalPages)}`;
  const submit = document.createElement("button");
  submit.type = "submit";
  submit.className = "outline";
  submit.textContent = "Ir";
  form.addEventListener("submit", event => {
    event.preventDefault();
    const destination = Number(input.value);
    if (Number.isInteger(destination) && destination >= 1 && destination <= totalPages) goToPage(destination);
  });
  label.append(input, count);
  form.append(label, submit);
  container.append(first, previous, form, next, last);
}

function render() {
  const term = normalize(queryInput.value);
  const tokens = term.split(" ").filter(Boolean);
  const category = byId("category").value;
  const order = byId("sort").value;
  const results = getItems().filter(film =>
    (!category || (category === "unclassified" ? !film.genres.length : film.genres.includes(category))) &&
    matchesPeriod(film) &&
    tokens.every(token => film.searchText.includes(token))
  ).sort((left, right) => compareItems(left, right, term, order));
  const totalPages = Math.max(1, Math.ceil(results.length / PAGE_SIZE));
  pageNumber = Math.max(1, Math.min(pageNumber, totalPages));
  const start = (pageNumber - 1) * PAGE_SIZE;
  byId("cards").replaceChildren(...results.slice(start, start + PAGE_SIZE).map(createCard));
  byId("status").textContent = results.length
    ? `${formatNumber(results.length)} resultado${results.length === 1 ? "" : "s"} · ${formatNumber(start + 1)}–${formatNumber(Math.min(start + PAGE_SIZE, results.length))}`
    : view === "saved" && !saved.size ? "Sua lista está vazia. Use + para salvar filmes e séries." : "Nenhum título encontrado com esses filtros.";
  renderPagination(byId("pagination-top"), totalPages, results.length > 0);
  renderPagination(byId("pagination-bottom"), totalPages, results.length > 0);
}

function showFeatured() {
  const film = featured[featuredIndex];
  byId("hero").hidden = !film || view === "saved";
  if (!film) return;
  byId("hero-art").src = film.backdrop || film.poster;
  byId("hero-title").textContent = film.title;
  byId("hero-meta").textContent = metadata(film);
  byId("hero-description").textContent = film.genres.join(" · ");
  byId("hero-position").textContent = `${featuredIndex + 1} / ${featured.length}`;
}

async function selectView(nextView) {
  const version = ++navigationVersion;
  view = nextView;
  pageNumber = 1;
  byId("status").textContent = "Carregando catálogo…";
  byId("cards").setAttribute("aria-busy", "true");
  byId("cards").replaceChildren();
  byId("hero").hidden = true;
  byId("pagination-top").hidden = byId("pagination-bottom").hidden = true;
  document.querySelectorAll("[data-view]").forEach(button => button.setAttribute("aria-pressed", String(button.dataset.view === view)));
  byId("library-title").textContent = view === "movie" ? "Filmes" : view === "tv" ? "Séries" : "Minha lista";
  try {
    if (view === "saved") await Promise.all([loadIndex("movie"), loadIndex("tv")]);
    else await loadIndex(view);
    if (version !== navigationVersion) return;
    const categories = [...new Set(getItems().flatMap(film => film.genres))].sort(collator.compare);
    const oldCategory = byId("category").value;
    byId("category").replaceChildren(new Option("Todas as categorias", ""));
    for (const category of categories) byId("category").append(new Option(category, category));
    if (getItems().some(film => !film.genres.length)) byId("category").append(new Option("Sem categoria informada", "unclassified"));
    if (categories.includes(oldCategory)) byId("category").value = oldCategory;
    featured = view === "saved" ? [] : getItems().slice(0, 5);
    featuredIndex = 0;
    showFeatured();
    render();
  } catch {
    if (version === navigationVersion) {
      byId("status").textContent = "Não foi possível carregar o catálogo. Toque em Filmes ou Séries para tentar novamente.";
    }
  } finally {
    if (version === navigationVersion) byId("cards").setAttribute("aria-busy", "false");
  }
}

async function loadDescription(film) {
  if (!detailRequests.has(film.detailFile)) {
    const request = fetchJson(film.detailFile).catch(error => {
      detailRequests.delete(film.detailFile);
      throw error;
    });
    detailRequests.set(film.detailFile, request);
  }
  const details = await detailRequests.get(film.detailFile);
  return details[film.id] || "Sinopse indisponível.";
}

function openFilm(film, autoplay = false) {
  activeFilm = film;
  byId("film-kind").textContent = film.kind === "tv" ? "SR.CINE · SÉRIE" : "SR.CINE · FILME";
  byId("film-title").textContent = film.title;
  byId("film-meta").textContent = [metadata(film), film.genres.join(", ")].filter(Boolean).join(" · ");
  byId("film-description").textContent = "Carregando sinopse…";
  byId("film-play").hidden = false;
  byId("film-play").textContent = "▶ Assistir";
  byId("player-status").textContent = "";
  updateDialogSave();
  byId("source").href = "https://embedmovies.org/";
  byId("source").textContent = "Player do EmbedMovies";
  loadDescription(film).then(text => {
    if (dialog.open && activeFilm.id === film.id) byId("film-description").textContent = text;
  }).catch(() => {
    if (dialog.open && activeFilm.id === film.id) byId("film-description").textContent = "Sinopse indisponível no momento.";
  });
  dialog.showModal();
  if (autoplay) startFilm();
}

function startFilm() {
  const film = activeFilm;
  if (!film || !/^https:\/\/myembed\.biz\/(?:filme|serie)\/(?:tt\d+|\d+)$/.test(film.video)) return;
  clearTimeout(loadingTimeout);
  player.hidden = false;
  byId("player-controls").hidden = false;
  byId("film-play").hidden = true;
  byId("player-status").textContent = film.kind === "tv"
    ? "Carregando player… Selecione a temporada e o episódio no player."
    : "Carregando player…";
  const frame = document.createElement("iframe");
  frame.title = `Player de ${film.title}`;
  frame.allow = "autoplay; encrypted-media; picture-in-picture; fullscreen";
  frame.allowFullscreen = true;
  frame.referrerPolicy = "strict-origin-when-cross-origin";
  frame.src = film.video;
  frame.addEventListener("load", () => {
    if (player.firstElementChild !== frame) return;
    clearTimeout(loadingTimeout);
    byId("player-status").textContent = film.kind === "tv" ? "Selecione a temporada e o episódio no player." : "";
  }, { once: true });
  frame.addEventListener("error", () => {
    if (player.firstElementChild !== frame) return;
    clearTimeout(loadingTimeout);
    byId("player-status").textContent = "O player está indisponível. Use Recarregar player para tentar novamente.";
  }, { once: true });
  loadingTimeout = setTimeout(() => {
    if (player.firstElementChild === frame) byId("player-status").textContent = "O player está demorando. Se precisar, use Recarregar player.";
  }, 15000);
  player.replaceChildren(frame);
  player.scrollIntoView({ block: "nearest" });
}

document.querySelectorAll("[data-close]").forEach(button => button.addEventListener("click", () => button.closest("dialog").close()));
dialog.addEventListener("close", () => {
  clearTimeout(loadingTimeout);
  player.replaceChildren();
  player.hidden = true;
  byId("player-controls").hidden = true;
  byId("player-status").textContent = "";
});
document.querySelectorAll("[data-view]").forEach(button => button.addEventListener("click", () => {
  if (manifest) selectView(button.dataset.view);
}));
queryInput.addEventListener("input", () => {
  clearTimeout(searchTimer);
  pageNumber = 1;
  searchTimer = setTimeout(render, 150);
});
for (const id of ["category", "period", "sort"]) byId(id).addEventListener("change", () => {
  pageNumber = 1;
  render();
});
byId("hero-previous").addEventListener("click", () => {
  if (!featured.length) return;
  featuredIndex = (featuredIndex + featured.length - 1) % featured.length;
  showFeatured();
});
byId("hero-next").addEventListener("click", () => {
  if (!featured.length) return;
  featuredIndex = (featuredIndex + 1) % featured.length;
  showFeatured();
});
byId("hero-play").addEventListener("click", () => { if (featured.length) openFilm(featured[featuredIndex], true); });
byId("hero-info").addEventListener("click", () => { if (featured.length) openFilm(featured[featuredIndex]); });
byId("film-play").addEventListener("click", startFilm);
byId("player-reload").addEventListener("click", startFilm);
byId("film-save").addEventListener("click", () => toggleSave(activeFilm));
window.addEventListener("beforeinstallprompt", event => { event.preventDefault(); installPrompt = event; });
window.addEventListener("appinstalled", () => { byId("install").hidden = true; });
if (matchMedia("(display-mode: standalone)").matches) byId("install").hidden = true;
byId("install").addEventListener("click", async () => {
  if (!installPrompt) { byId("install-dialog").showModal(); return; }
  const prompt = installPrompt;
  installPrompt = null;
  await prompt.prompt();
});
if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js").catch(() => {});

async function init() {
  manifest = await fetchJson("manifest.json");
  byId("catalog-total").textContent = `${formatNumber(manifest.counts.movie)} FILMES · ${formatNumber(manifest.counts.tv)} SÉRIES`;
  await selectView("movie");
}
init().catch(() => {
  byId("hero").hidden = true;
  byId("status").textContent = "Não foi possível carregar o catálogo. Atualize a página para tentar novamente.";
});
