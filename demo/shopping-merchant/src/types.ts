/** Values MUST originate from a trusted verifier on every host call, never from client JSON. */
export type HumanActor = {
  kind: "human";
  customerId: string;
  scopes: string[];
};

export type AgentActor = {
  kind: "agent";
  customerId?: string;
  agentId: string;
  pairwiseUserId: string;
  sessionId: string;
  scopes: string[];
};

export type TrustedActor = HumanActor | AgentActor;

export type CatalogProduct = {
  id: string;
  name: string;
  description: string;
  priceMinor: number;
  currency: "USD";
};

export type CartItem = {
  productId: string;
  quantity: number;
  priceMinor: number;
  currency: "USD";
};

export type Cart = {
  id: string;
  version: number;
  items: CartItem[];
};

export type TrustedDestination = {
  id: string;
  customerId: string;
  label: string;
  version: string;
  trustedForAgentCheckout: boolean;
  destination: Record<string, unknown>;
};

export type QuoteItemSnapshot = {
  productId: string;
  name: string;
  quantity: number;
  priceMinor: number;
  currency: "USD";
};

export type Quote = {
  id: string;
  operationId: string;
  revision: number;
  cartId: string;
  cartVersion: number;
  customerId: string;
  agentId: string | null;
  items: QuoteItemSnapshot[];
  subtotalMinor: number;
  taxMinor: number;
  shippingMinor: number;
  totalMinor: number;
  currency: "USD";
  destination: TrustedDestination;
  expiresAt: string;
  requirement: "customer_verification";
};

export type OrderSnapshot = {
  id: string;
  customerId: string;
  operationId: string;
  quoteId: string;
  totalMinor: number;
  currency: "USD";
};

export type CompletionResult =
  | { status: "completed"; order: OrderSnapshot }
  | { status: "customer_verification_required" }
  | { status: "processing" }
  | { status: "denied" }
  | { status: "abandoned" }
  | { status: "provider_confirmed_absent" };

export type CustomerAccountPort = {
  getAddress(
    customerId: string,
    addressId: string,
  ): Promise<TrustedDestination | null>;
};

/** Simulated payment provider only; never initiates real charges. */
export type OrderProviderPort = {
  place(input: {
    quote: Quote;
    idempotencyKey: string;
  }): Promise<{ id: string } | null>;
  reconcile(input: {
    quote: Quote;
    idempotencyKey: string;
  }): Promise<{ id: string; status?: "absent" } | null>;
};

/**
 * Trusted host port: injects verified customer approval for an exact quote revision.
 * There is no public HTTP "approve" route; the worker must call this after independent proof.
 */
export type CustomerApprovalVerifier = (input: {
  actor: HumanActor;
  quote: Quote;
}) => Promise<boolean>;

export type MerchantLedgerPorts = {
  customerAccount: CustomerAccountPort;
  verifyCustomerApproval: CustomerApprovalVerifier;
  orderProvider: OrderProviderPort;
};
