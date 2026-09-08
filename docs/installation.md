# Install Son of Anton IDE

Download an IDE installer from [GitHub Releases](https://github.com/CodeHalwell/Son-Of-Anton/releases). IDE releases use the `ide-v` prefix. Releases with the `sota-v` prefix contain the standalone command-line tool.

| Computer | Download | Installation |
| --- | --- | --- |
| Mac with Apple silicon | `darwin-arm64.dmg` | Open the disk image and drag **Son of Anton IDE** to Applications. |
| Mac with Intel processor | `darwin-x64.dmg` | Open the disk image and drag **Son of Anton IDE** to Applications. |
| Windows x64 | `win32-x64-setup.exe` | Run the per-user installer. An administrator account is not required for installation into your user profile. |
| Ubuntu 22.04 or later / compatible Debian x64 | `linux-x64.deb` | Run `sudo apt install ./son-of-anton-<version>-linux-x64.deb`. |

Filenames include the version before the platform. Portable `.zip` archives are available for macOS and Windows; Linux has a `.tar.gz` archive. Extract the entire archive before launching. Linux portable installations need the runtime libraries listed by the Debian package and a supported Chromium sandbox configuration.

## Verify a download

Download `SHA256SUMS.txt` from the same release. In the download directory, use `shasum -a 256 <filename>` on macOS, `sha256sum <filename>` on Linux, or `Get-FileHash <filename> -Algorithm SHA256` in PowerShell. Compare the complete hash with its entry in `SHA256SUMS.txt`.

Build provenance is attached by GitHub Actions. With GitHub CLI installed, verify an asset with `gh attestation verify <filename> --repo CodeHalwell/Son-Of-Anton`. The release's `build-manifest.json` records the source commit, native platform, asset sizes, checksums and signing state. Native installation reports are included separately.

Development releases can be unsigned on Windows and ad-hoc signed on macOS. Those builds have not established a publisher identity with Windows or Apple and may be blocked by operating-system checks. Signing status is stated in the release notes. Production releases should require signing and notarization using the workflow option. Do not disable system-wide security controls to install a build.

## First launch

Open a project, open **Anton: Open Setup Wizard** from the command palette, and sign into the providers you want to use. The IDE includes the Son of Anton extension, agent prompts, chat and task-board assets, and the native code-graph service. Structural indexing runs locally without Docker. Semantic search requires a configured embedding provider. External agents, including Gemini, use their own sign-in and installation configuration; credentials are not part of the installer.

Workspace trust and tool permissions remain explicit. Opening the IDE does not authorize agents to execute project code. The setup wizard can discover installed skills, plugins and MCP configurations; discovery does not grant those servers execution permission.

## Update or recover

Close the IDE before updating. Install a newer release using the same installer and destination. On macOS replace the application in Applications; on Windows rerun the per-user setup; on Linux install the newer `.deb` using `apt`. User settings, conversations and extensions live outside the application directory and are retained. The upstream VS Code update service is not used for these GitHub releases; updates are currently installed manually.

Keep the previous installer while evaluating an update. If the application fails to start, close it and reinstall that previous release. Back up your user data before downgrading: older versions may not understand data written by newer versions. A fresh temporary profile (`--user-data-dir <empty-directory>`) can distinguish a profile problem from an installation problem without deleting your existing profile. Agent changes are reviewed and restored through proposal checkpoints; reinstalling the application does not undo project files.

## Build and release with GitHub Actions

Open [Build and install Son of Anton IDE](https://github.com/CodeHalwell/Son-Of-Anton/actions/workflows/ide-distribution.yml). **Run workflow** builds native macOS arm64, macOS x64, Windows x64 and Linux x64 installers, tests installation and activation, and keeps the verified downloads as Actions artifacts for 14 days.

Select **Create a draft GitHub release** to stage a release after every platform passes. The tag is `ide-v` followed by the root `package.json` version. A new `ide-v*` tag push also runs this pipeline. Tags that already have a release skip rebuilding, including the tag created when a draft is published. Existing releases are never overwritten, and a tag pointing at another commit is rejected. Review the draft's installation reports and signing status, then publish it to make the downloads visible on the repository's Releases page. Pull requests can build and test artifacts but cannot publish releases.

Configure repository secrets for signed production builds:

- macOS: `MACOS_SIGNING_CERT_P12` (base64 Developer ID certificate), `MACOS_SIGNING_CERT_PASSWORD`, `MACOS_SIGNING_IDENTITY`, `MACOS_NOTARY_KEY_BASE64`, `MACOS_NOTARY_KEY_ID`, `MACOS_NOTARY_KEY_ISSUER`.
- Windows: `WINDOWS_SIGNING_CERT_BASE64` (base64 PFX), `WINDOWS_SIGNING_PASSWORD`.

Temporary certificates and macOS keychains are removed after signing. Incomplete signing configurations fail the job. Enable **Require signing** to reject unsigned development builds. The repository needs Actions enabled and workflow permissions that allow the release job to write repository contents and build attestations. No provider API keys are needed for packaging or the offline installation checks.
