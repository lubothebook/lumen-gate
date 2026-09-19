pragma circom 2.0.0;
include "circomlib/poseidon.circom";
include "circomlib/comparators.circom";

/*
M-of-N finality circuit for Migrate to Stellar
Proves: at least M of N EdDSA signatures over a state root are valid
Simplified for hackathon: we use Poseidon hash and range check as placeholder
Public inputs: state_root, threshold
Private: signers bitmap, etc.

For demo we use range_proof circuit from stellar-zkstream as working example:
- Proves a value is in [0, 1e9) without revealing it
- Commitment = Poseidon(value, salt)
- This pattern can be extended to M-of-N: commitment = hash(state_root), value = threshold met
*/

template MOfN(n, m) {
    signal input state_root;
    signal input threshold;
    signal input pubkeys[n][2];
    signal input signatures[n][3];
    signal input enabled[n];

    signal output valid;

    // Simplified: count enabled signers >= threshold
    component sum = 0;
    var count = 0;
    for (var i=0; i<n; i++) {
        count += enabled[i];
    }
    // Check count >= m
    component ge = GreaterEqThan(8);
    ge.in[0] <== count;
    ge.in[1] <== m;
    ge.out === 1;

    // Dummy Poseidon to bind state_root
    component poseidon = Poseidon(2);
    poseidon.inputs[0] <== state_root;
    poseidon.inputs[1] <== threshold;
    
    valid <== ge.out;
}

component main {public [state_root, threshold]} = MOfN(5, 3);
