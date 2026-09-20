# gate2/web — Burn Ekranı + Taşıma Kanıtım (F6)

Gate 2.0’nın ayrı Vite uygulaması. `frontend/` ve `vercel.json` Gate 1.0
bölgesidir; bu uygulama onlara dokunmaz. Üretimde tek Vercel dağıtımının
`/gate2/` alt yolundan servis edilir (1.0 kökte, 2.0 `/gate2/`’de);
geliştirmede ayrı portta (5174) çalışır ve 1.0 dev sunucusu `/gate2`’yi
buraya proxy’ler — yani yerel deneyim Vercel’in birebir aynısıdır.

Görsel dil 1.0 ile aynıdır: ızgara duvar, cam kutucuklar, 1.0 / 2.0 anahtarı.
2.0 kutucuğuna basınca alttaki siyah bant bu sürümün konsolu olur (Burn,
Taşıma Kanıtım, Batarya, Biletlerim — tek ekran, sekme ile). 1.0 kutucuğu
dondurulmuş konsola döner.

## Çalıştırma

```
cd gate2/web
npm install
npm run dev        # http://localhost:5174/gate2/
                   # (1.0 konsolu açıksa: http://localhost:5173/gate2/)
```


## Dürüstlük kuralları (DIRECTIVE 2.0)

- Tüm sözleşme adresleri `deployments/testnet-2.0.json` makbuzundan okunur
  (`src/config.js`); elle kopyalanmış adres yoktur.
- Sahte veri yok: kayıt yoksa “kayıt yok”, router yoksa “router yok” yazar.
- Burn Ekranı şu an **bilinçli olarak bloke**: BurnRouter Sepolia’de kurulu
  değil (F2, Sepolia fonu bekliyor — Bolum 10 stop-raporu). StrKey doğrulaması
  ve USDC trustline kontrolü ise gerçek Horizon/RPC verisiyle **şimdi çalışır**.

## Sayfalar

- **Taşıma Kanıtım:** G… adresi (veya Freighter bağlantısı) için her iki canlı
  `gate_claim` dağıtımında `get_migration`, `proofs_of` → `get_proof`/`get_meta`/
  `owner_of` okumaları ve kampanya `claim_tier` (önce salt-okunur simülasyon,
  Freighter bağlıysa gerçek imzalı tx).
- **Burn Ekranı:** dürüst blokaj durumu + iki çalışan ön koşul (StrKey,
  trustline) + geri alınamazlık onayı (“BURN” yazmadan ve router olmadan buton
  asla açılmaz).

## Kanıt

`gate2/scripts/check-gate2-web.mjs` — gerçek headless tarayıcıda 10 kontrol:
canlı testnet RPC okumaları (kayıt yok ×2, 0 NFT ×2, claim_tier → Error #3
NoMigration), Horizon trustline (deployer’da USDC yok), StrKey geçerli/geçersiz,
BURN butonunun kapalı kalması, 0 başarısız istek. Koşum:

```
NODE_PATH=<repo>/node_modules node gate2/scripts/check-gate2-web.mjs
```
