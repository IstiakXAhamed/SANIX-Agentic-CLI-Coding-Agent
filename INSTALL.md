# SANIX Installation Guide

## 🖥️ Desktop App (Recommended)

### macOS (.dmg)

#### Quick Install

1. **Download** `SANIX-1.0.0-mac.dmg` from [Releases](https://github.com/istiak-ahamed/sanix/releases/latest)
2. **Open** the `.dmg` file
3. **Drag** SANIX to your Applications folder
4. **Right-click** SANIX → **Open** → **"Open anyway"** (first launch only)
5. Done! 🎉

#### Detailed Steps with Screenshots

**Step 1: Download**

Go to [https://github.com/istiak-ahamed/sanix/releases/latest](https://github.com/istiak-ahamed/sanix/releases/latest) and download `SANIX-1.0.0-mac.dmg`.

**Step 2: Open the DMG**

Double-click the downloaded `.dmg` file. A window will appear showing the SANIX icon and an Applications folder shortcut.

**Step 3: Install**

Drag the SANIX icon onto the Applications folder.

**Step 4: Bypass Gatekeeper (First Launch Only)**

Because SANIX is distributed without an Apple Developer certificate (to keep it free), macOS Gatekeeper will block the first launch. This is normal and safe. To bypass:

**Option A (Easiest — Right-Click Method):**
1. Open Finder → Go to Applications
2. **Right-click** (or Control-click) the SANIX app
3. Select **"Open"** from the context menu
4. A dialog will appear saying "SANIX is from an unidentified developer"
5. Click **"Open"**

**Option B (System Settings Method):**
1. Try to open SANIX normally (double-click)
2. You'll see "SANIX cannot be opened because it is from an unidentified developer"
3. Click **"OK"**
4. Open **System Settings** → **Privacy & Security**
5. Scroll down to the **Security** section
6. You'll see "SANIX was blocked from use because it is not from an identified developer"
7. Click **"Open Anyway"**
8. Enter your password if prompted
9. Click **"Open"** in the confirmation dialog

**Option C (Terminal Method):**
```bash
xattr -cr /Applications/SANIX.app
open /Applications/SANIX.app
```

> ⚠️ **After the first launch**, subsequent launches work normally — just double-click SANIX. No warning will appear again.

**Step 5: Enjoy!**

SANIX will open, auto-start the REST API server, and load the dashboard.

---

### Windows (.exe)

#### Quick Install

1. **Download** `SANIX-1.0.0-win.exe` from [Releases](https://github.com/istiak-ahamed/sanix/releases/latest)
2. **Run** the `.exe` file
3. Click **"More info"** → **"Run anyway"** (bypasses SmartScreen)
4. Follow the installer
5. Done! 🎉

#### Detailed Steps

**Step 1: Download**

Go to [https://github.com/istiak-ahamed/sanix/releases/latest](https://github.com/istiak-ahamed/sanix/releases/latest) and download `SANIX-1.0.0-win.exe`.

**Step 2: Run the Installer**

Double-click the downloaded `.exe` file.

**Step 3: Bypass SmartScreen (Windows 10/11)**

Windows SmartScreen will show "Windows protected your PC" because SANIX is not code-signed. This is normal and safe. To bypass:

1. Click **"More info"** (in the SmartScreen dialog)
2. Click **"Run anyway"**

> ⚠️ **Why?** Code signing certificates cost $200+/year. SANIX is free and open-source, so we distribute unsigned builds. The app is safe — you can verify by checking the [source code](https://github.com/istiak-ahamed/sanix).

**Step 4: Follow the Installer**

- Choose installation directory (default is fine)
- Check "Create desktop shortcut" (recommended)
- Check "Create Start Menu shortcut" (recommended)
- Click **Install**
- Wait for installation to complete
- Click **Finish** (SANIX will launch automatically)

**Step 5: Launch SANIX**

After installation, you can launch SANIX from:
- Desktop shortcut
- Start Menu → SANIX
- Or run `SANIX.exe` from the installation directory

#### Portable Version

Prefer no installation? Download `SANIX-1.0.0-portable.exe` — just run it, no install needed.

---

### Linux (AppImage)

```bash
# Download
wget https://github.com/istiak-ahamed/sanix/releases/latest/download/SANIX-1.0.0-linux.AppImage

# Make executable
chmod +x SANIX-1.0.0-linux.AppImage

# Run
./SANIX-1.0.0-linux.AppImage
```

For desktop integration (optional):
```bash
sudo apt install libappindicator1
```

---

## 📦 CLI Installation

### Option 1: One-Line Install

```bash
curl -fsSL https://sanix.dev/install.sh | bash
```

### Option 2: npm

```bash
npm install -g sanix
```

### Option 3: Build from Source

```bash
git clone https://github.com/istiak-ahamed/sanix.git
cd sanix
npm install
npm run build
npm link
```

### Verify

```bash
sanix --version      # Should print: 1.0.0
sanix --help         # Should show all commands
```

---

## 🚀 First Run Guide

After installing, run:

```bash
# 1. Onboarding wizard
sanix config init

# 2. Set an API key (any one)
export ANTHROPIC_API_KEY=sk-ant-...    # Claude
# OR
export OPENAI_API_KEY=sk-...           # GPT-4o
# OR use OAuth (browser-based)
sanix auth login google

# 3. Try it!
sanix ask "What can you do?"
sanix run "Add error handling to src/auth.ts"
sanix chat

# 4. Run a specialized agent
sanix agent list
sanix agent run security-sentinel "Scan for vulnerabilities"

# 5. Let UltraWorker handle everything
sanix agent run ultra-worker "Audit this entire codebase"
```

---

## 🔧 Troubleshooting

### macOS: "SANIX cannot be opened"

**Solution:** Right-click → Open → "Open anyway" (see [macOS guide](#macos-dmg) above)

### Windows: "Windows protected your PC"

**Solution:** Click "More info" → "Run anyway" (see [Windows guide](#windows-exe) above)

### "sanix: command not found"

```bash
# Restart terminal, or:
source ~/.bashrc    # Bash
source ~/.zshrc     # Zsh

# If still not found, re-link:
cd ~/.sanix/src && npm link
```

### Desktop app shows "Starting SANIX server..." forever

The app couldn't start the SANIX server. Fix:

```bash
# Install SANIX CLI first
curl -fsSL https://sanix.dev/install.sh | bash

# Then start the server manually
sanix serve

# Now restart the desktop app
```

### Need Help?

- 📖 [Full Documentation](https://github.com/istiak-ahamed/sanix#readme)
- 🐛 [Report Issues](https://github.com/istiak-ahamed/sanix/issues)
- 💬 [Discussions](https://github.com/istiak-ahamed/sanix/discussions)

---

**Created by Istiak Ahamed** · All rights reserved © 2026
