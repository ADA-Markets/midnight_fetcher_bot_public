import fs from 'fs';
import path from 'path';
import { Lucid, toHex } from 'lucid-cardano';
import { encrypt, decrypt, EncryptedData } from './encryption';

const SECURE_DIR = path.join(process.cwd(), 'secure');
const SEED_FILE = path.join(SECURE_DIR, 'wallet-seed.json.enc');
const DERIVED_ADDRESSES_FILE = path.join(SECURE_DIR, 'derived-addresses.json');

export interface DerivedAddress {
  index: number;
  bech32: string;
  publicKeyHex: string;
  registered?: boolean;
}

export interface WalletInfo {
  seedPhrase: string;
  addresses: DerivedAddress[];
}

export class WalletManager {
  private mnemonic: string | null = null;
  private derivedAddresses: DerivedAddress[] = [];

  /**
   * Generate a new wallet with 24-word seed phrase
   */
  async generateWallet(password: string, count: number = 40): Promise<WalletInfo> {
    // Ensure secure directory exists
    if (!fs.existsSync(SECURE_DIR)) {
      fs.mkdirSync(SECURE_DIR, { recursive: true, mode: 0o700 });
    }

    // Generate 24-word mnemonic using Lucid
    const tempLucid = await Lucid.new(undefined, 'Mainnet');
    this.mnemonic = tempLucid.utils.generateSeedPhrase();
    const words = this.mnemonic.split(' ');

    if (words.length !== 24) {
      throw new Error('Failed to generate 24-word mnemonic');
    }

    // Derive addresses
    await this.deriveAddresses(count);

    // Encrypt and save seed
    const encryptedData = encrypt(this.mnemonic, password);
    fs.writeFileSync(SEED_FILE, JSON.stringify(encryptedData, null, 2), { mode: 0o600 });

    // Save derived addresses
    fs.writeFileSync(
      DERIVED_ADDRESSES_FILE,
      JSON.stringify(this.derivedAddresses, null, 2),
      { mode: 0o600 }
    );

    return {
      seedPhrase: this.mnemonic,
      addresses: this.derivedAddresses,
    };
  }

  /**
   * Load existing wallet from encrypted file
   */
  async loadWallet(password: string): Promise<DerivedAddress[]> {
    if (!fs.existsSync(SEED_FILE)) {
      throw new Error('No wallet found. Please create a new wallet first.');
    }

    const encryptedData: EncryptedData = JSON.parse(fs.readFileSync(SEED_FILE, 'utf8'));

    try {
      this.mnemonic = decrypt(encryptedData, password);
    } catch (err) {
      throw new Error('Failed to decrypt wallet. Incorrect password?');
    }

    // Load derived addresses if they exist
    if (fs.existsSync(DERIVED_ADDRESSES_FILE)) {
      this.derivedAddresses = JSON.parse(fs.readFileSync(DERIVED_ADDRESSES_FILE, 'utf8'));
    } else {
      throw new Error('Derived addresses file not found. Wallet may be corrupted.');
    }

    return this.derivedAddresses;
  }

  /**
   * Check if wallet exists
   */
  walletExists(): boolean {
    return fs.existsSync(SEED_FILE);
  }

  /**
   * Derive addresses from mnemonic
   */
  private async deriveAddresses(count: number): Promise<void> {
    if (!this.mnemonic) {
      throw new Error('Mnemonic not loaded');
    }

    this.derivedAddresses = [];

    for (let i = 0; i < count; i++) {
      try {
        const { address, pubKeyHex } = await this.deriveAddressAtIndex(i);

        this.derivedAddresses.push({
          index: i,
          bech32: address,
          publicKeyHex: pubKeyHex,
          registered: false,
        });
      } catch (err: any) {
        console.error(`Failed to derive address at index ${i}:`, err.message);
        throw err;
      }
    }
  }

  /**
   * Derive a single address at specific index
   */
  private async deriveAddressAtIndex(index: number): Promise<{ address: string; pubKeyHex: string }> {
    if (!this.mnemonic) {
      throw new Error('Mnemonic not loaded');
    }

    const lucid = await Lucid.new(undefined, 'Mainnet');
    lucid.selectWalletFromSeed(this.mnemonic, {
      accountIndex: index,
    });

    const address = await lucid.wallet.address();

    // Get public key by signing a test message
    const testPayload = toHex(Buffer.from('test', 'utf8'));
    const signedMessage = await lucid.wallet.signMessage(address, testPayload);

    // Extract 32-byte public key from COSE_Key structure
    const coseKey = signedMessage.key;
    const pubKeyHex = coseKey.slice(-64);

    if (!pubKeyHex || pubKeyHex.length !== 64) {
      throw new Error(`Failed to extract valid public key for index ${index}`);
    }

    return { address, pubKeyHex };
  }

  /**
   * Sign a message with specific address
   */
  async signMessage(addressIndex: number, message: string): Promise<string> {
    if (!this.mnemonic) {
      throw new Error('Mnemonic not loaded');
    }

    const addr = this.derivedAddresses.find(a => a.index === addressIndex);
    if (!addr) {
      throw new Error(`Address not found for index ${addressIndex}`);
    }

    const lucid = await Lucid.new(undefined, 'Mainnet');
    lucid.selectWalletFromSeed(this.mnemonic, {
      accountIndex: addressIndex,
    });

    const payload = toHex(Buffer.from(message, 'utf8'));
    const signedMessage = await lucid.wallet.signMessage(addr.bech32, payload);

    return signedMessage.signature;
  }

  /**
   * Get all derived addresses
   */
  getDerivedAddresses(): DerivedAddress[] {
    return this.derivedAddresses;
  }

  /**
   * Get public key for specific address index
   */
  getPubKeyHex(index: number): string {
    const addr = this.derivedAddresses.find(a => a.index === index);
    if (!addr) {
      throw new Error(`Address not found for index ${index}`);
    }
    return addr.publicKeyHex;
  }

  /**
   * Mark address as registered
   */
  markAddressRegistered(index: number): void {
    const addr = this.derivedAddresses.find(a => a.index === index);
    if (addr) {
      addr.registered = true;
      // Save updated addresses
      fs.writeFileSync(
        DERIVED_ADDRESSES_FILE,
        JSON.stringify(this.derivedAddresses, null, 2),
        { mode: 0o600 }
      );
    }
  }

  /**
   * Create donation signature for consolidating rewards
   * Signs the message: "donate_to:{destinationAddress}"
   */
  async makeDonationSignature(addressIndex: number, sourceAddress: string, destinationAddress: string): Promise<string> {
    if (!this.mnemonic) {
      throw new Error('Mnemonic not loaded');
    }

    const addr = this.derivedAddresses.find(a => a.index === addressIndex);
    if (!addr) {
      throw new Error(`Address not found for index ${addressIndex}`);
    }

    if (addr.bech32 !== sourceAddress) {
      throw new Error(`Address mismatch: expected ${addr.bech32}, got ${sourceAddress}`);
    }

    const lucid = await Lucid.new(undefined, 'Mainnet');
    lucid.selectWalletFromSeed(this.mnemonic, {
      accountIndex: addressIndex,
    });

    const message = `donate_to:${destinationAddress}`;
    const payload = toHex(Buffer.from(message, 'utf8'));
    const signedMessage = await lucid.wallet.signMessage(sourceAddress, payload);

    return signedMessage.signature;
  }
}
