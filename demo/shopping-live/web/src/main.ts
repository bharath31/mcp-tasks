import { setSessionCsrfToken, shoppingApi } from "./api.js";
import { formatMoney, STORE_PRODUCTS } from "./catalog.js";
import { safeNavHref } from "./nav.js";
import {
  canExecuteOrder,
  canRequestQuote,
  canStartAgent,
  canStartApproval,
  gateLabel,
  sessionVerified,
} from "./gating.js";
import type {
  AgentRun,
  ApprovalRecord,
  Cart,
  Quote,
  SessionResponse,
} from "./types.js";

type UiState = {
  session: SessionResponse | null;
  sessionError: string | null;
  cart: Cart | null;
  cartError: string | null;
  quote: Quote | null;
  quoteError: string | null;
  approval: ApprovalRecord | null;
  approvalError: string | null;
  orderMessage: string | null;
  agent: AgentRun | null;
  agentError: string | null;
  busy: string | null;
  apiAvailable: boolean;
};

const POLL_MS = 4000;

const root = document.getElementById("app")!;

const ui: UiState = {
  session: null,
  sessionError: null,
  cart: null,
  cartError: null,
  quote: null,
  quoteError: null,
  approval: null,
  approvalError: null,
  orderMessage: null,
  agent: null,
  agentError: null,
  busy: null,
  apiAvailable: false,
};

let pollGeneration = 0;
let agentPollTimer: number | undefined;
let approvalPollTimer: number | undefined;

function cancelPolls(): void {
  pollGeneration += 1;
  if (agentPollTimer !== undefined) {
    window.clearTimeout(agentPollTimer);
    agentPollTimer = undefined;
  }
  if (approvalPollTimer !== undefined) {
    window.clearTimeout(approvalPollTimer);
    approvalPollTimer = undefined;
  }
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Record<string, string | boolean | undefined> = {},
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === false) continue;
    if (key === "className") node.className = String(value);
    else if (key.startsWith("data-")) node.setAttribute(key, String(value));
    else if (key === "disabled" && value === true) node.setAttribute("disabled", "");
    else if (key === "ariaHidden" && value === true)
      node.setAttribute("aria-hidden", "true");
    else if (typeof value === "string") node.setAttribute(key, value);
  }
  for (const child of children) {
    node.append(child instanceof Node ? child : document.createTextNode(child));
  }
  return node;
}

function statusBanner(): HTMLElement {
  const connected = sessionVerified(ui.session);
  const wallet = ui.session?.merchant;
  return el(
    "div",
    {
      className: "status-banner",
      "data-nominee-connection": connected ? "verified" : "unavailable",
      role: "status",
    },
    [
      el("p", {}, [
        connected
          ? `Signed in · ${wallet?.label ?? "Merchant wallet"} (${wallet?.mode ?? "unknown"} until the API reports it). Real browser shopping and Guardian approval apply only on a connected Nominee deployment.`
          : ui.apiAvailable
            ? "Shopping API is reachable but you are not signed in. Browser shopping, simulated wallet debits, and Guardian approval stay inactive until you authenticate."
            : "No shopping API on this origin yet. This page is static UI only — no cart sync, agent runs, quotes, approvals, or orders are simulated locally.",
      ]),
    ],
  );
}

function authControls(): HTMLElement {
  const wrap = el("div", { className: "auth-chip" });
  if (!ui.apiAvailable) {
    wrap.append(
      el("span", { className: "auth-label" }, ["API unavailable"]),
      el("button", { type: "button", disabled: true }, ["Sign in"]),
    );
    return wrap;
  }
  const logoutHref = safeNavHref(ui.session?.logoutUrl, window.location.origin);
  if (ui.session?.authenticated && logoutHref) {
    wrap.append(
      el("span", { className: "auth-label" }, [
        ui.session.customerId
          ? `Customer ${ui.session.customerId}`
          : "Signed in",
      ]),
      el(
        "a",
        {
          className: "button button--ghost",
          href: logoutHref,
          "data-nominee-action": "logout",
        },
        ["Sign out"],
      ),
    );
    return wrap;
  }
  const loginHref = safeNavHref(ui.session?.loginUrl, window.location.origin);
  wrap.append(
    el("span", { className: "auth-label" }, ["Not signed in"]),
    loginHref
      ? el(
          "a",
          {
            className: "button button--coral",
            href: loginHref,
            "data-nominee-action": "login",
          },
          ["Sign in"],
        )
      : el("button", { type: "button", disabled: true }, ["Sign in"]),
  );
  return wrap;
}

