# Migrate to Stellar — Uygulama Direktifi
## Rise In x Stellar Pro Hackathon — Genesis Track (36 saat, Grand Pera, 19-20 Eylül 2026)

**Proje adı:** Migrate to Stellar  
**Slug:** `migrate-to-stellar`  
**Tagline:** Anchor'a takılan yerleşim katmanı — başka zincirlere köprü kurmak istemeyen anchor için nötr finality-proof altyapısı

---

### 1. Amaç

36 saatte gerçekten çalışan, Stellar testnet'e gerçekten bağlanan uçtan uca bir ürün:

1. Harici kaynak zincirin finality kanıtını Soroban üzerinde doğrulayan kontrat (iki yol: imza seti ve ZK).
2. Bu doğrulamaya bağlı çift yönlü token hareketi: `lock -> mint -> burn -> unlock`.
3. Anchor yerleşim katmanı: Klasik bir Stellar varlığının (SAC) mint yetkisi Soroban gateway kontratına devrediliyor. Anchor, kendi başına köprü işletmeden, sadece kriptografik olarak doğrulanmış finality'ye karşı mint eden bir altyapı sunuyor.

Tek bir akış: kullanıcı kaynak zincirde kilitler → kanıt üretilir (BLS seti ya da Groth16) → Soroban'da doğrulanır → finalized root saklanır → Merkle kanıtlı mesajla Stellar tarafında mint/unlock tetiklenir. Ters yön de çalışır.

### 2. Kesin Kısıtlar

- **İsimlendirme (katı):** Hiçbir dosyada, yorumda, değişken adında, README'de, commit mesajında, UI metninde yasaklı kelime geçmeyecek. Kaynak zincir için sadece `source_chain`, `SOURCE_DOMAIN`, `source domain` gibi nötr adlar.
- **Gerçek bağlantı şart:** Soroban testnet'e gerçek deploy, gerçek RPC/Horizon. Stellar tarafı mock olamaz. Kaynak zincir tarafı simüle edilebilir.
- **Çalışıyor olmak > güvenli olmak:** Eşik düşürme (3-of-5 test seti), test anahtarları, Groth16 trusted setup'ı hardcode kabul. README'de bilerek basitleştirilenler açıkça yazılacak.
- **Dil:** Kod ve testler İngilizce; doküman Türkçe olabilir.

### 3. Doğrulanmış Teknik Zemin (Eylül 2026)

- **BLS12-381:** Protocol 22 (CAP-0059) beri 11 host fonksiyonu var. Toplu imza doğrulama native ve ucuz. EVM'deki precompile belirsizliği yok.
- **BN254 / Groth16:** Protocol 25 X-Ray (CAP-0074 + CAP-0075) ile canlı. `env.crypto().bn254().bn254_multi_pairing_check` + `g1_add`, `g1_mul` ve Poseidon/Poseidon2 permutation host fonksiyonları. Mainnet Ocak 2026'da aktif. Testnet şu an Protocol 27. `soroban-sdk >= 25` şart.
- **Groth16 referans kodu:** AGPL lisanslı OpenZKTool yerine **Apache-2.0** olan `stellar-zkstream/contracts/zk_verifier/src/groth16.rs` kalıbı kullanılacak. Canlı testnette başkaları tarafından aynen yeniden kullanılmış, jüriye anlatması kolay. Lisans uyumlu.
- **Poseidon:** CAP-0075 sayesinde Circom devresi içinde kullanılan Poseidon hash ile kontrat içinde aynı permutation kullanılabilir → devre ve kontrat hash uyumu kolay.
- **Post-kuantum:** CAP-0087 draft (protocol 29) ML-DSA için native host öneriyor, henüz canlı değil. Ama `soroban-ml-dsa` ile in-contract ML-DSA-65 testnette ölçülmüş (~%19 tx bütçesi). Bu hackathon'da PQ katmanı **uygulanmayacak**, ama `SecurityBacking` ve mesaj zarfında yer ayrılacak. README'de "gelecek iş" notu.
- **SAC + set_admin:** Klasik Stellar varlığı (`CODE:ISSUER`) için Stellar Asset Contract deploy edilir, issuer `set_admin(gateway_contract)` çağırır. Artık sadece gateway mint edebilir. Bu, anchor fikrinin teknik omurgası.

