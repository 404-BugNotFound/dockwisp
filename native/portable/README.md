# Portable Everything assets

`Everything.exe` and `Everything.lng` are third-party binaries from Everything
1.4.1.1032 (x64, [voidtools](https://www.voidtools.com/)). They are used as the
fallback when no installed Everything is available.

They are intentionally **not committed** to this repository: the repository
keeps source code only and build/release binaries are published separately.

To build or run the portable fallback, place these files here:

- `Everything.exe`
- `Everything.lng`

You can copy them from an existing Everything installation or download the
portable Everything package. `License.txt` is included. The Everything SDK
client files live in `native/sdk/` and follow the same rule.