function consumerPanel(): HTMLElement {
  const panel = el("section", {
    className: "panel consumer-panel",
    "data-nominee-panel": "consumer",
    "aria-labelledby": "consumer-heading",
  });
  panel.append(
    el("header", { className: "panel-head" }, [
      el("div", { className: "agent-avatar", "aria-hidden": true }, ["🍊"]),
      el("div", {}, [
        el("h2", { id: "consumer-heading" }, ["Poppy"]),
        el("p", { className: "muted" }, [
          ui.agent?.status === "running"
            ? "Shopping in the merchant browser…"
            : "Ready when you are",
        ]),
      ]),
      authControls(),
    ]),
    el("p", { className: "intro-copy" }, [
      "Poppy shops in a real browser you can watch on the right. It asks before it buys anything. Guardian approval is required for checkout and is only real once this demo is connected to Nominee.",
    ]),
  );

  const prompts = [
    "Find a warm jacket under $150 and add it to my cart",
    "What's on sale right now?",
    "Show me what you can find for a rainy day",
  ];
  const pills = el("div", { className: "prompt-pills", role: "list" });
  for (const text of prompts) {
    const disabled = canStartAgent(ui.session) !== "ok" || Boolean(ui.busy);
    const pill = el(
      "button",
      {
        type: "button",
        className: "pill",
        disabled,
        "data-nominee-prompt": text,
      },
      [text],
    );
    pill.addEventListener("click", () => void startAgent(text));
    pills.append(pill);
  }
  panel.append(pills);

  const form = el("form", { className: "composer", "data-nominee-agent-form": "true" });
  const input = el("input", {
    type: "text",
    name: "goal",
    placeholder: "Ask Poppy to find something…",
    "aria-label": "Shopping goal for Poppy",
    autocomplete: "off",
    disabled: canStartAgent(ui.session) !== "ok" || Boolean(ui.busy),
  }) as HTMLInputElement;
  const submit = el(
    "button",
    {
      type: "submit",
      className: "button button--coral",
      disabled: canStartAgent(ui.session) !== "ok" || Boolean(ui.busy),
      "data-nominee-action": "agent-start",
    },
    ["Send"],
  );
  form.append(input, submit);
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const goal = input.value.trim();
    if (!goal) return;
    void startAgent(goal);
    input.value = "";
  });
  panel.append(form);

  if (ui.agentError) {
    panel.append(el("p", { className: "error", role: "alert" }, [ui.agentError]));
  }

  const feed = el("div", {
    className: "agent-feed",
    "data-nominee-agent-feed": "true",
    "aria-live": "polite",
    "aria-relevant": "additions",
  });
  const events = ui.agent?.events ?? [];
  if (!events.length) {
    feed.append(
      el("p", { className: "muted" }, [
        "Agent activity appears here only after the server accepts a run. Nothing is invented in the browser.",
      ]),
    );
  } else {
    for (const event of events) {
      feed.append(
        el("article", { className: "agent-event", "data-kind": event.kind }, [
          el("time", { dateTime: event.at }, [
            new Date(event.at).toLocaleTimeString(),
          ]),
          el("p", {}, [event.message]),
        ]),
      );
    }
  }
  panel.append(el("h3", { className: "feed-title" }, ["Agent activity"]), feed);

  const checkout = checkoutPanel();
  panel.append(checkout);

  return panel;
}