### 4. Repodan Alınan Kalıplar (isim değiştirilmiş, birebir kopya değil)

#### 4.1 Adaptör Arayüzü (genel external-domain framework)

```rust
struct RawEvidence {
    adapter_id: [u8; 32],          // AdapterId::from_name("source-chain-bls-v1") gibi
    evidence_version: u32,
    network: String,               // "source-testnet"
    payload: Vec<u8>,              // adaptöre özel, opak
    declared_height: u64,
    declared_root: [u8; 32],
    submitter: Address,
}

enum SecurityBacking {
    SignatureSet { signers: u32, required: u32, total_weight: u128, slashable: bool },
    ZkProof { system: &'static str }, // "groth16-bn254"
    None,
}

struct FinalityAttestation {
    adapter: [u8; 32],
    domain: [u8; 32],              // DomainKey = hash(adapter, network)
    height: u64,
    state_root: [u8; 32],
    finalized_at: u64,
    time_unit: TimeUnit,           // Slot, Height, Epoch
    security: SecurityBacking,
    evidence_digest: [u8; 32],
    adapter_version: u32,
    evidence_version: u32,
}

trait FinalityAdapter {
    fn descriptor(&self) -> AdapterDescriptor;
    fn verify(&self, evidence: &RawEvidence, policy: &VerificationPolicy) 
        -> Result<FinalityAttestation, AdapterError>;
}
```

Kural: `assume valid` yok. Her reddetme `Err` döner. `declared_height`/`declared_root` payload'dan yeniden türetilip doğrulanır.

#### 4.2 Cross-Domain Mesaj Zarfı

```rust
enum MessageKind { Lock, Mint, Burn, Unlock, Custom(Vec<u8>) }

struct CrossDomainMessage {
    message_id: [u8; 32],          // içerikten türetilir: hash(domain, nonce, sender, recipient, payload_hash, kind, expiry)
    source_domain: u32,
    target_domain: u32,
    source_height: u64,
    event_index: u32,
    nonce: u64,
    sender: Address,
    recipient: Address,
    payload_hash: [u8; 32],        // (asset_id, amount, recipient) -> hash, yeniden türetilir
    kind: MessageKind,
    expiry_height: u64,
}
```

`payload_hash` körü körüne güvenilmez: `finalize_mint` içinde `(asset, amount)`'tan yeniden hesaplanır.

#### 4.3 Replay Koruması — High-Water Mark

Set tutmak yerine yön ve gönderici başına tek değer:

`(source_domain, target_domain, sender) -> highest_processed_nonce`

Kabul edilen her nonce, ondan küçük her şeyi otomatik geçersiz kılar. İz sadece ileri gider. Gap olursa (n atlanır, n+2 gelirse) aradaki mesaj expiry ile refund olur, zincir tıkanmaz.

#### 4.4 Versioning

```rust
struct VersionPolicy {
    accepted: Vec<u32>,
    window_start: u64,
    window_end: u64,
}
```

Bilinmeyen `evidence_version` = sert ret. Asla best-effort yorumlama yok.

#### 4.5 Profile — Skor Yok, Birimli Gerçekler

Anchor operatörünün UI'da göreceği:

```rust
struct DomainProfile {
    state: DomainState,            // Registered, Admitted, Active, Faulted, Retired
    consensus_kind: String,
    finality_kind: FinalityKind,   // Probabilistic, Economic, Protocol, Proven
    trust_model: TrustModel,       // Trustless, HonestMajority{set_size}, TrustedParty
    required_depth: u64,
    security_backing: SecurityBacking,
    bond: u64,
    history: Vec<StateEvent>,
}
```

Jüriye anlatım: "Bu anchor neye güveniyor?" sorusuna sayı ve birimle cevap.

#### 4.6 Selftest — Fault Probe'lar Veri Olarak

```rust
enum BytePatch {
    InPayload { offset: usize, bytes: Vec<u8> },
    TruncatePayload { keep: usize },
    DeclaredHeight { value: u64 },
    DeclaredRoot { value: [u8; 32] },
    EvidenceVersion { value: u32 },
    Network { value: String },
}

struct FaultProbe {
    name: String,                  // "zeroed_signature_must_refuse"
    patch: BytePatch,
    expect: ExpectedRefusal,
}
```

