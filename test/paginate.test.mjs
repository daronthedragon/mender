import { eq, ok, section } from "./harness.mjs";
import { createServer } from "node:http";
import { runCheck } from "../dist/repair.js";
import { authHeaders, AuthError, fetchPages } from "../dist/fetch.js";

section("pagination and auth");

const card = (name, price) =>
  `<div class="pricing-card"><h3 class="plan-title">${name}</h3><p class="amount">$${price}</p>` +
  `<ul><li>a<li>b<li>c</ul></div>`;

const listing = (names, next) =>
  `<!doctype html><html><body><main><section class="pricing-grid">` +
  names.map((n, i) => card(n, 10 + i)).join("") +
  `</section>${next ? `<a class="next" href="${next}">Next</a>` : ""}</main></body></html>`;

const seenHeaders = [];

const server = createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  seenHeaders.push({ path: url.pathname + url.search, headers: req.headers });
  const send = (html, status = 200) => {
    res.writeHead(status, { "content-type": "text/html" });
    res.end(html);
  };

  switch (url.pathname) {
    case "/p1": return send(listing(["A", "B", "C"], "/p2"));
    case "/p2": return send(listing(["D", "E", "F"], "/p3"));
    case "/p3": return send(listing(["G", "H", "I"], null));
    case "/loop": return send(listing(["A", "B", "C"], "/loop"));
    case "/relative": return send(listing(["A", "B", "C"], "p2"));
    case "/broken1": return send(listing(["A", "B", "C"], "/broken2"));
    case "/broken2": return send("<html><body>server error</body></html>", 500);
    case "/t": {
      const p = Number(url.searchParams.get("page") ?? "1");
      return send(listing([`P${p}a`, `P${p}b`, `P${p}c`], null));
    }
    case "/secure": {
      if (req.headers["authorization"] === "Bearer s3cret" || req.headers["cookie"] === "session=abc") {
        return send(listing(["A", "B", "C"], null));
      }
      return send("<html><body><h1>Unauthorized</h1></body></html>", 401);
    }
    default: return send("<html><body><h1>Not Found</h1></body></html>", 404);
  }
});

await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

const specFor = (path, extra = {}) => ({
  name: "paged",
  url: `${base}${path}`,
  row: ".pricing-card",
  fields: {
    plan: { selector: ".plan-title", type: "string" },
    price: { selector: ".amount", type: "number", min: 1 },
  },
  expect: { rows: { min: 2, max: 30 } },
  ...extra,
});

/* ---- following next links ---- */
{
  const res = await runCheck(specFor("/p1", { paginate: { next: "a.next", maxPages: 5 } }));
  eq(res.pages.length, 3, "it follows next links until they run out");
  eq(res.rows.length, 9, "rows accumulate across every page");
  eq(res.rows[0].plan, "A", "first page first");
  eq(res.rows[8].plan, "I", "last page last");
  eq(res.cause, "OK", "the contract is judged over the accumulated rows");
}

{
  const res = await runCheck(specFor("/p1", { paginate: { next: "a.next", maxPages: 2 } }));
  eq(res.pages.length, 2, "maxPages is a hard cap");
  eq(res.rows.length, 6, "and stops the accumulation there");
}

{
  // A page that links to itself must not spin forever.
  const res = await runCheck(specFor("/loop", { paginate: { next: "a.next", maxPages: 50 } }));
  eq(res.pages.length, 1, "a self-referencing next link is not followed twice");
}

{
  const res = await runCheck(specFor("/relative", { paginate: { next: "a.next", maxPages: 5 } }));
  eq(res.pages.length, 3, "relative next hrefs resolve against the page url");
}

{
  const res = await runCheck(specFor("/broken1", { paginate: { next: "a.next", maxPages: 5 } }));
  eq(res.pages.length, 2, "pagination stops at a failing page");
  eq(res.pages[1].status, 500, "and the failure is recorded");
  eq(res.rows.length, 3, "only the good page contributed rows");
}

{
  const res = await runCheck(
    specFor("/t?page=1", { paginate: { urlTemplate: `${base}/t?page={page}`, maxPages: 3 } }),
  );
  eq(res.pages.length, 3, "urlTemplate mode fetches the numbered pages");
  eq(res.rows.length, 9, "and accumulates their rows");
  eq(res.rows[3].plan, "P2a", "in page order");
}

{
  const res = await runCheck(specFor("/p1"));
  eq(res.pages.length, 1, "without a paginate block only one page is fetched");
  eq(res.rows.length, 3, "and only its rows are used");
}

/* ---- auth ---- */
eq(Object.keys(authHeaders(undefined)).length, 0, "no auth block means no extra headers");

{
  const env = { TOKEN: "s3cret", COOKIE: "session=abc", U: "user", P: "pass" };
  eq(
    authHeaders({ headerEnv: { Authorization: "TOKEN" } }, env).authorization,
    "s3cret",
    "header values come from the named environment variable",
  );
  eq(authHeaders({ cookieEnv: "COOKIE" }, env).cookie, "session=abc", "cookie header from env");
  eq(
    authHeaders({ basicEnv: { user: "U", pass: "P" } }, env).authorization,
    "Basic " + Buffer.from("user:pass").toString("base64"),
    "basic auth is encoded correctly",
  );

  let threw = null;
  try {
    authHeaders({ headerEnv: { Authorization: "MISSING" } }, env);
  } catch (e) {
    threw = e;
  }
  ok(threw instanceof AuthError, "a missing environment variable is an AuthError");
  ok(threw.message.includes("MISSING"), "and names the variable that is not set");
}

{
  process.env.MENDER_TEST_TOKEN = "Bearer s3cret";
  const spec = specFor("/secure", { auth: { headerEnv: { Authorization: "MENDER_TEST_TOKEN" } } });
  const res = await runCheck(spec);
  eq(res.cause, "OK", "an authenticated request succeeds");
  eq(res.rows.length, 3, "and returns real rows");
  const hit = seenHeaders.filter((h) => h.path === "/secure").pop();
  eq(hit.headers.authorization, "Bearer s3cret", "the header actually reached the server");
  delete process.env.MENDER_TEST_TOKEN;
}

{
  // The failure mode that matters: a missing credential must never look like a
  // layout change, or the repairer would rewrite selectors against a login page.
  const spec = specFor("/secure", { auth: { headerEnv: { Authorization: "MENDER_TEST_ABSENT" } } });
  const res = await runCheck(spec);
  eq(res.cause, "HTTP_ERROR", "a missing credential is an error, not a layout change");
  ok(res.causeDetail.includes("MENDER_TEST_ABSENT"), "and the message names the variable");
  eq(res.rows.length, 0, "no rows are invented");
}

{
  const spec = specFor("/secure");
  const res = await runCheck(spec);
  eq(res.fetched.status, 401, "without credentials the server returns 401");
  eq(res.cause, "HTTP_ERROR", "which classifies as an error rather than a repairable page");
}

{
  // Auth headers must be sent on every paginated page, not only the first.
  process.env.MENDER_TEST_COOKIE = "session=abc";
  const spec = specFor("/secure", {
    auth: { cookieEnv: "MENDER_TEST_COOKIE" },
    paginate: { urlTemplate: `${base}/secure?page={page}`, maxPages: 3 },
  });
  const res = await fetchPages(spec);
  eq(res.pages.length, 3, "three pages fetched");
  const authed = seenHeaders.filter((h) => h.path.startsWith("/secure?page=") && h.headers.cookie === "session=abc");
  eq(authed.length, 3, "every paginated request carried the credential");
  delete process.env.MENDER_TEST_COOKIE;
}

await new Promise((r) => server.close(r));
