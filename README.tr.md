# Lumen Gate

**Anchor'ın arkasına takılan nötr yerleşim katmanı: kaynak zincir finality kanıtlarını Soroban'da doğrular ve mint/burn kararını makineye bağlar.**

Bu proje [Rise In x Stellar Pro Hackathon](https://www.risein.com/programs/stellar-pro-hackathon) Genesis parkuru için hazırlanıyor. Kaynak zincir tarafı 36 saatlik demo gerçeği nedeniyle simüle edilebilir; Stellar tarafı ise gerçek Soroban Testnet kontratları, RPC/Horizon çağrıları ve explorer'da görülebilen transaction'larla çalışmalıdır.

> **Durum notu:** Bu checkout bir uygulama snapshot'ı ve uygulama planıdır. `deployments/testnet.json` içinde henüz placeholder ID'ler vardır. Gerçek contract ID, transaction hash ve uçtan uca negatif probe eklenmeden proje tamamlanmış production bridge olarak sunulmayacaktır.

## Fikir

Bir Stellar anchor'ı her kaynak zincir için ayrı validator ağı, multisig köprüsü ve operasyon kurmak istemeyebilir. Lumen Gate bu anchor'ın arkasında nötr bir settlement katmanı olur:

- Anchor issuer, rezerv ve müşteri ilişkisinin sahibidir.
- Lumen Gate domain registry ve finality proof doğrulamasını yapar.
- Relayer kanıtı taşır ve Stellar transaction ücretini öder; mint kararının güven kökü relayer değildir.
- Soroban gateway, doğrulama başarılı olduktan sonra anchor'ın SAC varlığını mint/burn eder.
- Anchor kaynak zincir validator'ı işletmek zorunda kalmaz.

Demo varlığı `wSRC` olarak adlandırılabilir. Bu, ürün adı veya belirli bir dış zincirin adı değildir.

## Jürinin göreceği akış

```text
Kaynakta lock + ücret
        ↓
Blok, state_root, event_root, message ve Merkle proof
        ↓
BLS veya Groth16 kanıtı
        ↓
Soroban Finality Registry: native curve/pairing doğrulaması
        ↓
Settlement Gateway: message id + payload + expiry + HWM
        ↓
SAC mint: kullanıcı miktarı + relayer ödülü
        ↓
Burn → kaynak tarafta tek-seferlik unlock
```

Aynı mesaj zarfı içinde iki güvenlik yolu gösterilir:

1. BLS12-381 aggregate signature ve full native pairing;
2. Groth16/BN254 proof ve native multi-pairing.

Aynı nonce veya daha düşük nonce tekrar gönderildiğinde HWM replay koruması işlemi reddeder. Mutlu yol kadar bu red sonucu da demoda görünür olmalıdır.

## Mimari

| Parça | Görevi | Dizin |
| --- | --- | --- |
| `finality_registry` | Domain kaydı, evidence parser, BLS/ZK doğrulama ve finalized root | `contracts/finality_registry` |
| `settlement_gateway` | Lock, mint, burn, Merkle, fee abstraction ve HWM | `contracts/settlement_gateway` |
| `source_simulator` | Blok, lock event, Merkle root ve proof fixture üretimi | `crates/source_simulator` |
| `relayer` | Kaynak event'lerini izleme ve gerçek Soroban transaction gönderimi | `crates/relayer` |
| frontend | Freighter ve görünür demo panelleri | `frontend` |
| anchor facade | SEP-1, `/info`, `/health` ve entegrasyon metadata'sı | `anchor` |

### Domain ve evidence

Domain anahtarı:

```text
domain_key = sha256(adapter_id || network)
```

Evidence `adapter_id`, version, network, opak payload, declared height, declared root ve submitter taşır. Kontrat height ve root'u payload'dan yeniden çıkarmalıdır. Kısa payload, unknown version, root mismatch, duplicate evidence, geçersiz eğri noktası veya geçersiz proof hiçbir zaman kabul edilmez.

### Mesaj ve replay

Message ID; source/target domain, source height, event index, nonce, sender, recipient, payload hash, kind ve expiry alanlarından deterministik üretilir.

Replay koruması mesaj başına set yerine şu HWM ile tutulur:

```text
(source_domain, target_domain, sender) -> highest_processed_nonce
```

`nonce <= highest` reddedilir; yalnızca daha yüksek nonce mark'ı ilerletir. Message ID kaydı ek idempotency korumasıdır.

## Anchor konumlandırması

Anchor:

- issuer ve rezerv tarafıdır;
- `stellar.toml` ile asset metadata yayınlar;
- kullanıcı, uyum ve müşteri süreçlerini yürütür;
- gateway'e SAC mint yetkisini verir;
- kaynak zincir validator'ı veya bridge multisig'i işletmez.

Lumen Gate:

- domain ve proof politikasını kaydeder;
- BLS/ZK kanıtını Soroban native fonksiyonlarıyla doğrular;
- finalized root ve event'i saklar;
- proof sonrası gateway mint/burn akışını çalıştırır.

Çalışmayan SEP deposit/withdraw endpoint'leri çalışıyormuş gibi ilan edilmez. `/info` yalnızca gerçek deployment ve profile bilgisini döndürür.

## Kriptografik kararlar

### BLS12-381

Yeni deployment için canonical domain separation string:

```text
lumen-gate-finality-v1
```

BLS public key payload'dan seçilip güvenilir kabul edilmemelidir; domain kaydındaki beklenen aggregate public key ile eşleşmelidir. Test validator kümesi deterministik 2-of-3 fixture’dır; production key yönetimi değildir. Güvenlik iddiası yalnızca curve/subgroup kontrolüne değil, full native pairing'e dayanır.

### Groth16 / BN254

Büyük bir kaynak zincir VM'si Soroban'a taşınmayacaktır. Küçük bir Circom devresi; height, state root ve message commitment'ı public input olarak bağlayacak şekilde kullanılacaktır. Native `bn254_multi_pairing_check` doğrulamanın on-chain noktasıdır.

Mevcut statik fixture, dynamic source-root finality kanıtı sayılmaz. Submission'dan önce wrong VK, modified proof ve root mismatch red testleriyle birlikte yeniden doğrulanmalıdır. Trusted setup kısa/test amaçlıysa README'de açıkça belirtilir.

## Mevcut snapshot ve yapılacaklar

### Repo'da bulunanlar

- iki Soroban kontrat iskeleti;
- Raw evidence, attestation, domain profile ve message envelope tipleri;
- HWM, Merkle ve SAC mint/burn yardımcıları;
- BLS ve BN254 host-call verifier kalıpları;
- Rust simülatör, relayer, frontend ve anchor facade;
- admin renounce ve fault-probe test fixture'ları;
- tek kalıcı plan: [`DIRECTIVE.md`](DIRECTIVE.md).

### Submission'dan önce zorunlu işler

- registry, gateway ve SAC'ı Testnet'e deploy etmek;
- gerçek ID, explorer linki, setup tx ve registry/gateway admin-renounce tx hash'lerini yazmak;
- register/admit/VK authorization kodunu Rust build ve Testnet receipt'leriyle doğrulamak;
- BLS key binding ve hash-to-curve fixture'larını eşleştirmek;
- root-bound Groth16 proof üretmek;
- relayer'ın gerçek CLI encoding, sign, submit ve receipt confirmation'ını doğrulamak;
- gateway burn event'inin Bytes payload'ını Soroban RPC'den okuyup kaynak
  simülatörünün tek-seferlik `/burn-unlock` endpoint'ine ileten relayer kodunu
  gerçek Testnet receipt'iyle doğrulamak;
- taze, hiç XLM fonlanmamış keypair ile gasless akışı kanıtlamak; kanıtlanamazsa
  bu iddiayı kaldırmak;
- tüm test, build, frontend preview ve fault-probe komutlarını çalıştırmak.

## Çalıştırma

### Gereksinimler

Rust/Cargo, Soroban CLI, Node.js, Circom, snarkjs ve Freighter gerekir. Gerçek Testnet submit için ayrıca fonlanmış bir relayer hesabı gerekir.

### Test ve kontrat build

```bash
cargo fmt --check
cargo test --workspace

cd contracts/finality_registry
stellar contract build
cd ../settlement_gateway
stellar contract build
```

### Kaynak simülatörü

```bash
SOURCE_ASSET_ID=<real-sac-contract-id> cargo run -p source_simulator -- --port 3001
```

Endpoint'ler:

```text
GET  /info
GET  /blocks/latest
POST /lock
POST /unlock                 # inbound lock consume
POST /burn-unlock            # live Stellar burn event consume
GET  /events?height=<height>
GET  /proof?height=<height>&kind=bls
GET  /proof?height=<height>&kind=zk
```

### Relayer ve UI

```bash
RPC_URL=https://soroban-testnet.stellar.org \
STELLAR_SOURCE_ACCOUNT=relayer \
STELLAR_RELAYER_ADDRESS=<funded-relayer-address> \
REGISTRY_ID=<real-contract-id> \
GATEWAY_ID=<real-contract-id> \
cargo run -p relayer -- --sim-url http://localhost:3001 --rpc "$RPC_URL"

# Yalnızca lokal inceleme; transaction göndermez.
cargo run -p relayer -- --dry-run --sim-url http://localhost:3001

cd frontend && npm install && npm run dev
cd ../anchor && npm install && PORT=8081 SIM_URL=http://localhost:3001 npm start
```

Browser tarafı sandbox'ın localhost'una güvenmemelidir. Preview için relative URL/Vite proxy veya public simulator URL kullanılır. Relayer BLS registry kanıtı ve gateway mint çağrısının yanında gerçek Soroban RPC'den burn Bytes event'ini okuyup source simulator `/burn-unlock` çağrısını yapar; bu kodun Testnet receipt'i henüz alınmadı. ZK fixture dynamic source-root bağlı olmadığı için yalnızca açıkça etkinleştirilen development registry probe'u olarak kalır.

## Güvenlik ve kapsam sınırları

Bu hackathon sürümü audit-grade değildir:

- kaynak zincir ve consensus simüledir;
- validator secret'ları demo fixture'ıdır;
- Groth16 trusted setup kısa olabilir;
- PQ imzaları, slashing, bond, validator rotation ve fraud proof yoktur;
- anchor rezervleri ve uyum süreçleri off-chain'dir;
- relayer operasyonel olarak tekil olabilir, ancak cryptographic mint authority
  olmamalıdır;
- Testnet varlıklarının production değeri yoktur.

Bootstrap admin, renounce öncesinde kritik tehdittir. Admin VK veya domain
politikasını değiştirebilir; bu yüzden setup'tan sonra renounce event'i ve tx
hash'i gösterilir. Renounce sonrası policy değişikliği yeni kontrat ve açık
migration ister.

## Genesis çerçevesi

Burada bilinen domain-adapter ve finality-attestation kalıbı Stellar/Soroban'a
özgü olarak uygulanmaktadır. Sunumun odağı, bu kalıbın gerçek Testnet proof,
mint, replay rejection ve reverse-flow receipt'leriyle çalıştığını göstermektir;
doğrulanmamış güvenlik veya ekosistem istatistikleri kullanılmayacaktır.

## Lisans

Kod MIT'tir; dosya bazında farklı lisans belirten devre/proof artifact'leri
kendi lisans ve attribution bilgileriyle korunur.
