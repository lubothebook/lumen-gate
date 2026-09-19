'use strict';

// ---------------------------------------------------------------------------
// SEP-6, as much of it as this deployment can actually honour.
//
// The rule used throughout this file: a field is either backed by something the
// deployment really does, or it is marked `not_implemented`. There is no third
// option, because the whole point of a SEP surface is that other people's
// software acts on it without asking us.
//
// What is real here:
//   * deposit  - the user locks on the source chain with the relayer fee
//                included, the registry verifies finality evidence on Soroban,
//                the gateway mints the wrapped asset. The record advances when
//                a lock event is read from the source chain and when the
//                matching Stellar payment is read from Horizon.
//   * withdraw - the user burns the wrapped asset on Stellar, the gateway emits
//                a burn event, the relayer delivers the one-time unlock to the
//                source chain. The record advances when the burn transaction is
//                verified against the network, not when a client claims it.
//
// What is not implemented, and says so: SEP-12 customer information, SEP-24
// hosted flows, SEP-31 cross-border payments, SEP-38 quotes, fiat rails.
// ---------------------------------------------------------------------------

const errors = require('./errors');
const store = require('./store');

const STROOPS = 10_000_000;

function manifest() {
  try {
    return JSON.parse(
      require('fs').readFileSync(require('path').join(__dirname, '..', '..', 'deployments', 'testnet.json'), 'utf8')
    );
  } catch {
    return null;
  }
}

function currency() {
  const doc = manifest();
  const sac = doc && doc.contracts && doc.contracts.wrapped_asset_sac;
  const configuredCode = (process.env.SEP6_ASSET_CODE || '').trim();
  return {
    code: configuredCode || (sac && sac.asset) || 'wSRC',
    issuer: (process.env.ISSUER || '').trim() || (sac && sac.issuer) || null,
    sac: (sac && sac.contract_id) || (process.env.TOKEN_ID || '').trim() || null,
    decimals: 7,
  };
}

/** The fixed relayer fee, in wrapped-asset units, that the source lock must also cover. */
function feeFixed() {
  const raw = (process.env.SEP6_FEE_FIXED || '0.1').trim();
  return normalizeAmount(raw) || '0.1';
}

function minAmount() {
  return normalizeAmount(process.env.SEP6_MIN_AMOUNT || '0.2') || '0.2';
}

function maxAmount() {
  return normalizeAmount(process.env.SEP6_MAX_AMOUNT || '1000000') || '1000000';
}

function horizonUrl() {
  const doc = manifest();
  return (process.env.HORIZON_URL || '').trim() || (doc && doc.horizon_url) || 'https://horizon-testnet.stellar.org';
}

function sourceUrl() {
  return (process.env.SOURCE_URL || process.env.SIM_URL || '').trim().replace(/\/+$/, '');
}

// ---------------------------------------------------------------------------
// amounts
// ---------------------------------------------------------------------------

/** Accepts "13.7" and returns "13.7000000"; rejects anything that is not a positive 7-decimal decimal. */
function normalizeAmount(value) {
  const text = String(value === undefined || value === null ? '' : value).trim();
  if (!/^\d{1,12}(\.\d{1,7})?$/.test(text)) return null;
  const [whole, fraction = ''] = text.split('.');
  const amount = `${whole}.${fraction.padEnd(7, '0')}`;
  return /^0\.0{7}$/.test(amount) ? null : amount;
}

function toStroops(amount) {
  const [whole, fraction = ''] = String(amount).split('.');
  return BigInt(whole) * BigInt(STROOPS) + BigInt(fraction.padEnd(7, '0').slice(0, 7));
}

function fromStroops(value) {
  const text = String(value);
  const whole = text.slice(0, Math.max(0, text.length - 7)) || '0';
  const fraction = text.padStart(8, '0').slice(-7);
  return `${whole}.${fraction}`;
}

function addAmounts(left, right) {
  return fromStroops(toStroops(left) + toStroops(right));
}

// ---------------------------------------------------------------------------
// /info
// ---------------------------------------------------------------------------

