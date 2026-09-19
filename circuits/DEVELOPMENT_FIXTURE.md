# Groth16 fixture quarantine

`range_proof_vk.hex`, `range_proof_proof.hex`, and
`range_proof_public_inputs.json` are checked-in development artifacts only.
They are retained so the local source simulator and the negative-probe UI can
exercise the Groth16 payload shape, but they are not a finality proof for a
source block.

The fixture's public commitment is not derived from the simulator's current
`state_root` or `event_root`. The registry therefore binds the submitted
commitment to the payload and rejects declared-root mismatches, while the
relayer refuses to use this fixture unless
`ALLOW_DEVELOPMENT_ZK_FIXTURE=1` is explicitly set. The deployment script also
leaves the VK and ZK domain out of a normal deployment unless that flag is set.
Neither setting is a live trustless or production claim.

A live ZK path requires regenerating the circuit and trusted setup with public
inputs that commit to the source height, source state root, and event root,
then recording positive and negative Testnet receipts. Until that work is
complete, BLS is the only intended live proof path and the fixture must remain
quarantined.