Artı zorunlu golden sample: her şeyi reddeden adaptör admit edilemez. Hackathon'da 1 mutlu yol + 6-7 probe = güçlü demo.

#### 4.7 Domain Lifecycle

`Registered -> Admitted (selftest geçti) -> Active (attestation alıyor) -> Faulted/Retired`

Tüm geçişler kayıtlı.

### 5. Mimari

#### 5.1 Soroban Kontratları (Rust, testnet)

**A) `finality_registry` kontratı**

- `register_domain(adapter_id, network, descriptor: AdapterDescriptor)`
- `submit_finality_evidence(evidence: RawEvidence, kind: EvidenceKind) -> Attestation`
  - `EvidenceKind::SignatureSet` : BLS12-381 aggregate doğrulama (native host)
  - `EvidenceKind::ZkProof` : Groth16/BN254 doğrulama (native pairing)
  - Başarılıysa `last_finalized_root[domain] = attestation.state_root`, event emit
- `is_finalized(domain, height) -> Option<root>`
- `get_profile(domain) -> DomainProfile`

**B) `settlement_gateway` kontratı**

- `lock_and_relay(asset: Address, amount: i128, recipient_on_source: Bytes) -> CrossDomainMessage`
  - Stellar tarafında SAC'i kilitler (ya da burn), Lock mesajı üretir, nonce = HWM.next()
- `finalize_inbound(message: CrossDomainMessage, merkle_proof: Bytes, evidence_ref: Option<AttestationRef>)`
  - 1. `message_id` yeniden hesapla, `verify_id`
  - 2. `is_finalized(source_domain, source_height)` kontrol
  - 3. Merkle proof'u `state_root`/`event_root`'a karşı doğrula
  - 4. `payload_hash`'i (asset, amount, recipient)'tan yeniden türet
  - 5. HWM replay kontrol: `is_processed` -> reddet, değilse `mark_processed_at`
  - 6. SAC `mint` (gateway admin olduğu için yapabilir) -> recipient
- `burn_and_relay(asset, amount, recipient_on_source)` : ters yön
- `finalize_outbound` benzer

Her iki kontrat da `soroban-sdk` v25+, `stellar-asset-contract` client kullanır.

**C) Token**

- Klasik varlık: `wSRC:ISSUER`. Issuer hesabı anchor'a ait. Deploy sonrası `set_admin(gateway_contract_id)`.
- Soroban tarafında test için basit `soroban-token` da olabilir, ama anchor hikâyesi için SAC şart.

#### 5.2 Relayer / Simülatör (off-chain, Rust)

Kaynak zincir gerçek mainnet olmak zorunda değil. Basit yerel simülatör:

- **Block producer:** her 2 sn'de blok, `height`, `state_root`, `event_root`, `tx_root`
- **Event tree:** lock/unlock event'lerini Merkle ağacına koyar, proof üretir
- **Finality layer (BLS modu):** 5 validator, 3-of-5 BLS12-381 aggregate imza. Payload = `hash(height || state_root || event_root)`. İmza seti + pubkey'ler evidence içinde.
- **Finality layer (ZK modu):** Circom devresi `m_of_n_poseidon.circom`
  - public input: `root`, `threshold`
  - private input: `signers, signatures, pubkeys`
  - devre: `M-of-N EdDSA-Poseidon doğrulama ve root imzalama`
  - Groth16 proof üret (snarkjs ya da arkworks), verifying key hardcode
- **API:** `POST /lock`, `POST /unlock`, `GET /proof?height=`, `GET /events?height=`, `GET /blocks/latest`

Relayer:

- Source simülatörü izler (`getEvents`)
- Kanıtı paketler, `submit_finality_evidence` çağırır (Stellar RPC)
- Stellar event'lerini dinler (`getEvents` Soroban RPC), karşı yönde `finalize_inbound` / source unlock tetikler
- Retry, idempotency, HWM takibi

