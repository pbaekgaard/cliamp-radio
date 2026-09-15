#!/usr/bin/env bash
# Bumps the version, commits any pending changes, tags the release, and
# pushes everything to GitHub in one go. This is the "I edited stuff on
# main, now ship it" button — just run it:
#
#   ./scripts/push_update.sh
#
# It'll ask you to pick a bump type (major/minor/bugfix), then prompt you
# for a short release message, which becomes both the commit message (if
# there are uncommitted changes) and the annotated git tag message shown in
# the app's "Check for updates" modal as the changelog.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

echo "What kind of update is this?"
select choice in "major" "minor" "bugfix"; do
  case "$choice" in
    major|minor|bugfix) BUMP="$choice"; break ;;
    *) echo "Please pick 1, 2, or 3." ;;
  esac
done

echo "==> Fetching latest tags from origin"
git fetch --tags origin --quiet

LATEST_TAG=$(git tag -l 'v*' --sort=-v:refname | head -n1)
LATEST_TAG="${LATEST_TAG:-v0.0.0}"
echo "==> Current latest tag: ${LATEST_TAG}"

if [[ ! "$LATEST_TAG" =~ ^v([0-9]+)\.([0-9]+)\.([0-9]+)$ ]]; then
  echo "==> ERROR: couldn't parse '${LATEST_TAG}' as vMAJOR.MINOR.PATCH" >&2
  exit 1
fi
MAJOR="${BASH_REMATCH[1]}"
MINOR="${BASH_REMATCH[2]}"
PATCH="${BASH_REMATCH[3]}"

case "$BUMP" in
  major)
    MAJOR=$((MAJOR + 1)); MINOR=0; PATCH=0
    ;;
  minor)
    MINOR=$((MINOR + 1)); PATCH=0
    ;;
  bugfix)
    PATCH=$((PATCH + 1))
    ;;
esac

NEW_TAG="v${MAJOR}.${MINOR}.${PATCH}"
echo "==> New version: ${NEW_TAG} (${BUMP})"

CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [[ "$CURRENT_BRANCH" != "main" ]]; then
  echo "==> WARNING: you're on branch '${CURRENT_BRANCH}', not 'main'."
  read -rp "    Continue anyway? [y/N] " confirm
  [[ "$confirm" =~ ^[Yy]$ ]] || { echo "Aborted."; exit 1; }
fi

read -rp "Release message (short summary for the changelog): " MESSAGE
if [[ -z "$MESSAGE" ]]; then
  MESSAGE="${NEW_TAG}"
fi

if [[ -n "$(git status --porcelain)" ]]; then
  echo "==> Committing pending changes"
  git add -A
  git commit -m "${NEW_TAG}: ${MESSAGE}"
else
  echo "==> No pending changes to commit"
fi

echo "==> Tagging ${NEW_TAG}"
git tag -a "${NEW_TAG}" -m "${NEW_TAG}: ${MESSAGE}"

echo "==> Pushing main and tag to origin"
git push origin main
git push origin "${NEW_TAG}"

echo "==> Done! ${NEW_TAG} is live on GitHub."
echo "    Your server's 'Check for updates' button will pick it up next time it's clicked."
