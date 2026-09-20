# Lumen Gate — Türkçe Tanıtım

**English version: [`README.md`](README.md)**

> **Güven, zincir dışı bir geri arama (callback) olmamalıdır.**

Bu dosya deponun Türkçe anlatımıdır. Kanıt tablolarının tamamı (işlem hash'leri,
ledger numaraları, test sayımları) `README.md` içinde ve `deployments/`
manifestlerinde durur; buradaki her sayı o kayıtlardan okunmuştur. Kural basit:
**bir işlem hash'i manifeste yazılmadan hiçbir cümle "canlı", "1:1" veya
"kanıtlandı" diyemez.**

---

## Tek depo, iki kapı

Bu depo, aynı kanıt kültürünü ve aynı regresyon kapısını paylaşan **iki ayrı
ürün** içerir. Ayrı anlatılmalarının sebebi ayrı olmalarıdır: ayrı kod, ayrı
kontratlar, ayrı dağıtımlar, ayrı konsollar ve ayrı olgunluk durumları. Biri
diğerinin itibarını ödünç almaz.

| | **Gate 1.0 — Uzlaşma sınırı** | **Gate 2.0 — Pasaport + Batarya + Bilet** |
|---|---|---|
| Nedir | Tarafsız finalite katmanı: Stellar anchor'ları, bir Soroban kayıt sözleşmesi BLS/Groth16 finalite kanıtını zincir üstünde doğruladıktan sonra başka domain'lerden değer mutabakat eder | CCTP taşıma ürünü: Sepolia'da tokenlarını USDC'ye çevir, Circle CCTP ile yak, Stellar'da native USDC'yi talep et — yanında ruhu bağlı (soulbound) **Taşıma Pasaportu**, kullanıcıya ait zincir üstü **Batarya** ve devredilebilir **Bilet** kasası |
| Durum | **Dondurulmuş ve kanıtlı.** Testnet kontratları canlı, admin'ler zincir üstünde feragat etmiş, ZK hatları zincir üstünde doğrulanmış, regresyon paketi yeşil | **Geliştirmede.** Çekirdek talep sözleşmesi testnet'te canlı ve init'li (iki kulvar), tüketici demosu canlı, web konsolu canlı (İngilizce, cüzdan-yazma korumalı); BurnRouter v2 yazıldı, test edildi (31/31 + test sahası 8/8) ve deploy scripti hazır ama dağıtılmadı; Batarya ve Bilet yazıldı ve tam test edildi (11/11, 12/12) ama dağıtılmadı |
| Otorite | `DIRECTIVE-1.0.md` | `DIRECTIVE.md` (operatörün kanonik metni) + `HARDENING-2.0.md` |
| Kanıt | `deployments/testnet.json`, `step-chain.json`, `execution-lane.json`, `gate-vm-lane.json` | `deployments/testnet-2.0.json` |
| Konsol | `/` — operatör ve doğrulama konsolu (31 etkileşimli kontrol, gerçek tarayıcıda harness'lı) | `/gate2/` — **aynı Vercel dağıtımında** 2.0 konsolu; tarayıcıdan canlı testnet kontratlarını okur |
| Kod | `contracts/`, `crates/`, `circuits/`, `anchor/`, `api/`, `frontend/`, `tools/` | yalnızca `gate2/` — `evm/`, `soroban/`, `web/`, `scripts/` |
| Dürüst engel | Kaynak zincir tasarım gereği deterministik simülatördür; testnet varlıklarının üretim değeri yoktur | Uçtan uca burn kulvarı iki operatör girdisi bekliyor: Sepolia testnet fonu (captcha'sız musluk bulunamadı) ve router-bağlantı kararı — canlı gate_claim burn'ü yalnızca init anında bağlı olduğu tam router adresinden kabul eder, router o adrese konmalı ya da yeni bir gate_claim ona bağlanmalı |

**Tek uygulama, iki kapı.** Vercel dağıtımı iki konsolu tek origin'den servis
eder: Gate 1.0 kökte (`/`), Gate 2.0 `/gate2/` altında. İki konsolun başlığı
birbirine link verir; yerel geliştirmede 1.0 sunucusu `/gate2`'yi 2.0
sunucusuna proxy'ler, yani yerel deneyim production'ın birebir aynısıdır.
Böylece gerçekte test edilebilir olan her şey **o uygulamadan** test
edilebilir: neyin canlı neyin bloke olduğu aşağıda dürüstçe listelenmiştir.

---

## BÖLÜM I — Gate 1.0: Tarafsız finalite katmanı (donduruldu)

### Değerlendirme

Gate 1.0, kanıtlamaya soyunduğu şeyi kanıtlamış durumda ve donduruldu: kod
yolları kilitli, makbuzları nihai. Tek paragrafta değerlendirme: *alışılmadık
derecede dürüst bir kanıt izine sahip, çalışan, zincir üstünde doğrulanmış bir
uzlaşma sınırı — aşağıdaki her kabul ve her ret, hash'i ile çekilebilen bir
testnet işlemidir — ve tek yapısal sınırı (simüle kaynak zincir) gizli bir eksik
değil, ilan edilmiş bir tasarım sınırıdır.*

### Ne yapar

Bir anchor, kaynak zincir başına ayrı bir köprü işletmek zorunda kalmadan:

1. bir kaynak domain ve finalite politikası kaydeder;
2. bir relayer aracılığıyla BLS veya Groth16 kanıtı kabul eder;
3. Soroban, kanıtı **yerel kriptografik host fonksiyonlarıyla** doğrular (BLS12-381 pairing, BN254 pairing — zincir dışında kontrol yok, oracle yok);
4. wrapped varlığı yalnızca doğrulamadan sonra mint eder ya da serbest bırakır;
5. varlığı yakar ve anchor'da validatör anahtarı tutmadan kaynak zincire ters mesaj yayınlar.

Akış: `kaynakta kilit → BLS/Groth16 kanıtı → Soroban doğrulaması → Stellar mint` ve tersi `Stellar burn → kanonik kontrat olayı → relayer → kaynakta çözme`.

### Zincir üstünde ne var (özet — tüm tablo `README.md` "Receipts" bölümünde)

- **finality_registry** `CCXJDQMT…`: admin zincir üstünde feragat etti; BLS finalitesi kabul edildi (`b181956b…`); aynı kanıtın tekrarı `#9 EvidenceAlreadyProcessed`, bir baytı bozulmuş imza `#7 InvalidSignature` ile reddedildi.
- **settlement_gateway** `CBUKVNCP…`: admin feragatı `f3396d44…`; feragat sonrası ikinci `renounce_admin` tuzağa düştü; feragatten **sonra** iki gasless mint başarılı — sıfır XLM'li hesaba mint (`8b4e9bd5…`), alıcının rezervi bayt bayt aynı kaldı, relayer ücretini wSRC olarak aldı.
- **İleri yön**: kilit → Merkle kanıtı → mint tek işlemde (`3d5d9936…`); **ters yön**: burn → kaynakta çözme (`ca0a1660…`), tekrar oynatma HTTP 409.
- **Zincirlenmiş hat** (ikinci registry `CCR3NZD5…`): 896 bayt anahtar, 3 adımlı zincir kabulü (`2269641a…`), kökleri değiştirilmiş / kısaltılmış / tekrarlanmış kanıtların her biri kendi hata koduyla reddedildi.
- **Yürütme hattı**: 1920 bayt anahtar, 16 adımlık program koşusu kabulü (`70cb914a…`), programı veya adım sayısını değiştiren her mutasyon reddedildi.
- Toplam: **120+ testnet makbuzu ve negatif prob**, hepsi `deployments/*.json` dosyalarında.

### Testler

`cargo test --workspace --lib` → 1.0 paketleri **61 / 17 / 11 / 20 / 28**
(finality_registry / gate_vm / settlement_gateway / domain_adapter /
execution_vm). Devre paketleri ağ gerektirmez: step-chain **18 kontrol**,
execution-trace **34 kontrol**; mutasyonlar yalnızca **hedefledikleri
kısıtta** reddedilirse sayılır. Canlı hatlar `tools/*-live.js` ile gerçek
registry'lere karşı koşulur ve her hash'i manifeste yazar.

### Arayüz

Konsol (`frontend/`), tarayıcıda harness ile doğrulanmış 31 etkileşimli
kontrol içerir; cüzdan bandı ilk ekranda, küpler arka planda etkileşimli,
çerçeve yalnızca işaretçinin altındaki görünür küplerde çizilir. Receipts
kartları pencere gibi açılır kapanır ve **kapalı başlar**. 17 bulgu tam
genişlikte bir bulgu penceresinde kayıtlıdır; başarısızlıklar silinmez.

---

## BÖLÜM II — Gate 2.0: Pasaport + Batarya + Bilet (geliştirmede)

### Değerlendirme

Tek paragrafta: *çekirdek Stellar tarafı talep sözleşmesi gerçek işlem
hash'leriyle testnet'te dağıtılmış, init'lenmiş ve negatif problanmış
durumda; tüketici demosu onu zincir üstünden çapraz kontratla okuyor; web
konsolu Gate 1.0 ile aynı Vercel dağıtımından canlı zincir verisi servis
ediyor — ama kaynak taraftaki burn hiç koşmadı: BurnRouter yazıldı, tam test
edildi ve deploy scripti hazır, yine de dağıtılmadı — çünkü Sepolia fon engeli
sürüyor ve router, canlı gate_claim'in init anında bağladığı tam adrese
konmak zorunda. Üç ürün sütununun tamamı artık var — Pasaport zincirde,
Batarya ve Bilet kontratları yazıldı ve tam test edildi (11/11 ve 12/12) —
ikisi de yerel, ikisi de kendi deploy makbuzunu bekliyor.* Bu bölümdeki hiçbir
cümle, `deployments/testnet-2.0.json` dosyasının kanıtlayabileceğinden daha
bitmiş duyulamaz.

### Ürün

Kullanıcı Ethereum Sepolia'da seçtiği tokenları USDC'ye çevirir ve Circle CCTP
ile yakar (hedef domain 27 = Stellar testnet). Stellar'da yaktığı miktar kadar
**native USDC** alır. Üç parça:

- **Taşıma Pasaportu (soulbound).** Adres başına tek, devredilemez kayıt: "bu
  cüzdan şu kadar değeri Stellar'a getirdi." Her claim aynı pasaportu
  büyütür; başka Soroban kontratları sabit sorgu arayüzüyle okur
  (`get_migration`, `has_migrated_at_least`, `get_proof`, `bump`). Kanıttır,
  satılamaz. *Bugünkü durum: pasaport zincir üstünde tam sorgu arayüzüyle
  storage kaydı olarak VAR; soulbound NFT tokeni ve zincir üstü SVG
  `token_uri` F3'ün açık yarısıdır ve "yapıldı" diye iddia edilmez.*
- **Batarya.** Kullanıcıya ait, zincir üstü, USDC cinsinden ücret bakiyesi.
  Kullanıcının XLM'i olmadığında Stellar işlem ücreti Batarya'dan relayer
  aracılığıyla ödenir. Tonkeeper Battery'den ilham alır; fark şudur: TON'da
  Batarya sağlayıcıda tutulan zincir dışı bir hesaptır, burada **zincir üstü
  ve kullanıcının malıdır**. *Bugünkü durum: kontrat yazıldı ve tam test
  edildi (11/11 — ücret tavanı dahil ve
  `sum(bakiyeler) == kasa USDC` değişmezi), ama **testnet'e dağıtılmadı** —
  gösterilecek zincir üstü bakiye ve canlı `forward` makbuzu henüz yok (F5,
  otomatik ücret web yolu F7 ile birlikte).*
- **Bilet (devredilebilir NFT).** Taşınan USDC'yi cüzdana hemen teslim etmek
  yerine kasada bekleten hak. Bilet devri yalnızca sahipliği değiştirir,
  USDC kasada kalır; trustline'ı olmayan adres de bilet alabilir. Destek
  zincir üstünde herkesçe doğrulanabilir:
  `sum(aktif bilet miktarları) == USDC.balance(gate_ticket)`. Bilet, kasadaki
  native USDC üzerinde **1:1 hak makbuzudur**; köprü varlığı değildir.
  **Hamiline yazılıdır**: yanlış adrese gönderilen veya çalınan bilet geri
  alınamaz; Circle kasa adresini dondurursa tüm biletler etkilenir — bu
  yoğunlaşmış risk saklanmaz, yazılır. *Bugünkü durum: kontrat yazıldı ve tam
  test edildi (12/12 — `sum(aktif biletler) == USDC.balance(kasa)` değişmezi,
  atomik redeem ve XLM'siz `redeem_to_battery` yolu dahil), ama **testnet'e
  dağıtılmadı** — incelenecek kasa henüz yok (F6).*

Neden iki ayrı NFT: Pasaport devredilebilseydi taşıma kanıtı satın
alınabilirdi. Bilet ise bir değer hakkıdır ve devri anlamlıdır. Pasaport
kredisi yakma anında ilk alıcıya yazılır ve sonraki bilet devirlerinden
etkilenmez.

### Akış

```text
[EVM cüzdan] → BurnRouter → swap → USDC → CCTP depositForBurnWithHook (domain 27)

                                        Circle Iris attestation

[Stellar] → GateClaim.claim(mesaj, attestation, …)
    MessageTransmitter.receive_message → native USDC mint
    relay ücreti (≤ kullanıcının tavanı) → relayer    batarya payı → gate_battery
    kalan:  mod 0 → alıcı cüzdanı (6→7 ondalık, ×10)
            mod 1 → gate_ticket kasası (USDC kasada, bilet alıcıda)
    Pasaport güncellenir + MigrationSummary yazılır — tek atomik işlem
```

Çekirdek **relayer'sızdır**: `claim` herkese açıktır ve sonuç her zaman
mesajın içinde bağlı alıcıya gider. Mesajın göndericisinin değişmez BurnRouter
adıresi olduğu doğrulanır; olmayan mesaj reddedilir. Batarya'nın relayer'ı
(F5/F7 gelince) **demo bağımlılığı** etiketi taşır, güven modelinin parçası
değildir. Güven kökü Circle'ın Iris attestation'ıdır — bu sistem "trustless"
değildir ve Circle USDC'yi dondurabilir.

### Şu an Stellar testnet'te canlı olanlar

Her satır gerçek bir işlemdir; Horizon'dan geri okunmuş ve
`deployments/testnet-2.0.json`'a yazılmıştır:

| Kontrat | Adres | Dağıtım / init | Zincir üstü negatifler |
| --- | --- | --- | --- |
| `gate_claim` (kanonik, sertleştirilmiş) | `CDQ3PA5LBLIS22VXJSHXLOPFDD2ZDWPQWODIBLA5KPBOTKIXKOUZI4K2` | deploy `aa421501…` (ledger 4770371), init `21c53dfe…` (ledger 4770385) | çöp claim → `Error #3 MessageTooShort`; ikinci init → `Error #1 AlreadyInitialized` — panik değil, hata kodu |
| `gate_claim` (F3 kulvarı; kampanya buna bağlı) | `CBKSNJBQS4IC6IPUT452RLCJR3I6RH6ELNDZEE5R5TDVO6274AV7IGPC` | create `c17b20a8…` (ledger 4770419), init `af88a0b2…` (ledger 4770426) | re-init reddi; kaydı olmayan cüzdana `get_migration` → `null` (dürüst cevap, canlı servis) |
| `gate_campaign_example` | `CDDQLXIIR3LZ6NT2EFYX2FAZGKPEQPTKHZUC5NLK4BRZYE2JSYDOARCF` | create `8dd80c5a…` (ledger 4770423), init `e6a50507…` (ledger 4770430) | rozetsiz `claim_tier` → `Error #3 NoMigration` (simülasyon; tx gönderilmedi) |
| `gate_stamp` (TESTNET soulbound damgası) | `CAC4XCFEDRRVDEHCJF4VSKVZEFHKYPARSHKLODZU3N4OZWDGYGNCCTDS` | deploy `36a4d188…` | çağıran `stamp(owner)` ile kendine damga basar; ikinci `stamp` → `Error #1 AlreadyStamped` — soulbound kuralı, devir yok, admin yok |
| Circle CCTP testnet (referans) | TokenMessenger `CDNG7HXA…`, MessageTransmitter `CBJ6MTCK…`, native USDC `CBIELTK6…` | — | domain 27, paused değil, min fee 0 — canlı okundu |

İki canlı `gate_claim` bilinçli olarak yan yana durur: sertleştirilmiş kanonik
derleme ve kampanyanın bağlı olduğu daha eski F3 kulvarı. Hiçbiri silinmedi;
ikisi de makbuzlu. `BurnRouter` (Foundry, `gate2/evm`) **yazıldı, test
edildi — v2, 31/31 — ama dağıtılmadı**: router paketinin yanında, konuşacağı
Sepolia CCTP V2 topolojisini bayt bayt sabitleyen deterministik bir
`TestVenue` (8/8) ve bir pre-deploy kapısının ardına koyulmuş deploy scripti
var. Dağıtım ve burn iki operatör girdisi ister: Sepolia testnet ETH ve USDC
(§10 stop-raporu sürüyor) ve router-bağlantı kararı — v2'den beri
`gate_claim`, init anında bağlanan tam `burn_router` adresi dışında her
burn'ü reddeder (kural 9), o bağlı değer manifestte de yok bu sandbox'tan da
okunamadığı için router ya o adrese konmalı (orijinal dağıtıcının anahtarı ve
nonce'u) ya da önce deploy edeceğimiz router'a yeni bir `gate_claim`
bağlanmalı. İki seçenek de `DeploySepolia.s.sol` başlığında yazılı; kararı
deploy anahtarını tutan operatör verir.

### Test paketleri

Aşağıdaki sayıların hepsi bu turda ölçüldü, hatırlanmadı:

- `gate_claim`: **13/13** entegrasyon kanıtı (`tests/claim.rs`) — her iki
  teslim modu (relay ücretiyle cüzdana doğrudan; bilet modunda bilet kasasına
  mint), gerçek iç içe auth altında bataryanın payının bataryaya inmesi ve ret
  matrisi: aynı mesajın tekrarı, bozulmuş attestation, yabancı destination
  caller'lı mesaj, izinsiz kaynak domain, yanlış burn token, hook tavanını
  aşan relay ücreti, sert maksimumu aşan relay ücreti, mint'in tamamını
  kaplayan ücret, karakter kümesinin dışındaki yıldız adı, bağlı router'ın
  yapmadığı bir burn, ikinci `initialize` — her biri kendi hata koduyla,
  asla panik değil.
- `gate_campaign_example`: **5/5** — kademe sınır matrisi, rozetsiz ret,
  kademe yükseltmeleri ve kampanyanın `gate2/zkvm` yürütme yarısıyla aynı
  paylaşımlı dosyadan okuduğu zkVM kademe-paritesi vektörleri — ve **gerçek**
  GateClaim'e karşı tek ortamda koşar.
- `gate_battery`: **11/11** — depozito/çekme/iletim (ücret bataryadan
  relayer'a ödenir), imzalı tavanı aşan ücretin reddi, süresi dolan ve
  tekrarlanan nonce'un reddi, saldırgan relayer'ın tavana çarpması, hedef
  işlem düşerse ücretin geri sarılması, cüzdan USDC'si ile bataryanın ayrı
  defterler olması ve `sum(sahip bakiyeleri) == kasa USDC` değişmezi.
- `gate_ticket`: **12/12** — mint'in USDC'yi kasaya taşıması, devrin yalnızca
  sahipliği değiştirmesi, redeem'in biletin tamamını ödeyip onu yakması
  (ödeme düşerse atomik geri sarılma), `redeem_to_battery`'nin XLM ve
  trustline gerektirmemesi, split'in toplamı koruması, approvals'un kapalı
  olması, minter'ın tek seferlik olması ve canlı
  `sum(aktif biletler) == USDC.balance(kasa)` değişmezi.
- `gate2/evm` (Foundry): **39/39** — tam §5.1 spec'ine karşı BurnRouter v2
  (31/31) ve Sepolia CCTP V2 topolojisini sabitleyen deterministik
  `TestVenue` (8/8).
- Her fazdan sonra regresyon kapısı: `cargo test --workspace --lib` —
  workspace artık **184 geçti, 0 düştü** ölçüyor; 1.0 paketleri
  (61/17/11/20/28) kıpırdamaz. Kıpırdamadı.

### Faz defteri (kanonik F0–F11)

| Faz | Durum |
|---|---|
| F0 Hazırlık | kapalı |
| F1 Spike'lar | S1–S4, S6, S10 kanıtlı; S5, S7–S9, S11, S12 açık |
| F2 Elle burn → kontrat claim | **bloke** — Sepolia fonu (dur ve raporla; sahte yol yok) |
| F3 Pasaport ve sorgu arayüzü | sorgu arayüzü + TTL + zincir üstü dağıtım tamam; soulbound NFT + `token_uri` yarısı açık |
| F4 BurnRouter | v2 tamam: yerelde 31/31 yeşil + TestVenue 8/8; tam §5.1 spec'i (swap+minOut, v1 hook yükü, modlar, yıldız adı, gas payı koruması) dağıtılmış gate_claim'e eklemeli olarak yeniden kapsandı; deploy scripti pre-deploy kapısının ardında (fon + router bağlanması) |
| F5 `gate_battery` | yazıldı, yerelde 11/11 yeşil; testnet'e dağıtılmadı |
| F6 `gate_ticket` | yazıldı, yerelde 12/12 yeşil; testnet'e dağıtılmadı |
| F7 Otomatik ücret stratejisi ve web | konsol kurulu (aşağıda); XLM'siz Batarya yolu F5 deploy'unu bekliyor |
| F8 Tüketici demosu | kapalı — kampanya canlı, kademeler kanıtlı (5/5, zkVM paritesi dahil), rozetsiz ret zincir üstünde kanıtlı |
| F9 Görsel katman (opsiyonel) | dokunulmadı |
| F10 Negatif testler ve kilit | çekirdek + saha negatifleri geçti (EVM 39/39, workspace 184/0); canlı Sepolia kulvarı router deploy'unu bekliyor |
| F11 Self-audit ve dokümantasyon | `self-audit-2.0.js` yazılmadı |

### Web konsolu — dağıtılan uygulamadan bugün test edilebilenler

2.0 konsolu, 1.0 konsoluyla **aynı Vercel dağıtımında `/gate2/`** altında
yayınlanır (tek origin, iki kapı; yerelde 1.0 dev sunucusu `/gate2`'yi 2.0'a
proxy'ler). Adresleri build anında makbuz manifestinden okur — elle kopya ID
yok — ve asla sahte veri çizmez: kayıt yoksa "no record" yazar. Konsol, 1.0
sayfası gibi İngilizcedir ve okumakla yazmak arasında sert bir çizgi çizer:
her okuma cüzdan olmadan çalışır; imza isteyen her buton (Friendbot,
trustline, TTL bump, TESTNET damgası, `claim_tier`) yalnızca **testnet'teki**
bağlı bir Freighter'a kilitlidir — ağ, kullanım anında yeniden kontrol
edilir, yani bağlandıktan sonra mainnet'e geçirilen bir cüzdan burada imza
atamaz.

Şu an tarayıcıdan, gerçek testnet durumuna karşı canlı test edilebilenler:

- **Taşıma Kanıtım:** herhangi bir Stellar adresi girin (veya Freighter
  bağlayın): *her iki* canlı `gate_claim` dağıtımında `get_migration` okunur,
  NFT kayıtları listelenir (`proofs_of` → `get_proof` / `get_meta` /
  `owner_of`), canlı kampanyada `claim_tier` simüle edilir — rozetsiz adres
  sözleşmenin `NoMigration` reddini gözle görülür biçimde alır. Freighter
  bağlıysa `claim_tier` gerçek imzalı işlem olarak gönderilebilir.
- **Burn Ekranı ön koşulları:** alıcı adresinin StrKey doğrulaması ve gerçek
  Horizon USDC-trustline kontrolü — burn butonunu koruyacak iki kapı — ayrıca
  geri alınamazlık "BURN yazdırma" kilidi; router yokken bu kilit hiçbir
  koşulda açılamaz.
- Bilinçli olarak **gösterilmeyenler:** token listesi, fiyat önizlemeleri,
  açılmış bir BURN butonu. Router dağıtılmadı; bu yüzden burn ekranı demo
  sahnelemek yerine engelini yazar. F2/F4 geldiğinde ekran, zaten okuduğu
  manifestten aydınlanır.

Bunların hepsi gerçek headless tarayıcıda makineyle doğrulanır:
`gate2/scripts/check-gate2-web.mjs` (16/16 yeşil, sıfır başarısız istek) ve
1.0 tarafında `tools/check-live-page.js` (31 kontrol erişilebilir, çerçeve
kontratı yerinde, sıfır başarısız istek).

### Bilinen sınırlar — yazılmaları gereken yerde

- Pasaport **cüzdan bazlıdır**: çok cüzdanla sybil mümkündür.
- Güven kökü **Circle'ın Iris attestation'ıdır**. "Trustless" kelimesi
  kullanılmaz. Circle USDC'yi dondurabilir; donmuş bir kasa adresi tüm
  biletleri etkiler.
- CCTP mesajları **geri alınamaz**: yanlış hook hedefi kalıcı kayıptır —
  BurnRouter'ın spec'i karşılanıp fon gelmeden ve canlı gate_claim'in
  bağladığı adrese (ya da ona bağlanacak yeni bir gate_claim'e) konmadan
  dağıtılmamasının sebebi budur.
- Batarya'nın ücret ödeyen relayer'ı üçüncü taraf bir **demo bağımlılığıdır**,
  yapılandırılabilirdir ve kullanıcının imzaladığı ücret tavanını aşamaz —
  güven çapası değildir.
- "Otomatik" ve "XLM'siz" ifadeleri yalnızca F7 kanıtlanınca yazılır ve şu
  cümleyle: ağ ücretini relayer XLM ile öder, karşılığını kullanıcının
  Bataryasından USDC ile alır.

### Engel, açıkça

F2 — tek gerçek uçtan uca burn — iki operatör girdisi ister. İlki Sepolia
testnet ETH (gas) ve USDC: yazım anında captcha'sız musluklar erişilemezdi,
bu yüzden direktifin §10 kuralı gereği iş **durdu ve raporladı** — burn
simüle edilmedi, hash uydurulmadı. İkincisi router-bağlantı kararı: canlı
`gate_claim`, burn'ü yalnızca init anında bağlanan tam `burn_router`
adresinden kabul eder, o bağlı değer manifestte yok ve bu sandbox'tan
okunamadığı için router ya o adrese konmalı (orijinal dağıtıcının anahtarı ve
nonce'u) ya da önce deploy edeceğimiz router'a yeni bir `gate_claim`
bağlanmalı. İki seçenek de `gate2/evm/script/DeploySepolia.s.sol`
belgelenmiştir ve kararı deploy anahtarını tutan operatör verir. Bu girdileri
gerektirmeyen her şey yine de inşa edilip kanıtlandı: claim yolu, kampanya,
konsol, Batarya ve Bilet kontratları ve negatif problar bitti; burn kulvarı
dürüstçe bitmedi.

---

## Yerel çalıştırma (özet)

```bash
# 1.0 yığını: simülatör + facade + api + konsol
cargo build -p source_simulator
SOURCE_ASSET_ID=CBPBDVLP… ./target/debug/source_simulator --port 8080
cd anchor && PORT=8081 SIM_URL=http://127.0.0.1:8080 … npm start
API_PORT=3001 SOURCE_URL=http://127.0.0.1:8081 … node tools/api-dev-server.js
cd frontend && npm run dev                 # http://localhost:5173

# 2.0 konsolu
cd gate2/web && npm install && npm run dev # http://localhost:5174/gate2/
                                           # (proxy ile: 5173/gate2/)

# Kanıt harness'ları
node tools/check-live-page.js              # 1.0: 31 kontrol
node gate2/scripts/check-gate2-web.mjs     # 2.0: 16 kontrol, canlı zincir
cargo test --workspace --lib               # regresyon kapısı
```

## Lisans

Depo kodu, bir dosya aksi söylemedikçe MIT'dir. İçe aktarılan devre
artefaktları kendi lisanslarını korur.
