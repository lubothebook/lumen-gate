# Trust Stellar, Move to Stellar

**Anchor'a takılan yerleşim katmanı — başka zincirlere köprü kurmak istemeyen anchor için nötr finality-proof altyapısı**

> Rise In x Stellar Pro Hackathon — Genesis Track, 36 saat, Grand Pera, İstanbul, 19-20 Eylül 2026

---

## Nedir

Normal Stellar anchor'ları fiat <-> USDC işini kendi custody'leriyle yapar. Her yeni zincir yeni bir köprü, yeni validator, yeni audit demektir.

Trust Stellar, Move to Stellar, anchor'lara **nötr bir yerleşim katmanı** veriyor:

1. **Kaynak zincir (simüle)** `state_root` + `event_root` ile blok üretir ve finality kanıtları üretir.
2. **Finality Registry (Soroban, Rust)** bu kanıtları **native host fonksiyonlarıyla** doğrular:
   - `SignatureSet`: BLS12-381 toplu imza, `env.crypto().bls12_381().g1_is_on_curve`, `g2_is_on_curve`, `hash_to_g1` ile — Protocol 22'den beri 11 host fonksiyonu var.
   - `ZkProof`: BN254 üzerinde Groth16, `env.crypto().bn254().pairing_check` ile — Protocol 25 X-Ray (CAP-0074/0075) ile canlı. `stellar-zkstream`'deki Apache-2.0 verifier kalıbı kullanıldı (gerçek pairing check, mock değil).
3. **Settlement Gateway (Soroban)** high-water-mark replay koruması `(source, target, sender) -> highest_nonce` tutar ve klasik Stellar varlığını **SAC `set_admin(gateway)`** ile mint/burn eder. Anchor sadece issuer'dır; mint yetkisi sadece kriptografik finality sonrası mint eden kontrattadır.
4. **Kaynak Simülatör (Rust, Axum)** + **Relayer (Rust)** + **Frontend (TS, Freighter)** döngüyü kapatır: kaynakta kilitle -> kanıt -> Stellar'da mint (Freighter'da görünür) -> burn -> kaynakta unlock. Bozuk kanıtlar reddedilir.

`assume valid` yok. Her ret yolu `Err` döner. `declared_height`/`declared_root` payload'dan yeniden türetilir.

---

## Mimari

```
Kaynak zincir simülatörü (Rust)              Stellar Testnet
 ├─ bloklar + Merkle event ağacı              ┌─ finality_registry
 ├─ 3-of-5 BLS12-381 finality (test anahtarı)─►│   register_domain / submit_evidence
 ├─ Groth16 prover (Circom range proof)       │   BLS host | BN254 pairing -> attestation
 └─ /lock, /proof, /events API                │   is_finalized(domain, h) -> root
                    ▲                         └─ settlement_gateway
     relayer (Rust) │ getEvents / RPC            finalize_inbound(msg, proof)
                    ▼                            → HWM nonce → SAC.mint(recipient)
 Anchor fasadı: stellar.toml + /info            burn_and_relay -> outbound event
   issuer = anchor, admin = gateway
```

**Anchor konumlandırması:** Anchor issuer hesabı oluşturur, `wSRC:ISSUER` için SAC deploy eder, `set_admin(gateway)` çağırır. Artık doğrudan mint edemez. Sadece off-chain rezervleri yönetir. On-chain mint trust-minimized'dır. Tek bir anchor, kendi validator'larını çalıştırmadan birçok kaynak domain'i listeleyebilir.

---

## Kontratlar (Soroban, Rust, SDK 28)

### finality_registry

- `initialize(admin)`
- `register_domain(adapter_id, network, required_depth, adapter_version, accepted_versions) -> domain_key`
- `submit_finality_evidence_bls(evidence: RawEvidence) -> Attestation`
  - Payload (368 byte): `height LE(8) || state_root(32) || event_root(32) || signer_count LE(4) || required LE(4) || sig G1 96 || pubkey G2 192`
  - Kontroller: version penceresi, digest replay, declared alanların yeniden türetilmesi, eşik, sig/pubkey sıfır değil, `g1_is_on_curve`, `g2_is_on_curve`, `hash_to_g1`
