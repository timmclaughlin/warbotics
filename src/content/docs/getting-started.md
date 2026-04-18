---
title: Getting started
description: How to run the site locally and index content.
tags: [setup]
updated: 2026-04-18
---

# Getting started

1. `npm install`
2. `cp .dev.vars.example .dev.vars` and fill in the values.
3. `npm run bootstrap:instances` — creates the shared `warbotics-content` and
   `wpilib-docs` AI Search instances.
4. `npm run index:content` — pushes this folder into the content instance.
5. `npm run dev` — Astro dev server at http://localhost:4321.

See the top-level `README.md` for the Slack app + Cloudflare account setup.
