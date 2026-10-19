# Everything SDK

These files are from the official Everything SDK (Everything 1.4.1.1032):

- https://www.voidtools.com/Everything-SDK.zip
- `Everything.h`, `Everything64.lib`, `Everything64.dll`

The header, license and this README are tracked in git. The SDK binaries
(`Everything64.lib`, `Everything64.dll`) are intentionally **not** committed
because the repository keeps only source code. Download the SDK zip and place
both files in this directory before building `native/bin/everything-search.exe`.

Dockwisp uses the SDK client DLL to query the locally running Everything
index for the full-disk file search mode. Everything itself must be installed
and running for queries to return results; if it is not, Dockwisp starts the
bundled portable Everything (see `native/portable/README.md`) or falls back to
its own common-folder index.

The SDK is distributed under the MIT license; see `License.txt`.
