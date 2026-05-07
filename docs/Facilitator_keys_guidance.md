# Facilitator Key Management — Operator Security Guidance

**Applies to:** x402-1CS Gateway v1
**Last updated:** 2026-04-02

---

## What is the Facilitator Wallet?

The x402-1CS Gateway uses a **facilitator wallet** — an EVM account funded with ETH on Base — to broadcast `transferWithAuthorization` (EIP-3009) transactions on behalf of buyers. When a buyer signs an x402 payment header, the facilitator submits that signed authorization on-chain, paying the gas fee.

The facilitator's private key (`FACILITATOR_PRIVATE_KEY`) is **the most sensitive secret** in the entire system. If compromised, an attacker can:

- Drain the facilitator's ETH balance
- Front-run or intercept in-flight settlements
- Impersonate the gateway in on-chain transactions

This guide explains how the gateway handles the key internally and what you, as the operator, must do to keep it safe.

---

## How the Gateway Handles the Key Internally

### What the code does well

| Protection | Detail |
|------------|--------|
| **Key never logged** | No `console.log` or error handler in the codebase ever prints the private key. Only the derived public address is logged at startup. |
| **Key never persisted to disk** | The state store only serializes `SwapState` objects (quote metadata). The key is never written to any database, file, or cache. |
| **Key not attached to requests** | Configuration is encapsulated in closures via `createX402Middleware(deps)` — it is never placed on Express `req.locals` or any request-scoped object. |
| **`.env` files gitignored** | Both `.env` and `.env.test` are listed in `.gitignore`. They will not be committed unless you override git. |
| **Error handlers sanitized** | `handleError()` in the middleware and all `catch` blocks in the settler extract only `err.message`, never the full config object. |
| **Health endpoint safe** | The `/health` endpoint exposes only the public wallet address and operational metrics — never any secret. |
| **Test keys are isolated** | Mock wallets in `src/mocks/mock-wallets.ts` are clearly marked as Hardhat test keys and are never used in production paths. |

### Known limitations (v1)

| Limitation | Impact | Mitigation |
|------------|--------|------------|
| **Key lives in process memory** | The private key string exists in the Node.js heap for the lifetime of the process. V8 strings are immutable and cannot be securely zeroed. | Keep the server process isolated (container, VM). Restrict who can attach debuggers or read `/proc/<pid>/mem`. |
| **`ethers.Wallet.privateKey` is a public property** | If the wallet object is accidentally logged or serialized (e.g., via `JSON.stringify`), the key appears in output. | Never log or serialize the wallet object. The codebase currently avoids this, but be careful when adding custom logging or middleware. |
| **Config object carries the key** | `GatewayConfig` includes `facilitatorPrivateKey` as a field that is passed to several modules at startup. | Downstream modules (verifier, quote-engine, middleware) never read this field — they only use chain/token metadata. But the key is technically accessible. |
| **No KMS/HSM integration** | The gateway reads the raw key from an environment variable. There is no native integration with AWS KMS, GCP KMS, HashiCorp Vault, or any hardware security module. | Use a secrets manager that injects environment variables at runtime (see below). |
| **No hot key rotation** | Changing the facilitator key requires restarting the service. There is no API or signal to reload keys at runtime. | Plan maintenance windows for key rotation. |

---

## Operator Checklist

### 1. Generate a dedicated key

Create a fresh private key exclusively for facilitator duties. **Never reuse** a key from a personal wallet, a treasury, or another service.

```bash
# Generate a random key (using Node.js + ethers)
node -e "const { Wallet } = require('ethers'); const w = Wallet.createRandom(); console.log('Address:', w.address); console.log('Private key:', w.privateKey);"
```

Record the address and private key securely. You will need the address to fund the wallet with ETH for gas.

### 2. Fund conservatively

The facilitator wallet only needs ETH for gas — it never holds USDC or any ERC-20 tokens. Each `transferWithAuthorization` call costs approximately 50,000–80,000 gas on Base.

**Recommendation**: Fund the wallet with a small amount (0.01–0.05 ETH) and top up incrementally. Never hold more ETH than you're willing to lose.

Set up a balance alert (e.g., via Basescan watchlist, Tenderly, or an RPC watcher script) so you know when to refill — and so you're notified immediately if funds drain unexpectedly.

### 3. Store the key in a secrets manager (production)

**Never store the raw private key in a plaintext `.env` file on a production server.** The `.env` file approach is acceptable only for local development.

For production, use a secrets manager that can inject the key as an environment variable at runtime:

