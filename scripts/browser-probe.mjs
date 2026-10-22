import { chromium } from "playwright";

const sites = new Set([
  "proof-a-20261018",
  "proof-b-20261018",
  "proof-neighbor-20261018",
]);
const site = process.env.ARTIFACT_PAGES_SITE;
const base = new URL(process.env.ARTIFACT_PAGES_BASE_URL ?? "");
if (!sites.has(site ?? "") || base.protocol !== "https:" || !base.hostname.endsWith(".cloudfront.net")) {
  throw new Error("Set a fixed proof site and its HTTPS CloudFront hostname before running this read-only probe");
}

const pagePath = process.env.ARTIFACT_PAGES_PAGE_PATH ?? `/${site}/nested/index.html`;
const targetUrl = new URL(pagePath, base);
if (targetUrl.origin !== base.origin || !targetUrl.pathname.includes(site)) {
  throw new Error("ARTIFACT_PAGES_PAGE_PATH must stay on the proof distribution and include the selected site ID");
}

const expectedGzip = process.env.ARTIFACT_PAGES_EXPECT_GZIP;
if (expectedGzip && !["true", "false"].includes(expectedGzip)) {
  throw new Error("ARTIFACT_PAGES_EXPECT_GZIP must be true or false when supplied");
}

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  const routeResponse = await page.goto(targetUrl.toString(), { waitUntil: "domcontentloaded" });
  if (routeResponse?.status() !== 200) {
    throw new Error(`Logical page returned ${routeResponse?.status() ?? "no response"}`);
  }
  await page.reload({ waitUntil: "domcontentloaded" });
  if (page.url() !== targetUrl.toString()) {
    throw new Error("Reload changed the canonical proof route");
  }

  const rawUrl = new URL(`/_artifacts/${site}/nested/index.html`, base);
  const rawResponse = await page.goto(rawUrl.toString(), { waitUntil: "domcontentloaded" });
  if (rawResponse?.status() !== 200) {
    throw new Error(`Raw nested artifact returned ${rawResponse?.status() ?? "no response"}`);
  }
  const enforcedCsp = rawResponse.headers()["content-security-policy"] ?? null;
  if (!enforcedCsp) {
    throw new Error("The raw nested artifact response did not include an enforced Content-Security-Policy header");
  }
  await page.waitForFunction(() => window.__proofFixtureReady === true, null, { timeout: 20_000 });

  const browserState = await page.evaluate(async (siteId) => {
    const css = getComputedStyle(document.documentElement);
    const indexResponse = await fetch(`/_indexes/${siteId}/index.json`);
    const indexBytes = await indexResponse.arrayBuffer();
    const index = JSON.parse(new TextDecoder().decode(indexBytes));
    const manifestResponse = await fetch(`/_indexes/${siteId}/search/manifest.json`);
    const manifestBytes = await manifestResponse.arrayBuffer();
    const manifest = JSON.parse(new TextDecoder().decode(manifestBytes));
    return {
      esm: document.documentElement.dataset.proofEsm,
      transitiveCss: css.getPropertyValue("--proof-transitive-css").trim(),
      imageWidth: document.querySelector("#proof-image")?.naturalWidth ?? 0,
      resourceResults: window.__proofResources ?? [],
      httpFetchRejected: window.__proofHttpFetchRejected === true,
      httpViolations: window.__proofHttpViolations ?? [],
      index: {
        status: indexResponse.status,
        contentEncoding: indexResponse.headers.get("content-encoding"),
        decodedBytes: indexBytes.byteLength,
        artifactCount: index.artifacts?.length ?? 0,
      },
      manifest: {
        status: manifestResponse.status,
        contentEncoding: manifestResponse.headers.get("content-encoding"),
        decodedBytes: manifestBytes.byteLength,
        documents: manifest.documents,
      },
    };
  }, site);

  if (browserState.esm !== "main-transitive-module-loaded") {
    throw new Error(`Transitive ESM did not execute: ${browserState.esm}`);
  }
  if (browserState.transitiveCss !== "loaded" || browserState.imageWidth < 1) {
    throw new Error("Transitive CSS or the relative image did not load");
  }
  const expectedTypes = [
    "application/json",
    "image/svg+xml",
    "font/woff2",
    "application/wasm",
    "application/octet-stream",
    "application/octet-stream",
    "application/octet-stream",
    "application/octet-stream",
  ];
  if (browserState.resourceResults.length !== expectedTypes.length || browserState.resourceResults.some((item, index) =>
    item.status !== 200 || item.byteLength < 1 || !item.contentType?.toLowerCase().startsWith(expectedTypes[index]))) {
    throw new Error("At least one data/font/WASM/unknown/reserved resource request failed");
  }
  if (!browserState.httpFetchRejected || browserState.httpViolations.length === 0) {
    throw new Error("The runtime HTTP fetch was not blocked by enforced CSP");
  }

  const opaqueOriginFetch = await page.evaluate((target) => new Promise((resolve) => {
    const frame = document.createElement("iframe");
    frame.setAttribute("sandbox", "allow-scripts");
    const timeout = setTimeout(() => finish({ outcome: "timeout" }), 10_000);
    const onMessage = (event) => {
      if (event.source === frame.contentWindow && event.origin === "null" && event.data?.type === "provider-proof-opaque-origin") {
        finish(event.data);
      }
    };
    function finish(result) {
      clearTimeout(timeout);
      window.removeEventListener("message", onMessage);
      frame.remove();
      resolve(result);
    }
    window.addEventListener("message", onMessage);
    frame.srcdoc = `<html data-target="${encodeURIComponent(target)}"><script type="module" src="../modules/opaque-origin-probe.mjs"></script></html>`;
    document.body.appendChild(frame);
  }), new URL(`/_indexes/${site}/index.json`, base).toString());
  if (opaqueOriginFetch.outcome !== "blocked") {
    throw new Error(`Opaque-origin cross-origin read was ${opaqueOriginFetch.outcome}; expected a CORS denial`);
  }

  if (expectedGzip) {
    const shouldBeGzip = expectedGzip === "true";
    for (const [label, value] of [["index", browserState.index], ["search manifest", browserState.manifest]]) {
      const isGzip = value.contentEncoding?.toLowerCase() === "gzip";
      if (isGzip !== shouldBeGzip) {
        throw new Error(`${label} Content-Encoding was ${value.contentEncoding ?? "absent"}; expected gzip=${shouldBeGzip}`);
      }
    }
  }

  const markdownUrl = new URL(`/${site}/nested/readme.md`, base);
  const markdownResponse = await page.goto(markdownUrl.toString(), { waitUntil: "domcontentloaded" });
  if (markdownResponse?.status() !== 200) {
    throw new Error(`Logical Markdown route returned ${markdownResponse?.status() ?? "no response"}`);
  }
  await page.waitForTimeout(500);
  const scriptRan = await Promise.all(page.frames().map(async (frame) => {
    try {
      return await frame.evaluate(() => window.__proofMarkdownScriptRan === true);
    } catch {
      return false;
    }
  }));
  if (scriptRan.some(Boolean)) {
    throw new Error("The inert Markdown script payload executed in a frame");
  }

  console.log(JSON.stringify({
    browserVersion: browser.version(),
    logicalRoute: targetUrl.toString(),
    rawRoute: rawUrl.toString(),
    enforcedCsp,
    browserState,
    opaqueOriginFetch,
    markdownScriptExecuted: false,
  }, null, 2));
} finally {
  await browser.close();
}
