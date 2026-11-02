// Fga backed by a Postgres tuple table, scoped to one tenant generation.
import type { Fga } from "../../../auth0/service/src/fga.js";
import type { Db } from "../../../auth0/service/src/store.js";

export class PgFga implements Fga {
  constructor(
    private db: Db,
    private tenantId: string,
  ) {}
  async check(user: string, relation: string, object: string) {
    const r = await this.db.query(
      "select 1 from policy_desk.fga_tuples where tenant_id=$1 and subject=$2 and relation=$3 and object=$4",
      [this.tenantId, user, relation, object],
    );
    return (r.rowCount ?? 0) > 0;
  }
}
