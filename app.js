"use strict";

const byId = id => document.getElementById(id);
const filmDialog = byId("film-dialog");
const player = byId("player");
const query = byId("query");
let catalog = [];
let view = "home";
let genre = "Todos";
let activeFilm;
let installPrompt;
let searchRequest;
let searchTimer;
let tmdbEnabled = false;
let featuredIndex = 0;
let playerLoadingTimeout;

function loadState(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}
function writeState(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
}
const saved = new Set(loadState("sr-cine:lista", []));
const progress = loadState("sr-cine:progresso", {});
const normalize = value => value.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
const metadata = film => [film.rating ? `★ ${film.rating.toFixed(1)}` : "", film.year, film.genre, film.duration].filter(Boolean).join("  ·  ");

function saveLabel(film) {
  return saved.has(film.id) ? "Remover da minha lista" : "Adicionar à minha lista";
}

function updateSave() {
  const button = byId("film-save");
  button.textContent = saved.has(activeFilm.id) ? "✓ Na minha lista" : "＋ Minha lista";
  button.setAttribute("aria-label", saveLabel(activeFilm));
  button.setAttribute("aria-pressed", saved.has(activeFilm.id));
}

function toggleSave(film) {
  if (saved.has(film.id)) saved.delete(film.id);
  else saved.add(film.id);
  writeState("sr-cine:lista", [...saved]);
  render();
  if (filmDialog.open && activeFilm.id === film.id) updateSave();
}

function createCard(film) {
  const article = document.createElement("article");
  article.className = "card";
  const open = document.createElement("button");
  open.type = "button";
  open.className = "open";
  open.setAttribute("aria-label", `Assistir ${film.title}`);
  const cover = document.createElement("span");
  cover.className = "cover";
  const image = document.createElement("img");
  image.src = film.poster || `./art/${film.id}.webp`;
  image.alt = "";
  image.loading = "lazy";
  image.addEventListener("error", () => image.remove(), { once: true });
  cover.append(image);
  const details = document.createElement("span");
  details.className = "card-copy";
  const title = document.createElement("strong");
  title.textContent = film.title;
  const meta = document.createElement("small");
  meta.textContent = metadata(film);
  details.append(title, meta);
  open.append(cover, details);
  open.addEventListener("click", () => openFilm(film, Boolean(film.type)));
  article.append(open);
  if (film.type) {
    const favorite = document.createElement("button");
    favorite.className = "outline save";
    favorite.textContent = saved.has(film.id) ? "✓" : "+";
    favorite.dataset.saveId = film.id;
    favorite.setAttribute("aria-label", `${saveLabel(film)}: ${film.title}`);
    favorite.setAttribute("aria-pressed", saved.has(film.id));
    favorite.addEventListener("click", () => {
      toggleSave(film);
      (document.querySelector(`[data-save-id="${CSS.escape(film.id)}"]`) || query).focus();
    });
    article.append(favorite);
  }
  return article;
}

function render() {
  byId("hero").hidden = view === "saved";
  byId("library-title").textContent = view === "saved" ? "Minha lista" : "Filmes em destaque";
  document.querySelectorAll("[data-view]").forEach(button => button.setAttribute("aria-pressed", view === button.dataset.view));
  document.querySelectorAll("[data-genre]").forEach(button => button.setAttribute("aria-pressed", genre === button.dataset.genre));
  const term = normalize(query.value.trim());
  const films = catalog.filter(film =>
    (view === "home" || saved.has(film.id)) &&
    (genre === "Todos" || (genre === "Lançamentos" && Number(film.year) >= 2025) || (genre === "Mais bem avaliados" && film.rating >= 8)) &&
    normalize([film.title, film.originalTitle, film.genre].filter(Boolean).join(" ")).includes(term)
  );
  byId("cards").replaceChildren(...films.map(createCard));
  byId("status").textContent = films.length ? `${films.length} filmes` : view === "saved" && !saved.size
    ? "Sua lista está vazia. Use o botão + para salvar um filme."
    : "Nenhum filme encontrado. Tente outro título.";
}

