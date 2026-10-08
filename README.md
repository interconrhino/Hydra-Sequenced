# Hydra-Sequenced

**Unofficial** browser patcher that adds a step sequencer to the Hydrasynth Explorer (firmware 2.2.0).

**Website and patcher:** https://interconrhino.github.io/Hydra-Sequenced/

> Not made, endorsed or supported by Ashun Sound Machines (ASM). Use at your own risk. See [Disclaimer](#disclaimer).

## Why

I built this for my own Explorer and use it there; every release is tested on my own unit. I'm sharing it so others can enjoy a better standalone Hydrasynth, with no computer needed.

## Features

- **16 savable phrases, 64 steps.** Chords per step. Separate from patches, saved on the synth.
- **Step recording.** One key or chord per step; length is set when you stop.
- **Per-step control.** Note, velocity, length, rest, tie and ratchet (×2 / ×4 / ×8).
- **Trig conditions.** Probability, A:B, 1ST and !1ST, with a live play/skip indicator and cycle counter.
- **Euclidean generator.** Steps, hits, rotation. Live preview, then apply or cancel.
- **Phrase lock.** Phrase and arp settings stay put while you browse patches. Patches are never changed.
- **Randomiser.** Variations from the phrase's own notes, for the whole phrase or one step.

Everything is edited from the panel. No computer is needed after flashing.

## How it works

ASM's firmware is not included or hosted here. The patcher runs in your browser:

1. You load the official Explorer 2.2.0 `.dat` from ASM.
2. The patcher checks its SHA-256 against the official file.
3. It adds the sequencer locally and verifies the result byte for byte against the tested build.
4. You download the patched `.dat`.

Nothing is uploaded.

## Install

1. Get **Hydrasynth Explorer firmware 2.2.0** from [ASM](https://www.ashunsoundmachines.com/) and unzip it.
2. Open the [patcher](https://interconrhino.github.io/Hydra-Sequenced/download.html), load `Hydrasynth_Explorer_Firmware_2.2.0.dat` and build.
3. Flash with ASM Manager:
   1. Back up your patches.
   2. Explorer off, connected over USB.
   3. Hold **ARP ON** + **LATCH** while switching it on (update mode).
   4. In ASM Manager, update firmware from a local file and load the patched `.dat`.
   5. Don't disconnect until it finishes, then restart.
4. **Shift + Triplet** opens the sequencer.

**Back to stock:** flash ASM's original 2.2.0 file the same way.

## Compatibility

- **Hydrasynth Explorer, firmware 2.2.0 only.**
- Not for the Hydrasynth Keyboard, Deluxe, or other firmware versions. The patcher refuses any other file.

## Testing

- Each build runs in an emulator from power-on and is compared against the stock firmware.
- With the sequencer unused, MIDI output and saved data match stock.
- New code goes only into firmware areas proven unused; every hook is checked.
- Each release is audited independently, then tested on hardware.

## Known limitations

- Notes stop on a patch change, as on the stock firmware. Retrigger to continue a locked phrase.
- Mono and unison patches play chord steps as single notes.
- Leaving Compare with unsaved edits can drop the lock's arp values.

## Disclaimer

Hydra-Sequenced is an independent hobby project. It is not made, endorsed, supported or approved by Ashun Sound Machines (ASM). Hydrasynth is a trademark of its owner and is used here only to describe compatibility.

The patcher and any firmware it produces are provided **"as is", without warranty of any kind**. Modifying your instrument's firmware may void its warranty and may cause malfunction, loss of data or damage to the device. You use this project **entirely at your own risk**. To the maximum extent permitted by law, the authors and contributors are not liable for any damages arising from its use.

This repository does not host or distribute ASM's firmware. You obtain it from ASM yourself and are responsible for complying with ASM's terms.

## License

[MIT](LICENSE). It covers this repository's contents only, not ASM's firmware.