Rust tercih: `tokio`, `soroban-client` benzeri, `bls12_381` crate (test için), `reqwest`.

#### 5.3 Anchor Yerleşim Katmanı (Minimal, ama jüriye anlatılabilir)

Anchor normalde fiat on/off ramp'tir (SEP-6/SEP-24). Bizim eklediğimiz:

```
Normal anchor:  fiat <-> USDC (merkezi rezerv, kendi imzası)
Bu proje:       source_chain varlık <-> wSRC (SAC, mint yetkisi kontratta, kanıtla)
```

Teknik adımlar:

1. Anchor operatörü issuer hesabı oluşturur (`stellar keys generate anchor-issuer`)
2. SAC deploy: `stellar contract deploy --id wsrc --asset wSRC:ISSUER`
3. `stellar contract invoke --id wsrc -- set_admin --new_admin <gateway_contract_id>`
4. Artık anchor'ın backend'i doğrudan mint edemez; sadece gateway edebilir.
5. Anchor'ın `stellar.toml` (SEP-1):
   ```
   [[CURRENCIES]]
   code="wSRC"
   issuer="G..."
   anchor_asset_type="crypto"
   desc="Wrapped Source Chain asset, minted only after BLS/ZK finality proof verified on Soroban"
   ```
6. Minimal HTTP fasadı (Node/TS veya Rust):
   - `GET /info` -> domain listesi, profile, last finalized height
   - `GET /deposit?asset=wSRC&account=G...` -> "önce source chain'de kilitle, sonra bekle" yönergesi (SEP-6 ruhu, tam SEP-6 implementasyonu şart değil)
   - `GET /transactions?id=` -> settlement durumu (Stellar Explorer linki)

Jüri cümlesi: "Anchor başka zincirlere köprü kurmak istemiyor. Biz ona 'nötr finality-proof altyapısı' veriyoruz: o sadece issuer, mint kararı kriptografide."

#### 5.4 Frontend / CLI (TypeScript)

- **Web (tercih):** Next.js / Vite + Freighter + Stellar SDK + Soroban RPC
  - Panel 1: Source chain simülatör durumu (height, finalized root, BLS signers)
  - Panel 2: Lock form (amount, recipient) -> source chain lock -> proof üretiliyor spinner -> Soroban submit -> attestation event
  - Panel 3: Stellar bakiye (wSRC), Horizon linki
  - Panel 4: Burn -> unlock ters yön
  - Panel 5: Kötü kanıt denemesi (imza sıfırlanmış / root değiştirilmiş) -> reddedildi gösterimi
  - Panel 6: Domain profile (trust model, required depth, security backing)
- **CLI fallback:** `pnpm demo:lock`, `pnpm demo:burn`, `pnpm demo:bad-proof`

Zaman yetmezse CLI yeterli ama en az bir izlenebilir demo şart.

### 6. ZK Devresi Detayı (Groth16 yolu)

**Hedef:** "STARK VM'i portlamak değil, M-of-N imza iddiasını kanıtlayan küçük devre"

Devre: `m_of_n.circom`

```
template MOfN(n, m) {
  signal input root;
  signal input pubkeys[n][2];
  signal input signatures[n][3]; // r, s, etc (EdDSA-Poseidon)
  signal input signers; // bitmask ya da count
  signal output valid;
  
  // 1. her imza pubkey'e karşı root'u doğruluyor mu kontrol et
  // 2. geçerli imza sayısı >= m mi
  // 3. valid = 1
}
```

- Curve: BN254 (Circom default)
- Hash: Poseidon (Circomlib)
- Groth16 trusted setup: `snarkjs powersoftau` test ceremony, `zkey` hardcode kontratta
- Kontrat tarafı: `stellar-zkstream` groth16 verifier kalıbı:
  ```rust
  // vk_x, proof_a, proof_b, proof_c, public_inputs
  env.crypto().bn254().bn254_multi_pairing_check(...)
  ```

Test: 1 mutlu yol proof kabul, 1 bozuk proof (public input değiştirilmiş) reddedilir.

### 7. BLS Yolu Detayı

