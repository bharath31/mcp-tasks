/** Minimal Worker/DO shapes for typecheck without bundling workers-types in this package. */
declare module "cloudflare:workers" {
  export class DurableObject<Env = unknown> {
    protected ctx: DurableObjectState;
    protected env: Env;
    constructor(ctx: DurableObjectState, env: Env);
  }
}

interface DurableObjectStorage {
  readonly sql: SqlStorage;
  transactionSync<T>(closure: () => T): T;
  get<T = unknown>(key: string): T | undefined;
  put<T>(key: string, value: T): void;
}

interface DurableObjectState {
  readonly storage: DurableObjectStorage;
}

interface DurableObjectId {
  toString(): string;
}

interface DurableObjectStub {
  fetch(input: RequestInfo, init?: RequestInit): Promise<Response>;
}

interface DurableObjectNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): DurableObjectStub;
}

interface SqlStorage {
  exec<T = Record<string, unknown>>(
    query: string,
    ...bindings: unknown[]
  ): SqlStorageCursor<T>;
}

interface SqlStorageCursor<T> extends Iterable<T> {
  one(): T;
}
