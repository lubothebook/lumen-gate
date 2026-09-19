// GENERATED FILE - do not edit by hand.
//
// Source: deployments/testnet.json, written by tools/sync-frontend-deployment.mjs.
// Every value here is a live testnet fact recorded next to the transaction that
// produced it. If a value looks wrong, fix the manifest and regenerate; do not
// patch this file.
export const deployment = {
  "network": "testnet",
  "passphrase": "Test SDF Network ; September 2015",
  "rpcUrl": "https://soroban-testnet.stellar.org",
  "horizonUrl": "https://horizon-testnet.stellar.org",
  "registryId": "CCXJDQMTJUGXKNFOQPC25IYVOAVWDMLJBNQYX75MAREHV7MZMU5OSEN4",
  "gatewayId": "CBUKVNCPF5XRYJVAH2SRLTLUMZT6T677T5KAJADXZIQOQTCTSBITQVPA",
  "tokenId": "CBPBDVLP7K436KEXOAJMPFFHEF5OXNN4KJIB2HDFDBRWOABQ6WBTURRV",
  "sourceDomainKey": "4c00370b422dcf0f72234af78a49d2fafa5196c3ee6b19f2b6a8e815f587137e",
  "targetDomain": "30e4a8e86c86dd7efbf8e589bc2055dd42f3f6e18569103e44eccc1e01cf8ef1",
  "adapterId": "3dcbf6f582455337083d5f6d36721f6d63d47af0bef870a043c02aca7850dac9",
  "generatedFrom": "deployments/testnet.json"
};

// Lanes of this deployment, read from the receipts only at generation time.
export const lanes = {
  "sources": [
    "deployments/self-audit.json",
    "deployments/merged-registry.json",
    "deployments/testnet.json",
    "deployments/step-chain.json",
    "deployments/execution-lane.json",
    "deployments/gate-vm-lane.json"
  ],
  "meaning_of_dash": "the receipts record nothing here — which is not the same as zero",
  "last_audit": {
    "round": 21,
    "passed": 14,
    "total": 14,
    "all_passed": true,
    "finished_at": "2026-09-19T22:41:40.157Z",
    "registry": "CCXJDQMTJUGXKNFOQPC25IYVOAVWDMLJBNQYX75MAREHV7MZMU5OSEN4"
  },
  "merged_registry": {
    "contract_id": "CB7ZKFLTSNRKLFE25T4E4R6K3GNEMVLQ5J7UPNHLEPVH35UYHBSGUNXL",
    "all_lanes_passed": true,
    "lane_suites": {
      "step-chain": {
        "checks": 11,
        "passed": 11,
        "honest_transaction": "7a02309529039fb8da15bbb62b8673cd5832130c5b29190b2e511fb0e2d73c54"
      },
      "execution": {
        "checks": 13,
        "passed": 13,
        "honest_transaction": "a6ad1bd41768efd8e17f0614322b8ea4f028145a7dbec6a6bcafb8e4a13b5e32"
      },
      "gate-vm": {
        "checks": 13,
        "passed": 13,
        "honest_transaction": "d2e7c9a3d58ca61bcf39146b609ce8284ba1b89de715fe743b1952a65a30f0ae"
      }
    },
    "record": "deployments/merged-registry.json"
  },
  "settlement": {
    "registry": "CCXJDQMTJUGXKNFOQPC25IYVOAVWDMLJBNQYX75MAREHV7MZMU5OSEN4",
    "admin_state": "renounced - permanently given up, see the renounce_admin receipt",
    "last_finalized_height": null
  },
  "step_chain": {
    "recorded": true,
    "registry": "CCR3NZD5ASZAC3RPHDJOVSHWZBIF46ELP3JGWFC37ZL65YZ443ULZLMM",
    "honest_transaction": "2269641ad8895d61004d550b6cb4d09ba2cc500236dcbcb23db341c959cc3649",
    "checks": "12/12",
    "ledger": "4766775",
    "fee_stroops": "176733"
  },
  "execution": {
    "recorded": true,
    "registry": "CAQ77OEKCHLLCE36MOHY6NO3YJU45FTRLY73REQW4DI5TQMFMZZ5G6LK",
    "honest_transaction": "70cb914ad86535ed9a9ba6eefd57f7bade0011f45fe3fa5f2b1b3a26aadc0601",
    "checks": "14/14",
    "ledger": "4766780",
    "fee_stroops": "212091"
  },
  "gate_vm": {
    "recorded": true,
    "registry": "CDWJWDJVCB72ZFVVYVTIY4ZQF2676CJWWKXOSJCC7KQCGS2EI5ZKXI6T",
    "honest_transaction": "6d67f5f402fc954b6e3cbdc94234a649409cfd246c4a6f489c679acb5e26d7e8",
    "checks": "14/14",
    "ledger": "4765859",
    "fee_stroops": "177143"
  },
  "gate_vm32": {
    "recorded": true,
    "registry": "CB7ZKFLTSNRKLFE25T4E4R6K3GNEMVLQ5J7UPNHLEPVH35UYHBSGUNXL",
    "honest_transaction": "1a32641b8d9b8c08ed8276fc55d2c38ecfc395bea142b5d27e4fd8ef973e53b6",
    "ledger": "4766791",
    "fee_stroops": "181707",
    "submitted_by": "an account generated at run time, configured nowhere"
  }
};

export default deployment;
