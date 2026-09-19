# The interface, as pictures

A note about why this folder exists, because its absence was the actual defect.
The round that changed the strips, the frame and the disabled-button reasons
shipped its code, its checks and its prose — and screenshots lived in a scratch
directory outside the repository. From inside the repository, "we changed the
design" was a sentence you had to take on trust, which is exactly the kind of
claim this project refuses everywhere else. If a value on screen has to come
from somewhere checkable, so does a change to the screen.

Every image here was taken by driving the real page in a real browser
(`tools/check-live-page.js` and `tools/check-live-actions.js` do the same, as
checks rather than snapshots). Pair images are two builds of the *same commit
range*, one column each, so the difference is visible rather than argued:

| File | What it shows |
|---|---|
| `01-hero-before-after.png` | Left: `270f7f7` — the retired banner, and a section painted as one black block. Right: the operator's own 1500×500 file, byte for byte, with the text on line strips. |
| `02-strips-before-after.png` | The same correction where it matters: left, the evidence section is one block that covers the artwork; right, every text row carries its own full-bleed strip and the lattice stays visible in the gaps between them. |
| `03-live-hero.png` | The deployed console (`migrate-to-stellar.vercel.app`), loading state already past: network pill green on a live ledger. |
| `04-live-disabled-controls.png` | The wallet, live, with the lock button disabled *and its reason written underneath it*. Before this round that button was grey with nothing anywhere saying why. |
| `05-pointer-frame.png` | The 4 screen pixel frame on the cube under the pointer, at 2× so the ring is measurable: the frame had been a `:hover` on an element painted behind the page, so it had never once appeared on the live page. |

To reproduce any of them:

```bash
npm i puppeteer --no-save        # a browser, without touching package.json
node tools/api-dev-server.js &
cd frontend && npx vite --host 0.0.0.0 --port 5173 &
cd .. && node tools/check-live-page.js            # the strips, the frame, the banner
node tools/check-live-actions.js                  # every control, clicked
node tools/check-live-page.js https://migrate-to-stellar.vercel.app/   # or the live one
```

These are images, not tests. The tests are the two tools above, and they fail
the round when the page stops behaving the way these pictures show it behaving.
