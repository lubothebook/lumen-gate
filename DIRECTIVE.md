# Lumen Gate — Kalıcı Uygulama Direktifi

## 0. Belgenin rolü

Bu belge projenin tek yetkili uygulama direktifidir. Her çalışma oturumunun
başında okunur; oturum sonunda yalnızca gerçekten tamamlanan maddeler Bölüm 3'te
işaretlenir. Kod, test ve canlı ağ çıktısı bu belgede yazan kararlarla uyumlu
olmalıdır.

Repo içinde ikinci bir ana direktif tutulmaz. Bu dosya dışındaki eski direktif
kopyaları oluşturulmayacak; varsa içerikleri bu dosyaya alınarak kaldırılacaktır.

Projenin görünen ve teknik ürün adı **Lumen Gate**'tir. README başlığı, Türkçe
README, UI başlığı, anchor metadata'sı, CLI çıktıları, paket adları ve yorumlar
bu adı kullanır. Repo'nun mevcut GitHub yolu teknik bir URL olarak kalabilir;
ürün adı olarak kullanılmaz.

Kaynak zincir için yalnızca `source chain`, `source-chain`, `source_domain` veya
`SOURCE_DOMAIN` gibi nötr ifadeler kullanılacaktır. Belirli bir dış zincirin
markası, doğrulanmamış ekosistem istatistiği veya başkasının ürün adı demo
protokolüne bağlanmayacaktır.

Bu proje için iki kesin yazım kuralı vardır:

- Yasaklı eski marka adı hiçbir dosyada, yorumda, değişken adında, README'de,
  UI metninde veya commit mesajında yer almayacak.
- Proje adı ile kriptografik namespace birbirine karıştırılmayacak. Yeni
  namespace `lumen-gate-finality-v1` olacaktır; bu değişiklik canlı kontrat
  deploy edilmeden önce yapılmalıdır. Canlı kontrat varsa eski namespace
  değiştirilmez, migration planı yazılır.

---

## 1. Hackathon hedefi ve ürün kararı

Lumen Gate, anchor'ın arkasına takılan **nötr yerleşim ve finality-proof
katmanı**dır. Konumlandırma cümlesi:

> Bir anchor kendi validator ağını veya her kaynak zincir için ayrı köprüyü
> işletmek zorunda kalmadan, kaynak zincir finality kanıtlarını Soroban'da
> doğrulatır; doğrulama başarılıysa kendi ihraç ettiği temsil varlığın mint,
> burn ve karşı tarafa bırakma işlemlerini çalıştırır.

Bu ürün klasik anlamda custody tutan bir köprü değildir:

- Anchor issuer, müşteri ilişkisi, rezerv ve uyum süreçlerinin sahibidir.
- Lumen Gate domain registry, kanıt doğrulama ve settlement akışını sağlar.
- Relayer yalnızca kanıtı ve işlemi taşır; mint yetkisi anchor anahtarında değil,
  doğrulama sonrası çalışan Soroban gateway kontratındadır.
- Kaynak zincir 36 saatlik demo için simüle edilebilir. Gerçek ve zorunlu
  entegrasyon Stellar Testnet Soroban RPC, Horizon ve deploy edilmiş kontratlar
  tarafındadır.
- Demo varlığı nötr `wSRC` kodunu kullanabilir; bu kod ürün adı veya dış zincir
  markası değildir.

