import type { Cart, Quote as MerchantQuote } from "../../../shopping-merchant/src/types.js";
import { hostCatalogProduct } from "./catalog.js";
import { customerStateRpc, customerStateStub } from "./customer-state-do.js";
import { merchantLedgerRpc } from "./merchant-client.js";
import { browserShoppingActor } from "./actor.js";
import type { ShoppingLiveEnv } from "./env.js";
import type { AuthenticatedCustomer } from "./session.js";

export type ClientCartItem = {
  productId: string;
  quantity: number;
  name?: string;
  priceMinor?: number;
  currency?: string;
};

export type ClientCart = {
  id: string;
  items: ClientCartItem[];
  version?: number;
};

export type ClientQuote = {
  id: string;
  cartId: string;
  revision: number;
  items: ClientCartItem[];
  subtotalMinor: number;
  taxMinor: number;
  shippingMinor: number;
  totalMinor: number;
  currency: string;
  expiresAt: string;
  verified: boolean;
};

function enrichCart(cart: Cart): ClientCart {
  return {
    id: cart.id,
    version: cart.version,
    items: cart.items.map((item) => {
      const product = hostCatalogProduct(item.productId);
      return {
        productId: item.productId,
        quantity: item.quantity,
        name: product?.name,
        priceMinor: item.priceMinor,
        currency: item.currency,
      };
    }),
  };
}

async function browserSessionId(
  env: ShoppingLiveEnv,
  customerId: string,
): Promise<string> {
  const stub = customerStateStub(env, customerId);
  const res = await customerStateRpc(stub, customerId, {
    op: "getBrowserSessionId",
  });
  const body = (await res.json()) as { browserSessionId?: string };
  if (!body.browserSessionId) throw new Error("browser_session_missing");
  return body.browserSessionId;
}

async function ensureCart(
  env: ShoppingLiveEnv,
  customer: AuthenticatedCustomer,
): Promise<string> {
  const stub = customerStateStub(env, customer.customerId);
  const existing = await customerStateRpc(stub, customer.customerId, {
    op: "getCartId",
  });
  const existingBody = (await existing.json()) as { cartId?: string | null };
  if (existingBody.cartId) return existingBody.cartId;

  const browserSession = await browserSessionId(env, customer.customerId);
  const actor = browserShoppingActor(env, customer.customerId, browserSession);
  const created = await merchantLedgerRpc(env, customer.customerId, {
    op: "createCart",
    actor,
  });
  if (!created.ok) {
    const err = await created.json().catch(() => ({}));
    throw new Error(
      (err as { error?: string }).error ?? "merchant_create_cart_failed",
    );
  }
  const cart = (await created.json()) as Cart;
  await customerStateRpc(stub, customer.customerId, {
    op: "setCartId",
    cartId: cart.id,
  });
  return cart.id;
}

export async function readCustomerCart(
  env: ShoppingLiveEnv,
  customer: AuthenticatedCustomer,
): Promise<ClientCart | null> {
  const stub = customerStateStub(env, customer.customerId);
  const cartRes = await customerStateRpc(stub, customer.customerId, {
    op: "getCartId",
  });
  const { cartId } = (await cartRes.json()) as { cartId?: string | null };
  if (!cartId) return null;

  const browserSession = await browserSessionId(env, customer.customerId);
  const actor = browserShoppingActor(env, customer.customerId, browserSession);
  const read = await merchantLedgerRpc(env, customer.customerId, {
    op: "readCart",
    actor,
    cartId,
  });
  if (!read.ok) return null;
  const cart = (await read.json()) as Cart;
  return enrichCart(cart);
}

export async function addCartItem(
  env: ShoppingLiveEnv,
  customer: AuthenticatedCustomer,
  productId: string,
  quantity: number,
): Promise<ClientCart> {
  const product = hostCatalogProduct(productId);
  if (
    !product ||
    !Number.isSafeInteger(quantity) ||
    quantity < 1 ||
    quantity > 100
  ) {
    throw new Error("invalid_item");
  }

  const cartId = await ensureCart(env, customer);
  const browserSession = await browserSessionId(env, customer.customerId);
  const actor = browserShoppingActor(env, customer.customerId, browserSession);

  const current = await merchantLedgerRpc(env, customer.customerId, {
    op: "readCart",
    actor,
    cartId,
  });
  if (!current.ok) throw new Error("cart_read_failed");
  const cart = (await current.json()) as Cart;
  const items = [...cart.items];
  const idx = items.findIndex((i) => i.productId === productId);
  if (idx >= 0) items[idx] = { ...items[idx], quantity: items[idx].quantity + quantity };
  else {
    items.push({
      productId: product.id,
      quantity,
      priceMinor: product.priceMinor,
      currency: product.currency,
    });
  }

  const updated = await merchantLedgerRpc(env, customer.customerId, {
    op: "updateCart",
    actor,
    cartId,
    items,
  });
  if (!updated.ok) {
    const err = (await updated.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? "cart_update_failed");
  }
  return enrichCart((await updated.json()) as Cart);
}

export async function createCustomerQuote(
  env: ShoppingLiveEnv,
  customer: AuthenticatedCustomer,
): Promise<ClientQuote> {
  const addressId = env.SHOPPING_MERCHANT_SHIPPING_ADDRESS_ID?.trim();
  if (!addressId) throw new Error("shipping_unconfigured");

  const cartId = await ensureCart(env, customer);
  const browserSession = await browserSessionId(env, customer.customerId);
  const actor = browserShoppingActor(env, customer.customerId, browserSession);
  const quoteRes = await merchantLedgerRpc(env, customer.customerId, {
    op: "createQuote",
    actor,
    cartId,
    shippingAddressId: addressId,
  });
  if (!quoteRes.ok) {
    const err = (await quoteRes.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? "quote_failed");
  }
  const quote = (await quoteRes.json()) as MerchantQuote;
  return {
    id: quote.id,
    cartId: quote.cartId,
    revision: quote.revision,
    items: quote.items.map((item) => ({
      productId: item.productId,
      quantity: item.quantity,
      name: item.name,
      priceMinor: item.priceMinor,
      currency: item.currency,
    })),
    subtotalMinor: quote.subtotalMinor,
    taxMinor: quote.taxMinor,
    shippingMinor: quote.shippingMinor,
    totalMinor: quote.totalMinor,
    currency: quote.currency,
    expiresAt: quote.expiresAt,
    verified: true,
  };
}