- Host fonksiyonlar: `bls12_381_aggregate_verify`, `bls12_381_g1_add`, `g2_add`, `pairing_check` vb (11 fonksiyon)
- Evidence payload layout (sabit, versiyonlu):
  ```
  [0..32]   signing_root (height || state_root || event_root hash)
  [32..40]  height u64 LE
  [40..72]  state_root
  [72..104] event_root
  [104..106] signer_count u16, required u16
  [106..]   pubkeys (48 byte compressed * n) + signature (96 byte)
  ```
- Doğrulama:
  - declared_height/root payload'dan türet, karşılaştır
  - pubkey'ler G1/G2 üzerinde mi kontrol
  - aggregate verify native host ile
  - threshold kontrol

### 8. Kapsam Kesintileri (Açıkça İzinli)

- Kaynak zincir simüle (gerçek mainnet değil). Gerçek entegrasyon Soroban tarafında.
- İmza eşiği 3-of-5 test seti.
- PQ katmanı yok (zarfta yer var, README'de gelecek iş).
- Bond/fee/slashing yok, sadece işlevsel doğrulama + mesaj akışı.
- Selftest harness tam değil, en az golden + 5-6 probe.
- Anchor SEP-24 tam interaktif flow yok, sadece `/info` + status + SAC admin devri.
- Groth16 trusted setup test amaçlı hardcode.

### 9. Hackathon Uyum Notu (Genesis)

- Genesis metni "sıfırdan başlayanlar" diyor. Bu proje önceden bilinen bir mimari kalıptan besleniyor (generic domain adapter, external finality). Bunu saklamak yerine README'de dürüstçe: "Önceden bildiğimiz bir tasarım kalıbını (external domain adapter, finality attestation, high-water-mark replay) Stellar'a özgü olarak, sıfırdan kod yazarak uyguladık. Kodun tamamı hackathon sırasında yazıldı, hiçbir kontrat kopyalanmadı." Şeffaf çerçeveleme en güvenli olanı.
- Submission zorunlu, sadece shortlist canlı sunar. Shortlist kriterleri deadline öncesi paylaşılacak, resmi duyuruyu takip et.

### 10. Dosya Yapısı (Hedef)

```
migrate-to-stellar/
  DIRECTIVE.md (bu dosya)
  README.md (teslim için)
  contracts/
    finality_registry/
      Cargo.toml (soroban-sdk 25+)
      src/lib.rs
    settlement_gateway/
      Cargo.toml
      src/lib.rs
  crates/
    source_simulator/
      src/{main.rs, block.rs, event_tree.rs, bls.rs, zk_prover.rs}
    relayer/
      src/{main.rs, stellar.rs, source.rs, anchor.rs}
  circuits/
    m_of_n.circom
    compile.sh (circom -> r1cs -> wasm -> zkey -> vkey.json)
    vkey.json (hardcode için)
  frontend/
    package.json
    src/{App.tsx, soroban.ts, source.ts, anchor.ts}
  anchor/
    stellar.toml
    server.ts (minimal /info)
  scripts/
    deploy.sh (testnet deploy + set_admin)
    demo.sh
```

### 11. Teslim Kontrol Listesi

- [ ] Soroban kontratları testnet'e deploy edildi, contract ID'ler README'de
- [ ] BLS12-381 yolu: 1 mutlu yol + 1 reddedilen kötü kanıt (zeroed sig / wrong root)
- [ ] Groth16/BN254 yolu: 1 mutlu yol + 1 reddedilen kötü kanıt (tampered public input)
- [ ] Lock -> proof -> mint uçtan uca demo, ters yön de çalışıyor
- [ ] Nonce high-water-mark replay koruması testte kanıtlı
- [ ] SAC set_admin ile anchor mint yetkisi kontratta, Freighter'da bakiye görünüyor
- [ ] Basit frontend ya da CLI demo hazır, Explorer linkleri var
- [ ] README: ne yapıldığı, nasıl çalıştırılacağı, basitleştirmeler (audit-grade olmadığı açık)
- [ ] Son kontrol: `grep -R -i "yasaklı_kelime" --include="*.rs" --include="*.md" --include="*.ts" --include="*.toml" .` (repo'da yasaklı kelime yok)
- [ ] Lisans kontrolü: OpenZKTool kullanılmadı, Apache-2.0 verifier kalıbı kullanıldı

### 12. Kaba Zaman Planı (36 saat, "hallederiz" modu)

**0-4s: İskelet**
- Soroban proje iskeleti `stellar contract init`, hello-world deploy testnet
- Rust workspace: source_simulator + relayer iskeleti
- `stellar.toml` + SAC deploy script taslağı
- Frontend boş Next.js, Freighter bağla

**4-12s: BLS Yolu + Anchor Temeli**
- BLS evidence layout + native host verify kontrat içinde
- Simulator: blok üret + 3-of-5 imza üret
- `submit_finality_evidence` -> `is_finalized` çalışır
- Anchor: issuer oluştur, SAC deploy, `set_admin(gateway)` manuel test

**12-20s: Mesaj + Replay + Settlement**
- `CrossDomainMessage` id türetme + `payload_hash` yeniden türetme
- HWM nonce store
- `settlement_gateway`: lock_and_relay + finalize_inbound (Merkle proof doğrulama)
- Relayer: source -> Stellar, Stellar -> source iki yön
- Uçtan uca BLS akışı demo: lock (source) -> mint (Stellar, Freighter'da görünsün)

**20-28s: ZK Yolu**
- Circom `m_of_n.circom` yaz, compile, test proof üret (snarkjs)
- vkey'yi kontrata hardcode
- `stellar-zkstream` groth16.rs kalıbıyla `verify_groth16` fonksiyonu
- `EvidenceKind::ZkProof` entegrasyonu, aynı `is_finalized` yolunu kullan
- 1 mutlu + 1 bozuk ZK testi

**28-32s: Frontend + Anchor Fasad + Demo Prova**
- Frontend panelleri bağla
- Anchor `/info` + status API
- Ters yön (burn -> unlock) UI
- Kötü kanıt butonu (probe'ları tetikle)
- Tüm akışı 2 kez prova et, Explorer linkleri hazır

**32-36s: README + Submission**
- README: mimari diyagram (Mermaid), nasıl çalıştırılır, basitleştirmeler, dürüst çerçeveleme notu
- Deploy script final, contract ID'ler pin'li
- Grep taraması, lisans kontrolü
- Video/gif, submission formu

### 13. Jüri Anlatımı (60 saniye)

"Anchor'lar fiat için var, ama her yeni zincir için kendi köprüsünü kurmak istemiyor. Biz anchor'a takılan nötr bir yerleşim katmanı yaptık: anchor sadece klasik varlığın issuer'ı, mint yetkisini Soroban'daki gateway kontrata devrediyor. Gateway sadece iki şeyde mint ediyor: BLS12-381 aggregate finality kanıtı ya da Groth16 ZK kanıtı, ikisi de Soroban'ın native host fonksiyonlarıyla doğrulanıyor. Kaynak zincir simüle, ama Stellar tarafı gerçek testnet. Lock -> proof -> mint'i ve burn -> unlock'u canlı gösteriyoruz, bir de bilerek bozduğumuz kanıtın reddedildiğini. Anchor'ın gözünden ise bu, 'başka zincirlere bulaşmadan wrapped varlık sunmak'."

### 14. Riskler ve Azaltma

- **SDK sürümü:** BN254 için sdk 25 şart, eski tutorial'lar 22 kullanıyor. `Cargo.toml`'da pin'le, `stellar contract build`'de kontrol et.
- **Circom kurulumu:** Grand Pera'da internet kısıtlı olabilir. `circom` binary'sini önceden indir, `snarkjs` global kur.
- **Testnet reset:** Contract ID'ler değişebilir. Deploy script idempotent yaz, README'de güncel ID'leri tut.
- **Freighter:** İzleyici cüzdanı için testnet XLM faucet + trustline + mint akışını tek butona bağla.
- **Zaman:** ZK yolu yetişmezse BLS + anchor ile ürün yine bütün. Ama plan ZK'yı MUST tutuyor, çünkü verifier kalıbı hazır.

---

**Sonraki adım:** Bu direktif onaylandıktan sonra `contracts/finality_registry` ve `contracts/settlement_gateway` iskeletlerini oluşturup testnet'e ilk deploy'u yapıyoruz.
