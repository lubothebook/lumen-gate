# DIRECTIVE 2.0 — Lumen Gate: Pasaport + Batarya + Bilet (CCTP)

Not (eklenen 2026-09-20): Guven otoritesi eki belgenin kendisi olarak repoda:
`HARDENING-2.0.md`. Bu direktifle catistigi yerde dur ve rapor kurali gecerli;
simtilik bilinen catisma yok. Durus tablosu: `deployments/hardening-2.0.json`.

Not (2026-09-20, operator kanonik metni): Bu dosya operatorun 2026-09-20'de
bizzat verdigi tam metnin simtilik halidir (Pasaport + Batarya + Bilet; F0-F11;
10 degismez kural). Repoda dolasan "Proof of Migration" ozet stub'i degil, bu
metin esastir; stub'in eksik biraktigi F4-F7 kapsami (swap, v1 hook yuku,
gate_battery, gate_ticket) bu metinle geri geldi.

> **Bu belge bir yapay zeka kodlama ajanina verilir.** Ajan bu belgeyi, `README.md`'yi ve `DIRECTIVE-1.0.md`'yi okumadan tek satir kod yazmaz. Kanit once, iddia sonra: hicbir "canli", "1:1", "otomatik", "XLM'siz" ifadesi, ilgili testnet islem hash'i `deployments/testnet-2.0.json` icine yazilmadan hicbir dosyaya giremez.

## 0. Surum adlandirmasi

- **Gate 1.0** = repodaki mevcut sistem: Registry, Gateway, source_simulator, relayer, BLS/Groth16 hatlari, anchor facade, Vercel console. **Dondurulmustur.**
- **Gate 2.0** = bu belgedeki yeni urun.

## 1. Ajan olarak calisma bicimin

1. Fazlari sirayla yurut (Bolum 7). Bir faz, kabul kriteri **kanitla** karsilanmadan kapanmaz.
2. Her fazin sonunda: testleri calistir, kaniti `deployments/testnet-2.0.json`'a yaz, commit at (`gate2(F<n>): ...`), **faz raporu** ver (Bolum 9).
3. Kaniti **asla uydurma.** Adres, tx hash, mesaj hash'i, attestation ve bakiye yalnizca gercek testnet ciktisindan gelir. Mock Iris, "assume valid" dali veya elle yazilmis hash yasaktir.
4. Engelle karsilasirsan **dur ve raporla** (Bolum 10). Sahte bir yol acarak ilerleme.
5. Gizli anahtari commit etme. Anahtarlar ortam degiskeninden gelir. Yalnizca testnet hesaplari.
6. Cozemedigini "calisiyor" diye yazma. Bulguyu `findings[]` altina yaz, basarisizliklar silinmez.

## 2. Urun

Kullanici bir EVM aginda (Ethereum Sepolia) sectigi tokenlari USDC'ye cevirir ve Circle CCTP ile yakar. Stellar'da yaktigi miktar kadar native USDC alir. Uc parca vardir:

- **Tasima Pasaportu (devredilemez NFT):** adres basina tek, "bu cuzdan su kadar degeri Stellar'a getirdi" kaydi. Zincirde uretilen SVG ile buyur, `get_migration(adres)` ile baska kontratlarca okunabilir. **Kanittir, satilamaz.**
- **Batarya:** gelen USDC'nin bir kismi kullaniciya ait, ayrilmis bir "ucret bakiyesi"ne yazilir. Kullanicinin XLM'i olmadiginda Stellar islem ucreti **otomatik** olarak buradan (USDC ile) odenir. Ilham: Tonkeeper Battery. Orada Battery saglayicida tutulan off-chain bir hesaptir, bizde **zincir ustu ve kullaniciya aittir**.
- **Bilet (devredilebilir NFT):** tasinan USDC'yi hemen cuzdana teslim etmek yerine **kasada bekleten** bir hak. Bilet sahibi istedigi an USDC'yi ceker. **Iki Stellar cuzdani arasinda bilet devri sadece sahipligi degistirir, USDC kasada kalir.** Alicinin USDC trustline'i olmasa da bileti alabilmesi ve gonderenin XLM'i olmasa da (Batarya ile) gonderebilmesi hedeflenir.

**Neden iki ayri NFT:** Pasaport devredilebilseydi tasima kaniti satin alinabilirdi. Bilet ise bir deger hakkidir ve devredilmesi anlamlidir. **Pasaport kredisi yakma aninda ilk aliciya yazilir ve biletin sonraki devirlerinden etkilenmez.**

Fark yaratan seyler: Circle attestation'li kalici tasima kaydi, Soroban kontratlarinin sorgulayabildigi arayuz, XLM'siz ilk claim'den itibaren akis, relayer'siz cekirdek ve kanit-once kulturu.

