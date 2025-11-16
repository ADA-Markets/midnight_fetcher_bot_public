# Midnight Fetcher Bot

APPLICATION BROUGHT TO YOU BY PADDY https://x.com/PoolShamrock AND PAUL https://x.com/cwpaulm

Windows-based NextJS application for user-friendly Midnight mining. Generate wallets, manage 1+X addresses, and mine with an intuitive web interface.

When the app starts, it can keep around 10 minutes for things to fully get going. As the registration of addresses can take quite some time as they are registering in the API that has rate limiting, luckily this is a one time thing.

This app is very much in early stages and bugs will appear!

Also note this was built very quickly and possibly has many bugs. 

WE TAKE ZEROOO RESPONSIBILITY FOR THIS SO USE IT AT YOUR OWN RISK.

## Features

- 🔐 **Easy Wallet Creation** - Generate 24-word seed phrase with one click
- 💼 **200 Mining Addresses** - Auto-generate and register addresses
- 🖥️ **User-Friendly UI** - Modern web interface with real-time updates
- ⚡ **Native Performance** - Rust-based hashing for maximum speed
- 🪟 **Windows Optimized** - One-click setup script for Windows
- 📊 **Live Dashboard** - Real-time mining statistics and solution tracking

## Development Fee

This software includes a small development fee to support ongoing maintenance and improvements, If you dont like that remove it:
- **1 solution per 17 user solutions** is mined for the developers
- This is **not a fee on your rewards** - you keep all your mined solutions
- The miner simply finds one additional solution for a developer address after every 10 solutions for your addresses
- Completely transparent - dev fee solutions are clearly logged and marked separately
- Can be disabled by setting `DEV_FEE_ENABLED=false` in your `.env` file

## Quick Start

### Windows Installation

**Prerequisites:**
- Windows 10/11
- Internet connection

**Steps:**

1. **Download** this repository (or clone with git)

2. **Run Setup** - Double-click `setup.cmd` or open Command Prompt and run:
   ```cmd
   setup.cmd
   ```

3. The setup script will:
   - ✅ Check/install Node.js 20.x
   - ✅ Verify pre-built hash server
   - ✅ Install all dependencies
   - ✅ Build the application
   - ✅ Open your browser and start the app

4. **Access the app** at `http://localhost:3001`

### Ubuntu/Linux Server Installation

**Prerequisites:**
- Ubuntu 20.04+ (or compatible Linux distribution)
- SSH access with sudo privileges
- Internet connection

**Steps:**

1. **Download and extract** the repository:
   ```bash
   wget https://github.com/ADA-Markets/midnight_fetcher_bot_public/archive/main.zip
   unzip main.zip
   cd midnight_fetcher_bot_public
   ```

2. **Run initial setup** (first time only):
   ```bash
   chmod +x setup.sh
   ./setup.sh
   ```

   The setup script will:
   - ✅ Install Node.js 20.x
   - ✅ Install build tools (gcc, g++, make)
   - ✅ Install Rust toolchain
   - ✅ Build optimized hash server (+15-38% performance vs standard build)
   - ✅ Install dependencies
   - ✅ Start services in background
   - ✅ Exit automatically (services keep running)

3. **Access the web dashboard immediately:**
   ```
   http://YOUR_SERVER_IP:3001
   ```

   Services are running in the background - no need to press Ctrl+C!

4. **Manage services** (after initial setup):
   ```bash
   ./start.sh        # Start services (auto-detects CPU cores)
   ./start.sh 16     # Start with 16 worker threads
   ./stop.sh         # Stop all services
   ./status.sh       # Check if services are running
   ./logs.sh         # View live logs
   ```

   **CPU Thread Configuration:** Scripts auto-detect CPU cores by default (max 32).
   Override with: `./start.sh 24` or `WORKERS=24 ./start.sh`

### macOS Installation

1. **Download** this repository (or clone with git)

2. **Run initial setup** (first time only):
  
   Find out how many cores your Mac has by running:
   ```bash
   sysctl -n hw.ncpu
   ```

   Then run (replace `<number_of_cores>` with your core count or less):
   ```bash
   chmod +x setup.sh
   ./setup.sh WORKERS=<number_of_cores>
   ```

4. **Access the app** at `http://localhost:3001`

