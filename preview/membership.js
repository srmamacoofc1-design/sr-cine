"use strict";

window.membership = (() => {
  const byId = id => document.getElementById(id);
  const screen = crypto.randomUUID();
  const currency = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
  const state = { account: null, plan: null, google: false, billing: false };
  let heartbeat;
  let operation = 0;
  let queue = Promise.resolve();
  let authMode = "login";
  let plansRequest;
  let paymentTimer;
  let paymentVersion = 0;
  let paymentBusy = false;

  let previewAccount = null;
  async function api(path, data) {
    if (path === "plans") return [
  { id: "mensal", name: "Mensal", months: 1, cents: 1990, screens: 1 },
  { id: "bimestral", name: "Bimestral", months: 2, cents: 3490, screens: 2 },
  { id: "trimestral", name: "Trimestral", months: 3, cents: 4690, screens: 4 },
  { id: "anual", name: "Anual", months: 12, cents: 9990, screens: 10 }
];
    if (path === "me") return { account: previewAccount, plan: null, google: true, billing: false };
    if (path === "email/login" || path === "email/register") {
      previewAccount = { email: "visitante@exemplo.com", name: "Visitante" };
      return { ok: true };
    }
    if (path === "play") throw new Error(previewAccount ? "subscription_required" : "login_required");
    if (path === "logout") { previewAccount = null; return { ok: true }; }
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
    byId("open-admin").hidden = !state.admin;
    return state;
  }

  async function openPlans() {
    byId("payment-dialog").close();
    byId("account-dialog").close();
    document.getElementById("film-dialog").close();
    byId("plans-context").textContent = state.account
      ? `${state.account.email} · Escolha o plano para liberar seu acesso.`
      : "Escolha seu plano. Você poderá entrar ou criar uma conta para continuar.";
    const dialog = byId("plans-dialog");
    if (!dialog.open) dialog.showModal();
    try { await loadPlans(); }
    catch { byId("plans-status").textContent = "Os planos estão indisponíveis no momento. Tente novamente."; }
  }

  async function afterLogin() {
    await refresh();
    byId("email-login").reset();
    byId("account-dialog").close();
    if (state.admin && sessionStorage.getItem("srcine-admin-intent")) {
      sessionStorage.removeItem("srcine-admin-intent");
      location.assign("./admin");
      return;
    }
    if (state.plan) return resume();
    if (sessionStorage.getItem("srcine-order")) return openPayment();
    await openPlans();
  }

  async function openAccount(message) {
    await refresh().catch(() => {});
    if (state.account && !state.plan && !state.admin && !state.blocked) {
      if (sessionStorage.getItem("srcine-order")) return openPayment();
      return openPlans();
    }
    byId("plans-dialog").close();
    const dialog = byId("account-dialog");
    const expiration = state.plan ? new Date(state.plan.expires).toLocaleDateString("pt-BR") : "";
    byId("account-message").textContent = message || (state.blocked ? "Sua conta está bloqueada. Entre em contato com o suporte." : state.account
      ? state.plan ? `${state.account.email} · Acesso até ${expiration} · ${state.plan.screens} tela(s)` : `${state.account.email} · Escolha um plano para assistir.`
      : "Entre ou crie sua conta. Em seguida, escolha seu plano.");
    byId("account-title").textContent = state.account ? "Minha conta" : authMode === "register" ? "Crie sua conta" : "Entre para assistir";
    byId("login-options").hidden = Boolean(state.account);
    byId("account-plans").hidden = !state.account;
    byId("login-error").textContent = "";
    const login = byId("google-login");
    login.hidden = Boolean(state.account);
    login.setAttribute("aria-disabled", String(!state.google));
    if (state.google) login.href = "./api/google/start";
    else login.removeAttribute("href");
    byId("account-logout").hidden = !state.account;
    byId("account-stats").hidden = true;
    if (!dialog.open) dialog.showModal();
    if (state.admin) {
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
      if (!state.account) {
        return await openAccount("Entre com Google ou e-mail para continuar com o plano escolhido.");
      }
      if (!state.billing) { message.textContent = "Este é um plano demonstrativo. O pagamento real ainda aguarda configuração."; return; }
      const result = await api("checkout", { plan });
      const target = new URL(result.checkout);
      if (target.protocol !== "https:" || !/(^|\.)mercadopago\.com\.br$/.test(target.hostname)) throw new Error("invalid_checkout");
      sessionStorage.setItem("srcine-order", result.order);
      location.assign(target.href);
    } catch (error) {
      message.textContent = error.message === "active_plan" ? "Sua conta já tem um plano ativo." : "Não foi possível iniciar o pagamento. Tente novamente.";
    } finally { button.disabled = false; }
  }

  async function loadPlans() {
    if (plansRequest) return plansRequest;
    plansRequest = renderPlans().catch(error => { plansRequest = undefined; throw error; });
    return plansRequest;
  }

  async function renderPlans() {
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
    sessionStorage.setItem("srcine-watch", JSON.stringify({ title, ...episode }));
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

  function resume() {
    for (const id of ["plans-dialog", "account-dialog", "payment-dialog"]) byId(id).close();
    window.dispatchEvent(new CustomEvent("srcine:access-ready"));
  }

  async function checkPayment(version = paymentVersion) {
    if (paymentBusy) return;
    paymentBusy = true;
    clearTimeout(paymentTimer);
    byId("check-payment").disabled = true;
    try {
      const order = sessionStorage.getItem("srcine-order");
      const result = await api("payment/status", order ? { order } : {});
      if (version !== paymentVersion || !byId("payment-dialog").open) return;
      await refresh();
      if (version !== paymentVersion || !byId("payment-dialog").open) return;
      if (state.plan) {
        sessionStorage.removeItem("srcine-order");
        byId("payment-title").textContent = "Acesso liberado!";
        byId("payment-status").textContent = `Seu plano está ativo até ${new Date(state.plan.expires).toLocaleString("pt-BR")}. Você já pode assistir.`;
        byId("watch-paid").hidden = false;
        byId("check-payment").hidden = true;
      } else if (["rejected", "cancelled", "refunded", "charged_back"].includes(result.status)) {
        byId("payment-status").textContent = "Este pagamento não liberou acesso. Confira a situação no Mercado Pago ou escolha outro plano.";
      } else {
        byId("payment-status").textContent = "Aguardando confirmação do Mercado Pago. Seu acesso será liberado após a aprovação. Você pode fechar esta tela e verificar novamente em Minha conta.";
        paymentTimer = setTimeout(() => checkPayment(version), 5000);
      }
    } catch (error) {
      if (version !== paymentVersion) return;
      byId("payment-status").textContent = error.message === "order_not_found" ? "Não encontramos um pedido desta conta. Escolha seu plano para continuar." : "Não foi possível consultar agora. Use Verificar agora para tentar novamente. Seu acesso continua protegido.";
    } finally { paymentBusy = false; byId("check-payment").disabled = false; }
  }

  async function openPayment() {
    await refresh();
    if (!state.account) return openAccount("Entre na conta usada no pagamento para consultar a confirmação.");
    for (const id of ["plans-dialog", "account-dialog", "film-dialog"]) byId(id).close();
    byId("payment-title").textContent = "Confirmando seu pagamento";
    byId("watch-paid").hidden = true;
    byId("check-payment").hidden = false;
    if (!byId("payment-dialog").open) byId("payment-dialog").showModal();
    await checkPayment(++paymentVersion);
  }

  function init() {
    loadPlans().catch(() => { byId("plans-status").textContent = "Os planos estão indisponíveis no momento."; });
    byId("google-login").addEventListener("click", async event => {
      event.preventDefault();
      previewAccount = { email: "visitante@exemplo.com", name: "Visitante" };
      await afterLogin();
    });
    byId("preview-plans").addEventListener("click", openPlans);
    const params = new URLSearchParams(location.search);
    const hash = new URLSearchParams(location.hash.slice(1));
    if (params.get("admin") === "login") sessionStorage.setItem("srcine-admin-intent", "1");
    refresh().then(async () => {
      if (hash.has("handoff")) {
        try {
          const target = await api("cast/redeem", { token: hash.get("handoff") });
          history.replaceState(null, "", location.pathname);
          sessionStorage.setItem("srcine-watch", JSON.stringify(target));
          await refresh();
          resume();
        } catch { history.replaceState(null, "", location.pathname); openAccount("O link para a TV expirou. Prepare outro link no navegador de origem."); }
      } else if (params.has("pagamento")) openPayment();
      else if (params.get("login") === "success" && state.account) afterLogin();
      else if (params.get("admin") === "login") openAccount("Entre com a conta Google do proprietário para abrir o painel.");
      else if (sessionStorage.getItem("srcine-order") && state.account) openPayment();
    }).catch(() => {});
    byId("open-account").addEventListener("click", () => openAccount());
    byId("open-plans").addEventListener("click", openPlans);
    byId("account-plans").addEventListener("click", openPlans);
    byId("check-payment").addEventListener("click", () => checkPayment());
    byId("watch-paid").addEventListener("click", resume);
    byId("other-plan").addEventListener("click", () => { sessionStorage.removeItem("srcine-order"); openPlans(); });
    byId("payment-dialog").addEventListener("close", () => { ++paymentVersion; clearTimeout(paymentTimer); });
    byId("auth-switch").addEventListener("click", () => {
      authMode = authMode === "login" ? "register" : "login";
      byId("account-title").textContent = authMode === "register" ? "Crie sua conta" : "Entre para assistir";
      byId("login-submit").textContent = authMode === "register" ? "Criar conta e ver planos" : "Entrar e continuar";
      byId("auth-switch-label").textContent = authMode === "register" ? "Já tem uma conta?" : "Primeira vez aqui?";
      byId("auth-switch").textContent = authMode === "register" ? "Entrar" : "Criar minha conta";
      byId("login-password").autocomplete = authMode === "register" ? "new-password" : "current-password";
      byId("login-error").textContent = "";
    });
    byId("email-login").addEventListener("submit", async event => {
      event.preventDefault();
      const button = byId("login-submit");
      button.disabled = true;
      try {
        await api(`email/${authMode}`, { email: byId("login-email").value.trim(), password: byId("login-password").value });
        await afterLogin();
      } catch (error) {
        const messages = { invalid_credentials: "E-mail ou senha incorretos.", invalid_registration: "Use um e-mail válido e uma senha entre 8 e 128 caracteres.", registration_unavailable: "Não foi possível criar a conta. Tente entrar ou use o Google.", too_many_attempts: "Muitas tentativas. Aguarde alguns minutos e tente novamente." };
        byId("login-error").textContent = messages[error.message] || "Não foi possível entrar. Tente novamente.";
      } finally { button.disabled = false; }
    });
    byId("account-logout").addEventListener("click", async () => {
      try { await api("logout", {}); location.assign("./"); }
      catch { byId("account-message").textContent = "Não foi possível sair. Tente novamente."; }
    });
    if (params.get("login") === "failed") openAccount("Não foi possível entrar com Google. Tente novamente.");
    if (params.get("login") === "blocked") openAccount("Sua conta está bloqueada. Fale com o suporte.");
    window.addEventListener("pagehide", () => { if (heartbeat) release(); });
  }
  return { api, init, openAccount, openPlans, afterLogin, play, release };
})();
