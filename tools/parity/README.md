# The parity matrix

`matrix.toml` lists one configuration per MCU family and flashing path (WebFlash SPEC Appendix B, plus Kalico's INDX heater for the C++ rules): a minimal defconfig, the projects it applies to and why it is there. A row may also name `unless`, a list of Kconfig symbols (without `CONFIG_`): it then does not apply to a tree whose Kconfig defines any of them. `rp2040-usb-legacy` uses it for Klipper before v0.13.0, whose `MACH_RP2040` became a choice under `MACH_RPXXXX`: it builds the old layout (with `lib/rp2040/elf2uf2`) and is skipped on newer trees, which `rp2040-usb` covers. `make-check` and `parity` print such a row as skipped and pass when every row is skipped; the snapshot gate records it as not applying, as it does a row that sets a symbol the tree's Kconfig does not define. Two maintainer commands run over it, and `.github/workflows/ci.yml` runs both on every push to `dev`, `master` and `wf/**`.

## `webflash make-check`

Compares the build engine's make interpreter with GNU make and its Kconfig session with the project's own `olddefconfig.py`, row by row, on a source tree:

```bash
webflash make-check path/to/klipper --make make --gcc-dir /path/to/arm-gnu-toolchain/bin
```

For every row it loads the defconfig through the tree's kconfiglib, writes `.config`, checks it against what `lib/kconfiglib/olddefconfig.py` writes for the same defconfig, then runs real `make -n V=1 all` and the interpreter's dry run on an empty `out/` and prints a unified diff of the two command lists (after dropping make's own messages, reducing the make binary's path to `make` and collapsing whitespace). The exit code is 1 on any difference. `--row NAME` limits it to one row, `--config FILE` checks a configuration of your own, `--project` overrides the detection (Kalico by `src/extras`, Katapult by `src/canboot.h` or `src/flashcmd.c`). The rows come from `tools/parity/matrix.toml` of the checkout the package runs from, else of the current directory (an installed package, as in CI); `--matrix FILE` names another.

`--gcc-dir` only matters for the Makefiles' `cc-option` probe: Klipper probes the host `gcc` (its `CROSS_PREFIX` is set after `CFLAGS`), so the probe's answer depends on the machine, and the interpreter runs the same probe so the comparison tests the interpreter and not the compiler. On Windows, GNU make comes from `winget install ezwinports.make` (`--make` takes its path) and `sh` from Git for Windows must be on `PATH`.

## `webflash parity`

Builds every row with each toolchain and compares the results:

```bash
webflash parity path/to/klipper --toolchains gcc,clang-native,clang-native-nolto \
    --gcc-dir /path/to/arm-gnu-toolchain --clang-dir /path/to/ATfE --table parity.md --json parity.json
```

Toolchains: `gcc` (the Arm GNU Toolchain, the Makefiles' commands as they are), `clang-native` (Arm Toolchain for Embedded through the driver's translation, LTO on as upstream), `clang-native-nolto`, `wasm-node` and `wasm-node-nolto` (the WebAssembly release of `webflash-toolchain` run under Node with `--wasm-dir`, see below for `--wasm-mount`). The checks: the `klipper.dict` of every toolchain is identical to the first one's except `build_versions`; the vector table's stack pointer lies in RAM and is the same for every toolchain; the reset vector is a Thumb address inside flash; the flash image (the sections, as `objcopy` writes them) fits the `rom` region of the linker script; every UF2 writes inside that region only; no ELF uses the FPU where the `gcc` build does not (without a `gcc` build, where GCC's soft-float default would not): neither a `Tag_FP_arch` build attribute nor an FPU instruction, which the check counts with GNU `arm-none-eabi-objdump` from `--gcc-dir` or `PATH` (llvm-objdump misdecodes parts of the LTO ELFs; without GNU objdump only the attribute is checked, and lld's LTO output takes its attributes from one input, so it can miss code). The projects never enable the FPU, so such an instruction faults on the board; the driver gives every clang line `-mfloat-abi=soft`, GCC's default, for that reason. It prints a Markdown table (row, toolchain, text, data, bss, flash used and region size, the size difference against the first toolchain, dict identity, stack and reset vectors, FPU use) and exits 1 on any failure. `--out DIR` keeps every build's outputs for `webflash inspect` and the UF2 comparison.

## `webflash build` and `webflash inspect`

`webflash build TREE --config FILE --toolchain gcc|clang-native|wasm-node --toolchain-dir DIR [--wasm-mount PATH] [--version V] [-j N] [--lto on|off] [--out DIR]` builds one configuration natively and prints the memory table and the outputs. `webflash inspect FILE` prints an ELF's sizes, segments, sections, vector table and the dictionary beside it, or the segments of a `.bin`, `.hex` or `.uf2`.

`wasm-node` runs the same WebAssembly module and the same tool commands as the site, so its outputs are the browser build's to the byte. The one input that differs is where the tree is: the ELF's debug information records the compilation directory, the tree's path inside the WebAssembly instance. By default that is the tree's own path (a Windows drive as `/c/...`); the site mounts a snapshot at `/webflash/src/<project>/<sha>`, and `--wasm-mount` (on `build` and `parity`) puts the tree there too. A build of a tree extracted from a snapshot's bundles with `--wasm-mount /webflash/src/klipper/<sha>` and the snapshot's `describe` as `--version` gives the `.bin`, `.elf` and `.dict` the site gives for the same `.config`; without it, the `.bin` and `.dict` are the same and the `.elf` differs in that path only. In Git Bash, set `MSYS_NO_PATHCONV=1` so the path reaches `webflash` as written.

## Where the toolchains come from

- GNU make: `apt-get install make` on Ubuntu, `winget install ezwinports.make` on Windows.
- Arm GNU Toolchain: `apt-get install gcc-arm-none-eabi` on Ubuntu, or a release zip from Arm (`arm-gnu-toolchain-14.3.rel1-mingw-w64-x86_64-arm-none-eabi.zip`) unpacked anywhere outside the repository.
- Arm Toolchain for Embedded: the release `release-23.1.0-ATfE` from `github.com/arm/arm-toolchain` (the Linux tarball or the Windows zip), unpacked anywhere outside the repository. The engine uses its `armv6m_soft_nofp_size`, `armv7m_soft_nofp_unaligned_size` and `armv8m.main_soft_nofp_unaligned_size` libraries, the same three the WebAssembly release ships.
- The WebAssembly release: `toolchain.tar` from `github.com/xbst/webflash-toolchain` releases, unpacked to a folder with `manifest.json`, for `wasm-node` (needs Node 20 or newer).