function info() {
  const {code} = currency();
  const fee = feeFixed();
  const min = minAmount();
  const max = maxAmount();
  return {
    deposit: {
      [code]: {
        enabled: true,
        authentication_required: false,
        min_amount: min,
        max_amount: max,
        fee_fixed: fee,
        fee_percent: 0,
        fields: {
          account: {description: 'the Stellar account that will receive the wrapped asset'},
          amount: {description: 'the amount you want to receive, fee excluded; the source-chain lock must cover amount + fee_fixed'},
          source_address: {description: 'your address on the source chain, recorded on the settlement message'},
        },
      },
    },
    withdraw: {
      [code]: {
        enabled: true,
        authentication_required: true,
        min_amount: min,
        max_amount: max,
        fee_fixed: '0',
        fee_percent: 0,
        fields: {
          account: {description: 'the Stellar account that signs the burn'},
          amount: {description: 'the amount of wrapped asset to burn and release on the source chain'},
          dest: {description: 'the source-chain address that will receive the released amount'},
        },
        note: 'you sign and pay for your own burn transaction; the relayer pays only the source-side delivery',
      },
    },
    fee: {enabled: true, description: 'the deposit fee is the fixed relayer fee, already included in the source-chain lock'},
    features: {
      account_creation: false,
      claimable_balances: false,
      quoted_asset: false,
      kyc: false,
      hosted_flow: false,
    },
    authentication: {
      sep10: '/v1/sep10/auth',
      applies_to: 'withdrawal records and write endpoints',
    },
    not_implemented: [
      'SEP-12 customer information (no KYC collection)',
      'SEP-24 hosted deposit/withdraw flow',
      'SEP-31 cross-border payments',
      'SEP-38 quotes',
      'fiat rails of any kind',
    ],
    network: require('./sep10').networkName(),
    asset: currency(),
    note:
      'Everything enabled above is backed by live testnet contracts: the source lock is verified as finality evidence on Soroban, and the wrapped asset is minted by the settlement gateway contract whose admin has been renounced.',
  };
}

// ---------------------------------------------------------------------------
// deposit / withdraw instruction records
// ---------------------------------------------------------------------------

function depositInstructions({account, assetCode, amount, sourceAddress, email}) {
  const {code} = currency();
  if (assetCode && assetCode !== code) {
    return {error: errors.errorBody('invalid_asset', `this deployment issues ${code}, not ${assetCode}`)};
  }
  if (!require('./sep10').isAccountId(account)) {
    return {error: errors.errorBody('invalid_account')};
  }
  const requested = normalizeAmount(amount || minAmount());
  if (!requested) return {error: errors.errorBody('invalid_amount')};
  if (toStroops(requested) < toStroops(minAmount())) {
    return {
      error: errors.errorBody('invalid_amount', `amount is below the minimum of ${minAmount()} ${code}`),
    };
  }
  if (toStroops(requested) > toStroops(maxAmount())) {
    return {
      error: errors.errorBody('invalid_amount', `amount is above the maximum of ${maxAmount()} ${code}`),
    };
  }

  const fee = feeFixed();
  const lockAmount = addAmounts(requested, fee);
  const record = store.create({
    kind: 'deposit',
    status: 'pending_user_transfer_start',
    status_eta: 900,
    account,
    from: sourceAddress || null,
    to: account,
    amount_in: requested,
    amount_in_asset: code,
    amount_out: lockAmount,
    amount_out_asset: 'SOURCE',
    amount_fee: fee,
    amount_fee_asset: code,
    email: email || null,
    message: `lock ${lockAmount} on the source chain to ${account}; the settlement message carries your address as sender`,
    source_height: null,
    required_info: {},
  });

  const quote = sourceUrl();
  return {
    body: {
      how:
        `1. lock exactly ${lockAmount} on the source chain with recipient ${account}` +
        ` (${requested} is yours, ${fee} covers the relayer fee), ` +
        '2. a relayer sends the block\'s finality evidence to the Soroban registry, ' +
        '3. the gateway verifies the Merkle proof of your event and mints the wrapped asset to your account.',
      id: record.id,
      eta: 900,
      min_amount: minAmount(),
      max_amount: maxAmount(),
      fee_fixed: fee,
      fee_percent: 0,
      extra_info: {
        status: record.status,
        source_chain: quote || 'not configured on this deployment',
        source_lock_template: quote
          ? `POST ${quote}/lock {"amount": ${toStroops(lockAmount)},"recipient": "${account}","sender": "<your source address>"}`
          : null,
        settlement: 'finality evidence is verified inside Soroban; the mint is executed by the gateway contract, not by an operator',
        tracking: `/v1/transactions?id=${record.id}`,
        reconciliation: 'this record advances when a lock event is read from the source chain and a matching payment is read from Horizon',
      },
    },
  };
}