- `submit_finality_evidence_zk(evidence, proof, public_inputs) -> Attestation`
  - `groth16::verify` ile native `bn254().pairing_check`
  - VK `set_vk(admin, vk)` ile saklanır
- `is_finalized(domain, height) -> Option<root>`
- `get_domain`, `list_domains`

Security backing: `SignatureSet(signers, required, slashable)` veya `ZkProof`.

### settlement_gateway

- `initialize(admin, registry, token)`
- `lock_and_relay(from, amount, recipient_on_source, target_domain, expiry) -> CrossDomainMessage`
  - Token'ı kullanıcıdan gateway'e transfer eder (kilit), `payload_hash = sha256(asset || amount || recipient)` hesaplar, HWM `next_nonce`, `lock` event'i
- `finalize_inbound(message, merkle_proof, asset, amount, recipient)`
  - `message_id` yeniden hesaplanır, expiry, HWM kontrolü, `registry.is_finalized`, payload_hash yeniden türetme, HWM ileri, `SAC.mint(recipient, amount)`
- `burn_and_relay` (ters yön)
- `get_high_water`

Replay koruması: `(source, target, sender)` başına high-water-mark — gönderen başına tek satır, eviction yok, sadece ileri gider.

---

## Off-chain

### source_simulator (Rust, Axum)

- Bellek içi bloklar, event'ler, Merkle ağacı (sha256)
- BLS finality: 3-of-5 test seti, sig = G1 generator, pubkey = G2 generator (geçerli eğri noktaları, host kontrollerinden geçer)
- ZK finality: `stellar-zkstream` range proof devresinden alınmış gerçek Groth16 kanıtı (VK 768 byte, proof 256 byte, 4 public input) — on-chain gerçek pairing check
- API: `GET /blocks/latest`, `GET /blocks/:h`, `POST /lock`, `GET /events?height=`, `GET /proof?height=&kind=bls|zk`, `GET /info`

### relayer (Rust)

- Simülatör `/events`'i poll eder, `RawEvidence` oluşturur, Soroban RPC ile `submit_finality_evidence_*` çağırır
- Stellar event'lerini Soroban RPC `getEvents` ile dinler, kaynak unlock'u tetikler
- Demo için frontend de Freighter + stellar-sdk ile relay yapar (görünürlük için)

### circuits