function scheduleSearch() {
  clearTimeout(searchTimer);
  searchRequest?.abort();
  byId("discovery").hidden = true;
  const term = query.value.trim();
  if (!tmdbEnabled || view !== "home" || term.length < 2) return;
  const controller = new AbortController();
  searchRequest = controller;
  searchTimer = setTimeout(async () => {
    try {
      const response = await fetch(`/api/search?q=${encodeURIComponent(term)}`, { signal: controller.signal });
      if (!response.ok) throw new Error("Catálogo indisponível");
      const films = await response.json();
      if (controller.signal.aborted) return;
      byId("results").replaceChildren(...films.map(createCard));
      byId("discovery").hidden = !films.length;
    } catch {
      if (!controller.signal.aborted && !byId("status").textContent) {
        byId("status").textContent = "Busca no TMDB indisponível no momento.";
      }
    }
  }, 350);
}

function openFilm(film, autoplay = false) {
  activeFilm = film;
  byId("film-kind").textContent = film.type ? "SR.CINE" : "CATÁLOGO TMDB";
  byId("film-title").textContent = film.title;
  byId("film-meta").textContent = metadata(film);
  byId("film-description").textContent = film.description || "Sinopse indisponível.";
  byId("player-status").textContent = film.type ? "" : "Filme indisponível para reprodução na seleção.";
  const play = byId("film-play");
  play.hidden = !film.type;
  play.textContent = progress[film.id] ? "▶  Continuar assistindo" : "▶  Assistir";
  byId("film-save").hidden = !film.type;
  if (film.type) updateSave();
  const source = byId("source");
  source.href = film.project ? `https://studio.blender.org/projects/${film.project}/` : film.source;
  source.hidden = !film.project && !film.source;
  source.textContent = film.type === "embedmovies" ? "Player do EmbedMovies" : film.project ? "© Blender Foundation · Ver créditos e licença" : "Ver no TMDB";
  filmDialog.showModal();
  if (autoplay) startFilm();
}

function startFilm() {
  const film = activeFilm;
  if (!film.type) return;
  clearTimeout(playerLoadingTimeout);
  player.hidden = false;
  byId("player-controls").hidden = false;
  byId("film-play").hidden = true;
  if (film.type === "mp4") {
    const video = document.createElement("video");
    video.controls = true;
    video.playsInline = true;
    video.preload = "metadata";
    video.addEventListener("loadedmetadata", () => {
      if (progress[film.id] > 0 && progress[film.id] < video.duration - 3) video.currentTime = progress[film.id];
    }, { once: true });
    const persist = () => {
      if (!Number.isFinite(video.duration) || (video.currentTime < 1 && !video.ended)) return;
      progress[film.id] = video.ended ? 0 : Math.floor(video.currentTime);
      writeState("sr-cine:progresso", progress);
    };
    video.addEventListener("timeupdate", persist);
    video.addEventListener("ended", persist);
    video.addEventListener("error", () => {
      byId("player-status").textContent = "Não foi possível carregar este vídeo. Tente novamente.";
      byId("film-play").hidden = false;
    });
    byId("player-status").textContent = "";
    video.src = film.video;
    player.replaceChildren(video);
    video.play().catch(() => {});
  } else {
    const frame = document.createElement("iframe");
    frame.title = `Player de ${film.title}`;
    frame.allow = "autoplay; encrypted-media; picture-in-picture; fullscreen";
    frame.allowFullscreen = true;
    frame.referrerPolicy = "strict-origin-when-cross-origin";
    if (film.type === "youtube") {
      frame.src = `https://www.youtube-nocookie.com/embed/${film.video}?autoplay=1&playsinline=1`;
      const link = document.createElement("a");
      link.href = `https://www.youtube.com/watch?v=${film.video}`;
      link.target = "_blank";
      link.rel = "noopener";
      link.textContent = "Abrir no YouTube";
      byId("player-status").replaceChildren(link);
    } else if (film.type === "bunny") {
      frame.src = `https://player.mediadelivery.net/embed/${film.video}?autoplay=true`;
      byId("player-status").textContent = "";
    } else if (film.type === "embedmovies" && /^https:\/\/myembed\.biz\/filme\/(?:tt\d+|\d+)$/.test(film.video)) {
      frame.src = film.video;
      byId("player-status").textContent = "Carregando player…";
      frame.addEventListener("load", () => {
        if (player.firstElementChild !== frame) return;
        clearTimeout(playerLoadingTimeout);
        byId("player-status").textContent = "";
      }, { once: true });
      frame.addEventListener("error", () => {
        if (player.firstElementChild !== frame) return;
        clearTimeout(playerLoadingTimeout);
        byId("player-status").textContent = "O player está indisponível. Tente carregar novamente.";
      }, { once: true });
      playerLoadingTimeout = setTimeout(() => {
        if (player.firstElementChild === frame) {
          byId("player-status").textContent = "O player está demorando. Se precisar, use Recarregar player.";
        }
      }, 15000);
    }
    player.replaceChildren(frame);
  }
  player.scrollIntoView({ block: "nearest" });
}

