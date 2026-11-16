"use client";
import { useEffect, useState } from "react";
import {
  api,
  type Product,
  type Cart,
  type Quote,
  type Session,
  type Order,
  type Completion,
  type Address,
} from "../lib/client";
const samples: Product[] = [
  {
    id: "tray",
    name: "Catchall tray",
    description: "A quiet place for the things you reach for.",
    priceMinor: 2400,
    currency: "USD",
    image: "/tray.svg",
  },
  {
    id: "cup",
    name: "Pencil cup",
    description: "A little order for your desk.",
    priceMinor: 1800,
    currency: "USD",
    image: "/cup.svg",
  },
  {
    id: "book",
    name: "Daily notebook",
    description: "Blank pages for plans and loose thoughts.",
    priceMinor: 1600,
    currency: "USD",
    image: "/book.svg",
  },
  {
    id: "weight",
    name: "Paper weight",
    description: "Keep the important page in place.",
    priceMinor: 3200,
    currency: "USD",
    image: "/weight.svg",
  },
];
const money = (n: number, c = "USD") =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: c }).format(
    n / 100,
  );
export default function Shop() {
  const [products, setProducts] = useState<Product[]>([]),
    [session, setSession] = useState<Session | null>(null),
    [cart, setCart] = useState<Cart | null>(null),
    [quote, setQuote] = useState<Quote | null>(null),
    [result, setResult] = useState<Completion | null>(null),
    [orders, setOrders] = useState<Order[] | null>(null),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [address, setAddress] = useState(""),
    [addresses, setAddresses] = useState<Address[]>([]),
    [addressMessage, setAddressMessage] = useState(
      "Load your saved addresses to review a quote.",
    ),
    [scenario, setScenario] = useState("ordinary"),
    [key, setKey] = useState("");
  const [fixture, setFixture] = useState(false);
  useEffect(() => {
    if (new URLSearchParams(location.search).get("view") === "fixture") {
      setFixture(true);
      setProducts(samples);
      setLoading(false);
      return;
    }
    api
      .catalog()
      .then((c) => setProducts(c.products))
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
    api
      .session()
      .then(setSession)
      .catch(() => {});
  }, []);
  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed.");
    } finally {
      setBusy(false);
    }
  }
  async function add(p: Product) {
    if (fixture) return;
    await run(async () => {
      const c = cart ?? (await api.createCart()).cart;
      const items = [...c.items];
      const i = items.findIndex((x) => x.productId === p.id);
      if (i < 0) items.push({ productId: p.id, quantity: 1 });
      else items[i] = { ...items[i], quantity: items[i].quantity + 1 };
      setCart((await api.items(c.id, items)).cart);
      setQuote(null);
      setResult(null);
    });
  }
  async function change(id: string, n: number) {
    if (!cart) return;
    await run(async () => {
      setCart(
        (
          await api.items(
            cart.id,
            cart.items
              .map((x) => (x.productId === id ? { ...x, quantity: n } : x))
              .filter((x) => x.quantity > 0),
          )
        ).cart,
      );
      setQuote(null);
      setResult(null);
    });
  }
  async function loadAddresses() {
    await run(async () => {
      const result = await api.addresses();
      setAddresses(result.addresses);
      setAddress("");
      setQuote(null);
      setResult(null);
      setAddressMessage(
        result.addresses.length
          ? "Choose an address for this quote."
          : "No saved addresses are available for this account.",
      );
    });
  }
  async function getQuote() {
    if (!cart) return;
    await run(async () => {
      setQuote((await api.quote(cart.id, address)).quote);
      setResult(null);
      setKey(crypto.randomUUID());
    });
  }
  async function grant() {
    await run(async () => {
      await api.fixtureTransition("grant");
      if (cart) setCart((await api.linkCart(cart.id)).cart);
      setSession(await api.session());
    });
  }
  async function resumeAgent() {
    await run(async () => {
      await api.fixtureTransition("agent");
      setSession(await api.session());
    });
  }
  async function confirmFixture() {
    if (!quote) return;
    await run(async () => {
      await api.fixtureConfirm(quote.id);
      setResult(null);
    });
  }
  async function complete() {
    if (!quote) return;
    await run(async () => setResult(await api.complete(quote.id, key)));
  }
  return (
    <>
      <div className="notice">
        {fixture
          ? "Fixture presentation · sample identity and simulated purchases · no orders are placed"
          : session?.mode === "fixture"
            ? "Fixture identity · purchases are simulated"
            : "Reference storefront · live commerce connection required"}
      </div>
      <header>
        <a className="logo" href="#top">
          stillroom<span> supply</span>
        </a>
        <nav>
          <a href="#shop">Shop</a>
          <a href="#cart">Your cart</a>
          <a href="#orders">Orders</a>
        </nav>
      </header>
      <main id="top">
        <section className="intro">
          <div>
            <p className="overline">Objects for the working day</p>
            <h1>
              Make room
              <br />
              for good work.
            </h1>
            <p>Thoughtful little things for the place where ideas happen.</p>
            <a className="button" href="#shop">
              Explore the collection
            </a>
          </div>
          <div className="intro-art">
            <img src="/tray.svg" alt="Illustration of a desk tray" />
            <p>
              Stillroom Supply
              <br />A collection for your desk
            </p>
          </div>
        </section>
        <section id="shop" className="shop">
          <div className="section-title">
            <h2>The collection</h2>
            <p>Everyday tools, ready for your desk.</p>
          </div>
          {loading ? (
            <p>Loading the collection…</p>
          ) : error && !products.length ? (
            <p role="alert">
              {error} Connect the commerce API to browse, or{" "}
              <a href="?view=fixture">open the fixture presentation</a>.
            </p>
          ) : (
            <div className="grid">
              {products.map((p, i) => (
                <article key={p.id}>
                  <div className={"product-image tone" + (i % 4)}>
                    {p.image ? (
                      <img src={p.image} alt="" />
                    ) : (
                      <span>Stillroom Supply</span>
                    )}
                  </div>
                  <div className="product-heading">
                    <h3>{p.name}</h3>
                    <b>{money(p.priceMinor, p.currency)}</b>
                  </div>
                  <p>{p.description}</p>
                  <button
                    disabled={busy || fixture || !session}
                    onClick={() => add(p)}
                  >
                    {fixture ? "Available when connected" : "Add to cart"}
                  </button>
                </article>
              ))}
            </div>
          )}
        </section>
        <section className="workspace" id="cart">
          <div>
            <h2>Your cart</h2>
            {!cart?.items.length ? (
              <p>
                Your cart is empty. Add something from the collection to begin.
              </p>
            ) : (
              <ul className="cart-list">
                {cart.items.map((item) => {
                  const p = products.find((p) => p.id === item.productId);
                  return (
                    <li key={item.productId}>
                      <span>
                        {p?.name ?? item.productId}{" "}
                        {p && money(p.priceMinor, p.currency)}
                      </span>
                      <div>
                        <button
                          aria-label={`Remove one ${p?.name ?? item.productId}`}
                          disabled={busy}
                          onClick={() =>
                            change(item.productId, item.quantity - 1)
                          }
                        >
                          −
                        </button>{" "}
                        <span>{item.quantity}</span>{" "}
                        <button
                          aria-label={`Add one ${p?.name ?? item.productId}`}
                          disabled={busy}
                          onClick={() =>
                            change(item.productId, item.quantity + 1)
                          }
                        >
                          +
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
            <button disabled={busy || fixture} onClick={loadAddresses}>
              Load saved addresses
            </button>
            <label htmlFor="address">Shipping address</label>
            <select
              id="address"
              value={address}
              onChange={(e) => {
                setAddress(e.target.value);
                setQuote(null);
                setResult(null);
              }}
            >
              <option value="">Choose an address</option>
              {addresses.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.label}
                </option>
              ))}
            </select>
            <p className="hint">
              {addressMessage} The server determines the destination and price.
            </p>
            <button
              disabled={!cart?.items.length || busy || !address}
              onClick={getQuote}
            >
              Review quote
            </button>
          </div>
          <aside>
            <h2>Personal agent simulator</h2>
            {session?.mode === "fixture" && (
              <>
                <p>Local fixture only: no real identity, proof or payment.</p>
                {!session.actor.customerId && (
                  <button disabled={busy} onClick={grant}>
                    Grant fixture account access
                  </button>
                )}
                {session.actor.customerId && (
                  <button disabled={busy} onClick={resumeAgent}>
                    Resume fixture agent
                  </button>
                )}
              </>
            )}
            <p>
              This panel simulates a customer’s choices. It is not a connected
              personal agent and does not prove customer presence.
            </p>
            <label htmlFor="scenario">Scenario</label>
            <select
              id="scenario"
              value={scenario}
              onChange={(e) => setScenario(e.target.value)}
            >
              <option value="ordinary">Ordinary saved-address order</option>
              <option value="review">
                Higher value or changed destination
              </option>
              <option value="change">Changed quote, fresh approval</option>
              <option value="retry">Retry the same order</option>
            </select>
            <p>
              {
                (
                  {
                    ordinary:
                      "Build a cart up to $50 and request a quote for a saved address.",
                    review:
                      "Add more items or choose a different saved address, then request a quote.",
                    change:
                      "After a review, change the cart or destination and request a new quote.",
                    retry:
                      "After completion, use Retry completion to send the same idempotency key.",
                  } as Record<string, string>
                )[scenario]
              }
            </p>
            <p className="hint">
              The service decides the policy; this selection does not override
              it.
            </p>
          </aside>
        </section>
        {quote && (
          <section className="review">
            <h2>Review your quote</h2>
            <p>
              Revision {quote.revision} · expires{" "}
              {new Date(quote.expiresAt).toLocaleString()}
            </p>
            <ul>
              {quote.items?.map((item, i) => (
                <li key={i}>
                  {item.name} × {item.quantity}{" "}
                  {item.totalMinor != null
                    ? money(item.totalMinor, quote.currency)
                    : item.priceMinor != null
                      ? money(item.priceMinor, quote.currency)
                      : ""}
                </li>
              ))}
            </ul>
            <dl>
              <div>
                <dt>Subtotal</dt>
                <dd>{money(quote.subtotalMinor, quote.currency)}</dd>
              </div>
              <div>
                <dt>Tax</dt>
                <dd>{money(quote.taxMinor, quote.currency)}</dd>
              </div>
              <div>
                <dt>Shipping</dt>
                <dd>{money(quote.shippingMinor, quote.currency)}</dd>
              </div>
              <div>
                <dt>Total</dt>
                <dd>{money(quote.totalMinor, quote.currency)}</dd>
              </div>
            </dl>
            <p>
              Destination:{" "}
              {quote.destinationLabel ??
                quote.shippingAddressId ??
                "See your account"}
            </p>
            <p>Decision required: {quote.requirement.replaceAll("_", " ")}</p>
            <button
              disabled={busy || quote.requirement === "denied"}
              onClick={complete}
            >
              Complete checkout
            </button>
            {result?.status === "customer_verification_required" && (
              <p>
                Customer review is required.{" "}
                <a href={result.reviewUrl} target="_blank" rel="noreferrer">
                  Open the merchant’s review page
                </a>
                .
              </p>
            )}
            {result?.status === "approval_required" && (
              <p>
                Fixture agent confirmation is simulated, not protocol proof.
                {session?.mode === "fixture" && (
                  <button disabled={busy} onClick={confirmFixture}>
                    Confirm exact fixture quote
                  </button>
                )}
              </p>
            )}
            {result?.status === "processing" && (
              <p>
                Processing. The outcome is not yet known; check again before
                making another purchase.
              </p>
            )}
            {result?.status === "completed" && (
              <div>
                <h3>Order completed</h3>
                <p>
                  Order {result.order.id}
                  {result.order.totalMinor != null &&
                    ` · ${money(result.order.totalMinor, result.order.currency)}`}
                </p>
                <button disabled={busy} onClick={complete}>
                  Retry completion
                </button>
              </div>
            )}
          </section>
        )}
        <section id="orders" className="orders">
          <h2>Your orders</h2>
          <p>See orders associated with your signed-in customer account.</p>
          <button
            disabled={busy || fixture}
            onClick={() =>
              run(async () => setOrders((await api.orders()).orders))
            }
          >
            Load order history
          </button>
          {orders &&
            (!orders.length ? (
              <p>No orders yet.</p>
            ) : (
              <ul>
                {orders.map((o) => (
                  <li key={o.id}>
                    Order {o.id} · {o.status ?? "Recorded"}{" "}
                    {o.totalMinor != null && money(o.totalMinor, o.currency)}
                  </li>
                ))}
              </ul>
            ))}
        </section>
        {error && products.length > 0 && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <details className="developer">
          <summary>Developer activity</summary>
          <p>
            Actor: {session?.actor.kind ?? "not connected"} · Customer:{" "}
            {session?.actor.customerId ?? "none"} · Agent:{" "}
            {session?.actor.agentId ?? "none"}
          </p>
          <p>
            Scopes: {session?.actor.scopes.join(", ") || "none"}. Capabilities:{" "}
            {session ? JSON.stringify(session.capabilities) : "unavailable"}.
          </p>
          <p>
            Quote revision: {quote?.revision ?? "none"}. A customer review must
            be verified by the merchant, not an agent browser. Agent
            confirmation is an agent assertion.
          </p>
        </details>
      </main>
      <footer>
        <strong>stillroom supply</strong>
        <p>
          A fictional shop for an Action Authority reference example. Product
          artwork is illustrative.
        </p>
      </footer>
    </>
  );
}
