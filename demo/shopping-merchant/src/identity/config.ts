/** Worker env keys for Auth0-backed shopping customer identity (unwired until bound). */
export type ShoppingIdentityEnv = {
  SHOPPING_AUTH0_DOMAIN: string;
  SHOPPING_API_AUDIENCE: string;
};

export const SHOPPING_CUSTOMER_SCOPE = "shopping:customer";

export const shoppingIssuer = (domain: string) =>
  `https://${domain.replace(/\/+$/, "")}/`;

export function shoppingIdentityConfigured(
  env: Partial<ShoppingIdentityEnv>,
): env is ShoppingIdentityEnv {
  const domain = env.SHOPPING_AUTH0_DOMAIN?.trim();
  const audience = env.SHOPPING_API_AUDIENCE?.trim();
  return Boolean(domain && audience);
}

export function requireShoppingIdentity(
  env: Partial<ShoppingIdentityEnv>,
): ShoppingIdentityEnv {
  if (!shoppingIdentityConfigured(env)) {
    throw new Error("shopping_identity_unconfigured");
  }
  return env;
}