Hedef etkinlik: [Rise In x Stellar Pro Hackathon](https://www.risein.com/programs/stellar-pro-hackathon).
Resmi sayfadaki çerçeveye göre proje Genesis parkurunun gerçek Stellar
entegrasyonu ve çalışan ürün beklentisini karşılamalıdır. Submission herkes için
zorunludur; canlı jüri sunumu shortlist edilen projeler içindir. Sunumda,
önceden bilinen bir domain-adapter tasarımını Stellar/Soroban'a özgü kodla
uyguladığımız dürüstçe söylenecektir.

---

## 2. Başarı kriterleri ve gösterilecek akış

Submission öncesi iki iddia gerçek testnet çıktısıyla gösterilmelidir:

1. **Makine onaylı settlement:** Mint kararı insan multisig'ine değil,
   Soroban'da doğrulanan BLS pairing veya Groth16/BN254 pairing sonucuna dayanır.
2. **Kullanıcı için ücret soyutlama:** Stellar'da XLM'i olmayan yeni bir
   kullanıcı, kaynak zincirde ücret dahil kilitleme yapar; fonlanmış relayer
   işlemi gönderir ve kullanıcı hedef varlığı alır. Bunun gerçekten canlı
   çalıştığı kanıtlanamazsa iddia README ve sunumdan çıkarılır.

Tek mutlu yol demosu:

1. Anchor `stellar.toml` ve `/info` ile tanıtılır.
2. Kullanıcı kaynak zincirde `amount = hedef miktar + relayer ücreti` kilitler.
3. Kaynak simülatörü yeni blok, `state_root`, `event_root`, lock message ve
   Merkle leaf üretir.
4. Relayer BLS veya ZK kanıtını alır.
5. Relayer gerçek Soroban RPC ile kanıtı `finality_registry` kontratına yollar.
6. Kontrat kanıtı doğrular, finalized root'u ve event'i kaydeder.
7. Relayer gerçek gateway çağrısını gönderir; gateway mesaj kimliğini, payload
   hash'ini, Merkle proof'u, expiry'yi ve nonce HWM'yi kontrol eder.
8. Gateway SAC üzerinde kullanıcıya mint eder ve gasless akışta relayer
   ödülünü ayrı event/storage kaydıyla verir.
9. Kullanıcı burn başlatır; relayer gateway event'ini izler, kaynak simülatörü
   unlock işlemini yalnızca bir kez kabul eder.
10. Aynı mesaj veya daha düşük nonce tekrar gönderildiğinde işlem reddedilir.

İkinci mutlu yol, aynı kaynağın `kind=zk` seçeneğiyle Groth16 kanıtı kullanır.
Demo ekranında BLS, ZK ve ters yön ayrı butonlar değil, aynı message envelope ve
settlement akışının güvenlik seçenekleri olarak gösterilir.

---

## 3. Mevcut repo durumu — 2026-09-19 snapshot

Bu bölüm gözlemlenen repo durumudur; çalıştırılmamış bir komut başarılı kabul
edilmez. Bu çalışma ortamında `cargo` bulunmadığı için Rust testleri henüz bu
oturumda çalıştırılmamıştır.

### Mevcut ve korunacak fikirler

- [x] `contracts/finality_registry` ve `contracts/settlement_gateway` Soroban
      kontrat iskeletleri var.
- [x] `source_simulator`, `relayer`, Vite frontend ve anchor facade iskeletleri
      var.
- [x] Raw evidence, domain key, finalized record, cross-domain message, Merkle
      leaf ve nonce HWM veri modelleri mevcut.
- [x] `finality_registry` içinde BLS host çağrıları ve Groth16/BN254 pairing
      verifier kalıbı bulunuyor.
- [x] Gateway'de fee config, gasless/sponsored çağrı isimleri, SAC mint/burn ve
      relayer reward kayıtları bulunuyor.
- [x] Admin renounce için bir fonksiyon ve fault-probe test/snapshot dosyaları
      eklenmiş.
- [x] Bu direktif tek ana direktif dosyasıdır; ek direktif dosyası
      oluşturulmayacaktır.

### Henüz canlı veya güvenilir kabul edilmeyecek noktalar

- [ ] `deployments/testnet.json` halen placeholder ID'ler içeriyor; canlı
      registry, gateway ve SAC deployment kanıtı yok.
- [ ] `relayer` gerçek signed Soroban transaction submit etmek yerine bazı
      adımları log/simulate seviyesinde bırakıyor.
- [ ] `register_domain` ve `admit_domain` akışlarında admin authorization
      boşlukları var; bootstrap sonrası kalıcı renounce akışı tamamlanmalı.
- [ ] BLS payload içinde gelen public key domain'e sabitlenmeden kabul ediliyor;
      tam pairing yolu ile gerçek kaynak simülatörünün hash-to-curve üretimi
      aynı canonical şemaya getirilmeli.
- [ ] Varsayılan BLS yolu yalnızca eğri/subgroup kontrolü ile yetinmemeli;
      demo yolu tam pairing ve sabit domain validator key ile çalışmalı.
- [ ] Mevcut Groth16 fixture'ı statik bir range-proof örneği gibi duruyor ve
      state root ile bağlama kontrolü yorum içinde bırakılmış. Kanıt, on-chain
      kabul edilen height/root/message id iddiasına bağlanmadan finality kanıtı
      sayılmayacak.
- [ ] Gateway'deki Merkle doğrulaması, finalized event root ile doğru leaf ve
      sibling yönlerini canlı uçtan uca göstermeli; boş proof yalnızca tek leaf
      durumunda kabul edilmeli.
- [ ] `burn_and_relay` sonrası kaynak simülatörde gerçek tek-seferlik unlock
      endpoint'i ve relayer event tüketimi tamamlanmalı.
- [ ] Browser kodunda sabit `localhost` kullanımı canlı preview için relative
      URL veya Vite proxy ile değiştirilmelidir.
- [ ] Taze, hiç fonlanmamış testnet keypair ile gasless mint kanıtı henüz canlı
      çekim olarak kabul edilmemelidir.
- [ ] README'de canlı deployment, test sayısı ve dış servis istatistikleri
      doğrulanmadan kesin başarı rozeti kullanılmayacak.

---

## 4. Karar verilmiş mimari

### 4.1 `finality_registry`

Registry iki kanıt yolunu aynı adapter sözleşmesine bağlar:

```text
RawEvidence { adapter_id, evidence_version, network, payload,
              declared_height, declared_root, submitter }
FinalityAttestation { domain, height, state_root, security, evidence_digest }
```

Her adapter için:

- `domain_key = sha256(adapter_id || network)`
- kabul edilen evidence version aralığı,
- gereken confirmation depth,
- BLS aggregate public key ve quorum bilgisi,
- ZK verification key ve circuit version
  bootstrap sırasında kaydedilir.

`declared_height` ve `declared_root` her zaman payload'dan yeniden çıkarılır.
Mismatch, kısa payload, unknown version, duplicate digest, geçersiz eğri noktası,
subgroup hatası veya pairing failure `Err` döndürür; hiçbir yol varsayılan olarak
valid kabul etmez.

BLS yolu:

- Demo validator kümesi 3-of-5 olarak açıkça test-only işaretlenir.
- Signer secret key'leri repoya konmaz; local demo fixture üretimi dışında canlı
  key yönetimi dokümante edilir.
- Aggregate public key domain kaydındaki beklenen key ile eşleştirilir.
- `hash_to_g1` için `lumen-gate-finality-v1` DST, BLS G1/G2 curve + subgroup
  kontrolleri ve full native pairing zorunludur.
- Permissive on-curve-only yöntem güvenlik iddiası olarak kullanılmaz.

ZK yolu:

- Küçük, amaca özel Circom devresi kullanılır; büyük bir kaynak zincir VM'si
  Soroban'a taşınmaz.
- Public input'lar kanıtlanan height/root/message commitment ile açıkça
  bağlanır.
- Verification key deployment öncesi sabitlenir; proof ve VK boyutu ile
  circuit version README'de yazılır.
- Soroban native `bn254_multi_pairing_check` gerçek doğrulama noktasıdır.
- Trusted setup hackathon kısaltması olabilir; tek katılımcılı fixture üretim
  ortamı olarak belirtilir, production ceremony gibi sunulmaz.

Admin modeli:

1. Deploy eden bootstrap admin registry'yi başlatır.
2. VK, domain, quorum ve örnek self-test kaydedilir.
3. Admin olmayan çağrılar `set_vk`, domain kayıt/değişiklik ve admit için
   reddedilir.
4. Self-test ve canlı kanıt görüldükten sonra `renounce_admin` çağrılır.
5. Admin adresi ve yetkisi kalıcı olarak etkisizleştirilir; event ve transaction
   hash deployment manifest'ine yazılır.
6. Renounce sonrasında VK veya domain politikasını değiştirmek yeni kontrat ve
   açık migration gerektirir.

### 4.2 `settlement_gateway`

Mesaj kimliği içerikten türetilir ve aşağıdaki alanları kapsar:

```text
(source_domain, target_domain, source_height, event_index, nonce,
 sender, recipient, payload_hash, kind, expiry_height)
```

Replay koruması yön ve gönderici başına tek HWM ile uygulanır:

```text
(source_domain, target_domain, sender) -> highest_processed_nonce
```

`nonce <= highest` reddedilir; yalnızca daha ileri nonce HWM'yi taşır. Message
ID kaydı ek savunma/idempotency içindir, HWM'nin yerine geçmez.

Inbound mint sırası:

1. message id yeniden hesapla.
2. expiry ve `kind` kontrol et.
3. registry'de ilgili source height/root finalized mı kontrol et.
4. payload hash'i asset, amount ve recipient'dan yeniden hesapla.
5. event leaf + sibling Merkle proof'u finalized event root'a karşı doğrula.
6. HWM'yi atomik olarak ilerlet.
7. SAC mint et; gasless ise miktarı kullanıcı ve relayer ödülü olarak böl.
8. `Mint`, `RelayerReward` ve hata event'lerini yayınla.

Outbound burn/lock mesajı aynı envelope'ı kullanır. Gateway outbound mesajı
processed saymaz; karşı domain'in unlock işlemi kendi HWM'si ile ayrı bir kez
çalışır. Bu ayrım çift yakma ve çift serbest bırakma hatasını önler.

### 4.3 Anchor facade

Anchor için entegrasyon yüzeyi:

- SEP-1 `stellar.toml` içinde gerçek testnet asset ve issuer metadata'sı,
- `/info`, `/health`, `/transactions` ve açıkça desteklenen deposit/withdraw
  bilgisi,
- domain profile: consensus kind, finality kind, trust model, required depth,
  security backing; puan uydurulmaz,
- issuer hesabı ve rezerv operasyonu anchor'da kalır,
- SAC admin'i settlement gateway'e devredilir,
- anchor validator veya bridge multisig işletmez.

Anchor facade çalışmayan SEP endpoint'lerini çalışıyormuş gibi ilan etmez.

### 4.4 Off-chain bileşenler

- `source_simulator`: deterministic block/event/Merkle üretir, BLS ve ZK fixture
  sağlar, lock ve unlock state machine'i tutar.
- `relayer`: simulator event'lerini izler; gerçek Soroban RPC'de
  `getLatestLedger`, `simulateTransaction`, resource assembly, signing,
  `sendTransaction` ve confirmation adımlarını yürütür. Private key yalnızca
  environment/secret store'dan gelir.
- `frontend`: Freighter ile kullanıcı cüzdanını bağlar, kanıt türünü seçer,
  gerçek explorer/RPC linklerini gösterir, BLS/ZK fault probe'larını görünür
  kılar. Preview ortamında browser'dan `localhost` çağrısı yapmaz.
- `anchor`: facade ve metadata sunar; simulator backend-to-backend erişiminde
  localhost kullanılabilir, browser-facing endpoint'ler public veya proxied
  olmalıdır.

---

## 5. Uygulama planı — plan onayından sonra kod sırası

### Faz 0 — isim ve dokümantasyon

- Tüm görünen ürün adını Lumen Gate yap.
- Eski ürün adı ve yasaklı marka taramasını CI/script haline getir.
- README.md ve README.tr.md'yi yalnızca doğrulanabilir iddialarla yenile.
- Tek deployment manifest şeması ve demo komutlarını tanımla.

### Faz 1 — registry güven kökü

- `register_domain`, `admit_domain`, `set_vk` authorization kontrollerini
  tamamla.
- Domain başına BLS verification key/quorum sakla.
- `renounce_admin` sonrası bütün mutation yollarını test et.
- Evidence parser'ı canonical length/encoding/version kurallarıyla sıkılaştır.

### Faz 2 — BLS canlı doğrulama

- Native Soroban BLS API'nin testnet protocol desteğini gerçek RPC'de doğrula.
- Kaynak simülatör ve kontrat için aynı hash-to-curve, DST, byte order ve
  aggregate public key fixture'ını kullan.
- Full pairing ile bir happy path ve değişmiş signature/root/wrong key ile
  üç negative path çalıştır.
- Eski permissive fonksiyonu ya kaldır ya da yalnızca açıkça insecure test
  helper olarak tut; README'de güvenli yol olarak göstermeme.

### Faz 3 — Groth16/BN254 canlı doğrulama

- Devreyi state root ve message commitment'a bağla.
- VK/proof/public input dönüşümünü Soroban `BytesN` boyutlarıyla sabitle.
- Native multi-pairing ile happy path, wrong VK, modified proof, root mismatch
  negative testleri ekle.
- Lisans ve trusted setup kaynağını `docs/` içinde açıkça yaz.

### Faz 4 — settlement ve ters yön

- Lock -> finalized proof -> mint -> burn -> source unlock akışını tek message
  ID üzerinden tamamla.
- HWM'nin nonce 0, ileri nonce, düşük nonce, aynı message ve expiry senaryolarını
  test et.
- Merkle proof sibling yönü, tek leaf ve çok leaf testlerini canlı kanıtla.
- Gasless reward accounting ile sponsored reserve davranışını birbirinden ayır;
  gerçekten desteklenmeyen classic-account iddiasını yazma.

### Faz 5 — gerçek Testnet deployment

- Admin, issuer, relayer ve demo kullanıcı hesaplarını ayrı tut.
- Registry ve gateway WASM'larını build et; SAC deploy et; gateway'e admin ver.
- Domain/VK/self-test setup işlemlerini gönder; `renounce_admin` çağır.
- Contract ID, network passphrase, tx hash, admin-renounce hash ve explorer
  linklerini `deployments/testnet.json` içine yaz.
- Placeholder varsa demo script canlı başarı kodu döndürmemeli.

### Faz 6 — relayer, anchor ve frontend

- Relayer'ın gerçekten imzalayıp gönderdiği transaction receipt'i sakla.
- Anchor `/info` ile canlı contract/profile verisini birleştir.
- Frontend'de source lock, proof choice, registry verification, gateway mint,
  zero-XLM evidence, burn/unlock ve negative probe panellerini bağla.
- Jürinin tek terminal komutuyla çalıştırabileceği `scripts/demo.sh` hazırlansın.

### Faz 7 — son doğrulama

- `cargo fmt --check`, `cargo test --workspace`, contract WASM build, frontend
  build ve anchor smoke test.
- Local negative matrix ve testnet happy path.
- Tüm repo taraması: ürün adı, eski ürün adı, yasaklı marka, placeholder
  contract ID ve localhost browser çağrıları.
- README'deki test sayısı ve canlı iddialar log çıktılarıyla eşleştirilir.

---

## 6. Test ve canlı kanıt matrisi

Minimum tamamlanma matrisi:

| Alan | Mutlu yol | Reddedilen yol | Canlı kanıt |
| --- | --- | --- | --- |
| Registry admin | bootstrap + setup | non-admin, renounced admin | tx hash + event |
| BLS | valid aggregate + full pairing | wrong sig, wrong key, root mismatch | registry attestation |
| Groth16 | valid proof + public root | wrong VK, modified proof, root mismatch | pairing result/event |
| HWM | nonce 0 ve ileri nonce | replay ve düşük nonce | stored HWM + error |
| Merkle | single/multi leaf | sibling/root mismatch | gateway receipt |
| Gasless | fresh zero-XLM recipient | missing sponsor/invalid fee | recipient balance + relayer reward |
| Reverse flow | burn -> source unlock | duplicate unlock | source event/state |
| Anchor | `/health`, `/info`, SEP-1 | placeholder endpoint | HTTP response + explorer |

Rust testleri unit/integration seviyesindedir; testnet kanıtı onların yerine
geçmez. Soroban mock testleri gerçek ağı taklit ediyor diye canlı entegrasyon
olarak yazılamaz.

---

## 7. Bilerek bırakılan sınırlar ve tehdit modeli

Bu hackathon sürümü audit-grade değildir:

- Kaynak zincir simülatördür; dış zincir consensus'ı gerçek değildir.
- Validator seti ve secret key yönetimi demo amaçlıdır; 3-of-5 production quorum
  değildir.
- Groth16 trusted setup kısa ve test amaçlı olabilir.
- ML-DSA veya başka post-quantum imza katmanı bu sürümde yoktur.
- Bond, fee market, slashing, fraud proof ve validator rotation yoktur.
- Anchor rezervleri, KYC ve uyum katmanı off-chain'dir.
- Relayer tekil olabilir; relayer kötü niyetli olsa bile kanıt doğrulama onu
  mint kararının güven kökü yapmamalıdır.
- Admin renounce öncesi bootstrap anahtarı kritik risktir; renounce sonrası
  değişiklik migration gerektirir.
- Testnet asset gerçek para değildir ve production bridge güvenliği iddiası
  değildir.

README, bu sınırları saklamaz. Çalışmayan bir özellik tamamlandı gibi
anlatılamaz.

---

## 8. Oturum durumu güncelleme kuralı

Her oturum sonunda yalnızca aşağıdaki üç sınıftan biri kullanılacaktır:

- **Tamamlandı:** kod/test/canlı receipt ile doğrulandı.
- **Kısmi:** kod var fakat canlı veya negatif kanıt eksik.
- **Bekliyor:** planlandı, uygulanmadı.

Bir madde tamamlandı işaretlenmeden önce ilgili komut ve sonucu kısa şekilde
Bölüm 3'e eklenir. Yeni bir güvenlik veya kapsam kararı alınırsa önce bu belgeye
karar olarak yazılır, sonra koda geçirilir.
