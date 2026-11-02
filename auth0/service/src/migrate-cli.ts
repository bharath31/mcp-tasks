import { Store } from "./store.js";

const url = process.env.TASK_AUTHORITY_DATABASE_URL;
if (!url) throw new Error("TASK_AUTHORITY_DATABASE_URL required");
const store = new Store(url, 1);
await store.migrate();
await store.close();
console.log("task-authority migrations applied");
