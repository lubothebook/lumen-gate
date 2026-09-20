# LUMEN GATE — DIRECTIVE 2.0

(Lisan notu: bu belge operatorun Turkce direktifidir; repo-nun icerik kapisi Turkce
noktali harfleri tarayip reddettigi icin belge bastan ASCII transliterasyonla yazildi;
kelimeler eksiksiz korundu, sadece noktalar dustu. Kod, test adlari ve
tanimlayicilar Ingilizce kalir; kod yorumlari ve hata mesajlari Turkce olabilir.
Kullaniciya Ingilizce rapor yazma.)

## 0) YETKI VE SIRALAMA

- Gecen turde `git mv DIRECTIVE.md DIRECTIVE-1.0.md` yapilmisti; 1.0 belgesi gecmise
  gitti. Bu dosya artik tek baglayici direktiftir.
- Ilk is: 1.0 belgesinin basina su satiri ekle ve dal ac:
  `Bu belge Gate 1.0 icindir; kapsam disi taleplerde 1.0 maddelerini yeni hedefe uydurmayiniz.`
  `git checkout -b gate-2.0` → bu belgeyi `DIRECTIVE.md` olarak yaz → **F0**'i yap → commit → push.
- Onceki direktifin gecmisteki birkac commitini buluyorsun. Bir madde hangi belgeye
  aitse o uygulanir. "Onceki yapilmis seyler" yeni hedefe uydurulmaz.
- Kod, test, dokuman, commit ve PR aciklamalari dahil her sey Turkce olmali;
  kullaniciya Ingilizce rapor yazma.

## 1) PROJE VE URUN

Lumen Gate: iki domain arasinda deger tasuyan kanit motoru.
- **Soroban = sabit varis adi (claim) domaini.** Kullanici asil degeri burada kendi
  cuzdanindan tutar; kilitli/teminata alinmis bakiyeyi diledigi an kendisi geri alir.
- **EVM = kampanya (campaign) domaini.** Suresi dolmus, degeri olmayan, sadece sembolik
  "kampanya jetonu" burada yasasin — ana para burada saklanmaz.

