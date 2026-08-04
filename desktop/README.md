# Claude Code Haha Desktop

基于 Tauri 2 + React 的桌面客户端。

## 开发

```bash
bun install
bun run tauri dev
```

## 构建

```bash
# macOS (Apple Silicon)
./scripts/build-macos-arm64.sh

# Windows (x64, MSI only)
.\scripts\build-windows-x64.ps1
```

构建产物位于 `build-artifacts/` 目录，文件名会显式包含平台、架构和包类型。

本地 macOS 构建默认使用独立的 Bundle ID `com.claude-code-haha.desktop.local`，避免与 `/Applications` 中的正式版争用系统隐私授权。若钥匙串中存在 `cc-haha-codesign`，构建脚本会自动用它稳定签名；也可通过 `LOCAL_MACOS_APP_ID` 和 `LOCAL_CODESIGN_IDENTITY` 覆盖。

## 常见问题

### macOS 提示"已损坏，无法打开"

```bash
xattr -cr /Applications/Claude\ Code\ Haha.app
```
