const expectedBucket = "ap-proof-231136241959-20261018";
const sites = new Set([
  "proof-a-20261018",
  "proof-b-20261018",
  "proof-neighbor-20261018",
]);
const marker = "PROOF_CONTROL_PRIVATE_MARKER_20261018";
const bucket = process.env.AWS_PROOF_BUCKET;
const site = process.env.AWS_PROOF_SITE;
const baseText = process.env.AWS_PROOF_DISTRIBUTION_URL;

if (bucket !== expectedBucket || !sites.has(site ?? "")) {
  throw new Error("Set the fixed AWS proof bucket and one of the registered proof sites");
}
if (!baseText) {
  throw new Error("AWS_PROOF_DISTRIBUTION_URL must be the proof distribution hostname from Terraform output");
}

const base = new URL(baseText ?? "");
if (base.protocol !== "https:" || !base.hostname.endsWith(".cloudfront.net")) {
  throw new Error("AWS_PROOF_DISTRIBUTION_URL must be the proof distribution's HTTPS cloudfront.net hostname");
}

const objectPath = `/_artifacts/${site}/nested/index.html`;
const s3Url = new URL(`https://s3.us-east-1.amazonaws.com/${bucket}${objectPath}`);
const edgeUrl = new URL(objectPath, base);
const controlUrl = new URL(`/_control/sites/${site}/p1.json`, base);

const [originResponse, edgeResponse, controlResponse] = await Promise.all([
  fetch(s3Url),
  fetch(edgeUrl),
  fetch(controlUrl),
]);
const controlBody = await controlResponse.text();
const edgeBody = await edgeResponse.text();
const report = {
  site,
  origin: { url: s3Url.toString(), status: originResponse.status },
  edge: { url: edgeUrl.toString(), status: edgeResponse.status, contentType: edgeResponse.headers.get("content-type") },
  control: { url: controlUrl.toString(), status: controlResponse.status, markerReturned: controlBody.includes(marker) },
};
console.log(JSON.stringify(report, null, 2));

if (originResponse.status !== 403) {
  throw new Error(`Anonymous S3 origin request returned ${originResponse.status}; expected AccessDenied (403)`);
}
if (edgeResponse.status !== 200 || !edgeBody.includes("Nested HTML delivery fixture") ||
    !edgeResponse.headers.get("content-type")?.toLowerCase().startsWith("text/html")) {
  throw new Error("The proof CloudFront URL did not return the registered nested artifact");
}
if (controlBody.includes(marker)) {
  throw new Error("A private control marker was returned through CloudFront");
}