function checkoutPanel(): HTMLElement {
  const quoteGate = canRequestQuote(ui.session, ui.cart);
  const approvalGate = canStartApproval(ui.session, ui.quote);
  const executeGate = canExecuteOrder(ui.session, ui.quote, ui.approval);

  const section = el("section", {
    className: "checkout-panel",
    "data-nominee-checkout": "panel",
  });

  section.append(
    el("h3", {}, ["Checkout (server-gated)"]),
    el("p", { className: "muted small" }, [
      "Quotes, Guardian approval, and order execution call the Nominee API. Buttons stay disabled until the server returns verified state.",
    ]),
  );

  if (ui.cartError) {
    section.append(el("p", { className: "error", role: "alert" }, [ui.cartError]));
  }

  const quoteBtn = el(
    "button",
    {
      type: "button",
      className: "button",
      disabled: quoteGate !== "ok" || Boolean(ui.busy),
      "data-nominee-action": "quote",
      "data-nominee-checkout-boundary": "true",
    },
    ["Review quote"],
  );
  quoteBtn.addEventListener("click", () => void requestQuote());
  section.append(quoteBtn, el("p", { className: "hint" }, [gateLabel(quoteGate)]));

  if (ui.quote) {
    section.append(
      el("dl", { className: "quote-dl", "data-nominee-quote": ui.quote.id }, [
        el("div", {}, [el("dt", {}, ["Quote"]), el("dd", {}, [ui.quote.id])]),
        el("div", {}, [
          el("dt", {}, ["Total"]),
          el("dd", {}, [formatMoney(ui.quote.totalMinor, ui.quote.currency)]),
        ]),
        el("div", {}, [
          el("dt", {}, ["Verified"]),
          el("dd", {}, [ui.quote.verified ? "Yes" : "No"]),
        ]),
      ]),
    );
  }
  if (ui.quoteError) {
    section.append(el("p", { className: "error", role: "alert" }, [ui.quoteError]));
  }

  const approvalBtn = el(
    "button",
    {
      type: "button",
      className: "button",
      disabled: approvalGate !== "ok" || Boolean(ui.busy),
      "data-nominee-action": "approval-start",
      "data-nominee-checkout-boundary": "true",
    },
    ["Start Guardian approval"],
  );
  approvalBtn.addEventListener("click", () => void startApproval());
  section.append(approvalBtn, el("p", { className: "hint" }, [gateLabel(approvalGate)]));

  if (ui.approval) {
    const reviewHref = safeNavHref(ui.approval.reviewUrl, window.location.origin);
    const review =
      reviewHref && ui.approval.status === "pending"
        ? el(
            "a",
            {
              href: reviewHref,
              className: "button button--ghost",
              target: "_blank",
              rel: "noopener noreferrer",
              "data-nominee-action": "approval-open",
            },
            ["Open Guardian review"],
          )
        : null;
    section.append(
      el("p", { "data-nominee-approval-status": ui.approval.status }, [
        `Approval ${ui.approval.id}: ${ui.approval.status}`,
      ]),
      ...(review ? [review] : []),
    );
  }
  if (ui.approvalError) {
    section.append(el("p", { className: "error", role: "alert" }, [ui.approvalError]));
  }

  const executeBtn = el(
    "button",
    {
      type: "button",
      className: "button button--coral",
      disabled: executeGate !== "ok" || Boolean(ui.busy),
      "data-nominee-action": "order-execute",
      "data-nominee-checkout-boundary": "true",
    },
    ["Complete checkout"],
  );
  executeBtn.addEventListener("click", () => void executeOrder());
  section.append(executeBtn, el("p", { className: "hint" }, [gateLabel(executeGate)]));

  if (ui.orderMessage) {
    section.append(el("p", { className: "order-message", role: "status" }, [ui.orderMessage]));
  }

  return section;
}

