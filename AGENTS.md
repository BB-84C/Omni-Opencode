---
title: Omni-Opencode Project Router
status: draft
scope: project
project: omni-opencode
---

# Omni-Opencode

## Project context

`D:\Omni-Opencode` is the OpenCode plugin that lets a parent OpenCode session launch Codex and Claude Code as external delegated workers while preserving OpenCode-native control surfaces: launch metadata, live monitors, attach commands, batch tracking, resume/cancel controls, and aggregate follow-up injection.

Primary stakeholders are the user, the parent OpenCode session, the delegated Codex/Claude runtimes, and the Windows/Linux monitor surfaces that make those jobs inspectable in real time.

## Key paths and commands

- Repo root: `D:\Omni-Opencode`
- Core build/test loop:
  - `npm run build`
  - `npm run typecheck`
  - `npm test`
- Release / install surfaces:
  - `npm run release:pack`
  - `.release\package\`
  - packaged install: `opencode plugin omni-opencode`
  - unpacked install: `opencode plugin "<unpacked-package-root>"`
  - local dev config may point to `file:///.../dist/plugin.js`
- Windows runtime bootstrap:
  - `npm run bootstrap:windows-psmux`
  - current shared-session attach surface: `psmux attach -t <monitorSessionId>`
- High-value source areas:
  - `src\plugin.ts`
  - `src\plugin\tools.ts`
  - `src\plugin\resume.ts`
  - `src\core\*.ts`
  - `src\adapters\*.ts`
  - `src\runtime\windows-psmux.ts`
  - `src\runtime\windows-dashboard-*.ts`
- Runtime state:
  - `.omni-monitors\`
  - `.omni-tools\`

## Domain vocabulary

- delegated job, parent turn, batch, aggregate follow-up, launch-confirm-stop
- `jobId`, `batchId`, attach command, monitor target, auto-open
- psmux, shared monitor session, dashboard pane, execution pane, attach surface
- transcript capture, correlation marker, snapshot/read/attach tools
- provider adapter, model choice, reasoning effort, resume prompt injection

## Existing local guidance

- No repo-local skills currently exist.
- The durable design/implementation history lives under `docs\plans\` and is worth using when the task references a specific phase or certification pass.

## Boundaries and routing notes

- This repo is plugin-first. Do not collapse it into a "tool wrapper" mental model when deciding where behavior belongs.
- Packaged-install testing and local-dev testing are different surfaces; keep them separate in both reasoning and verification.
- Windows monitor behavior is part of the product contract, not a cosmetic extra.
- See `.opencode/memory/*.md` for Omni-specific cuts of the global memory categories.
