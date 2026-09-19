pragma circom 2.0.0;

/*
  The gate-vm lane at its shipped size: K = T = R = 8.

  All the semantics — the fold commitment, the decode, the register muxes, the
  window-as-gas — live in gate_vm_core.circom, which this file instantiates at
  the one size the committed vectors, the deployed key and the audit readback
  are about. The 32-line sibling (gate_vm32.circom) instantiates the same core
  at the other size; neither file repeats a constraint the other does not have.

  The long form of what the proof says, and everything it deliberately does
  not claim, is section 5d of docs/PROVING_SYSTEM.md.
*/

include "gate_vm_core.circom";

component main {public [program_root, start_root, event_root, end_root, hash_steps, domain_tag]} = GateVm(8, 8, 8);