function merchantBrowser(): HTMLElement {
  const signedIn = sessionVerified(ui.session);
  const panel = el("section", {
    className: "panel agent-panel",
    "data-nominee-panel": "agent-browser",
    "aria-labelledby": "agent-heading",
  });
  panel.append(
    el("header", { className: "vm-chrome" }, [
      el("span", { className: "vm-dot" }),
      el("span", { className: "vm-dot" }),
      el("span", { className: "vm-dot" }),
      el("span", { className: "vm-title" }, ["Poppy · merchant browser"]),
      el("span", { className: "vm-badge" }, [
        signedIn ? "Connected account" : "View only",
      ]),
    ]),
    el("h2", { id: "agent-heading", className: "visually-hidden" }, [
      "What the agent sees",
    ]),
    el("p", { className: "browser-url", "data-nominee-merchant-url": "stillroom" }, [
      signedIn
        ? "https://shop.stillroom.supply/"
        : "Merchant storefront — sign in to enable shopping",
    ]),
  );

  const shop = el("section", { id: "shop", className: "shop" });
  shop.append(
    el("div", { className: "section-title" }, [
      el("h3", {}, ["The collection"]),
      el("p", {}, ["Stillroom Supply · illustrative merchant catalog"]),
    ]),
    el("div", { className: "grid" }, [
      ...STORE_PRODUCTS.map((p, i) => {
        const article = el("article", { "data-product-id": p.id });
        article.append(
          el("div", { className: `product-image tone${i % 4}` }, [
            el("img", { src: p.image, alt: "" }),
          ]),
          el("div", { className: "product-heading" }, [
            el("h3", {}, [p.name]),
            el("b", {}, [formatMoney(p.priceMinor, p.currency)]),
          ]),
          el("p", {}, [p.description]),
          el(
            "button",
            {
              type: "button",
              disabled: !signedIn || Boolean(ui.busy),
              "data-nominee-merchant-action": "add",
            },
            [signedIn ? "Add to cart" : "Sign in to add"],
          ),
        );
        article
          .querySelector("button")!
          .addEventListener("click", () => void addToCart(p.id));
        return article;
      }),
    ]),
  );

  const cartSection = el("section", { id: "cart", className: "workspace" });
  cartSection.append(el("h3", {}, ["Your cart"]));
  const list = el("ul", { className: "cart-list" });
  const items = ui.cart?.items ?? [];
  if (!items.length) {
    cartSection.append(
      el("p", { className: "muted" }, [
        signedIn
          ? "No items yet. Add products from the catalog or ask Poppy to shop."
          : "Cart sync requires a verified session.",
      ]),
    );
  } else {
    for (const item of items) {
      const product =
        STORE_PRODUCTS.find((p) => p.id === item.productId) ?? item;
      const name = "name" in product && product.name ? product.name : item.productId;
      const priceMinor =
        item.priceMinor ??
        ("priceMinor" in product ? product.priceMinor : undefined);
      const line =
        priceMinor != null
          ? `${name} ${formatMoney(priceMinor, item.currency ?? "USD")}`
          : name;
      list.append(
        el("li", {}, [
          el("span", {}, [line]),
          el("div", {}, [
            el("button", { type: "button", disabled: true, "aria-label": "Remove one" }, [
              "−",
            ]),
            el("span", {}, [String(item.quantity)]),
            el("button", { type: "button", disabled: true, "aria-label": "Add one" }, [
              "+",
            ]),
          ]),
        ]),
      );
    }
    cartSection.append(list);
  }

  panel.append(shop, cartSection);
  panel.append(
    el("p", { className: "footnote" }, [
      "Stillroom Supply is fictional catalog markup shared with the shopping agent tests. Wallet debits stay simulated until Nominee connects a live merchant adapter.",
    ]),
  );
  return panel;
}

function layout(): HTMLElement {
  const wrap = el("div", { className: "simulator" }, [
    el("header", { className: "sim-header" }, [
      el("h1", {}, ["Simulator"]),
      el("p", { className: "muted" }, [
        "Nominee consumer shopping demo · static frontend",
      ]),
      el(
        "button",
        {
          type: "button",
          className: "button button--ghost",
          "data-nominee-action": "refresh",
        },
        ["Refresh state"],
      ),
    ]),
    statusBanner(),
    el("div", { className: "sim-grid" }, [consumerPanel(), merchantBrowser()]),
    el("footer", { className: "sim-footer" }, [
      "Browser shopping and Guardian approval are real only after this UI is deployed with the Nominee shopping worker. This build does not fake approvals, orders, or wallet charges.",
    ]),
  ]);
  wrap
    .querySelector('[data-nominee-action="refresh"]')!
    .addEventListener("click", () => void bootstrap());
  return wrap;
}

function render(): void {
  root.replaceChildren(layout());
  root.setAttribute("aria-busy", "false");
}

async function withBusy<T>(label: string, fn: () => Promise<T>): Promise<T> {
  ui.busy = label;
  render();
  try {
    return await fn();
  } finally {
    ui.busy = null;
    render();
  }
}

