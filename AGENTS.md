# Agent Instructions

Standing rules for GitHub Copilot CLI (and other AI agents) working in this repository.

## Releases & Deployment

- When asked to "push a release" or "update": only push commits to `main` and create a git tag for the release using the @./scripts/push_update.sh. Do **not** SSH into the production server or apply updates there.
- The user installs updates on the production server themselves via the web interface. Never perform remote deployment/installation steps on their behalf.

<!-- Add more standing instructions below as they come up. -->
