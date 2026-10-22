const target = decodeURIComponent(document.documentElement.dataset.target ?? "");
try {
  const response = await fetch(target, { mode: "cors" });
  parent.postMessage({ type: "provider-proof-opaque-origin", outcome: "allowed", status: response.status }, "*");
} catch {
  parent.postMessage({ type: "provider-proof-opaque-origin", outcome: "blocked" }, "*");
}
