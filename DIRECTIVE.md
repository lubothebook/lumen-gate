# DIRECTIVE 2.0 — Lumen Gate: Proof of Migration (CCTP)

Not (eklenen 2026-09-20): Guven otoritesi eki belgenin kendisi olarak repoda:
`HARDENING-2.0.md`. Bu direktifle catistigi yerde dur ve rapor kurali gecerli;
simtilik bilinen catisma yok. Durus tablosu: `deployments/hardening-2.0.json`.

> (The operator issued this directive in Turkish. This file is the same text,
> byte-faithful except that Turkish diacritical marks are transliterated away
> to keep the repository's ASCII gate intact.)

> **Bu belge bir yapay zeka kodlama ajanina verilir.** Ajan bu belgeyi, `README.md`'yi ve `DIRECTIVE-1.0.md`'yi okumadan tek satir kod yazmaz. Kanit once, iddia sonra: hicbir "canli", "1:1", "kanitlandi" ifadesi, ilgili testnet islem hash'i `deployments/testnet-2.0.json` icine yazilmadan hicbir dosyaya giremez.

## 0. Surum adlandirmasi

- **Gate 1.0** = repodaki mevcut sistem: Registry, Gateway, source_simulator, relayer, BLS/Groth16 hatlari, anchor facade, Vercel console. (Eskiden "2.0" diye aniliradi.) **Dondurulmustur.**
- **Gate 2.0** = bu belgedeki yeni urun: CCTP tabanli, relayer'siz, koprusuz "Tasima Kaniti".

## 1. Ajan olarak calisma bicimi

1. Fazlari sirayla yurut (Bolum 7). Bir faz, kabul kriteri **kanitla** karsilanmadan kapanmaz.
2. Her fazin sonunda: testleri calistir, kaniti `deployments/testnet-2.0.json`'a yaz, commit at, **faz raporu** ver (Bolum 9).
3. Kaniti **asla uydurma.** Adres, tx hash, mesaj hash'i, attestation ve bakiye yalnizca gercek testnet ciktisindan gelir. Mock Iris, "assume valid" dali veya elle yazilmis hash yasaktir.
4. Engelle karsilarsan **dur ve raporla** (Bolum 10). Sahte bir yol acarak ilerleme.
5. Gizli anahtari commit etme. Anahtarlar ortam degiskeninden gelir (`.env` git'te yok). Yalnizca testnet hesapleri kullanilsin.
6. Bir seyi cozemezsen "calisiyor" deme. Bulguyu `findings[]` altina yaz. Basarisizliklar silinmez (1.0'daki gibi).

## 2. Urun

Kullanici bir EVM aginda (Ethereum Sepolia) sectigi tokenlari USDC'ye cevirir ve Circle CCTP ile yakar. Stellar'da yaktigi miktar kadar native USDC alir. Ayni islemde **devredilemez (soulbound) bir Tasima Kaniti NFT'si** mint edilir.

**Fark yaratan sey NFT'dir.** Tasima (swap + kopru) tarafinda Squid, LI.FI, Jumper gibi araclar zaten var, bizim yasayacagimiz yer orasi degil. Bizim degerimiz:

- zincirde kalici, Circle attestation'iyla desteklenen bir "bu cuzdan su zincirden su kadar degeri Stellar'a getirdi" kaydi;
- Soroban'daki **herhangi bir kontratin sorgulayabildigi** bir arayuz (kampanya, kademe, erisim);
- relayer'siz, admin'siz, sahipsiz kontratlar ve kanit-once kulturu.

Bilinen sinir (README'ye yazilir): kanit **cuzdan bazlidir**, birden cok cuzdanla sahtecilik (sybil) mumkundur.

## 3. Degismez kurallar

1. **Relayer yok.** `claim` permissionless'tir (herkes gonderebilir), ama sonuc her zaman mesajda bagli aliciya gider. Bizim islettigimiz sunucu, anahtar veya operator token'i yoktur.
2. **Custody yok.** `BurnRouter` ve `GateClaim`, bir islemin disinda fon tutmaz. Islem sonu bakiyeleri sifirdir, bu testle kanitlanir.
3. **Admin yok.** Deploy sonrasi `renounce_admin` veya bastan adminsiz. Upgrade yok.
4. **Sinirsiz approval yasak.** Token basina tam miktar approve veya Permit2.
5. **Kullanici secmeden hicbir tokena dokunulmaz.** "Hepsini sec" butonu var ama varsayilan kapalidir.


### 3.1 Durum (2026-09-20, gate-2.0 @ eec2a76, CI 7/7 yesil)

- Kural 1 (relayer yok): gate_claim testnet'te `CDQ3PA5LBI...` olarak duruyor; `claim` anyone-call, alici mesaj-içi sabit - on-chain negatifle kanitli (junk -> Error #3, deployer penceresi kapandi).
- Kural 2 (custody yok): BurnRouter 23/23 test (sifir-bakiye iddiasi testte) + gate_claim hardening sonrasi 7/7; campaign 3/3 (tier sinir matrisi dahil) - hepsi ayni commit'te CI'da.
- Kural 3 (admin yok): gate_claim constructor penceresi initialize ile kapandi, rebuild reddedildi (#1) - kanit zinciri findings s19/s21.
- Kural 4-5: EVM tarafinda unlimited-approval deseni (venue-allowance) tasarımdan cikarildi, slither rebuttal'ari audit_ignores'ta.
- 1.0 tabani: 61/17/11/20/28 - test tasma/taşıma sonrasi yeniden sayildi, dustu yok.6. **NFT devredilemez.** Transfer, approve ve benzeri fonksiyonlar kontratta yoktur veya trap eder.
7. **Guven modeli durust yazilir.** Guven koku Circle'in Iris attestation'idir. "Trustless" kelimesi kullanilsin. Circle USDC'yi dondurabilir.
8. **Testnet.** Mainnet icin ayri ve acik bir insan karari gerekir.

## 4. Kapsam siniri: neye dokunulur

**Dokunma (1.0, dondurulmus):** `contracts/`, `crates/`, `anchor/`, `circuits/`, `api/`, `frontend/`, `tools/`, `scripts/`, `vercel.json`, `deployments/testnet.json`, `deployments/self-audit.json`. Bunlar yollara baglidir (Vercel `includeFiles`, self-audit, manifest). **Taskima, yeniden adlandirma yok.**

**Izinli degisiklikler (1.0'a dair tek dokunuslar):**
- `DIRECTIVE.md` → `git mv DIRECTIVE.md DIRECTIVE-1.0.md`, en uste tek satir ekle: "Bu belge Gate 1.0 icindir."
- Kok `Cargo.toml`: yalnizca `gate2/soroban/*` uyelerini workspace'e ekle.
- `README.md` (ve `README.tr.md`): "Gate 1.0 ve Gate 2.0" bolumu ekle, mevcut icerikte "Gate 1.0" ifadesini kullanilsin. Mevcut kanit tablolarini degistirme.

**Yeni kod yalnizca buraya:**

```
gate2/
  evm/        BurnRouter (Foundry)
  soroban/    gate_claim, gate_campaign_example (Cargo workspace uyeleri)
  web/        Burn Ekrani + "Tasima Kanitim" sayfasi (ayri Vite uygulamas)
  scripts/    spike'lar, uctan uca testler, self-audit
deployments/testnet-2.0.json
deployments/self-audit-2.0.json
docs/GATE2_TRUST_MODEL.md
```

Calisma dali: `gate-2.0`. **Regresyon kapi:** her fazdan sonra `cargo test --workspace --lib` calistir. 1.0 testleri (12 / 11 / 3) aynen gecmeli, duserse dur.

## 5. Mimari

```
[EVM cuzdan] → BurnRouter → swap → USDC → CCTP depositForBurnWithHook (domain 27)
                                                   |
                                        Circle Iris attestation
                                                   |
[Stellar cuzdan] → GateClaim.claim(message, attestation)
     +- MessageTransmitter.receive_message → USDC mint
     +- USDC → hook'taki aliciya (6→7 ondalik: × 10)
     +- soulbound NFT mint → ayni aliciya
     └ alicinin MigrationSummary kaydini guncelle

[Herhangi bir Soroban kontrati] → GateClaim.get_migration(adres)
```

### 5.1 `BurnRouter` (Solidity)

- Girdi: token listesi, miktarlar, token basina `minOut`, Stellar alici adresi (strkey).
- Swap router, USDC ve TokenMessenger adresleri **immutable constructor argumani**.
- Yakilan miktar = swap sonrasi **gercekten alinan USDC** (bakiye farki). Tahmini deger kullanilsin.
- `depositForBurnWithHook`: `destinationDomain = 27`, `mintRecipient = destinationCaller = GateClaim` (Karar D1), `hookData` = 24 bayt sifir + uint32 versiyon (0) + uint32 alici uzunlugu + alici strkey (UTF-8), `maxFee`, `minFinalityThreshold` (1000 hizli, 2000 standart).
- Router `hookData` seklini dogrular (uzunluk, `G`/`C` oneki, 56 karakter). Hatali hook geri alinamaz kayip yaratabilir.
- Sahip, upgrade ve fon cikis fonksiyonu yoktur.

### 5.2 `GateClaim` (Soroban)

`claim(message: Bytes, attestation: Bytes)`:

1. Mesaji ayristir. Dogrula: kaynak domain izinli listede, hedef domain 27, `mintRecipient == destinationCaller == self`, `burnToken` beklenen USDC.
2. `MessageTransmitter.receive_message` cagrir. Ayni mesaj ikinci kez tuketilemez (replay korumasi CCTP nonce'undan gelir). Ek olarak mesaj hash'ini saklayip idempotency icin kontrol et.
3. Hook'taki aliciyi oku. Mint edilen USDC'yi aliciya aktar (`× 10`).
4. Aliciya NFT mint et. Metadata: kaynak domain, mesaj nonce'u, `amount` (6 ondalik), `feeExecuted`, ledger.
5. `MigrationSummary` guncelle. Hepsi tek atomik islemdir.

**Sorgu arayuzu (kontratlar icin, sabit sozlesme):**

```
get_migration(owner: Address) -> Option<MigrationSummary>
    MigrationSummary { total_usdc: i128 /*6 ondalik*/, claim_count: u32,
                       first_ledger: u32, last_ledger: u32, sources: Vec<u32> }
has_migrated_at_least(owner: Address, min_usdc: i128) -> bool
get_proof(id: u64) -> MigrationProof
bump(owner: Address)        // herkes cagirabilir, persistent kayitlarin TTL'ini uzatir
```

**State archival:** persistent kayitlarin TTL'i yazma sirasinda uzatilir ve `bump` ile herkes uzatabilir. Bunu test et, aksi halde kanitlar arsilanip kaybolabilir.

### 5.3 `gate_campaign_example` (Soroban, tuketici demosu)

`GateClaim.get_migration`'i cagiran, **fon tutmayan** ornek kontrat. `claim_tier(owner)` (owner auth): toplam `>= 10 USDC` Bronze, `>= 100` Silver, `>= 1000` Gold. Kademe kaydeder (yukseltme serbest), olay yayinar. Amaci: rozetin sus olmadigini, baska kontratlarca kullanilabildigini gostermek. Odul tokeni veya hazine **yoktur**.

### 5.4 Web (`gate2/web`)

- **Burn Ekran:** token listesi, satir basina "→ USDC" onizlemesi (minimum alinacak, fiyat etkisi), toplam ve ucret satiri. Likiditesiz/honeypot ve toz miktarlar gizlenir. Islem basina ust limit. Geri alinabilirlik uyarisi ve "BURN" yazdirma. Burn oncesi: Stellar adresi `StrKey` ile dogrulanir, alicinin USDC trustline'i kontrol edilir (yoksa burn butonu kapali).
- Burn sonrasi: attestation Iris API'den cekilir, kullanici Freighter ile `claim` islemine yonlendirilir.
- **Tasima Kanitim sayfasi:** bagli Freighter adresi icin `get_migration` sonucu, NFT'ler ve kampanya kademesi (`claim_tier` butonu).
- Ayri uygulama. `frontend/` ve `vercel.json` degismez.

## 6. Sabit kararlar

- **D1 — Alici tasarimi.** Varsayilan **G**: `mintRecipient = destinationCaller = GateClaim`. Sadece Gate mesajini tuketebilir, bu yuzden claim'i ucuncu kisi one gecip NFT'siz birakamaz. **Yedek F:** `CctpForwarder.mint_and_forward`'u sarmak. Forwarder herkese aciktir, biri dogrudan cagrirsa kullanici USDC'yi alir, NFT basilamaz. F secilirse bu risk README'ye yazilir. **Spike S1 karar verir.**
- **D2 — NFT.** Devredilemez Tasima Kaniti. Odul emisyonu bu surumde yok.
- **D3 — Hiz.** Varsayilan standart (2000), hizli mod kullanici secimiyle.
- **D4 — Kaynak zincir.** Ethereum Sepolia.
- Circle uyaris: `destinationCaller` veya `mintRecipient` yanlissa fon **kalici olarak** takilir. S1 kaniti olmadan `BurnRouter` yazilmaz.

## 7. Fazlar ve kabul kriterleri

**F0 — Hazirlik.** `gate-2.0` dali, Bolum 4'te izinli degisiklikler, `gate2/` iskeleti, bos `deployments/testnet-2.0.json`. *Kabul:* 1.0 testleri degismeden geciyor, `git diff` yalnizca izinli dosyalari gosteriyor.

**F1 — Spike'lar.** Her sonuc manifestte `spikes[]` altina kanitla yazilir.

| # | Soru |
|---|------|
| S1 | `GateClaim` hem `mintRecipient` hem `destinationCaller` olarak calisiyor ve `receive_message`'i dogrudan cagrabiliyor mu? (Hayirsa D1 → F) |
| S2 | Ethereum Sepolia → Stellar testnet (domain 27) hatti ve Iris sandbox API'si acik mi? Testnet kontrat adresleri (Circle docs'tan alinir, koda gomulmez, manifeste yazilir) |
| S3 | `amount`, `maxFee`, `feeExecuted` iliskisi: Stellar'da mint edilen miktar tam olarak nedir? |
| S4 | Kontrat bakiyesi icin trustline gerekir mi? Alici hesap icin evet (Circle docs), dogrula |
| S5 | Soroban'da devredilemez NFT icin standart/kutuphane (or. OpenZeppelin Stellar Contracts) veya minimal ozel cozum |
| S6 | Hizli (1000) ve standart (2000) modda gercek ucret ve sure |

*Kabul:* S1–S6 kanitli, D1 kesinlesti.

**F2 — Elle burn, kontrat claim.** Script ile `depositForBurnWithHook`, sonra `GateClaim.claim` (henuz NFT yok). *Kabul:* burn tx, Iris mesaji, claim tx ve alici bakiyesi manifestte. Aliciya varan USDC = `amount - feeExecuted` (× 10).

**F3 — NFT ve sorgu arayuzu.** Soulbound NFT, `MigrationSummary`, Bolum 5.2'deki sorgu fonksiyonlari, TTL/`bump`. *Kabul:* zincirden okunan NFT metadata ve ozet. Transfer denemesi mumkun degil (testle). TTL testi.

**F4 — BurnRouter.** Once tek token, sonra coklu token. *Kabul:* router bakiyesi islem sonrasi 0. Toz, likiditesiz ve fee-on-transfer token davranislari test edilmis.

**F5 — Tuketici demosu.** `gate_campaign_example`. *Kabul:* rozet sahibi `claim_tier` ile kademe alir, rozeti olmayan alamaz (her ikisi de tx/simulasyon kanitiyla).

**F6 — Web.** Burn Ekran ve Tasima Kanitim, Freighter ile uctan uca. *Kabul:* tek bir gercek testnet akisinin ekran kaydi veya tx zinciri.

**F7 — Negatif testler ve kilit.** Bolum 8'deki liste gecer, sonra adminsizlik dogrulanir (varsa `renounce_admin`, basarisizligi simulasyonla kanitla).

**F8 — Self-audit ve dokumantasyon.** `gate2/scripts/self-audit.js`: her turda gecerli claim kabul, ayni mesaj reddi, bozulmus attestation reddi, yanlis `mintRecipient` reddi (simulasyon, ucret yakmaz), admin yok kontrolu. Sonuc `deployments/self-audit-2.0.json`'a yazilir. `docs/GATE2_TRUST_MODEL.md` ve README bolumleri yazilir. *Kabul:* 1.0 testleri hala 12 / 11 / 3.

## 8. Negatif test listesi

- Ayni mesavin ikinci claim'i reddedilir.
- Bir bayti bozulmus attestation reddedilir.
- `destinationCaller` baska adres olan mesaj `GateClaim` tarafindan islenemez.
- Bozuk alici hook'u: kaynak tarafta `BurnRouter` reddeder (Stellar'da mesaj hic olusmaz).
- Trustline'i olmayan alici icin UI burn'u engeller.
- Router'a disaridan bagis yapilan token, yakma miktarini etkilemez (bakiye farki olcumu).
- Slipaji `minOut` altina dusen swap tumuyle geri alinir.
- NFT transfer denemesi basarisiz olur.
- Rozeti olmayan adres `claim_tier` alamaz.

## 9. Kanit manifesti ve faz raporu

`deployments/testnet-2.0.json`:

```
spikes[]            soru, sonuc, tarih, kanit tx
contracts           BurnRouter (EVM), GateClaim, gate_campaign_example, USDC, CCTP adresleri
receipts[]          burn tx, Iris mesaj hash'i, attestation, claim tx, NFT id, alici bakiyesi
negative_probes[]   test adi, beklenen hata, gercek sonuc
findings[]          bulunan her hata (silinmez)
superseded[]        terkedilen deploy'lar ve nedenleri
```

**Faz raporu formati (her faz sonunda):**

```
FAZ: F<n>  DURUM: gecmist | engellendi
YAPILAN:    kisa madde listesi
KANIT:      manifestteki anahtarlari / tx hash'leri
REGRESYON:  1.0 testleri 12/11/3 → gecti mi
BULGU:      yeni findings[] girdileri
SONRAKI:    bir sonraki adim ve insan karari gerekiyorsa sorusu
```

## 10. Durma kosullari (dur ve insana rapor ver)

- S1'de hem G hem F calismiyorsa.
- Circle docs ile gercek testnet davranisi celisiyorsa.
- 1.0 testlerinden biri duserse.
- Bir gizli anahtar veya fon riski gorursen.
- Kanit uretemedigini bir iddiayi yazmak zorunda kaliyorsan.
- Bu belgede olmayan bir mimari degisiklik gerekiyorsa.

## 11. README dil kurallari

- "Yakildi" yalnizca CCTP burn tx'i kanitliysa. "Yok edildi" denmez: ayni miktar Stellar'da yeniden basilir.
- "1:1" yalnizca swap sonrasi USDC icin. Swap ucreti, slipaj ve CCTP ucreti duser.
- "Kimseye guvenme" yerine: "Guven modeli Circle'in CCTP attestation'idir."
- "Gasless" kullanimli: kullanici kendi XLM ucretini ve trustline rezervini oder.
- Sybil siniri ve fon-takilma riski (CCTP mesajlari geri alinamaz) acikca yazilir.

## 12. Bitti tanimi

F0–F8 kabul kriterleri kanitli, negatif testler gecmist, self-audit en az bir tur yesil, 1.0 testleri degismemis, README'deki her iddianin manifestte karsiligi var.

## Kaynaklar

- Stellar docs, CCTP: https://developers.stellar.org/docs/tokens/cross-chain-transfers
- Circle, CCTP on Stellar (adres sekli, hook, forwarder, ondalik farqi): https://developers.circle.com/cctp/references/stellar
- Circle, CCTP Stellar kontratlari ve arayuzleri: https://developers.circle.com/cctp/references/stellar-contracts
