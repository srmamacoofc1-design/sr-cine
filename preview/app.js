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
let selectedEpisode;
let playVersion = 0;
let episodeVersion = 0;

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
  const base = path.startsWith("details/") ? "../data/" : DATA_ROOT;
  const response = await fetch(`${base}${path}?v=preview-1`);
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
  byId("hero-choices").querySelectorAll("button").forEach((button, index) =>
    button.setAttribute("aria-pressed", String(index === featuredIndex)));
}

function renderFeaturedChoices() {
  byId("hero-choices").replaceChildren(...featured.map((film, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.setAttribute("aria-label", film.title);
    const image = document.createElement("img");
    image.alt = "";
    if (film.backdrop || film.poster) image.src = film.backdrop || film.poster;
    button.append(image);
    button.addEventListener("click", () => { featuredIndex = index; showFeatured(); });
    return button;
  }));
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
    const picks = view === "movie" ? [83533, 157336, 693134, 911430, 533535] : [1396, 66732, 1399, 1416, 136315];
    featured = view === "saved" ? [] : picks.map(id => getItems().find(film => film.tmdbId === id)).filter(Boolean);
    featuredIndex = 0;
    renderFeaturedChoices();
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
  selectedEpisode = undefined;
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
  showSeasons(film);
  if (autoplay && film.kind !== "tv") startFilm();
}

function showSeasons(film) {
  ++episodeVersion;
  byId("episode-panel").hidden = film.kind !== "tv" || !film.seasons;
  if (byId("episode-panel").hidden) return;
  const seasonSelect = byId("season");
  seasonSelect.replaceChildren(...Array.from({ length: Math.min(film.seasons, 100) }, (_, index) => new Option(`Temporada ${index + 1}`, index + 1)));
  showEpisodes();
}

async function showEpisodes() {
  const version = ++episodeVersion;
  const film = activeFilm;
  const season = Number(byId("season").value);
  const list = byId("episodes");
  list.textContent = "Carregando episódios…";
  try {
    const data = await membership.api(`episodes/${film.id}?season=${season}`);
    if (version !== episodeVersion || !dialog.open) return;
    list.replaceChildren(...data.episodes.map(episode => {
      const button = document.createElement("button");
      button.className = "episode";
      const title = document.createElement("strong");
      title.textContent = `${episode.number}. ${episode.title}`;
      const description = document.createElement("span");
      description.textContent = [episode.duration && `${episode.duration} min`, episode.description].filter(Boolean).join(" · ");
      button.append(title, description);
      button.addEventListener("click", () => {
        selectedEpisode = { season, episode: episode.number };
        startFilm();
      });
      return button;
    }));
    if (!data.episodes.length) list.textContent = "Ainda não há episódios listados para esta temporada.";
  } catch {
    if (version === episodeVersion && dialog.open) list.textContent = "A lista de episódios está indisponível. Use Assistir para escolher no player.";
  }
}

function stopPlayback(message) {
  clearTimeout(loadingTimeout);
  player.replaceChildren();
  player.hidden = true;
  byId("player-controls").hidden = true;
  byId("film-play").hidden = false;
  byId("player-status").textContent = message;
}

