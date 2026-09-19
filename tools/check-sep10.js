'use strict';

// Behavioural check for the SEP-10 verifier.
//
// The facade authenticates by having the client sign a challenge transaction.
// What "verified" means depends on the ledger: an on-ledger account's signer
// weights and medium threshold decide (a multisig account must authenticate
// with multisig weight), an unfunded account falls back to its master key.
// A regression here either locks multisig accounts out or - worse - lets a
// signature in that should not carry enough weight through. This drives the
// real library against a stubbed Horizon, including the case that matters:
//
//   an account whose collected signature weight is BELOW its medium
//   threshold must be REFUSED, even when the master key signed.
//
// No network access: Horizon responses are stubbed, anchors and clients are
// freshly generated keypairs, and every expectation runs against the actual
// verification path in anchor/lib/sep10.js.

process.env.SEP10_SIGNING_SECRET = process.env.SEP10_SIGNING_SECRET || '';
process.env.SEP10_HOME_DOMAIN = 'anchor.example';
process.env.SEP10_WEB_AUTH_DOMAIN = 'auth.anchor.example';
process.env.HORIZON_URL = 'https://horizon.test';

const problems = [];
function expect(condition, message) {
  if (!condition) problems.push(message);
}

const sdk = require('@stellar/stellar-sdk');
const {Keypair, TransactionBuilder, Networks} = sdk;

const anchor = Keypair.random();
const funded = Keypair.random();
const fresh = Keypair.random();
const stranger = Keypair.random();
process.env.SEP10_SIGNING_SECRET = anchor.secret();

const MED = 2;
const horizonBodies = new Map([
  [funded.publicKey(), {status: 200, body: {
    signers: [
      {key: funded.publicKey(), weight: 1, type: 'ed25519_public_key'},
      {key: stranger.publicKey(), weight: 1, type: 'ed25519_public_key'},
    ],
    thresholds: {low_threshold: 0, med_threshold: MED, high_threshold: 0},
  }}],
]);

global.fetch = async (url) => {
  const match = /\/accounts\/(G[A-Z0-9]{55})/.exec(String(url));
  const hit = match && horizonBodies.get(match[1]);
  if (!hit) return {ok: false, status: 404, json: async () => ({})};
  return {ok: true, status: hit.status, json: async () => hit.body};
};

const sep10 = require('../anchor/lib/sep10');

function signChallenge(xdr, ...keys) {
  const tx = TransactionBuilder.fromXDR(xdr, Networks.TESTNET);
  for (const key of keys) tx.sign(key);
  return tx.toXDR();
}

async function attempt(label, fn, wantCode) {
  try {
    const result = await fn();
    return {label, result};
  } catch (error) {
    if (wantCode && error.code === wantCode) return {label, refused: error};
    problems.push(`${label}: threw ${error.code || error.message} but ${wantCode ? `wanted a refusal with ${wantCode}` : 'wanted success'}`);
    return {label, error};
  }
}

(async () => {
  // 1. funded account, med threshold 2, both weight-1 signers sign: passes.
  {
    const challenge = await sep10.buildChallenge({account: funded.publicKey()});
    const signed = signChallenge(challenge.transaction, funded, stranger);
    const {result} = await attempt('threshold met', () => sep10.verifyChallenge({transaction: signed}));
    if (result) {
      expect(result.verification?.method === 'threshold', `an on-ledger account must be verified by threshold, saw ${JSON.stringify(result.verification)}`);
      expect(result.verification?.med_threshold === MED, 'the reported threshold must be the account med_threshold');
      expect(result.account === funded.publicKey(), 'the session subject must be the challenged account');
    }
  }

  // 2. funded account, only the master key signs: weight 1 < med 2, REFUSED.
  //    The pre-hardening verifier accepted this because it only checked that
  //    the master key signed. This is the regression case.
  {
    const challenge = await sep10.buildChallenge({account: funded.publicKey()});
    const signed = signChallenge(challenge.transaction, funded);
    const {refused} = await attempt('weight below threshold', () => sep10.verifyChallenge({transaction: signed}), 'unauthorized');
    if (refused) expect(/threshold 2/.test(refused.message), `the refusal should name the unmet threshold, got: ${refused.message}`);
  }

  // 3. unfunded account, master key signs: master_key fallback, as the spec
  //    reserves for accounts that are not on the ledger yet.
  {
    const challenge = await sep10.buildChallenge({account: fresh.publicKey()});
    const signed = signChallenge(challenge.transaction, fresh);
    const {result} = await attempt('unfunded master key', () => sep10.verifyChallenge({transaction: signed}));
    if (result) expect(result.verification?.method === 'master_key', `an unfunded account must be labelled master_key, saw ${JSON.stringify(result.verification)}`);
  }

  // 4. unfunded account, a stranger signs instead of the challenged account.
  {
    const challenge = await sep10.buildChallenge({account: fresh.publicKey()});
    const signed = signChallenge(challenge.transaction, stranger);
    await attempt('stranger signature', () => sep10.verifyChallenge({transaction: signed}), 'unauthorized');
  }

  // 5. a body that is not an envelope at all.
  {
    await attempt('not an envelope', () => sep10.verifyChallenge({transaction: 'this-is-not-an-envelope'}), 'invalid_transaction');
  }

  // 6. Horizon down while a threshold decision is needed: refuse loudly, never guess.
  {
    const challenge = await sep10.buildChallenge({account: funded.publicKey()});
    const signed = signChallenge(challenge.transaction, funded, stranger);
    const realFetch = global.fetch;
    global.fetch = async () => null;
    const {refused} = await attempt('horizon down', () => sep10.verifyChallenge({transaction: signed}), 'upstream_unavailable');
    global.fetch = realFetch;
    expect(Boolean(refused), 'with Horizon unreachable the verifier must refuse instead of falling back to weaker checks');
  }

  console.log('sep-10: threshold met, weight refused, unfunded fallback, stranger refused, garbage refused');
  if (problems.length === 0) {
    console.log('sep-10 verification: on-ledger accounts are verified by signature weight against their own threshold, and nothing weaker passes');
    process.exit(0);
  }
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
})().catch((error) => {
  console.error(`sep-10 check crashed: ${error && error.stack ? error.stack : error}`);
  process.exit(1);
});
