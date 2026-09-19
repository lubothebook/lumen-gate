# The SEP surface: what is implemented, what is not

The anchor facade is the integration surface of this system, so the SEP claims it
makes have to survive a client that knows only the specification. This document
lists what is served, what each endpoint is backed by, and — in the same
document, not a footnote — what is deliberately absent.

Everything below is probed by
[`tools/sep-conformance.js`](../tools/sep-conformance.js), which talks to a
running facade the way a wallet would, and by the self-audit loop, which runs
that probe every round and records the verdict.

## Routes

| Route | Backed by |
| --- | --- |
| `GET /.well-known/stellar.toml` | SEP-1 discovery. The two deployment-dependent values (the SEP-10 signing key and the facade's public URL) are rendered from the environment when the file is served; when they are undefined the lines are omitted rather than left as placeholders |
| `GET /v1/sep10/auth?account=G...` | a challenge transaction signed by the anchor account, carrying `web_auth_domain`, a short validity window, and client attribution when `client_domain` is supplied (the client domain's `SIGNING_KEY` is read from its own stellar.toml) |
| `POST /v1/sep10/auth` | verification of the client's signature over that exact transaction, using the SDK's own SEP-10 reader, then a short-lived HS256 JWT |
| `GET /v1/sep6/info` | the deposit and withdraw capabilities that really exist, with the documented field names, plus an explicit list of what this deployment does not have |
| `GET /v1/deposit` | official SEP-6 response fields (`how`, `id`, `eta`, `min_amount`, `max_amount`, `fee_fixed`, `extra_info`) and a real transaction record |
| `GET /v1/withdraw` | the same, for the outbound direction, with the burn instructions the user signs themselves |
| `GET /v1/transactions` | records in the SEP-6 transaction schema, with the statuses the specification defines |
| `POST /v1/transactions/{id}/burn` | reports a burn transaction hash. The facade verifies it against Horizon before the record moves, and requires a SEP-10 session belonging to the account on the record |
| `GET /v1/sep12/customer` | answers `501 not_implemented` with a reason |
| `POST /v1/relay`, `POST /v1/reconcile` | operator token only; these spend fees or write records |

Unversioned aliases (`/info`, `/deposit`, `/withdraw`, `/transactions`,
`/sep6/info`, `/relay`, `/self-audit`) point at the same handlers, so nothing
integrating today breaks silently. New integrations should use `/v1`.

## How records advance

A record moves only when evidence is observed on a ledger:

| Transition | Evidence that causes it |
| --- | --- |
| deposit: `pending_user_transfer_start` → `pending_anchor` | a lock event read from the source chain whose recipient is the record's account and whose amount is the requested amount plus the fixed fee |
| deposit: `pending_anchor` → `completed` | a payment of the wrapped asset to that account, read from Horizon; its transaction hash becomes the record's `stellar_transaction_id` |
| withdrawal: `pending_user_transfer_start` → `pending_anchor` | a burn transaction confirmed by Horizon, signed by the account on the record |

There is no path where a client's assertion moves a record. The conformance
probe checks exactly that: it reports a burn hash that does not exist and
requires the facade to refuse it after checking the network.

## What is not implemented

- **SEP-12 customer information.** No KYC is collected; `/v1/sep12/customer`
  answers 501.
- **SEP-24 hosted deposit and withdraw.** There is no interactive flow, so no
  `TRANSFER_SERVER_SEP0024` is advertised.
- **SEP-31 cross-border payments, SEP-38 quotes, fiat rails.** Absent, and not
  mentioned in `stellar.toml`.
- **Account creation and claimable balances.** The inbound direction is gasless
  for the recipient in the sense that they need no spendable XLM, but a Stellar
  account with a trustline for the wrapped asset is still required, because a
  Stellar asset cannot be held without one.
- **Market pricing.** The relayer fee is a fixed amount chosen at submission
  time, not a rate derived from the live XLM fee and a market price. The SEP-6
  `fee_fixed` field reports that same fixed number, so the surface and the
  mechanism agree.

## Error shape

Every failure from every route is the same document:

```json
{
  "error": {
    "code": "invalid_account",
    "message": "account must be a Stellar account id (G...)",
    "details": { "example": "/v1/sep10/auth?account=G..." }
  }
}
```

`code` is stable and machine-readable, `message` is for a human, `details`
carries structured context when there is any. This includes 404, 405, 429 and
5xx answers: a client that parses one error shape can parse them all.

## Rate limiting

The public read surface is limited per calling address (default 60 requests per
minute, `RATE_LIMIT_PER_MIN`), with `X-RateLimit-Limit`, `X-RateLimit-Remaining`
and `X-RateLimit-Reset` on every answer and a `Retry-After` on the refusal. The
refusal itself is the standard error envelope with code `rate_limited`. Writes
are protected by credentials rather than by volume, so they are not part of this
limiter.

## Running the probe

```bash
# with the facade running on 8081
FACADE_URL=http://127.0.0.1:8081 node tools/sep-conformance.js
FACADE_URL=http://127.0.0.1:8081 node tools/sep-conformance.js --json
```

It exits non-zero if any check fails, which is what makes it usable as a gate in
CI and as a probe in the self-audit loop. SEP-10 checks need
`SEP10_SIGNING_SECRET` to be set on the facade; without it the endpoint reports
itself as not configured, which the probe records as a failure rather than
skipping it.
