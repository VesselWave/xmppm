import { describe, expect, it } from "bun:test";
import { consumeRateLimit, rateLimitKey } from "../../apps/worker/db";

describe("rate limit helpers", () => {
  it("creates stable key from ip only so user-agent rotation cannot shard buckets", async () => {
    const one = await rateLimitKey("1.2.3.4", "browser-a");
    const two = await rateLimitKey("1.2.3.4", "browser-b");
    expect(one).toBe(two);
  });

  it("consumes rate limits with one upsert so concurrent requests share a bucket", async () => {
    const sqls: string[] = [];
    const fakeDb = {
      prepare: (sql: string) => {
        sqls.push(sql);
        return {
          bind: () => ({
            first: async () => ({ count: 2 }),
          }),
        };
      },
    };

    const allowed = await consumeRateLimit(fakeDb as never, "k", 101, 3600, 3);

    expect(allowed).toBe(true);
    expect(sqls).toHaveLength(1);
    expect(sqls[0]).toContain("ON CONFLICT(key) DO UPDATE");
    expect(sqls[0]).toContain("RETURNING count");
  });
});
