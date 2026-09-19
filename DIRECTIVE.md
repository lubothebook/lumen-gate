# Trust Stellar, Move to Stellar: Kalici Direktif

## 0. Bu belgenin rolu (protokol, ilk once oku)

- Bu belge bu proje icin tek yetkili direktif kaynagidir.
- Repo icinde ikinci bir "ana direktif" dosyasi tutulmaz. `DIRECTIVE.md` ve
  `MIGRATE_TO_STELLAR_COMPLETE_DIRECTIVE.md` bu belgenin icerigiyle birlestirilip
  kaldirilir; ikisi de bu belgeyle celisen ayri bir kaynak olarak kalmaz.
- Her calisma oturumunun basinda once bu belge okunur, ozellikle Bolum 3 (Durum).
  Oturum sonunda Bolum 3 guncellenir. Zaten yapilmis is yeniden sifirdan tasarlanmaz
  ya da yeniden adlandirilmaz; uzerine insa edilir.
- Proje adi sabittir: **Trust Stellar, Move to Stellar**. README basligi, repo
  aciklamasi, UI basligi, vercel deploy adi dahil her yerde bu isim kullanilir.
  Su an repo "Migrate to Stellar" adini kullaniyor, bu degistirilecek (bkz Bolum 3).
- "Budlum" kelimesi (ya da acik/ortuk hicbir turevi) hicbir dosyada gecmez. Bu kural
  buyuk olcude uygulanmis gorunuyor (ornek: "no forbidden word in code" notu), korunacak.

## 1. Amac ve iki temel iddia

Uygulamanin var olma sebebi iki iddiayi gercek ve canli sekilde kanitlamak:

1. **Makine onayli kopru**: mint karari hicbir insan imzasina/multisig'e degil,
   yalnizca on-chain dogrulanan kriptografik kanita (BLS esik imzasi ve/veya
   Groth16 ZK kaniti) dayanir.
2. **Gassiz kullanici**: Stellar'da hic XLM'i olmayan biri, ucreti kaynak
   zincirdeki kilitlemeden karsilanarak varligi alabilir.

Her iki iddia da submission oncesi canli ve sahte olmayan sekilde gosterilebilmeli.
Bir iddia demoda gosterilemiyorsa, README'den o cumle cikarilir; calismayan bir
ozellik calisiyormus gibi yazilmaz.

## 2. Mevcut mimari (korunacak, sifirdan yeniden yazilmayacak)

Asagidaki parcalar repoda zaten var ve calisir durumda gorunuyor:

- Soroban kontratlari: `finality_registry` (BLS + Groth16 + `verify_via_zkvm`
  alias, domain registry, `DomainProfile` skor yok sadece gercekler) ve
  `settlement_gateway` (HWM + Merkle + `FeeConfig` + `finalize_inbound_gasless`
  + `finalize_inbound_sponsored`).
- Kanit yollari: BLS12-381 (Protocol 22 CAP-0059 native host'lar,
  `submit_finality_evidence_bls` ve tam pairing yapan `submit_bls_hardened`),
  Groth16/BN254 (Protocol 25 `bn254_multi_pairing_check`, 768B VK, 256B proof).
- Off-chain: `source_simulator` (gercek BLS aggregate, binary Merkle, ucret
  dahil kilitleme), `relayer` (gercek RPC `getLatestLedger`/`simulateTransaction`),
  `frontend` (Freighter, 7 panel), `anchor` facade (`stellar.toml`, `/info`,
  `/health`, SEP-6).
- 11 test geciyor (`finality_registry` 5, `settlement_gateway` 6), fault-probe'lar
  var (zeroed sig, root mismatch, version 99, replay).

Bu liste dogruysa bir sonraki oturum bunlari yeniden yazmaz, sadece Bolum 4'teki
sertlestirme maddelerini uygular.

## 3. Durum (her oturum sonunda guncellenecek)

### Yapildi
- [x] BLS12-381 dogrulama yolu, native host'larla, tam pairing dahil
- [x] Groth16/BN254 dogrulama yolu, native pairing ile
- [x] HWM + Merkle replay korumasi
- [x] Gassiz/sponsored mint yolu (test ortaminda)
- [x] Frontend + Freighter + relayer + anchor facade uctan uca bagli
- [x] "Budlum" kelimesi kod tabaninda gecmiyor (submission oncesi tekrar grep ile dogrulanacak)

### Henuz yapilmadi / sertlestirilmeli
- [ ] Proje adi her yerde "Trust Stellar, Move to Stellar" olarak degistirilmeli
      (su an "Migrate to Stellar")
- [ ] `finality_registry` uzerindeki `admin` yetkisi (`set_vk`, `register_domain`,
      `admit_domain`) sertlestirilmeli, bkz Bolum 4.1
- [ ] Sifir-XLM iddiasi gercek, hic fonlanmamis taze bir keypair ile canli
      kanitlanmali, bkz Bolum 4.2
- [ ] Validator anahtarlari (`sk=1,2,3`) test amacli oldugu README'de acikca
      isaretlenmeli, uretim yol haritasina tasinmali
