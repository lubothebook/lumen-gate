// Source chain simulator client
const SIM_URL = (typeof localStorage !== 'undefined' ? localStorage.getItem('simUrl') : null) || 'http://localhost:3001';

export async function getInfo() {
  const res = await fetch(`${SIM_URL}/info`);
  return res.json();
}

export async function getLatestBlock() {
  const res = await fetch(`${SIM_URL}/blocks/latest`);
  return res.json();
}

export async function lock(amount: number, recipient: string) {
  const res = await fetch(`${SIM_URL}/lock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ amount, recipient, sender: 'frontend-demo' })
  });
  return res.json();
}

export async function getProof(height: number, kind: 'bls' | 'zk' = 'bls', tamper?: string) {
  let url = `${SIM_URL}/proof?height=${height}&kind=${kind}`;
  if (tamper) url += `&tamper=${tamper}`;
  const res = await fetch(url);
  return res.json();
}

export async function getEvents(height?: number) {
  let url = `${SIM_URL}/events`;
  if (height) url += `?height=${height}`;
  const res = await fetch(url);
  return res.json();
}
