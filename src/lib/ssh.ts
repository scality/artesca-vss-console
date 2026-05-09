import { Client, type ConnectConfig } from "ssh2";
import * as fs from "fs";
import * as crypto from "crypto";
import { appendAuditLog } from "./db";

export interface SshExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

// Cached SSH private key buffer — loaded once on first use.
let cachedKey: Buffer | null = null;

// Emit the no-host-key-verification warning at most once per process.
let hostKeyWarnEmitted = false;

function getConnectConfig(): ConnectConfig {
  if (cachedKey === null) {
    cachedKey = fs.readFileSync(
      process.env.CAMERA_SIM_SSH_KEY_PATH ?? "/run/secrets/camera-sim-ssh-key"
    );
  }

  const cfg: ConnectConfig = {
    host: process.env.CAMERA_SIM_HOST ?? "",
    username: process.env.CAMERA_SIM_SSH_USER ?? "ubuntu",
    privateKey: cachedKey,
    readyTimeout: 10_000,
  };

  const expectedFingerprint = process.env.CAMERA_SIM_HOST_PUBKEY_SHA256;
  if (expectedFingerprint) {
    cfg.hostVerifier = (key: Buffer): boolean => {
      const actual = crypto.createHash("sha256").update(key).digest("hex");
      return actual.toLowerCase() === expectedFingerprint.toLowerCase();
    };
  } else {
    if (!hostKeyWarnEmitted) {
      hostKeyWarnEmitted = true;
      console.warn(
        "[ssh] CAMERA_SIM_HOST_PUBKEY_SHA256 is not set — SSH host key verification is disabled"
      );
    }
  }

  return cfg;
}

/** Execute a command on the camera-sim EC2 instance via SSH. */
export function sshExec(cmd: string): Promise<SshExecResult> {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    let stdout = "";
    let stderr = "";

    conn.on("ready", () => {
      conn.exec(cmd, (err, stream) => {
        if (err) {
          conn.end();
          return reject(err);
        }

        stream.on("data", (chunk: Buffer) => {
          stdout += chunk.toString();
        });
        stream.stderr.on("data", (chunk: Buffer) => {
          stderr += chunk.toString();
        });
        stream.on("close", (code: number) => {
          conn.end();
          resolve({ stdout, stderr, code });
        });
      });
    });

    conn.on("error", (err) => reject(err));
    conn.connect(getConnectConfig());
  });
}

/** SCP a buffer to a remote path on the camera-sim instance. Write calls are audit-logged. */
export async function sshScp(
  localBuffer: Buffer,
  remotePath: string,
  operator: string
): Promise<void> {
  await appendAuditLog({
    operator,
    action: "scp-write",
    target: remotePath,
    detailsJson: JSON.stringify({ bytes: localBuffer.length }),
  });

  return new Promise((resolve, reject) => {
    const conn = new Client();

    conn.on("ready", () => {
      conn.sftp((err, sftp) => {
        if (err) {
          conn.end();
          return reject(err);
        }

        const writeStream = sftp.createWriteStream(remotePath);
        writeStream.on("error", (e: Error) => {
          conn.end();
          reject(e);
        });
        writeStream.on("finish", () => {
          conn.end();
          resolve();
        });

        writeStream.end(localBuffer);
      });
    });

    conn.on("error", (err) => reject(err));
    conn.connect(getConnectConfig());
  });
}
