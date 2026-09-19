'use strict';

// ---------------------------------------------------------------------------
// SEP-10 web authentication.
//
// The flow, in the order the network actually performs it:
//
//   1. the client asks for a challenge for its own account;
//   2. the anchor builds a transaction whose source is the anchor account,
//      containing a manage_data operation sourced by the client account (the
//      challenge) and one carrying the web_auth_domain, then signs it;
//   3. the client signs the same transaction and posts it back;
//   4. the anchor verifies the client's signature over that exact transaction,
//      checks the time bounds and the domain binding, and issues a JWT.
//
// The transaction is never submitted to the network. Its purpose is to make the
// client prove control of the key by signing a statement the anchor chose.
//
// Configuration:
//   SEP10_SIGNING_SECRET     secret key of the anchor account (required)
//   SEP10_SIGNING_KEY        optional; defaults to the public key of the secret
//   SEP10_HOME_DOMAIN        the domain the challenge is bound to
//   SEP10_WEB_AUTH_DOMAIN    the domain serving this endpoint (defaults to home)
//   SEP10_CHALLENGE_TIMEOUT  seconds the challenge stays valid (default 300)
// ---------------------------------------------------------------------------

const errors = require('./errors');

function sdk() {
  // Required lazily: the facade stays runnable without the SDK for every
  // endpoint that does not perform authentication.
  return require('@stellar/stellar-sdk');
}

function networkPassphrase() {
  const explicit = (process.env.NETWORK_PASSPHRASE || '').trim();
  if (explicit) return explicit;
  const network = (process.env.STELLAR_NETWORK || 'testnet').trim();
  return network === 'public'
    ? 'Public Global Stellar Network ; September 2015'
    : 'Test SDF Network ; September 2015';
}

function networkName() {
  return networkPassphrase().startsWith('Public') ? 'public' : 'testnet';
}

/** The facade's own public origin, used to derive the default domains. */
function publicBase() {
  return (process.env.PUBLIC_FACADE_URL || '').trim().replace(/\/+$/, '');
}

function homeDomain() {
  const explicit = (process.env.SEP10_HOME_DOMAIN || '').trim();
  if (explicit) return explicit;
  const base = publicBase();
  if (base) {
    try {
      return new URL(base).host;
    } catch {
      /* fall through to the local default */
    }
  }
  return 'localhost';
}

function webAuthDomain() {
  return (process.env.SEP10_WEB_AUTH_DOMAIN || '').trim() || homeDomain();
}

function challengeTimeout() {
  const raw = Number(process.env.SEP10_CHALLENGE_TIMEOUT || 300);
  if (!Number.isFinite(raw) || raw < 15) return 300;
  return Math.min(Math.floor(raw), 3600);
}

/** `{configured, signing_key, home_domain, web_auth_domain, ...}` - all facts, no guesses. */
function status() {
  const secret = (process.env.SEP10_SIGNING_SECRET || '').trim();
  const configuredKey = (process.env.SEP10_SIGNING_KEY || '').trim();
  let derivedKey = '';
  if (secret) {
    try {
      derivedKey = sdk().Keypair.fromSecret(secret).publicKey();
    } catch {
      derivedKey = '';
    }
  }
  return {
    configured: Boolean(secret) && Boolean(derivedKey),
    endpoint: `${publicBase()}/v1/sep10/auth`,
    signing_key: derivedKey || configuredKey || null,
    home_domain: homeDomain(),
    web_auth_domain: webAuthDomain(),
    network: networkName(),
    network_passphrase: networkPassphrase(),
    challenge_timeout_seconds: challengeTimeout(),
    jwt_ttl_seconds: require('./jwt').ttlSeconds(),
    note: 'the challenge transaction is signed by this anchor account and never submitted to the network; the client proves key control by signing it back',
  };
}

/**
 * Builds a challenge transaction.
 *
 * `client_domain` is optional client attribution. SEP-10 requires the client
 * domain's SIGNING_KEY as the source of the client_domain operation, so it is
 * read from that domain's stellar.toml. If it cannot be read, the request is
 * refused instead of being served with a missing attribution.
 */
async function buildChallenge({account, clientDomain, memo}) {
  const config = status();
  if (!config.configured) {
    const error = new Error('SEP-10 is not configured: set SEP10_SIGNING_SECRET to an anchor secret key');
    error.code = 'not_configured';
    throw error;
  }
  if (!isAccountId(account)) {
    const error = new Error('account must be a Stellar account id (G...)');
    error.code = 'invalid_account';
    throw error;
  }
  if (memo && String(account).startsWith('M')) {
    const error = new Error('memo cannot be used with a muxed account');
    error.code = 'invalid_request';
    throw error;
  }

  let clientSigningKey = null;
  if (clientDomain) {
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(String(clientDomain))) {
      const error = new Error('client_domain must be a bare domain name');
      error.code = 'invalid_request';
      throw error;
    }
    clientSigningKey = await clientDomainSigningKey(String(clientDomain));
    if (!clientSigningKey) {
      const error = new Error(`could not read SIGNING_KEY from https://${clientDomain}/.well-known/stellar.toml`);
      error.code = 'upstream_unavailable';
      throw error;
    }
  }

  const {Keypair, WebAuth} = sdk();
  const signer = Keypair.fromSecret((process.env.SEP10_SIGNING_SECRET || '').trim());
  const transaction = WebAuth.buildChallengeTx(
    signer,
    account,
    homeDomain(),
    challengeTimeout(),
    networkPassphrase(),
    webAuthDomain(),
    memo || null,
    clientDomain || null,
    clientSigningKey
  );
  return {
    transaction,
    network_passphrase: networkPassphrase(),
    home_domain: homeDomain(),
    expires_in_seconds: challengeTimeout(),
  };
}

