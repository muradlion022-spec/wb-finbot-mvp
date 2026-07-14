import assert from "node:assert/strict";
import { createServer } from "node:http";

const server = createServer((request, response) => {
  assert.equal(request.headers.authorization, "promotion-test-token");
  response.setHeader("Content-Type", "application/json");
  if (request.url === "/adv/v1/promotion/count") {
    response.end(JSON.stringify({ adverts: [{ status: 9, advert_list: [{ advertId: 101 }, { advertId: 202 }] }] }));
    return;
  }
  if (request.url?.startsWith("/adv/v3/fullstats?")) {
    const url = new URL(request.url, "http://127.0.0.1");
    assert.equal(url.searchParams.get("ids"), "101,202");
    assert.equal(url.searchParams.get("beginDate"), "2026-07-01");
    assert.equal(url.searchParams.get("endDate"), "2026-07-02");
    response.end(
      JSON.stringify([
        {
          advertId: 101,
          days: [
            {
              date: "2026-07-01T00:00:00Z",
              apps: [
                { appType: 1, nms: [{ nmId: 111, sum: 10.25 }] },
                { appType: 32, nms: [{ nmId: 111, sum: 20.5 }, { nmId: 222, sum: 4.25 }] }
              ]
            }
          ]
        },
        {
          advertId: 202,
          days: [{ date: "2026-07-02T00:00:00Z", apps: [{ appType: 64, nms: [{ nmId: 111, sum: 5 }] }] }]
        }
      ])
    );
    return;
  }
  response.statusCode = 404;
  response.end(JSON.stringify({ error: "not found" }));
});

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert.ok(address && typeof address === "object");
process.env.NODE_ENV = "development";
process.env.ENCRYPTION_SECRET = "promotion-smoke-secret-32-characters";
process.env.WB_PROMOTION_API_BASE_URL = `http://127.0.0.1:${address.port}`;

try {
  const [{ encryptSecret }, { WbClient }] = await Promise.all([import("../src/server/crypto.js"), import("../src/server/wbClient.js")]);
  const result = await new WbClient(encryptSecret("promotion-test-token")).getPromotionSpend("2026-07-01", "2026-07-02");
  assert.equal(result.partial, false);
  assert.deepEqual(
    result.rows.toSorted((left, right) => `${left.date}:${left.nmId}`.localeCompare(`${right.date}:${right.nmId}`)),
    [
      { date: "2026-07-01", nmId: 111, amount: 30.75 },
      { date: "2026-07-01", nmId: 222, amount: 4.25 },
      { date: "2026-07-02", nmId: 111, amount: 5 }
    ]
  );
  console.log("promotion smoke: spend grouped by date and nmId");
} finally {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}
