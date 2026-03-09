import crypto from 'crypto';

/**
 * Encryption service for sensitive data (API keys, credentials).
 * Uses AES-256-GCM for authenticated encryption.
 *
 * Format versions:
 *   v1 (legacy): iv_b64:authTag_b64:ciphertext_b64     — key = SHA-256(masterKey)
 *   v2 (current): v2:salt_b64:iv_b64:ciphertext_b64:tag_b64 — key = scrypt(masterKey, salt, 32)
 *
 * encrypt() always produces v2. decrypt() auto-detects format.
 * Lazy migration: pass onMigration callback to decrypt() to re-encrypt v1 → v2.
 */
export class EncryptionService {
  private readonly algorithm: crypto.CipherGCMTypes = 'aes-256-gcm';
  private readonly masterKey: string;
  /** Pre-computed v1 key (SHA-256 of masterKey) for legacy decryption */
  private readonly v1Key: Buffer;

  constructor(masterKey?: string) {
    const key = masterKey || process.env.ENCRYPTION_KEY;

    if (key) {
      if (key.length < 32) {
        console.error('FATAL: ENCRYPTION_KEY must be at least 32 characters');
        process.exit(1);
      }
      this.masterKey = key;
    } else {
      // Fall back to JWT_SECRET with deprecation warning (migration period)
      const jwtSecret = process.env.JWT_SECRET;
      if (!jwtSecret) {
        console.error('FATAL: ENCRYPTION_KEY (or JWT_SECRET) environment variable must be set');
        process.exit(1);
      }
      console.warn('DEPRECATED: Using JWT_SECRET for encryption. Set ENCRYPTION_KEY for better security.');
      this.masterKey = jwtSecret;
    }

    // Pre-compute v1-compatible key for legacy decryption
    this.v1Key = crypto.createHash('sha256').update(this.masterKey).digest();
  }

  /**
   * Derive a per-record encryption key using scrypt (v2).
   */
  private deriveKeyV2(salt: Buffer): Buffer {
    return crypto.scryptSync(this.masterKey, salt, 32, { N: 16384, r: 8, p: 1 });
  }

  /**
   * Encrypt data using v2 format (per-record salt + scrypt key derivation).
   * Output: v2:salt_b64:iv_b64:ciphertext_b64:tag_b64
   */
  encrypt(data: any): string {
    try {
      const salt = crypto.randomBytes(16);
      const key = this.deriveKeyV2(salt);
      const iv = crypto.randomBytes(12);

      const cipher = crypto.createCipheriv(this.algorithm, key, iv);
      const jsonData = JSON.stringify(data);
      let encrypted = cipher.update(jsonData, 'utf8', 'base64');
      encrypted += cipher.final('base64');
      const authTag = cipher.getAuthTag();

      return `v2:${salt.toString('base64')}:${iv.toString('base64')}:${encrypted}:${authTag.toString('base64')}`;
    } catch (error) {
      console.error('Encryption error:', error);
      throw new Error('Failed to encrypt data');
    }
  }

  /**
   * Decrypt data, auto-detecting v1 or v2 format.
   *
   * @param onMigration — optional callback invoked when a v1 record is re-encrypted
   *   to v2 format. The caller can persist the new encrypted string to avoid
   *   repeated migration on future reads.
   */
  decrypt(encryptedString: string, onMigration?: (reEncrypted: string) => void): any {
    if (encryptedString.startsWith('v2:')) {
      return this.decryptV2(encryptedString);
    }

    // Legacy v1 format
    const data = this.decryptV1(encryptedString);

    // Lazy migration: re-encrypt as v2 and notify caller
    if (onMigration) {
      try {
        const reEncrypted = this.encrypt(data);
        onMigration(reEncrypted);
      } catch {
        // Migration is best-effort — don't fail the read
      }
    }

    return data;
  }

  private decryptV2(encryptedString: string): any {
    try {
      const parts = encryptedString.split(':');
      if (parts.length !== 5 || parts[0] !== 'v2') {
        throw new Error('Invalid v2 encrypted data format');
      }

      const [, saltB64, ivB64, ciphertext, tagB64] = parts;
      const salt = Buffer.from(saltB64, 'base64');
      const iv = Buffer.from(ivB64, 'base64');
      const authTag = Buffer.from(tagB64, 'base64');
      const key = this.deriveKeyV2(salt);

      const decipher = crypto.createDecipheriv(this.algorithm, key, iv);
      decipher.setAuthTag(authTag);
      let decrypted = decipher.update(ciphertext, 'base64', 'utf8');
      decrypted += decipher.final('utf8');

      return JSON.parse(decrypted);
    } catch (error) {
      console.error('Decryption error (v2):', error);
      throw new Error('Failed to decrypt data');
    }
  }

  private decryptV1(encryptedString: string): any {
    try {
      const parts = encryptedString.split(':');
      if (parts.length !== 3) {
        throw new Error('Invalid v1 encrypted data format');
      }

      const [ivB64, authTagB64, encryptedData] = parts;
      const iv = Buffer.from(ivB64, 'base64');
      const authTag = Buffer.from(authTagB64, 'base64');

      const decipher = crypto.createDecipheriv(this.algorithm, this.v1Key, iv);
      decipher.setAuthTag(authTag);
      let decrypted = decipher.update(encryptedData, 'base64', 'utf8');
      decrypted += decipher.final('utf8');

      return JSON.parse(decrypted);
    } catch (error) {
      console.error('Decryption error (v1):', error);
      throw new Error('Failed to decrypt data');
    }
  }

  /**
   * Check whether an encrypted string uses the legacy v1 format.
   */
  needsMigration(encryptedString: string): boolean {
    return !encryptedString.startsWith('v2:');
  }

  /**
   * Self-test: encrypt + decrypt round-trip.
   */
  test(): boolean {
    try {
      const testData = { test: 'data', nested: { value: 123 } };
      const encrypted = this.encrypt(testData);
      const decrypted = this.decrypt(encrypted);
      return JSON.stringify(testData) === JSON.stringify(decrypted);
    } catch {
      return false;
    }
  }
}

// Export singleton instance
export const encryption = new EncryptionService();
