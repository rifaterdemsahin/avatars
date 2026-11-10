# Topping up Venice credits

Status on 2026-11-10: **top-up completed by the user** via the Venice web dashboard (route below). Balance went from $0.09 to $4.24 USD (as read from `/api/balance`; the $5 purchase shows as slightly less than $5 net). Before the top-up, chat, images and video returned HTTP 402.

## What worked: web dashboard + Google Pay
1. Log in at https://venice.ai/settings/api (the user's own Chrome session).
2. Click the card icon next to "New API Key" (button "Purchase Credits") to open **Add credits**.
3. Presets start at $10; click **Enter a custom amount** and type `5` (shows 500 credits).
4. Pay with **Google Pay** (approved by the user in their own browser) or a card typed by the user.
5. Check with `GET /api/balance` in this app, or the `/balance` page.
Notes: the assistant set the amount to $5 but did not enter any card details or complete the payment; card numbers are never stored by this project. No saved card existed on the Venice account.

## Options
1. **Web dashboard (simplest):** https://venice.ai/settings/api, add credit by card or crypto (min. $5 for x402).
2. **x402 API (USDC on Base or Solana):** `POST https://api.venice.ai/api/v1/x402/top-up`.
   - Call with no header, get HTTP 402 with payment terms (min `5000000` = 5 USDC, `payTo`, `asset`).
   - Sign the USDC transfer with an x402 client, resend with `PAYMENT-SIGNATURE: <base64 payload>`.
   - Needs a wallet holding USDC and its private key (never stored by this project).
   - Wallet credit is checked with `GET /x402/balance/{wallet}` (SIWE sign-in); see `/balance` in the app.
   - Unverified: whether wallet credit is spendable by the bearer API key in `.env`.
3. **E2B browser automation (this folder, partial):** `e2b/run.mjs` + `e2b/venice_probe.py`.

## E2B process (what exists)
1. E2B key is stored in Azure Key Vault `dp-kv-deliverypilot` as `e2b-api-key` and `e2b-api-key-venice-topup`; the app reads `E2B_API_KEY` from `.env`.
2. `POST /api/e2b/run` creates a sandbox, installs Playwright + Chromium (`PLAYWRIGHT_BROWSERS_PATH=/opt/pw`), runs `venice_probe.py`, returns logs and a screenshot, then kills the sandbox. The page `/e2b` has the button.
3. Known issue: Venice's page did not finish loading inside the sandbox within the timeout (likely bot protection on datacenter IPs); not resolved.

## E2B shutdown
No sandboxes are running (`e2b sandbox list` shows none). Each run of `e2b/run.mjs` kills its sandbox in a `finally` block, so nothing stays up after a probe. The `/e2b` page and `E2B_API_KEY` remain available but idle.

## Missing before the E2B login + top-up can be completed
- Vault secrets for the Venice login (none exist; only `VENICE-API-KEY`).
- A payment method authorised for this use (card or wallet). Nothing suitable is in the vault.
- A confirmation step before any charge.

## Tooling installed (2026-11-10)
- `@e2b/cli` 2.23.0 (global). Works with `E2B_API_KEY` from `.env`, so `e2b auth login` is not needed. `e2b sandbox list` confirmed access. `e2b sandbox create base` opens an interactive terminal; run it yourself with `! e2b sandbox create base`.
- `playwright` 1.65.0 (devDependency) with Chromium. `node e2b/local_probe.mjs` opens Venice locally and screenshots it: the page loads as "Venice Guest" (not logged in). The same page timed out inside the E2B sandbox, so run browser steps locally until that is solved.

## Superpowers plugin (installed by the user)
- Source: https://github.com/obra/superpowers, via marketplace `superpowers-dev` (`claude plugin marketplace add obra/superpowers`).
- Installed by the user with `claude plugin install superpowers@superpowers-dev`: version 7.0.2, scope user, enabled. Claude's auto-mode check blocked the assistant from running the install, so it was done by hand.
- Provides 15 skills (brainstorming, writing-plans, executing-plans, test-driven-development, systematic-debugging, requesting/receiving-code-review, verification-before-completion, using-git-worktrees, subagent-driven-development, and others), no agents, no MCP servers, and one SessionStart hook. About 848 tokens are added to every session.
- Inspect: `claude plugin details superpowers`. Remove: `claude plugin uninstall superpowers@superpowers-dev` then `claude plugin marketplace remove superpowers-dev`.
