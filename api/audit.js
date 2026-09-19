'use strict';

// GET /api/audit
//
// Serves the record written by anchor/self-audit.js. This is a read-only
// mirror of a file in the repository: the hosted console cannot run the audit
// itself, because the audit needs to advance the source chain and sign
// transactions. It reports; it does not approve.

const { loadAuditRecord, send, sendError } = require('./_shared');

module.exports = async function handler(req, res) {
  const record = loadAuditRecord();
  if (!record) {
    sendError(res, 404, 'no_audit_record', 'deployments/self-audit.json was not found in this deployment');
    return;
  }
  send(res, 200, record, { cacheSeconds: 30 });
};