5. See Step 4 of the [Linux Installation instructions](#ubuntulinux-server-installation) for 
   managing the services.
   
**Firewall Configuration** (if needed):
```bash
sudo ufw allow 3001/tcp
sudo ufw reload
```

## Usage

Run: `setup.cmd`

On completion, open your browser and go to:

http://localhost:3001

### First Time Setup

1. **Create Wallet**
   - Click "Create New Wallet"
   - Enter a strong password (min. 8 characters)
   - **IMPORTANT**: Write down your 24-word seed phrase
   - Store it safely offline (paper, secure vault)
   - ⚠️ Without this seed phrase, you cannot recover your wallet!

2. **Start Mining**
   - The app will automatically generate 200 mining addresses
   - Register all addresses (this happens automatically)
   - Click "Start Mining"
   - Monitor your progress on the dashboard

### Returning Users

1. **Load Wallet**
   - Click "Load Existing Wallet"
   - Enter your password
   - Start mining immediately

## Application Structure

```
midnight-fetcher-bot/
├── setup.cmd                   # Windows setup script
├── app/                        # NextJS app (UI pages)
│   ├── page.tsx               # Home page
│   ├── wallet/
│   │   ├── create/page.tsx   # Wallet creation
│   │   └── load/page.tsx     # Load existing wallet
│   ├── mining/page.tsx        # Mining dashboard
│   └── api/                   # API routes
│       ├── wallet/            # Wallet operations
│       ├── hash/              # Hash service
│       └── mining/            # Mining control
├── lib/                       # Core libraries
│   ├── wallet/                # Wallet management
│   ├── hash/                  # Hash engine
│   └── mining/                # Mining orchestrator
├── native-HashEngine/    # Rust native module
├── secure/                    # Encrypted wallet files (auto-created)
├── storage/                   # Receipts and logs (auto-created)
└── logs/                      # Application logs (auto-created)
```

## Dashboard Features

### Real-Time Stats
- 🎯 **Challenge ID** - Current mining challenge
- ✅ **Solutions Found** - Total solutions submitted
- ⏱️ **Uptime** - Mining session duration
- 📍 **Registered Addresses** - 200 addresses ready to mine
- 📈 **Hash Rate** - Mining performance

### Controls
- ▶️ **Start Mining** - Begin mining operation
- ⏹️ **Stop Mining** - Stop current mining session
- 🔄 **Live Updates** - Real-time statistics via Server-Sent Events

## Security

### Wallet Security
- Seed phrase encrypted with password (scrypt + AES-256-GCM)
- Encrypted files stored in `secure/` directory
- Never shares seed phrase after initial display
- All signing done locally (no network transmission of keys)

### Best Practices
- ✅ Use a strong password (12+ characters, mixed case, numbers, symbols)
- ✅ Store seed phrase offline (paper, hardware wallet)
- ✅ Never share your seed phrase with anyone
- ✅ Backup your `secure/` directory to external storage
- ❌ Never screenshot or digitally store your seed phrase

### Scale
increase the below in lib\mining\orchestrator.ts
const BATCH_SIZE = 350;
private workerThreads = 12;

increase or decrease these based on your hardware

## Troubleshooting

### Setup Issues

**"Node.js not found"**
- Run `setup.cmd` - it will guide you to install Node.js
- Or manually install from: https://nodejs.org/

**"Rust not found"**
- Run `setup.cmd` - it will install Rust automatically
- Or manually install from: https://rustup.rs/

**"Native module build failed"**
- Ensure Visual C++ Build Tools are installed
- Rust installer should handle this automatically
- Restart your terminal after Rust installation

### Runtime Issues

**"Failed to decrypt wallet"**
- Double-check your password
- Ensure `secure/wallet-seed.json.enc` exists

**"Address registration failing"**
- Check your internet connection
- API may be rate-limiting (waits 1.5s between registrations)
- Check logs in `logs/` directory

**"Mining not starting"**
- Ensure all 200 addresses are registered
- Check if challenge is active (mining has time windows)
- Verify ROM initialization completed

## Advanced Configuration

Create `config.json` in the project root (optional):

```json
{
  "apiBase": "https://scavenger.prod.gd.midnighttge.io",
  "pollIntervalMs": 30000,
  "cpuThreads": 8,
  "walletAutogen": {
    "count": 50,
    "destinationIndexForDonation": 0
  }
}
```

## Development

### Run in Development Mode

```cmd
npm run dev
```

Access at `http://localhost:3001`

### Build for Production

```cmd
npm run build
npm run start
```

### Project Scripts

```cmd
npm run dev          # Start development server (port 3001)
npm run build        # Build for production
npm run start        # Start production server (port 3001)
npm run lint         # Run linter
npm run build:native # Build native module only
```

## Architecture

### Frontend
- **NextJS 14+** - React framework with App Router
- **TypeScript** - Type-safe development
- **Tailwind CSS** - Utility-first styling
- **Server-Sent Events** - Real-time updates

### Backend
- **NextJS API Routes** - Serverless API endpoints
- **Lucid Cardano** - Wallet generation and signing
- **Native Module** - Rust-based HashEngine for hashing

### Storage
- **secure/** - Encrypted seed phrase and address list
- **storage/** - Mining receipts (JSONL format)
- **logs/** - Application and registration logs

## Support

### Common Questions

**Q: Can I use this on multiple computers?**
A: Yes, copy your `secure/` directory and use your password on the new machine.

**Q: What happens if I forget my password?**
A: You'll need your 24-word seed phrase to recover. Without it, the wallet is unrecoverable.

**Q: Can I change the number of addresses?**
A: Yes, modify `count` in the wallet creation request (default: 200, max: 500).

**Q: Is my seed phrase sent to the server?**
A: No. All wallet operations are local. Only public addresses and signatures are sent to the mining API.

### Logs

Check these locations for debugging:
- `logs/app.log` - Application logs
- `logs/wallet-registration-progress.log` - Address registration status
- Console output in terminal

## License

MIT License - See LICENSE file for details

## Credits

- Built on [Midnight Network](https://midnight.network/)
- Uses [Lucid Cardano](https://github.com/spacebudz/lucid)
- Native hashing via HashEngine

## Disclaimer

This software is provided as-is. Always backup your seed phrase and secure your passwords. The authors are not responsible for lost funds or mining rewards.

---

**Happy Mining! ⛏️🌙**