document.querySelectorAll("[data-close]").forEach(button => button.addEventListener("click", () => button.closest("dialog").close()));
filmDialog.addEventListener("close", () => {
  clearTimeout(playerLoadingTimeout);
  player.replaceChildren();
  player.hidden = true;
  byId("player-controls").hidden = true;
  byId("player-status").textContent = "";
});
document.querySelectorAll("[data-view]").forEach(button => button.addEventListener("click", () => {
  view = button.dataset.view;
  genre = "Todos";
  query.value = "";
  render();
  scheduleSearch();
}));
query.addEventListener("input", () => { render(); scheduleSearch(); });
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

function showFeatured() {
  const featured = catalog[featuredIndex];
  byId("hero-art").src = featured.backdrop || featured.poster || `./art/${featured.id}.webp`;
  byId("hero-title").textContent = featured.title;
  byId("hero-meta").textContent = metadata(featured);
  byId("hero-description").textContent = featured.description;
  byId("hero-position").textContent = `${featuredIndex + 1} / ${Math.min(catalog.length, 5)}`;
}

function stepFeatured(direction) {
  featuredIndex = (featuredIndex + direction + Math.min(catalog.length, 5)) % Math.min(catalog.length, 5);
  showFeatured();
}
byId("hero-previous").addEventListener("click", () => { if (catalog.length) stepFeatured(-1); });
byId("hero-next").addEventListener("click", () => { if (catalog.length) stepFeatured(1); });

async function init() {
  const response = await fetch("./catalog.json?v=embed-3");
  if (!response.ok) throw new Error("Catálogo indisponível");
  ({ films: catalog, tmdbEnabled } = await response.json());
  byId("tmdb-credit").hidden = !tmdbEnabled;
  if (!catalog.length) throw new Error("Catálogo vazio");
  showFeatured();
  byId("hero-play").addEventListener("click", () => openFilm(catalog[featuredIndex], true));
  byId("hero-info").addEventListener("click", () => openFilm(catalog[featuredIndex]));
  for (const label of ["Todos", "Lançamentos", "Mais bem avaliados"]) {
    const button = document.createElement("button");
    button.className = "chip";
    button.textContent = label;
    button.dataset.genre = label;
    button.addEventListener("click", () => { genre = label; render(); });
    byId("filters").append(button);
  }
  render();
  scheduleSearch();
}

init().catch(() => {
  byId("hero").hidden = true;
  byId("status").textContent = "Não foi possível carregar o catálogo. Atualize a página para tentar de novo.";
});
