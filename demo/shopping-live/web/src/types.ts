export type MerchantWallet = {
  mode: "simulated" | "live";
  label: string;
};

export type SessionResponse = {
  authenticated: boolean;
  loginUrl?: string;
  logoutUrl?: string;
  customerId?: string;
  merchant?: MerchantWallet;
  agentConnected?: boolean;
  capabilities?: Record<string, boolean>;
  /** Same-origin mutation token from the Worker when signed in. */
  csrfToken?: string;
};

export type AgentEvent = {
  at: string;
  kind: string;
  message: string;
};

export type AgentRun = {
  id: string;
  status:
    | "pending"
    | "running"
    | "completed"
    | "stopped"
    | "budget_exhausted"
    | "failed"
    | "idle";
  goal?: string;
  events: AgentEvent[];
};

export type CartItem = {
  productId: string;
  quantity: number;
  name?: string;
  priceMinor?: number;
  currency?: string;
};

export type Cart = {
  id: string;
  items: CartItem[];
  version?: number;
};

export type QuoteDestination = {
  id: string;
  label: string;
  detailsJson: string;
};

export type Quote = {
  id: string;
  cartId: string;
  revision: number;
  items: CartItem[];
  subtotalMinor: number;
  taxMinor: number;
  shippingMinor: number;
  totalMinor: number;
  currency: string;
  expiresAt: string;
  verified: boolean;
  destination: QuoteDestination;
};

export type ApprovalRecord = {
  id: string;
  quoteId: string;
  status: "pending" | "approved" | "denied" | "expired" | "failed";
  /** Only when the provider returned a validated URL; CIBA push omits this. */
  reviewUrl?: string;
  failureCode?: string;
  delivery?: "guardian_push";
};

export type OrderResult = {
  status: "completed" | "processing" | "denied" | "approval_required";
  orderId?: string;
  message?: string;
};

export type ApiError = {
  code: string;
  message: string;
};