async function startFilm() {
  const film = activeFilm;
  if (!film) return;
  const version = ++playVersion;
  byId("film-play").disabled = true;
  let source;
  try {
    source = await membership.play(film.id, selectedEpisode, () => {
      if (version === playVersion) stopPlayback("A sessão de reprodução terminou. Verifique seu plano e tente novamente.");
    });
  } catch (error) {
    if (version !== playVersion || !dialog.open) return;
    if (error.message === "login_required" || error.message === "subscription_required") {
      const message = error.message === "login_required" ? "Entre com Google para assistir." : "Escolha um plano ativo para assistir.";
      stopPlayback(message);
      membership.openAccount();
    } else {
      stopPlayback(error.message === "screen_limit" ? "Todas as telas do seu plano estão em uso. Feche outra reprodução e tente novamente." : "Não foi possível liberar a reprodução. Tente novamente.");
    }
    return;
  } finally {
    if (version === playVersion) byId("film-play").disabled = false;
  }
  if (version !== playVersion || !dialog.open) return;
  clearTimeout(loadingTimeout);
  player.hidden = false;
  byId("player-controls").hidden = false;
  byId("film-play").hidden = true;
  byId("player-status").textContent = film.kind === "tv" && !selectedEpisode
    ? "Carregando player… Selecione a temporada e o episódio no player."
    : "Carregando player…";
  const frame = document.createElement("iframe");
  frame.title = `Player de ${film.title}`;
  frame.allow = "autoplay; encrypted-media; picture-in-picture; fullscreen";
  frame.allowFullscreen = true;
  frame.referrerPolicy = "strict-origin-when-cross-origin";
  frame.src = source;
  frame.addEventListener("load", () => {
    if (player.firstElementChild !== frame) return;
    clearTimeout(loadingTimeout);
    byId("player-status").textContent = film.kind === "tv" && !selectedEpisode ? "Selecione a temporada e o episódio no player." : "";
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
  ++playVersion;
  ++episodeVersion;
  byId("film-play").disabled = false;
  stopPlayback("");
  membership.release();
});
byId("season").addEventListener("change", () => {
  selectedEpisode = undefined;
  showEpisodes();
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
let castLinkTimer;
function openTvOptions() {
  clearTimeout(castLinkTimer);
  byId("open-wvc").hidden = true;
  byId("open-wvc").removeAttribute("href");
  byId("prepare-wvc").hidden = false;
  byId("prepare-wvc").disabled = !activeFilm;
  byId("cast-status").textContent = activeFilm ? `Selecionado: ${activeFilm.title}. Prepare o acesso e abra no Web Video Caster do celular.` : "Abra um filme ou episódio para prepará-lo para a TV.";
  if (!byId("tv-dialog").open) byId("tv-dialog").showModal();
}
byId("film-tv").addEventListener("click", openTvOptions);
byId("open-tv").addEventListener("click", openTvOptions);
byId("prepare-wvc").addEventListener("click", async () => {
  if (!activeFilm) return;
  const button = byId("prepare-wvc");
  button.disabled = true;
  try {
    const handoff = await membership.api("cast/start", { title: activeFilm.id, ...selectedEpisode });
    const page = new URL(location.pathname, location.origin);
    page.hash = new URLSearchParams({ handoff: handoff.token });
    const launch = new URL("wvc-x-callback://open");
    launch.search = new URLSearchParams({ url: page.href, title: activeFilm.title });
    byId("open-wvc").href = launch.href;
    byId("open-wvc").hidden = false;
    button.hidden = true;
    byId("cast-status").textContent = "Pronto! No celular, toque em Abrir Web Video Caster em até 2 minutos. No aplicativo, dê play e selecione a TV.";
    castLinkTimer = setTimeout(() => { byId("open-wvc").hidden = true; byId("open-wvc").removeAttribute("href"); button.hidden = false; byId("cast-status").textContent = "O link expirou. Prepare um novo acesso para transmitir."; }, handoff.expiresIn * 1000);
  } catch (error) {
    byId("cast-status").textContent = error.message === "login_required" || error.message === "subscription_required" ? "Entre na sua conta e ative um plano para transmitir este filme." : "Não foi possível preparar a transmissão. Tente novamente.";
  } finally { button.disabled = false; }
});
byId("open-wvc").addEventListener("click", () => { ++playVersion; stopPlayback(""); membership.release(); });
byId("tv-dialog").addEventListener("close", () => { clearTimeout(castLinkTimer); byId("open-wvc").removeAttribute("href"); });
byId("film-save").addEventListener("click", () => toggleSave(activeFilm));
window.addEventListener("beforeinstallprompt", event => { event.preventDefault(); installPrompt = event; });
window.addEventListener("appinstalled", () => { byId("install").hidden = true; });
const mobileDevice = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ||
  (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
if (!mobileDevice || matchMedia("(display-mode: standalone)").matches) byId("install").hidden = true;
byId("install").addEventListener("click", async () => {
  if (!installPrompt) { byId("install-dialog").showModal(); return; }
  const prompt = installPrompt;
  installPrompt = null;
  await prompt.prompt();
});

membership.init();
let resumeRequested = false;
async function resumePending() {
  if (!resumeRequested || !manifest) return;
  resumeRequested = false;
  try {
    const target = JSON.parse(sessionStorage.getItem("srcine-watch") || "null");
    if (!target?.title) return;
    const kind = target.title.startsWith("series-") ? "tv" : "movie";
    await loadIndex(kind);
    const film = indexes.get(kind)?.find(item => item.id === target.title);
    if (!film) return;
    if (dialog.open) dialog.close();
    openFilm(film);
    if (film.kind === "tv" && Number.isInteger(target.season) && Number.isInteger(target.episode)) {
      selectedEpisode = { season: target.season, episode: target.episode };
      byId("season").value = String(target.season);
      showEpisodes();
    }
    if (film.kind !== "tv" || selectedEpisode) startFilm();
  } catch { byId("status").textContent = "Acesso confirmado. Escolha um título para assistir."; }
}
window.addEventListener("srcine:access-ready", () => { resumeRequested = true; resumePending(); });

async function init() {
  manifest = await fetchJson("manifest.json");
  byId("catalog-total").textContent = `${formatNumber(manifest.counts.movie)} FILMES · ${formatNumber(manifest.counts.tv)} SÉRIES`;
  await selectView("movie");
  await resumePending();
}
init().catch(() => {
  byId("hero").hidden = true;
  byId("status").textContent = "Não foi possível carregar o catálogo. Atualize a página para tentar novamente.";
});