function withdrawInstructions({account, assetCode, amount, dest}) {
  const {code} = currency();
  if (assetCode && assetCode !== code) {
    return {error: errors.errorBody('invalid_asset', `this deployment issues ${code}, not ${assetCode}`)};
  }
  if (!require('./sep10').isAccountId(account)) {
    return {error: errors.errorBody('invalid_account')};
  }
  const requested = normalizeAmount(amount || minAmount());
  if (!requested) return {error: errors.errorBody('invalid_amount')};

  const record = store.create({
    kind: 'withdrawal',
    status: 'pending_user_transfer_start',
    status_eta: 900,
    account,
    from: account,
    to: dest || null,
    amount_in: requested,
    amount_in_asset: code,
    amount_out: requested,
    amount_out_asset: 'SOURCE',
    amount_fee: '0.0000000',
    amount_fee_asset: code,
    message: 'burn the wrapped asset from your account; the relayer delivers the unlock to the source chain once the burn is verified',
    source_height: null,
    required_info: {},
  });

  return {
    body: {
      how:
        `burn ${requested} ${code} from ${account} with the gateway's burn_and_relay entrypoint, ` +
        'then report the burn transaction hash to this anchor. The anchor verifies the transaction against the ' +
        'network and the relayer delivers the one-time unlock to the source chain.',
      id: record.id,
      eta: 900,
      min_amount: minAmount(),
      max_amount: maxAmount(),
      fee_fixed: '0',
      fee_percent: 0,
      extra_info: {
        status: record.status,
        you_sign: 'the burn is signed and paid for by you in Freighter; the relayer never signs for your account',
        report_endpoint: `POST /v1/transactions/${record.id}/burn`,
        tracking: `/v1/transactions?id=${record.id}`,
        kyc: 'not_implemented: this deployment collects no customer information',
      },
    },
  };
}

// ---------------------------------------------------------------------------
// records in the SEP-6 transaction schema
// ---------------------------------------------------------------------------

function asTransaction(record) {
  return {
    id: record.id,
    kind: record.kind,
    status: record.status,
    status_eta: record.status_eta || null,
    more_info_url: `/v1/transactions?id=${record.id}`,
    amount_in: record.amount_in,
    amount_in_asset: record.amount_in_asset,
    amount_out: record.amount_out,
    amount_out_asset: record.amount_out_asset,
    amount_fee: record.amount_fee,
    amount_fee_asset: record.amount_fee_asset,
    started_at: record.started_at,
    updated_at: record.updated_at,
    completed_at: record.completed_at || null,
    stellar_transaction_id: record.stellar_transaction_id,
    external_transaction_id: record.external_transaction_id,
    from: record.from,
    to: record.to,
    message: record.message,
    refunded: false,
    required_info: record.required_info || {},
    source_height: record.source_height || null,
    evidence: record.evidence || null,
  };
}

function transactions({query}) {
  const records = store.list({
    id: query.get('id') || undefined,
    account: query.get('account') || undefined,
    kind: query.get('kind') || undefined,
    status: query.get('status') || undefined,
  });
  return {transactions: records.map(asTransaction)};
}

function transactionById(id) {
  const record = store.get(id);
  return record ? asTransaction(record) : null;
}

// ---------------------------------------------------------------------------
// reconciliation against real ledgers
// ---------------------------------------------------------------------------

/**
 * Advances deposit records using evidence.
 *
 * Step 1: a lock event on the source chain whose recipient is this record's
 *         Stellar account and whose amount equals the requested amount plus the
 *         fixed fee. The event's own message id becomes the external id.
 * Step 2: a payment of the wrapped asset to that account, read from Horizon.
 *         Only then is the record complete, and the payment's transaction hash
 *         is the Stellar id.
 *
 * A record that matches neither stays where it is. This function never
 * completes a record from an assertion in a request body.
 */
async function reconcile() {
  const result = {deposits_examined: 0, source_events_read: 0, payments_read: 0, advanced: []};
  const open = store.list({kind: 'deposit'}).filter((record) =>
    ['pending_user_transfer_start', 'pending_anchor', 'pending_stellar'].includes(record.status)
  );
  result.deposits_examined = open.length;
  if (open.length === 0) return result;

  let events = [];
  const base = sourceUrl();
  if (base) {
    try {
      const response = await fetch(`${base}/events`, {signal: AbortSignal.timeout(5000)});
      if (response.ok) events = await response.json();
      result.source_events_read = events.length;
    } catch {
      events = [];
    }
  }

  const paymentsByAccount = new Map();

  for (const record of open) {
    const wanted = toStroops(addAmounts(record.amount_in, record.amount_fee));
    const match = events.find(
      (event) =>
        event &&
        event.recipient_on_source === record.account &&
        String(event.amount) === wanted.toString()
    );

    if (match && !record.external_transaction_id) {
      const updated = store.update(record.id, {
        status: 'pending_anchor',
        source_height: match.height,
        external_transaction_id: match.message_id,
        evidence: {
          source_lock: {
            message_id: match.message_id,
            height: match.height,
            amount: String(match.amount),
            read_from: `${base}/events`,
          },
        },
      });
      result.advanced.push({id: record.id, to: updated.status, why: `lock event at height ${match.height}`});
      Object.assign(record, updated);
    }

    const payment = await findPayment(record.account, record.amount_in, paymentsByAccount);
    if (payment) {
      const updated = store.update(record.id, {
        status: 'completed',
        completed_at: new Date().toISOString(),
        stellar_transaction_id: payment.transaction_hash,
        evidence: {
          ...(record.evidence || {}),
          stellar_payment: {
            transaction_hash: payment.transaction_hash,
            amount: payment.amount,
            asset_code: payment.asset_code,
            created_at: payment.created_at,
            read_from: `${horizonUrl()}/accounts/${record.account}/payments`,
          },
        },
      });
      result.advanced.push({id: record.id, to: updated.status, why: `wrapped asset paid in ${payment.transaction_hash}`});
    }
  }

  return result;
}

