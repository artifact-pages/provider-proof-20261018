#!/usr/bin/env bash
set -euo pipefail

if [[ "${GITHUB_REF:-}" != "refs/heads/main" ]]; then
  echo "Manual previews must be dispatched from refs/heads/main" >&2
  exit 1
fi

head_sha="${ARTIFACT_PAGES_REVIEWED_HEAD:-}"
if [[ ! "$head_sha" =~ ^[0-9a-f]{40}$ ]]; then
  echo "Supply the full lowercase SHA of the reviewed preview commit" >&2
  exit 1
fi

git fetch --no-tags origin "$head_sha"
git cat-file -e "${head_sha}^{commit}"
main_sha="$(git rev-parse refs/heads/main)"
merge_base="$(git merge-base refs/heads/main "$head_sha")"
if [[ ! "$merge_base" =~ ^[0-9a-f]{40}$ ]]; then
  echo "The reviewed preview commit has no merge base with main" >&2
  exit 1
fi

{
  printf 'Manual preview head: `%s`\n' "$head_sha"
  printf 'Main SHA: `%s`\n' "$main_sha"
  printf 'Merge base: `%s`\n' "$merge_base"
  printf 'Default ref passed to the preview Action: `refs/heads/main`\n'
} >> "$GITHUB_STEP_SUMMARY"
