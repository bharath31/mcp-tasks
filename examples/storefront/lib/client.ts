export type Product = { id:string; name:string; description:string; priceMinor:number; currency:string; image?:string };
export type Address = { id:string; label:string; trustedForAgentCheckout:boolean };
export type Cart = { id:string; version:number; items:{productId:string; quantity:number}[] };
export type Quote = { id:string; operationId:string; revision:number; cartId:string; items:{name:string; quantity:number; priceMinor?:number; totalMinor?:number}[]; subtotalMinor:number; taxMinor:number; shippingMinor:number; totalMinor:number; currency:string; destinationLabel?:string; shippingAddressId?:string; expiresAt:string; requirement:'agent_confirmation'|'customer_verification'|'denied' };
export type Order = { id:string; totalMinor?:number; currency?:string; status?:string };
export type Session = { mode:'fixture'|'live'; actor:{kind:string; customerId?:string; agentId?:string; scopes:string[]}; capabilities:Record<string,unknown> };
export type Completion = {status:'completed'; order:Order}|{status:'approval_required'; operation:unknown}|{status:'customer_verification_required'; reviewUrl:string}|{status:'processing'};
async function request<T>(path:string, init?:RequestInit):Promise<T> {
 const response=await fetch(`/api${path}`,{...init,cache:'no-store',headers:{'Content-Type':'application/json',...init?.headers}});
 let data: any; try { data=await response.json(); } catch { throw new Error('The shopping service is unavailable or returned an invalid response.'); }
 if(!response.ok) throw new Error(data?.message || data?.error?.message || 'The shopping service could not complete this request.');
 return data as T;
}
export const api={
 catalog:()=>request<{products:Product[]}>('/catalog'), session:()=>request<Session>('/session'),
 addresses:()=>request<{addresses:Address[]}>('/addresses'),
 linkCart:(id:string)=>request<{cart:Cart}>(`/carts/${encodeURIComponent(id)}/link`,{method:'POST'}),
 createCart:()=>request<{cart:Cart}>('/carts',{method:'POST'}), cart:(id:string)=>request<{cart:Cart}>(`/carts/${encodeURIComponent(id)}`),
 items:(id:string,items:Cart['items'])=>request<{cart:Cart}>(`/carts/${encodeURIComponent(id)}/items`,{method:'PUT',body:JSON.stringify({items})}),
 quote:(id:string,shippingAddressId:string)=>request<{quote:Quote}>(`/carts/${encodeURIComponent(id)}/quote`,{method:'POST',body:JSON.stringify({shippingAddressId})}),
 checkout:(id:string)=>request<{quote:Quote; status?:string}>(`/checkouts/${encodeURIComponent(id)}`),
 complete:(id:string,key:string)=>request<Completion>(`/checkouts/${encodeURIComponent(id)}/complete`,{method:'POST',headers:{'Idempotency-Key':key}}),
 approve:(id:string)=>request<unknown>(`/checkouts/${encodeURIComponent(id)}/approve`,{method:'POST'}),
 orders:()=>request<{orders:Order[]}>('/orders')
};