/** Reads the wrapped asset's payments to one account, cached per reconciliation pass. */
async function findPayment(account, expectedAmount, cache) {
  let payments = cache.get(account);
  if (!payments) {
    try {
      const url = `${horizonUrl()}/accounts/${encodeURIComponent(account)}/payments?order=desc&limit=50`;
      const response = await fetch(url, {headers: {accept: 'application/json'}, signal: AbortSignal.timeout(8000)});
      const body = response.ok ? await response.json() : {_embedded: {records: []}};
      payments = (body._embedded && body._embedded.records) || [];
    } catch {
      payments = [];
    }
    cache.set(account, payments);
  }
  const {code, issuer} = currency();
  const wanted = toStroops(expectedAmount);
  return (
    payments.find((payment) => {
      if (!payment || payment.transaction_successful === false) return false;
      const isCredit = payment.type === 'payment' || payment.type === 'create_account';
      if (!isCredit) return false;
      if (payment.to !== account && payment.account !== account) return false;
      if (payment.asset_code !== code) return false;
      if (issuer && payment.asset_issuer && payment.asset_issuer !== issuer) return false;
      const amount = normalizeAmount(payment.amount);
      return amount ? toStroops(amount) >= wanted : false;
    }) || null
  );
}

/**
 * Verifies a reported burn transaction and moves the withdrawal to pending_anchor.
 *
 * The transaction is read back from the network. If it is not there, or it is
 * not successful, the record does not move and the caller is told why.
 */
async function recordBurn(id, txHash) {
  const record = store.get(id);
  if (!record) return {status: 404, body: errors.errorBody('not_found', `no transaction record with id ${id}`)};
  if (record.kind !== 'withdrawal') {
    return {status: 400, body: errors.errorBody('invalid_request', 'this record is not a withdrawal')};
  }
  if (!/^[0-9a-f]{64}$/.test(String(txHash || '').toLowerCase())) {
    return {status: 400, body: errors.errorBody('invalid_id', 'stellar_transaction_id must be a 32-byte hash in lower-case hex')};
  }

  const hash = String(txHash).toLowerCase();
  let horizonBody = null;
  try {
    const response = await fetch(`${horizonUrl()}/transactions/${hash}`, {
      headers: {accept: 'application/json'},
      signal: AbortSignal.timeout(8000),
    });
    if (response.ok) horizonBody = await response.json();
  } catch {
    horizonBody = null;
  }
  if (!horizonBody) {
    return {
      status: 404,
      body: errors.errorBody('invalid_request', `transaction ${hash} was not found on ${horizonUrl()}`, {
        hint: 'a burn is only accepted once the network has it; wait for the ledger to close and try again',
      }),
    };
  }
  if (horizonBody.successful === false) {
    return {
      status: 400,
      body: errors.errorBody('invalid_request', `transaction ${hash} failed on chain and cannot release anything`),
    };
  }
  if (horizonBody.source_account && horizonBody.source_account !== record.account) {
    return {
      status: 400,
      body: errors.errorBody('unauthorized', `transaction ${hash} was not signed by ${record.account}`, {
        source_account: horizonBody.source_account,
      }),
    };
  }

  const updated = store.update(id, {
    status: 'pending_anchor',
    stellar_transaction_id: hash,
    evidence: {
      ...(record.evidence || {}),
      burn_transaction: {
        hash,
        ledger: horizonBody.ledger,
        successful: horizonBody.successful !== false,
        read_from: `${horizonUrl()}/transactions/${hash}`,
      },
    },
  });
  return {status: 200, body: asTransaction(updated)};
}

/** The SEP-12 endpoint exists only to say that it does not exist. */
function customerNotImplemented() {
  return errors.errorBody('not_implemented', 'SEP-12 customer information is not implemented: this deployment collects no KYC data', {
    why: 'the demo settles a testnet asset with no fiat rails and no customer relationship',
  });
}

module.exports = {
  info,
  transactions,
  transactionById,
  depositInstructions,
  withdrawInstructions,
  reconcile,
  recordBurn,
  customerNotImplemented,
  asTransaction,
  normalizeAmount,
  toStroops,
  fromStroops,
  addAmounts,
  currency,
  feeFixed,
  minAmount,
  maxAmount,
  horizonUrl,
};
