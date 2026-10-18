# Windows installer qualification

The `Windows installer lifecycle` job in `native-parity.yml` builds the current
frontend and both Tauri Windows installers with the locked Rust dependency graph.
It needs no signing secret and publishes no release. The job installs each
package in a unique runner-temporary directory whose name contains spaces.

`scripts/check-windows-installers.py` requires a disposable GitHub-hosted Windows
runner and refuses a pre-existing product registration. For both NSIS and MSI,
it checks the registered version and install location, compares the installed
executable with the locally built executable, invokes the normal uninstaller,
and waits for both product registration and the install directory to disappear.
The receipt and MSI logs are uploaded even when a later check fails. Cleanup
retries the normal uninstaller after a failed check and removes only the unique
temporary harness directory; cleanup never changes a failed result to a pass.

This qualifies fresh installation and removal of the raw Windows installers.
It does not claim upgrade-path, application playback, Authenticode, or SmartScreen
acceptance. Existing release and playback gates remain separate.

The invocation rules follow the [NSIS command-line documentation](https://nsis.sourceforge.io/Docs/Chapter3.html)
and [Microsoft's msiexec documentation](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/msiexec).
The portable guard tests run with `python tests/test_windows_installers.py`.
