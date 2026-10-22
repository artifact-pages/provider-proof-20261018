#!/usr/bin/env bash
set -euo pipefail

case "${ARTIFACT_PAGES_LANE:-}" in
  baseline)
    cli_version="0.4.4"
    config_path="artifact-pages.yaml"
    ;;
  a9)
    cli_version="0.5.1"
    config_path="artifact-pages.a9.yaml"
    ;;
  *)
    echo "ARTIFACT_PAGES_LANE must be baseline or a9" >&2
    exit 2
    ;;
esac

case "${ARTIFACT_PAGES_SITE:-}" in
  proof-a-20261018|proof-b-20261018|proof-neighbor-20261018) ;;
  *)
    echo "ARTIFACT_PAGES_SITE is not one of the three proof sites" >&2
    exit 2
    ;;
esac

if [[ -z "${ARTIFACT_PAGES_EXPECTED_ROLE_ARN:-}" ]]; then
  echo "The Terraform role ARN variable is required for comparison before STS" >&2
  exit 2
fi

cli="artifact-pages_v${cli_version}_linux_amd64"
release_url="https://github.com/artifact-pages/artifact-pages/releases/download/v${cli_version}"
temporary="$(mktemp -d)"
trap 'rm -rf "$temporary"' EXIT

curl --fail --silent --show-error --location "$release_url/$cli" --output "$temporary/$cli"
curl --fail --silent --show-error --location \
  "$release_url/artifact-pages_v${cli_version}_checksums.txt" \
  --output "$temporary/checksums.txt"

expected="$(awk -v asset="$cli" '$2 == asset { print $1 }' "$temporary/checksums.txt")"
if [[ ! "$expected" =~ ^[0-9a-f]{64}$ ]]; then
  echo "Official release checksums do not contain one valid entry for $cli" >&2
  exit 1
fi
printf '%s  %s\n' "$expected" "$temporary/$cli" | sha256sum --check --status
chmod 0755 "$temporary/$cli"

role_arn="$("$temporary/$cli" registry role-arn --config "$config_path" --site "$ARTIFACT_PAGES_SITE")"
if [[ "$role_arn" != "$ARTIFACT_PAGES_EXPECTED_ROLE_ARN" ]]; then
  echo "Helper-derived role ARN does not match the reviewed Terraform output" >&2
  exit 1
fi

printf 'role-arn=%s\n' "$role_arn" >> "$GITHUB_OUTPUT"
printf 'Verified helper-derived role for `%s` against Terraform output.\n' "$ARTIFACT_PAGES_SITE" >> "$GITHUB_STEP_SUMMARY"
