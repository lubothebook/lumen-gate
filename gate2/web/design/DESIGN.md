# Gate 2.0 tasarım dili

Gate 1.0 dondurulmuştur (`frontend/` dokunulmaz). 2.0 aynı görsel sözleşmeyi
`gate2/web` içinde yeniden kurar: iki kapı, tek yüzey.

## Sürüm anahtarı

Hero’daki 1.0 / 2.0 kutucukları 1.0’daki `track-box` ile aynı geometridir.

- **1.0** → `/` (settlement-boundary konsolu)
- **2.0** → bu sayfa; tıklanınca alttaki siyah bant (`#console`) bu sürümün
  çalışma alanı olur. Ayrı bir siteye gidilmez.

Burn, Taşıma Kanıtım, Batarya ve Biletlerim, 1.0’daki Receive / Send / Cash out
sekmeleri gibi **tek kartın içinde** değişir.

## Belirteçler

1.0 ile birebir: zemin `#050604`, mürekkep `#f7f8f6`, kart yarıçapı 22px,
cam katman, ızgara 60px piksel kiremit, pill düğmeler, segmented tabs.

Açık tema `prefers-color-scheme: light` ile desteklenir; ızgara soluklaşır.
Birincil ölçü 390×844.

## Dürüstlük

- TESTNET bandı her ekranda.
- BurnRouter yoksa yakma uydurulmaz.
- Batarya (F5) ve Bilet (F6) kontratları yoksa ekran “yok” der.
- Yasak iddia yok: trustless, risksiz, otomatik, XLM’siz, 1:1 (swap dışı).
- Bilet: hamiline yazılı; Circle dondurabilir.
- Batarya: ağ ücretini relayer XLM ile öder, karşılığı Bataryadan USDC ile alınır.

## Sahiplik

Ekran ve metin: DQ / `gate2/web`. Zincir çağrıları mevcut `stellar.js` üzerinden;
`chain-port.ts` henüz yok, kontrat arayüzü bu turda değişmedi.