async function loadSession(): Promise<void> {
  const result = await shoppingApi.session();
  if (result.ok) {
    ui.session = result.data;
    setSessionCsrfToken(result.data.csrfToken);
    ui.sessionError = null;
    ui.apiAvailable = true;
  } else {
    ui.session = null;
    setSessionCsrfToken(null);
    ui.sessionError = result.error.message;
    ui.apiAvailable = result.error.status !== 404;
  }
}

async function refreshCart(): Promise<void> {
  if (!sessionVerified(ui.session)) {
    ui.cart = null;
    ui.cartError = null;
    return;
  }
  const result = await shoppingApi.cart();
  if (result.ok) {
    ui.cart = result.data.cart;
    ui.cartError = null;
  } else {
    ui.cart = null;
    ui.cartError = result.error.message;
  }
}

async function addToCart(productId: string): Promise<void> {
  if (!sessionVerified(ui.session)) return;
  await withBusy("cart-add", async () => {
    const result = await shoppingApi.addCartItem(productId, 1);
    if (result.ok) {
      ui.cart = result.data.cart;
      ui.cartError = null;
      if (ui.cart === null) {
        await refreshCart();
      }
    } else {
      ui.cartError = result.error.message;
    }
  });
}

async function requestQuote(): Promise<void> {
  await withBusy("quote", async () => {
    ui.quoteError = null;
    const result = await shoppingApi.quote();
    if (result.ok) {
      ui.quote = result.data.quote;
    } else {
      ui.quote = null;
      ui.quoteError = result.error.message;
    }
  });
}

async function startApproval(): Promise<void> {
  if (!ui.quote) return;
  await withBusy("approval", async () => {
    ui.approvalError = null;
    const result = await shoppingApi.startApproval(ui.quote!.id);
    if (result.ok) {
      ui.approval = result.data;
      await pollApproval(ui.approval.id, pollGeneration);
    } else {
      ui.approval = null;
      ui.approvalError = result.error.message;
    }
  });
}

async function pollApproval(id: string, generation: number): Promise<void> {
  if (generation !== pollGeneration) return;
  const result = await shoppingApi.approval(id);
  if (generation !== pollGeneration) return;
  if (result.ok) {
    ui.approval = result.data;
    if (result.data.status === "pending") {
      approvalPollTimer = window.setTimeout(
        () => void pollApproval(id, generation),
        POLL_MS,
      );
    }
  } else {
    ui.approvalError = result.error.message;
  }
  render();
}

async function executeOrder(): Promise<void> {
  if (!ui.quote) return;
  await withBusy("order", async () => {
    ui.orderMessage = null;
    const result = await shoppingApi.executeOrder(ui.quote!.id);
    if (result.ok) {
      const body = result.data;
      ui.orderMessage =
        body.message ??
        (body.status === "completed" && body.orderId
          ? `Order ${body.orderId} reported by the server.`
          : `Order status: ${body.status}`);
    } else {
      ui.orderMessage = result.error.message;
    }
  });
}

async function startAgent(goal: string): Promise<void> {
  await withBusy("agent", async () => {
    ui.agentError = null;
    const result = await shoppingApi.startAgent(goal);
    if (result.ok) {
      ui.agent = result.data;
      scheduleAgentPoll(result.data.id);
    } else {
      ui.agent = null;
      ui.agentError = result.error.message;
    }
  });
}

function scheduleAgentPoll(id: string): void {
  const generation = pollGeneration;
  if (agentPollTimer !== undefined) {
    window.clearTimeout(agentPollTimer);
    agentPollTimer = undefined;
  }
  void pollAgent(id, generation);
}

async function pollAgent(id: string, generation: number): Promise<void> {
  if (generation !== pollGeneration) return;
  const result = await shoppingApi.agent(id);
  if (generation !== pollGeneration) return;
  if (result.ok) {
    ui.agent = result.data;
    if (result.data.status === "running" || result.data.status === "pending") {
      agentPollTimer = window.setTimeout(
        () => void pollAgent(id, generation),
        POLL_MS,
      );
    } else {
      await refreshCart();
    }
  } else {
    ui.agentError = result.error.message;
  }
  render();
}

async function bootstrap(): Promise<void> {
  cancelPolls();
  ui.quote = null;
  ui.approval = null;
  ui.orderMessage = null;
  ui.agent = null;
  await loadSession();
  await refreshCart();
  render();
}

void bootstrap();