Kullanici akisi (dort adim):
1. **Lock:** kullanicinin kendi EVM cuzdanindan, kendi EVM sozlesmesine.
2. **Kaniti yolla:** kullanici kendi kanitini kendisi yollar (relay'i kendisi yapar),
   ya da isterse gasless modda relay'i sistem yollar.
3. **Finalize + claim:** Soroban'da claim olusur; 100 gun sona erme (TTL), sonra iade.
4. **Talep / geri alma:** kampanya jetonunu EVM'de yak → Soroban'daki kilit acilir.
   Kullanici isterse **asla kampanyaya girmeden** adim 1'deki kilidi dogrudan geri alabilir.

Kullaniciya sadece su uc sayi soylenir: **miktar**, **sona erme tarihi** ve **is
kimligi (hash)**. Ceremony, sabit demo anahtarlari, VDV, k-tipli satirlar ve benzerleri
kullaniciya gorunmez — araclarin icinde kalir.

## 2) KAPSAM DISI (YENI HEDEFE UYDURULMAZ)

Asagidakiler 1.0 gecmisidir. Kod olarak calisir durumda kalabilir; urun sozleminden
cikarilmistir. Yeni is icin gerekce olarak "1.0'da boyleydi" denilemez:

- Kullanicinin tarayicida kendi VDV'sini urettigi seremoni (audience ceremony)
- Sabit demo anahtarlarinin ve policy slot'larinin kullaniciya aciklanmasi; k-api
  (k-esigi) hakkinda kullaniciya yonlendirme
- Gasless'in "kural olarak garanti edildigi" iddiasi
- ZK/VM katmanlarinin kullaniciya tanitilmasi
- "Bircok dogrulayici" / guven-esigi pazarlamasi
- Onceki `finality_registry` ve `settlement_gateway` sozlesmelerinin 2.0'da da aynen
  korunmasi gerektigi varsayimi

## 3) KOD HEDEFI

- **Sadece EVM tarafi:** 1.0'daki `finality_registry` icindeki finalized-event dogrulama
  mantigini `gate2/evm/` altinda ayni semanticayla karsiliga gecir (byte-for-byte
  kopya + yeni test; "yeniden yazma" yok).
- **Sadece Soroban tarafi:** `crates/settlement_gateway` icindeki lock + finalize +
  geri-alma akisini `gate2/soroban/gate_claim/` altina, ayni kontrollerle, **sadece**
  `u128` miktar ve `u32` sona-erme (TTL) kullanacak sekilde tasi. Onceki `u64`/`i128`
  kullanimi buradan kaldirilir.
- **Kampanya ornegi:** `crates/settlement_gateway` icindeki burn_and_relay / gasless
  / campaign-joinli cikis yolunu `gate2/soroban/gate_campaign_example/` altina tasi.
  Ana claim'dan ayri sozlesme, ayri depolama (storage) prefix'i.
- Onceki `crates/settlement_gateway` ve `crates/finality_registry` 1.0 kaniti olarak
  yerinde kalir; **2.0'in kaynak agaci `gate2/` altidir.**

## 4) F0 — ILK YAPI KOMITU (BOS ISKELET, DERLENIR)

Degisecek dosyalar:
- `git mv DIRECTIVE.md DIRECTIVE-1.0.md` + basliga tek satirlik uyari ekle (bkz. 0).
- `gate2/{evm,soroban,web,scripts}` bos manifest iskeleti.
- Kok `Cargo.toml`'a `gate2/soroban/gate_claim` ve `gate2/soroban/gate_campaign_example`
  eklenir (skeleton crate'ler derlenir durumda).
- `deployments/testnet-2.0.json` olusturulur; `spikes`, `receipts`, `negative_probes`,
  `findings`, `superseded` alanlari bos dizi olarak yazilir — buraya dolacak alanlari
  elle uydirma.
- Kokta baska dosya degisikligi yok. **Kabul:** 1.0'da gecen testler aynen gecmeli
  (12 host test + 11 prop-test + 3 EVM); git diff sadece izinli dosyalari gosterir.
- **1.0'un hicbir dosyasini "duzenlemeye" baslama** (README, anchor, frontend, circuits,
  scripts dahil) — o dosyalar F0-F11'de el surutulmez.

## 5) F1..F11 — KANIT ZORUNLULUKLARI

Her faz ayri commit. Her fazda: kod + test + dokumanda kayit + (canli faz ise) kanit.

| Faz | Yapilacak | Kabul olcutu (olculebilir) |
|---|---|---|
| **F1** | EVM tarafina tasi | `forge test` yesil; dogruladigi 4 sembolik anahtar + 3 imza girdisi + 100 gunluk sure acikca okunur; 1.0 ile ayni `bytes32` domain tag'i hesaplanir. |
| **F2** | Ceremony otomasyonu | `gate2/scripts/` icinde; 3 kisilik testnet ceremony'si iki ayrilmista calisir, `phase2_final.zkey` **indirilir** (uretilmez, saklanmaz), `--verify-only` ile dogrulanir; imza edilen `public_signals` ve sha256 hash'i rapora gecilir; ceremony katilimcisi olan sahtesi reddedilir. |
| **F3** | Devreye alma | `gate2/scripts/deploy-testnet.sh` tek komut: deploy + verify + manifest yazimi (`deployments/testnet-2.0.json`). Iki `address(0)` ile baslayan "bozuk" deploy **reddedilir**. |
| **F4** | Sabit anahtar/sozlesme sabitleme | Sozlesme adresi + verifier konfigi + domain tag'i raporda; adresler manifest'ten okunur, kaynaga gomulu degil. |
| **F5** | Claim motoru | u128 miktar, u32 TTL; `finalize` + `claim` + `reclaim (TTL sonrasi)`; **100. gunden bir gun once para geri alinabilir**, 100. gun ve sonrasi claim kapanir; TTL sona erme kontrolu tek yerde. |
| **F6** | Kampanya ornegi | Burn → finalize → release; kampanyaya girmeden release calisir (kullanicinin "kampanyaya katilmadim" yolu ana yoldur). |
| **F7** | Gasless modu | Iki yol test edilir: (a) kullanici relay'i kendisi yollar; (b) sistem yollar. (b) icin sistem butcesi ayri fonksiyon + max-gas tavan parametresi; butce tukendiginde (a) **bozulmadan** calisir; "garanti" kelimesi yoktur. |
| **F8** | CI | `gate2/scripts/run-all.sh`: cargo + forge + canli faz. Sadece derlenebilir bir adim "gecmis" sayilmaz. |
| **F9** | Kapi kontrolu | `gate2/scripts/repo-gate.sh`: 1.0'daki `scripts/repo-gate.sh` muadili; **F0 ile catisan kurallar 2.0 kapisinda duzeltilir**, 1.0 kapi betigine dokunulmaz. |
| **F10** | Kullanici dokumanlari | Yalnizca 4 adim + 3 sayi + "100 gun sonra ne olur" + "asla kampanyaya katilmadan para iadesi" anlatilir. Ceremony/anahtar/VDV/k-esigi gecmez. |
| **F11** | Geri alinabilirlik | Her fazdan sonra tek `git revert` ile geri alinabilir oldugu kanitla gosterilir (revert commit'i rapora eklenir, sonra geri alinir). |

**Ortak kabul:** kod + 3 negatif test (zimani yanlis imza / TTL siniri / replay)
yesil; olcum yoksa veya 1'e karsilik 1'i basarisizsa **durma durumu** olarak yazilir;
"beklenenden iyi" diye yumusatilamaz.

## 6) CANLI FAZLAR VE OLUM HATLARI

Sadece asagidaki fazlar zincire dokunur; hepsi **testnet**'tir:
- **F3** canli deploy
- **F5** canli claim testi
- **F6** canli kampanya testi
- **F7** canli gasless testi
- **F8** canli CI (testnet'te)

Yukaridakiler icin zorunlu rapor: transaction hash (0x…/hex), blok yuksekligi, gas
kullanimi (sayi), sozlesme adresleri, **olcuilen** limit/tavan degerleri.
**Canli fazlarin sonuclari `deployments/testnet-2.0.json` icine "receipt" olarak
yazilir.** Kaynaga/README'ye canli sonuc yazmak yasaktir; sadece manifest'e yazilir.

**Olcum ve durma satirlari:**
- **Gas tavani / limit:** F7'de `maxGas` icin varsayilan bir sayi sec, **canlida olc**,
  ayni sayiyi manifest'e ve hata mesajina yaz; "yeterince kucuk/uygun" gibi soyleme
  yasak.
- **Butce:** F7 sistem-relay butcesi = **tek seferlik, sabit, sayiyla** tanimlanir
  (or. 0.05 ETH); tukendiginde kullanici kendi relay'ina duser — bu durum test edilmelidir.
- **TTL:** 100 gun (8 640 000 saniye) — sabittir; sozlesmede tek yerde tanimlidir.
- **Kayip/hasar:** "geleneksel" kabul edilen tek durum: **TTL'den sonra kampanyaya
  girmemis kullanici icin para zaten serbesttir** — bunu belgeleyen tek test yeterlidir.
- **Olum cizgisi (duruma dusur):** F5/F6/F7'de canli test zincirde `revert` olursa
  **tamamlanmis sayilmaz** → "durma" yazilir, yumusatma yapilmaz.
- F5/F6/F7 testnet'te kanitlanmadiysa F0+F1+F2+F3+F4+F9+F10+F11 **tek basina
  "tamamlandi" degildir**; raporda bu acikca durur.

## 7) ZAMANLAMAYA KARSILIK SOZLEM

Faz siralamasi degistirilebilir (F1 ↔ F5 gibi); **kabul olcutleri degistirilemez**.
Bir faz " simdilik bos" birakilirsa, "bos" yazilir; "gecmis gibi" yazilmaz.

## 8) URUN KISITLARI (KOD + SOZLEM)

- **Sayi dogrulugunun tek kaynagi:** miktaarin ve TTL'nin tek kaynagi on-chain
  state/proof'tur. **On-face sadece manifest'teki ve on-chain'den okunan degerleri
  gosterir**; kendi hesabini uretemez. Aksi halde **on-face'i bos birak, sadece
  terminal/JSON cikisina yaz.**
- **Miktar kurali:** u128 icinde sabit-komma ile; `10^10` sabiti **tek yerde**
  tanimlidir; baska yerde gomulu `10000000000` yasak. "1 jeton = 10^10" kurali
  kod dokumani ve kullanici dokumaninda ayni seydir.
- **TTL kurali:** 100 gun = 8 640 000 sn; **1.0'daki 100-blok penceresi 2.0'da
  yoktur** — bu degisiklik kabul edilmis kirlilik olarak F0 raporunda gecir.
- **Gasless soylemi:** (a) kullanici kendi yollar → **bedava**; (b) sistem yollar →
  sistem butcesi bittiginde (a)'ya duser. (b) icin "gasless garanti" yok; "(a) bedava,
  (b) butce bitene kadar" yazilir. Butce bitmisken (a)'nin calistigini gosteren test
  F7'nin kabul kosuludur.
- **On-yuz:** `gate2/web/` (F12) uc sayi: miktar, sona erme tarihi, is kimligi.
  Ceremony ve anahtar sozcukleri **olmayacak**; sadece "cuzdanini bagla → kilitle →
  kanitini kendin yolla ya da gasless iste → talebini al" akisi.
- **Isimlendirme:** repo icinde eski bagisici reponun koku ve hicbir turevi gecmez. Urun adi **Lumen Gate**.
  `gate_claim` ve `gate_campaign_example` isimleri sabittir. Ulke/bolge/seyirci
  atfi yoktur.
- **Kanit dili:** commit/aciklama/documan Turkce; kod tanimlayicilari Ingilizce;
  kod yoru ve hata mesaji Turkce olabilir.

## 9) RAPOR FORMATI (HER FAZ SONU)

Tek mesaj: **faz adi** — durum (gecmis | durma | bos) + degisen dosya yollari +
`cargo test --workspace --lib` veya `forge test` **gercek sayilari** + kanit varsa
manifest alintisi. Kanitsiz "yesil" yok. Bir sonraki fazin kodunu yazmaya baslama;
once raporu ver.

## 10) DURMA KURALLARI

- F2'de `phase2_final.zkey` indirilip dogrulanamiyorsa → **dur** (uretim/istisna yok;
  1.0'daki "yerel seremoni" kapisindan farkli olarak 2.0'da muadili yoktur).
- F7'de butce bitisi (a)'ya dusuruyorsa → F7 gecmis sayilmaz.
- F5/F6/F7 zincirde revert → F5..F7 **tamamlanmis sayilmaz** → F8/F9/F10/F11'e
  gecilmez; "durma" yazilir.
- F1'de dogrulama icin 1.0 ile ayni `bytes32` domain tag'i hesaplanmiyorsa → dur.