Bilinen sinirlar (README'ye yazilir): pasaport kaniti **cuzdan bazlidir**, cok cuzdanla sahtecilik (sybil) mumkundur. Bilet **hamiline yazili** bir haktir (bearer): yanlis adrese gonderilen veya calinan bilet geri alinamaz.

## 3. Degismez kurallar

1. **Cekirdekte relayer yok.** `claim` permissionless'tir, sonuc her zaman mesajda bagli aliciya gider. Bizim islettigimiz sunucu, anahtar veya operator token'i yoktur. *Batarya modulu ag ucretini odemek icin ucuncu taraf bir relayer kullanir. Bu bir "demo bagimliligidir", guven modelinin parcasi degildir (D5).*
2. **Custody yok, iki sinirli istisna: `gate_battery` ve `gate_ticket`.** `BurnRouter` ve `GateClaim` fon tutmaz, islem sonu bakiyeleri sifirdir. Istisna kontratlar kullanici haklarini tutar ve su kosullara baglidir: admin yok, pause yok, upgrade yok, USDC'nin tek cikis yolu sahibin yetkilendirdigi cekim/iade fonksiyonudur.
3. **Admin yok.** Deploy sonrasi `renounce_admin` veya bastan adminsiz. Upgrade yok. Tek seferlik baglama (`init`) yalnizca deploy betiginde bir kez calisir, ikinci cagri revert eder (test).
4. **Sinirsiz approval yasak.** Token basina tam miktar approve veya Permit2. Bilet NFT'sinde `approve` ve `approve_for_all` varsayilan olarak devre disidir (D8).
5. **Kullanici secmeden hicbir tokena dokunulmaz.** "Hepsini sec" butonu var ama varsayilan kapalidir.
6. **Pasaport devredilemez, Bilet devredilebilir.** Pasaportta transfer fonksiyonlari yoktur veya trap eder.
7. **Bilet destegi 1:1 ve zincirde dogrulanabilir.** `Σ (mevcut biletlerin miktari) == USDC.balance(gate_ticket)` her zaman dogru olmalidir ve herkes bunu kendi basina okuyabilmelidir. Bilet, kasadaki native USDC uzerindeki bir haktir. Bir kopru varligi (bridge-wrapped token) degildir, ama README bunu "hak makbuzu" diye acikca adlandirir.
8. **Guven modeli durust yazilir.** Guven koku Circle'in Iris attestation'idir. "Trustless" kelimesi kullanilmaz. Circle USDC'yi dondurabilir. **Kasa adresi dondurulursa tum biletler etkilenir, bu yogunlasmis bir risktir** ve README'de yazilir.
9. **Mesajin gondericisi dogrulanir.** `GateClaim`, CCTP mesajindaki gonderici alaninin degismez `BurnRouter` adresi oldugunu kontrol eder, aksi halde revert eder. Hook icerigi (ucret tavani, batarya miktari, mod, isim, bilesim) sahte olamaz.
10. **Testnet.** Mainnet icin ayri, acik bir insan karari gerekir.

### 3.1 Durum (guncellendi 2026-09-20, kanonik directive'e gore, gate-2.0 @ e3a6952)

- Kural 1 (cekirdekte relayer yok): gate_claim testnet'te `CDQ3PA5LBI...`; `claim` anyone-call, alici mesaj-ici sabit - on-chain negatif kanitli (junk -> Error #3). Bataryanin demo-relayer ayrimi F5 yazilirken README'ye aynen islenecek.
- Kural 2 (custody + iki istisna): BurnRouter 23/23 ve gate_claim 7/7 sifir-bakiye testleriyle; `gate_battery`/`gate_ticket` HENUZ YAZILMADI - istisnalarin kosullari (adminsiz, pausesuz, tek cikis) onlarla birlikte dogrulanacak.
- Kural 3 (admin yok): gate_claim constructor penceresi initialize ile kapandi, ikinci init Error #1 - kanit zinciri s19/s21.
- Kural 4-5: EVM'de unlimited-approval deseni tasarin cikarildi (venue-allowance olduru, s14-s15 rebuttal'lari audit_ignores'ta); D8 bilet-onay-trap'i gate_ticket ile gelecek.
- Kural 6 (pasaport devredilemez): pasaport su an STORAGE KAYDI - soulbound NFT tokeni ve token_uri URETILMEDI; F3 kabul'unun NFT yari ACIK (asagidaki F3 satirina bakin).
- Kural 7 (bilet destegi 1:1): gate_ticket yok - degismez ozellik testiyle F6'da kanitlanacak.
- Kural 8-9: guven modeli README §7 notu + Circle cift-sayfa dogrulamasi (F1) yapildi; kural 9 gonderici-dogrulama gate_claim parse'inda VAR (burnFrom kontrolu, test #4).
- Kural 10 (testnet): mainnet kontrol listesi HARDENING-2.0.md'de tamamiyla isaretsiz - operator karari bekleniyor.
- Faz durumu (kanonik numaralandirma): F0 kapali. F1: S1-S4, S6, S10 kanitli; S5, S7, S8, S9, S11, S12 KANITLANMADI (NFT/batarya/relayer spike'lari). F2 fon bekliyor (driver exit 3). F3: sorgu-arayuzu + TTL + on-chain deploy KAPALI; soulbound-NFT + token_uri YARISI ACIK. F4: BurnRouter 23/23 yesil ama §5.1 TAM spec'i karsilamadi (swap+minOut, v1 hook yuku, mod, yildiz adi, gas-payi korumasi) - mevcut uretim-alt kumesi kanitli, genisleme F4 acik. F5-F7: YAZILMADI. F8 kapali (campaign 3/3, kademe sinir matrisiyle). F9 opsiyonel, dokunulmadi. F10: cekirdek negatifleri gecti, batarya/bilet bloklari kontratlarsiz bekliyor. F11 self-audit-2.0.js YAZILMADI.
- Regresyon kapisi notu: directive'in saydigi 12/11/3, 1.0'in yazim-anindaki sayimdir; repoda buyuyen taban 61/17/11/20/28 olarak olculuyor ve CI her crate'te dustukte kirmiziya ceviriyor - kural "aynen gecmeli, duserse dur" hem eski hem yeni sayim icin saglanir.

## 4. Kapsam siniri: neye dokunulur

**Dokunma (1.0, dondurulmus):** `contracts/`, `crates/`, `anchor/`, `circuits/`, `api/`, `frontend/`, `tools/`, `scripts/`, `vercel.json`, `deployments/testnet.json`, `deployments/self-audit.json`. Bunlar yollara baglidir. **Tasima, yeniden adlandirma yok.**

**Izinli degisiklikler:**
- `git mv DIRECTIVE.md DIRECTIVE-1.0.md` ve en uste "Bu belge Gate 1.0 icindir." satiri.
- Kok `Cargo.toml`: yalnizca `gate2/soroban/*` uyelerini ekle.
- `README.md` ve `README.tr.md`: "Gate 1.0 ve Gate 2.0" bolumu ekle. Mevcut kanit tablolarini degistirme.

**Yeni kod yalnizca buraya:**

```
gate2/
  evm/        BurnRouter (Foundry)
  soroban/    gate_claim, gate_battery, gate_ticket, gate_campaign_example
  web/        Burn Ekrani, Tasima Kanitim, Batarya, Biletlerim (ayri Vite uygulamasi)
  scripts/    spike'lar, uctan uca testler, self-audit
deployments/testnet-2.0.json
deployments/self-audit-2.0.json
docs/GATE2_TRUST_MODEL.md
```

Calisma dali: `gate-2.0`. **Regresyon kapisi:** her fazdan sonra `cargo test --workspace --lib`. 1.0 testleri (12 / 11 / 3) aynen gecmeli, duserse dur.

## 5. Mimari

```
[EVM cuzdan] → BurnRouter → swap → USDC → CCTP depositForBurnWithHook (domain 27)
                                                   │
                                        Circle Iris attestation
                                                   │
[Stellar hesabi] → GateClaim.claim(message, attestation, relayer, relay_fee)
     ├─ MessageTransmitter.receive_message → USDC mint
     ├─ relay ucreti (≤ kullanicinin tavani) → relayer
     ├─ batarya miktari → gate_battery.deposit(alici)
     ├─ kalan USDC:
     │     mod 0 (varsayilan) → alicinin cuzdanina (6→7 ondalik: × 10)
     │     mod 1 (bilet)      → gate_ticket.mint_ticket(alici)   [USDC kasaya, bilet aliciya]
     ├─ Pasaport guncelle + MigrationSummary (kredi ilk aliciya)
     └─ hepsi tek atomik islem

[Bilet devri]   gate_ticket.transfer(a → b)     // sadece sahiplik, USDC kasada
[Bilet cekimi]  gate_ticket.redeem(id, to)      // bileti yak, USDC'yi ode
[Sonraki her Stellar islemi, XLM yoksa]
     web → fee quote → gate_battery.forward(...) → relayer ucreti Bataryadan odenir
```

### 5.1 `BurnRouter` (Solidity)

- Girdi: token listesi, miktarlar, token basina `minOut`, Stellar alici adresi, `relay_fee_cap`, `battery_amount`, `mod` (0 veya 1), opsiyonel yildiz adi.
- Swap router, USDC ve TokenMessenger adresleri **immutable constructor argumani**.
- Yakilan miktar = swap sonrasi **gercekten alinan USDC** (bakiye farki).
- `depositForBurnWithHook`: `destinationDomain = 27`, `mintRecipient = destinationCaller = GateClaim` (D1).
- **hookData duzeni** (Circle'in hook formati esastir, bu duzen entegrator yukudur, S10 ile dogrulanir; toplam ≤ 256 bayt):
  ```
  24 bayt sifir (magic) | uint32 versiyon=1 | uint32 yuk uzunlugu
  yuk: u8 bayraklar (bit0 yildiz adi, bit1 bilesim, bit2 bilet modu)
       | u128 relay_fee_cap (6 ondalik) | u128 battery_amount (6 ondalik)
       | u8 alici uzunlugu + alici strkey (UTF-8)
       | [bit0] u8 ad uzunlugu + ad (yalniz [A-Za-z0-9 ], ≤ 24)
  ```
- Kaynak tarafta dogrulanir: sekil ve uzunluk, `relay_fee_cap + battery_amount < amount`, ad karakter kumesi. Hatali hook geri alinamaz kayip yaratabilir.
- **Gas payi korumasi:** ETH secilirse router/UI, `estimateGas × maxFeePerGas × 1.5` kadarini ayirir, o kisim yakilamaz.
- Sahip, upgrade ve fon cikis fonksiyonu yok.

### 5.2 `GateClaim` (Soroban)

`claim(message: Bytes, attestation: Bytes, relayer: Address, relay_fee: i128)`:

1. Mesaji ayristir. Dogrula: kaynak domain izinli, hedef domain 27, `mintRecipient == destinationCaller == self`, `burnToken` beklenen USDC, **gonderici == BurnRouter** (kural 9).
2. `MessageTransmitter.receive_message`. Replay korumasi CCTP nonce'undan gelir. Mesaj hash'ini saklayip idempotency icin ayrica kontrol et.
3. Dogrula: `relay_fee ≤ relay_fee_cap`, `relay_fee ≤ MAX_RELAY_FEE` (S8 belirler), `relay_fee + battery_amount ≤` mint edilen net miktar. Aksi halde revert.
4. Dagit (hepsi `× 10` ile 7 ondalik): `relay_fee` → `relayer` (alici kendisi gonderirse 0 olabilir), `battery_amount` → `gate_battery.deposit(self, alici, miktar)`, kalan → **mod 0:** aliciya, **mod 1:** `gate_ticket.mint_ticket(self, alici, miktar, meta)`.
5. Pasaportu guncelle ve `MigrationSummary`'yi yaz. Kredi, mod ne olursa olsun **mesajdaki ilk aliciya** gider.

`relay_fee` bir **tavandir**, relayer'lar arasinda rekabetle duser. Kendi XLM'i olan kullanici kendi claim'ini gonderirse ucret 0 olur.

### 5.3 `gate_battery` (Soroban)

Kullaniciya ait, USDC cinsinden ucret bakiyesi. Ayristirilmis: kullanici cuzdanindaki USDC'yi harcasa bile Batarya'ya dokunamaz.

```
deposit(from: Address, owner: Address, amount: i128)     // from auth; herkes herkesin bataryasini doldurabilir
withdraw(owner: Address, amount: i128)                   // owner auth; her zaman acik
balance_of(owner: Address) -> i128
forward(owner, relayer, fee, max_fee, expiry, nonce, target, fn, args)
    // owner auth (imza: max_fee, expiry, nonce, target, fn, args'i kapsar)
    // kurallar: fee ≤ max_fee, ledger < expiry, nonce tekil
    // fee'yi bataryadan relayer'a oder, sonra hedef kontrati cagirir; biri basarisizsa hepsi geri alinir
```

- **Uygulama:** OpenZeppelin Stellar `fee-abstraction` paketindeki `FeeForwarder` semantigini temel al (kullanicinin imzaladigi tavan, atomik ucret toplama). Sifirdan kripto yazma. Ucret kaynagi kullanicinin allowance'i yerine batarya bakiyesidir (S8).
- **Degismezler (ozellik testiyle kanitlanir):** `Σ balance_of(owner) == USDC.balance(gate_battery)`; `withdraw` hicbir kosulda engellenemez; `forward` sahibin imzasini asan tutari asla cekemez.
- State archival: kayitlarin TTL'i yazmada uzatilir, `bump(owner)` herkese acik.

### 5.4 `gate_ticket` (Soroban): Bilet ve kasa

Hem NFT (SEP-50, OpenZeppelin `non-fungible`) hem kasa. Bilet mint edilince USDC ayni kontratta tutulur, bilet yakilinca ayni miktar cikar. Tek kontrat oldugu icin degismez tek yerde dogrulanir.

```
mint_ticket(from, to: Address, amount: i128, meta) -> u64     // yalnizca GateClaim cagirabilir
transfer(from, to, id)                                        // SEP-50 standardi; USDC hareket etmez
redeem(id: u64, to: Address)                                  // sahip auth; bileti yak, USDC'yi to'ya ode
redeem_to_battery(id: u64)                                    // sahip auth; USDC → gate_battery.deposit(sahip)
split(id: u64, amounts: Vec<i128>) -> Vec<u64>                // sahip auth; Σ amounts == amount; opsiyonel
get_ticket(id) -> Ticket { amount /*7 ondalik*/, source_domain, msg_hash, minted_ledger, origin }
value_of(owner) -> i128                                       // sahibin toplam bilet degeri
```

- **Yalnizca `GateClaim` mint edebilir.** Baglama tek seferlik `init_minter` ile yapilir (kural 3), ikinci cagri revert eder. Elle mint, admin mint ve toplu mint yoktur.
- **Redeem guvenligi:** odeme `to`'nun trustline'i yoksa revert eder ve **bilet yanmadan kalir**. Islem atomiktir: once bilet yanar, sonra USDC gider, biri basarisizsa hepsi geri alinir. Ayni bilet ikinci kez cekilemez.
- **`redeem_to_battery`:** XLM ve trustline gerekmeden bileti dogrudan Batarya bakiyesine cevirir.
- **Devir:** `transfer` bir Soroban cagrisidir, ucreti XLM ile veya Batarya `forward`'iyla odenir. Alicinin trustline'i cekim anina kadar gerekmez (S11).
- **Onaylar:** `approve` ve `approve_for_all` devre disidir (D8). Ilk surumde pazar yeri listelemesi yok, sadece dogrudan sahip devri.
- **Enumerasyon:** sahibin biletlerini listelemek icin OpenZeppelin Enumerable varyanti veya kendi indeksin (S12).
- **Degismezler (ozellik testiyle):** `Σ amount(mevcut biletler) == USDC.balance(gate_ticket)`; `transfer` USDC bakiyesini degistirmez; `split` toplami korur; kasadan USDC yalnizca `redeem` ve `redeem_to_battery` ile cikar.
- **`token_uri`:** sade JSON (miktar, kaynak zincir, mesaj hash'i, tarih). SVG uretimi yalnizca Pasaporttadir.

### 5.5 Otomatik ucret stratejisi (`gate2/web`)

Kullanici hicbir mod secmez. Uygulamadaki **her** Stellar islemi (bilet devri ve cekimi dahil) bu karardan gecer:

1. Soroban RPC `simulateTransaction` ile ucreti tahmin et, `× 1.2` marj ekle.
2. Harcanabilir XLM (rezervler dusulmus) ≥ ucret → **normal yol**, kullanici XLM ile oder.
3. Aksi halde Batarya bakiyesi ≥ relayer'in USDC teklifi → **Batarya yolu**: relayer'dan teklif al, `forward` islemini kur, kullanici normal imza adiminda yetki girdisini imzalar, relayer gonderir. Bildirim: "Batarya kullanildi: −0.004 USDC".
4. Batarya da yetmezse → "Batarya bos" ekrani: cuzdandaki USDC veya bir biletle (`redeem_to_battery`) doldur.

- **Relayer yapilandirilabilir:** `RELAYERS` listesi (OpenZeppelin Relayer uyumlu teklif ve sponsorlu islem uclari). Uygulama en dusuk teklifi secer. Relayer hicbir yetkiye sahip degildir, kullanici imzasindaki tavani asamaz.
- Arayuzde Batarya gostergesi: bakiye ve tahmini islem sayisi. Bu tahmin off-chain hesaplanir, zincirdeki deger yalnizca USDC'dir.
- **Yakit payi uyarisi:** cuzdan USDC'sini harcayan bir islem Batarya disindaki bakiyeyi sifirlarsa ekran "Batarya ayri ve guvende" der. Batarya bossa doldurma onerir.

### 5.6 Tasima Pasaportu (soulbound NFT, sorgu arayuzu)

- Adres basina **tek** NFT. Her claim ayni NFT'yi buyutur. Transfer, approve ve benzeri fonksiyonlar yok veya trap eder (S5: OpenZeppelin `non-fungible` `Base` + `ContractOverrides`, SEP-50 taslaktir).
- `token_uri` gorseli **zincirde** uretir (SVG, base64 data URI). Sunucu ve IPFS yok. Boyut ve CPU siniri S7 ile dogrulanir, asilirsa sade metadata'ya geri dusulur.
- **Sorgu arayuzu (sabit sozlesme):**
  ```
  get_migration(owner) -> Option<MigrationSummary>
      MigrationSummary { total_usdc: i128 /*6 ondalik*/, claim_count: u32,
                         first_ledger: u32, last_ledger: u32, sources: Vec<u32> }
  has_migrated_at_least(owner, min_usdc: i128) -> bool
  get_proof(id: u64) -> MigrationProof
  bump(owner)
  ```
- **Gorsel katman (opsiyonel, cekirdegi bloke etmez):** her tasima bir yildiz; konum ve sekil CCTP mesaj hash'inden, parlaklik miktardan, renk kaynak zincirden. Yildizlar zaman sirasiyla baglanir, gorselde son 24'u cizilir. Yildiza ad verme (karakter kumesi router'da ve `GateClaim`'de suzulur, ciktida tekrar kacislanir). Yakilan token bilesimi ("spektrum") **varsayilan kapalidir**, gonderici dogrulamasi (kural 9) olmadan acilmaz.

### 5.7 `gate_campaign_example` (tuketici demosu)

`GateClaim`'in yazdigi `get_migration`'i cagiran, **fon tutmayan** ornek kontrat. `claim_tier(owner)`: `>= 10 USDC` Bronze, `>= 100` Silver, `>= 1000` Gold. Odul tokeni veya hazine yok.

### 5.8 Web sayfalari

- **Burn Ekrani:** token listesi, satir basina "→ USDC" onizlemesi, ucret satiri, **teslim sekli** (dogrudan cuzdana / Bilet olarak kasada), Batarya payi (varsayilan `min(1 USDC, %10)`, 0 yapilabilir), relay ucreti tavani, opsiyonel yildiz adi. Likiditesiz/honeypot ve toz gizlenir. Islem basina ust limit, geri alinamazlik uyarisi, "BURN" yazdirma. Stellar adresi `StrKey` ile dogrulanir.
- **Tasima Kanitim:** `get_migration`, pasaport gorseli, kampanya kademesi.
- **Batarya:** bakiye, doldur, cek, son ucret harcamalari.
- **Biletlerim:** bilet listesi ve toplam deger, **Gonder** (Stellar adresi dogrulamasi, "bilet hamiline yazilidir, yanlis adres geri alinamaz" uyarisi), **Cek** (`redeem`, trustline yoksa once acilisi gosterir), **Bataryaya cevir**, opsiyonel **Bol**. Onay/`approve` istegi hicbir yerde yok.
- `frontend/` ve `vercel.json` degismez.

## 6. Sabit kararlar

- **D1 — Alici tasarimi.** Varsayilan **G**: `mintRecipient = destinationCaller = GateClaim`, sadece Gate mesaji tuketebilir. **Yedek F:** `CctpForwarder.mint_and_forward`'u sarmak (herkese aciktir, biri dogrudan cagirip mesaji tuketirse pasaport, Batarya ve Bilet hic olusmaz). **S1 karar verir.** `destinationCaller` veya `mintRecipient` yanlissa fon **kalici olarak** takilir, S1 kaniti olmadan `BurnRouter` yazilmaz.
- **D2 — NFT'ler.** Iki ayri kontrat: Pasaport (devredilemez, kanit) ve Bilet (devredilebilir, USDC hakki). Odul emisyonu ve sponsor havuzu bu surumde **yok**.
- **D3 — Hiz.** Varsayilan standart (2000).
- **D4 — Kaynak zincir.** Ethereum Sepolia.
- **D5 — Batarya.** Zincir ustu, USDC cinsinden, kullaniciya ait. Ag ucretini odeyen relayer ucuncu taraftir ve yapilandirilabilir, testnet demosu icin bir relayer calistirilabilir ama README'de "demo bagimliligi" diye etiketlenir.
- **D6 — Varsayilan Batarya payi:** `min(1 USDC, %10)`. Kullanici 0 secebilir.
- **D7 — Teslim sekli.** Varsayilan **mod 0** (dogrudan cuzdana). Bilet modu kullanicinin bilincli secimidir.
- **D8 — Bilet onaylari.** `approve` ve `approve_for_all` devre disi (trap), cuzdan bosaltici (drainer) yuzeyini kapatmak icin. S12'de OpenZeppelin bunu override etmeye izin vermezse: onaylar acik kalir, UI onay istemez ve README'ye SEP-50 uyum notu ve risk yazilir.

## 7. Fazlar ve kabul kriterleri

**F0 — Hazirlik.** Dal, Bolum 4'teki izinli degisiklikler, `gate2/` iskeleti, bos manifest. *Kabul:* 1.0 testleri degismeden geciyor, `git diff` yalnizca izinli dosyalar.

**F1 — Spike'lar.** Sonuclar manifestte `spikes[]` altinda, kanitli.

| # | Soru |
|---|------|
| S1 | `GateClaim` hem `mintRecipient` hem `destinationCaller` olarak calisiyor ve `receive_message`'i dogrudan cagirabiliyor mu? (Hayirsa D1 → F) |
| S2 | Ethereum Sepolia → Stellar testnet (domain 27) hatti, Iris sandbox API'si, testnet kontrat adresleri (Circle docs'tan) |
| S3 | `amount`, `maxFee`, `feeExecuted` iliskisi: Stellar'da mint edilen net miktar |
| S4 | Kontrat bakiyesi icin trustline gerekir mi? Alici icin evet (Circle docs), dogrula. Hesap yoksa olusturma ve trustline rezervi nasil karsilanir (sponsored reserves veya akilli cuzdan / C adresi)? |
| S5 | Devredilemez Pasaport: OpenZeppelin `non-fungible` `Base` + override yeterli mi? |
| S6 | Hizli (1000) ve standart (2000) modda ucret ve sure |
| S7 | Zincirde SVG uretimi Soroban okuma/CPU sinirlarina sigiyor mu? En fazla kac yildiz? |
| S8 | OpenZeppelin `fee-abstraction` (`FeeForwarder`) ucreti kullanici allowance'i yerine batarya bakiyesinden almaya uyarlanabiliyor mu? Gercek ucret araligi, `MAX_RELAY_FEE` degeri |
| S9 | OpenZeppelin Relayer'in teklif ve sponsorlu islem uclari testnet'te `forward` cagrisini tasiyabiliyor mu? |
| S10 | Circle Stellar hook formati ile 5.1'deki entegrator yuk duzeni uyumlu mu, boyut siniri nedir? |
| S11 | Stellar'da henuz hesabi/trustline'i olmayan bir adrese Bilet mint ve transfer edilebiliyor mu? Redeem icin gereken en az kosul nedir? |
| S12 | Bilet icin `approve`/`approve_for_all` override edilebiliyor mu? Sahibe gore bilet listeleme (Enumerable veya ozel indeks) mumkun mu? |

*Kabul:* S1–S12 kanitli, D1 ve D8 kesinlesti.

**F2 — Elle burn, kontrat claim.** Script ile `depositForBurnWithHook`, sonra `GateClaim.claim` (mod 0, henuz NFT ve Batarya yok, ama ucret bolusumu var). *Kabul:* burn tx, Iris mesaji, claim tx; aliciya varan USDC = `amount − feeExecuted − relay_fee − battery_amount` (× 10).

**F3 — Pasaport ve sorgu arayuzu.** Soulbound NFT, `MigrationSummary`, sorgu fonksiyonlari, TTL/`bump`, sade `token_uri`. *Kabul:* zincirden okunan NFT ve ozet, transfer denemesi basarisiz, TTL testi.

**F4 — BurnRouter.** Once tek token, sonra coklu, gas payi korumasi, `mod` alani. *Kabul:* router bakiyesi islem sonrasi 0, toz ve fee-on-transfer davranislari test edilmis.

**F5 — `gate_battery`.** `deposit`, `withdraw`, `forward`, ozellik testleri. *Kabul:* zincirde bir `forward` islemi: kullanicinin XLM'i yokken hedef islem calisir, ucret bataryadan relayer'a gider.

**F6 — `gate_ticket` (Bilet).** `mint_ticket`, `transfer`, `redeem`, `redeem_to_battery`, `value_of`, (opsiyonel) `split`, `init_minter`. `GateClaim`'e mod 1 dali. *Kabul (hepsi zincirde kanitli):*
- Mod 1 ile burn → claim: USDC kasaya, bilet aliciya gider, alicinin cuzdan USDC bakiyesi artmaz.
- Bileti A'dan B'ye devret: kasadaki USDC bakiyesi **degismez**, sahiplik degisir.
- B `redeem` eder: bilet yanar, B'ye tam miktar gelir. A ayni bileti cekemez.
- `redeem_to_battery`: XLM'siz hesapta Batarya bakiyesi artar.
- Degismez ozellik testi: `Σ amount(biletler) == USDC.balance(gate_ticket)`.
- Pasaport kredisi mod ve devirden bagimsiz ilk alicida kalir.

**F7 — Otomatik strateji ve web.** 5.5'teki karar akisi, Burn Ekrani, Tasima Kanitim, Batarya ve Biletlerim sayfalari. *Kabul:* (a) XLM var → normal yol, (b) XLM sifir → Batarya yolu, mod secmeden, (c) XLM'siz hesaptan Bilet devri Batarya ile calisiyor. Ekran kaydi veya tx zinciri.

**F8 — Tuketici demosu.** `gate_campaign_example`. *Kabul:* rozet sahibi kademe alir, rozetsiz alamaz.

**F9 — Gorsel katman (opsiyonel).** Yildizlar, ad. S7 sonucuna gore. Yetismezse atla, README'de belirt.

**F10 — Negatif testler ve kilit.** Bolum 8 listesi gecer, adminsizlik dogrulanir.

**F11 — Self-audit ve dokumantasyon.** `gate2/scripts/self-audit.js`: gecerli claim kabul, ayni mesaj reddi, bozulmus attestation reddi, yanlis `mintRecipient` reddi, yanlis gonderici reddi, Batarya ve Bilet degismezleri, admin yok. Sonuc `deployments/self-audit-2.0.json`. `docs/GATE2_TRUST_MODEL.md` ve README yazilir. *Kabul:* 1.0 testleri hala 12 / 11 / 3.

## 8. Negatif test listesi

**Cekirdek**
- Ayni mesajin ikinci claim'i reddedilir.
- Bir bayti bozulmus attestation reddedilir.
- `destinationCaller` baska olan mesaj `GateClaim` tarafindan islenemez.
- Gondericisi `BurnRouter` olmayan mesaj (dogrudan CCTP burn) reddedilir.
- Bozuk alici hook'u kaynak tarafta reddedilir.
- Router'a disaridan bagis yapilan token yakma miktarini etkilemez.
- Slipaji `minOut` altina dusen swap tumuyle geri alinir.
- Pasaport transfer denemesi basarisiz olur.

**Ucret ve Batarya**
- `relay_fee > relay_fee_cap` veya `> MAX_RELAY_FEE` reddedilir.
- `relay_fee + battery_amount >` net miktar hem kaynakta hem claim'de reddedilir.
- `forward`: `fee > max_fee`, suresi gecmis, tekrar kullanilan nonce, sahibin imzasi olmayan cagri reddedilir.
- Dusman relayer: `withdraw`'i engelleyemez, bakiyeyi tavanin ustunde azaltamaz.
- Ozellik testi: `Σ balance_of == USDC.balance(gate_battery)` rastgele islem dizilerinde gecerli.
- Cuzdan USDC'si sifirlansa da Batarya bakiyesi degismez. Batarya bosken `forward` net hata verir.

**Bilet**
- `mint_ticket`'i `GateClaim` disinda cagiran reddedilir. `init_minter` ikinci kez cagrilamaz.
- Sahibi olmayan `redeem` ve `redeem_to_battery` reddedilir. Devirden sonra eski sahip cekemez.
- Ayni bilet iki kez cekilemez (cift harcama).
- Trustline'i olmayan `to` icin `redeem` revert eder ve bilet yanmadan kalir.
- `split`: `Σ amounts != amount` reddedilir, gecerli split toplami korur.
- Kasadan USDC yalnizca `redeem` ve `redeem_to_battery` yoluyla cikar (cikis yollari taranir).
- `approve` ve `approve_for_all` (D8 uygulandiysa) trap eder.
- Ozellik testi: `Σ amount(biletler) == USDC.balance(gate_ticket)` rastgele mint, devir, cekim, bol dizilerinde gecerli.
- Devir Pasaport kredisini tasimaz: bileti alan adresin `get_migration` toplami artmaz.

**Gorsel (F9 yapilirsa)**
- Karakter kumesi disinda ad (`<`, `>`, `"`, `&`) router'da ve `GateClaim`'de reddedilir, SVG ciktisi kacislanmis.

## 9. Kanit manifesti ve faz raporu

`deployments/testnet-2.0.json`:

```
spikes[]            soru, sonuc, tarih, kanit tx
contracts           BurnRouter (EVM), GateClaim, gate_battery, gate_ticket, gate_campaign_example, USDC, CCTP adresleri
relayers[]          kullanilan relayer, "demo bagimliligi" etiketi
receipts[]          burn tx, Iris mesaj hash'i, attestation, claim tx, forward tx'leri, bilet mint/devir/cekim tx'leri, NFT id'leri, bakiyeler
negative_probes[]   test adi, beklenen hata, gercek sonuc
findings[]          bulunan her hata (silinmez)
superseded[]        terk edilen deploy'lar ve nedenleri
```

**Faz raporu (her faz sonunda):**

```
FAZ: F<n>  DURUM: gecti | engellendi
YAPILAN:    kisa madde listesi
KANIT:      manifestteki anahtarlar / tx hash'leri
REGRESYON:  1.0 testleri 12/11/3 → gecti mi
BULGU:      yeni findings[] girdileri
SONRAKI:    bir sonraki adim ve insan karari gerekiyorsa sorusu
```

## 10. Durma kosullari (dur ve insana rapor ver)

- S1'de hem G hem F calismiyorsa.
- S8 veya S9'da Batarya'nin atomik ucret modeli kurulamiyorsa. (Sonuc: Batarya'yi yalnizca "ilk claim ucreti" ile sinirla ve raporla, kendin sadelestirme.)
- **Batarya veya Bilet degismezi** (`Σ hak == USDC bakiyesi`) herhangi bir testte bozulursa.
- Bilet kasasindan `redeem` disinda bir USDC cikis yolu bulursan.
- S11 sonucu Bilet devrini alicinin hesabi olmadan imkansiz kiliyorsa: ozelligi "alici hesabi gerekir" sartiyla raporla, README'deki vaadi buna gore daralt.
- Circle docs ile gercek testnet davranisi celisiyorsa.
- 1.0 testlerinden biri duserse.
- Bir gizli anahtar veya fon riski gorursen.
- Kanit uretemedigin bir iddiayi yazmak zorunda kaliyorsan.
- Bu belgede olmayan bir mimari degisiklik gerekiyorsa.

## 11. README dil kurallari

- "Yakildi" yalnizca CCTP burn tx'i kanitliysa. "Yok edildi" denmez: ayni miktar Stellar'da yeniden basilir.
- "1:1" yalnizca swap sonrasi USDC icin. Swap ucreti, slipaj, CCTP ucreti, relay ucreti ve Batarya payi duser.
- "Kimseye guvenme" yerine: "Guven modeli Circle'in CCTP attestation'idir."
- "Otomatik" ve "XLM'siz" yalnizca F7 kanitlaninca yazilir ve su aciklamayla: "Ag ucretini relayer XLM ile oder, karsiligi kullanicinin Bataryasindan USDC ile alinir."
- Batarya icin: "Tonkeeper Battery'den ilham alinmistir. TON'da off-chain, Gate'te zincir ustu ve kullaniciya aittir."
- Bilet icin: "Bilet, kasadaki native USDC uzerinde 1:1 bir hak makbuzudur. Kopru varligi degildir, destegi zincirde herkesce dogrulanabilir. Hamiline yazilidir: yanlis adrese gonderilen veya calinan bilet geri alinamaz. Circle kasa adresini dondurursa tum biletler etkilenir."
- Pasaport ve Bilet farki acikca yazilir: kanit satilamaz, hak devredilebilir.
- Relayer bagimliligi, sybil siniri ve fon-takilma riski (CCTP mesajlari geri alinamaz) acikca yazilir.

## 12. Bitti tanimi

F0–F8 ve F10–F11 kabul kriterleri kanitli (F9 opsiyonel), negatif testler gecmis, self-audit en az bir tur yesil, 1.0 testleri degismemis, README'deki her iddianin manifestte karsiligi var.

## Kaynaklar

- Stellar docs, CCTP: https://developers.stellar.org/docs/tokens/cross-chain-transfers
- Circle, CCTP on Stellar: https://developers.circle.com/cctp/references/stellar
- Circle, CCTP Stellar kontratlari ve arayuzleri: https://developers.circle.com/cctp/references/stellar-contracts
- OpenZeppelin, Fee Abstraction (Stellar): https://docs.openzeppelin.com/stellar-contracts/fee-abstraction
- OpenZeppelin Relayer, Stellar sponsorlu islemler: https://docs.openzeppelin.com/relayer/1.5.x/guides/stellar-sponsored-transactions-guide
- OpenZeppelin, Non-Fungible (Stellar): https://docs.openzeppelin.com/stellar-contracts/tokens/non-fungible/non-fungible
- Tonkeeper, Battery ve Gasless: https://tonkeeper.com/en/article/how-tonkeeper-brings-gasless
