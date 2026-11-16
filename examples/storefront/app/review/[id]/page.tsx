"use client";
import { use, useEffect, useState } from "react";
import { api, type Quote, type Session } from "../../../lib/client";
export default function Review({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const [quote, setQuote] = useState<Quote | null>(null),
    [session, setSession] = useState<Session | null>(null),
    [message, setMessage] = useState("Loading review…");
  useEffect(() => {
    Promise.all([api.checkout(id), api.session()])
      .then(([q, s]) => {
        setQuote(q.quote);
        setSession(s);
        setMessage("");
      })
      .catch((e) => setMessage(e.message));
  }, [id]);
  async function becomeHuman() {
    try {
      await api.fixtureTransition("human");
      setSession(await api.session());
      setMessage(
        "Fixture customer selected; this is not identity verification.",
      );
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Transition failed.");
    }
  }
  async function approve() {
    try {
      await api.approve(id);
      setMessage("Review recorded. Return to checkout to complete the order.");
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Review failed.");
    }
  }
  return (
    <main className="review-page">
      <a href="/">← Back to shop</a>
      <h1>Review your purchase</h1>
      <p>
        This page is for the customer, not an agent-controlled browser. The
        merchant must verify the customer and the exact quote before recording
        approval.
      </p>
      {quote && (
        <>
          <p>
            Revision {quote.revision} · expires{" "}
            {new Date(quote.expiresAt).toLocaleString()}
          </p>
          <ul>
            {quote.items?.map((item, i) => (
              <li key={i}>
                {item.name} × {item.quantity}
              </li>
            ))}
          </ul>
          <p>
            Destination:{" "}
            {quote.destinationLabel ??
              quote.shippingAddressId ??
              "See your account"}
          </p>
          <p>
            Subtotal {quote.subtotalMinor} · tax {quote.taxMinor} · shipping{" "}
            {quote.shippingMinor} · total {quote.totalMinor} {quote.currency}{" "}
            minor units
          </p>
          {session?.mode === "fixture" &&
            session.actor.kind === "agent" &&
            session.actor.customerId && (
              <button onClick={becomeHuman}>
                Switch to fixture customer (simulated)
              </button>
            )}
          {session?.mode === "fixture" &&
          session.actor.kind === "human" &&
          session.capabilities.directCustomerVerification === true ? (
            <button onClick={approve}>
              {session.mode === "fixture"
                ? "Record fixture review (simulated)"
                : "Verify and approve"}
            </button>
          ) : (
            <p>
              Customer verification is not connected in this example. A merchant
              must integrate its own verification ceremony; an agent session
              cannot approve.
            </p>
          )}
        </>
      )}
      {message && <p role="status">{message}</p>}
    </main>
  );
}
