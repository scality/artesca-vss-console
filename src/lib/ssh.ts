import { Client, type ConnectConfig } from "ssh2";
import * as fs from "fs";
import { appendAuditLog } from "./db";

export interface SshExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

function getConnectConfig(): ConnectConfig {
  return {
    host: process.env.CAMERA_SIM_HOST ?? "",
    username: process.env.CAMERA_SIM_SSH_USER ?? "ubuntu",
    privateKey: fs.readFileSync(
      process.env.CAMERA_SIM_SSH_KEY_PATH ?? "/run/secrets/camera-sim-ssh-key"
    ),
    readyTimeout: 10_000,
  };
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