/**
 * Verifies a signed challenge.
 *
 * Returns `{account, matched_home_domain, signers, verification}`. Every
 * failure path throws with a code; there is no path that returns success
 * without a verified signature from the account named in the challenge.
 *
 * What "verified" means depends on what the ledger knows: if the account
 * exists, its signers and thresholds are read from Horizon and the collected
 * weight must meet the account's medium threshold (the spec's rule for
 * multisig accounts). If the account is not on the ledger yet, the master
 * key alone is verified, which is exactly the case the spec reserves for
 * unfunded accounts. The method used is returned, never implied.
 */
async function verifyChallenge({transaction}) {
  const config = status();
  if (!config.configured) {
    const error = new Error('SEP-10 is not configured');
    error.code = 'not_configured';
    throw error;
  }
  if (!transaction || typeof transaction !== 'string') {
    const error = new Error('transaction must be a base64-encoded signed challenge transaction');
    error.code = 'invalid_transaction';
    throw error;
  }
  const {WebAuth} = sdk();
  const serverAccountID = config.signing_key;

  let read;
  try {
    read = WebAuth.readChallengeTx(
      transaction,
      serverAccountID,
      networkPassphrase(),
      homeDomain(),
      webAuthDomain()
    );
  } catch (cause) {
    const error = new Error(`the challenge could not be read: ${cause.message}`);
    error.code = 'invalid_transaction';
    throw error;
  }

  const record = await clientAccountRecord(read.clientAccountID);
  if (record) {
    const summary = record.signers || [];
    const threshold = record.thresholds ? Number(record.thresholds.med_threshold) || 0 : 0;
    try {
      const met = WebAuth.verifyChallengeTxThreshold(
        transaction,
        serverAccountID,
        networkPassphrase(),
        threshold,
        summary,
        homeDomain(),
        webAuthDomain()
      );
      return {
        account: read.clientAccountID,
        matched_home_domain: read.matchedHomeDomain,
        memo: read.memo || null,
        signers: met,
        verification: {method: 'threshold', med_threshold: threshold, signers_on_record: summary.length},
      };
    } catch (cause) {
      const error = new Error(`the collected signature weight does not meet ${read.clientAccountID}'s threshold ${threshold}: ${cause.message}`);
      error.code = 'unauthorized';
      throw error;
    }
  }

  let signers;
  try {
    signers = WebAuth.verifyChallengeTxSigners(
      transaction,
      serverAccountID,
      networkPassphrase(),
      [read.clientAccountID],
      homeDomain(),
      webAuthDomain()
    );
  } catch (cause) {
    const error = new Error(`the challenge was not signed by ${read.clientAccountID}: ${cause.message}`);
    error.code = 'unauthorized';
    throw error;
  }

  return {
    account: read.clientAccountID,
    matched_home_domain: read.matchedHomeDomain,
    memo: read.memo || null,
    signers,
    verification: {method: 'master_key', reason: 'account not on the ledger yet'},
  };
}

function horizonUrl() {
  const explicit = (process.env.HORIZON_URL || '').trim();
  if (explicit) return explicit.replace(/\/+$/, '');
  return networkName() === 'public' ? 'https://horizon.stellar.org' : 'https://horizon-testnet.stellar.org';
}

/** Loads the signer/threshold record for threshold verification; null when the account is unfunded. */
async function clientAccountRecord(account) {
  const response = await fetch(`${horizonUrl()}/accounts/${encodeURIComponent(account)}`, {
    headers: {accept: 'application/json'},
    signal: AbortSignal.timeout(6000),
  }).catch(() => null);
  if (!response) {
    const error = new Error(`Horizon is unreachable at ${horizonUrl()}, so signature weight cannot be proven`);
    error.code = 'upstream_unavailable';
    throw error;
  }
  if (response.status === 404) return null;
  if (!response.ok) {
    const error = new Error(`Horizon answered ${response.status} reading the signer record`);
    error.code = 'upstream_unavailable';
    throw error;
  }
  return response.json().catch(() => null);
}

function isAccountId(value) {
  try {
    const {StrKey} = sdk();
    return StrKey.isValidEd25519PublicKey(String(value || ''));
  } catch {
    return false;
  }
}

/** Reads SIGNING_KEY from a client domain's stellar.toml, as SEP-10 defines client attribution. */
async function clientDomainSigningKey(domain) {
  const response = await fetch(`https://${domain}/.well-known/stellar.toml`, {
    headers: {accept: 'text/plain'},
    signal: AbortSignal.timeout(5000),
  }).catch(() => null);
  if (!response || !response.ok) return null;
  const text = await response.text().catch(() => '');
  const match = text.match(/^\s*SIGNING_KEY\s*=\s*"?(G[A-Z0-9]{55})"?/m);
  return match ? match[1] : null;
}

/** Rejection reason for a token that is not a bearer of a valid session. */
function unauthenticated(code = 'unauthorized') {
  return errors.errorBody(code, 'SEP-10 authentication is required for this endpoint', {
    how: 'GET /v1/sep10/auth?account=<your G address>, sign the returned transaction with the account key, then POST it back to /v1/sep10/auth',
  });
}

module.exports = {
  status,
  buildChallenge,
  verifyChallenge,
  homeDomain,
  webAuthDomain,
  networkPassphrase,
  networkName,
  isAccountId,
  unauthenticated,
};
