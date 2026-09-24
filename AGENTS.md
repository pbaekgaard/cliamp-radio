# Agent Instructions

Standing rules for GitHub Copilot CLI (and other AI agents) working in this repository.

## Releases & Deployment

- When asked to "push a release" or "update": only push commits to `main` and create a git tag for the release using the @./scripts/push_update.sh. Do **not** SSH into the production server or apply updates there.
- The user installs updates on the production server themselves via the web interface. Never perform remote deployment/installation steps on their behalf.

## Task queueing mid-task

- When the user says something like "also, do this" or "finally, this" while I'm already mid-task, treat it as adding to the queue of work, not as a request to stop. Note it down, keep working on the current task, and pick up the new one afterward — unless they explicitly say to drop what I'm doing.

## Specific Task Instructions

### Visual changes

- When the user asks for changes that will do any visual changes. Spin up the local server, and provide a link to the live reload page only of whatever page we are working on. so he can follow whats going on and verify!
