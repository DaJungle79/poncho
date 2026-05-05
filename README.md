# Poncho

*A handcrafted Nintendo Entertainment System emulator, written in TypeScript, played in your browser.*

---

## Hello there

Sometimes you just want to play a game from when you were a kid. Maybe Castlevania. Maybe Contra. Maybe Metroid. The cartridge is in a box somewhere and the console hasn't been plugged in for a decade, and *you don't feel like setting it all up.*

That's what Poncho is for.

It's also for the kind of person who, halfway through their tenth nostalgic playthrough, started wondering how the NES *actually worked* — and decided the best way to find out was to build one.

So here we are. About 7,000 lines of TypeScript, no game-specific hacks, every chip built from the documented hardware. Open a webpage. Drop a `.nes` file in. Press Start.

## Get started

```bash
git clone https://github.com/DaJungle79/poncho.git
cd poncho
npm install
npm run dev
```

Open <http://localhost:5173>. Drop your `.nes` files into the `roms/` folder and they'll appear in the dropdown — or use the file input directly. (Poncho doesn't ship any games. Bring your own.)

## What plays

Six cartridge mappers, covering ~85% of the commercial library:

| Mapper | Games it plays |
|---|---|
| **NROM** (0)   | Super Mario Bros., Donkey Kong, Galaga, Ice Climber |
| **MMC1** (1)   | The Legend of Zelda, Metroid, Final Fantasy, Dragon Warrior |
| **UxROM** (2)  | Castlevania, Mega Man, Contra, Duck Tales |
| **CNROM** (3)  | Adventure Island, Solomon's Key, Ghosts'n Goblins |
| **MMC3** (4)   | Super Mario Bros. 3, Mega Man 3-6, Kirby's Adventure, Crystalis |
| **AxROM** (7)  | Battletoads, Marble Madness, RC Pro-Am |

All five APU sound channels are wired up — pulse × 2, triangle, noise, and DMC — feeding a non-linear mixer through the canonical 90 Hz / 440 Hz / 14 kHz analog filter chain. It sounds like the NES because it's modelled to sound like the NES.

Default controls:

```
   ↑ ↓ ← →     D-pad
       Z       B
       X       A
       C       Select
       V       Start
```

## Look under the hood

The architecture is documented in [`CLAUDE.md`](CLAUDE.md) — written for whoever's reading the code (Claude Code or otherwise). The interesting bits live in:

| Module | What's there |
|---|---|
| `src/core/cpu/` | per-cycle 2A03 (6502 minus decimal mode), all 151 official + 25 illegal opcodes |
| `src/core/ppu/` | 2C02 scanline pipeline, background + sprite shifters, sprite-0 hit |
| `src/core/apu/` | frame counter, 4 channels + DMC, non-linear mixer, RC filters |
| `src/core/mappers/` | six cartridge mapper chips, runtime mirroring, MMC3 IRQ counter |
| `src/renderer/` | Filter and Scaler pipelines, kept separate so CRT/NTSC effects can plug in later |

If you'd rather skip ahead and read about *what's still missing*, that's all in [`DEFERRED.md`](DEFERRED.md) — every known gap explained with *what*, *why deferred*, and *how a fix would be verified*.

## Testing

```bash
npm test
```

194 tests across 27 files. About a hundred are pure unit tests — CPU instructions and addressing modes, channel envelopes and length counters, mapper bank logic, scaler arithmetic. The rest run real ROMs:

| Suite | Pass | Total |
|---|---|---|
| nestest (CPU full) | 1 | 1 |
| blargg `apu_mixer` | 4 | 4 |
| blargg `oam_*` | 2 | 3 |
| blargg `apu_test` | 3 | 8 |
| blargg `ppu_vbl_nmi` | 1 | 10 |
| blargg `sprite_overflow` | 2 | 5 |
| blargg `sprite_hit_tests` | 1 | 11 |

The remaining synthetic-timing failures share a single architectural gap (sub-cycle bus alignment) — see [DEFERRED.md](DEFERRED.md) for the unified explanation. Real games of every supported mapper render and play.

Test ROMs are gitignored. Drop them in `tests/roms/`; the suite skips gracefully when files are absent.

## Where it goes from here

Everything that's still missing or imperfect is logged in [`DEFERRED.md`](DEFERRED.md), categorized and explained. Pull requests are welcome — whether that's a new mapper, a tightened timing path, save state persistence, or a CRT post-processing filter.

## Thank you

This wouldn't exist without:

- **blargg**, for the canonical NES test ROM suites that turn an opaque hardware spec into something debuggable
- **the nesdev community**, for documentation that's somehow free *and* meticulous
- **christopherpow**, for hosting clean GitHub mirrors of the test ROMs
- **everyone who's reverse-engineered the 2A03 and 2C02** since the early 2000s

## License

GPL-3.0-or-later. See [`LICENSE`](LICENSE) for the full text. In short: do what you like with this code; if you ship modifications, ship the source too.

---

*— Ivailo Ivanov*
