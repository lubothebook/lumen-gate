pragma circom 2.0.0;

/*
  The gate-vm lane at quadrupled scale: 32 program lines, a 32-row window,
  the same eight registers and the same twelve-bit instruction encoding.

  This is not a second machine. It is one machine compiled twice, and the
  point of keeping both in the repository is the claim neither alone makes:
  the constraint density per row is a property of the ISA, so a reviewer can
  diff the two build reports and see the growth is linear in the window —
  which is what "the window is the gas" means when someone has to pay for
  it. The program counter here addresses five bits, and that width is
  derived from K in the core rather than written down, so no file can claim
  a bound its own instantiation cannot enforce.

  Same public-input order, same domain tag, same ceremony caveat.
*/

include "gate_vm_core.circom";

component main {public [program_root, start_root, event_root, end_root, hash_steps, domain_tag]} = GateVm(32, 32, 8);
