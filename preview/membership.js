"use strict";

window.membership = (() => {
  const byId = id => document.getElementById(id);
  const screen = crypto.randomUUID();
  const currency = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
  const state = { account: null, plan: null, google: false, billing: false };
  let heartbeat;
  let operation = 0;
  let queue = Promise.resolve();

  async function api(path) {
    if (path === "plans") return [
  { id: "mensal", name: "Mensal", months: 1, cents: 1990, screens: 1 },
  { id: "bimestral", name: "Bimestral", months: 2, cents: 3490, screens: 2 },
  { id: "trimestral", name: "Trimestral", months: 3, cents: 4690, screens: 4 },
  { id: "anual", name: "Anual", months: 12, cents: 9990, screens: 10 }
];
    if (path === "me") return { account: null, plan: null, google: false, billing: false };
    if (path.startsWith("episodes/")) {
      const [id, query] = path.slice("episodes/".length).split("?");
      if (id !== "series-1396") throw new Error("episode_preview_unavailable");
      const season = new URLSearchParams(query).get("season");
      const response = await fetch("./data/episodes.json");
      if (!response.ok) throw new Error("episode_preview_unavailable");
      return { episodes: (await response.json())[season] || [] };
    }
    throw new Error("login_required");
  }

  async function refresh() {
    Object.assign(state, await api("me"));
    byId("open-account").textContent = state.account ? "Minha conta" : "Entrar";
    return state;
  }

  async function openAccount(message) {
    await refresh().catch(() => {});
    const dialog = byId("account-dialog");
    const expiration = state.plan ? new Date(state.plan.expires).toLocaleDateString("pt-BR") : "";
    byId("account-message").textContent = message || (state.account
      ? state.plan ? `${state.account.email} · Acesso até ${expiration} · ${state.plan.screens} tela(s)` : `${state.account.email} · Escolha um plano para assistir.`
      : state.google ? "Entre com sua conta Google para assistir." : "Esta é uma prévia. O login com Google, os pagamentos e a reprodução serão ativados no ambiente de membros.");
    const login = byId("google-login");
    login.hidden = Boolean(state.account);
    login.setAttribute("aria-disabled", String(!state.google));
    if (state.google) login.href = "./api/google/start";
    else login.removeAttribute("href");
    byId("account-logout").hidden = !state.account;
    byId("account-stats").hidden = true;
    if (!dialog.open) dialog.showModal();
    if (state.account) {
      const stats = await api("admin/stats").catch(() => null);
      if (!stats || !dialog.open) return;
      const labels = { accounts: "Contas cadastradas", recentlyActive: "Contas ativas nos últimos 15 minutos", subscribers: "Assinantes ativos", playing: "Telas em reprodução" };
      byId("account-stats").replaceChildren(...Object.entries(labels).flatMap(([key, label]) => {
        const term = document.createElement("dt");
        term.textContent = label;
        const value = document.createElement("dd");
        value.textContent = stats[key];
        return [term, value];
      }));
      byId("account-stats").hidden = false;
    }
  }

  async function checkout(plan, button) {
    button.disabled = true;
    const message = byId("plans-status");
    try {
      await refresh();
      if (!state.account) return await openAccount("Você está na prévia. Nenhum pagamento será iniciado.");
      if (!state.billing) { message.textContent = "A cobrança ainda está em configuração."; return; }
      const result = await api("checkout", { plan });
      const target = new URL(result.checkout);
      if (target.protocol !== "https:" || !/(^|\.)mercadopago\.com\.br$/.test(target.hostname)) throw new Error("invalid_checkout");
      location.assign(target.href);
    } catch (error) {
      message.textContent = error.message === "active_plan" ? "Sua conta já tem um plano ativo." : "Não foi possível iniciar o pagamento. Tente novamente.";
    } finally { button.disabled = false; }
  }

  async function loadPlans() {
    const plans = await api("plans");
    byId("plans").replaceChildren(...plans.map(plan => {
      const card = document.createElement("article");
      card.className = "plan";
      if (plan.months === 12) card.classList.add("plan-annual");
      const name = document.createElement("h3");
      name.textContent = plan.name;
      const price = document.createElement("strong");
      price.textContent = currency.format(plan.cents / 100);
      const terms = document.createElement("p");
      terms.textContent = `${plan.months} ${plan.months === 1 ? "mês" : "meses"} · ${plan.screens} ${plan.screens === 1 ? "tela simultânea" : "telas simultâneas"}`;
      const button = document.createElement("button");
      button.className = "primary";
      button.textContent = `Escolher ${plan.name.toLowerCase()}`;
      button.addEventListener("click", () => checkout(plan.id, button));
      card.append(name, price, terms, button);
      return card;
    }));
  }

  function enqueue(action) {
    const next = queue.then(action);
    queue = next.catch(() => {});
    return next;
  }

  function release() {}

  function play(title, episode, onStop) {
    const attempt = ++operation;
    clearInterval(heartbeat);
    return enqueue(async () => {
      if (attempt !== operation) throw new Error("superseded");
      const permission = await api("play", { title, screen, ...episode });
      if (attempt !== operation) throw new Error("superseded");
      heartbeat = setInterval(async () => {
        try { await api("screen/renew", { screen }); }
        catch (error) {
          if (attempt !== operation) return;
          release();
          onStop(error.message);
        }
      }, 20000);
      return permission.player;
    });
  }

  function init() {
    loadPlans().catch(() => { byId("plans-status").textContent = "Os planos estão indisponíveis no momento."; });
    refresh().catch(() => {});
    byId("open-account").addEventListener("click", () => openAccount());
    byId("open-tv").addEventListener("click", () => byId("tv-dialog").showModal());
    byId("account-plans").addEventListener("click", () => {
      byId("account-dialog").close();
      document.getElementById("film-dialog").close();
      byId("assinatura").scrollIntoView({ behavior: "smooth" });
    });
    byId("account-logout").addEventListener("click", async () => {
      try { await api("logout", {}); location.assign("./"); }
      catch { byId("account-message").textContent = "Não foi possível sair. Tente novamente."; }
    });
    const params = new URLSearchParams(location.search);
    if (params.has("pagamento")) openAccount("Verificando o pagamento. O acesso é liberado após a confirmação.");
    if (params.get("login") === "failed") openAccount("Não foi possível entrar com Google. Tente novamente.");
    window.addEventListener("pagehide", () => { if (heartbeat) release(); });
  }
  return { api, init, openAccount, play, release };
})();