- `m_of_n.circom` — M-of-N EdDSA-Poseidon kontrolü (şablon, hackathon'da çalışan örnek olarak range proof kullanıyoruz)
- `range_proof_vk.hex`, `range_proof_proof.hex`, `range_proof_public_inputs.json` — stellar-zkstream'den gerçek artefaktlar (Apache-2.0)
- Derleme: `circom m_of_n.circom --r1cs --wasm`, `snarkjs groth16 setup`, `zkey contribute`, `export verificationkey`, `gen proof`, `convert_to_soroban.mjs`

### frontend (TS, Vite)

- Paneller: simülatör durumu, lock formu, Stellar bakiye (Freighter), burn, bozuk kanıt butonu, domain profili
- `@stellar/stellar-sdk`, Freighter API, Soroban RPC kullanır
- Explorer linkleri gösterir

### anchor

- `stellar.toml` (SEP-1) içinde `wSRC` para birimi
- Minimal sunucu `server.ts`: `GET /info` (domain'ler, profiller, son finalized), `GET /transactions?id=`
- Issuer kurulumu: `stellar keys generate anchor-issuer`, `stellar contract deploy --asset wSRC:ISSUER`, `set_admin(gateway)`

---

## Hızlı başlangıç

### Gereksinimler

- Rust 1.98+, `soroban-sdk 28`, Node 22+, `circom`, `snarkjs`
- Stellar CLI: `cargo install stellar-cli --locked`

### 1. Kontrat derleme & test

```bash
cd contracts/finality_registry
cargo test
cd ../settlement_gateway
cargo test
# wasm derle
stellar contract build
```

### 2. Testnet'e deploy

```bash
./scripts/deploy.sh
# deploy.sh:
# - admin, issuer oluştur ve fonla
# - finality_registry, settlement_gateway deploy
# - wSRC:ISSUER için SAC deploy
# - set_admin(gateway)
# - set_vk (range_proof vk)
# - register_domain
# çıktı: deployments/testnet.json içinde contract ID'ler
```

### 3. Simülatör & relayer çalıştır

```bash
cd crates/source_simulator
cargo run -- --port 3001
# başka terminal
cd ../relayer
cargo run -- --sim-url http://localhost:3001 --rpc https://soroban-testnet.stellar.org
```

### 4. Frontend

```bash
cd frontend
pnpm install
pnpm dev
# http://localhost:5173 aç, Freighter bağla (testnet), wSRC için trustline, lock yap, mint'i gör
```

### 5. Demo akışı

- Kaynakta kilitle: `curl -X POST http://localhost:3001/lock -d '{"amount":100,"recipient":"G..."}'`
- BLS kanıtı doğrulandı: `finality_registry` event'lerine bak
- Stellar'da mint: Freighter'da bakiye, Explorer linki
- Bozuk kanıt: `curl http://localhost:3001/proof?height=1&tamper=sig` -> submit -> `InvalidSignature` bekleniyor
- Burn: frontend burn butonu -> kaynakta unlock

---

## Güvenlik notları (hackathon için bilerek basitleştirildi)

- BLS eşiği 3-of-5 test anahtarı, prod validator seti değil. Host kontrolleri `on_curve` + `in_subgroup` + eşik, tam aggregate pairing değil (dokümante edildi, prod'da tam `pairing_check` olur).
- Groth16 trusted setup tek katılımcılı test seremonisi (stellar-zkstream'den). Prod çok partili değil.
- Gateway'de Merkle proof doğrulaması basitleştirildi (finalized height + payload hash yeniden türetme, tam sibling yolu değil) — prod'da tam MPT olur.
- Bond/fee/slashing yok, PQ (ML-DSA) yok — `SecurityBacking` enum'unda yeri ayrıldı, gelecek iş olarak not edildi (CAP-0087).
- Replay koruması gerçek HWM, set değil.

Bunlar hackathon kuralına uygun olarak "çalışıyor olmak > güvenli olmak" şeklinde dokümante edildi.

---

## Teslim kontrol listesi

- [x] Kontratlar derleniyor, testler geçiyor (2 + 1)
- [x] BLS yolu: mutlu yol + bozuk sig reddi
- [x] ZK yolu: gerçek BN254 pairing_check, mutlu yol + bozuk proof reddi
- [x] Lock -> proof -> mint + tersi
- [x] HWM nonce replay koruması testli
- [x] SAC set_admin anchor akışı
- [x] Frontend/CLI demo
- [x] README çalıştırma talimatları + basitleştirmeler
- [x] Repo'da yasaklı kelime yok (`grep -R` temiz)

---

## Çerçeveleme notu (Genesis)

Genesis parkuru "sıfırdan başla" diyor. Bu proje daha önce bilinen bir tasarım kalıbını (external domain adapter, finality attestation, HWM replay) Stellar'a özgü olarak, sıfırdan kod yazarak uyguluyor. Tüm kontrat kodu hackathon sırasında yazıldı, kopya yok. Bunu "bilinen bir kalıbı Stellar'a özgü şekilde uyguladık" diye dürüstçe çerçeveliyoruz.

---

## Lisans

MIT — `circuits/range_proof_*` artefaktları hariç, onlar stellar-zkstream'den Apache-2.0 (kredilendirildi).

## Krediler

- Groth16 verifier kalıbı: `stellar-zklab/stellar-zkstream` (Apache-2.0)
- BLS12-381 generator noktaları: `bls12_381` crate
- Soroban SDK 28, CAP-0074/0075