- [ ] Repo'daki iki ayri direktif dosyasi (`DIRECTIVE.md`,
      `MIGRATE_TO_STELLAR_COMPLETE_DIRECTIVE.md`) bu belgeyle birlestirilip kaldirilmali
- [ ] README'deki Raven istatistikleri dogrulanmali, bkz Bolum 4.4

## 4. Sertlestirme maddeleri (bu turda oncelik)

### 4.1 Admin/VK guven acigi (en kritik mimari bulgu)

`finality_registry.set_vk` ve `register_domain`/`admit_domain` bir `admin`
hesabina bagliysa, o admin anahtarini kontrol eden kisi dogrulama anahtarini
degistirip sahte kanitlari gecirebilir ya da kotu niyetli bir domain'i
onaylayabilir. Bu, "insan onayi yok" iddiasini dogrudan curutur, cunku hala
tek bir insan anahtari sistemin guvenliginin kokunde duruyor.

Sertlestir:
- `admin`'i yalnizca kurulus/deploy aninda tek seferlik bootstrap rolu olarak sinirla.
- VK ve domain kaydi ayarlandiktan sonra `renounce_admin()` gibi bir fonksiyonla
  admin yetkisini kalici olarak sifirla.
- README'nin tehdit modeli tablosuna "Admin key compromise" satiri ve mitigasyonu ekle.

Bu madde demoda gorunur olmali: "admin renounced, tx hash: ..." gibi kanitlanabilir
bir adim.

### 4.2 Gercek sifir-XLM kaniti

Su an "recipient gets amount even with 0 XLM (in test env works)" deniyor ama
bunun gercekten taze, hic fonlanmamis bir keypair ile mi yoksa onceden friendbot
ile fonlanmis bir test hesabiyla mi gosterildigi belirsiz.

Demoda: yeni bir Stellar keypair uret, hic friendbot cagirma, dogrudan
`finalize_inbound_gasless` ile mint dene, basarili oldugunu goster. Olmuyorsa
sponsorship/claimable balance yolu (CAP-33) gercekten devreye alinmali, roadmap'te
birakilmamali. Bu iddia demo edilemezse README'den "even with 0 XLM" cumlesi
kaldirilmali ya da kosullari netlestirilmeli.

### 4.3 Fault-probe'lari genislet

Mevcut 4 probe (zeroed sig, root mismatch, version 99, replay) iyi bir baslangic.
Ekle: yanlis VK ile uretilmis sahte Groth16 proof reddi, admin olmayan birinin
`set_vk` cagirmaya calismasi reddi (4.1 uygulanirsa zaten imkansiz olur, o zaman
"renounce sonrasi hic kimse cagiramiyor" testi).

### 4.4 Raven istatistiklerini dogrula

README'deki "920+ projects, 20 playbooks" rakamlari, raven.stellar.org'un resmi
sayfasindaki guncel rakamlarla (276 katalog girdisi, 18 playbook, 54 canli
operasyon) eslesmiyor. Submission oncesi bu rakamlari canli sayfadan tekrar
kontrol et ve dogru olanlari yaz; yanlis istatistik iceren bir "verified" rozeti
hakemler tarafindan kolayca yakalanir ve guvenilirligi zedeler.

## 5. Gassiz akis: netlestirilmis tasarim (referans, yeniden turetilmesin)

- Kullanici kaynak zincirde `amount = istenen + ucret` kilitler.
- Kanit (BLS ya da ZK) uretilir, `finality_registry`'de dogrulanir (makine onayi).
- `relayer`, Stellar islem ucretini oder, `finalize_inbound_gasless` cagirir.
- Alici `istenen` miktari alir, `relayer` ucreti alir, `RelayerReward` izlenir.
- Alicinin onceden trustline/rezerv/XLM'i olmasi gerekmiyor (Bolum 4.2'de kanitlanacak).

Bu akis zaten dogru tasarlanmis; degistirilmez, sadece 4.2'deki gibi gercekten
kanitlanir.

## 6. Kalici kontrol listesi (her submission oncesi)

- [ ] Repo genelinde "Budlum" grep taramasi bos donuyor
- [ ] Proje adi her yerde "Trust Stellar, Move to Stellar"
- [ ] Tek direktif dosyasi var (bu belge), digerleri kaldirildi
- [ ] Admin renounce adimi yapilmis ve kanitlanmis
- [ ] Sifir-XLM akisi taze keypair ile canli test edilmis
- [ ] README'de gercekte calismayan hicbir iddia yok (Raven rozeti dahil,
      rakamlar dogrulanmis)
- [ ] `cargo test` tum testler geciyor, sayi README ile esleşiyor

## 7. Hackathon uyum notu (hatirlatma)

Genesis parkuru gercek Stellar entegrasyonu ve calisan urun istiyor, bu repo
bu sarti zaten karsiliyor. "Sifirdan baslama" cercevesiyle ilgili durust anlatim
notu hala gecerli: sunumda "onceden bildigimiz bir tasarim kalibini Stellar'a
ozgu olarak sifirdan uyguladik" de.
