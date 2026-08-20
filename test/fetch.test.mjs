import { eq, ok, section } from "./harness.mjs";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { runCheck, runRepair } from "../dist/repair.js";
import { fetchPage } from "../dist/fetch.js";

section("real http path");

const page = (f) => readFileSync(`examples/pages/${f}`, "utf8");

// Everything above this point runs on strings. This exercises the actual
// network path: a real socket, real redirects, real status codes.
const server = createServer((req, res) => {
  if (req.url === "/pricing") {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(page("v2-price-moved.html"));
  } else if (req.url === "/moved") {
    res.writeHead(302, { location: "/pricing" });
    res.end();
  } else if (req.url === "/blocked") {
    res.writeHead(403, { "content-type": "text/html" });
    res.end(page("blocked.html"));
  } else if (req.url === "/healthy") {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(page("v1-original.html"));
  } else {
    res.writeHead(404, { "content-type": "text/html" });
    res.end("<html><body><h1>Not Found</h1></body></html>");
  }
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const specFor = (path) => ({
  name: "pricing",
  url: `${base}${path}`,
  row: ".pricing-card",
  fields: {
    plan: { selector: ".plan-title", type: "string" },
    price: { selector: ".amount", type: "number", min: 1 },
    features: { selector: "li", type: "list", minItems: 3 },
  },
  expect: { rows: { min: 2, max: 8 } },
});

{
  const res = await fetchPage(`${base}/healthy`);
  eq(res.status, 200, "fetches over a real socket");
  ok(res.html.includes("pricing-card"), "and returns the page body");
}

{
  const check = await runCheck(specFor("/healthy"));
  eq(check.cause, "OK", "a healthy page fetched over http passes");
  eq(check.rows.length, 3, "three rows extracted from the wire");
}

{
  const check = await runCheck(specFor("/pricing"));
  eq(check.cause, "LAYOUT_CHANGE", "the broken page fetched over http is a layout change");

  const outcome = await runRepair(specFor("/pricing"), { fixturesRoot: "examples/fixtures" });
  eq(outcome.fixes.length, 1, "and it repairs over the network exactly as it does offline");
  eq(outcome.fixes[0].selector, '.amount, [data-testid="price-value"]', "same union selector");
}

{
  const check = await runCheck(specFor("/moved"));
  eq(check.cause, "REDIRECTED", "a redirect to another path is detected from the final url");
}

{
  const check = await runCheck(specFor("/blocked"));
  eq(check.cause, "BLOCKED", "a 403 over the wire is BLOCKED");
}

{
  const check = await runCheck(specFor("/nope"));
  eq(check.cause, "HTTP_ERROR", "a 404 over the wire is an error");
}

{
  // Nothing is listening on this port, so this is a transport failure.
  const check = await runCheck({ ...specFor("/pricing"), url: "http://127.0.0.1:1/pricing" });
  eq(check.cause, "HTTP_ERROR", "a connection refusal never looks like a repairable page");
  eq(check.fetched.status, 0, "and is marked with status 0");
}

await new Promise((resolve) => server.close(resolve));