| Platform | Tool | How it works |
|----------|------|--------------|
| AWS | [Secrets Manager](https://aws.amazon.com/secrets-manager/) | ECS/Lambda/EC2 can inject secrets as env vars via task definitions or SDK calls |
| GCP | [Secret Manager](https://cloud.google.com/secret-manager) | Cloud Run / GKE can mount secrets as env vars |
| Azure | [Key Vault](https://azure.microsoft.com/en-us/products/key-vault/) | App Service / AKS can reference vault secrets as env vars |
| Self-hosted | [HashiCorp Vault](https://www.vaultproject.io/) | Use `vault agent` or `envconsul` to inject secrets |
| CI/CD | [Doppler](https://www.doppler.com/) | `doppler run -- npx tsx src/server.ts` injects all secrets |
| Docker | Docker Secrets + Compose | Mount secrets to files, read via a startup script |

The gateway reads `FACILITATOR_PRIVATE_KEY` from `process.env` — any mechanism that sets that environment variable before the process starts will work.

### 4. Lock down the `.env` file (development / staging)

If you must use a `.env` file (local dev, staging), restrict its permissions immediately:

```bash
chmod 600 .env
```

This ensures only the file owner can read it. Verify:

```bash
ls -la .env
# Should show: -rw------- 1 youruser yourgroup ... .env
```

**Never commit `.env` to version control.** The repository's `.gitignore` already excludes it, but double-check:

```bash
git status --short .env
# Should show nothing (ignored) or "??" (untracked, not staged)
```

### 5. Isolate the process

The private key lives in process memory for the entire lifetime of the Node.js process. To limit exposure:

| Measure | Why |
|---------|-----|
| **Run in a container** | Containers provide process isolation. If the container is compromised, the blast radius is limited. |
| **Drop capabilities** | Run with `--cap-drop=ALL` in Docker. The gateway needs only network access, not `ptrace`, `sys_admin`, etc. |
| **No root** | Run the process as a non-root user. In Docker: `USER node` in the Dockerfile. |
| **Restrict debugger access** | Ensure `--inspect` is not enabled in production. An open debugger port allows reading process memory (and therefore the key). |
| **Limit SSH / shell access** | Only authorized operators should be able to shell into the machine or container running the gateway. |

### 6. Monitor for compromise

Set up alerts for:

| Signal | How to monitor |
|--------|---------------|
| **Unexpected ETH outflows** | Basescan address watchlist, Tenderly alerts, or a custom RPC script polling `eth_getBalance` |
| **Unexpected transaction origins** | If transactions appear from your facilitator address that don't match gateway logs, the key may be compromised |
| **Gateway health anomalies** | Monitor `/health` for sudden changes in `settlements.inFlight` or `uptime` resets |
| **Error rate spikes** | A compromised key being used elsewhere may cause nonce conflicts, leading to broadcast failures in your gateway |

### 7. Rotate the key

If you suspect the key is compromised — or as a regular hygiene practice — rotate it:

1. **Generate a new key** (see step 1)
2. **Fund the new wallet** with ETH for gas
3. **Wait for in-flight settlements to complete** — check `/health` and ensure `settlements.inFlight` is 0
4. **Update the secret** in your secrets manager (or `.env` file)
5. **Restart the gateway** — the new key will be loaded on startup
6. **Drain the old wallet** — transfer remaining ETH out of the old facilitator address

There is no hot-reload for keys in v1. A restart is required.

### 8. Protect the 1CS JWT as well

The `ONE_CLICK_JWT` is also a sensitive credential. While it cannot move funds on-chain, it grants access to the 1Click Swap API and could be used to:

- Generate swap quotes on your behalf (consuming your rate limits)
- Observe your trading patterns

Apply the same secrets management practices (secrets manager, restricted file permissions, no version control) to the JWT.

---

## Threat Model Summary

| Threat | Likelihood | Impact | Mitigation |
|--------|-----------|--------|------------|
| `.env` file leaked via git | Medium | Critical | `.gitignore`, pre-commit hooks, secrets scanning (e.g., `gitleaks`) |
| `.env` file read by another user on shared machine | Medium | Critical | `chmod 600`, dedicated user account, container isolation |
| Process memory dumped (debugger, core dump, `/proc/mem`) | Low | Critical | No `--inspect` in prod, `ulimit -c 0` to disable core dumps, restricted shell access |
| Log output accidentally includes key | Low | Critical | Code audit shows no key logging; maintain this discipline when adding new logs |
| Wallet object serialized via `JSON.stringify` | Low | High | Never log or serialize the wallet object; ethers `Wallet.privateKey` is a public getter |
| Attacker gains RPC access and replays transactions | Low | Medium | Facilitator only pays gas; buyer funds move via signed EIP-3009 authorizations that are single-use |
| 1CS JWT stolen | Medium | Low | Secrets manager, same protections as private key |

---

## Quick Reference

```
DO:
  + Generate a dedicated key for the facilitator (never reuse personal keys)
  + Store the key in a secrets manager for production
  + chmod 600 .env for development
  + Fund the wallet conservatively and monitor the balance
  + Run the process in a container as a non-root user
  + Rotate the key periodically and after any suspected compromise
  + Monitor for unexpected transactions from the facilitator address

DON'T:
  - Commit .env or any file containing the private key to git
  - Log or serialize the wallet object or the config object
  - Run with --inspect or debugger ports open in production
  - Hold large ETH balances in the facilitator wallet
  - Share the private key across multiple services or environments
  - Skip key rotation after personnel changes
```
