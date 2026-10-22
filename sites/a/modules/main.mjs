import { transitiveValue } from "./nested/transitive.mjs";

const status = document.querySelector("#fixture-status");
document.documentElement.dataset.proofEsm = `main-${transitiveValue}`;

const paths = [
  "../data/sample.json",
  "../images/proof.svg",
  "../fonts/proof.woff2",
  "../wasm/identity.wasm",
  "../unknown/opaque.ap-proof",
  `../reserved/${encodeURIComponent("space name.txt")}`,
  `../reserved/${encodeURIComponent("café.txt")}`,
  `../reserved/${encodeURIComponent("hash#mark?.txt")}`,
];

window.__proofResources = await Promise.all(paths.map(async (path) => {
  const response = await fetch(path);
  const bytes = await response.arrayBuffer();
  return {
    path,
    status: response.status,
    contentType: response.headers.get("content-type"),
    byteLength: bytes.byteLength,
  };
}));

const httpViolations = [];
window.addEventListener("securitypolicyviolation", (event) => {
  if (event.blockedURI.startsWith("http:")) {
    httpViolations.push({ blockedURI: event.blockedURI, directive: event.effectiveDirective });
  }
});

window.__proofHttpFetchAttempted = true;
try {
  await fetch("http://example.invalid/provider-proof-runtime-http", { mode: "no-cors" });
  window.__proofHttpFetchRejected = false;
} catch {
  window.__proofHttpFetchRejected = true;
}

window.__proofHttpViolations = httpViolations;
window.__proofFixtureReady = true;
status.textContent = `ESM ${transitiveValue}; ${window.__proofResources.length} resources checked.`;
document.querySelector("#resource-results").textContent = JSON.stringify(window.__proofResources);
