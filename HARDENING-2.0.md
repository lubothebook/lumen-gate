# DIRECTIVE 2.0 - EK A: HARDENING DIRECTION

> (The operator issued this annex in Turkish, appended to DIRECTIVE.md on
> 2026-09-20. It is stored byte-faithfully except that Turkish diacritical
> marks are transliterated away, the same convention the 2.0 directive itself
> uses to keep the repository's ASCII gate intact. Terminology note: the text
> refers to the main 2.0 document as DIRECTIVE-2.0.md - in this repository
> that is `DIRECTIVE.md`; all "DIRECTIVE-2.0.md" references below read as it.)

> **Bu belge de, tipki DIRECTIVE-2.0.md gibi, bir yapay zeka kodlama ajanina ve insan gozden geciricisine verilir.** Amaci yeni ozellik eklemek degil, `gate-2.0` dalindaki (ve dolayli olarak dondurulmus Gate 1.0'daki) kodun saldiri yuzeyini kucultmek, varsayimlarini gorunur kilmak ve "calisiyor" ile "kanitlanmis guvenli" arasindaki farki kapatmaktir. Kanit-once kulturu burada da gecerlidir: bir sertlestirme maddesi, ilgili negatif test veya statik analiz raporu `deployments/testnet-2.0.json` ya da yeni `deployments/hardening-2.0.json` dosyasina yazilmadan "tamamlandi" sayilmaz.
>
> Bu belge DIRECTIVE-2.0.md'nin **yerine gecmez**, onu **tamamlar**. Celiski durumunda urun mantigi (ne insa edilecek) icin DIRECTIVE-2.0.md, guvenlik durusu (nasil insa edilecek) icin bu belge esas alinir. Ikisi celisirse Bolum 10'daki "dur ve raporla" kurali isler.

## 0. Neden ayri bir belge

Bir kopru/tasima sistemi iki farkli sekilde basarisiz olur: **urun eksik kalir** (DIRECTIVE-2.0.md'nin konusu) ya da **urun tamamlanir ama bir varsayim yanlis cikar** (bu belgenin konusu). Ikinci tur basarisizlik daha pahalidir cunku genellikle testler yesilken, demo calisirken ve README iddialarla doluyken ortaya cikar. CCTP gibi geri alinamaz, tek yonlu bir mesajlasma katmani uzerine insa edilen bir sistemde ikinci tur basarisizligin bedeli **kalicidir** — Bolum 6'daki Circle uyarisi bunu zaten soyluyor: yanlis `destinationCaller` ya da `mintRecipient`, fonu sonsuza dek kilitler. Bu belge, o cumlenin arkasindaki muhendislik disiplinini sistematik hale getirir.

Gate 1.0'in kendi gecmisi bunun neden gerekli oldugunu zaten gosteriyor: canli self-audit dongusu art arda on gercek kusur bulmus (yanlis relayer hesabi, yanlis tx hash raporlama, resume edememe, yanlis nedenle gecen testler) ve bunlarin hepsi "testler yesil" asamasindan *sonra* ortaya cikmis. Gate 2.0'in bunu tekrar kesfetmesine gerek yok; bu belge o dersleri bastan kurallara cevirir.

## 1. Kapsam ve onkosul

- Bu belge yalnizca `gate2/` altina ve `deployments/testnet-2.0.json`, `deployments/self-audit-2.0.json`, `docs/GATE2_TRUST_MODEL.md` dosyalarina dokunan calismayi kapsar. Gate 1.0 kodu hala dokunulmazdir (DIRECTIVE-2.0.md Bolum 4).
- Bu belgedeki hicbir madde Bolum 3'teki degismez kurallari (relayer yok, custody yok, admin yok, sinirsiz approval yasak, NFT devredilemez, guven modeli durust yazilir, testnet) gevsetmez. Sertlestirme, bu kurallari **zayiflatan** degil **kanitlayan** yonde calisir.
- Bu belge bir denetim (audit) raporunun yerine gecmez. Amaci, dis denetime girmeden once bulunabilecek ucuz hatalari temizlemek ve dis denetimin daha derin, daha az mekanik sorulara odaklanmasini saglamaktir.
- Ajan, her sertlestirme maddesini uygularken once **basarisiz senaryoyu** yazmali (negatif test), sonra duzeltmeli. Once duzeltip sonra test yazmak, "gecen ama yanlis nedenle gecen" test riskini tasir — Gate 1.0'in Bulgu #4'u tam olarak buydu.

## 2. Tehdit modeli

### 2.1 Aktorler

| Aktor | Motivasyon | Erisebildigi yuzey |
|---|---|---|
| Siradan kullanici | Token'ini tasimak, kanit almak | Web UI, cuzdan imzasi |
| Kotu niyetli kullanici / bot | Fon calmak, kanit sahteciligi, sybil | `BurnRouter` fonksiyonlari, `claim` (permissionless), `bump` (herkese acik) |
| MEV arayicisi / front-runner | Swap sirasinda deger cekmek | Mempool'daki bekleyen `burn` islemi |
| Kotu niyetli token kontrati | Yeniden giris (reentrancy), sahte bakiye, fee-on-transfer/rebasing davranisi | `BurnRouter`'in cagirdigi `transferFrom`/`transfer`/swap yolu |
| Circle (guven koku) | — (kotu niyetli degil ama tek hata noktasi) | Iris attestation, dondurma yetkisi, domain/kontrat adresleri |
| Kampanya kontrati gelistiricisi (ucuncu taraf) | `get_migration`'i yanlis/kotu niyetli kullanmak | Sorgu arayuzu (salt-okunur, ama yanlis yorumlanabilir) |
| Ajan/gelistirici (biz) | Yanlislikla yanlis adres/domain deploy etmek | Deploy script'leri, `.env`, manifest |
| Gozlemci/rakip | Itibar zedelemek icin kanitsiz iddialari yakalamak | README, public repo |

Not: Bolum 3, madde 1 geregi bu sistemde klasik "admin/operator" aktoru **kalici olarak yoktur** — bu hem bir guc hem bir risktir (bkz. Bolum 4.7 ve Bolum 14).

### 2.2 Varliklar

1. Kullanicinin EVM tarafindaki kaynak token'lari (burn oncesi).
2. Swap sonrasi router'da gecici olarak duran USDC (burn anina kadar).
3. CCTP mesaji ve onun Iris attestation'i (tek kullanimlik, taklit edilemez ama *yanlis yorumlanabilir*).
4. Stellar'da mint edilen USDC (claim sonrasi aliciya giden).
5. Soulbound NFT ve onun metadata'si (tekrar uretilemez kanit).
6. `MigrationSummary` durumu (persistent storage, TTL'e tabi).
7. Deployment manifesti (`deployments/testnet-2.0.json`) — bu bir varlik cunku **yanlissa** herkesi yaniltir.
8. README/dokumantasyondaki iddialar — bunlar da bir varlik, cunku proje itibari buna bagli.

### 2.3 Saldiri yuzeyi haritasi

| Bilesen | Giris noktasi | Olasi saldiri/hata | Mevcut savunma (DIRECTIVE-2.0.md) | Bu belgenin ekledigi savunma |
|---|---|---|---|---|
| `BurnRouter` | `burn(tokens[], amounts[], minOuts[], recipient)` | Reentrancy sirasinda bakiye olcumunun manipulasyonu | Bakiye farki olcumu | Bolum 4.1 — checks-effects-interactions + `nonReentrant` + tekil harici cagri sirasi |
| `BurnRouter` | swap adimi | Sandvic saldirisi, bayat fiyat | `minOut` | Bolum 4.3 — `deadline` parametresi, TWAP/agregator tercihi |
| `BurnRouter` | `hookData` insasi | Yanlis `strkey`, checksum hatasi, yanlis uzunluk | Uzunluk + `G`/`C` oneki + 56 karakter kontrolu | Bolum 4.4 — tam Base32/CRC16 checksum dogrulamasi, sadece format degil |
| `BurnRouter` | dis bagis (donation) | Router'a dogrudan token gonderilip yakma miktarinin sisirilmesi | Bakiye farki olcumu | Bolum 4.2 — bunu acik negatif test olarak zorunlu kil, ayrica "once/sonra" bakiyeyi *ayni token* icin tekil okuma |
| `BurnRouter` | token secimi | Kotu niyetli/ERC777/rebasing token | — | Bolum 4.5 — bilinen kotu niyetli davranis siniflari listesi ve zorunlu fuzz |
| `GateClaim.claim` | mesaj ayristirma | Kisa/bozuk byte dizisinde panik (`unwrap`/`panic!`) | "assume valid dali yok" | Bolum 5.1 — panik yerine `Result`, tum slicing'lerde sinir kontrolu |
| `GateClaim.claim` | `mintRecipient`/`destinationCaller` | D1 kararinin yanlis uygulanmasi | Spike S1 | Bolum 5.2 — deploy sonrasi on-chain dogrulama testi, mainnet oncesi tekrar |
| `GateClaim.claim` | ondalik donusumu (×10) | Tasma (overflow) veya yuvarlama hatasi buyuk miktarlarda | S3 kaniti | Bolum 5.3 — checked-arithmetic zorunlulugu, sinir-deger testleri |
| `GateClaim` | TTL/archival | Kanit kaydinin sessizce arsivlenip kaybolmasi | "test et" notu | Bolum 5.4 — `bump` icin otomatik zamanlayici + ucuncu taraf "bekci" |
| `gate_campaign_example` | `claim_tier` | `get_migration` sonucunun yanlis yorumlanmasi (or. `>=` yerine `>`) | Negatif test listesi | Bolum 5.5 — sinir-deger testleri (tam 10/100/1000 USDC) |
| Web UI | Stellar adres girisi | Checksum'siz adrese burn | StrKey dogrulama | Bolum 7.1 — cift dogrulama (frontend + kontrat) |
| Web UI | fiyat/slipaj gosterimi | Honeypot/likiditesiz token'in gercek disi fiyatla gosterilmesi | "gizlenir" notu | Bolum 7.2 — coklu fiyat kaynagi, sapma esigi |
| Anahtarlar | `.env`, CI | Sizinti, git gecmisine yanlislikla girme | ".env git'te yok" | Bolum 8 — otomatik secret tarama, pre-commit kancasi |
| Manifest | `deployments/testnet-2.0.json` | Yanlis/uydurma kanit | "asla uydurma" kurali | Bolum 12 — otomatik "kanit-linter" |
| Tum sistem | Circle bagimliligi | Iris kesintisi, domain yanlis yapilandirma, dondurma | Bolum 11 dil kurallari | Bolum 6 — operasyonel izleme, "fail-closed" davranis |

## 3. Gate 1.0'dan devralinan dersler

Gate 1.0'in canli self-audit dongusu ve README'sindeki "Honest status" bolumu, Gate 2.0'in bastan kopyalamasi gereken bes kalibi ortaya koyuyor:

1. **`renounce_admin` bir urundur, dipnot degildir.** Gate 1.0'da hem registry hem gateway admin'i on-chain olarak feragat edilmis ve bu iddia, admin fonksiyonunu simule edip host'un trap ettigini dogrulayan bir problarla her turda yeniden kanitlaniyor. Gate 2.0'da "admin yok" (Bolum 3, madde 3) ayni titizlikle kanitlanmali: eger Gate 2.0 kontratlarinda hic admin yoksa (DIRECTIVE-2.0.md'nin varsayilan yolu), bunu kanitlamanin yolu "admin fonksiyonu yok" iddiasini **bytecode/ABI seviyesinde** dogrulamaktir — yani derlenmis kontratta yetkilendirme gerektiren hicbir disa acik fonksiyon olmadigini statik olarak gostermek.
2. **Bir prob, sonuc vermeden "gecti" diyemez.** Gate 1.0'in kurali: "verdict uretmeyen bir prob, hic prob olmamasindan daha kotudur" cunku sahte bir guven duygusu yaratir. Gate 2.0'in self-audit script'i (F8) bu kurali miras almali: her prob acikca `PASS`/`FAIL` dondurmeli, sessizce atlanamamali.
3. **`findings[]` silinmez, `superseded[]` de oyle.** Bir hata bulundugunda duzeltilir ama kayittan silinmez; terk edilen bir deploy neden terk edildigiyle birlikte tutulur. Bu, "ilk denemenin calistigi" yanilsamasini onler ve gelecekteki bir ajanin ayni hatayi tekrar yapmasini engeller.
4. **Operator yuzeyi = en cok saldirilacak yuzey.** Gate 1.0'in anchor facade'i uc kurala gore sertlestirilmis: okuma herkese acik, yazma asla degil; CORS beyaz liste (wildcard degil); her girdi kullanilmadan once dogrulanir. Gate 2.0'in **relayer'i yok** ama web tarafinda (Bolum 5.4, Tasima Kanitim sayfasi) yine de bir "yazma" islemi var: `claim_tier` cagrisi ve burn oncesi trustline kontrolu. Ayni uc kural oraya da uygulanmali.
5. **Kanitisiz sifat, sifat degildir.** Gate 1.0 README'si "live", "trustless", "gasless" kelimelerini yalnizca ilgili manifest anahtari doluyken kullaniyor ve bunu acikca yaziyor. Gate 2.0'in Bolum 11'i zaten bu disiplini tasiyor; Bolum 12'de bunu otomatiklestiriyoruz.

## 4. EVM tarafi: `BurnRouter` sertlestirme

### 4.1 Reentrancy ve cagri sirasi

`BurnRouter`, kullanici tarafindan secilen keyfi token kontratlarini cagirir (swap router uzerinden). Keyfi bir ERC-20 (ozellikle ERC-777 ailesi veya "callback" iceren token'lar), `transferFrom` sirasinda `BurnRouter`'a geri cagri yapabilir. Zorunlu kurallar:

- Fonksiyonun tamami `nonReentrant` ile korunmali (OpenZeppelin `ReentrancyGuard` veya esdegeri), **sadece dis cagrilar degil, tum fonksiyon**.
- **Checks-Effects-Interactions** sirasi: bakiye okumasi → swap cagrisi → bakiye farkinin hesaplanmasi → `depositForBurnWithHook` cagrisi → olay yayinlama. Hicbir dahili durum, harici cagridan *sonra* guncellenmemeli cunku bu router'da zaten durum yok denecek kadar az (immutable adresler disinda), ama **cagri sirasi** yine de saldiri yuzeyini belirler: `depositForBurnWithHook` cagrilmadan once hicbir harici, guvenilmeyen kontrata tekrar donulmemeli.
- Negatif test: kotu niyetli bir test token'i yaz (yalnizca test ortaminda), `transferFrom` icinde `BurnRouter.burn`'u tekrar cagirmayi dene, islemin revert ettigini dogrula.

### 4.2 Bakiye-farki olcumu ve dis bagis saldirisi

DIRECTIVE-2.0.md zaten "yakilan miktar = swap sonrasi gercekten alinan USDC (bakiye farki)" diyor. Bunu sertlestirmenin somut yolu:

- Olcum **tam olarak** `usdcBalanceAfter - usdcBalanceBefore` olmali, `usdcBalanceBefore` swap cagrisindan **hemen once**, ayni blokta okunmali (baska bir kullanicinin islemi arada giremez cunku EVM tek is parcaciklidir, ama router birden cok token'i **donguyle** isliyorsa her token icin bu olcum bagimsiz ve izole olmali).
- Router'a rastgele biri USDC "bagislarsa" (dogrudan `transfer`), bu bagis bir sonraki kullanicinin `usdcBalanceBefore` okumasina karisabilir ve o kullanici baskasinin parasini da yakabilir. **Zorunlu negatif test:** islem baslamadan hemen once router'a harici bir USDC transferi yap, yakilan miktarin yalnizca swap'tan gelen kisim oldugunu dogrula — bunun icin router'in fonksiyonu tek bir atomik islemde `before → swap → after` okumasini garanti etmeli, yani **iki farkli kullanici islemi arasinda router'da asla USDC kalmamali** (islem sonu bakiyesi sifir kurali zaten var, Bolum 4.4 madde 4'teki testle ortusuyor ama burada asil risk *ayni blok icinde* degil, *bloklar arasi* kalan tozdur).
- Coklu token akisinda (F4, coklu token fazi) her token icin ayri `before/after` cifti tutulmali; bir token'in islenmesi sirasinda olusan bakiye degisikligi baska bir token'in olcumunu etkilememeli.

### 4.3 Slipaj, deadline ve fiyat manipulasyonu

- `minOut` zaten zorunlu (Bolum 3, madde 4 ve Bolum 5.1). Buna ek olarak **`deadline` parametresi** eklenmeli: kullanici islemi imzaladiktan sonra mempool'da bekletilip cok sonra, fiyat kosullari degistikten sonra calistirilabilir (ozellikle dusuk gas fiyatli testnet'te bu ihmal edilebilir gorunse de aliskanlik mainnet icin kritik). `block.timestamp > deadline` ise revert.
- Swap router'in fiyat kaynagi sandvic saldirisina aciksa (AMM spot fiyati), `minOut`'un kullanici tarafindan **gercekci** girilmesi UI sorumlulugu (Bolum 7.2), ama kontrat seviyesinde `minOut == 0` girisine izin **verilmemeli** ya da en azindan acik bir uyari/onay adimi zorunlu kilinmali, cunku sifir `minOut` sandvic saldirisini tamamen kontrata davet eder.
- Negatif test: `minOut`'un altina dusen bir swap **tumuyle** geri alinmali (bu zaten Bolum 8'de var) — buna ek olarak, swap sonrasi CCTP cagrisi hic yapilmadigini da dogrulayan bir test ekle (yarim kalmis burn = kalici fon kaybi riski, Bolum 6'daki Circle uyarisiyla ayni sinif hata).

### 4.4 `hookData` insasi ve strkey dogrulamasi

DIRECTIVE-2.0.md, router'in `hookData` seklini (uzunluk, `G`/`C` oneki, 56 karakter) dogruladigini soyluyor. Bu **gerekli ama yeterli degil**: 56 karakterlik, `G` ile baslayan ama **checksum'i bozuk** bir strkey bu kontrolden gecer ve mesaj Stellar tarafinda geri dondurulemeyecek sekilde olusur (kaynak tarafta hic mesaj olusmadigi icin, DIRECTIVE-2.0.md'nin Bolum 8'indeki "bozuk alici hook'u" negatif testi bunu kismen kapsiyor, ama testin **gercek bir checksum hatasiyla** calistirildigindan emin olunmali, sadece uzunluk/onek hatasiyla degil).

- **Zorunlu:** Solidity tarafinda tam Stellar StrKey Base32 + CRC16-XModem checksum dogrulamasi uygula (bu, on-chain'de ucuz bir islemdir — 56 karakterlik bir string icin Base32 decode + CRC16, birkac bin gas'tan fazla tutmaz). Sadece format kontrolu ile checksum kontrolu **iki farkli negatif test** olarak ayri ayri yazilmali: (a) yanlis uzunluk/onek reddedilir, (b) dogru uzunluk/onek ama bozuk checksum reddedilir.
- `hookData`'nin 24 bayt sifir + versiyon + uzunluk + strkey seklindeki bayt duzeni, bir birim testte **byte-byte** dogrulanmali — CCTP hook formati Circle'in dokumantasyonuna gore sabittir ve burada bir off-by-one hatasi (or. uzunluk alaninin UTF-8 byte sayisi yerine karakter sayisi olmasi, ki ASCII strkey icin ayni ama yine de acikca test edilmeli) dogrudan Bolum 6'daki "fon kalici olarak takilir" senaryosuna girer.

### 4.5 Kotu niyetli/anormal token davranislari

DIRECTIVE-2.0.md'nin Bolum 8'i "toz, likiditesiz ve fee-on-transfer token davranislari test edilmis" diyor. Bunu somut bir liste haline getiriyoruz — F4'un kabul kriterine su token siniflarinin **her biri icin ayri fuzz/birim testi** eklenmeli:

| Token sinifi | Risk | Beklenen davranis |
|---|---|---|
| Fee-on-transfer | `transferFrom` ile alinan miktar, gonderilenden az | Bakiye-farki olcumu zaten dogru sonucu verir; test bunu kanitlamali |
| Rebasing (or. elastik arz) | Bakiye, blok icinde beklenmedik sekilde degisebilir | Olcum penceresinin mumkun oldugunca dar oldugu dogrulanmali |
| ERC-777 / callback'li | Reentrancy vektoru | Bolum 4.1'deki koruma test edilmeli |
| Sifir ondalikli veya cok yuksek ondalikli | Aritmetik tasma/yuvarlama | Sinir-deger testleri |
| `transfer` donus degeri yanlis/olmayan (bazi eski token'lar `bool` dondurmez) | Sessiz basarisizlik | `SafeERC20` benzeri saramalayici kullan, ham `transfer`/`transferFrom` cagrilmamali |
| Likiditesiz/honeypot (satilamayan) | Kullanici fonu router'da veya swap'ta kilitlenir | UI gizler (Bolum 7.2) ama kontrat da `minOut` ile bunu reddeder |
| Kara listeye alma yetkisi olan (or. merkezi stabilcoin) | Router adresi kara listeye alinirsa tum akis durur | Bilinen bir kisit olarak README'ye yazilir, kontrat seviyesinde cozulemez |

### 4.6 Statik analiz ve fuzz zorunlulugu

- **Slither** ve **Mythril**, `BurnRouter` uzerinde her fazdan sonra calistirilmali; yuksek/orta onemli bulgular `findings[]`'e yazilir ve kapatilmadan bir sonraki faz acilmaz.
- **Foundry fuzz testleri**: `minOut`, miktar ve token adresi rastgele uretilerek islem sonu router bakiyesinin her kosulda sifir oldugu (invariant) dogrulanmali. Bu, F4'un kabul kriterindeki "router bakiyesi islem sonrasi 0" iddiasini tek bir ornekten (unit test) bir **invariant**'a (her girdi icin dogru) yukseltir.
- **Echidna** ile invariant testi: "router hicbir zaman token tutmaz" ve "toplam yakilan USDC ≤ toplam alinan USDC" gibi ozellikler surekli fuzz edilmeli.
- Derleyici uyarilari hata olarak ele alinmali (`forge build` uyarisiz gecmeli), Solidity surumu sabitlenmeli (floating pragma yasak — bu, Bolum 3 madde 3'teki "upgrade yok" ruhuyla uyumludur: derleyici surumu de bir cesit dondurulmus varsayimdir).

### 4.7 Admin yok / pause yok gerilimi

DIRECTIVE-2.0.md'nin Bolum 3'u admin ve upgrade'i tamamen yasakliyor. Bu, klasik bir "acil durdurma" (pause/circuit breaker) mekanizmasini da imkansiz kiliyor — bilincli bir mimari tercih ama sonuclari acikca yazilmali:

- Bir hata bulundugunda (or. `hookData` insasinda bir kusur), **kontrat duzeltilemez**. Tek cozum yolu yeni bir `BurnRouter` deploy etmek ve eskisinin adresini kullanicilarin onunden kaldirmaktir (web UI'da). Bu yuzden **F4'un kabul kriterine eklenecek madde:** router'in kendisi hicbir fon tutmadigindan, "acil durdurma" ihtiyaci yalnizca *yeni islemleri onlemek* icindir — bunun tek gercekci kontrol noktasi **frontend'dir** (Bolum 7.4). Bu, custody riski yaratmaz ama netlik riski yaratir: README, "admin yok" ile "hata duzeltilemez" arasindaki farki acikca yazmali (oneri: `docs/GATE2_TRUST_MODEL.md`'ye bir "Ne olur da bir hata bulunursa" bolumu).
- `GateClaim` tarafinda da ayni gerilim var: hatali bir `GateClaim` deploy edilirse, o kontrata gonderilmis CCTP mesajlari (eger `mintRecipient` o adrese sabitlenmisse) **kurtarilamaz**. Bu yuzden Spike S1'in kaniti ve F2'nin ilk uctan uca testi, **kucuk miktarlarla** ve **birden fazla bagimsiz kisi tarafindan gozden gecirilerek** yapilmali; bu bir oneri degil, Bolum 6'daki Circle uyarisinin dogrudan sonucu.

## 5. Soroban tarafi: `GateClaim` ve `gate_campaign_example` sertlestirme

### 5.1 Panik yerine hata: mesaj ayristirma

CCTP mesaj formati sabit bir bayt duzenine sahiptir. Soroban/Rust'ta yaygin bir hata, `message[a..b]` gibi bir dilimlemenin, mesaj beklenenden kisaysa **panic** uretmesidir. Soroban'da bir panik, islemi geri alir (bu iyi) ama **anlamsiz bir hata koduyla** (bu kotu) — self-audit veya izleme araclari "hangi kontrol basarisiz oldu" sorusuna cevap alamaz.

- Zorunlu kural: mesaj uzunlugu, her alan okunmadan **once** acikca kontrol edilmeli (`if message.len() < EXPECTED_LEN { return Err(Error::MalformedMessage) }`), asla dilimleme panik'e birakilmamali.
- Negatif test seti genisletilmeli: DIRECTIVE-2.0.md'nin Bolum 8 listesine ek olarak, **her bir alan icin ayri ayri** kisaltilmis mesaj testi (bastan kesilmis, ortadan kesilmis, sonu eksik) eklenmeli. "Bir bayti bozulmus attestation reddedilir" testi zaten var; buna simetrik olarak "N bayti eksik mesaj reddedilir" testi eklenmeli.

### 5.2 D1 kararinin deploy-sonrasi dogrulanmasi

Spike S1, D1 kararini (varsayilan G: `mintRecipient == destinationCaller == GateClaim`) test ortaminda dogruluyor. Ama bu, **her yeni deploy**'da yeniden dogrulanmasi gereken bir invaryanttir, cunku bir adres kopyalama hatasi (or. eski `GateClaim` adresinin yanlislikla yeni deploy'a tasinmasi) sessizce D1'i bozar ve bu ancak ilk gercek claim basarisiz oldugunda (ya da daha kotusu, F secenegindeki gibi sessizce NFT'siz USDC transferi olarak) fark edilir.

- **Zorunlu deploy-sonrasi kontrol:** deploy script'i, deploy bittikten hemen sonra otomatik olarak `GateClaim` adresinin CCTP `MessageTransmitter`'da hem `mintRecipient` hem `destinationCaller` olarak simule edilebildigini test etmeli ve sonucu manifestin `spikes[]` degil, ayri bir `post_deploy_checks[]` alanina yazmali (bu, bir kerelik spike kanitiyla her-deploy kanitini birbirinden ayirir).
- Bu kontrol, F2, F3, F4, F5, F6 fazlarinin **her birinde**, eger o fazda yeni bir `GateClaim` deploy'u yapilmissa tekrarlanmali.

### 5.3 Ondalik donusumu ve aritmetik tasma

`× 10` donusumu (6 ondaliktan 7 ondaliga) basit gorunur ama iki risk tasir:

1. **Tasma:** `i128` kullaniliyor olsa da (DIRECTIVE-2.0.md `MigrationSummary.total_usdc: i128` diyor), cok buyuk bir `amount` degeri × 10 isleminde teorik tasma sinirina yaklasabilir. Soroban'in checked-arithmetic davranisi (debug modda panik, release modda tanimsiz olabilir — bu SDK surumune gore degisir) **acikca** dogrulanmali: carpma islemi `checked_mul` ile yapilmali, `None` durumunda `Err` donulmeli, ciplak `*` operatorune guvenilmemeli.
2. **Yuvarlama/kesinlik kaybi yok, ama toplama kesinligi:** `MigrationSummary.total_usdc` birden fazla claim'i topluyorsa (`claim_count` alani bunu ima ediyor), bu toplama da `checked_add` ile yapilmali.
- Sinir-deger testleri: `amount = 0`, `amount = u64::MAX`'e yakin bir CCTP miktari, `amount` tam olarak Bronze/Silver/Gold esiklerinde (Bolum 5.5).

### 5.4 TTL/archival ve `bump` bekciligi

DIRECTIVE-2.0.md zaten "bunu test et, aksi halde kanitlar arsivlenip kaybolabilir" diyor. Bunu sertlestirmenin somut adimlari:

- **Negatif test:** bir `MigrationSummary` kaydinin TTL'ini kasitli olarak suresi dolacak sekilde ayarla (test ortaminda ledger'i ileri sar), `bump` cagrilmazsa kaydin gercekten erisilemez hale geldigini dogrula — bu, "arsivlenmis kanit" senaryosunun gercekten oldugunu kanitlar, sadece teoride var oldugunu degil.
- **Pozitif test:** `bump`'in *herhangi biri* tarafindan (kayit sahibi olmayan bir hesaptan) cagrilabildigini ve TTL'i gercekten uzattigini dogrula.
- **Operasyonel oneri:** F8'deki self-audit script'i, her turda **rastgele secilmis** eski bir kaydi `bump`'lamali ve TTL'in arttigini dogrulamali. Bu, Gate 1.0'in "sistem kanitlamaya devam ediyor, bir kere kanitlamadi" felsefesinin dogrudan devamidir. Kimse `bump` cagirmazsa ve kayitlar sessizce arsivlenirse, `get_migration` bir gun "bulunamadi" donmeye baslar ve bu, kullanici icin "kanitim kayboldu" anlamina gelir — sistemin en kirilgan olabilecegi nokta budur cunku hata *fon kaybi degil, guven kaybidir* ve bu proje guven uzerine kurulu.

### 5.5 `gate_campaign_example`: sinir-deger ve yorum hatalari

- Esikler (`>= 10`, `>= 100`, `>= 1000`) **tam sinirda** test edilmeli: `total_usdc = 9.999999` Bronze vermemeli, `total_usdc = 10.000000` Bronze vermeli, vb. Gate 1.0'in Bulgu #4'u (yanlis nedenle gecen test) tam olarak bu tur sinir hatalarinda ortaya cikar — bir testin "10 USDC ustu Bronze alir" demesi yetmez, "9.999999 USDC Bronze **almaz**" testi de olmali.
- `claim_tier`'in `owner` parametresi icin `require_auth` kullanildigi dogrulanmali — aksi halde biri baskasi adina, o kisinin rizasi olmadan kademe talep edebilir (zararsiz ama yaniltici bir olay yayinlar).
- Kademe dusurme (downgrade) senaryosu: DIRECTIVE-2.0.md "yukseltme serbest" diyor ama dusurme davranisini tanimlamiyor — eger `get_migration` bir sekilde azalabiliyorsa (normalde azalmaz, ama gelecekte bir "geri alma" ozelligi eklenirse) kademe dusurulmeli mi sorusu simdiden `findings[]`'e not dusulmeli, F5'te karara baglanmali.

## 6. CCTP/Circle bagimlilik riskleri

Bolum 11'in dil kurallari ("Trustless" denmez, guven koku Circle'in attestation'idir) dogru baslangic noktasi. Bunu operasyonel hale getiriyoruz:

- **Iris API kesintisi:** attestation gecikirse ya da hic gelmezse, kullanicinin burn'u yakilmis ama claim edilememis durumda kalir. Web UI (Bolum 7.3), bu durumu **acikca** gostermeli ("attestation bekleniyor, bu Circle'in altyapisina baglidir, dakikalar surebilir") ve kullaniciyi yaniltici bir "basarisiz" mesajiyla korkutmamali. Bir "durum sorgula" arayuzu (burn tx hash'i girilerek attestation durumunun tekrar sorgulanabildigi) F6'nin kabul kriterine eklenmeli.
- **Domain yanlis yapilandirmasi:** Spike S2 testnet kontrat adreslerini "Circle docs'tan alinir, koda gomulmez, manifeste yazilir" diyor. Bunu guclendiren kural: bu adresler **derleme zamaninda degil, deploy zamaninda** enjekte edilmeli ve deploy script'i, kullanilan adresin Circle'in resmi dokumantasyon sayfasindaki guncel adresle **elle capraz kontrol edildigine dair bir onay adimi** (insan tarafindan tiklanan bir checkbox/commit mesaji) icermeli — bu tur adresler zaman zaman guncellenir ve eski bir adresi sessizce kullanmak Bolum 6'daki "kalici takilma" riskinin en sinsi turudur cunku kontrat **calisir gorunur**, sadece yanlis hedefe konusur.
- **Circle'in dondurma yetkisi:** README bunu zaten durustce yazacak (Bolum 11). Ek olarak `docs/GATE2_TRUST_MODEL.md`'ye somut bir senaryo eklenmeli: "Circle, kaynak veya hedef USDC'yi dondurursa ne olur" — cevap muhtemelen "claim islemi Circle tarafinda reddedilir, kullanici fonu kurtaramaz, bu bizim kontrolumuz disindadir" olacaktir ve bu acikca yazilmali, gizlenmemeli.
- **CCTP mesaj geri alinamazligi:** Bolum 11 bunu zaten "sybil siniri ve fon-takilma riski acikca yazilir" diye not ediyor. Buna ek olarak F7'nin negatif test listesine su senaryo eklenmeli: yanlis `mintRecipient` iceren bir mesajin **hicbir sekilde** `GateClaim` tarafindan "kurtarilamadigi" acikca gosterilmeli (bu zaten Bolum 8'de var, ama "kurtarilamaz" iddiasinin kendisi de test edilmeli — yani birinin bu mesaji baska bir yoldan `GateClaim`'e sunmaya calisip basarisiz oldugunu gostermek, sadece "normal claim basarisiz olur" demekten daha guclu bir kanittir).

## 7. Web/Frontend sertlestirme (`gate2/web`)

### 7.1 Adres dogrulama — cift katman

Frontend'in StrKey dogrulamasi kullanici deneyimi icindir, **guvenlik siniri degildir** cunku frontend guvenilmeyen bir ortamdir (tarayici uzantilari, kullanici DevTools ile manipulasyon, XSS). Bolum 4.4'teki on-chain checksum dogrulamasi asil guvenlik siniridir. Bu iki katmanin **ayni kutuphaneyi/ayni algoritmayi** kullandigindan emin olunmali — frontend'de "gorunuste dogru" ama on-chain'de reddedilen bir adres, kullaniciya "islem neden reddedildi" konusunda kafa karisikligi yaratir (bu bir guvenlik acigi degil ama bir guven acigidir, Bolum 3 madde 7 ruhuyla tutarli olmali).

### 7.2 Fiyat/slipaj gosterimi guvenilirligi

- Likiditesiz/honeypot tespiti tek bir kaynaga (or. tek bir fiyat API'si) dayanmamali; en az iki bagimsiz kaynak (or. on-chain quote + off-chain agregator) karsilastirilip **sapma bir esigi asarsa** kullaniciya uyari gosterilmeli, islem otomatik engellenmemeli ama "yuksek risk" etiketi konmali.
- Gosterilen `minOut` **tavsiye edilen** bir deger olmali, kullanici bunu degistirebilmeli ama sifira cok yakin bir deger girerse (Bolum 4.3) acik bir uyari gosterilmeli.

### 7.3 Attestation bekleme durumu ve kullaniciyi yanlis yonlendirmeme

Bolum 6'da belirtildigi gibi, Iris gecikmesi kullanicida panik yaratabilir. UI, burn tx hash'ini **kalici olarak** (yerel depolama + opsiyonel olarak URL parametresi ile paylasilabilir bir baglanti) saklamali, boylece kullanici sayfayi kapatip geri donse bile "attestation durumu" tekrar sorgulanabilsin. Bu bir guvenlik onlemi degil ama **fon kaybi yanilsamasini** onler — kullanici "param gitti" diye dusunup gereksiz destek talepleri acmaz.

### 7.4 Bagimlilik ve tedarik zinciri sertlestirmesi

- `npm audit` (veya `pnpm audit`) her CI calismasinda zorunlu; yuksek/kritik bulgular F6'yi bloklamali.
- Kilit dosyasi (`package-lock.json`/`pnpm-lock.yaml`) commit'lenmeli, surum araliklari degil tam surumler tercih edilmeli — ozellikle cuzdan baglantisi (Freighter API) ve kripto kutuphaneleri (strkey/CRC hesaplama) icin, cunku bu kutuphanelerdeki bir tedarik zinciri saldirisi dogrudan kullanici fonlarini hedef alir.
- Eger CDN'den herhangi bir script yukleniyorsa Subresource Integrity (SRI) hash'i zorunlu.
- CSP (Content-Security-Policy) basligi, yalnizca gerekli kaynaklara (Freighter uzantisi, RPC endpoint'leri) izin verecek sekilde daraltilmali.

### 7.5 Frontend'in "acil durdurma" rolu

Bolum 4.7'de belirtildigi gibi, kontratlarda pause mekanizmasi yok. Bu nedenle **tek gercekci kontrol noktasi** frontend'dir: eger bir hata bulunursa, onerilen ilk mudahale "web UI'daki router adresini kaldirmak/uyari eklemek" olmalidir. Bu, F6'nin kabul kriterine eklenmeli: web uygulamasi, kullanilan kontrat adreslerini **kod icine gommek yerine** kolayca guncellenebilir bir yapilandirma dosyasindan okumali, boylece bir olay aninda dakikalar icinde "bu kontrat artik onerilmiyor" uyarisi yayinlanabilir.

## 8. Anahtar yonetimi ve operasyonel guvenlik

- `.env`'in git'te olmadigi zaten kural (Bolum 1, madde 5). Bunu **otomatiklestir**: CI pipeline'ina `gitleaks` veya esdegeri bir secret-tarama adimi ekle, her push'ta calissin. Bir anahtar sizintisi tespit edilirse CI kirmizi olmali, insan onayi olmadan merge edememeli.
- Pre-commit kancasi (`pre-commit` + `detect-secrets` ya da `gitleaks protect`) gelistirici makinesinde de calistirilmali, boylece sizinti commit aninda yakalanir, push aninda degil.
- Testnet hesaplari icin bile "en az ayricalik" ilkesi uygulanmali: burn islemini test eden hesap ile deploy eden hesap **farkli** olmali, boylece bir test script'indeki hata deploy anahtarini tehlikeye atmaz.
- Deploy script'lerinin **idempotent** oldugu kanitlanmali: ayni script iki kez calistirildiginda yanlislikla ikinci bir `GateClaim` deploy edip eski adresi manifestte "unutmadigindan" emin ol (Gate 1.0'in `superseded[]` deseni burada da uygulanmali: her yeni deploy, oncekini `superseded[]`'e tasiyarak nedenini yazmali).

## 9. CI/CD ve tedarik zinciri guvenligi

- `cargo audit` (Rust bagimliliklarinda bilinen guvenlik aciklari icin) her CI calismasinda zorunlu.
- `cargo clippy -- -D warnings`: uyarilar hata olarak ele alinmali, ozellikle `unwrap()`/`expect()`/`panic!()` kullanimini isaretleyen lint kurallari (Bolum 5.1) CI'da ozel olarak taranmali — basit bir `grep -rn "unwrap()\|expect(\|panic!(" gate2/soroban/` kontrolu bile, F1'den itibaren her fazin CI adimina eklenebilir ve bu belgenin en ucuz, en yuksek getirili maddesidir.
- Foundry projesinde `forge build --sizes` ile kontrat boyutu izlenmeli (EVM 24KB siniri); Soroban tarafinda WASM boyutu izlenmeli cunku buyuyen bir kontrat hem gaz/kaynak maliyetini hem de denetim yuzeyini buyutur.
- Regresyon kapisi (1.0 testleri 12/11/3) zaten CI'a baglanmali: bu sayilardan herhangi biri duserse CI kirmizi olmali, sadece rapor olarak degil, **merge engelleyici** olarak.

## 10. Test sertlestirme: fuzz, invariant, mutation

- **Mutation testing** (Solidity icin `gambit` veya benzeri, Rust icin `cargo-mutants`): mevcut testlerin gercekten anlamli oldugunu kanitlamanin en guclu yolu, kodun kucuk bir parcasini kasitli olarak bozup (or. `>=` yerine `>` yaz) testlerin bunu yakalayip yakalamadigini gormektir. Gate 1.0'in Bulgu #4'u (yanlis nedenle gecen test) tam olarak mutation testing'in yakalayacagi turden bir hatadir. F7 veya F8'in kabul kriterine "mutation skoru >= %X" gibi bir hedef eklenmesi onerilir.
- **Invariant testleri** (Foundry `invariant_` fonksiyonlari, Soroban icin ozel fuzz harness): "router asla token tutmaz", "toplam mint <= toplam burn (feeExecuted dusulerek)", "hicbir NFT asla transfer edilemez" gibi ozellikler tek seferlik testler yerine surekli fuzz edilen invaryantlar olarak ifade edilmeli.
- **Chaos/negatif testlerin genisletilmesi:** RPC saglayicisi yanit vermezse, Iris API 500 donerse, Stellar agi gecici olarak tikanirsa sistemin **fail-closed** (islemi reddet, sessizce yarim birakma) davrandigi ayrica test edilmeli. Bolum 8'deki negatif test listesi buyuk olcude "kotu niyetli girdi" senaryolarini kapsiyor; bu madde "altyapi arizasi" senaryosunu ekliyor.

## 11. Izlenebilirlik, self-audit'in canliya tasinmasi, olay mudahalesi

- Gate 1.0'in self-audit deseni (canli kontrata karsi periyodik prob, sonuclarin `deployments/self-audit-2.0.json`'a yazilmasi ve salt-okunur bir arayuzde sunulmasi) Gate 2.0'a **birebir tasinmali**. F8 bunu zaten planliyor; ek olarak:
  - Her turun sonucu **zaman damgali ve eklemeli** olmali (uzerine yazilmamali), Gate 1.0'daki "round 4, 7/7" formati gibi.
  - Prob'lar arasinda Bolum 5.4'teki `bump` bekciligi ve Bolum 5.2'deki deploy-sonrasi D1 dogrulamasi da yer almali.
- **Anomali izleme:** beklenmedik buyuklukte tek bir burn, kisa surede ayni adresten cok sayida basarisiz `claim` denemesi (olasi bir saldiri kesfi belirtisi) gibi olaylar icin basit bir esik-tabanli uyari (or. bir cron job'un `deployments/testnet-2.0.json`'daki `receipts[]`'i tarayip esik asimlarini loglamasi) F8'in kapsamina eklenmeli.
- **`SECURITY.md` ve sorumlu ifsa sureci:** repoya bir guvenlik acigi bildirme kanali (e-posta veya ozel bir form) tanimlanmali; bu, dis katkicilarin/denetcilerin bir kusuru bulduklarinda bunu public bir issue yerine guvenli bir kanaldan bildirmesini saglar.
- **Post-mortem kulturu:** Gate 1.0'in `findings[]`'i asla silmemesi gibi, canlida (testnet dahi olsa) yasanan her beklenmedik davranis bir post-mortem notuyla `findings[]`'e eklenmeli — "ne oldu, neden oldu, ne degisti" formatinda, Gate 1.0'in Bulgu 1-4 orneklerindeki gibi.

## 12. Dil ve dokumantasyon sertlestirme: "kanit-linter"

Bolum 11 (DIRECTIVE-2.0.md) zaten "Yakildi", "1:1", "Gasless" gibi kelimelerin kanitsiz kullanilamayacagini soyluyor. Bunu insan gozden gecirmesine birakmak yerine otomatiklestiriyoruz:

- Basit bir script (`gate2/scripts/proof-lint.js` veya benzeri) `README.md`/`README.tr.md` icinde su kelimeleri arasin: "live/canli", "1:1", "trustless/guvensiz", "gasless", "kanitlandi". Her biri gectiginde, o cumlenin yakininda bir tx hash'e veya `deployments/testnet-2.0.json` anahtarina referans olup olmadigini kontrol etsin (or. bir markdown linki veya ters tirnak icinde 64 karakterlik hex).
- Bu script CI'da calismali; referanssiz bir iddia bulunursa CI uyari versin (baslangicta engelleyici olmasa da zamanla engelleyici hale getirilebilir).
- Bu, Bolum 3 madde 6'daki "kanit asla uydurulmaz" kuralinin insan hatasina karsi ikinci bir savunma katmanidir — bir ajan yorgun/aceleci bir anda "artik canli" yazabilir, script bunu yakalar.

## 13. Faz planina ek: her fazin sonuna guvenlik kapisi + yeni F9

DIRECTIVE-2.0.md'nin F0-F8 fazlarinin her birine, mevcut kabul kriterine **ek olarak** asagidaki "H-kapisi" (hardening gate) eklenmelidir. Bir faz, kendi kabul kriteri **ve** ilgili H-kapisi gecmeden kapanmaz:

| Faz | Ek H-kapisi |
|---|---|
| F0 | `gitleaks`/secret-tarama CI'a bagli ve yesil |
| F1 | Her spike sonucunun `post_deploy_checks[]` formatinda da tekrarlanabilir oldugu dogrulanmis (Bolum 5.2) |
| F2 | Bolum 4.1-4.3'teki reentrancy/deadline/bakiye-farki testleri yazilmis ve gecmis |
| F3 | TTL/`bump` negatif testi (Bolum 5.4) ve ondalik tasma testleri (Bolum 5.3) gecmis |
| F4 | Slither/Mythril raporu temiz veya bulgular `findings[]`'e yazilmis; Bolum 4.5'teki token siniflarinin her biri fuzz edilmis |
| F5 | Sinir-deger testleri (Bolum 5.5) gecmis |
| F6 | `npm audit` temiz, CSP/SRI uygulanmis, attestation-bekleme UI'i test edilmis (Bolum 7.3) |
| F7 | Mutation testing calistirilmis, skor manifestte kayitli |
| F8 | Kanit-linter (Bolum 12) CI'a bagli; self-audit script'i Bolum 11'deki anomali izlemeyi iceriyor |

Buna ek olarak, **yeni bir faz** oneriyoruz:

**F9 — Dis gozden gecirme ve mainnet-oncesi dondurma.**

*Kabul kriteri:*
- Kod, en az bir gun sureyle "dondurulmus" halde tutulur (yeni ozellik eklenmez), yalnizca F0-F8'in H-kapilarinda bulunan sorunlar duzeltilir.
- Mumkunse bagimsiz bir ucuncu kisi (ekip disindan bir gelistirici/denetci) `contracts/`, `gate2/evm/` ve `gate2/soroban/`'i okur ve en az bir "taze goz" bulgusu ya da "bulgu yok, X ve Y'yi kontrol ettim" onayi `findings[]`'e eklenir.
- Bolum 14'teki mainnet gecis kapisi somut bir kontrol listesi olarak doldurulur (henuz onaylanmamis olsa da).
- `docs/GATE2_TRUST_MODEL.md` bu belgenin (Ek A) tum maddelerine karsi bir "durum" sutunu ekler: yapildi / kismen yapildi / bilincli olarak yapilmadi (nedeniyle).

## 14. Mainnet gecis kapisi

Bolum 3 madde 8 "mainnet icin ayri ve acik bir insan karari gerekir" diyor. Bunu somutlastiriyoruz — mainnet'e gecis, asagidaki listenin **tamami** isaretlenmeden yapilamaz:

- [ ] F0-F9 tum kabul kriterleri ve H-kapilari kanitli.
- [ ] En az bir bagimsiz dis gozden gecirme (F9) tamamlanmis; mumkunse ucretli/bagimsiz bir denetim firmasi tarafindan.
- [ ] Slither/Mythril/mutation testing raporlari temiz veya kalan bulgular acikca kabul edilmis ve gerekcelendirilmis.
- [ ] Circle'in mainnet domain/kontrat adresleri, testnet icin kullanilanlardan **ayri bir dogrulama turuyla** teyit edilmis (Bolum 6).
- [ ] Mainnet deploy'u, testnet deploy'undan **farkli ve daha kisitli** anahtarlarla yapiliyor; deploy anahtari mumkunse ikinci bir kisi tarafindan da dogrulaniyor (iki-kisi kurali; klasik anlamda "multisig admin" degil cunku admin yok, ama *deploy isleminin kendisi* iki kisi onayli olabilir).
- [ ] Kucuk miktarla ("kanarya" testi) gercek bir uctan uca akis mainnet'te calistirilmis ve kanitlanmis, **sonra** genis kullanima acilmis.
- [ ] `SECURITY.md` ve sorumlu ifsa kanali yayinda.
- [ ] Bu gecisi onaylayan kararin kendisi (kim, ne zaman, hangi kanitlara dayanarak) bir commit mesajinda veya `deployments/mainnet.json` icinde `decision_record` olarak kayitli — yani mainnet kararinin kendisi de Bolum 1'in "kanit once" kuralina tabi.

## 15. Sertlestirme kontrol listesi (ozet)

Bu, onceki bolumlerin sikistirilmis, hizli taranabilir halidir; her fazda geri donup kontrol edilebilir:

**EVM (`BurnRouter`)**
- [ ] `nonReentrant` + checks-effects-interactions
- [ ] `deadline` parametresi
- [ ] Tam StrKey checksum dogrulamasi (yalnizca format degil)
- [ ] Bakiye-farki olcumu, dis bagis senaryosu dahil test edilmis
- [ ] Fee-on-transfer/rebasing/ERC-777/kara-liste token senaryolari fuzz edilmis
- [ ] `SafeERC20` benzeri sarmalayici, ham `transfer`/`transferFrom` yok
- [ ] Slither/Mythril/Echidna raporlari temiz veya gerekceli
- [ ] Sabit derleyici surumu, uyarisiz derleme

**Soroban (`GateClaim`, `gate_campaign_example`)**
- [ ] Hicbir `unwrap()`/`panic!()` mesaj ayristirmada yok
- [ ] D1 (mintRecipient == destinationCaller == self) her deploy'da otomatik dogrulaniyor
- [ ] Checked-arithmetic her yerde (× 10 donusumu dahil)
- [ ] TTL/`bump` negatif ve pozitif testleri var
- [ ] Sinir-deger testleri (Bronze/Silver/Gold esikleri)
- [ ] NFT transfer/approve denemesi test edilerek basarisiz kilinmis
- [ ] `require_auth` dogru yerde (yalnizca gerekenlerde)

**Web**
- [ ] Frontend + kontrat cift-katman adres dogrulama tutarli
- [ ] Coklu fiyat kaynagi + sapma uyarisi
- [ ] Attestation-bekleme durumu kalici ve tekrar sorgulanabilir
- [ ] `npm audit` temiz, kilit dosyasi commit'li
- [ ] CSP/SRI uygulanmis
- [ ] Kontrat adresleri koddan ayri, hizla guncellenebilir yapilandirmada

**Operasyon**
- [ ] Secret tarama (CI + pre-commit) aktif
- [ ] Deploy script'leri idempotent, `superseded[]` deseni uygulaniyor
- [ ] Self-audit dongusu canli, sonuclar eklemeli ve zaman damgali
- [ ] `SECURITY.md` ve ifsa kanali var
- [ ] Kanit-linter CI'da calisiyor
- [ ] Mainnet kontrol listesi (Bolum 14) doldurulmadan mainnet yok

## 16. Onerilen araclar (ozet tablo)

| Katman | Arac | Amac |
|---|---|---|
| Solidity statik analiz | Slither, Mythril | Bilinen zafiyet kaliplarini yakalama |
| Solidity fuzz/invariant | Foundry (`forge fuzz`, `invariant_*`), Echidna | Router bakiyesi, minOut ihlalleri |
| Solidity mutation | Gambit veya esdegeri | Testlerin gercekten anlamli oldugunu kanitlama |
| Rust/Soroban lint | `cargo clippy -D warnings` | `unwrap`/`panic!` gibi kaliplari yakalama |
| Rust bagimlilik | `cargo audit` | Bilinen CVE'li crate'leri yakalama |
| Rust fuzz | `cargo-fuzz`, `proptest` | Mesaj ayristirma, ondalik donusum sinir durumlari |
| Rust mutation | `cargo-mutants` | Soroban testlerinin gercek kapsami |
| Secret tarama | `gitleaks`, `detect-secrets` | Anahtar sizintisi |
| JS bagimlilik | `npm audit` / `pnpm audit` | Frontend tedarik zinciri |
| Kontrat boyutu | `forge build --sizes`, `stellar contract build` ciktisi | EVM 24KB siniri, WASM sismesi |
| Manifest dogrulama | Ozel `proof-lint.js` (Bolum 12) | README iddialarinin kanitla eslesmesi |

## 17. Kapanis: bitti tanimina ek

DIRECTIVE-2.0.md'nin Bolum 12'sindeki "bitti" tanimina su madde eklenir:

> F0-F9 kabul kriterleri ve bu belgedeki tum H-kapilari kanitli; Bolum 15'teki kontrol listesinin tamami isaretli; `docs/GATE2_TRUST_MODEL.md` bu belgenin her maddesine karsi bir durum notu iceriyor; mainnet kontrol listesi (Bolum 14) doldurulmus veya bilincli olarak "henuz mainnet yok" karari kayitli.

Sertlestirme bir varis noktasi degil, bir aliskanliktir. Bu belgenin gercek "bitti" hali, buradaki maddelerin tukenmesi degil, self-audit dongusunun (Bolum 11) bu maddeleri **surekli** yeniden sinamasi, `findings[]`'in buyumeye devam etmesi ve hicbir maddenin "bir kere kanitlandi, artik dusunmeye gerek yok" muamelesi gormemesidir.
